import Database from "better-sqlite3";

// v1 never had a migration story beyond "recreate the disposable dev db"
// (every column so far shipped straight in the base CREATE TABLE DDL, per
// the comment below) — safe when there's no real deployed data to preserve.
// BUG-003's must_change_password column is the first one added AFTER a
// real deployment (the 244 machine) already has a populated `users` table,
// so CREATE TABLE IF NOT EXISTS alone would silently no-op there and leave
// the column missing. This tiny guarded ALTER TABLE is additive-only (new
// column, safe default, never touches existing data) — a full migration
// framework would be over-engineering for what is still, elsewhere in this
// file, a single hand-maintained DDL script.
function ensureColumn(db: Database.Database, table: string, column: string, columnDdl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  }
}

export function initSchema(dbPath: string): void {
  const db = new Database(dbPath);

  // Apply PRAGMAs
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Create all tables if they don't exist
  // All migration columns are included in the base CREATE TABLE DDL

  // Users table with migration columns my_issues_seen_at, must_change_password
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      my_issues_seen_at TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0
    )
  `);
  // BUG-003: covers the case where `users` already existed (a real prior
  // deployment) before this column existed — CREATE TABLE IF NOT EXISTS
  // above is a no-op there, so the column would otherwise be silently
  // missing. No-ops on a fresh install (the column is already present from
  // the CREATE TABLE itself).
  ensureColumn(db, "users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 0");

  // Repositories table with migration columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      local_path TEXT,
      description TEXT DEFAULT '',
      branch TEXT,
      cred_username TEXT,
      cred_token TEXT,
      created_at TEXT NOT NULL,
      last_sync_at TEXT,
      last_sync_status TEXT,
      last_sync_message TEXT,
      index_status TEXT,
      last_sync_sha TEXT
    )
  `);

  // Permissions (user ↔ repo)
  db.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      repo_id INTEGER NOT NULL,
      access_level TEXT DEFAULT 'read',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
      UNIQUE(user_id, repo_id)
    )
  `);

  // Sessions table with migration columns owner_id and resolved_at
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      owner_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Issue submissions with migration columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      repo_id INTEGER,
      user_id INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      issue_number INTEGER,
      issue_url TEXT,
      draft_tool_use_id TEXT,
      submitted_at TEXT NOT NULL,
      track_status TEXT DEFAULT 'submitted',
      remote_state TEXT,
      remote_labels TEXT,
      reopen_count INTEGER DEFAULT 0,
      closed_at TEXT,
      last_checked_at TEXT,
      track_error TEXT,
      status_changed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Issue actions
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      repo_id INTEGER,
      user_id INTEGER,
      issue_number INTEGER NOT NULL,
      action TEXT NOT NULL,
      comment TEXT NOT NULL,
      issue_url TEXT,
      draft_tool_use_id TEXT,
      applied_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Per-LLM-call timing/usage
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_call_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      model TEXT,
      iteration INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      ttft_ms INTEGER,
      total_ms INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Per-answer user feedback
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      user_id INTEGER,
      rating INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(message_id, user_id)
    )
  `);

  // Issue fix reports
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue_fix_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      note_id INTEGER NOT NULL,
      worker_id TEXT,
      commit_sha TEXT,
      files_json TEXT NOT NULL DEFAULT '[]',
      verified INTEGER,
      reported_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(submission_id, note_id),
      FOREIGN KEY (submission_id) REFERENCES issue_submissions(id) ON DELETE CASCADE
    )
  `);

  // Semantic search log
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      repo_id INTEGER,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      top1_score REAL,
      results_json TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  // Small key/value store for server-generated secrets that need to
  // survive restarts (GitHub/GitLab webhook secrets, 2026-07-14) — the DB
  // is already the one thing every deployment persists correctly (its own
  // proven bind mount), unlike the file-based approach these replaced
  // (GitHub issue #6: a file that had to be pre-touched empty for Docker's
  // bind-mount to work then silently regenerated its secret on every
  // restart without ever persisting it). jwtSecret deliberately stays
  // file-based — it's needed before the DB is even open.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Create indexes
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_llm_metrics_session ON llm_call_metrics(session_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_issue_submissions_session ON issue_submissions(session_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_issue_actions_session ON issue_actions(session_id)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_semantic_search_log_created ON semantic_search_log(created_at)"
  );
  // Idempotent-submit guard (2026-07-13): draft_tool_use_id is stable per
  // draft card, so a retried /api/issues/submit under the same id must not
  // file a second real GitHub/GitLab issue — a partial unique index (only
  // enforced where the value is actually present) lets recordIssueSubmission
  // detect and recover from the collision instead of throwing blind.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_submissions_draft_tool_use_id " +
      "ON issue_submissions(draft_tool_use_id) WHERE draft_tool_use_id IS NOT NULL"
  );
  // Lets manage_issue's post-action recheck (getSubmissionByIssue) find the
  // right row without a full-table scan — issue_number alone isn't unique
  // across repos, so this is a compound index, not a second unique one.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_issue_submissions_repo_issue " +
      "ON issue_submissions(repo_id, issue_number)"
  );

  db.close();
}
