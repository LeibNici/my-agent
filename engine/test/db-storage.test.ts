import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStorage, SchemaError, type Storage } from "../src/db/storage.js";
import { makeSeededDb } from "./db-fixture.js";

let dir: string, dbPath: string, storage: Storage;
beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  dbPath = f.dbPath;
  storage = openStorage(dbPath);
});
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

describe("openStorage", () => {
  it("PRAGMA 生效：WAL / busy_timeout / foreign_keys", () => {
    const db = new Database(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
    // FK 由行为证明：不存在的 session 插消息必须炸
    expect(() => storage.addMessage("ghost", "user", "x")).toThrow(/FOREIGN KEY/i);
  });
  it("缺表 ⇒ SchemaError 点名", () => {
    const p2 = join(dir, "empty.db"); new Database(p2).close();
    expect(() => openStorage(p2)).toThrow(SchemaError);
    expect(() => openStorage(p2)).toThrow(/messages/);
  });
  it("独缺 users 表 ⇒ SchemaError 点名 users（其余表齐全时该检查才轮得到）", () => {
    const p3 = join(dir, "no-users.db");
    const db = new Database(p3);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat',
        owner_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL);
      CREATE TABLE llm_call_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        user_id INTEGER, model TEXT, iteration INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        ttft_ms INTEGER, total_ms INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE repositories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL);
      CREATE TABLE permissions (user_id INTEGER NOT NULL, repo_id INTEGER NOT NULL, access_level TEXT DEFAULT 'read');
    `);
    db.close();
    expect(() => openStorage(p3)).toThrow(SchemaError);
    expect(() => openStorage(p3)).toThrow(/users/);
  });
});

describe("addMessage / getMessages（test_message_codec goldens 对齐）", () => {
  it("纯字符串原样存取", () => {
    storage.addMessage("s1", "assistant", "普通回答");
    expect(storage.getMessages("s1")[0].content).toBe("普通回答");
  });
  it("块数组：pythonJsonDumps 落库（带空格分隔符），读回解析", () => {
    const blocks = [{ type: "tool_use", id: "tu_1", name: "code_search", input: { keyword: "不合格评审" } }];
    storage.addMessage("s1", "assistant", blocks);
    const db = new Database(dbPath);
    const raw = db.prepare("SELECT content FROM messages ORDER BY id DESC LIMIT 1").get() as { content: string };
    db.close();
    expect(raw.content).toBe('[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]');
    expect(storage.getMessages("s1")[0].content).toEqual(blocks);
  });
  it("[ 开头的非 JSON 字符串原样保留", () => {
    storage.addMessage("s1", "user", "[系统] 这不是JSON");
    expect(storage.getMessages("s1")[0].content).toBe("[系统] 这不是JSON");
  });
  it("插入顺序 = 读取顺序；session.updated_at 被 addMessage 刷新为同一时间戳", () => {
    const id0 = storage.addMessage("s1", "user", "m0");
    storage.addMessage("s1", "user", "m1");
    expect(storage.getMessages("s1").map(m => m.content)).toEqual(["m0", "m1"]);
    expect(typeof id0).toBe("number");
    const db = new Database(dbPath);
    const sess = db.prepare("SELECT updated_at FROM sessions WHERE id='s1'").get() as { updated_at: string };
    const msg = db.prepare("SELECT timestamp FROM messages WHERE id=?").get(
      storage.getMessages("s1")[1].id) as { timestamp: string };
    db.close();
    expect(sess.updated_at).toBe(msg.timestamp);
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
});

describe("recordLlmCallMetrics", () => {
  it("批量单事务、全批同一 created_at、空批 no-op", () => {
    storage.recordLlmCallMetrics([]);
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: 1, model: "m", iteration: 1, input_tokens: 10, output_tokens: 5, ttft_ms: 100, total_ms: 200 },
      { session_id: "s1", user_id: 1, model: "m", iteration: 2, input_tokens: 20, output_tokens: 6, ttft_ms: 90, total_ms: 150 },
    ]);
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT * FROM llm_call_metrics ORDER BY id").all() as any[];
    db.close();
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBe(rows[1].created_at);
    expect(rows[1].iteration).toBe(2);
  });
});

describe("createUser / getUserByUsername（v1 database.py 同语义）", () => {
  it("round trip：返回 lastrowid，读回完整行", () => {
    const id = storage.createUser("alice", "hashed-pw", "user");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
    const row = storage.getUserByUsername("alice");
    expect(row).not.toBeNull();
    expect(row).toMatchObject({ id, username: "alice", password_hash: "hashed-pw", role: "user" });
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
  it("role 省略时默认 'user'（对照 v1 create_user 的默认参数）", () => {
    storage.createUser("bob", "hashed-pw");
    expect(storage.getUserByUsername("bob")!.role).toBe("user");
  });
  it("显式 role 直通（如 'admin'）", () => {
    storage.createUser("root", "hashed-pw", "admin");
    expect(storage.getUserByUsername("root")!.role).toBe("admin");
  });
  it("不存在的用户名 ⇒ null（不是抛错、不是 undefined）", () => {
    expect(storage.getUserByUsername("ghost-user")).toBeNull();
  });
  it("is_active 默认为 1（列存在但 createUser 不显式写它，交给 DEFAULT）", () => {
    storage.createUser("carol", "hashed-pw");
    expect(storage.getUserByUsername("carol")!.is_active).toBe(1);
  });
  it("连续创建两个用户 id 递增；重复用户名违反 UNIQUE 约束", () => {
    const id1 = storage.createUser("dup", "pw1");
    const id2 = storage.createUser("someone-else", "pw2");
    expect(id2).toBeGreaterThan(id1);
    expect(() => storage.createUser("dup", "pw3")).toThrow(/UNIQUE/i);
  });
  it("mustChangePassword 省略时默认 0（BUG-003）", () => {
    storage.createUser("regular-admin", "hashed-pw", "admin");
    expect(storage.getUserByUsername("regular-admin")!.must_change_password).toBe(0);
  });
  it("mustChangePassword=true → 存为 1（BUG-003：引导用默认密码创建的管理员）", () => {
    storage.createUser("bootstrap-admin", "hashed-pw", "admin", true);
    expect(storage.getUserByUsername("bootstrap-admin")!.must_change_password).toBe(1);
  });
});

describe("createSession / listSessions / getSession / deleteSession（v1 database.py 同语义，Task 5）", () => {
  // sessions.owner_id carries a real FOREIGN KEY -> users(id) (schema.ts,
  // ported from v1's DDL) and the fixture's PRAGMA foreign_keys=ON enforces
  // it — an arbitrary int like owner_id=1 with no matching users row would
  // 500 on that constraint, not on session-id collision. Every test that
  // cares about owner_id uses a REAL user row's id for exactly this reason.
  function seedUser(username: string): number {
    return storage.createUser(username, "hashed-pw", "user");
  }

  it("createSession 返回 8 位十六进制 id，getSession 读回完整行（owner_id/resolved_at 含在内）", () => {
    const uid = seedUser("alice");
    const id = storage.createSession("New Chat", uid);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const row = storage.getSession(id);
    expect(row).toMatchObject({ id, title: "New Chat", owner_id: uid, resolved_at: null });
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(row!.updated_at).toBe(row!.created_at);
  });

  it("owner_id 可为 null（未登录/系统会话，对照 v1 create_session 的默认参数）", () => {
    const id = storage.createSession("New Chat", null);
    expect(storage.getSession(id)!.owner_id).toBeNull();
  });

  it("不存在的 session_id ⇒ null", () => {
    expect(storage.getSession("ghost1234")).toBeNull();
  });

  it("listSessions(ownerId) 只返回该 owner 的会话，按 updated_at DESC", () => {
    const uid1 = seedUser("alice");
    const uid2 = seedUser("bob");
    const a = storage.createSession("chat-a", uid1);
    const b = storage.createSession("chat-b", uid1);
    storage.createSession("chat-c", uid2); // different owner — must not show up
    // a/b can land in the same millisecond in a tight loop — stamp
    // updated_at explicitly so the DESC ordering assertion is deterministic
    // rather than racing the wall clock.
    const db = new Database(dbPath);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000000", a);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run("2020-01-02T00:00:00.000000", b);
    db.close();
    const rows = storage.listSessions(uid1);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows.every((r) => r.owner_id === uid1)).toBe(true);
  });

  it("listSessions(null) 返回全部会话（admin 视角），不按 owner 过滤", () => {
    const uid1 = seedUser("alice");
    const uid2 = seedUser("bob");
    const a = storage.createSession("chat-a", uid1);
    const b = storage.createSession("chat-b", uid2);
    const ids = storage.listSessions(null).map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).toContain("s1"); // fixture seed row
  });

  it("deleteSession 级联删除 messages（显式两条 DELETE），会话本身也消失", () => {
    const uid = seedUser("alice");
    const id = storage.createSession("to-delete", uid);
    storage.addMessage(id, "user", "hi");
    storage.addMessage(id, "assistant", "there");
    expect(storage.getMessages(id).length).toBe(2);
    storage.deleteSession(id);
    expect(storage.getSession(id)).toBeNull();
    expect(storage.getMessages(id).length).toBe(0);
  });

  it("连续创建多个会话 id 各不相同（8 位十六进制 id 空间下的正常路径）", () => {
    const ids = Array.from({ length: 20 }, () => storage.createSession("x", null));
    expect(new Set(ids).size).toBe(20);
  });

  it("updateSessionTitle 只改 title + updated_at（v1 database.py::update_session_title 同语义）", () => {
    const uid = seedUser("alice");
    const id = storage.createSession("New Chat", uid);
    const before = storage.getSession(id)!;
    storage.updateSessionTitle(id, "衍生出的标题");
    const after = storage.getSession(id)!;
    expect(after.title).toBe("衍生出的标题");
    expect(after.owner_id).toBe(before.owner_id);
    expect(after.created_at).toBe(before.created_at);
    expect(after.resolved_at).toBeNull();
    expect(after.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
});

describe("listRepos / listReposForUser（v1 database.py list_repos/get_user_repos 同语义，Task 5）", () => {
  function seedRepoWithPermission(db: Database.Database, userId: number, accessLevel: string): number {
    const repoId = Number(
      db
        .prepare("INSERT INTO repositories (name, url, description, branch, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("demo-repo", "https://example.com/demo.git", "desc", "main", "x").lastInsertRowid
    );
    db.prepare(
      "INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?)"
    ).run(userId, repoId, accessLevel, "x");
    return repoId;
  }

  it("空 repositories 表 ⇒ listRepos/listReposForUser 都返回 []", () => {
    expect(storage.listRepos()).toEqual([]);
    expect(storage.listReposForUser(1)).toEqual([]);
  });

  it("listRepos 返回全部仓库，access_level 恒为 null（无授权行可关联）", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const db = new Database(dbPath);
    seedRepoWithPermission(db, uid, "write");
    db.close();
    const rows = storage.listRepos();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: "demo-repo", url: "https://example.com/demo.git", access_level: null });
  });

  it("listReposForUser 只返回该用户被授权的仓库，携带真实 access_level；未授权用户拿到 []", () => {
    const uid1 = storage.createUser("alice", "hashed-pw", "user");
    const uid2 = storage.createUser("bob", "hashed-pw", "user");
    const db = new Database(dbPath);
    seedRepoWithPermission(db, uid1, "write");
    db.close();
    expect(storage.listReposForUser(uid1)).toMatchObject([{ name: "demo-repo", access_level: "write" }]);
    expect(storage.listReposForUser(uid2)).toEqual([]);
  });

  it("getUserRepos 与 listReposForUser 同语义（v1 get_user_repos 的独立命名）", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const db = new Database(dbPath);
    seedRepoWithPermission(db, uid, "admin");
    db.close();
    expect(storage.getUserRepos(uid)).toEqual(storage.listReposForUser(uid));
    expect(storage.getUserRepos(uid)).toMatchObject([{ name: "demo-repo", access_level: "admin" }]);
  });
});

describe("getUserById / listUsers / updateUserPassword / setUserActive / deleteUser（v1 database.py 同语义，Task 1）", () => {
  it("create → getById → list → updatePassword → setActive → delete 全链路", () => {
    const id = storage.createUser("alice", "hashed-pw", "user");

    const byId = storage.getUserById(id);
    expect(byId).toMatchObject({ id, username: "alice", password_hash: "hashed-pw", role: "user", is_active: 1 });

    const listed = storage.listUsers();
    expect(listed).toContainEqual({ id, username: "alice", role: "user", is_active: 1, created_at: byId!.created_at });
    // password_hash 必须被排除在 SELECT 之外，而不是取回后再删
    expect(listed.every((u) => !("password_hash" in u))).toBe(true);

    storage.updateUserPassword(id, "new-hash");
    expect(storage.getUserById(id)!.password_hash).toBe("new-hash");

    storage.setUserActive(id, false);
    expect(storage.getUserById(id)!.is_active).toBe(0);
    storage.setUserActive(id, true);
    expect(storage.getUserById(id)!.is_active).toBe(1);

    storage.deleteUser(id);
    expect(storage.getUserById(id)).toBeNull();
  });

  it("updateUserPassword 同时清除 must_change_password（BUG-003：改密码即视为已处理强制改密）", () => {
    const id = storage.createUser("bootstrap-admin", "hashed-pw", "admin", true);
    expect(storage.getUserById(id)!.must_change_password).toBe(1);
    storage.updateUserPassword(id, "new-hash");
    const row = storage.getUserById(id)!;
    expect(row.password_hash).toBe("new-hash");
    expect(row.must_change_password).toBe(0);
  });

  it("getUserById 查无此人 ⇒ null", () => {
    expect(storage.getUserById(999)).toBeNull();
  });

  it("listUsers 按 id 排序，空表返回 []", () => {
    expect(storage.listUsers()).toEqual([]);
    const id1 = storage.createUser("zed", "pw");
    const id2 = storage.createUser("amy", "pw");
    expect(storage.listUsers().map((u) => u.id)).toEqual([id1, id2]);
  });

  it("deleteUser 级联清掉该用户的 permissions（FK CASCADE），不影响 sessions 之外的数据完整性", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    storage.grantPermission(uid, repoId, "read");
    expect(storage.listPermissions().length).toBe(1);
    storage.deleteUser(uid);
    expect(storage.listPermissions().length).toBe(0);
  });
});

describe("getRepo / createRepo / updateRepo / deleteRepo（v1 database.py 同语义，Task 1）", () => {
  it("create → get → update(动态字段) → delete 级联清 permissions", () => {
    const repoId = storage.createRepo({
      name: "demo",
      url: "https://example.com/demo.git",
      description: "desc",
      branch: "main",
      credUsername: "bot",
      credToken: "secret",
    });
    expect(typeof repoId).toBe("number");

    const got = storage.getRepo(repoId);
    expect(got).toMatchObject({ id: repoId, name: "demo", url: "https://example.com/demo.git", description: "desc", branch: "main", access_level: null });

    // 只传部分字段：未传字段必须原样保留（动态 SET builder 语义）
    storage.updateRepo(repoId, { name: "demo-renamed" });
    expect(storage.getRepo(repoId)).toMatchObject({ name: "demo-renamed", url: "https://example.com/demo.git", branch: "main" });

    // sync 相关字段（last_sync_* / index_status / local_path）不在 RepoRow 的公开列里，直接查库验证落库
    storage.updateRepo(repoId, {
      localPath: "/data/repos/demo",
      lastSyncAt: "2020-01-01T00:00:00.000000",
      lastSyncStatus: "ok",
      lastSyncMessage: "synced",
      indexStatus: "indexed",
      lastSyncSha: "abc123",
    });
    const db = new Database(dbPath);
    const raw = db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId) as any;
    db.close();
    expect(raw).toMatchObject({
      local_path: "/data/repos/demo",
      last_sync_at: "2020-01-01T00:00:00.000000",
      last_sync_status: "ok",
      last_sync_message: "synced",
      index_status: "indexed",
      last_sync_sha: "abc123",
    });

    // branch/credUsername/credToken 传空字符串 ⇒ 落库为 NULL（对照 v1 的 `x or None`）
    storage.updateRepo(repoId, { branch: "", credUsername: "", credToken: "" });
    const db2 = new Database(dbPath);
    const raw2 = db2.prepare("SELECT branch, cred_username, cred_token FROM repositories WHERE id = ?").get(repoId) as any;
    db2.close();
    expect(raw2).toEqual({ branch: null, cred_username: null, cred_token: null });

    storage.deleteRepo(repoId);
    expect(storage.getRepo(repoId)).toBeNull();
  });

  it("createRepo 省略可选字段：description 默认为空串，branch/cred 默认为 null", () => {
    const repoId = storage.createRepo({ name: "bare", url: "https://example.com/bare.git" });
    const db = new Database(dbPath);
    const raw = db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId) as any;
    db.close();
    expect(raw).toMatchObject({ description: "", branch: null, cred_username: null, cred_token: null, local_path: null });
  });

  it("updateRepo 不传任何字段 ⇒ no-op（不炸，也不改动任何列）", () => {
    const repoId = storage.createRepo({ name: "untouched", url: "https://example.com/u.git" });
    const before = storage.getRepo(repoId);
    storage.updateRepo(repoId, {});
    expect(storage.getRepo(repoId)).toEqual(before);
  });

  it("getRepo 查无此仓库 ⇒ null", () => {
    expect(storage.getRepo(999)).toBeNull();
  });

  it("getRepoAdmin 返回完整行（含 cred_username/cred_token/local_path/last_sync_*/index_status），plain getRepo 不带这些字段", () => {
    const repoId = storage.createRepo({
      name: "demo",
      url: "https://example.com/demo.git",
      description: "desc",
      branch: "main",
      credUsername: "bot",
      credToken: "secret-token",
    });
    storage.updateRepo(repoId, {
      localPath: "/data/repos/demo",
      lastSyncAt: "2020-01-01T00:00:00.000000",
      lastSyncStatus: "ok",
      lastSyncMessage: "synced",
      indexStatus: "indexed",
      lastSyncSha: "abc123",
    });

    const full = storage.getRepoAdmin(repoId);
    expect(full).toMatchObject({
      id: repoId,
      name: "demo",
      url: "https://example.com/demo.git",
      description: "desc",
      branch: "main",
      access_level: null,
      cred_username: "bot",
      cred_token: "secret-token",
      local_path: "/data/repos/demo",
      last_sync_at: "2020-01-01T00:00:00.000000",
      last_sync_status: "ok",
      last_sync_message: "synced",
      index_status: "indexed",
      last_sync_sha: "abc123",
    });
    expect(full!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);

    // plain getRepo stays narrow — proves this is an addition, not a silent widening
    const narrow = storage.getRepo(repoId) as Record<string, unknown>;
    expect("cred_username" in narrow).toBe(false);
    expect("cred_token" in narrow).toBe(false);
    expect("local_path" in narrow).toBe(false);
    expect("last_sync_at" in narrow).toBe(false);
  });

  it("getRepoAdmin 查无此仓库 ⇒ null", () => {
    expect(storage.getRepoAdmin(999)).toBeNull();
  });

  it("deleteRepo 级联删除 permissions（显式两条 DELETE，先 permissions 后 repositories）", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo", url: "https://example.com/demo.git" });
    storage.grantPermission(uid, repoId, "read");
    expect(storage.listPermissions().length).toBe(1);
    storage.deleteRepo(repoId);
    expect(storage.getRepo(repoId)).toBeNull();
    expect(storage.listPermissions().length).toBe(0);
  });
});

describe("grantPermission / listPermissions / revokePermission（v1 database.py 同语义，Task 1）", () => {
  it("grant → list(JOIN 出 username/repo_name) → revoke", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });

    const permId = storage.grantPermission(uid, repoId, "read");
    expect(typeof permId).toBe("number");

    const perms = storage.listPermissions();
    expect(perms).toMatchObject([
      { user_id: uid, username: "alice", repo_id: repoId, repo_name: "demo-repo", access_level: "read" },
    ]);
    expect(perms[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);

    storage.revokePermission(uid, repoId);
    expect(storage.listPermissions()).toEqual([]);
  });

  it("grantPermission 对已存在的 (user, repo) 是 UPSERT：更新 access_level 而不是报 UNIQUE 冲突", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    storage.grantPermission(uid, repoId, "read");
    storage.grantPermission(uid, repoId, "admin");
    const perms = storage.listPermissions();
    expect(perms.length).toBe(1);
    expect(perms[0].access_level).toBe("admin");
  });

  it("revokePermission 对不存在的授权是 no-op（不炸）", () => {
    expect(() => storage.revokePermission(999, 999)).not.toThrow();
  });

  it("listPermissions 按 username, repo_name 排序，空表返回 []", () => {
    expect(storage.listPermissions()).toEqual([]);
    const uidZ = storage.createUser("zed", "pw");
    const uidA = storage.createUser("amy", "pw");
    const repoId = storage.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    storage.grantPermission(uidZ, repoId, "read");
    storage.grantPermission(uidA, repoId, "read");
    expect(storage.listPermissions().map((p) => p.username)).toEqual(["amy", "zed"]);
  });

  it("FK 约束真实生效：对不存在的 user_id/repo_id 授权直接炸 FOREIGN KEY（DB 层不做业务层 404，交给调用方）", () => {
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    expect(() => storage.grantPermission(999, repoId, "read")).toThrow(/FOREIGN KEY/i);

    const uid = storage.createUser("alice", "hashed-pw", "user");
    expect(() => storage.grantPermission(uid, 999, "read")).toThrow(/FOREIGN KEY/i);
  });
});

describe("markSessionResolved（v1 database.py:590 同语义）", () => {
  it("将 resolved_at 从 null 置为新鲜时间戳，不改动其余字段", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const id = storage.createSession("chat", uid);
    const before = storage.getSession(id)!;
    expect(before.resolved_at).toBeNull();

    storage.markSessionResolved(id);
    const after = storage.getSession(id)!;
    expect(after.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(after.title).toBe(before.title);
    expect(after.owner_id).toBe(before.owner_id);
    expect(after.created_at).toBe(before.created_at);
  });
});

describe("recordIssueSubmission / getIssueSubmissionsForSession（v1 database.py:661/688 同语义）", () => {
  it("round trip：labels 解析为真实数组，track_status/reopen_count 落到 schema 默认值", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    const subId = storage.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: uid,
      title: "登录按钮无响应",
      body: "点击登录无反应",
      labels: ["bug", "P1"],
      issueNumber: 42,
      issueUrl: "https://github.com/x/y/issues/42",
      draftToolUseId: "tu_1",
    });
    expect(typeof subId).toBe("number");

    const rows = storage.getIssueSubmissionsForSession("s1");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id: subId,
      repo_id: repoId,
      user_id: uid,
      title: "登录按钮无响应",
      body: "点击登录无反应",
      labels: ["bug", "P1"],
      issue_number: 42,
      issue_url: "https://github.com/x/y/issues/42",
      draft_tool_use_id: "tu_1",
      track_status: "submitted",
      reopen_count: 0,
    });
    expect(rows[0].submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("draftToolUseId 省略时落库为 null；只返回目标 session 的提报", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    storage.createSession("other", uid); // 混淆用的另一个 session，不应污染 s1 的结果
    storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 1, issueUrl: "https://x/1",
    });
    const rows = storage.getIssueSubmissionsForSession("s1");
    expect(rows.length).toBe(1);
    expect(rows[0].draft_tool_use_id).toBeNull();
  });

  it("issueUrl 为 null 时原样落库（TrackerResult 的 comment-only 失败态）", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 1, issueUrl: null,
    });
    expect(storage.getIssueSubmissionsForSession("s1")[0].issue_url).toBeNull();
  });

  it("查无提报的 session ⇒ []", () => {
    expect(storage.getIssueSubmissionsForSession("ghost")).toEqual([]);
  });
});

describe("getSubmissionByDraftToolUseId / recordIssueSubmission 幂等化（2026-07-13，防止重试重复建 issue）", () => {
  it("命中：按 draft_tool_use_id 查到之前提交的那一行", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    const subId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 1, issueUrl: "https://x/1",
      draftToolUseId: "tu_abc",
    });
    const row = storage.getSubmissionByDraftToolUseId("tu_abc");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(subId);
    expect(row!.issue_number).toBe(1);
  });

  it("未命中 ⇒ null", () => {
    expect(storage.getSubmissionByDraftToolUseId("tu_never_existed")).toBeNull();
  });

  it("重复调用 recordIssueSubmission 传同一个 draft_tool_use_id ⇒ 返回第一行的 id，不抛错，不产生第二行", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    const firstId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t1", body: "b1", labels: [], issueNumber: 1, issueUrl: "https://x/1",
      draftToolUseId: "tu_retry",
    });
    const secondId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t2", body: "b2", labels: [], issueNumber: 999, issueUrl: "https://x/999",
      draftToolUseId: "tu_retry",
    });
    expect(secondId).toBe(firstId);
    expect(storage.getIssueSubmissionsForSession("s1")).toHaveLength(1);
    // The FIRST row's data survives untouched — the retry never overwrote it.
    expect(storage.getIssueSubmissionsForSession("s1")[0].issue_number).toBe(1);
  });

  it("draft_tool_use_id 为 null 的多行不会互相冲突（局部索引只约束非 null 值）", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    expect(() => {
      storage.recordIssueSubmission({
        sessionId: "s1", repoId, userId: uid,
        title: "t1", body: "b1", labels: [], issueNumber: 1, issueUrl: "https://x/1",
      });
      storage.recordIssueSubmission({
        sessionId: "s1", repoId, userId: uid,
        title: "t2", body: "b2", labels: [], issueNumber: 2, issueUrl: "https://x/2",
      });
    }).not.toThrow();
    expect(storage.getIssueSubmissionsForSession("s1")).toHaveLength(2);
  });
});

describe("getSubmissionForTracking / getSubmissionByIssue（2026-07-13，操作后单条 recheck 用的查询）", () => {
  it("getSubmissionForTracking：按 id 查到已有 issue_number/issue_url 的行", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    const subId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 5, issueUrl: "https://x/5",
    });
    const row = storage.getSubmissionForTracking(subId);
    expect(row).not.toBeNull();
    expect(row!.issue_number).toBe(5);
  });

  it("getSubmissionForTracking：id 不存在 ⇒ null，不像 getTrackableSubmissions 那样受“是否到期”限制", () => {
    expect(storage.getSubmissionForTracking(999999)).toBeNull();
  });

  it("getSubmissionByIssue：按 repo_id + issue_number 查到，多行时取最新的一行", () => {
    const uid = storage.createUser("alice", "hashed-pw", "user");
    const repoId = storage.createRepo({ name: "demo-repo", url: "https://example.com/demo.git" });
    storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "old", body: "b", labels: [], issueNumber: 7, issueUrl: "https://x/7",
    });
    const newerId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "new", body: "b", labels: [], issueNumber: 7, issueUrl: "https://x/7",
    });
    const row = storage.getSubmissionByIssue(repoId, 7);
    expect(row!.id).toBe(newerId);
  });

  it("getSubmissionByIssue：没有匹配的 repo_id/issue_number 组合 ⇒ null", () => {
    expect(storage.getSubmissionByIssue(999999, 1)).toBeNull();
  });
});

describe("getTrackableSubmissions（v1 database.py:710 同语义：open/未知恒轮询，closed 每天至多查一次）", () => {
  function seedSubmission(issueNumber: number, issueUrl: string | null = `https://x/${issueNumber}`): number {
    const uid = storage.createUser(`u${issueNumber}`, "pw");
    const repoId = storage.createRepo({ name: `r${issueNumber}`, url: `https://example.com/r${issueNumber}.git` });
    return storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber, issueUrl,
    });
  }

  it("issue_number/issue_url 有一个是 null ⇒ 不可追踪，不出现在结果里", () => {
    seedSubmission(1, null);
    expect(storage.getTrackableSubmissions()).toEqual([]);
  });

  it("从未 track 过（remote_state 为 null）⇒ 恒被包含", () => {
    const id = seedSubmission(2);
    expect(storage.getTrackableSubmissions().map((r) => r.id)).toContain(id);
  });

  it("remote_state 显式为非 'closed' 值（如 'open'）⇒ 恒被包含，不看 last_checked_at", () => {
    const id = seedSubmission(3);
    storage.updateIssueTracking(id, { remoteState: "open" }); // last_checked_at 被戳为刚刚
    expect(storage.getTrackableSubmissions().map((r) => r.id)).toContain(id);
  });

  it("closed 且 last_checked_at 在 1 天以内 ⇒ 被排除", () => {
    const id = seedSubmission(4);
    storage.updateIssueTracking(id, { remoteState: "closed" }); // last_checked_at 刚刚 = 现在
    expect(storage.getTrackableSubmissions().map((r) => r.id)).not.toContain(id);
  });

  it("closed 但 last_checked_at 超过 1 天 ⇒ 被重新纳入（防止错过 reopen）", () => {
    const id = seedSubmission(5);
    storage.updateIssueTracking(id, { remoteState: "closed" });
    const db = new Database(dbPath);
    db.prepare("UPDATE issue_submissions SET last_checked_at = ? WHERE id = ?").run(
      "2000-01-01T00:00:00.000000",
      id
    );
    db.close();
    expect(storage.getTrackableSubmissions().map((r) => r.id)).toContain(id);
  });
});

describe("updateIssueTracking（status_changed_at 的 CASE 防竞态写法，v1 database.py:732 同语义）", () => {
  function seedSubmission(): number {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    return storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 1, issueUrl: "https://x/1",
    });
  }
  function readStatusChangedAt(id: number): string | null {
    const db = new Database(dbPath);
    const row = db.prepare("SELECT status_changed_at FROM issue_submissions WHERE id = ?").get(id) as {
      status_changed_at: string | null;
    };
    db.close();
    return row.status_changed_at;
  }

  it("传入与当前一致的 trackStatus（列默认值 'submitted'）⇒ status_changed_at 保持不变（null 到 null，逐字节相同）", () => {
    const id = seedSubmission();
    expect(readStatusChangedAt(id)).toBeNull();
    storage.updateIssueTracking(id, { trackStatus: "submitted" });
    expect(readStatusChangedAt(id)).toBeNull();
  });

  it("传入真正不同的 trackStatus ⇒ status_changed_at 被戳为新鲜时间戳；之后再传相同值就不再变化", () => {
    const id = seedSubmission();
    storage.updateIssueTracking(id, { trackStatus: "in_progress" });
    const stamped = readStatusChangedAt(id);
    expect(stamped).not.toBeNull();
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);

    // 再次传入与"当前已存储值"一致的 trackStatus（此时是 'in_progress'）⇒ 不再变化
    storage.updateIssueTracking(id, { trackStatus: "in_progress" });
    expect(readStatusChangedAt(id)).toBe(stamped);
  });

  it("last_checked_at 每次调用都被戳新（哪怕不传 trackStatus，标记的是轮询尝试本身）", () => {
    const id = seedSubmission();
    storage.updateIssueTracking(id, {});
    const db = new Database(dbPath);
    const row = db.prepare("SELECT last_checked_at FROM issue_submissions WHERE id = ?").get(id) as {
      last_checked_at: string;
    };
    db.close();
    expect(row.last_checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("clearError 优先于 trackError（同时传入时按 v1 的 if/elif 语义，清空而不是写入新错误文本）", () => {
    const id = seedSubmission();
    storage.updateIssueTracking(id, { trackError: "boom" });
    const db1 = new Database(dbPath);
    expect((db1.prepare("SELECT track_error FROM issue_submissions WHERE id = ?").get(id) as any).track_error).toBe(
      "boom"
    );
    db1.close();

    storage.updateIssueTracking(id, { trackError: "should be ignored", clearError: true });
    const db2 = new Database(dbPath);
    expect(
      (db2.prepare("SELECT track_error FROM issue_submissions WHERE id = ?").get(id) as any).track_error
    ).toBeNull();
    db2.close();
  });

  it("动态 SET：只传 remoteState/reopenCount/closedAt 时，track_status 等未传字段不受影响", () => {
    const id = seedSubmission();
    storage.updateIssueTracking(id, {
      remoteState: "closed",
      reopenCount: 2,
      closedAt: "2020-01-01T00:00:00.000000",
    });
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT remote_state, reopen_count, closed_at, track_status FROM issue_submissions WHERE id = ?")
      .get(id) as any;
    db.close();
    expect(row).toMatchObject({
      remote_state: "closed",
      reopen_count: 2,
      closed_at: "2020-01-01T00:00:00.000000",
      track_status: "submitted",
    });
  });
});

describe("upsertFixReport / getUnverifiedFixReports / setFixReportVerified（v1 database.py:765/788 同语义：幂等 upsert + verified 保留）", () => {
  function seedSubmission(): { subId: number; repoId: number } {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    const subId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 1, issueUrl: "https://x/1",
    });
    return { subId, repoId };
  }
  function rawFixReports(submissionId: number): any[] {
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT * FROM issue_fix_reports WHERE submission_id = ? ORDER BY note_id").all(
      submissionId
    );
    db.close();
    return rows;
  }

  it("round trip：写入后能在 getUnverifiedFixReports 里查到，含 JOIN 出的 issue_url/repo_id", () => {
    const { subId, repoId } = seedSubmission();
    storage.upsertFixReport({
      submissionId: subId, noteId: 100, workerId: "w1", commitSha: "sha1",
      files: ["a.ts", "b.ts"], reportedAt: "2020-01-01T00:00:00.000000",
    });
    const unverified = storage.getUnverifiedFixReports();
    expect(unverified.length).toBe(1);
    expect(unverified[0]).toMatchObject({ submission_id: subId, commit_sha: "sha1", issue_url: "https://x/1", repo_id: repoId });
  });

  it("commit_sha 为 null 的报告不出现在 getUnverifiedFixReports（v1: verified IS NULL AND commit_sha IS NOT NULL 两个条件都要满足）", () => {
    const { subId } = seedSubmission();
    storage.upsertFixReport({ submissionId: subId, noteId: 1, workerId: null, commitSha: null, files: [], reportedAt: null });
    expect(storage.getUnverifiedFixReports()).toEqual([]);
  });

  it("幂等：同一 (submissionId, noteId) 二次 upsert 不新增行，且不覆盖已被 setFixReportVerified 设置的 verified", () => {
    const { subId } = seedSubmission();
    const reportId = storage.upsertFixReport({
      submissionId: subId, noteId: 1, workerId: "w1", commitSha: "sha1",
      files: ["a.ts"], reportedAt: "2020-01-01T00:00:00.000000",
    });
    expect(rawFixReports(subId).length).toBe(1);

    storage.setFixReportVerified(reportId, true);
    expect(storage.getUnverifiedFixReports()).toEqual([]); // 已核实，从"待核实"里消失

    // 二次 upsert：全新的 worker_id/commit_sha/files/reported_at，但 verified 必须原封不动保留
    storage.upsertFixReport({
      submissionId: subId, noteId: 1, workerId: "w2", commitSha: "sha2",
      files: ["c.ts"], reportedAt: "2020-02-02T00:00:00.000000",
    });
    const rows = rawFixReports(subId);
    expect(rows.length).toBe(1); // 仍只有一行，不是新增
    expect(rows[0]).toMatchObject({
      id: reportId,
      worker_id: "w2",
      commit_sha: "sha2",
      files_json: '["c.ts"]',
      reported_at: "2020-02-02T00:00:00.000000",
      verified: 1, // 被 setFixReportVerified 设置后，未被后续 upsert 覆盖
    });
    expect(storage.getUnverifiedFixReports()).toEqual([]); // 依然不在待核实列表里
  });

  it("不同 noteId（同一 submissionId）⇒ 新增一行，而不是更新既有行", () => {
    const { subId } = seedSubmission();
    storage.upsertFixReport({ submissionId: subId, noteId: 1, workerId: "w1", commitSha: "sha1", files: [], reportedAt: null });
    storage.upsertFixReport({ submissionId: subId, noteId: 2, workerId: "w2", commitSha: "sha2", files: [], reportedAt: null });
    const rows = rawFixReports(subId);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.note_id)).toEqual([1, 2]);
  });

  it("setFixReportVerified(false) 落库为 0（不是 null）；0 是「已查证不在分支上」的结论，不再出现在 getUnverifiedFixReports 里", () => {
    const { subId } = seedSubmission();
    const reportId = storage.upsertFixReport({ submissionId: subId, noteId: 1, workerId: "w1", commitSha: "sha1", files: [], reportedAt: null });
    storage.setFixReportVerified(reportId, false);
    expect(rawFixReports(subId)[0].verified).toBe(0);
    expect(storage.getUnverifiedFixReports()).toEqual([]);
  });
});

describe("getMyIssueSubmissions / getMyUnreadIssueCount / markMyIssuesSeen（fresh 的 null/非 null 边界，v1 database.py:835/868 同语义）", () => {
  function seedTrackedSubmission(userId: number, repoId: number, issueNumber: number): number {
    const subId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId,
      title: `issue-${issueNumber}`, body: "b", labels: [], issueNumber, issueUrl: `https://x/${issueNumber}`,
    });
    // 触发一次真实的状态迁移，让 status_changed_at 落到非 null
    storage.updateIssueTracking(subId, { trackStatus: "in_progress" });
    return subId;
  }

  it("status_changed_at 非空 + my_issues_seen_at 从未设置（null）⇒ fresh=true，计入未读数", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedTrackedSubmission(uid, repoId, 1);

    expect(storage.getMyUnreadIssueCount(uid)).toBe(1);
    const rows = storage.getMyIssueSubmissions(uid);
    expect(rows.length).toBe(1);
    expect(rows[0].fresh).toBe(true);
  });

  it("status_changed_at 非空 + my_issues_seen_at 晚于它 ⇒ fresh=false，不计入未读数", () => {
    const uid = storage.createUser("bob", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedTrackedSubmission(uid, repoId, 2);

    // 用一个保证"晚于任何 status_changed_at"的哨兵时间戳，避免和 wall clock 赛跑
    const db = new Database(dbPath);
    db.prepare("UPDATE users SET my_issues_seen_at = ? WHERE id = ?").run("9999-01-01T00:00:00.000000", uid);
    db.close();

    expect(storage.getMyUnreadIssueCount(uid)).toBe(0);
    const rows = storage.getMyIssueSubmissions(uid);
    expect(rows.length).toBe(1);
    expect(rows[0].fresh).toBe(false);
  });

  it("status_changed_at 仍为 null（从未真正变更过状态）⇒ 无论 my_issues_seen_at 是否设置都不计入", () => {
    const uid1 = storage.createUser("carol", "hashed-pw");
    const uid2 = storage.createUser("dave", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });

    // 注意：不调用 updateIssueTracking，status_changed_at 保持 null
    storage.recordIssueSubmission({ sessionId: "s1", repoId, userId: uid1, title: "t1", body: "b", labels: [], issueNumber: 3, issueUrl: "https://x/3" });
    storage.recordIssueSubmission({ sessionId: "s1", repoId, userId: uid2, title: "t2", body: "b", labels: [], issueNumber: 4, issueUrl: "https://x/4" });
    storage.markMyIssuesSeen(uid2); // uid2 显式标记过已读；uid1 从未标记（null）

    expect(storage.getMyUnreadIssueCount(uid1)).toBe(0);
    expect(storage.getMyIssueSubmissions(uid1)[0].fresh).toBe(false);
    expect(storage.getMyUnreadIssueCount(uid2)).toBe(0);
    expect(storage.getMyIssueSubmissions(uid2)[0].fresh).toBe(false);
  });

  it("markMyIssuesSeen 之后，原本 fresh 的提报翻转为非 fresh", () => {
    const uid = storage.createUser("erin", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedTrackedSubmission(uid, repoId, 5);
    expect(storage.getMyUnreadIssueCount(uid)).toBe(1);

    storage.markMyIssuesSeen(uid);
    expect(storage.getMyUnreadIssueCount(uid)).toBe(0);
    expect(storage.getMyIssueSubmissions(uid)[0].fresh).toBe(false);
  });

  it("getMyIssueSubmissions 携带 repo_name（LEFT JOIN）；fix_verified/fix_files_count/fix_commit 汇总自 issue_fix_reports", () => {
    const uid = storage.createUser("frank", "hashed-pw");
    const repoId = storage.createRepo({ name: "cool-repo", url: "https://example.com/cool.git" });
    const subId = storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid, title: "t", body: "b", labels: [], issueNumber: 6, issueUrl: "https://x/6",
    });

    let row = storage.getMyIssueSubmissions(uid)[0];
    expect(row.repo_name).toBe("cool-repo");
    expect(row.fix_verified).toBe(false);
    expect(row.fix_files_count).toBeNull();
    expect(row.fix_commit).toBeNull();

    const reportId = storage.upsertFixReport({
      submissionId: subId, noteId: 1, workerId: "w1", commitSha: "abcdef1234567890",
      files: ["a.ts", "b.ts"], reportedAt: "2020-01-01T00:00:00.000000",
    });
    storage.setFixReportVerified(reportId, true);

    row = storage.getMyIssueSubmissions(uid)[0];
    expect(row.fix_verified).toBe(true);
    expect(row.fix_files_count).toBe(2);
    expect(row.fix_commit).toBe("abcdef1234"); // commit_sha 截断到前 10 位
  });

  it("其他用户的提报不计入 getMyIssueSubmissions/getMyUnreadIssueCount", () => {
    const uid1 = storage.createUser("gina", "hashed-pw");
    const uid2 = storage.createUser("henry", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedTrackedSubmission(uid1, repoId, 7);
    expect(storage.getMyIssueSubmissions(uid2)).toEqual([]);
    expect(storage.getMyUnreadIssueCount(uid2)).toBe(0);
  });
});

describe("getIssueTrackingOverview（counts 按 COALESCE(track_status,'submitted') 分组 + labels/remote_labels 真实数组，v1 database.py:892 同语义）", () => {
  function seedSubmission(userId: number, repoId: number, issueNumber: number, labels: string[] = []): number {
    return storage.recordIssueSubmission({
      sessionId: "s1", repoId, userId, title: `t${issueNumber}`, body: "b", labels, issueNumber, issueUrl: `https://x/${issueNumber}`,
    });
  }

  it("counts 按 track_status 分组统计（未变更的默认 'submitted' 与显式变更的状态分别计数）", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedSubmission(uid, repoId, 1); // 保持默认 'submitted'
    seedSubmission(uid, repoId, 2); // 保持默认 'submitted'
    const id3 = seedSubmission(uid, repoId, 3);
    storage.updateIssueTracking(id3, { trackStatus: "closed" });

    const overview = storage.getIssueTrackingOverview();
    expect(overview.counts).toEqual({ submitted: 2, closed: 1 });
  });

  it("labels/remote_labels 解析为真实数组；remote_labels 为 NULL 时是 []而不是抛错", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    const id = seedSubmission(uid, repoId, 1, ["bug", "urgent"]);

    let overview = storage.getIssueTrackingOverview();
    let row = overview.submissions.find((r) => r.id === id)!;
    expect(row.labels).toEqual(["bug", "urgent"]);
    expect(row.remote_labels).toEqual([]); // 从未 track 过 ⇒ 该列是 NULL ⇒ 解析为 []

    storage.updateIssueTracking(id, { remoteLabels: JSON.stringify(["needs-info"]) });
    overview = storage.getIssueTrackingOverview();
    row = overview.submissions.find((r) => r.id === id)!;
    expect(row.remote_labels).toEqual(["needs-info"]);
  });

  it("fix_reports 附加在每个 submission 上（来自 issue_fix_reports 的 JOIN 结果）", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    const id = seedSubmission(uid, repoId, 1);
    storage.upsertFixReport({ submissionId: id, noteId: 1, workerId: "w1", commitSha: "sha1", files: ["a.ts"], reportedAt: null });

    const overview = storage.getIssueTrackingOverview();
    const row = overview.submissions.find((r) => r.id === id)!;
    expect(row.fix_reports.length).toBe(1);
    expect(row.fix_reports[0]).toMatchObject({ submission_id: id, note_id: 1, worker_id: "w1", commit_sha: "sha1", files: ["a.ts"] });
  });

  it("limit 参数生效，且按 id DESC 排序", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    const id1 = seedSubmission(uid, repoId, 1);
    const id2 = seedSubmission(uid, repoId, 2);
    const id3 = seedSubmission(uid, repoId, 3);

    const overview = storage.getIssueTrackingOverview(2);
    expect(overview.submissions.map((r) => r.id)).toEqual([id3, id2]);
    expect(overview.submissions.map((r) => r.id)).not.toContain(id1);
  });
});

describe("recordIssueAction / getIssueActionsForSession（v1 database.py:935/955 同语义）", () => {
  it("round trip：issueUrl/draftToolUseId 可选，省略时落库为 null", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    const actionId = storage.recordIssueAction({
      sessionId: "s1", repoId, userId: uid, issueNumber: 10, action: "close", comment: "已解决",
    });
    expect(typeof actionId).toBe("number");

    const rows = storage.getIssueActionsForSession("s1");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      id: actionId, repo_id: repoId, user_id: uid, issue_number: 10,
      action: "close", comment: "已解决", issue_url: null, draft_tool_use_id: null,
    });
    expect(rows[0].applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("issueUrl/draftToolUseId 显式传入时原样落库；按 id 升序返回", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    storage.recordIssueAction({ sessionId: "s1", repoId, userId: uid, issueNumber: 1, action: "comment", comment: "c1", issueUrl: "https://x/1", draftToolUseId: "tu_1" });
    storage.recordIssueAction({ sessionId: "s1", repoId, userId: uid, issueNumber: 1, action: "reopen", comment: "c2" });

    const rows = storage.getIssueActionsForSession("s1");
    expect(rows.map((r) => r.action)).toEqual(["comment", "reopen"]);
    expect(rows[0].issue_url).toBe("https://x/1");
    expect(rows[0].draft_tool_use_id).toBe("tu_1");
  });

  it("查无 action 的 session ⇒ []", () => {
    expect(storage.getIssueActionsForSession("ghost")).toEqual([]);
  });
});

describe("getUsageSummary / getUsageByUser（v1 database.py:992/1011 同语义：按 user_id 分组，非按 users 主键 JOIN 键分组）", () => {
  it("空表 ⇒ getUsageSummary 全部字段为 0（每个聚合都被 COALESCE 兜底）", () => {
    expect(storage.getUsageSummary()).toEqual({
      call_count: 0, total_input_tokens: 0, total_output_tokens: 0,
      avg_ttft_ms: 0, max_ttft_ms: 0, avg_total_ms: 0, max_total_ms: 0,
    });
  });

  it("getUsageSummary 汇总 sum/avg/max", () => {
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: 1, model: "m", iteration: 1, input_tokens: 10, output_tokens: 5, ttft_ms: 100, total_ms: 200 },
      { session_id: "s1", user_id: 1, model: "m", iteration: 2, input_tokens: 30, output_tokens: 15, ttft_ms: 300, total_ms: 400 },
    ]);
    expect(storage.getUsageSummary()).toEqual({
      call_count: 2, total_input_tokens: 40, total_output_tokens: 20,
      avg_ttft_ms: 200, max_ttft_ms: 300, avg_total_ms: 300, max_total_ms: 400,
    });
  });

  it("getUsageByUser 按 user_id 分组（不是按 users 表主键 JOIN 键）；用户被删除后指标仍在，展示占位用户名", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: uid, model: "m", iteration: 1, input_tokens: 10, output_tokens: 5, ttft_ms: 100, total_ms: 200 },
      { session_id: "s1", user_id: uid, model: "m", iteration: 2, input_tokens: 20, output_tokens: 5, ttft_ms: 100, total_ms: 200 },
    ]);

    // 删除前：真实用户名
    let rows = storage.getUsageByUser();
    expect(rows).toMatchObject([
      { user_id: uid, username: "alice", call_count: 2, total_input_tokens: 30, total_output_tokens: 10 },
    ]);

    // llm_call_metrics.user_id 在 schema.ts 里没有 FK 约束（只有 session_id 有）——
    // 删除用户不会级联清掉这些行，这正是 LEFT JOIN + GROUP BY m.user_id 要覆盖的场景：
    // 用真实的 storage.deleteUser 验证行为，而不是假设它会级联。
    storage.deleteUser(uid);
    rows = storage.getUsageByUser();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ user_id: uid, username: `(已删除用户 #${uid})`, call_count: 2 });
  });

  it("多用户按 (input+output) 总量降序排列", () => {
    const uidBig = storage.createUser("big", "hashed-pw");
    const uidSmall = storage.createUser("small", "hashed-pw");
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: uidSmall, model: "m", iteration: 1, input_tokens: 1, output_tokens: 1, ttft_ms: 1, total_ms: 1 },
      { session_id: "s1", user_id: uidBig, model: "m", iteration: 1, input_tokens: 100, output_tokens: 100, ttft_ms: 1, total_ms: 1 },
    ]);
    expect(storage.getUsageByUser().map((r) => r.user_id)).toEqual([uidBig, uidSmall]);
  });

  it("user_id 为 null（未登录调用）也能被分组统计；username 落到 SQL 的 NULL 拼接结果——COALESCE(NULL, '...' || NULL || '...') 本身也是 NULL，不是占位字符串（已用 better-sqlite3 直接验证过，v1 同一段 SQL 有一致行为，非本层引入的差异）", () => {
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: null, model: "m", iteration: 1, input_tokens: 5, output_tokens: 5, ttft_ms: 1, total_ms: 1 },
    ]);
    const rows = storage.getUsageByUser();
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].username).toBeNull();
  });
});

describe("getMessageSessionId / setMessageFeedback / getFeedbackForSession / getFeedbackSummary / getRecentNegativeFeedback（v1 database.py:1040-1103 同语义）", () => {
  it("getMessageSessionId：命中返回 session_id，未命中返回 null", () => {
    const msgId = storage.addMessage("s1", "assistant", "回答内容");
    expect(storage.getMessageSessionId(msgId)).toBe("s1");
    expect(storage.getMessageSessionId(999999)).toBeNull();
  });

  it("setMessageFeedback：round trip 写入 +1/-1，getFeedbackForSession 按 (session,user) 还原为 map", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "答案1");
    const msg2 = storage.addMessage("s1", "assistant", "答案2");
    storage.setMessageFeedback(msg1, "s1", uid, 1);
    storage.setMessageFeedback(msg2, "s1", uid, -1);

    expect(storage.getFeedbackForSession("s1", uid)).toEqual({ [msg1]: 1, [msg2]: -1 });
  });

  it("setMessageFeedback 对同一 (message,user) 是 UPSERT：二次评分覆盖而不是新增一行", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "答案1");
    storage.setMessageFeedback(msg1, "s1", uid, 1);
    storage.setMessageFeedback(msg1, "s1", uid, -1);
    expect(storage.getFeedbackForSession("s1", uid)).toEqual({ [msg1]: -1 });

    const db = new Database(dbPath);
    const count = (db.prepare("SELECT COUNT(*) as n FROM message_feedback WHERE message_id = ?").get(msg1) as any).n;
    db.close();
    expect(count).toBe(1);
  });

  it("不同用户对同一条消息的评分互不影响", () => {
    const uid1 = storage.createUser("alice", "hashed-pw");
    const uid2 = storage.createUser("bob", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "答案1");
    storage.setMessageFeedback(msg1, "s1", uid1, 1);
    storage.setMessageFeedback(msg1, "s1", uid2, -1);
    expect(storage.getFeedbackForSession("s1", uid1)).toEqual({ [msg1]: 1 });
    expect(storage.getFeedbackForSession("s1", uid2)).toEqual({ [msg1]: -1 });
  });

  it("getFeedbackSummary 统计全局 up/down 总数（不按 session 过滤），空表 ⇒ {0,0}", () => {
    expect(storage.getFeedbackSummary()).toEqual({ up_count: 0, down_count: 0 });

    const uid = storage.createUser("alice", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "答案1");
    const msg2 = storage.addMessage("s1", "assistant", "答案2");
    const msg3 = storage.addMessage("s1", "assistant", "答案3");
    storage.setMessageFeedback(msg1, "s1", uid, 1);
    storage.setMessageFeedback(msg2, "s1", uid, 1);
    storage.setMessageFeedback(msg3, "s1", uid, -1);
    expect(storage.getFeedbackSummary()).toEqual({ up_count: 2, down_count: 1 });
  });

  it("getRecentNegativeFeedback 只返回负分反馈，JOIN 出 session_title/username", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "好答案");
    const msg2 = storage.addMessage("s1", "assistant", "差答案");
    storage.setMessageFeedback(msg1, "s1", uid, 1);
    storage.setMessageFeedback(msg2, "s1", uid, -1);

    const rows = storage.getRecentNegativeFeedback();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ message_id: msg2, session_id: "s1", session_title: "seed", user_id: uid, username: "alice" });
  });

  it("getRecentNegativeFeedback 遵守 limit，按 id DESC 排序", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const msg1 = storage.addMessage("s1", "assistant", "差1");
    const msg2 = storage.addMessage("s1", "assistant", "差2");
    storage.setMessageFeedback(msg1, "s1", uid, -1);
    storage.setMessageFeedback(msg2, "s1", uid, -1);
    const rows = storage.getRecentNegativeFeedback(1);
    expect(rows.length).toBe(1);
    expect(rows[0].message_id).toBe(msg2);
  });
});

describe("getRecentLlmCalls（v1 database.py:1103 同语义）", () => {
  it("round trip：JOIN 出 session_title/username，按 id DESC 排序，遵守 limit", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: uid, model: "m1", iteration: 1, input_tokens: 1, output_tokens: 1, ttft_ms: 10, total_ms: 20 },
    ]);
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: uid, model: "m2", iteration: 2, input_tokens: 2, output_tokens: 2, ttft_ms: 30, total_ms: 40 },
    ]);
    const rows = storage.getRecentLlmCalls();
    expect(rows.length).toBe(2);
    expect(rows[0].model).toBe("m2"); // 最近一条在前
    expect(rows[0]).toMatchObject({ session_id: "s1", session_title: "seed", user_id: uid, username: "alice" });

    const limited = storage.getRecentLlmCalls(1);
    expect(limited.length).toBe(1);
    expect(limited[0].model).toBe("m2");
  });

  it("user_id 为 null 时 username 也是 null——这里不像 getUsageByUser 那样有 COALESCE 占位符兜底，直接是 LEFT JOIN 的自然结果", () => {
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: null, model: "m", iteration: 1, input_tokens: 1, output_tokens: 1, ttft_ms: 1, total_ms: 1 },
    ]);
    const rows = storage.getRecentLlmCalls();
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].username).toBeNull();
  });
});

describe("recordSemanticSearchLog / getSemanticSearchStats / getSemanticSearchRecent（分桶边界 + low_score_only 过滤，v1 database.py:1125/1156 同语义）", () => {
  function seedRows(uid: number, repoId: number) {
    // top1_score: null | 0.1 | 0.3(边界) | 0.5(边界) | 0.7(边界) | 0.95
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-null", resultCount: 0, top1Score: null, resultsJson: "[]", durationMs: 100 });
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-01", resultCount: 2, top1Score: 0.1, resultsJson: "[]", durationMs: 100 });
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-03", resultCount: 4, top1Score: 0.3, resultsJson: "[]", durationMs: 100 });
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-05", resultCount: 4, top1Score: 0.5, resultsJson: "[]", durationMs: 100 });
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-07", resultCount: 4, top1Score: 0.7, resultsJson: "[]", durationMs: 100 });
    storage.recordSemanticSearchLog({ userId: uid, repoId, query: "q-095", resultCount: 4, top1Score: 0.95, resultsJson: "[]", durationMs: 100 });
  }

  it("5 个分桶按边界 (0.3/0.5/0.7) 正确切分；NULL 落入 bucket_none 且计入 no_result_count，但不计入 low_score_count", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedRows(uid, repoId);

    const stats = storage.getSemanticSearchStats();
    expect(stats.query_count).toBe(6);
    expect(stats.no_result_count).toBe(1); // 只有 q-null 的 result_count=0
    expect(stats.low_score_count).toBe(2); // 0.1 和 0.3（< 0.5）；NULL 因 IS NOT NULL 判断被排除在外
    expect(stats.distribution).toEqual({
      bucket_none: 1,
      bucket_0_3: 1, // 0.1
      bucket_3_5: 1, // 0.3（边界值，>=0.3 记入这里而非 bucket_0_3）
      bucket_5_7: 1, // 0.5（边界值，>=0.5 记入这里而非 bucket_3_5）
      bucket_7_10: 2, // 0.7（边界值）与 0.95
    });
    expect(stats.avg_top1_score).toBeCloseTo((0.1 + 0.3 + 0.5 + 0.7 + 0.95) / 5, 5); // AVG 自动跳过 NULL
    expect(stats.avg_duration_ms).toBe(100);
  });

  it("空表：query_count=0、avg 系列兜底为 0；但 low_score_count/no_result_count/各分桶因 SQL 没有 COALESCE 保护，SUM over 0 行是 null 不是 0（已用 better-sqlite3 直接验证，v1 同一段 SQL 同样没有 COALESCE，是原样保留的行为而非本层 bug）", () => {
    const stats = storage.getSemanticSearchStats();
    expect(stats.query_count).toBe(0);
    expect(stats.avg_top1_score).toBe(0);
    expect(stats.avg_duration_ms).toBe(0);
    expect(stats.low_score_count).toBeNull();
    expect(stats.no_result_count).toBeNull();
    expect(stats.distribution).toEqual({
      bucket_none: null, bucket_0_3: null, bucket_3_5: null, bucket_5_7: null, bucket_7_10: null,
    });
  });

  it("getSemanticSearchRecent 默认返回全部，按 id DESC；lowScoreOnly=true 只保留 top1_score IS NULL OR < 0.5", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "cool-repo", url: "https://example.com/cool.git" });
    seedRows(uid, repoId);

    const all = storage.getSemanticSearchRecent();
    expect(all.length).toBe(6);
    expect(all[0].query).toBe("q-095"); // 最后插入的排最前
    expect(all[0]).toMatchObject({ repo_id: repoId, repo_name: "cool-repo", username: "alice" });

    const lowOnly = storage.getSemanticSearchRecent(50, true);
    expect(lowOnly.map((r) => r.query).sort()).toEqual(["q-01", "q-03", "q-null"].sort());
  });

  it("getSemanticSearchRecent 遵守 limit", () => {
    const uid = storage.createUser("alice", "hashed-pw");
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    seedRows(uid, repoId);
    expect(storage.getSemanticSearchRecent(2).length).toBe(2);
  });

  it("user_id 为 null 时 username 也是 null（COALESCE 占位符拼接遇到 NULL id 时整体塌缩为 NULL，与 getUsageByUser 是同一个已验证过的 SQL 行为）", () => {
    const repoId = storage.createRepo({ name: "r", url: "https://example.com/r.git" });
    storage.recordSemanticSearchLog({ userId: null, repoId, query: "anon", resultCount: 1, top1Score: 0.9, resultsJson: "[]", durationMs: 50 });
    const rows = storage.getSemanticSearchRecent();
    expect(rows[0].username).toBeNull();
  });
});
