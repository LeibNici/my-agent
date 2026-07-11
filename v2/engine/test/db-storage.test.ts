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
