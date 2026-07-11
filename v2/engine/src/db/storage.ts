import Database from "better-sqlite3";
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

export type Storage = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): number;
  getMessages(sessionId: string): StoredMessageRow[];
  recordLlmCallMetrics(rows: LlmMetricsRow[]): void;
  getUserByUsername(username: string): UserRow | null;
  createUser(username: string, passwordHash: string, role?: string): number;
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
  if (!sessionsColumns.has("id") || !sessionsColumns.has("updated_at")) {
    throw new SchemaError(
      "missing sessions table or required columns (id, updated_at)"
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

    close(): void {
      db.close();
    },
  };
}
