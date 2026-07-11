"""Goldens for the browser-facing SSE contract produced by chat_event_stream.
Pins exactly what Codex called out as wider than 'event names': the early
session event, the error→done→end reject sequence, immediate tool_exchange
persistence, and disconnect partial-save semantics."""
import asyncio
import json

import pytest

import app.main as main
from app.agent import AgentEvent
from app.database import create_user, get_messages
from app.main import ChatRequest, chat_event_stream

ADMIN = {"id": 1, "username": "admin", "role": "admin"}


@pytest.fixture
async def admin(tmp_db):
    """A real admin row in tmp_db, not just a dict.

    sessions.owner_id carries `FOREIGN KEY (owner_id) REFERENCES users(id)`
    (app/database.py) and tmp_db's PRAGMA foreign_keys=ON enforces it, so
    chat_event_stream's create_session(owner_id=current_user["id"]) needs an
    actual matching users row — the brief's plain ADMIN dict 404s that FK
    (IntegrityError, retried 5x, then "Failed to allocate a unique session
    ID"). create_user() on a fresh tmp_db always mints id=1 (AUTOINCREMENT
    from empty), so this still satisfies every test's assumption that
    ADMIN["id"] == 1.
    """
    uid = await create_user("admin", "x", role="admin")
    assert uid == 1
    return {"id": uid, "username": "admin", "role": "admin"}


class StubAgent:
    def __init__(self, events):
        self._events = events

    async def run(self, messages, **kw):
        for e in self._events:
            # BaseException, not Exception: asyncio.CancelledError has
            # inherited from BaseException (not Exception) since Python 3.8,
            # so a plain `isinstance(e, Exception)` check silently misses it
            # here — the CancelledError would fall through to `yield e`
            # instead, and chat_event_stream's `event.type` access on it
            # raises AttributeError instead of the disconnect ever propagating.
            if isinstance(e, BaseException):
                raise e
            yield e


async def _collect_sse(req, user):
    return [e async for e in chat_event_stream(req, user)]


async def test_reject_sequence_is_error_done_end(tmp_db):
    req = ChatRequest(message="x" * (main.MAX_MESSAGE_LENGTH + 1))
    events = await _collect_sse(req, ADMIN)
    assert [e["event"] for e in events] == ["error", "done", "end"]
    assert json.loads(events[1]["data"])["session_id"] is None


async def test_normal_turn_session_first_done_carries_ids(tmp_db, admin, monkeypatch):
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="text_delta", data={"text": "答案"}),
        AgentEvent(type="done", data={"text": "答案", "success": True}),
    ]))
    events = await _collect_sse(ChatRequest(message="问题"), admin)
    assert [e["event"] for e in events] == ["session", "text", "done", "end"]
    session_data = json.loads(events[0]["data"])
    assert session_data["reason"] == "new" and session_data["session_id"]
    done = json.loads(events[2]["data"])
    assert done["session_id"] == session_data["session_id"]
    assert done["message_id"] is not None
    assert done["budget_exhausted"] is False
    # persisted: user question + assistant answer
    msgs = await get_messages(session_data["session_id"])
    assert [m["role"] for m in msgs] == ["user", "assistant"]


async def test_tool_exchange_persisted_even_when_turn_errors_later(tmp_db, admin, monkeypatch):
    assistant_blocks = [{"type": "tool_use", "id": "tu_1", "name": "code_search",
                         "input": {"keyword": "x"}}]
    result_blocks = [{"type": "tool_result", "tool_use_id": "tu_1", "content": "hit"}]
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="tool_exchange",
                   data={"assistant": assistant_blocks, "results": result_blocks}),
        RuntimeError("boom"),
    ]))
    events = await _collect_sse(ChatRequest(message="查"), admin)
    assert [e["event"] for e in events] == ["session", "error", "done", "end"]
    sid = json.loads(events[0]["data"])["session_id"]
    msgs = await get_messages(sid)
    # user question + persisted exchange pair survive the crash
    assert msgs[1]["content"] == assistant_blocks
    assert msgs[2]["content"] == result_blocks


async def test_disconnect_saves_partial_text_and_reraises(tmp_db, admin, monkeypatch):
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="text_delta", data={"text": "写到一半"}),
        asyncio.CancelledError(),
    ]))
    gen = chat_event_stream(ChatRequest(message="问"), admin)
    events = []
    with pytest.raises(asyncio.CancelledError):
        async for e in gen:
            events.append(e)
    sid = json.loads(events[0]["data"])["session_id"]
    msgs = await get_messages(sid)
    assert msgs[-1]["role"] == "assistant"
    assert msgs[-1]["content"].startswith("写到一半")
    assert "连接已中断" in msgs[-1]["content"]
