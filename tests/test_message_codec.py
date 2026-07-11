"""Goldens for the legacy message storage format — the exact bytes Phase 2's
Node codec must reproduce. list content is JSON-encoded (ensure_ascii=False),
plain strings stored raw, decode only kicks in for a leading '['."""
import aiosqlite
import pytest

from app.database import add_message, get_messages


async def _raw_content(db_file, msg_id):
    async with aiosqlite.connect(db_file) as db:
        cur = await db.execute("SELECT content FROM messages WHERE id = ?", (msg_id,))
        return (await cur.fetchone())[0]


@pytest.fixture(autouse=True)
async def _seed_session(tmp_db):
    """add_message's own UPDATE targets sessions.id, and _connect() sets
    PRAGMA foreign_keys=ON, so messages.session_id -> sessions.id (ON DELETE
    CASCADE) is enforced — inserting a message against session "s1" without
    a matching sessions row raises sqlite3.IntegrityError. create_session()
    always mints its own random id, so tests seed the "s1" row directly."""
    async with aiosqlite.connect(tmp_db) as db:
        await db.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, 'seed', 'x', 'x')",
            ("s1",),
        )
        await db.commit()


async def test_plain_string_stored_raw(tmp_db):
    mid = await add_message("s1", "assistant", "普通回答")
    assert await _raw_content(tmp_db, mid) == "普通回答"
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == "普通回答"


async def test_block_list_roundtrips_and_keeps_unicode(tmp_db):
    blocks = [{"type": "tool_use", "id": "tu_1", "name": "code_search",
               "input": {"keyword": "不合格评审"}}]
    mid = await add_message("s1", "assistant", blocks)
    raw = await _raw_content(tmp_db, mid)
    assert raw.startswith("[") and "不合格评审" in raw  # ensure_ascii=False
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == blocks


async def test_string_starting_with_bracket_but_not_json_left_alone(tmp_db):
    text = "[系统] 这不是JSON"
    await add_message("s1", "user", text)
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == text


async def test_message_order_is_insertion_order(tmp_db):
    for i in range(3):
        await add_message("s1", "user", f"m{i}")
    msgs = await get_messages("s1")
    assert [m["content"] for m in msgs] == ["m0", "m1", "m2"]
