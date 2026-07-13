// Admin API — user/repo/permission CRUD, mounted at /api/admin/* by
// buildApp (src/server/app.ts) behind a role==="admin" guard registered
// there (see app.ts's "Admin" section). Port of
// `git show v1-python-final:app/admin.py`'s users/repos/permissions
// sections only — usage/feedback/issue-tracking/semantic-search-log
// routes are Phase 5's admin dashboard, deliberately out of scope.
//
// v1's per-route `Depends(get_existing_user)`/`Depends(get_existing_repo)`
// 404 dependencies have no Hono equivalent worth building for three
// sections' worth of routes — each handler that operates on a specific id
// just does its own early-return 404 (get_existing_user/get_existing_repo
// inlined at the call site).
//
// syncAndPersist is injectable (deps.syncAndPersist) rather than hardcoded
// to repo-sync.ts's real export: production (src/server/main.ts, via
// buildApp) never sets it, so the real implementation (with its SSRF gate)
// is what actually runs. Tests inject repo-sync.ts's
// `__internal.syncAndPersistUnvalidated` to exercise a REAL git clone/pull
// against a local temp bare repo without the SSRF gate rejecting it
// (127.0.0.1/bare local paths are exactly what that gate exists to
// block) — see repo-sync.test.ts's own header comment for why that split
// exists; this is the same pattern, reused rather than re-invented.
import type { Hono, Context } from "hono";
import type { DbClient } from "../db/client.js";
import type { Settings } from "../config.js";
import type { FullRepoRow } from "../db/storage.js";
import type { Env } from "./app.js";
import {
  syncAndPersist as realSyncAndPersist,
  maskUrlCredentials,
  type SyncAndPersistOptions,
} from "../repo-sync.js";
import { hashPassword } from "../auth.js";

export type SyncAndPersistFn = (
  db: DbClient,
  opts: SyncAndPersistOptions,
  onSyncSuccess?: (repoId: number, localPath: string) => void
) => Promise<{ ok: boolean; message: string }>;

export type AdminRoutesDeps = {
  db: DbClient;
  settings: Settings;
  syncAndPersist?: SyncAndPersistFn;
};

async function parseBody<T = Record<string, unknown>>(c: Context<Env>): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

// v1's _admin_repo_view: cred_username isn't secret (it's just who we
// authenticate as) so it's shown as-is; cred_token is never echoed back —
// only whether one is set. The retired combined `credentials` legacy
// column that v1 also stripped here never existed in v2's schema (Task 1),
// so there is nothing to strip. The url itself is masked too, same reason
// as cred_token: an admin can paste a credential directly into the url
// field instead of using the dedicated cred_* fields.
function adminRepoView(repo: FullRepoRow): Record<string, unknown> {
  const { cred_token, ...rest } = repo;
  return {
    ...rest,
    has_token: Boolean(cred_token),
    url: maskUrlCredentials(rest.url),
  };
}

const ACCESS_LEVELS = new Set(["read", "write", "admin"]);

// BUG-001 (QA report): repeat/double-click submissions of the same repo URL
// silently created duplicate rows — no uniqueness check existed anywhere
// (v1 had none either, git show v1-python-final:app/database.py's
// create_repo; confirmed not a v2 regression). Trailing-slash/`.git`-suffix
// differences are the realistic "same repo, slightly different spelling"
// case (not case-folded — git hosts are commonly case-sensitive on the
// path segment, only case-INsensitive on the host, and collapsing that
// would risk conflating two genuinely different repos).
export function normalizeRepoUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.toLowerCase().endsWith(".git")) u = u.slice(0, -4);
  return u;
}

export function mountAdminRoutes(app: Hono<Env>, deps: AdminRoutesDeps): void {
  const sync: SyncAndPersistFn = deps.syncAndPersist ?? realSyncAndPersist;

  // ==================== Users ====================

  app.get("/api/admin/users", async (c) => c.json(await deps.db.listUsers()));

  app.post("/api/admin/users", async (c) => {
    const body = await parseBody<{ username?: unknown; password?: unknown; role?: unknown }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    if (typeof body.username !== "string" || !body.username) {
      return c.json({ detail: "username is required" }, 422);
    }
    if (typeof body.password !== "string" || body.password.length < 8) {
      return c.json({ detail: "password must be at least 8 characters" }, 422);
    }
    const role = typeof body.role === "string" ? body.role : "user";

    const existing = await deps.db.getUserByUsername(body.username);
    if (existing) return c.json({ detail: "Username already exists" }, 409);

    const passwordHash = await hashPassword(body.password);
    const id = await deps.db.createUser(body.username, passwordHash, role);
    return c.json({ id, username: body.username, role });
  });

  app.patch("/api/admin/users/:id", async (c) => {
    const userId = Number(c.req.param("id"));
    const user = Number.isFinite(userId) ? await deps.db.getUserById(userId) : null;
    if (!user) return c.json({ detail: "User not found" }, 404);

    const body = await parseBody<{ password?: unknown; is_active?: unknown }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);

    // Validate the whole body BEFORE writing anything — a request with a
    // valid password but an invalid is_active must not leave the password
    // changed while still returning 422 for the rest of the payload.
    const hasPassword = body.password !== undefined && body.password !== null;
    if (hasPassword && (typeof body.password !== "string" || body.password.length < 8)) {
      return c.json({ detail: "password must be at least 8 characters" }, 422);
    }
    const hasIsActive = body.is_active !== undefined && body.is_active !== null;
    if (hasIsActive && typeof body.is_active !== "boolean") {
      return c.json({ detail: "is_active must be a boolean" }, 422);
    }

    if (hasPassword) {
      await deps.db.updateUserPassword(userId, await hashPassword(body.password as string));
    }
    if (hasIsActive) {
      await deps.db.setUserActive(userId, body.is_active as boolean);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", async (c) => {
    const userId = Number(c.req.param("id"));
    const user = Number.isFinite(userId) ? await deps.db.getUserById(userId) : null;
    if (!user) return c.json({ detail: "User not found" }, 404);
    if (user.role === "admin") return c.json({ detail: "Cannot delete admin user" }, 403);
    await deps.db.deleteUser(userId);
    return c.json({ ok: true });
  });

  // ==================== Repositories ====================

  app.get("/api/admin/repos", async (c) => {
    // DbClient.listRepos() is the client-safe subset (no credentials, no
    // sync bookkeeping) — the admin view needs the full row per id to
    // compute has_token/mask the url, so this fans out through
    // getRepoAdmin rather than using v1's single `SELECT *` list_repos.
    const repos = await deps.db.listRepos();
    const full = await Promise.all(repos.map((r) => deps.db.getRepoAdmin(r.id)));
    return c.json(full.filter((r): r is FullRepoRow => r !== null).map(adminRepoView));
  });

  app.get("/api/admin/repos/:id", async (c) => {
    const repoId = Number(c.req.param("id"));
    const repo = Number.isFinite(repoId) ? await deps.db.getRepoAdmin(repoId) : null;
    if (!repo) return c.json({ detail: "Repo not found" }, 404);
    return c.json(adminRepoView(repo));
  });

  app.post("/api/admin/repos", async (c) => {
    const body = await parseBody<{
      name?: unknown;
      url?: unknown;
      description?: unknown;
      branch?: unknown;
      cred_username?: unknown;
      cred_token?: unknown;
    }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    if (typeof body.name !== "string" || !body.name) {
      return c.json({ detail: "name is required" }, 422);
    }
    if (typeof body.url !== "string" || !body.url) {
      return c.json({ detail: "url is required" }, 422);
    }
    const description = typeof body.description === "string" ? body.description : "";
    const branch = typeof body.branch === "string" ? body.branch : null;
    const credUsername = typeof body.cred_username === "string" ? body.cred_username : null;
    const credToken = typeof body.cred_token === "string" ? body.cred_token : null;

    // BUG-001 (QA report): reject an obvious duplicate before cloning — see
    // normalizeRepoUrl's comment. A check-then-insert has a narrow TOCTOU
    // window between two truly simultaneous requests, but this is an
    // admin-only, human-driven action (not a hot path); the frontend's
    // disable-on-submit (web/admin.js) covers the realistic case (an
    // impatient double-click), and this covers a deliberate re-submission.
    const normalizedNewUrl = normalizeRepoUrl(body.url);
    const existingRepos = await deps.db.listRepos();
    if (existingRepos.some((r) => normalizeRepoUrl(r.url) === normalizedNewUrl)) {
      return c.json({ detail: "A repository with this URL already exists" }, 409);
    }

    const id = await deps.db.createRepo({
      name: body.name,
      url: body.url,
      description,
      branch,
      credUsername,
      credToken,
    });

    // Clone the repo now (blocking) — matches v1's synchronous
    // `await sync_and_persist`: the create-repo response reports whether
    // the clone actually worked rather than "queued, check back later".
    const result = await sync(deps.db, {
      repoId: id,
      url: body.url,
      reposDir: deps.settings.reposDir,
      branch,
      credUsername,
      credToken,
    });

    return c.json({
      id,
      name: body.name,
      url: body.url,
      branch,
      synced: result.ok,
      sync_message: result.message,
    });
  });

  app.patch("/api/admin/repos/:id", async (c) => {
    const repoId = Number(c.req.param("id"));
    const repo = Number.isFinite(repoId) ? await deps.db.getRepoAdmin(repoId) : null;
    if (!repo) return c.json({ detail: "Repo not found" }, 404);

    const body = await parseBody<{
      name?: unknown;
      url?: unknown;
      description?: unknown;
      branch?: unknown;
      cred_username?: unknown;
      cred_token?: unknown;
    }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);

    // undefined = "leave unchanged" for every field below — matches v1's
    // Optional[...] = None convention (a JSON `null` collapses to the same
    // "leave unchanged" bucket as an omitted key, exactly like v1's
    // `req.field is not None` checks; only a real string value, including
    // "", counts as a provided value).
    const name = typeof body.name === "string" ? body.name : undefined;
    const description = typeof body.description === "string" ? body.description : undefined;
    const url = typeof body.url === "string" ? body.url : undefined;
    const branch = typeof body.branch === "string" ? body.branch : undefined;
    const credUsername = typeof body.cred_username === "string" ? body.cred_username : undefined;
    const credToken = typeof body.cred_token === "string" ? body.cred_token : undefined;

    // Cosmetic fields are safe to update immediately regardless of sync
    // outcome — matches v1's ordering exactly (this UPDATE runs first,
    // unconditionally, before any sync is even considered).
    await deps.db.updateRepo(repoId, { name, description });

    const urlChanged = url !== undefined && url !== repo.url;
    const branchChanged = branch !== undefined && branch !== (repo.branch ?? "");
    const usernameChanged = credUsername !== undefined && credUsername !== (repo.cred_username ?? "");
    const tokenChanged = credToken !== undefined && credToken !== (repo.cred_token ?? "");

    // BUG-001 follow-up (QA report, 2026-07-13): POST's duplicate-URL check
    // only ever guarded creation — retargeting an EXISTING repo's url via
    // PATCH to match another repo's url bypassed it entirely (create A,
    // create B, then PATCH B's url to A's). Same normalizeRepoUrl rule,
    // just scoped to exclude this repo's own (about-to-be-replaced) row.
    if (urlChanged) {
      const normalizedNewUrl = normalizeRepoUrl(url);
      const otherRepos = (await deps.db.listRepos()).filter((r) => r.id !== repoId);
      if (otherRepos.some((r) => normalizeRepoUrl(r.url) === normalizedNewUrl)) {
        return c.json({ detail: "A repository with this URL already exists" }, 409);
      }
    }

    if (urlChanged || branchChanged || usernameChanged || tokenChanged) {
      const result = await sync(deps.db, {
        repoId,
        url: url ?? repo.url,
        reposDir: deps.settings.reposDir,
        branch: branch ?? repo.branch,
        forceReclone: true,
        credUsername: credUsername ?? repo.cred_username,
        credToken: credToken ?? repo.cred_token,
      });

      if (!result.ok) {
        return c.json(
          {
            detail: `Repo record kept unchanged — resync with the new url/branch/credentials failed: ${result.message}`,
          },
          502
        );
      }

      // Only commit the new url/branch/credentials once the resync
      // actually succeeded, so the DB never describes a repo that isn't
      // what's actually on disk.
      await deps.db.updateRepo(repoId, { url, branch, credUsername, credToken });
    }

    return c.json({ ok: true });
  });

  app.delete("/api/admin/repos/:id", async (c) => {
    const repoId = Number(c.req.param("id"));
    const repo = Number.isFinite(repoId) ? await deps.db.getRepoAdmin(repoId) : null;
    if (!repo) return c.json({ detail: "Repo not found" }, 404);
    await deps.db.deleteRepo(repoId);
    return c.json({ ok: true });
  });

  app.post("/api/admin/repos/:id/sync", async (c) => {
    const repoId = Number(c.req.param("id"));
    const repo = Number.isFinite(repoId) ? await deps.db.getRepoAdmin(repoId) : null;
    if (!repo) return c.json({ detail: "Repo not found" }, 404);

    const result = await sync(deps.db, {
      repoId,
      url: repo.url,
      reposDir: deps.settings.reposDir,
      branch: repo.branch,
      credUsername: repo.cred_username,
      credToken: repo.cred_token,
    });
    return c.json({ ok: result.ok, message: result.message });
  });

  // ==================== Permissions ====================

  app.get("/api/admin/permissions", async (c) => c.json(await deps.db.listPermissions()));

  app.post("/api/admin/permissions", async (c) => {
    const body = await parseBody<{ user_id?: unknown; repo_id?: unknown; access_level?: unknown }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    if (typeof body.user_id !== "number") return c.json({ detail: "user_id is required" }, 422);
    if (typeof body.repo_id !== "number") return c.json({ detail: "repo_id is required" }, 422);
    const accessLevel = body.access_level === undefined ? "read" : body.access_level;
    if (typeof accessLevel !== "string" || !ACCESS_LEVELS.has(accessLevel)) {
      return c.json({ detail: "access_level must be one of read, write, admin" }, 422);
    }

    const user = await deps.db.getUserById(body.user_id);
    if (!user) return c.json({ detail: "User not found" }, 404);
    const repo = await deps.db.getRepo(body.repo_id);
    if (!repo) return c.json({ detail: "Repo not found" }, 404);

    const id = await deps.db.grantPermission(body.user_id, body.repo_id, accessLevel);
    return c.json({ id, user_id: body.user_id, repo_id: body.repo_id, access_level: accessLevel });
  });

  app.delete("/api/admin/permissions/:userId/:repoId", async (c) => {
    const userId = Number(c.req.param("userId"));
    const repoId = Number(c.req.param("repoId"));
    await deps.db.revokePermission(userId, repoId);
    return c.json({ ok: true });
  });
}
