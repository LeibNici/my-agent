import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { pythonJsonDumps, pyLocalIsoNow } from "./py-compat.js";

export class SchemaError extends Error {}

export type StoredMessageRow = {
  id: number;
  role: string;
  content: string | unknown[];
  timestamp: string;
};

export type LlmMetricsRow = {
  session_id: string;
  user_id: number | null;
  model: string | null;
  iteration: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
};

export type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  is_active: number;
  created_at: string;
};

export type SessionRow = {
  id: string;
  title: string;
  owner_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

// Client-safe repo fields only (id/name/url/description/branch) — matches
// v1's `_public_repo` (app/main.py) selection, which never exposes
// local_path/cred_username/cred_token to a browser response. access_level
// is populated by listReposForUser's permissions JOIN; listRepos (the
// admin "sees everything, no grant row" path) always reports it as null,
// mirroring v1's `r.get("access_level")` on a plain `list_repos()` row
// (no "access_level" key present at all there, so the dict .get() is None).
export type RepoRow = {
  id: number;
  name: string;
  url: string;
  description: string;
  branch: string | null;
  access_level: string | null;
};

export type Storage = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): number;
  getMessages(sessionId: string): StoredMessageRow[];
  recordLlmCallMetrics(rows: LlmMetricsRow[]): void;
  getUserByUsername(username: string): UserRow | null;
  createUser(username: string, passwordHash: string, role?: string): number;
  createSession(title: string, ownerId: number | null): string;
  listSessions(ownerId: number | null): SessionRow[];
  getSession(sessionId: string): SessionRow | null;
  deleteSession(sessionId: string): void;
  listRepos(): RepoRow[];
  listReposForUser(userId: number): RepoRow[];
  close(): void;
};

function checkSchema(db: Database.Database): void {
  // Check for required tables and columns using PRAGMA table_info
  const getTableColumns = (tableName: string): Set<string> => {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    return new Set(cols.map((c) => c.name));
  };

  const messagesColumns = getTableColumns("messages");
  if (
    !messagesColumns.has("id") ||
    !messagesColumns.has("session_id") ||
    !messagesColumns.has("role") ||
    !messagesColumns.has("content") ||
    !messagesColumns.has("timestamp")
  ) {
    throw new SchemaError(
      "missing messages table or required columns (id, session_id, role, content, timestamp)"
    );
  }

  const sessionsColumns = getTableColumns("sessions");
  if (
    !sessionsColumns.has("id") ||
    !sessionsColumns.has("title") ||
    !sessionsColumns.has("owner_id") ||
    !sessionsColumns.has("updated_at") ||
    !sessionsColumns.has("resolved_at")
  ) {
    throw new SchemaError(
      "missing sessions table or required columns (id, title, owner_id, updated_at, resolved_at)"
    );
  }

  const metricsColumns = getTableColumns("llm_call_metrics");
  if (
    !metricsColumns.has("session_id") ||
    !metricsColumns.has("user_id") ||
    !metricsColumns.has("model") ||
    !metricsColumns.has("iteration") ||
    !metricsColumns.has("input_tokens") ||
    !metricsColumns.has("output_tokens") ||
    !metricsColumns.has("ttft_ms") ||
    !metricsColumns.has("total_ms") ||
    !metricsColumns.has("created_at")
  ) {
    throw new SchemaError(
      "missing llm_call_metrics table or required columns"
    );
  }

  const usersColumns = getTableColumns("users");
  if (
    !usersColumns.has("id") ||
    !usersColumns.has("username") ||
    !usersColumns.has("password_hash") ||
    !usersColumns.has("role") ||
    !usersColumns.has("created_at")
  ) {
    throw new SchemaError(
      "missing users table or required columns (id, username, password_hash, role, created_at)"
    );
  }

  const reposColumns = getTableColumns("repositories");
  if (
    !reposColumns.has("id") ||
    !reposColumns.has("name") ||
    !reposColumns.has("url")
  ) {
    throw new SchemaError(
      "missing repositories table or required columns (id, name, url)"
    );
  }

  const permissionsColumns = getTableColumns("permissions");
  if (
    !permissionsColumns.has("user_id") ||
    !permissionsColumns.has("repo_id") ||
    !permissionsColumns.has("access_level")
  ) {
    throw new SchemaError(
      "missing permissions table or required columns (user_id, repo_id, access_level)"
    );
  }
}

export function openStorage(dbPath: string): Storage {
  const db = new Database(dbPath);

  // Apply PRAGMAs
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Check schema
  checkSchema(db);

  return {
    addMessage(sessionId: string, role: string, content: string | unknown[]): number {
      const now = pyLocalIsoNow();
      const contentStr =
        typeof content === "string" ? content : pythonJsonDumps(content);

      const txn = db.transaction(() => {
        const insertStmt = db.prepare(
          "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)"
        );
        const res = insertStmt.run(sessionId, role, contentStr, now);
        const msgId = Number(res.lastInsertRowid);

        db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
          now,
          sessionId
        );

        return msgId;
      });

      return txn();
    },

    getMessages(sessionId: string): StoredMessageRow[] {
      const rows = db
        .prepare(
          "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id"
        )
        .all(sessionId) as Array<{
        id: number;
        role: string;
        content: string;
        timestamp: string;
      }>;

      return rows.map((row) => {
        let parsedContent: string | unknown[] = row.content;

        if (
          typeof row.content === "string" &&
          row.content.startsWith("[")
        ) {
          try {
            parsedContent = JSON.parse(row.content);
          } catch {
            // Keep raw content on parse failure
            parsedContent = row.content;
          }
        }

        return {
          id: row.id,
          role: row.role,
          content: parsedContent,
          timestamp: row.timestamp,
        };
      });
    },

    recordLlmCallMetrics(rows: LlmMetricsRow[]): void {
      if (rows.length === 0) {
        return;
      }

      const now = pyLocalIsoNow();
      const txn = db.transaction(() => {
        const insertStmt = db.prepare(
          "INSERT INTO llm_call_metrics " +
            "(session_id, user_id, model, iteration, input_tokens, output_tokens, ttft_ms, total_ms, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );

        for (const row of rows) {
          insertStmt.run(
            row.session_id,
            row.user_id,
            row.model,
            row.iteration,
            row.input_tokens,
            row.output_tokens,
            row.ttft_ms,
            row.total_ms,
            now
          );
        }
      });

      txn();
    },

    getUserByUsername(username: string): UserRow | null {
      const row = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get(username) as UserRow | undefined;
      return row ?? null;
    },

    createUser(username: string, passwordHash: string, role: string = "user"): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)"
        )
        .run(username, passwordHash, role, now);
      return Number(res.lastInsertRowid);
    },

    // v1's create_session: mint uuid4()[:8] (first 8 hex chars — the
    // segment before the first '-' in a v4 UUID string), retry up to 5x on
    // the rare PK collision, then give up loudly rather than hang forever.
    createSession(title: string, ownerId: number | null): string {
      const now = pyLocalIsoNow();
      const insertStmt = db.prepare(
        "INSERT INTO sessions (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        const sessionId = randomUUID().slice(0, 8);
        try {
          insertStmt.run(sessionId, title, ownerId, now, now);
          return sessionId;
        } catch (err) {
          // Narrowly matched to the id-collision case (PRIMARY KEY violation)
          // — NOT a blanket SQLITE_CONSTRAINT* match, which would also catch
          // (and silently retry-then-mask behind "failed to allocate an id")
          // an invalid owner_id's FOREIGN KEY violation. better-sqlite3
          // exposes the specific extended code so there's no need to accept
          // v1's coarser `except aiosqlite.IntegrityError` ambiguity here.
          if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
            continue; // collided with an existing id — try another
          }
          throw err;
        }
      }
      throw new Error("Failed to allocate a unique session ID after 5 attempts");
    },

    listSessions(ownerId: number | null): SessionRow[] {
      const sql =
        "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions " +
        (ownerId !== null ? "WHERE owner_id = ? " : "") +
        "ORDER BY updated_at DESC";
      const rows = ownerId !== null ? db.prepare(sql).all(ownerId) : db.prepare(sql).all();
      return rows as SessionRow[];
    },

    getSession(sessionId: string): SessionRow | null {
      const row = db
        .prepare(
          "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions WHERE id = ?"
        )
        .get(sessionId) as SessionRow | undefined;
      return row ?? null;
    },

    // Explicit two DELETEs (messages then sessions), matching v1's
    // delete_session exactly, rather than relying solely on the schema's
    // `ON DELETE CASCADE` — both in one transaction for atomicity.
    deleteSession(sessionId: string): void {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      });
      txn();
    },

    // Admin "sees every repo" path — v1's list_repos(), no permissions
    // filter. access_level is always null here (no grant row backs it).
    listRepos(): RepoRow[] {
      const rows = db
        .prepare("SELECT id, name, url, description, branch FROM repositories ORDER BY name")
        .all() as Array<Omit<RepoRow, "access_level">>;
      return rows.map((r) => ({ ...r, access_level: null }));
    },

    // Non-admin "only granted repos" path — v1's get_user_repos(), JOINed
    // through permissions for this user's access_level per repo.
    listReposForUser(userId: number): RepoRow[] {
      const rows = db
        .prepare(
          `SELECT r.id, r.name, r.url, r.description, r.branch, p.access_level
           FROM repositories r
           JOIN permissions p ON r.id = p.repo_id
           WHERE p.user_id = ?
           ORDER BY r.name`
        )
        .all(userId);
      return rows as RepoRow[];
    },

    close(): void {
      db.close();
    },
  };
}
