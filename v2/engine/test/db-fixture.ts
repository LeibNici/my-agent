import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// DDL 逐字复制自 app/database.py init_db()（Node 永不执行 DDL，这是测试 fixture 在替 Python 建库）
const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat',
  owner_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE llm_call_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  user_id INTEGER, model TEXT, iteration INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  ttft_ms INTEGER, total_ms INTEGER, created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);`;

/** 建一个带 SCHEMA + s1 seed 的临时 sqlite 库，返回其目录和路径（调用方负责 rmSync 目录）。 */
export function makeSeededDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "v2db-"));
  const dbPath = join(dir, "t.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','seed','x','x')").run();
  db.close();
  return { dir, dbPath };
}
