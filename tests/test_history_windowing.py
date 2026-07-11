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
    # limit=5 (not 3): with limit=3, room for condensed past is
    # max(3 - len(current_turn), 0) == 2, and the align-loop pops every
    # candidate (none of the 2 tail slots starts on a user message), so
    # condensed ends up empty either way — that fixture can't tell condense-
    # then-window apart from a naive tail slice. limit=5 leaves room=4,
    # enough for one condensed past turn to survive, which only a real
    # condense-then-window implementation gets right.
    monkeypatch.setattr(settings, "max_history_messages", 5)
    history = (_tool_heavy_turn(1) + _tool_heavy_turn(2) + _tool_heavy_turn(3)
               + [_msg("user", "当前问题"), ])
    out = _prepare_model_messages(history)
    # Hand-traced against app/main.py: current_turn = [当前问题] (1 msg);
    # condensed past (9 msgs: 3 turns x question+text+conclusion, tool_use/
    # tool_result already dropped) gets windowed to room=4 tail slots, then
    # the align-loop pops the leading non-user item — leaving exactly turn
    # 3's condensed question/text/conclusion ahead of the current turn.
    assert out == [
        _msg("user", "问题3"),
        {"role": "assistant", "content": [{"type": "text", "text": "我查一下3"}]},
        _msg("assistant", "结论3"),
        _msg("user", "当前问题"),
    ]
    assert out[0]["role"] == "user"  # never opens on assistant
    # Discriminates from naive positional slicing: msgs[-5:] would keep
    # turn 3's raw tool_use/tool_result bookkeeping (and turn 3's tool_use
    # message intact) instead of condensing it away, giving 5 messages
    # with "tool_use"/"tool_result" blocks present instead of these 4.
    flat = str(out)
    assert len(out) == 4
    assert "tool_use" not in flat and "tool_result" not in flat and "tu_3" not in flat


def test_current_turn_sent_whole_even_when_it_alone_exceeds_the_window(monkeypatch):
    # Pins the docstring's headline guarantee: "The CURRENT turn ... is
    # always sent whole, even if it alone exceeds the window."
    monkeypatch.setattr(settings, "max_history_messages", 2)
    current_turn = [
        _msg("user", "当前问题"),
        _msg("assistant", [{"type": "tool_use", "id": "tu_c", "name": "file_reader",
                            "input": {"path": "a.py"}}]),
        _msg("user", [{"type": "tool_result", "tool_use_id": "tu_c", "content": "..."}]),
    ]
    history = _tool_heavy_turn(1) + current_turn  # current turn alone is 3 msgs > limit=2
    out = _prepare_model_messages(history)
    # Hand-traced against app/main.py: current_turn has 3 messages, so
    # room = max(limit - len(current_turn), 0) == max(2 - 3, 0) == 0; since
    # room is falsy, `condensed = condensed[len-room:] if room else []`
    # takes the empty-list branch and drops ALL condensed past turn 1 —
    # nothing precedes the current turn, which survives whole and in order.
    assert out == current_turn
    assert len(out) == 3 > 2  # exceeds the monkeypatched limit, by design


def test_windowing_disabled_when_zero(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 0)
    history = _tool_heavy_turn(1) * 40
    assert len(_prepare_model_messages(history)) == len(history)
