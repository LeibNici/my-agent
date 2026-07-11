"""Goldens for _prepare_model_messages — the exact condensation semantics
Codex flagged as un-replaceable: image placeholders, current-turn-kept-whole,
past tool bookkeeping dropped, never opening on an assistant message."""
import pytest

from app.config import settings
from app.main import _HISTORY_IMAGE_PLACEHOLDER, _prepare_model_messages


def _msg(role, content):
    return {"role": role, "content": content}


def test_under_limit_passes_through_with_image_placeholder(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 60)
    history = [
        _msg("user", [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}},
                      {"type": "text", "text": "看这个截图"}]),
        _msg("assistant", "看到了"),
    ]
    out = _prepare_model_messages(history)
    assert out[0]["content"][0] == {"type": "text", "text": _HISTORY_IMAGE_PLACEHOLDER}
    assert out[0]["content"][1] == {"type": "text", "text": "看这个截图"}
    assert out[1] == {"role": "assistant", "content": "看到了"}


def _tool_heavy_turn(i):
    """One past turn: question + assistant(text+tool_use) + tool_result relay + answer."""
    return [
        _msg("user", f"问题{i}"),
        _msg("assistant", [{"type": "text", "text": f"我查一下{i}"},
                           {"type": "tool_use", "id": f"tu_{i}", "name": "code_search",
                            "input": {"keyword": "x"}}]),
        _msg("user", [{"type": "tool_result", "tool_use_id": f"tu_{i}", "content": "..."}]),
        _msg("assistant", f"结论{i}"),
    ]


def test_past_turns_condensed_current_turn_kept_whole(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 6)
    history = _tool_heavy_turn(1) + _tool_heavy_turn(2) + [
        _msg("user", "当前问题"),
        _msg("assistant", [{"type": "tool_use", "id": "tu_c", "name": "file_reader",
                            "input": {"path": "a.py"}}]),
        _msg("user", [{"type": "tool_result", "tool_use_id": "tu_c", "content": "..."}]),
    ]
    out = _prepare_model_messages(history)
    # current turn (from last plain user message) survives whole
    assert out[-3] == _msg("user", "当前问题")
    assert out[-2]["content"][0]["type"] == "tool_use"
    assert out[-1]["content"][0]["type"] == "tool_result"
    # past turns: tool_use/tool_result bookkeeping gone, questions/answers remain
    flat = str(out[:-3])
    assert "tu_1" not in flat and "tu_2" not in flat
    # condensation KEEPS the past questions and text conclusions (the whole
    # point vs. positional slicing — see app/main.py docstring)
    assert any(m == {"role": "user", "content": "问题2"} for m in out[:-3])
    assert any(m["role"] == "assistant" and "结论2" in str(m["content"]) for m in out[:-3])
    assert out[0]["role"] == "user"  # never opens on assistant


def test_condensed_past_windowed_and_never_opens_on_assistant(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 3)
    history = (_tool_heavy_turn(1) + _tool_heavy_turn(2) + _tool_heavy_turn(3)
               + [_msg("user", "当前问题"), ])
    out = _prepare_model_messages(history)
    assert len(out) <= 3 + 1  # window + current turn tolerance: current turn is 1 msg
    assert out[0]["role"] == "user"
    assert out[-1] == _msg("user", "当前问题")


def test_windowing_disabled_when_zero(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 0)
    history = _tool_heavy_turn(1) * 40
    assert len(_prepare_model_messages(history)) == len(history)
