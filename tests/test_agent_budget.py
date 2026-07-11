"""Goldens for the tool-budget checkpoint — the behavior Codex identified as
the hardest thing to reproduce on pi-agent-core. Five pinned semantics:
1. midpoint/endgame reminders ride on the NEXT call's tool-result message;
2. reminders are model-only — never in persisted tool_exchange blocks;
3. budget exhaustion triggers one final tool-free wrap-up call;
4. the wrap-up call requests tool_choice=none first;
5. done carries budget_exhausted=True."""
import json

import pytest

import app.tools.calculator  # noqa: F401
from app.agent import Agent, _WRAPUP_FALLBACK
from app.config import settings
from tests.fakes import FakeLLM, text_turn, text_turn_then_raise, tool_turn


@pytest.fixture
def budget8(monkeypatch):
    monkeypatch.setattr(settings, "max_tool_iterations", 8)


async def _run_to_exhaustion(fake):
    return [e async for e in Agent(llm=fake).run([{"role": "user", "content": "查"}])]


def _exhausting_turns():
    """8 tool turns (burn the whole budget) + 1 wrap-up text turn."""
    turns = [tool_turn("calculator", {"expression": f"{i}+1"}, f"tu_{i}") for i in range(8)]
    turns.append(text_turn(["阶段性汇报"]))
    return turns


async def test_midpoint_and_endgame_reminders_reach_the_model(budget8):
    fake = FakeLLM(_exhausting_turns())
    await _run_to_exhaustion(fake)
    assert len(fake.calls) == 9  # 8 loop iterations + 1 wrap-up
    # midpoint reminder is computed after iteration 3 (next_iteration ==
    # 8 // 2 == 4), so it must be absent through call 3 and first appear
    # in call 4 — pin both ends, not just "present somewhere".
    call3 = json.dumps(fake.calls[3]["messages"], ensure_ascii=False)
    assert "本轮调查已过半" not in call3
    call4 = json.dumps(fake.calls[4]["messages"], ensure_ascii=False)
    assert "本轮调查已过半" in call4
    # endgame (1 <= remaining <= 3, remaining = 8 - next_iteration) fires for
    # next_iteration in {5, 6, 7}, computed after iterations 4/5/6 — so it
    # first appears in call 5's messages, not call 4's.
    assert "仅剩" not in call4
    call5 = json.dumps(fake.calls[5]["messages"], ensure_ascii=False)
    assert "仅剩" in call5


async def test_reminders_never_appear_in_persisted_exchanges(budget8):
    fake = FakeLLM(_exhausting_turns())
    events = await _run_to_exhaustion(fake)
    for e in events:
        if e.type == "tool_exchange":
            persisted = json.dumps(e.data, ensure_ascii=False)
            assert "本轮调查已过半" not in persisted
            assert "仅剩" not in persisted


async def test_wrapup_call_is_tool_free_and_done_flags_budget(budget8):
    fake = FakeLLM(_exhausting_turns())
    events = await _run_to_exhaustion(fake)
    wrap_call = fake.calls[8]
    assert wrap_call.get("tool_choice") == {"type": "none"}  # first attempt enforces
    assert "预算已用尽" in json.dumps(wrap_call["messages"], ensure_ascii=False)
    done = events[-1]
    assert done.type == "done"
    assert done.data["budget_exhausted"] is True
    assert done.data["text"] == "阶段性汇报"


async def test_wrapup_retries_without_tool_choice_when_rejected(budget8):
    turns = _exhausting_turns()
    # first wrap-up attempt (with tool_choice) blows up, retry without succeeds
    turns[8:] = [RuntimeError("tool_choice unsupported"), text_turn(["汇报"])]
    fake = FakeLLM(turns)
    events = await _run_to_exhaustion(fake)
    assert len(fake.calls) == 10
    assert fake.calls[8].get("tool_choice") == {"type": "none"}
    assert "tool_choice" not in fake.calls[9]
    assert events[-1].data["budget_exhausted"] is True


async def test_wrapup_falls_back_when_first_attempt_streams_no_text(budget8):
    """The wrap-up stream can complete successfully (no exception) yet still
    produce zero text — e.g. the model just emits an empty content block.
    That's not a retry case (nothing raised): attempt 0 completes, the loop
    `break`s, and _WRAPUP_FALLBACK has to carry the checkpoint instead."""
    turns = _exhausting_turns()
    turns[8:] = [text_turn([])]  # completes normally, streams no text at all
    fake = FakeLLM(turns)
    events = await _run_to_exhaustion(fake)
    assert len(fake.calls) == 9  # no retry — the attempt didn't raise
    text_deltas = [e.data["text"] for e in events if e.type == "text_delta"]
    assert text_deltas == [_WRAPUP_FALLBACK]  # only the fallback was emitted
    done = events[-1]
    assert done.type == "done"
    assert done.data["budget_exhausted"] is True
    assert done.data["text"] == _WRAPUP_FALLBACK


async def test_wrapup_does_not_retry_after_partial_text_then_failure(budget8):
    """If the first wrap-up attempt already streamed some text to the client
    before dying, a retry would duplicate that text in the transcript — so
    the loop must give up with the partial text rather than retry."""
    turns = _exhausting_turns()
    turns[8:] = [text_turn_then_raise(["部分", "汇报"], RuntimeError("stream dropped"))]
    fake = FakeLLM(turns)
    events = await _run_to_exhaustion(fake)
    assert len(fake.calls) == 9  # no second attempt
    done = events[-1]
    assert done.type == "done"
    assert done.data["text"] == "部分汇报"
    assert done.data["budget_exhausted"] is True
