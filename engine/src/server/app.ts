// buildApp — the v1 browser contract reproduced on Hono: SSE chat route,
// session/auth/config/skills/repos APIs, static frontend. Port of
// `git show v1-python-final:app/main.py` (routes) with the admin/issue/
// feedback/code-viewer/repo-sync surface deliberately deferred to
// Phase 4/5 (see docs/superpowers/plans/2026-07-12-pi-phase3-node-service.md's
// self-review — those pages 404 for now, which is expected).
//
// engine is injected (RunTurnFn) rather than imported directly — this is
// what lets the SSE route tests script a stub turn generator with no
// network and no pi involved. Everything else (db, settings) is likewise
// passed in, never reached for as module-level state, so main.ts (Task 6)
// is the only place that assembles the real thing.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { DbClient } from "../db/client.js";
import type { Settings } from "../config.js";
import type { RunTurnFn } from "../engine/turn.js";
import { createToken, decodeToken, verifyPassword, AuthError } from "../auth.js";
import { listTools } from "../tools/registry.js";
// Side-effecting registrations (Task 8 closes Phase 4a): each of these
// files calls registerTool() at import time — calculator (Phase 3's one
// tool) plus the repo-scoped file/code/symbol/semantic tools Phase 4a/4b
// add (file_reader, code_search + list_directory, find_symbol +
// list_file_symbols, semantic_search). Chat requests now reach real repos.
import "../tools/calculator.js";
import "../tools/file-reader.js";
import "../tools/code-search.js";
import "../tools/symbol-index.js";
import "../tools/semantic-search.js";
import { chatEventStream, userOwnsSession, type ChatRequestBody, type CurrentUser } from "./sse.js";
import { mountAdminRoutes, type SyncAndPersistFn } from "./admin-routes.js";

export type BuildAppDeps = {
  db: DbClient;
  settings: Settings;
  engine: RunTurnFn;
  // Task 7: injectable so tests can swap in repo-sync.ts's
  // __internal.syncAndPersistUnvalidated (real git, no SSRF gate) against a
  // local temp bare repo — production (src/server/main.ts) never sets this,
  // so admin-routes.ts defaults to the real, SSRF-gated export.
  syncAndPersist?: SyncAndPersistFn;
};

export type Env = { Variables: { user: CurrentUser } };

// web/ lives at the repo root, two levels up from engine
// (<root>/engine/src/server/app.ts -> <root>/web). Resolved from THIS
// file's own location (import.meta.url), never process.cwd():
// @hono/node-server's serveStatic resolves a RELATIVE root against cwd
// (see its own .d.ts comment), which would silently break the moment the
// process is launched from anywhere but the repo root — an absolute root
// sidesteps that entirely.
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web");

// v1 app/main.py:80-83 — static client-side limits, unrelated to any
// specific request; kept here (not in sse.ts) since GET /api/config is a
// plain route, not part of the chat/turn orchestration. Images themselves
// are not wired end to end yet (see sse.ts's ChatRequestBody comment) but
// the frontend's loadConfig() unconditionally reads these two fields to
// override its own client-side defaults, so the shape/values still need
// to match v1's — a missing/zero response here would silently change the
// frontend's own upload limits.
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_BASE64_CHARS = 6_000_000;

// v1 app/main.py:164-178 — in-memory login throttle, ported verbatim:
// per-process only (won't coordinate across replicas), but meaningfully
// raises the cost of a scripted attack against a known username. Every
// login call counts as an attempt (even before credentials are checked);
// a successful login clears the counter for that username.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 300_000;
const loginAttempts = new Map<string, number[]>();

function checkLoginRateLimit(username: string): boolean {
  const now = Date.now();
  const attempts = (loginAttempts.get(username) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(username, attempts);
    return false;
  }
  attempts.push(now);
  loginAttempts.set(username, attempts);
  return true;
}

export function buildApp(deps: BuildAppDeps): Hono<Env> {
  const app = new Hono<Env>();
  // Registered once at app-build time, not per-request — Phase 3 shipped
  // calculator-only (Task 3); Phase 4a grows this to six tools via the
  // same side-effecting-import + listTools() pattern (imports above).
  const tools = listTools();

  app.use(
    "*",
    cors({
      origin: deps.settings.corsOrigins
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      credentials: true,
    })
  );

  // ==================== Auth ====================
  // One blanket middleware over /api/* (except the login route itself,
  // which must be reachable without a token) instead of v1's per-route
  // `Depends(get_current_user)` — same effect, one place. Re-fetches the
  // user by id on every request (like v1's get_current_user) rather than
  // trusting the JWT payload's role/is_active for the token's whole
  // lifetime — otherwise a disabled or demoted user keeps full access
  // until the token naturally expires.

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/login") {
      await next();
      return;
    }
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ detail: "Not authenticated" }, 401);
    }
    let userId: number;
    try {
      const decoded = decodeToken(header.slice("Bearer ".length), deps.settings);
      userId = decoded.user_id;
    } catch (err) {
      // v1's decode_token: expired vs. anything-else-invalid both collapse
      // to 401 at the HTTP layer (only the `detail` text differs) — AuthError
      // always carries that same status, matching FastAPI's HTTPException(401).
      const message = err instanceof AuthError ? err.message : "Invalid token";
      return c.json({ detail: message }, 401);
    }
    const user = await deps.db.getUserById(userId);
    if (!user || !user.is_active) {
      return c.json({ detail: "Not authenticated" }, 401);
    }
    c.set("user", { id: user.id, username: user.username, role: user.role });
    await next();
  });

  app.post("/api/auth/login", async (c) => {
    let body: { username?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ detail: "Invalid JSON body" }, 422);
    }
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return c.json({ detail: "username and password are required" }, 422);
    }
    if (!checkLoginRateLimit(body.username)) {
      return c.json({ detail: "Too many login attempts. Try again later." }, 429);
    }
    const user = await deps.db.getUserByUsername(body.username);
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      return c.json({ detail: "Invalid credentials" }, 401);
    }
    if (!user.is_active) {
      return c.json({ detail: "Account disabled" }, 403);
    }
    loginAttempts.delete(body.username);
    const token = createToken({ id: user.id, username: user.username, role: user.role }, deps.settings);
    return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.get("/api/auth/me", (c) => c.json(c.get("user")));

  // ==================== Config / skills ====================

  app.get("/api/config", (c) =>
    c.json({
      max_images_per_message: MAX_IMAGES_PER_MESSAGE,
      max_image_bytes: Math.round((MAX_IMAGE_BASE64_CHARS * 3) / 4),
      repo_sync_interval_minutes: deps.settings.repoSyncIntervalMinutes,
    })
  );

  // v1's coder/issue_agent skills return once Phase 4 brings their tool
  // surface back — this phase has no skills to gate (calculator-only, no
  // skill grouping), so the list is empty. Bare array, matching v1's SHAPE
  // (list[SkillInfo] via FastAPI's response_model), not its content.
  app.get("/api/skills", (c) => c.json([]));

  // ==================== Repos ====================

  app.get("/api/repos", async (c) => {
    const user = c.get("user");
    const rows = user.role === "admin" ? await deps.db.listRepos() : await deps.db.listReposForUser(user.id);
    return c.json(rows);
  });

  // ==================== Sessions ====================

  app.get("/api/sessions", async (c) => {
    const user = c.get("user");
    const rows = await deps.db.listSessions(user.role === "admin" ? null : user.id);
    return c.json(rows);
  });

  app.get("/api/sessions/:id", async (c) => {
    const user = c.get("user");
    const session = await deps.db.getSession(c.req.param("id"));
    if (!session) return c.json({ detail: "Session not found" }, 404);
    if (!userOwnsSession(session, user)) return c.json({ detail: "Access denied" }, 403);
    // issue_submissions/issue_actions/feedback are Phase 4/5 subsystems
    // that don't exist yet — web/app.js's openSession() already treats all
    // three as optional (`data.issue_submissions || []` etc.), so omitting
    // them here is safe rather than a silent frontend break.
    const messages = await deps.db.getMessages(session.id);
    return c.json({ session, messages });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const user = c.get("user");
    const session = await deps.db.getSession(c.req.param("id"));
    if (!session) return c.json({ detail: "Session not found" }, 404);
    if (!userOwnsSession(session, user)) return c.json({ detail: "Access denied" }, 403);
    await deps.db.deleteSession(session.id);
    return c.json({ ok: true });
  });

  // ==================== Chat (SSE) ====================

  app.post("/api/chat", async (c) => {
    const user = c.get("user");
    let body: ChatRequestBody;
    try {
      const parsed = await c.req.json();
      if (typeof parsed?.message !== "string") {
        return c.json({ detail: "message is required" }, 422);
      }
      body = parsed;
    } catch {
      return c.json({ detail: "Invalid JSON body" }, 422);
    }

    return streamSSE(c, async (stream) => {
      // Hono's onAbort fires when the client disconnects mid-response (the
      // underlying ReadableStream body gets cancelled) — the real signal
      // behind chatEventStream's CancelledError-equivalent branch. Only
      // fires reliably over an actual HTTP transport (@hono/node-server),
      // not for in-process `app.request()` calls, which never drive Node's
      // request/response close events.
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      for await (const frame of chatEventStream(
        { db: deps.db, settings: deps.settings, engine: deps.engine, tools },
        body,
        user,
        { signal: controller.signal }
      )) {
        await stream.writeSSE(frame);
      }
    });
  });

  // ==================== Admin ====================
  // Task 7: user/repo/permission CRUD, port of v1's
  // `app/admin.py`'s users/repos/permissions sections. v1's `require_admin`
  // dependency is a role check layered ON TOP of `get_current_user` (401
  // for missing/invalid token, then 403 for an authenticated non-admin) —
  // the /api/* auth middleware above already covers the 401 half for every
  // /api/admin/* path (it's a subset of /api/*, checked first since it was
  // registered first), so this middleware only needs the role check, with
  // the same {detail: "Admin access required"} text v1's require_admin uses.
  app.use("/api/admin/*", async (c, next) => {
    if (c.get("user").role !== "admin") {
      return c.json({ detail: "Admin access required" }, 403);
    }
    await next();
  });
  mountAdminRoutes(app, deps);

  // ==================== Static frontend ====================
  // Mirrors v1's `app.mount("/static", StaticFiles(directory="web"))` +
  // explicit `/`, `/login`, `/admin` FileResponse routes exactly — web/'s
  // own HTML references `/static/style.css` etc. (see web/login.html),
  // so the URL-space prefix must be stripped before joining against
  // WEB_ROOT (the directory itself has no `static/` subfolder).

  app.use(
    "/static/*",
    serveStatic({ root: WEB_ROOT, rewriteRequestPath: (p) => p.replace(/^\/static/, "") })
  );
  app.get("/", serveStatic({ root: WEB_ROOT, path: "index.html" }));
  app.get("/login", serveStatic({ root: WEB_ROOT, path: "login.html" }));
  app.get("/admin", serveStatic({ root: WEB_ROOT, path: "admin.html" }));

  return app;
}
