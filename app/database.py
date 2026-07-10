"""SQLite database layer for sessions, messages, users, repos, and permissions."""

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime

import aiosqlite

DB_PATH = "agent_data.db"


@asynccontextmanager
async def _connect():
    """Open a connection with safe PRAGMAs applied."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA busy_timeout=5000")
        await db.execute("PRAGMA foreign_keys=ON")
        yield db


# ==================== Schema ====================

async def _table_columns(db, table: str) -> set[str]:
    cursor = await db.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in await cursor.fetchall()}


async def _add_column_if_missing(db, table: str, column: str, ddl: str, columns: set[str]):
    """Add `column` to `table` if not already present. `columns` is the
    table's current column set (from _table_columns) — passed in and
    updated in place so multiple checks against the same table share one
    PRAGMA table_info round-trip instead of re-querying it per column."""
    if column not in columns:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        await db.commit()
        columns.add(column)


async def init_db():
    """Create all tables if they don't exist."""
    async with _connect() as db:
        # Users
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_active INTEGER DEFAULT 1,
                created_at TEXT NOT NULL
            )
        """)
        # Repositories
        await db.execute("""
            CREATE TABLE IF NOT EXISTS repositories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                local_path TEXT,
                description TEXT DEFAULT '',
                branch TEXT,
                cred_username TEXT,
                cred_token TEXT,
                created_at TEXT NOT NULL
            )
        """)
        # Permissions (user ↔ repo)
        await db.execute("""
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
        """)
        # Sessions (with owner)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New Chat',
                owner_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
            )
        """)
        # Messages
        await db.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        # Issue submissions — the authoritative record of what was actually
        # filed on the tracker, independent of chat message rendering (which
        # only ever showed the draft card live and never persisted the
        # submit outcome).
        await db.execute("""
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
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        # Issue actions — comment/close/reopen applied to an ALREADY-FILED
        # issue (distinct from issue_submissions, which is only ever a create).
        # Exists for the same reason issue_submissions does: the chat message
        # history only ever shows the confirmation card live, never persists
        # what actually happened on the tracker.
        await db.execute("""
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
        """)
        # Per-LLM-call timing/usage — one row per iteration of the agent's
        # tool-use loop, so slow sessions can be diagnosed from real numbers
        # (time-to-first-token vs. total call time, token counts) instead of
        # inferring everything from message timestamps after the fact.
        await db.execute("""
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
        """)
        # Per-answer user feedback (👍/👎) — one row per (message, user),
        # re-rating overwrites. message_id points at the assistant message
        # that closed the turn.
        await db.execute("""
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
        """)
        # Structured completion reports parsed from tracker comments
        # (<!-- codex-report/v1 {...} --> posted by the fix fleet's
        # finish-issue tool). 1:many with issue_submissions and keyed by the
        # tracker's own note_id — an issue reopened and re-fixed gets a SECOND
        # report, and evidence from the first fix must not be overwritten.
        # `verified` is the PLATFORM's own check that commit_sha is really
        # reachable from the target branch — never trusted from the worker.
        await db.execute("""
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
        """)
        # One row per semantic_search tool call — recall-quality signal the
        # admin dashboard didn't have before: llm_call_metrics only knows
        # token/latency per LLM turn, not which tool ran or what it found.
        # Written by the tool itself via a raw sqlite3 connection (see
        # semantic_index._log_search) since it executes in the worker thread
        # the registry offloads sync tools to, not on the asyncio loop.
        await db.execute("""
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
        """)
        # SQLite does not auto-index foreign keys — without these, every
        # session open / usage query walks the whole table.
        await db.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_llm_metrics_session ON llm_call_metrics(session_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_issue_submissions_session ON issue_submissions(session_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_issue_actions_session ON issue_actions(session_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_semantic_search_log_created ON semantic_search_log(created_at)")
        await db.commit()

        # Migration: add owner_id to existing sessions table if missing
        sessions_columns = await _table_columns(db, "sessions")
        await _add_column_if_missing(db, "sessions", "owner_id", "INTEGER", sessions_columns)

        # Migration: add resolved_at to existing sessions table if missing —
        # set once a session's task (e.g. an issue submission) is complete,
        # so the next message on it transparently starts a fresh session
        # instead of tacking onto a closed thread.
        await _add_column_if_missing(db, "sessions", "resolved_at", "TEXT", sessions_columns)

        # Migration: add draft_tool_use_id to existing issue_submissions table
        # if missing — a stable key to reconcile a draft card to its real
        # submission by (title text alone collides/misses too easily).
        issue_submissions_columns = await _table_columns(db, "issue_submissions")
        await _add_column_if_missing(db, "issue_submissions", "draft_tool_use_id", "TEXT", issue_submissions_columns)

        # Migration: progress tracking — filed issues used to vanish from the
        # platform's view the moment they were submitted; these columns hold
        # what the background poller (app/issue_tracker.py) observes on the
        # tracker afterwards. track_status is the derived lifecycle phase
        # (submitted/claimed/merged/closed/reopened); remote_state is GitLab's
        # raw opened/closed; reopen 检测 comes from the resource_state_events
        # API (authoritative event stream), not snapshot diffing, so a
        # close→reopen happening entirely between two polls is still counted.
        await _add_column_if_missing(db, "issue_submissions", "track_status", "TEXT DEFAULT 'submitted'", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "remote_state", "TEXT", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "remote_labels", "TEXT", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "reopen_count", "INTEGER DEFAULT 0", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "closed_at", "TEXT", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "last_checked_at", "TEXT", issue_submissions_columns)
        await _add_column_if_missing(db, "issue_submissions", "track_error", "TEXT", issue_submissions_columns)

        # Migration: add branch and separate username/token credential columns
        # to existing repositories table if missing
        repositories_columns = await _table_columns(db, "repositories")
        await _add_column_if_missing(db, "repositories", "branch", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "cred_username", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "cred_token", "TEXT", repositories_columns)

        # Migration: sync/index observability — last_sync_at is the time of
        # the last ATTEMPT (success or failure, see last_sync_status);
        # index_status tracks the ctags symbol index separately, since it's
        # rebuilt as a background task after the git sync and can lag it.
        await _add_column_if_missing(db, "repositories", "last_sync_at", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "last_sync_status", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "last_sync_message", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "index_status", "TEXT", repositories_columns)
        await _add_column_if_missing(db, "repositories", "last_sync_sha", "TEXT", repositories_columns)

        # Migration: split any legacy combined "credentials" column (a short-lived
        # earlier design) into cred_username/cred_token
        if "credentials" in repositories_columns:
            cursor = await db.execute(
                "SELECT id, credentials FROM repositories WHERE credentials IS NOT NULL AND cred_token IS NULL"
            )
            legacy_rows = await cursor.fetchall()
            for repo_id, combined in legacy_rows:
                if ":" in combined:
                    user, _, secret = combined.partition(":")
                else:
                    user, secret = None, combined
                await db.execute(
                    "UPDATE repositories SET cred_username = ?, cred_token = ? WHERE id = ?",
                    (user or None, secret or None, repo_id),
                )
            if legacy_rows:
                await db.commit()
            # Unconditionally null out the legacy column — this must run every
            # startup (not just when a row is newly split above), since a row
            # split by an earlier version of this migration would otherwise
            # keep its raw secret sitting in "credentials" forever.
            await db.execute("UPDATE repositories SET credentials = NULL WHERE credentials IS NOT NULL")
            await db.commit()


# ==================== Users ====================

async def create_user(username: str, password_hash: str, role: str = "user") -> int:
    """Create a new user, return user ID."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            (username, password_hash, role, now),
        )
        await db.commit()
        return cursor.lastrowid


async def get_user_by_username(username: str) -> dict | None:
    """Find a user by username."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_by_id(user_id: int) -> dict | None:
    """Find a user by ID."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def list_users() -> list[dict]:
    """List all users."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, username, role, is_active, created_at FROM users ORDER BY id"
        )
        return [dict(r) for r in await cursor.fetchall()]


async def update_user_password(user_id: int, password_hash: str):
    """Update a user's password."""
    async with _connect() as db:
        await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (password_hash, user_id),
        )
        await db.commit()


async def set_user_active(user_id: int, active: bool):
    """Activate or deactivate a user."""
    async with _connect() as db:
        await db.execute(
            "UPDATE users SET is_active = ? WHERE id = ?",
            (1 if active else 0, user_id),
        )
        await db.commit()


async def delete_user(user_id: int):
    """Delete a user."""
    async with _connect() as db:
        await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        await db.commit()


# ==================== Repositories ====================

async def create_repo(name: str, url: str, description: str = "", local_path: str = None, branch: str = None, cred_username: str = None, cred_token: str = None) -> int:
    """Create a new repository entry, return repo ID."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO repositories (name, url, local_path, description, branch, cred_username, cred_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (name, url, local_path, description, branch, cred_username, cred_token, now),
        )
        await db.commit()
        return cursor.lastrowid


async def list_repos() -> list[dict]:
    """List all repositories."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM repositories ORDER BY name"
        )
        return [dict(r) for r in await cursor.fetchall()]


async def get_repo(repo_id: int) -> dict | None:
    """Get a repository by ID."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM repositories WHERE id = ?", (repo_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_repo(repo_id: int, name: str = None, url: str = None, description: str = None, local_path: str = None, branch: str = None, cred_username: str = None, cred_token: str = None,
                      last_sync_at: str = None, last_sync_status: str = None, last_sync_message: str = None, index_status: str = None, last_sync_sha: str = None):
    """Update repository fields."""
    fields = []
    values = []
    if name is not None:
        fields.append("name = ?"); values.append(name)
    if url is not None:
        fields.append("url = ?"); values.append(url)
    if branch is not None:
        fields.append("branch = ?"); values.append(branch or None)
    if cred_username is not None:
        fields.append("cred_username = ?"); values.append(cred_username or None)
    if cred_token is not None:
        fields.append("cred_token = ?"); values.append(cred_token or None)
    if description is not None:
        fields.append("description = ?"); values.append(description)
    if local_path is not None:
        fields.append("local_path = ?"); values.append(local_path)
    if last_sync_at is not None:
        fields.append("last_sync_at = ?"); values.append(last_sync_at)
    if last_sync_status is not None:
        fields.append("last_sync_status = ?"); values.append(last_sync_status)
    if last_sync_message is not None:
        fields.append("last_sync_message = ?"); values.append(last_sync_message)
    if index_status is not None:
        fields.append("index_status = ?"); values.append(index_status)
    if last_sync_sha is not None:
        fields.append("last_sync_sha = ?"); values.append(last_sync_sha)
    if not fields:
        return
    values.append(repo_id)
    async with _connect() as db:
        await db.execute(
            f"UPDATE repositories SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        await db.commit()


async def delete_repo(repo_id: int):
    """Delete a repository and its permissions."""
    async with _connect() as db:
        await db.execute("DELETE FROM permissions WHERE repo_id = ?", (repo_id,))
        await db.execute("DELETE FROM repositories WHERE id = ?", (repo_id,))
        await db.commit()


# ==================== Permissions ====================

async def grant_permission(user_id: int, repo_id: int, access_level: str = "read") -> int:
    """Grant a user access to a repository."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id, repo_id) DO UPDATE SET access_level = ?",
            (user_id, repo_id, access_level, now, access_level),
        )
        await db.commit()
        return cursor.lastrowid


async def revoke_permission(user_id: int, repo_id: int):
    """Revoke a user's access to a repository."""
    async with _connect() as db:
        await db.execute(
            "DELETE FROM permissions WHERE user_id = ? AND repo_id = ?",
            (user_id, repo_id),
        )
        await db.commit()


async def get_user_repos(user_id: int) -> list[dict]:
    """Get repositories accessible to a user."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT r.*, p.access_level
            FROM repositories r
            JOIN permissions p ON r.id = p.repo_id
            WHERE p.user_id = ?
            ORDER BY r.name
        """, (user_id,))
        return [dict(r) for r in await cursor.fetchall()]


async def get_repo_users(repo_id: int) -> list[dict]:
    """Get users who have access to a repository."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT u.id, u.username, u.role, p.access_level
            FROM users u
            JOIN permissions p ON u.id = p.user_id
            WHERE p.repo_id = ?
            ORDER BY u.username
        """, (repo_id,))
        return [dict(r) for r in await cursor.fetchall()]


async def list_permissions() -> list[dict]:
    """List all permission entries."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT p.id, p.user_id, u.username, p.repo_id, r.name as repo_name,
                   p.access_level, p.created_at
            FROM permissions p
            JOIN users u ON p.user_id = u.id
            JOIN repositories r ON p.repo_id = r.id
            ORDER BY u.username, r.name
        """)
        return [dict(r) for r in await cursor.fetchall()]


# ==================== Sessions ====================

async def create_session(title: str = "New Chat", owner_id: int = None) -> str:
    """Create a new session, return its ID. Retries on the (rare) short-ID collision."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        for _ in range(5):
            session_id = str(uuid.uuid4())[:8]
            try:
                await db.execute(
                    "INSERT INTO sessions (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (session_id, title, owner_id, now, now),
                )
                await db.commit()
                return session_id
            except aiosqlite.IntegrityError:
                continue
        raise RuntimeError("Failed to allocate a unique session ID after 5 attempts")


async def list_sessions(owner_id: int = None) -> list[dict]:
    """List sessions, optionally filtered by owner."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        if owner_id is not None:
            cursor = await db.execute(
                "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions WHERE owner_id = ? ORDER BY updated_at DESC",
                (owner_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions ORDER BY updated_at DESC"
            )
        return [dict(r) for r in await cursor.fetchall()]


async def get_session(session_id: str) -> dict | None:
    """Get session info."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions WHERE id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def mark_session_resolved(session_id: str):
    """Mark a session as resolved (its task, e.g. an issue submission, is
    done) — the next message sent against this session_id should land in a
    fresh session instead of continuing this one."""
    async with _connect() as db:
        await db.execute(
            "UPDATE sessions SET resolved_at = ? WHERE id = ?",
            (datetime.now().isoformat(), session_id),
        )
        await db.commit()


async def delete_session(session_id: str):
    """Delete a session and its messages."""
    async with _connect() as db:
        await db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()


async def add_message(session_id: str, role: str, content: str | list) -> int:
    """Add a message to a session. Returns the new message's row id."""
    now = datetime.now().isoformat()
    content_str = json.dumps(content, ensure_ascii=False) if isinstance(content, list) else content
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content_str, now),
        )
        await db.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        await db.commit()
        return cursor.lastrowid


async def get_messages(session_id: str) -> list[dict]:
    """Get all messages for a session."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        rows = await cursor.fetchall()
        messages = []
        for row in rows:
            msg = dict(row)
            raw = msg["content"]
            if isinstance(raw, str) and raw.startswith("["):
                try:
                    msg["content"] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    pass
            messages.append(msg)
        return messages


async def update_session_title(session_id: str, title: str):
    """Update session title."""
    async with _connect() as db:
        await db.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (title, datetime.now().isoformat(), session_id),
        )
        await db.commit()


# ==================== Issue submissions ====================

async def record_issue_submission(
    session_id: str, repo_id: int, user_id: int,
    title: str, body: str, labels: list[str],
    issue_number: int, issue_url: str,
    draft_tool_use_id: str | None = None,
) -> int:
    """Record the authoritative outcome of a real issue submission — the
    chat message history only ever shows the draft card live and never
    persisted whether/where it was actually filed.

    draft_tool_use_id (the draft_issue tool_use block's id) is the stable key
    used to reconcile a specific draft card to this submission on replay —
    title text alone can collide (two drafts with the same title) or simply
    be unavailable (legacy rows from before this column existed)."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO issue_submissions "
            "(session_id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, repo_id, user_id, title, body,
             json.dumps(labels, ensure_ascii=False), issue_number, issue_url, draft_tool_use_id, now),
        )
        await db.commit()
        return cursor.lastrowid


async def get_issue_submissions_for_session(session_id: str) -> list[dict]:
    """All issues actually submitted from a session, used to reconcile
    historical draft cards to their real final state on replay."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at "
            "FROM issue_submissions WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        rows = [dict(r) for r in await cursor.fetchall()]
        for r in rows:
            try:
                r["labels"] = json.loads(r["labels"])
            except (json.JSONDecodeError, TypeError):
                r["labels"] = []
        return rows


# ==================== Issue progress tracking ====================

async def get_trackable_submissions() -> list[dict]:
    """Submissions the poller should refresh this round. Everything still
    open/unknown is polled every round; closed issues drop to at most one
    check per day (instead of stopping entirely) so a late reopen is still
    caught — Codex's fleet reopens issues when a merged fix regresses."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT id, repo_id, issue_number, issue_url, track_status, remote_state,
                   reopen_count, closed_at, last_checked_at
            FROM issue_submissions
            WHERE issue_number IS NOT NULL AND issue_url IS NOT NULL
              AND (
                remote_state IS NULL OR remote_state != 'closed'
                OR last_checked_at IS NULL
                OR last_checked_at < datetime('now', 'localtime', '-1 day')
              )
            ORDER BY id
        """)
        return [dict(r) for r in await cursor.fetchall()]


async def update_issue_tracking(submission_id: int, track_status: str = None,
                                remote_state: str = None, remote_labels: str = None,
                                reopen_count: int = None, closed_at: str = None,
                                track_error: str = None, clear_error: bool = False):
    """Persist one poll's observation. Only touches passed fields, mirroring
    update_repo's pattern; last_checked_at is always stamped — it marks the
    poll ATTEMPT, success or failure (track_error carries the failure)."""
    fields, values = ["last_checked_at = ?"], [datetime.now().isoformat()]
    if track_status is not None:
        fields.append("track_status = ?"); values.append(track_status)
    if remote_state is not None:
        fields.append("remote_state = ?"); values.append(remote_state)
    if remote_labels is not None:
        fields.append("remote_labels = ?"); values.append(remote_labels)
    if reopen_count is not None:
        fields.append("reopen_count = ?"); values.append(reopen_count)
    if closed_at is not None:
        fields.append("closed_at = ?"); values.append(closed_at)
    if clear_error:
        fields.append("track_error = NULL")
    elif track_error is not None:
        fields.append("track_error = ?"); values.append(track_error)
    values.append(submission_id)
    async with _connect() as db:
        await db.execute(f"UPDATE issue_submissions SET {', '.join(fields)} WHERE id = ?", values)
        await db.commit()


async def upsert_fix_report(submission_id: int, note_id: int, worker_id: str | None,
                            commit_sha: str | None, files: list[str],
                            reported_at: str | None) -> int:
    """Insert a completion report if this note hasn't been seen; on re-poll
    of a known note, refresh the payload fields but PRESERVE `verified` —
    verification is the platform's own conclusion and a re-parse of the same
    comment must not reset it back to pending."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO issue_fix_reports "
            "(submission_id, note_id, worker_id, commit_sha, files_json, reported_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(submission_id, note_id) DO UPDATE SET "
            "worker_id = excluded.worker_id, commit_sha = excluded.commit_sha, "
            "files_json = excluded.files_json, reported_at = excluded.reported_at",
            (submission_id, note_id, worker_id, commit_sha,
             json.dumps(files, ensure_ascii=False), reported_at, now),
        )
        await db.commit()
        return cursor.lastrowid


async def get_unverified_fix_reports() -> list[dict]:
    """Reports whose commit hasn't been platform-verified yet (verified IS
    NULL). Verified 0 (checked, NOT on the branch) is a conclusion, not a
    retry queue — a commit doesn't leave a branch it was merged to short of
    history rewrites, but re-checking every such report forever would let one
    bad worker report add a permanent API call to every poll round."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT f.id, f.submission_id, f.commit_sha, s.issue_url, s.repo_id
            FROM issue_fix_reports f
            JOIN issue_submissions s ON s.id = f.submission_id
            WHERE f.verified IS NULL AND f.commit_sha IS NOT NULL
        """)
        return [dict(r) for r in await cursor.fetchall()]


async def set_fix_report_verified(report_id: int, verified: bool):
    async with _connect() as db:
        await db.execute("UPDATE issue_fix_reports SET verified = ? WHERE id = ?",
                         (1 if verified else 0, report_id))
        await db.commit()


async def get_fix_reports_for_submissions(submission_ids: list[int]) -> dict[int, list[dict]]:
    """{submission_id: [report, ...]} for the 工单 tab rows."""
    if not submission_ids:
        return {}
    placeholders = ",".join("?" * len(submission_ids))
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            f"SELECT submission_id, note_id, worker_id, commit_sha, files_json, verified, reported_at "
            f"FROM issue_fix_reports WHERE submission_id IN ({placeholders}) ORDER BY note_id",
            submission_ids,
        )
        out: dict[int, list[dict]] = {}
        for r in await cursor.fetchall():
            d = dict(r)
            try:
                d["files"] = json.loads(d.pop("files_json"))
            except (json.JSONDecodeError, TypeError):
                d["files"] = []
            out.setdefault(d["submission_id"], []).append(d)
        return out


async def get_issue_tracking_overview(limit: int = 100) -> dict:
    """The 工单 tab's data: status counts + the tracked-submission list.
    Counts are simple tallies, deliberately NOT dressed up as a 修复率 —
    'closed' includes won't-fix/duplicate closures, and calling that a fix
    rate would be a fake number until Phase 2's structured completion
    reports can distinguish real fixes."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT COALESCE(track_status, 'submitted') as status, COUNT(*) as n
            FROM issue_submissions WHERE issue_number IS NOT NULL
            GROUP BY COALESCE(track_status, 'submitted')
        """)
        counts = {r["status"]: r["n"] for r in await cursor.fetchall()}
        cursor = await db.execute("""
            SELECT s.id, s.repo_id, r.name as repo_name, s.title, s.body, s.issue_number, s.issue_url,
                   s.labels, s.submitted_at,
                   COALESCE(s.track_status, 'submitted') as track_status,
                   s.remote_state, s.remote_labels, s.reopen_count, s.closed_at,
                   s.last_checked_at, s.track_error,
                   COALESCE(u.username, '(已删除用户 #' || s.user_id || ')') as username
            FROM issue_submissions s
            LEFT JOIN users u ON u.id = s.user_id
            LEFT JOIN repositories r ON r.id = s.repo_id
            WHERE s.issue_number IS NOT NULL
            ORDER BY s.id DESC
            LIMIT ?
        """, (limit,))
        rows = [dict(r) for r in await cursor.fetchall()]
        for r in rows:
            for key in ("labels", "remote_labels"):
                try:
                    r[key] = json.loads(r[key]) if r[key] else []
                except (json.JSONDecodeError, TypeError):
                    r[key] = []
        reports = await get_fix_reports_for_submissions([r["id"] for r in rows])
        for r in rows:
            r["fix_reports"] = reports.get(r["id"], [])
        return {"counts": counts, "submissions": rows}


# ==================== Issue actions (comment/close/reopen an existing issue) ====================

async def record_issue_action(
    session_id: str, repo_id: int, user_id: int,
    issue_number: int, action: str, comment: str, issue_url: str | None,
    draft_tool_use_id: str | None = None,
) -> int:
    """Record the authoritative outcome of an issue comment/close/reopen —
    same rationale as record_issue_submission: the chat history only ever
    shows the confirmation card live, never the real tracker outcome."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO issue_actions "
            "(session_id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, applied_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, now),
        )
        await db.commit()
        return cursor.lastrowid


async def get_issue_actions_for_session(session_id: str) -> list[dict]:
    """All issue actions actually applied from a session, used to reconcile
    historical action cards to their real final state on replay."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, applied_at "
            "FROM issue_actions WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        return [dict(r) for r in await cursor.fetchall()]


# ==================== LLM call metrics ====================

async def record_llm_call_metrics(rows: list[dict]):
    """Record LLM API call timing/usage in one batch — a chat turn can now run
    up to `max_tool_iterations` (30) LLM calls, so the caller accumulates one
    row per iteration in memory and flushes them here in a single connection
    / commit instead of opening a fresh one per iteration."""
    if not rows:
        return
    now = datetime.now().isoformat()
    async with _connect() as db:
        await db.executemany(
            "INSERT INTO llm_call_metrics "
            "(session_id, user_id, model, iteration, input_tokens, output_tokens, ttft_ms, total_ms, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (r["session_id"], r["user_id"], r["model"], r["iteration"],
                 r["input_tokens"], r["output_tokens"], r["ttft_ms"], r["total_ms"], now)
                for r in rows
            ],
        )
        await db.commit()


async def get_usage_summary() -> dict:
    """Overall totals across every recorded LLM call."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                COUNT(*) as call_count,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(AVG(ttft_ms), 0) as avg_ttft_ms,
                COALESCE(MAX(ttft_ms), 0) as max_ttft_ms,
                COALESCE(AVG(total_ms), 0) as avg_total_ms,
                COALESCE(MAX(total_ms), 0) as max_total_ms
            FROM llm_call_metrics
        """)
        row = await cursor.fetchone()
        return dict(row)


async def get_usage_by_user() -> list[dict]:
    """Per-user totals, for the admin usage dashboard.

    LEFT JOINs (not INNER) and groups by m.user_id (not u.id) so that metrics
    recorded before a user was deleted are still counted here — matching
    get_usage_summary (no join) and get_recent_llm_calls (LEFT JOIN), instead
    of silently vanishing from just this one view and making the per-user
    totals stop summing to the top-line summary numbers."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                m.user_id,
                COALESCE(u.username, '(已删除用户 #' || m.user_id || ')') as username,
                COUNT(m.id) as call_count,
                COALESCE(SUM(m.input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(m.output_tokens), 0) as total_output_tokens,
                COALESCE(AVG(m.ttft_ms), 0) as avg_ttft_ms,
                COALESCE(AVG(m.total_ms), 0) as avg_total_ms
            FROM llm_call_metrics m
            LEFT JOIN users u ON u.id = m.user_id
            GROUP BY m.user_id
            ORDER BY (total_input_tokens + total_output_tokens) DESC
        """)
        return [dict(r) for r in await cursor.fetchall()]


# ==================== Message feedback ====================

async def get_message_session_id(message_id: int) -> str | None:
    """Which session a message belongs to — used to validate feedback targets."""
    async with _connect() as db:
        cursor = await db.execute("SELECT session_id FROM messages WHERE id = ?", (message_id,))
        row = await cursor.fetchone()
        return row[0] if row else None


async def set_message_feedback(message_id: int, session_id: str, user_id: int, rating: int) -> None:
    """Record a 👍(+1)/👎(-1) on an assistant message; re-rating overwrites."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        await db.execute(
            "INSERT INTO message_feedback (message_id, session_id, user_id, rating, created_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(message_id, user_id) DO UPDATE SET rating = ?, created_at = ?",
            (message_id, session_id, user_id, rating, now, rating, now),
        )
        await db.commit()


async def get_feedback_for_session(session_id: str, user_id: int) -> dict[int, int]:
    """This user's ratings in a session, as {message_id: rating} — used to
    restore button state when a session is replayed."""
    async with _connect() as db:
        cursor = await db.execute(
            "SELECT message_id, rating FROM message_feedback WHERE session_id = ? AND user_id = ?",
            (session_id, user_id),
        )
        return {row[0]: row[1] for row in await cursor.fetchall()}


async def get_feedback_summary() -> dict:
    """Overall 👍/👎 totals for the admin usage dashboard."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0) as up_count,
                COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) as down_count
            FROM message_feedback
        """)
        return dict(await cursor.fetchone())


async def get_recent_negative_feedback(limit: int = 20) -> list[dict]:
    """Most recent 👎 with session context — the admin's review queue for
    answers that missed."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT f.message_id, f.session_id, s.title as session_title,
                   f.user_id, u.username, f.created_at
            FROM message_feedback f
            LEFT JOIN users u ON u.id = f.user_id
            LEFT JOIN sessions s ON s.id = f.session_id
            WHERE f.rating < 0
            ORDER BY f.id DESC
            LIMIT ?
        """, (limit,))
        return [dict(r) for r in await cursor.fetchall()]


async def get_recent_llm_calls(limit: int = 50) -> list[dict]:
    """Most recent LLM calls with session/user context, for diagnosing a
    specific slow session after the fact."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                m.id, m.session_id, s.title as session_title,
                m.user_id, u.username,
                m.model, m.iteration, m.input_tokens, m.output_tokens,
                m.ttft_ms, m.total_ms, m.created_at
            FROM llm_call_metrics m
            LEFT JOIN users u ON u.id = m.user_id
            LEFT JOIN sessions s ON s.id = m.session_id
            ORDER BY m.id DESC
            LIMIT ?
        """, (limit,))
        return [dict(r) for r in await cursor.fetchall()]


# ==================== Semantic search log ====================

async def get_semantic_search_stats() -> dict:
    """Aggregate recall-quality signal for the admin dashboard: how many
    queries ran, how often the top hit was a weak match (top1_score < 0.5,
    the same threshold the recent-queries view flags), and how often nothing
    came back at all. Score buckets let the panel show a distribution instead
    of just one average masking a bimodal (great queries + garbage queries) mix."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("""
            SELECT
                COUNT(*) as query_count,
                COALESCE(AVG(top1_score), 0) as avg_top1_score,
                COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
                SUM(CASE WHEN top1_score IS NOT NULL AND top1_score < 0.5 THEN 1 ELSE 0 END) as low_score_count,
                SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) as no_result_count
            FROM semantic_search_log
        """)
        summary = dict(await cursor.fetchone())
        cursor = await db.execute("""
            SELECT
                SUM(CASE WHEN top1_score IS NULL THEN 1 ELSE 0 END) as bucket_none,
                SUM(CASE WHEN top1_score < 0.3 THEN 1 ELSE 0 END) as bucket_0_3,
                SUM(CASE WHEN top1_score >= 0.3 AND top1_score < 0.5 THEN 1 ELSE 0 END) as bucket_3_5,
                SUM(CASE WHEN top1_score >= 0.5 AND top1_score < 0.7 THEN 1 ELSE 0 END) as bucket_5_7,
                SUM(CASE WHEN top1_score >= 0.7 THEN 1 ELSE 0 END) as bucket_7_10
            FROM semantic_search_log
        """)
        summary["distribution"] = dict(await cursor.fetchone())
        return summary


async def get_semantic_search_recent(limit: int = 50, low_score_only: bool = False) -> list[dict]:
    """Most recent semantic_search calls with user/repo context. low_score_only
    filters to top1_score < 0.5 (or no hits at all) — the queries worth
    reviewing for a chunking/embedding-model tuning signal."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        where = "WHERE l.top1_score IS NULL OR l.top1_score < 0.5" if low_score_only else ""
        cursor = await db.execute(f"""
            SELECT l.id, l.query, l.repo_id, r.name as repo_name, l.result_count,
                   l.top1_score, l.duration_ms, l.created_at,
                   COALESCE(u.username, '(已删除用户 #' || l.user_id || ')') as username
            FROM semantic_search_log l
            LEFT JOIN users u ON u.id = l.user_id
            LEFT JOIN repositories r ON r.id = l.repo_id
            {where}
            ORDER BY l.id DESC
            LIMIT ?
        """, (limit,))
        return [dict(r) for r in await cursor.fetchall()]
