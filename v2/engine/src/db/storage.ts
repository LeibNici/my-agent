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

// create_repo's writable fields (Task 1 / v1's create_repo — local_path is
// deliberately excluded: it's populated later by the sync process, not at
// creation time).
export type CreateRepoFields = {
  name: string;
  url: string;
  description?: string;
  branch?: string | null;
  credUsername?: string | null;
  credToken?: string | null;
};

// update_repo's dynamic SET builder — every field is optional-and-omittable
// (undefined = "leave column untouched"); branch/credUsername/credToken
// additionally fold "" to NULL on write, matching v1's `x or None`.
export type UpdateRepoFields = Partial<{
  name: string;
  url: string;
  description: string;
  localPath: string;
  branch: string | null;
  credUsername: string | null;
  credToken: string | null;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncMessage: string;
  indexStatus: string;
  lastSyncSha: string | null;
}>;

// Admin-only full row — v1's get_repo (`SELECT *` from repositories).
// Unlike RepoRow (the client-safe subset), this exposes cred_username/
// cred_token/local_path/last_sync_*/index_status — the admin routes (Task 7)
// need these to diff PATCH changes, compute has_token, and pass credentials
// to sync_and_persist. Masking (strip cred_token to a has_token bool, mask
// the URL) is the route layer's job, NOT this method's — it returns raw data.
export type FullRepoRow = RepoRow & {
  cred_username: string | null;
  cred_token: string | null;
  local_path: string | null;
  created_at: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  index_status: string | null;
  last_sync_sha: string | null;
};

// list_permissions' JOIN row — username/repo_name resolved through
// users/repositories so callers don't need a second round-trip.
export type PermissionRow = {
  id: number;
  user_id: number;
  username: string;
  repo_id: number;
  repo_name: string;
  access_level: string;
  created_at: string;
};

export type Storage = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): number;
  getMessages(sessionId: string): StoredMessageRow[];
  recordLlmCallMetrics(rows: LlmMetricsRow[]): void;
  getUserByUsername(username: string): UserRow | null;
  getUserById(userId: number): UserRow | null;
  createUser(username: string, passwordHash: string, role?: string): number;
  listUsers(): Omit<UserRow, "password_hash">[];
  updateUserPassword(userId: number, passwordHash: string): void;
  setUserActive(userId: number, active: boolean): void;
  deleteUser(userId: number): void;
  createSession(title: string, ownerId: number | null): string;
  listSessions(ownerId: number | null): SessionRow[];
  getSession(sessionId: string): SessionRow | null;
  updateSessionTitle(sessionId: string, title: string): void;
  deleteSession(sessionId: string): void;
  listRepos(): RepoRow[];
  listReposForUser(userId: number): RepoRow[];
  getUserRepos(userId: number): RepoRow[];
  getRepo(repoId: number): RepoRow | null;
  getRepoAdmin(repoId: number): FullRepoRow | null;
  listReposFull(): FullRepoRow[];
  listReposForUserFull(userId: number): FullRepoRow[];
  createRepo(fields: CreateRepoFields): number;
  updateRepo(repoId: number, fields: UpdateRepoFields): void;
  deleteRepo(repoId: number): void;
  grantPermission(userId: number, repoId: number, accessLevel: string): number;
  revokePermission(userId: number, repoId: number): void;
  listPermissions(): PermissionRow[];
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

  // `storage` is bound to the object below, but its methods only read the
  // binding at call time (not during literal construction) — self-reference
  // (getUserRepos delegating to listReposForUser) is safe.
  const storage: Storage = {
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

    getUserById(userId: number): UserRow | null {
      const row = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(userId) as UserRow | undefined;
      return row ?? null;
    },

    // v1's list_users: password_hash deliberately excluded from the SELECT
    // (not just stripped after the fact) — never round-trips through this path.
    listUsers(): Omit<UserRow, "password_hash">[] {
      const rows = db
        .prepare("SELECT id, username, role, is_active, created_at FROM users ORDER BY id")
        .all();
      return rows as Omit<UserRow, "password_hash">[];
    },

    updateUserPassword(userId: number, passwordHash: string): void {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    },

    setUserActive(userId: number, active: boolean): void {
      db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, userId);
    },

    // No explicit permissions/sessions cleanup here — matches v1's single
    // DELETE FROM users; the schema's FKs (permissions.user_id ON DELETE
    // CASCADE, sessions.owner_id ON DELETE SET NULL) do the rest.
    deleteUser(userId: number): void {
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
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

    // v1 database.py's update_session_title: title + updated_at, nothing
    // else touched (created_at/owner_id/resolved_at all untouched).
    updateSessionTitle(sessionId: string, title: string): void {
      const now = pyLocalIsoNow();
      db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
        title,
        now,
        sessionId
      );
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

    // v1's get_user_repos — same JOIN as listReposForUser, exposed under
    // its own v1-matching name for the admin API (Task 1 brief). Delegates
    // rather than re-running the query so the JOIN has one source of truth.
    getUserRepos(userId: number): RepoRow[] {
      return storage.listReposForUser(userId);
    },

    // Admin single-repo lookup. Mirrors listRepos' public column set
    // (access_level always null, no permissions JOIN) rather than v1's
    // `SELECT *` — the credential/sync-status columns stay internal to
    // updateRepo's dynamic SET builder per the Task 1 brief's signature.
    getRepo(repoId: number): RepoRow | null {
      const row = db
        .prepare("SELECT id, name, url, description, branch FROM repositories WHERE id = ?")
        .get(repoId) as Omit<RepoRow, "access_level"> | undefined;
      return row ? { ...row, access_level: null } : null;
    },

    // Admin full-row lookup — v1's get_repo (`SELECT *`). Exposes the
    // credential/local_path/sync-status columns getRepo omits; the admin
    // routes (Task 7) need this to diff PATCH changes, compute has_token,
    // and pass credentials to sync_and_persist. No masking here — that's
    // the route layer's job (_admin_repo_view in v1).
    getRepoAdmin(repoId: number): FullRepoRow | null {
      const row = db
        .prepare("SELECT * FROM repositories WHERE id = ?")
        .get(repoId) as Omit<FullRepoRow, "access_level"> | undefined;
      return row ? { ...row, access_level: null } : null;
    },

    // Task 8: the chat route's ToolContext resolution needs local_path
    // (which RepoRow's `_public_repo`-equivalent column set never
    // includes — see RepoRow's own comment) to build allowedRepoPaths.
    // v1 didn't need this distinction: its list_repos()/get_user_repos()
    // DB functions always returned the full sqlite row (local_path
    // included), and masking only happened at the `/api/repos` ROUTE via
    // `_public_repo()`. v2 baked the masking into listRepos/listReposForUser
    // itself instead, which is safer by construction for that endpoint but
    // left no full-row bulk accessor for a server-internal caller like
    // resolveToolContext (src/server/sse.ts) that legitimately needs
    // local_path and must never let it leak to the browser. These two
    // mirror listRepos/listReposForUser's admin-bypass shape exactly, just
    // with the full column set (like getRepoAdmin) — for internal callers
    // only, never wired to a client-facing route.
    listReposFull(): FullRepoRow[] {
      const rows = db
        .prepare("SELECT * FROM repositories ORDER BY name")
        .all() as Array<Omit<FullRepoRow, "access_level">>;
      return rows.map((r) => ({ ...r, access_level: null }));
    },

    listReposForUserFull(userId: number): FullRepoRow[] {
      const rows = db
        .prepare(
          `SELECT r.*, p.access_level
           FROM repositories r
           JOIN permissions p ON r.id = p.repo_id
           WHERE p.user_id = ?
           ORDER BY r.name`
        )
        .all(userId);
      return rows as FullRepoRow[];
    },

    // v1's create_repo — local_path intentionally omitted from the writable
    // fields (Task 1 brief): it's populated later by the sync process, not
    // at creation time.
    createRepo(fields: CreateRepoFields): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO repositories (name, url, description, branch, cred_username, cred_token, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          fields.name,
          fields.url,
          fields.description ?? "",
          fields.branch ?? null,
          fields.credUsername ?? null,
          fields.credToken ?? null,
          now
        );
      return Number(res.lastInsertRowid);
    },

    // v1's update_repo: dynamic SET builder — only fields actually passed
    // (undefined) are touched; a no-op call (no fields) skips the UPDATE
    // entirely. branch/credUsername/credToken fold "" to NULL on write,
    // matching v1's `x or None`.
    updateRepo(repoId: number, fields: UpdateRepoFields): void {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        setClauses.push(`${column} = ?`);
        values.push(value);
      };

      if (fields.name !== undefined) set("name", fields.name);
      if (fields.url !== undefined) set("url", fields.url);
      if (fields.branch !== undefined) set("branch", fields.branch || null);
      if (fields.credUsername !== undefined) set("cred_username", fields.credUsername || null);
      if (fields.credToken !== undefined) set("cred_token", fields.credToken || null);
      if (fields.description !== undefined) set("description", fields.description);
      if (fields.localPath !== undefined) set("local_path", fields.localPath);
      if (fields.lastSyncAt !== undefined) set("last_sync_at", fields.lastSyncAt);
      if (fields.lastSyncStatus !== undefined) set("last_sync_status", fields.lastSyncStatus);
      if (fields.lastSyncMessage !== undefined) set("last_sync_message", fields.lastSyncMessage);
      if (fields.indexStatus !== undefined) set("index_status", fields.indexStatus);
      if (fields.lastSyncSha !== undefined) set("last_sync_sha", fields.lastSyncSha);

      if (setClauses.length === 0) return;
      values.push(repoId);
      db.prepare(`UPDATE repositories SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    },

    // Explicit two DELETEs (permissions then repositories), matching v1's
    // delete_repo exactly, both in one transaction for atomicity.
    deleteRepo(repoId: number): void {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM permissions WHERE repo_id = ?").run(repoId);
        db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
      });
      txn();
    },

    // v1's grant_permission: INSERT ... ON CONFLICT(user_id, repo_id) DO
    // UPDATE — re-granting an existing (user, repo) pair updates its
    // access_level in place rather than erroring on the UNIQUE constraint.
    grantPermission(userId: number, repoId: number, accessLevel: string): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(user_id, repo_id) DO UPDATE SET access_level = excluded.access_level"
        )
        .run(userId, repoId, accessLevel, now);
      return Number(res.lastInsertRowid);
    },

    revokePermission(userId: number, repoId: number): void {
      db.prepare("DELETE FROM permissions WHERE user_id = ? AND repo_id = ?").run(userId, repoId);
    },

    // v1's list_permissions — JOINed through users/repositories so callers
    // get username/repo_name without a second round-trip.
    listPermissions(): PermissionRow[] {
      const rows = db
        .prepare(
          `SELECT p.id, p.user_id, u.username, p.repo_id, r.name as repo_name,
                  p.access_level, p.created_at
           FROM permissions p
           JOIN users u ON p.user_id = u.id
           JOIN repositories r ON p.repo_id = r.id
           ORDER BY u.username, r.name`
        )
        .all();
      return rows as PermissionRow[];
    },

    close(): void {
      db.close();
    },
  };

  return storage;
}
