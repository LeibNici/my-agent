"""Goldens for the Agent.run event stream — the exact sequence Phase 1's
pi-event adapter must reproduce."""
import pytest

import app.tools.calculator  # noqa: F401 — side-effect: registers the tool
from app.agent import Agent
from tests.fakes import FakeLLM, text_turn, tool_turn


async def _collect(agent, messages, **kw):
    return [e async for e in agent.run(messages, **kw)]


async def test_text_only_turn_sequence():
    fake = FakeLLM([text_turn(["你", "好"])])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "hi"}])
    assert [e.type for e in events] == ["text_delta", "text_delta", "llm_metrics", "done"]
    assert events[-1].data == {"text": "你好", "success": True}
    assert events[2].data["input_tokens"] == 10 and events[2].data["output_tokens"] == 5


async def test_tool_round_sequence_and_exchange_pairing():
    fake = FakeLLM([
        tool_turn("calculator", {"expression": "1+1"}, "tu_1", text="算一下"),
        text_turn(["答案是2"]),
    ])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "1+1=?"}])
    types = [e.type for e in events]
    assert types == ["text_delta", "llm_metrics", "tool_use", "tool_result",
                     "tool_exchange", "text_delta", "llm_metrics", "done"]
    tu = next(e for e in events if e.type == "tool_use")
    assert tu.data == {"id": "tu_1", "name": "calculator",
                       "input": {"expression": "1+1"}}
    tr = next(e for e in events if e.type == "tool_result")
    assert tr.data["id"] == "tu_1" and "2" in tr.data["result"]
    ex = next(e for e in events if e.type == "tool_exchange")
    # assistant blocks: leading text + the tool_use; results pair by tool_use_id
    assert ex.data["assistant"][0] == {"type": "text", "text": "算一下"}
    assert ex.data["assistant"][1]["id"] == "tu_1"
    assert ex.data["results"][0]["tool_use_id"] == "tu_1"
    # second LLM call saw the tool_result relayed back
    relay = fake.calls[1]["messages"][-1]
    assert relay["role"] == "user"
    assert relay["content"][0]["type"] == "tool_result"


async def test_llm_error_yields_error_then_unsuccessful_done():
    fake = FakeLLM([RuntimeError("boom")])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "hi"}])
    assert [e.type for e in events] == ["error", "done"]
    assert events[0].data["message"].startswith("LLM API error: RuntimeError")
    assert events[1].data["success"] is False
