// buildApp — the v1 browser contract reproduced on Hono: SSE chat route,
// session/auth/config/skills/repos APIs, static frontend. Port of
// `git show v1-python-final:app/main.py` (routes) with the admin/issue/
// feedback/code-viewer/repo-sync surface deliberately deferred to
// Phase 4/5 — those pages 404 for now, which is expected.
//
// engine is injected (RunTurnFn) rather than imported directly — this is
// what lets the SSE route tests script a stub turn generator with no
// network and no pi involved. Everything else (db, settings) is likewise
// passed in, never reached for as module-level state, so main.ts (Task 6)
// is the only place that assembles the real thing.
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import type { DbClient } from "../db/client.js";
import type { Settings } from "../config.js";
import type { RunTurnFn } from "../engine/turn.js";
import { createToken, decodeToken, verifyPassword, hashPassword, AuthError } from "../auth.js";
import { maskUrlCredentials } from "../repo-sync.js";
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
import "../tools/github-issue.js";
import {
  chatEventStream,
  userOwnsSession,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BASE64_CHARS,
  type ChatRequestBody,
  type CurrentUser,
} from "./sse.js";
import { mountAdminRoutes, type SyncAndPersistFn } from "./admin-routes.js";
import { mountAdminDashboardRoutes } from "./admin-dashboard-routes.js";
import { mountIssueRoutes } from "./issue-routes.js";
import { mountWebhookRoutes } from "./webhook-routes.js";

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
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(ENGINE_ROOT, "..");

// So the running site can show which commit it's actually serving (QA
// asked for this after a deploy-mechanics investigation made "is this the
// version I just pushed?" a real recurring question). deploy.sh writes
// `engine/.git-sha` at build time (picked up by the Dockerfile's `COPY
// engine/ ./` automatically) since the container has no `.git` directory
// of its own to ask — the git-cli fallback below only ever fires in local
// dev, where `.git` genuinely exists at REPO_ROOT. Resolved once at
// startup (matches this file's own WEB_ROOT — computed once, not
// per-request) since the running process is always one fixed commit.
function readGitSha(): string {
  try {
    return fs.readFileSync(path.join(ENGINE_ROOT, ".git-sha"), "utf8").trim();
  } catch {
    // fall through to the git-cli fallback below
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}
const GIT_SHA = readGitSha();

// v1 app/main.py:80-83 — static client-side limits, unrelated to any
// specific request; the frontend's loadConfig() unconditionally reads
// these two fields to override its own client-side defaults, so the
// shape/values still need to match v1's — a missing/zero response here
// would silently change the frontend's own upload limits. Canonical
// values live in sse.ts (where they're actually enforced); re-exported
// here since GET /api/config is a plain route, not chat/turn orchestration.

// v1 app/main.py:164-178 — in-memory login throttle, originally ported
// verbatim keyed on username alone. Codex full-repo review (2026-07-14,
// Warning) flagged three real gaps in that shape:
//  1. Unbounded Map keyed by arbitrary attacker-supplied usernames — an
//     attacker cycling through many fake usernames grows this Map forever
//     (memory DoS). Fixed with a hard cap + eviction of the oldest entries.
//  2. Username-only keying let anyone who just knows a real username (e.g.
//     "admin") lock that account out for the legitimate owner from ANY
//     other IP, just by throwing 5 bad guesses at it. Fixed by keying on
//     ip:username instead — this only throttles that same attacker's own
//     IP against that username, not the account globally. nginx always
//     sets X-Real-IP (deploy/nginx-codeaxis.conf) and the backend port is
//     now loopback-only (Critical #5, same review), so a direct client
//     can't spoof this header — it's nginx's own $remote_addr.
//  3. A nonexistent username skipped the (slow) bcrypt comparison
//     entirely, creating a timing side channel that reveals which
//     usernames are real. Fixed in the login route below with a
//     constant-shape dummy-hash compare.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 300_000;
const LOGIN_ATTEMPTS_MAX_ENTRIES = 10_000;
const loginAttempts = new Map<string, number[]>(); // insertion order == iteration order; re-inserting a touched key moves it to the end, giving simple LRU-ish eviction

function clientIp(c: Context<Env>): string {
  return c.req.header("x-real-ip") || "unknown";
}

function checkLoginRateLimit(key: string): boolean {
  const now = Date.now();
  const attempts = (loginAttempts.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(key, attempts);
    return false;
  }
  attempts.push(now);
  loginAttempts.delete(key); // re-insert below so this key becomes most-recently-used for eviction ordering
  loginAttempts.set(key, attempts);
  if (loginAttempts.size > LOGIN_ATTEMPTS_MAX_ENTRIES) {
    const oldest = loginAttempts.keys().next();
    if (!oldest.done) loginAttempts.delete(oldest.value);
  }
  return true;
}

// A fixed, valid-format bcrypt hash of a password nobody has — run through
// verifyPassword for a nonexistent username so that path takes roughly the
// same time as a real user's (slow) bcrypt compare, closing the timing
// side-channel. This value encodes nothing secret; bcrypt hashes are
// self-contained and safe to hardcode.
const TIMING_SAFE_DUMMY_HASH = "$2b$12$z8ffHwIouNw/GvU7Cak6wejN0zHY06svwLSmr4eOgdphzELfABXii";

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
    // Same bypass shape as /api/auth/login: GitHub/GitLab never send our JWT
    // — these two routes authenticate the REQUEST itself (HMAC signature /
    // shared token, verified inside webhook-routes.ts) instead of a user.
    if (c.req.path === "/api/auth/login" || c.req.path.startsWith("/api/webhooks/")) {
      await next();
      return;
    }
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ detail: "Not authenticated" }, 401);
    }
    let decoded: ReturnType<typeof decodeToken>;
    try {
      decoded = decodeToken(header.slice("Bearer ".length), deps.settings);
    } catch (err) {
      // v1's decode_token: expired vs. anything-else-invalid both collapse
      // to 401 at the HTTP layer (only the `detail` text differs) — AuthError
      // always carries that same status, matching FastAPI's HTTPException(401).
      const message = err instanceof AuthError ? err.message : "Invalid token";
      return c.json({ detail: message }, 401);
    }
    const user = await deps.db.getUserById(decoded.user_id);
    if (!user || !user.is_active) {
      return c.json({ detail: "Not authenticated" }, 401);
    }
    // Codex full-repo review (2026-07-14, Warning): a password change/reset
    // used to only stop the CURRENT password from working — the JWT itself
    // stayed valid regardless (auth.ts's createToken/decodeToken). Any
    // mismatch means this token was issued before the most recent password
    // change, so it must not still work.
    if (decoded.token_version !== user.token_version) {
      return c.json({ detail: "Token invalidated by a password change — please log in again" }, 401);
    }
    // Codex full-repo review (2026-07-14, Critical #1): must_change_password
    // used to be enforced ONLY by the frontend (it reads the flag off the
    // login response and blocks navigation) — the backend never checked it,
    // so a valid JWT for an account still on the well-known default
    // password (auth.ts's ensureAdminUser) had full API access regardless,
    // including /api/admin/*. Enforced here instead: every route except the
    // two needed to actually clear the flag is blocked until it's cleared.
    if (
      user.must_change_password &&
      c.req.path !== "/api/auth/me" &&
      c.req.path !== "/api/auth/change-password"
    ) {
      return c.json({ detail: "Password change required before accessing this resource" }, 403);
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
    const rateLimitKey = `${clientIp(c)}:${body.username}`;
    if (!checkLoginRateLimit(rateLimitKey)) {
      return c.json({ detail: "Too many login attempts. Try again later." }, 429);
    }
    const user = await deps.db.getUserByUsername(body.username);
    if (!user) {
      // Timing-safe: still run a bcrypt compare (against a fixed dummy
      // hash, never a real one) so this branch takes roughly as long as
      // the real-user branch below — otherwise a nonexistent username
      // returns near-instantly while a real one waits on bcrypt, letting
      // response time alone reveal which usernames exist.
      await verifyPassword(body.password, TIMING_SAFE_DUMMY_HASH);
      return c.json({ detail: "Invalid credentials" }, 401);
    }
    if (!(await verifyPassword(body.password, user.password_hash))) {
      return c.json({ detail: "Invalid credentials" }, 401);
    }
    if (!user.is_active) {
      return c.json({ detail: "Account disabled" }, 403);
    }
    loginAttempts.delete(rateLimitKey);
    const token = createToken(
      { id: user.id, username: user.username, role: user.role, tokenVersion: user.token_version },
      deps.settings
    );
    return c.json({
      token,
      // BUG-003: surfaces the bootstrap-admin-with-default-password flag
      // (see auth.ts's ensureAdminUser) so the frontend can block on a
      // mandatory password change before letting the user past login.
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        must_change_password: Boolean(user.must_change_password),
      },
    });
  });

  app.get("/api/auth/me", (c) => c.json(c.get("user")));

  // BUG-003: self-service password change, the only way must_change_password
  // ever gets cleared (storage.ts's updateUserPassword clears it as part of
  // the same UPDATE). Requires the CURRENT password even when a change is
  // mandatory — the default password being "known" is exactly why this
  // route exists, not a reason to skip verifying it; this also defends a
  // leaked JWT from being enough on its own to take over the account via a
  // password change.
  app.post("/api/auth/change-password", async (c) => {
    const currentUser = c.get("user");
    let body: { current_password?: unknown; new_password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ detail: "Invalid JSON body" }, 422);
    }
    if (typeof body.current_password !== "string" || typeof body.new_password !== "string") {
      return c.json({ detail: "current_password and new_password are required" }, 422);
    }
    if (body.new_password.length < 8) {
      return c.json({ detail: "new_password must be at least 8 characters" }, 422);
    }
    const user = await deps.db.getUserById(currentUser.id);
    if (!user || !(await verifyPassword(body.current_password, user.password_hash))) {
      return c.json({ detail: "Current password is incorrect" }, 401);
    }
    const newHash = await hashPassword(body.new_password);
    await deps.db.updateUserPassword(user.id, newHash);
    // updateUserPassword just bumped token_version (Codex full-repo review,
    // 2026-07-14, Warning) so every OTHER already-issued token for this
    // user stops working immediately — but that includes the very token
    // this request just authenticated with. Issue a fresh one carrying the
    // new version so the client that just changed its own password isn't
    // logged out by the same action, while every other device/session is.
    const updated = await deps.db.getUserById(user.id);
    const token = createToken(
      { id: user.id, username: user.username, role: user.role, tokenVersion: updated?.token_version },
      deps.settings
    );
    return c.json({ ok: true, token });
  });

  // ==================== Config / skills ====================

  app.get("/api/config", (c) =>
    c.json({
      max_images_per_message: MAX_IMAGES_PER_MESSAGE,
      max_image_bytes: Math.round((MAX_IMAGE_BASE64_CHARS * 3) / 4),
      repo_sync_interval_minutes: deps.settings.repoSyncIntervalMinutes,
      git_sha: GIT_SHA,
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
    // Codex full-repo review (2026-07-14, Critical #3): maskUrlCredentials'
    // own doc comment says it's meant to be shared between the admin and
    // non-admin repo views (an admin can paste credentials straight into the
    // url field instead of using cred_username/cred_token — admin-routes.ts's
    // adminRepoView already masks it), but this route never actually called
    // it — any authenticated user with read access to a repo could see a
    // credential-embedded URL verbatim, not just admins.
    return c.json(rows.map((r) => ({ ...r, url: maskUrlCredentials(r.url) })));
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
    // Independent reads (matches v1's `asyncio.gather`) — web/app.js's
    // openSession() reads all three to reconcile historical draft/action
    // cards to their real final state and restore this user's 👍/👎 button
    // state on replay.
    const [messages, issueSubmissions, issueActions, feedback] = await Promise.all([
      deps.db.getMessages(session.id),
      deps.db.getIssueSubmissionsForSession(session.id),
      deps.db.getIssueActionsForSession(session.id),
      deps.db.getFeedbackForSession(session.id, user.id),
    ]);
    return c.json({
      session,
      messages,
      issue_submissions: issueSubmissions,
      issue_actions: issueActions,
      feedback,
    });
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

  // ==================== Message feedback ====================
  // v1's api_set_feedback (app/main.py) — a 👍(+1)/👎(-1) on an assistant
  // message; re-rating overwrites (storage.ts's setMessageFeedback upsert).
  // Lives here rather than issue-routes.ts: this is a session/message
  // concept, not an issue-tracker one (matches v1's own file layout — this
  // sits under main.py's "Message feedback" section, nowhere near "Issues").

  app.post("/api/feedback", async (c) => {
    const user = c.get("user");
    let body: { session_id?: unknown; message_id?: unknown; rating?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ detail: "Invalid JSON body" }, 422);
    }
    if (
      typeof body.session_id !== "string" ||
      typeof body.message_id !== "number" ||
      typeof body.rating !== "number"
    ) {
      return c.json({ detail: "session_id, message_id, and rating are required" }, 422);
    }
    if (body.rating !== 1 && body.rating !== -1) {
      return c.json({ detail: "rating must be 1 or -1" }, 400);
    }
    const session = await deps.db.getSession(body.session_id);
    if (!session || !userOwnsSession(session, user)) {
      return c.json({ detail: "Access denied" }, 403);
    }
    // The message must actually belong to the claimed session — otherwise
    // a crafted request could rate arbitrary messages across sessions.
    if ((await deps.db.getMessageSessionId(body.message_id)) !== body.session_id) {
      return c.json({ detail: "Message not found in this session" }, 404);
    }
    await deps.db.setMessageFeedback(body.message_id, body.session_id, user.id, body.rating);
    return c.json({ ok: true });
  });

  // ==================== Issues ====================
  // Task-Phase-5: submit/action/check-duplicates/mine — port of v1's
  // app/main.py "Issues" section. See issue-routes.ts's own header for the
  // full rationale and the getRepoAdmin/listReposFull credential warning.
  mountIssueRoutes(app, deps);

  // GitHub/GitLab webhook receiver (2026-07-13) — see webhook-routes.ts's
  // own header. Bypasses the /api/* auth middleware above (GitHub/GitLab
  // never send our JWT); authenticates the request itself instead.
  mountWebhookRoutes(app, deps);

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
  mountAdminDashboardRoutes(app, deps);

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
