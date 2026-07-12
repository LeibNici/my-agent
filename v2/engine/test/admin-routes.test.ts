// Task 7 — admin API: user/repo/permission CRUD at /api/admin/*, admin-only.
// Oracle: `git show v1-python-final:app/admin.py`'s users/repos/permissions
// sections (usage/feedback/issue-tracking/semantic-search-log are Phase 5,
// out of scope). See src/server/admin-routes.ts's header for the
// syncAndPersist-injection rationale this file leans on throughout: every
// repo test below injects repo-sync.ts's __internal.syncAndPersistUnvalidated
// so create/update/sync exercise a REAL git clone/pull against a local temp
// bare repo without the production SSRF gate (which exists precisely to
// reject local/loopback addresses) getting in the way.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import { createToken } from "../src/auth.js";
import { buildApp, type BuildAppDeps } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";
import { __internal } from "../src/repo-sync.js";
import type { SyncAndPersistFn } from "../src/server/admin-routes.js";

const noopEngine: RunTurnFn = async function* () {};

function initOriginRepo(originDir: string): void {
  mkdirSync(originDir, { recursive: true });
  const run = (args: string[]) => execFileSync("git", args, { cwd: originDir });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(originDir, "README.md"), "hello\n");
  run(["add", "-A"]);
  run(["commit", "-m", "initial"]);
}

let dir: string, dbPath: string, client: DbClient, settings: Settings, reposDir: string;

beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  dbPath = f.dbPath;
  client = createDbClient(f.dbPath);
  reposDir = mkdtempSync(join(tmpdir(), "admin-routes-repos-"));
  settings = loadSettings({
    APP_JWT_SECRET: "test-secret-do-not-use-in-prod",
    APP_REPOS_DIR: reposDir,
  });
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(reposDir, { recursive: true, force: true });
});

async function seedUser(role: "user" | "admin" = "user", username = "alice"): Promise<{ id: number; token: string }> {
  const id = await client.createUser(username, "hashed-pw", role);
  const token = createToken({ id, username, role }, settings);
  return { id, token };
}

// Every test in this file needs a REAL sync path (no network, no SSRF gate)
// so create/update/sync routes can be exercised end to end — this is the
// one deps override every buildTestApp() call needs, per admin-routes.ts's
// injection design.
function buildTestApp(extra: Partial<BuildAppDeps> = {}) {
  return buildApp({
    db: client,
    settings,
    engine: noopEngine,
    syncAndPersist: __internal.syncAndPersistUnvalidated,
    ...extra,
  });
}

function authed(
  app: ReturnType<typeof buildApp>,
  token: string,
  path: string,
  init: RequestInit = {}
) {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

// ==================== Admin-only guard ====================

describe("admin-only guard", () => {
  it.each([
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/admin/repos"],
    ["POST", "/api/admin/repos"],
    ["GET", "/api/admin/permissions"],
    ["POST", "/api/admin/permissions"],
  ])("%s %s → 403 {detail} for an authenticated non-admin", async (method, path) => {
    const { token } = await seedUser("user");
    const app = buildTestApp();
    const resp = await authed(app, token, path, { method, body: method === "GET" ? undefined : "{}" });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Admin access required" });
  });

  it("missing token → 401 (the blanket /api/* auth middleware, not the admin guard)", async () => {
    const app = buildTestApp();
    const resp = await app.request("/api/admin/users");
    expect(resp.status).toBe(401);
  });
});

// ==================== Users ====================

describe("users CRUD", () => {
  it("POST creates a user, hashes the password, defaults role=user", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "longenough1" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toMatchObject({ username: "bob", role: "user" });
    const row = await client.getUserById(body.id);
    expect(row).not.toBeNull();
    expect(row!.password_hash).not.toBe("longenough1");
  });

  it("POST duplicate username → 409", async () => {
    const { token } = await seedUser("admin");
    await client.createUser("bob", "x", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "longenough1" }),
    });
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ detail: "Username already exists" });
  });

  it("POST short password → 422", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "short" }),
    });
    expect(resp.status).toBe(422);
  });

  it("GET lists users without password_hash", async () => {
    const { token } = await seedUser("admin");
    await client.createUser("bob", "hash", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users");
    expect(resp.status).toBe(200);
    const list = await resp.json();
    const bob = list.find((u: { username: string }) => u.username === "bob");
    expect(bob).toBeDefined();
    expect(bob.password_hash).toBeUndefined();
  });

  it("PATCH updates password and is_active", async () => {
    const { token } = await seedUser("admin");
    const targetId = await client.createUser("bob", "oldhash", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/users/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "newlongpassword", is_active: false }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    const row = await client.getUserById(targetId);
    expect(row!.password_hash).not.toBe("oldhash");
    expect(row!.is_active).toBe(0);
  });

  it("PATCH nonexistent user → 404", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users/999999", { method: "PATCH", body: "{}" });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "User not found" });
  });

  it("DELETE removes a non-admin user", async () => {
    const { token } = await seedUser("admin");
    const targetId = await client.createUser("bob", "hash", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/users/${targetId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(await client.getUserById(targetId)).toBeNull();
  });

  it("DELETE admin user → 403, row untouched", async () => {
    const { token } = await seedUser("admin");
    const targetId = await client.createUser("root2", "hash", "admin");
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/users/${targetId}`, { method: "DELETE" });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Cannot delete admin user" });
    expect(await client.getUserById(targetId)).not.toBeNull();
  });

  it("DELETE nonexistent user → 404", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/users/999999", { method: "DELETE" });
    expect(resp.status).toBe(404);
  });
});

// ==================== Repositories ====================

describe("repos", () => {
  it("POST creates + synchronously syncs (real git clone against a temp bare repo)", async () => {
    const { token } = await seedUser("admin");
    const originDir = mkdtempSync(join(tmpdir(), "admin-routes-origin-"));
    initOriginRepo(originDir);
    try {
      const app = buildTestApp();
      const resp = await authed(app, token, "/api/admin/repos", {
        method: "POST",
        body: JSON.stringify({ name: "r1", url: originDir }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toMatchObject({ name: "r1", url: originDir, branch: null, synced: true });
      expect(typeof body.sync_message).toBe("string");

      const row = await client.getRepoAdmin(body.id);
      expect(row!.last_sync_status).toBe("ok");
      expect(existsSync(join(row!.local_path!, ".git"))).toBe(true);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it("GET list applies _admin_repo_view: has_token bool, no cred_token, masked url", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({
      name: "r1",
      url: "https://user:secret@example.com/r1.git",
      credUsername: "bot",
      credToken: "tok123",
    });
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/repos");
    expect(resp.status).toBe(200);
    const list = await resp.json();
    const r = list.find((x: { id: number }) => x.id === repoId);
    expect(r).toBeDefined();
    expect(r.has_token).toBe(true);
    expect(r.cred_token).toBeUndefined();
    expect(r.cred_username).toBe("bot");
    expect(r.url).toBe("https://example.com/r1.git");
  });

  it("GET /:id 404 for nonexistent repo", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/repos/999999");
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "Repo not found" });
  });

  it("PATCH cosmetic-only fields updates immediately and never calls sync", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    let syncCalls = 0;
    const spySync: SyncAndPersistFn = async (db, opts, onSyncSuccess) => {
      syncCalls++;
      return __internal.syncAndPersistUnvalidated(db, opts, onSyncSuccess);
    };
    const app = buildTestApp({ syncAndPersist: spySync });
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed", description: "new desc" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(syncCalls).toBe(0);
    const row = await client.getRepoAdmin(repoId);
    expect(row!.name).toBe("renamed");
    expect(row!.description).toBe("new desc");
    expect(row!.url).toBe("https://example.com/r1.git");
  });

  it("PATCH url change triggers a forceReclone resync (real git) and commits the new url", async () => {
    const { token } = await seedUser("admin");
    const originDir = mkdtempSync(join(tmpdir(), "admin-routes-origin2-"));
    initOriginRepo(originDir);
    try {
      const repoId = await client.createRepo({ name: "r1", url: "https://example.com/old.git" });
      const app = buildTestApp();
      const resp = await authed(app, token, `/api/admin/repos/${repoId}`, {
        method: "PATCH",
        body: JSON.stringify({ url: originDir }),
      });
      expect(resp.status).toBe(200);
      const row = await client.getRepoAdmin(repoId);
      expect(row!.url).toBe(originDir);
      expect(row!.last_sync_status).toBe("ok");
      expect(existsSync(join(row!.local_path!, ".git"))).toBe(true);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it("PATCH url change whose resync fails → 502, DB config (url) kept unchanged", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/old.git", branch: "main" });
    const badUrl = join(reposDir, "does-not-exist-xyz"); // real path, but no git repo there — clone fails
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, {
      method: "PATCH",
      body: JSON.stringify({ url: badUrl }),
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.detail).toContain("Repo record kept unchanged");

    const row = await client.getRepoAdmin(repoId);
    expect(row!.url).toBe("https://example.com/old.git");
    expect(row!.branch).toBe("main");
    // syncAndPersist itself still records the failed attempt (v1 ordering:
    // only the CONFIG fields are held back, not the sync-status bookkeeping)
    expect(row!.last_sync_status).toBe("error");
  });

  it("DELETE removes a repo", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(await client.getRepoAdmin(repoId)).toBeNull();
  });

  it("DELETE nonexistent repo → 404", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/repos/999999", { method: "DELETE" });
    expect(resp.status).toBe(404);
  });

  it("POST /:id/sync manually re-syncs (real git)", async () => {
    const { token } = await seedUser("admin");
    const originDir = mkdtempSync(join(tmpdir(), "admin-routes-origin3-"));
    initOriginRepo(originDir);
    try {
      const repoId = await client.createRepo({ name: "r1", url: originDir });
      const app = buildTestApp();
      const resp = await authed(app, token, `/api/admin/repos/${repoId}/sync`, { method: "POST" });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.ok).toBe(true);
      expect(typeof body.message).toBe("string");
      const row = await client.getRepoAdmin(repoId);
      expect(row!.last_sync_status).toBe("ok");
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it("POST /:id/sync 404 for nonexistent repo", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/repos/999999/sync", { method: "POST" });
    expect(resp.status).toBe(404);
  });
});

// ==================== Permissions ====================

describe("permissions", () => {
  it("POST grants permission, defaulting access_level to read", async () => {
    const { token } = await seedUser("admin");
    const userId = await client.createUser("bob", "hash", "user");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/permissions", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, repo_id: repoId }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      id: expect.any(Number),
      user_id: userId,
      repo_id: repoId,
      access_level: "read",
    });
  });

  it("POST grant for a ghost user_id → 404 before touching permissions", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/permissions", {
      method: "POST",
      body: JSON.stringify({ user_id: 999999, repo_id: repoId }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "User not found" });
    expect(await client.listPermissions()).toEqual([]);
  });

  it("POST grant for a ghost repo_id → 404", async () => {
    const { token } = await seedUser("admin");
    const userId = await client.createUser("bob", "hash", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/permissions", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, repo_id: 999999 }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "Repo not found" });
  });

  it("GET lists permissions with the username/repo_name JOIN", async () => {
    const { token } = await seedUser("admin");
    const userId = await client.createUser("bob", "hash", "user");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await client.grantPermission(userId, repoId, "write");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/permissions");
    expect(resp.status).toBe(200);
    const list = await resp.json();
    expect(list).toContainEqual(
      expect.objectContaining({ user_id: userId, username: "bob", repo_id: repoId, repo_name: "r1", access_level: "write" })
    );
  });

  it("DELETE revokes a permission", async () => {
    const { token } = await seedUser("admin");
    const userId = await client.createUser("bob", "hash", "user");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await client.grantPermission(userId, repoId, "read");
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/permissions/${userId}/${repoId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    const list = await client.listPermissions();
    expect(list.find((p) => p.user_id === userId && p.repo_id === repoId)).toBeUndefined();
  });
});
