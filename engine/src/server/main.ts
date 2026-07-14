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
import { isMainThread } from "node:worker_threads";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";

import {
  loadSettings,
  loadOrCreateJwtSecret,
  type Settings,
} from "../config.js";
import { initSchema } from "../db/schema.js";
import { createDbClient, type DbClient } from "../db/client.js";
import type { FullRepoRow } from "../db/storage.js";
import { ensureAdminUser } from "../auth.js";
import { runTurn } from "../engine/turn.js";
import {
  syncAllRepos,
  periodicSyncLoop,
  configureIndexing,
  type RepoSyncDescriptor,
} from "../repo-sync.js";
import { periodicTrackingLoop } from "../issue-tracker.js";
import { buildApp } from "./app.js";

// listReposFull() returns the admin/internal full row shape (snake_case,
// straight off the sqlite columns) — repo-sync.ts's RepoSyncDescriptor is
// camelCase and deliberately narrower (just what clone/pull need). This is
// the one place that bridges them: both syncAllRepos (startup) and
// periodicSyncLoop's injected fetchRepos (Task 3's design, see repo-sync.ts's
// periodicSyncLoop doc comment — it takes credentials via an injected
// fetcher rather than db.listRepos()'s client-safe/credential-free view)
// go through this.
function toSyncDescriptors(rows: FullRepoRow[]): RepoSyncDescriptor[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    branch: row.branch,
    credUsername: row.cred_username,
    credToken: row.cred_token,
  }));
}

// This file lives at <repoRoot>/engine/src/server/main.ts — three `..`
// hops off its own directory lands on repo root, the exact same derivation
// app.ts's WEB_ROOT uses for `web/` (see that file's comment for why this
// must be import.meta.url-derived rather than process.cwd()-relative:
// `npm start` runs with cwd=engine, not the repo root, so anything
// cwd-relative would silently break the moment someone launches this any
// other way, e.g. a systemd unit with a different WorkingDirectory).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  /**
   * Test-only override for the startup repo-sync entry point. Production
   * never sets this — the real `syncAllRepos` (repo-sync.ts), with its SSRF
   * gate, always runs. An e2e test that wants to prove "startup sync
   * actually populated local_path/last_sync_status" against a real local git
   * fixture needs `repo-sync.ts`'s `__internal.syncAllReposUnvalidated`
   * instead, for the exact reason admin-routes.ts injects
   * `deps.syncAndPersist` the same way (see that file's header comment): a
   * bare local temp dir is precisely what the SSRF gate exists to reject.
   */
  syncAllRepos?: typeof syncAllRepos;
};

export type StartedServer = {
  port: number;
  settings: Settings;
  db: DbClient;
  /**
   * Closes the HTTP server (force-dropping any still-ACTIVE connections —
   * see the `closeAllConnections` note below) THEN the db client, in that
   * order, resolving only once both are actually done. `db.close()`
   * resolves only after the worker thread's real "exit" event (client.ts),
   * so a resolved stop() means no leaked db worker. Idempotent: safe to
   * call from a test's `afterEach` and from a production signal handler
   * without double-work (`db.close()` is itself idempotent — Phase 2's
   * close-lifecycle work).
   *
   * How this is test-enforced (e2e-smoke.test.ts): a stop() that HANGS
   * fails that test via its own timeout; a stop() that silently skips
   * closing is caught by explicit post-stop assertions there (connection
   * refused on the port; db calls reject as closed). Note "vitest would
   * hang on a leaked handle" is NOT the enforcement mechanism — the
   * default threads pool force-terminates its workers after a run, so a
   * leak would not actually hang `npm test` (empirically verified during
   * Task 6 review).
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
  // Codex full-repo review (2026-07-14, Warning): nothing pinned the
  // process umask, so agent_data.db (webhook secrets, repo credentials,
  // password hashes) and every secret file below inherited whatever the
  // shell/container's ambient umask happened to be — often 022, i.e.
  // world-readable. process.umask(mask) applies to the whole OS process
  // (not per-thread) — but Node explicitly forbids the SETTER form from a
  // worker thread (ERR_WORKER_UNSUPPORTED_OPERATION), which is exactly
  // where this file's own e2e tests run it (vitest's worker-pool runner).
  // Production always calls startServer() from the real main thread
  // (`tsx src/server/main.ts` has none), so isMainThread is true there.
  if (isMainThread) {
    process.umask(0o077);
  }

  const settings = loadSettings(opts.env);
  if (!settings.jwtSecret) {
    settings.jwtSecret = loadOrCreateJwtSecret(REPO_ROOT);
  }

  const dbPath = resolveDbPath(opts.env ?? process.env);
  initSchema(dbPath);
  const db = createDbClient(dbPath);
  await ensureAdminUser(db, settings);

  // Webhook secrets (2026-07-14): DB-backed, not file-based like jwtSecret
  // above — moved here, after the DB is open, per GitHub issue #6 (the old
  // file-based approach silently regenerated a new secret on every restart
  // instead of persisting one; see config.ts's history comment). The admin
  // panel's Webhook tab (admin-routes.ts's GET/regenerate endpoints) is the
  // intended distribution channel — printing the raw value here too
  // (Codex full-repo review, 2026-07-14, Warning) would put a live
  // production secret in cleartext in every process log/journal an
  // operator ever collects, for no benefit now that there's an
  // authenticated UI to read it from.
  if (!settings.githubWebhookSecret) {
    settings.githubWebhookSecret = await db.getOrCreateAppSecret("github_webhook_secret");
    console.log("GitHub webhook secret loaded — see Admin → Webhook to view/copy it.");
  }
  if (!settings.gitlabWebhookSecret) {
    settings.gitlabWebhookSecret = await db.getOrCreateAppSecret("gitlab_webhook_secret");
    console.log("GitLab webhook secret loaded — see Admin → Webhook to view/copy it.");
  }

  // Phase 4b Task 5: repo-sync.ts's default onSyncSuccess needs Settings for
  // its embedding-build phase but doesn't import the config singleton itself
  // (see configureIndexing's doc comment) — must run before the startup sync
  // below, which is the first thing that can trigger onSyncSuccess.
  configureIndexing(settings);

  // Repo sync — v1's lifespan (app/main.py, ~line 124-138) awaits
  // sync_all_repos(repos) on startup BEFORE the app starts serving requests,
  // wrapped in try/except so one bad repo (bad path, filesystem error, ...)
  // can't prevent the app itself from starting; it then launches
  // periodic_sync_loop as a fire-and-forget background task. Mirrored here
  // exactly: awaited-but-caught startup sync, then a NOT-awaited periodic
  // loop. (syncAllRepos/periodicSyncLoop themselves were built in Task 3 but
  // never wired to a caller until now.)
  const syncAllReposFn = opts.syncAllRepos ?? syncAllRepos;
  try {
    const repos = toSyncDescriptors(await db.listReposFull());
    if (repos.length) {
      console.log("Syncing repositories...");
      await syncAllReposFn(db, repos, settings.reposDir);
    }
  } catch (e) {
    const label = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    console.log(`  ❌ Startup repo sync failed: ${label}`);
  }

  // periodicSyncLoop's fetchRepos is an injected fetcher (Task 3's design,
  // see that function's doc comment) rather than a direct db.listRepos()
  // call: listRepos() is the client-safe view with credentials stripped, so
  // a periodic resync built on it would silently stop working for every
  // private repo. db.listReposFull() is the credentialed admin view this
  // process is trusted to hold. Not awaited — v1's asyncio.create_task
  // equivalent — and its returned `stop()` is captured so shutdown (below)
  // can cancel it instead of leaving a live timer past process teardown.
  const repoSync = periodicSyncLoop(
    settings.repoSyncIntervalMinutes,
    () => db.listReposFull().then(toSyncDescriptors),
    db,
    settings.reposDir
  );

  // Issue-tracking poller (Phase 5) — same fire-and-forget shape as
  // repoSync above, and the same reason: v1's lifespan starts
  // periodic_tracking_loop as its own background task alongside
  // periodic_sync_loop, not sequenced with it. A non-positive
  // issueTrackIntervalMinutes disables it (periodicTrackingLoop's own
  // guard), matching v1's `if not interval_minutes or interval_minutes <=
  // 0: return`.
  const issueTracking = periodicTrackingLoop(settings.issueTrackIntervalMinutes, db, settings);

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
        // Cancel the periodic repo-sync loop first: it holds a `setTimeout`
        // that (though `.unref()`'d, so it can't itself keep the process
        // alive) would otherwise keep firing background syncs against a
        // `db`/`server` we're in the middle of tearing down. repoSync.stop()
        // is synchronous (just clears the pending timer, see
        // repo-sync.ts's periodicSyncLoop) — nothing to await here.
        repoSync.stop();
        // Same reasoning for the issue-tracking poller (periodicTrackingLoop
        // copies periodicSyncLoop's exact shape) — it must be cancelled
        // before the db/server it would otherwise keep polling against are
        // torn down.
        issueTracking.stop();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          // On Node >=19, server.close() already closes IDLE keep-alive
          // sockets by itself (empirically re-verified on this repo's Node
          // 24: the e2e test passes at the same speed with this line
          // stripped — an earlier comment here claimed idle undici sockets
          // would wedge close(), which is Node <19 behavior). What close()
          // still waits for indefinitely is ACTIVE connections — e.g. a
          // browser holding an SSE chat stream open when SIGTERM lands, the
          // normal state for this product. closeAllConnections() drops
          // those too, so shutdown is bounded instead of hostage to the
          // longest-lived open stream.
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
