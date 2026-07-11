"""Shared fixtures. Tests never touch the real agent_data.db or the network."""
import asyncio

import pytest

import app.database as database
from app.config import settings


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    """Point the whole app at a throwaway SQLite file and initialize schema."""
    db_file = tmp_path / "test.db"
    monkeypatch.setattr(database, "DB_PATH", str(db_file))
    asyncio.get_event_loop_policy()  # ensure a policy exists under pytest-asyncio
    asyncio.run(database.init_db())
    return db_file


@pytest.fixture(autouse=True)
def no_cache(monkeypatch):
    """Force prompt caching off so event goldens don't depend on .env contents."""
    monkeypatch.setattr(settings, "prompt_cache", "off")
