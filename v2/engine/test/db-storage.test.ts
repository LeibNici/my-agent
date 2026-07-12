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
});
