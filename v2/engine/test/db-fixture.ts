import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initSchema } from "../src/db/schema.js";

// Schema now comes from src/db/schema.ts's initSchema — the single DDL
// source of truth since "Node owns DDL" (Task 1 amendment; Python is gone).
// This fixture used to hand-copy DDL from app/database.py directly (back
// when Python was schema owner and this stood in for its init_db()); that
// duplicated-by-hand copy had drifted (missing sessions.resolved_at,
// users.my_issues_seen_at, and the repositories/permissions tables Task 5
// needs), so it's now a thin wrapper over the real thing instead of a
// second copy that can silently fall out of sync again.
/** 建一个带完整 schema + s1 seed 的临时 sqlite 库，返回其目录和路径（调用方负责 rmSync 目录）。 */
export function makeSeededDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "v2db-"));
  const dbPath = join(dir, "t.db");
  initSchema(dbPath);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','seed','x','x')").run();
  db.close();
  return { dir, dbPath };
}
