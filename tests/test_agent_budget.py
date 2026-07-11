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
from app.agent import Agent
from app.config import settings
from tests.fakes import FakeLLM, text_turn, tool_turn


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
    # midpoint fires before iteration 4 (next_iteration == 8//2)
    call4 = json.dumps(fake.calls[4]["messages"], ensure_ascii=False)
    assert "本轮调查已过半" in call4
    # endgame fires when 1..3 rounds remain (calls 6 and 7)
    call6 = json.dumps(fake.calls[6]["messages"], ensure_ascii=False)
    assert "仅剩" in call6


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
