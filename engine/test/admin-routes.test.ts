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
import { createToken, hashPassword } from "../src/auth.js";
import { buildApp, type BuildAppDeps } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";
import { __internal, getRepoLocalPath } from "../src/repo-sync.js";
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

// Codex full-repo review (2026-07-14, production QA): repo create/manual
// sync are now fire-and-forget (see admin-routes.ts's own comment on why —
// a route blocking on up to 120s of git meant a slow/degraded network path
// was indistinguishable from a genuine hang) — the HTTP response no longer
// carries the sync outcome, so tests that care about the eventual result
// need to poll the DB row until repo-sync.ts's transient "syncing" status
// clears. Also needed so afterEach's client.close() never races an
// in-flight background sync (which would otherwise log a stray "db client
// is closed" error from the fire-and-forget promise's own .catch).
async function waitForSyncSettled(repoId: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const row = await client.getRepoAdmin(repoId);
    if (row && row.last_sync_status !== "syncing") return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForSyncSettled(${repoId}) timed out`);
    await new Promise((r) => setTimeout(r, 10));
  }
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
    ["GET", "/api/admin/webhook-config"],
    ["POST", "/api/admin/webhook-config/regenerate"],
    ["GET", "/api/admin/llm-config"],
    ["POST", "/api/admin/llm-config"],
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

  // Codex full-repo review (2026-07-14, Warning): updateUserPassword (the
  // same storage method both the self-service change-password route and
  // this admin reset route call) now bumps token_version — an admin
  // resetting a compromised user's password must actually kick out
  // whatever session the attacker was using, not just change what password
  // would be needed for a NEW login.
  it("PATCH password reset revokes the TARGET user's existing token (not the admin's)", async () => {
    const { token: adminToken } = await seedUser("admin");
    const targetId = await client.createUser("bob", await hashPassword("bobs-old-password"), "user");
    const targetOldToken = createToken({ id: targetId, username: "bob", role: "user" }, settings);
    const app = buildTestApp();

    const resp = await authed(app, adminToken, `/api/admin/users/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "bobs-new-password-123" }),
    });
    expect(resp.status).toBe(200);

    const targetStillWorks = await authed(app, targetOldToken, "/api/auth/me");
    expect(targetStillWorks.status).toBe(401);

    // The admin's OWN token (a different user row, never touched) is unaffected.
    const adminStillWorks = await authed(app, adminToken, "/api/admin/users");
    expect(adminStillWorks.status).toBe(200);
  });

  it("PATCH with valid password + invalid is_active → 422, password left untouched (validate before write)", async () => {
    const { token } = await seedUser("admin");
    const targetId = await client.createUser("bob", "oldhash", "user");
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/users/${targetId}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "newlongpassword", is_active: "not-a-boolean" }),
    });
    expect(resp.status).toBe(422);
    const row = await client.getUserById(targetId);
    expect(row!.password_hash).toBe("oldhash");
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
  it("POST creates immediately (fire-and-forget sync), row transitions syncing -> ok once the background clone actually finishes", async () => {
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
      // Codex full-repo review (2026-07-14, production QA): the response no
      // longer carries synced/sync_message — the background sync hasn't
      // necessarily finished (or even started) by the time this resolves.
      expect(body).toMatchObject({ name: "r1", url: originDir, branch: null });
      expect(body.synced).toBeUndefined();
      expect(body.sync_message).toBeUndefined();

      await waitForSyncSettled(body.id);
      const row = await client.getRepoAdmin(body.id);
      expect(row!.last_sync_status).toBe("ok");
      expect(existsSync(join(row!.local_path!, ".git"))).toBe(true);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it("POST 同一 URL 重复提交 → 409，不产生第二条仓库记录（BUG-001）", async () => {
    // 本地不存在的路径（同 "PATCH url 变更导致 resync 失败" 用例的写法）——
    // sync 会失败但 POST 本身仍返回 200（只有 PATCH 才在 resync 失败时 502），
    // 而且失败得够快，不用等真正的网络/git 超时。
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const url = join(reposDir, "dup-test-repo");
    const first = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r1", url }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r1-again", url }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ detail: "A repository with this URL already exists" });

    const all = await client.listRepos();
    expect(all.filter((r) => r.url === url)).toHaveLength(1);
    await waitForSyncSettled(firstBody.id);
  });

  it("POST 同一仓库但 URL 只差末尾斜杠 → 仍判定重复 → 409", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const url = join(reposDir, "dup-test-repo2");
    const first = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r1", url }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r1-slash", url: `${url}/` }),
    });
    expect(second.status).toBe(409);
    await waitForSyncSettled(firstBody.id);
  });

  it("POST 真正不同的 URL → 正常创建，不受重复检查影响", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const first = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r1", url: join(reposDir, "dup-test-repo3a") }),
    });
    const firstBody = await first.json();
    const second = await authed(app, token, "/api/admin/repos", {
      method: "POST",
      body: JSON.stringify({ name: "r2", url: join(reposDir, "dup-test-repo3b") }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    await Promise.all([waitForSyncSettled(firstBody.id), waitForSyncSettled(secondBody.id)]);
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

  it("PATCH url 改成另一仓库的 URL → 409，不触发 sync，不绕过 BUG-001（QA follow-up）", async () => {
    const { token } = await seedUser("admin");
    const urlA = "https://example.com/repo-a.git";
    await client.createRepo({ name: "a", url: urlA });
    const repoB = await client.createRepo({ name: "b", url: "https://example.com/repo-b.git" });
    let syncCalls = 0;
    const spySync: SyncAndPersistFn = async (db, opts, onSyncSuccess) => {
      syncCalls++;
      return __internal.syncAndPersistUnvalidated(db, opts, onSyncSuccess);
    };
    const app = buildTestApp({ syncAndPersist: spySync });
    const resp = await authed(app, token, `/api/admin/repos/${repoB}`, {
      method: "PATCH",
      body: JSON.stringify({ url: urlA }),
    });
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ detail: "A repository with this URL already exists" });
    expect(syncCalls).toBe(0);
    const row = await client.getRepoAdmin(repoB);
    expect(row!.url).toBe("https://example.com/repo-b.git");
  });

  it("PATCH url 只差末尾斜杠命中另一仓库 → 仍判定重复 → 409", async () => {
    const { token } = await seedUser("admin");
    const urlA = "https://example.com/repo-slash.git";
    await client.createRepo({ name: "a", url: urlA });
    const repoB = await client.createRepo({ name: "b", url: "https://example.com/repo-slash-b.git" });
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoB}`, {
      method: "PATCH",
      body: JSON.stringify({ url: `${urlA}/` }),
    });
    expect(resp.status).toBe(409);
  });

  it("PATCH url 改回自己原来的值（未变化）→ 不触发重复检查", async () => {
    const { token } = await seedUser("admin");
    const url = "https://example.com/repo-self.git";
    const repoId = await client.createRepo({ name: "r1", url });
    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, {
      method: "PATCH",
      body: JSON.stringify({ url, name: "renamed" }),
    });
    expect(resp.status).toBe(200);
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

  it("DELETE 也清理本地 checkout 目录（Codex 全仓库审查，2026-07-14，Warning：以前只删 DB 行，本地代码永久留在磁盘上）", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    const localPath = getRepoLocalPath(reposDir, repoId);
    mkdirSync(localPath, { recursive: true });
    writeFileSync(join(localPath, "sentinel.txt"), "should be gone after delete");
    expect(existsSync(localPath)).toBe(true);

    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(existsSync(localPath)).toBe(false);
  });

  it("DELETE 对本来就没有本地 checkout 目录的 repo 仍然正常成功（不因为 ENOENT 报错）", async () => {
    const { token } = await seedUser("admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1-never-synced.git" });
    expect(existsSync(getRepoLocalPath(reposDir, repoId))).toBe(false);

    const app = buildTestApp();
    const resp = await authed(app, token, `/api/admin/repos/${repoId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("POST /:id/sync 立即返回（fire-and-forget），row 之后异步变成 ok（real git）", async () => {
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
      await waitForSyncSettled(repoId);
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

// ==================== Webhook config ====================

describe("webhook config", () => {
  it("GET returns the receiver paths and the configured secrets, not a guessed hostname", async () => {
    settings.githubWebhookSecret = "gh-secret-abc";
    settings.gitlabWebhookSecret = "gl-secret-xyz";
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/webhook-config");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      github_path: "/api/webhooks/github",
      github_secret: "gh-secret-abc",
      gitlab_path: "/api/webhooks/gitlab",
      gitlab_secret: "gl-secret-xyz",
    });
  });

  // 2026-07-14, after GitHub issue #6 (webhook secrets moved off the
  // filesystem and into the DB) — rotation is the whole point of that
  // move: an admin can invalidate a leaked/misconfigured secret without an
  // SSH session and a container restart.
  it("POST regenerate rotates the github secret, persists it, and updates the SAME process's in-memory settings immediately", async () => {
    settings.githubWebhookSecret = "old-github-secret";
    const { token } = await seedUser("admin");
    const app = buildTestApp();

    const resp = await authed(app, token, "/api/admin/webhook-config/regenerate", {
      method: "POST", body: JSON.stringify({ provider: "github" }),
    });
    expect(resp.status).toBe(200);
    const { secret } = await resp.json();
    expect(secret).not.toBe("old-github-secret");
    expect(secret.length).toBe(64);

    // The in-memory settings object this same buildApp instance holds must
    // already reflect the new value — webhook-routes.ts reads it directly
    // for signature verification, so a GET right after must agree.
    const getResp = await authed(app, token, "/api/admin/webhook-config");
    expect((await getResp.json()).github_secret).toBe(secret);

    // ...and it's durably persisted, not just held in memory.
    expect(await client.getOrCreateAppSecret("github_webhook_secret")).toBe(secret);
  });

  it("POST regenerate rotates ONLY the requested provider — gitlab's secret is untouched", async () => {
    settings.githubWebhookSecret = "old-github-secret";
    settings.gitlabWebhookSecret = "old-gitlab-secret";
    const { token } = await seedUser("admin");
    const app = buildTestApp();

    await authed(app, token, "/api/admin/webhook-config/regenerate", {
      method: "POST", body: JSON.stringify({ provider: "github" }),
    });

    const getResp = await authed(app, token, "/api/admin/webhook-config");
    expect((await getResp.json()).gitlab_secret).toBe("old-gitlab-secret");
  });

  it("POST regenerate with an invalid provider → 422, nothing changed", async () => {
    settings.githubWebhookSecret = "old-github-secret";
    const { token } = await seedUser("admin");
    const app = buildTestApp();

    const resp = await authed(app, token, "/api/admin/webhook-config/regenerate", {
      method: "POST", body: JSON.stringify({ provider: "bitbucket" }),
    });
    expect(resp.status).toBe(422);
    expect(settings.githubWebhookSecret).toBe("old-github-secret");
  });
});

// ==================== LLM config ====================
// 2026-07-14, production P0: a host-side .env permission mismatch made
// ANTHROPIC_API_KEY silently unreadable — see main.ts's post-load DB
// override comment for the full incident. These routes replace the .env
// file as the admin-facing way to configure the LLM provider.

describe("llm config", () => {
  it("GET never echoes the real api key — only whether one is configured, plus the non-secret fields", async () => {
    settings.apiKey = "sk-real-secret-value";
    settings.baseUrl = "https://dashscope.aliyuncs.com/apps/anthropic";
    settings.model = "qwen3.7-plus";
    settings.maxTokens = 8192;
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/llm-config");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({
      configured: true,
      base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
      model: "qwen3.7-plus",
      max_tokens: 8192,
    });
    expect(JSON.stringify(body)).not.toContain("sk-real-secret-value");
  });

  it("GET reports configured:false when no key is set", async () => {
    settings.apiKey = "";
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/llm-config");
    expect((await resp.json()).configured).toBe(false);
  });

  it("POST saves all four fields, persists to DB, updates the SAME process's in-memory settings immediately, and never echoes the key back", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/llm-config", {
      method: "POST",
      body: JSON.stringify({
        api_key: "sk-new-key",
        base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
        model: "qwen3.7-plus",
        max_tokens: 4096,
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ ok: true, configured: true });
    expect(JSON.stringify(body)).not.toContain("sk-new-key");

    // In-memory settings this process holds must already reflect it — the
    // very next chat turn should use the new key, no restart.
    expect(settings.apiKey).toBe("sk-new-key");
    expect(settings.baseUrl).toBe("https://dashscope.aliyuncs.com/apps/anthropic");
    expect(settings.model).toBe("qwen3.7-plus");
    expect(settings.maxTokens).toBe(4096);

    // ...and durably persisted.
    const stored = await client.getLlmConfig();
    expect(stored!.api_key).toBe("sk-new-key");
  });

  it("POST with a blank api_key keeps the previously-saved key — re-saving other fields can't accidentally wipe it", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    await authed(app, token, "/api/admin/llm-config", {
      method: "POST",
      body: JSON.stringify({ api_key: "sk-original", model: "qwen3.7-plus" }),
    });
    const resp = await authed(app, token, "/api/admin/llm-config", {
      method: "POST",
      body: JSON.stringify({ api_key: "", model: "qwen-max" }),
    });
    expect(resp.status).toBe(200);
    expect(settings.apiKey).toBe("sk-original");
    expect(settings.model).toBe("qwen-max");
  });

  it("POST with invalid JSON → 422", async () => {
    const { token } = await seedUser("admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/llm-config", { method: "POST", body: "not json" });
    expect(resp.status).toBe(422);
  });
});
