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
        await db.commit()

        # Migration: add owner_id to existing sessions table if missing
        cursor = await db.execute("PRAGMA table_info(sessions)")
        columns = [row[1] for row in await cursor.fetchall()]
        if "owner_id" not in columns:
            await db.execute("ALTER TABLE sessions ADD COLUMN owner_id INTEGER")
            await db.commit()

        # Migration: add branch to existing repositories table if missing
        cursor = await db.execute("PRAGMA table_info(repositories)")
        columns = [row[1] for row in await cursor.fetchall()]
        if "branch" not in columns:
            await db.execute("ALTER TABLE repositories ADD COLUMN branch TEXT")
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

async def create_repo(name: str, url: str, description: str = "", local_path: str = None, branch: str = None) -> int:
    """Create a new repository entry, return repo ID."""
    now = datetime.now().isoformat()
    async with _connect() as db:
        cursor = await db.execute(
            "INSERT INTO repositories (name, url, local_path, description, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (name, url, local_path, description, branch, now),
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


async def update_repo(repo_id: int, name: str = None, url: str = None, description: str = None, local_path: str = None, branch: str = None):
    """Update repository fields."""
    fields = []
    values = []
    if name is not None:
        fields.append("name = ?"); values.append(name)
    if url is not None:
        fields.append("url = ?"); values.append(url)
    if branch is not None:
        fields.append("branch = ?"); values.append(branch or None)
    if description is not None:
        fields.append("description = ?"); values.append(description)
    if local_path is not None:
        fields.append("local_path = ?"); values.append(local_path)
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
                "SELECT id, title, owner_id, created_at, updated_at FROM sessions WHERE owner_id = ? ORDER BY updated_at DESC",
                (owner_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT id, title, owner_id, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
            )
        return [dict(r) for r in await cursor.fetchall()]


async def get_session(session_id: str) -> dict | None:
    """Get session info."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id, title, owner_id, created_at, updated_at FROM sessions WHERE id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def delete_session(session_id: str):
    """Delete a session and its messages."""
    async with _connect() as db:
        await db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.commit()


async def add_message(session_id: str, role: str, content: str | list):
    """Add a message to a session."""
    now = datetime.now().isoformat()
    content_str = json.dumps(content, ensure_ascii=False) if isinstance(content, list) else content
    async with _connect() as db:
        await db.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, role, content_str, now),
        )
        await db.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        await db.commit()


async def get_messages(session_id: str) -> list[dict]:
    """Get all messages for a session."""
    async with _connect() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id",
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
