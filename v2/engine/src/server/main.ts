// Process entrypoint (Task 6) — the final piece of Phase 3. Wires every
// layer built by Tasks 1-5 (config -> schema -> db client -> admin
// bootstrap -> SSE/HTTP edge -> the real per-turn pi engine) into one
// running Node process. Everything this file calls was already exercised
// in isolation with stubbed/injected deps (buildApp with a stub engine in
// sse-route.test.ts, runTurn against a mock LLM in turn-engine.test.ts,
// createDbClient/initSchema in db-*.test.ts, ...) — this file's only job is
// the WIRING, and test/e2e-smoke.test.ts is what proves the wiring itself
// holds together: a real server, a real runTurn, only the LLM is mocked
// (test/mock-anthropic.ts).
//
// `startServer()` is exported (not just a bare top-level side effect) so
// the e2e test can drive the exact same composition path `npm start` uses,
// instead of re-deriving a parallel test-only assembly. The
// `if (import.meta.url === ...)` guard at the bottom is what lets this file
// be BOTH an importable module (for tests) and a `tsx src/server/main.ts`-
// runnable script (production, via `npm start`) without double-starting a
// listener when imported.
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";

import { loadSettings, loadOrCreateJwtSecret, type Settings } from "../config.js";
import { initSchema } from "../db/schema.js";
import { createDbClient, type DbClient } from "../db/client.js";
import { ensureAdminUser } from "../auth.js";
import { runTurn } from "../engine/turn.js";
import { buildApp } from "./app.js";

// This file lives at <repoRoot>/v2/engine/src/server/main.ts — four `..`
// hops off its own directory lands on repo root, the exact same derivation
// app.ts's WEB_ROOT uses for `web/` (see that file's comment for why this
// must be import.meta.url-derived rather than process.cwd()-relative:
// `npm start` runs with cwd=v2/engine, not the repo root, so anything
// cwd-relative would silently break the moment someone launches this any
// other way, e.g. a systemd unit with a different WorkingDirectory).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// v1 had no APP_DB_PATH-equivalent: `DB_PATH` was a Python module constant
// (`"agent_data.db"`, implicitly cwd-relative — safe there only because
// uvicorn was always launched from the repo root, per root CLAUDE.md's
// Running section). `Settings` (src/config.ts) has no `dbPath` field, and
// this task deliberately does NOT add one there (unlike `port` above): the
// db file's location is a deployment path, not an LLM/app runtime knob, so
// it's resolved here — once, from the SAME env source `loadSettings()`
// itself was given (see `startServer` below) — rather than folded into
// Settings. Default keeps v1's exact filename, anchored at repo root (not
// cwd) so it lands in the same place regardless of which directory the
// process was started from; `APP_DB_PATH` can override with either an
// absolute path or one relative to repo root.
function resolveDbPath(env: Record<string, string | undefined>): string {
  const override = env.APP_DB_PATH;
  if (!override) return path.join(REPO_ROOT, "agent_data.db");
  return path.isAbsolute(override) ? override : path.resolve(REPO_ROOT, override);
}

export type StartServerOptions = {
  /**
   * Explicit env source (test path). When provided, mirrors loadSettings'
   * own env-vs-dotenv contract exactly: no `dotenv.config()` read, and
   * `resolveDbPath` reads from this SAME object rather than `process.env`,
   * so a test's `APP_DB_PATH`/`APP_PORT`/`ANTHROPIC_BASE_URL` overrides are
   * seen consistently by both settings and db-path resolution. Omit for
   * production (reads `.env` + `process.env`, real repo-root db path).
   */
  env?: Record<string, string | undefined>;
};

export type StartedServer = {
  port: number;
  settings: Settings;
  db: DbClient;
  /**
   * Closes the HTTP server (force-dropping any idle keep-alive sockets —
   * see the `closeAllConnections` call below — so this doesn't hang waiting
   * on a socket nobody was going to close) THEN the db client, in that
   * order, resolving only once both are actually done. Idempotent: safe to
   * call from a test's `afterEach` and from a production signal handler
   * without double-work (`db.close()` is itself idempotent — Phase 2's
   * close-lifecycle work).
   */
  stop(): Promise<void>;
};

/**
 * Composes every Phase 1-3 layer into one running server and returns its
 * bound port plus a clean shutdown hook. `start()` below wraps this for
 * production; test/e2e-smoke.test.ts calls it directly.
 *
 * Order mirrors the dependency chain: settings first (everything else
 * reads from it); schema before the db client (the client just opens
 * whatever schema.ts already created/verified — see storage.ts's
 * checkSchema, the fail-loud backstop); db before admin bootstrap
 * (ensureAdminUser needs somewhere to write); everything before buildApp
 * (which wires the HTTP surface on top of all of it).
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const settings = loadSettings(opts.env);
  if (!settings.jwtSecret) {
    settings.jwtSecret = loadOrCreateJwtSecret(REPO_ROOT);
  }

  const dbPath = resolveDbPath(opts.env ?? process.env);
  initSchema(dbPath);
  const db = createDbClient(dbPath);
  await ensureAdminUser(db, settings);

  // engine: runTurn already IS a RunTurnFn — `(deps: RunTurnDeps, req) =>
  // AsyncGenerator<DomainEvent>` — with no wrapping needed here. buildApp
  // (src/server/app.ts) registers the tool list itself (side-effecting
  // `import "../tools/calculator.js"` + `listTools()` at app-build time)
  // and sse.ts's chatEventStream assembles the per-request RunTurnDeps
  // (`{ db, settings, tools }`) from that before calling `engine(...)` —
  // that composition already lives one layer down (Task 5), so main.ts's
  // job really is just "pass the real implementations in".
  const app = buildApp({ db, settings, engine: runTurn });

  // serve()'s declared return is the ServerType union (http | http2 |
  // http2-secure) — but with no `createServer` override in the options it
  // always constructs a plain node:http Server, and the narrow type is
  // needed for `closeAllConnections` below (an http.Server-only API).
  const server = serve({ fetch: app.fetch, port: settings.port }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const boundPort = (server.address() as AddressInfo).port;

  let stopped: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (!stopped) {
      stopped = (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          // fetch/undici (and any other keep-alive HTTP/1.1 client) leaves
          // idle sockets open after its response body is fully read —
          // server.close()'s callback only fires once every connection is
          // gone, so without this it can sit unresolved waiting on a socket
          // nobody was going to close on their own. That's exactly the
          // "vitest hangs after tests report done" failure mode the e2e
          // test's own cleanup exists to catch.
          server.closeAllConnections();
        });
        await db.close();
      })();
    }
    return stopped;
  }

  return { port: boundPort, settings, db, stop };
}

async function start(): Promise<void> {
  const { port, stop } = await startServer();
  console.log(`CodeAxis v2 (node) listening on :${port}`);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);
    stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("Error during shutdown:", err);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Runs the server only when this file is the process entry point (`tsx
// src/server/main.ts` / `npm start`) — importing `startServer` from a test
// must NOT also trigger this, which is why the actual composition lives in
// `startServer()` above and this guard is the module's only top-level
// side effect.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error("Fatal error during startup:", err);
    process.exit(1);
  });
}
