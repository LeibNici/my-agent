import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { loadSettings, loadOrCreateJwtSecret } from "../src/config.js";
import { initSchema } from "../src/db/schema.js";
import { openStorage } from "../src/db/storage.js";

describe("loadSettings", () => {
  it("loads default settings when no env is provided", () => {
    const settings = loadSettings({});
    expect(settings.maxToolIterations).toBe(30);
    expect(settings.maxHistoryMessages).toBe(60);
    expect(settings.maxTokens).toBe(4096);
    expect(settings.adminUsername).toBe("admin");
    expect(settings.adminPassword).toBe("admin123");
    expect(settings.tokenExpireHours).toBe(24);
    expect(settings.corsOrigins).toContain("http://localhost:8000");
    expect(settings.promptCache).toBe("auto");
  });

  it("parses numeric fields from env strings", () => {
    const settings = loadSettings({
      ANTHROPIC_MAX_TOKENS: "8192",
      ANTHROPIC_MAX_TOOL_ITERATIONS: "50",
      ANTHROPIC_MAX_HISTORY_MESSAGES: "100",
      APP_TOKEN_EXPIRE_HOURS: "48",
    });
    expect(settings.maxTokens).toBe(8192);
    expect(settings.maxToolIterations).toBe(50);
    expect(settings.maxHistoryMessages).toBe(100);
    expect(settings.tokenExpireHours).toBe(48);
  });

  it("respects env var overrides with ANTHROPIC_ prefix", () => {
    const settings = loadSettings({
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: "https://custom.example.com",
      ANTHROPIC_MODEL: "custom-model",
    });
    expect(settings.apiKey).toBe("test-key");
    expect(settings.baseUrl).toBe("https://custom.example.com");
    expect(settings.model).toBe("custom-model");
  });

  it("respects env var overrides with APP_ prefix", () => {
    const settings = loadSettings({
      APP_ADMIN_USERNAME: "superadmin",
      APP_ADMIN_PASSWORD: "supersecret",
      APP_REPOS_DIR: "/custom/repos",
    });
    expect(settings.adminUsername).toBe("superadmin");
    expect(settings.adminPassword).toBe("supersecret");
    expect(settings.reposDir).toBe("/custom/repos");
  });

  it("contains systemPrompt with default Chinese text", () => {
    const settings = loadSettings({});
    expect(settings.systemPrompt).toContain("You are an internal code assistant");
  });
});

describe("loadOrCreateJwtSecret", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jwt-secret-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("creates jwt secret file if missing", () => {
    const secret = loadOrCreateJwtSecret(tmpDir);
    expect(secret).toBeDefined();
    expect(secret.length).toBeGreaterThan(0);

    const secretFile = path.join(tmpDir, ".jwt_secret");
    expect(fs.existsSync(secretFile)).toBe(true);
  });

  it("reads existing jwt secret file", () => {
    const secretFile = path.join(tmpDir, ".jwt_secret");
    const originalSecret = "my-existing-secret-key";
    fs.writeFileSync(secretFile, originalSecret, { mode: 0o600 });

    const secret = loadOrCreateJwtSecret(tmpDir);
    expect(secret).toBe(originalSecret);
  });

  it("sets correct file permissions (0600)", () => {
    const secretFile = path.join(tmpDir, ".jwt_secret");
    loadOrCreateJwtSecret(tmpDir);

    const stats = fs.statSync(secretFile);
    const mode = (stats.mode & parseInt("777", 8)).toString(8);
    expect(mode).toBe("600");
  });
});

describe("initSchema", () => {
  let tmpDbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-test-"));
    tmpDbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  it("creates schema in a fresh database", () => {
    initSchema(tmpDbPath);

    // Verify the database file was created
    expect(fs.existsSync(tmpDbPath)).toBe(true);

    // Verify tables exist
    const db = new Database(tmpDbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    db.close();

    const tableNames = tables.map((t) => t.name).sort();
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("repositories");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("issue_submissions");
    expect(tableNames).toContain("llm_call_metrics");
  });

  it("schema is idempotent (can call initSchema multiple times)", () => {
    initSchema(tmpDbPath);
    // Call again - should not throw or fail
    expect(() => initSchema(tmpDbPath)).not.toThrow();
  });

  it("openStorage checkSchema passes after initSchema", () => {
    initSchema(tmpDbPath);
    // This should not throw SchemaError
    const storage = openStorage(tmpDbPath);
    storage.close();
  });

  it("includes migration columns in base DDL", () => {
    initSchema(tmpDbPath);

    const db = new Database(tmpDbPath);

    // Check issue_submissions has migration columns
    const issueSubmissionsColumns = db
      .prepare("PRAGMA table_info(issue_submissions)")
      .all() as Array<{ name: string }>;
    const issueColumnNames = issueSubmissionsColumns.map((c) => c.name);
    expect(issueColumnNames).toContain("track_status");
    expect(issueColumnNames).toContain("remote_state");
    expect(issueColumnNames).toContain("remote_labels");
    expect(issueColumnNames).toContain("reopen_count");
    expect(issueColumnNames).toContain("closed_at");
    expect(issueColumnNames).toContain("last_checked_at");
    expect(issueColumnNames).toContain("track_error");
    expect(issueColumnNames).toContain("status_changed_at");

    // Check users has migration columns
    const usersColumns = db
      .prepare("PRAGMA table_info(users)")
      .all() as Array<{ name: string }>;
    const userColumnNames = usersColumns.map((c) => c.name);
    expect(userColumnNames).toContain("my_issues_seen_at");
    expect(userColumnNames).toContain("must_change_password");

    // Check repositories has migration columns
    const reposColumns = db
      .prepare("PRAGMA table_info(repositories)")
      .all() as Array<{ name: string }>;
    const repoColumnNames = reposColumns.map((c) => c.name);
    expect(repoColumnNames).toContain("last_sync_at");
    expect(repoColumnNames).toContain("last_sync_status");
    expect(repoColumnNames).toContain("last_sync_message");
    expect(repoColumnNames).toContain("index_status");
    expect(repoColumnNames).toContain("last_sync_sha");

    db.close();
  });

  it("includes all required indexes", () => {
    initSchema(tmpDbPath);

    const db = new Database(tmpDbPath);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    db.close();

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_messages_session");
    expect(indexNames).toContain("idx_llm_metrics_session");
    expect(indexNames).toContain("idx_issue_submissions_session");
    expect(indexNames).toContain("idx_issue_actions_session");
    expect(indexNames).toContain("idx_sessions_owner");
    expect(indexNames).toContain("idx_semantic_search_log_created");
    expect(indexNames).toContain("idx_issue_submissions_draft_tool_use_id");
    expect(indexNames).toContain("idx_issue_submissions_repo_issue");
  });

  it("idempotent-submit guard: draft_tool_use_id unique index actually rejects a second non-null duplicate at the raw SQL level; re-running initSchema on an already-migrated db doesn't error", () => {
    initSchema(tmpDbPath);
    // Idempotency of the CREATE UNIQUE INDEX IF NOT EXISTS statement itself
    // (matches this file's own "schema is idempotent" test above, just
    // pinned specifically to the new index rather than the whole schema).
    expect(() => initSchema(tmpDbPath)).not.toThrow();

    const db = new Database(tmpDbPath);
    const insert = db.prepare(
      "INSERT INTO issue_submissions " +
        "(session_id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    db.prepare("INSERT INTO sessions (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("s1", "t", null, "2026-01-01 00:00:00.000000", "2026-01-01 00:00:00.000000");
    insert.run("s1", null, null, "t1", "b1", "[]", 1, "https://x/1", "tu_dup", "2026-01-01 00:00:00.000000");
    expect(() =>
      insert.run("s1", null, null, "t2", "b2", "[]", 2, "https://x/2", "tu_dup", "2026-01-01 00:00:00.000000")
    ).toThrow(/UNIQUE constraint failed/);
    // NULL draft_tool_use_id is explicitly exempted (WHERE draft_tool_use_id
    // IS NOT NULL) — two rows with no draft id at all must NOT collide.
    expect(() =>
      insert.run("s1", null, null, "t3", "b3", "[]", 3, "https://x/3", null, "2026-01-01 00:00:00.000000")
    ).not.toThrow();
    expect(() =>
      insert.run("s1", null, null, "t4", "b4", "[]", 4, "https://x/4", null, "2026-01-01 00:00:00.000000")
    ).not.toThrow();
    db.close();
  });

  it("BUG-003: retrofits must_change_password onto a pre-existing users table (a prior real deployment) via ALTER TABLE, without losing existing rows", () => {
    // Simulates the 244 machine's already-deployed db: a `users` table
    // created BEFORE this column existed. CREATE TABLE IF NOT EXISTS alone
    // would no-op against this and leave the column missing — this proves
    // ensureColumn's guarded ALTER TABLE path actually fires.
    const db = new Database(tmpDbPath);
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES ('preexisting', 'hash', 'admin', 'x')"
    ).run();
    db.close();

    expect(() => initSchema(tmpDbPath)).not.toThrow();

    const db2 = new Database(tmpDbPath);
    const columns = db2.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("must_change_password");
    const row = db2.prepare("SELECT * FROM users WHERE username = 'preexisting'").get() as {
      must_change_password: number;
    };
    expect(row.must_change_password).toBe(0);
    db2.close();
  });

  it("applies correct PRAGMAs", () => {
    initSchema(tmpDbPath);

    const db = new Database(tmpDbPath);
    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    db.close();

    expect(journalMode).toBe("wal");
    expect(foreignKeys).toBe(1);
  });
});
