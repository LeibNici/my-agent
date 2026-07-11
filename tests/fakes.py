"""FakeLLM: drop-in replacement for app.llm.LLMClient that replays scripted
Anthropic stream events and records every request the agent sends.
Event attribute shapes mirror exactly what app/agent.py reads."""
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace


def text_turn(chunks, input_tokens=10, output_tokens=5):
    """One LLM call that streams plain text (chunks: list[str])."""
    return [
        SimpleNamespace(type="message_start",
                        message=SimpleNamespace(usage=SimpleNamespace(input_tokens=input_tokens))),
        SimpleNamespace(type="content_block_start",
                        content_block=SimpleNamespace(type="text")),
        *[SimpleNamespace(type="content_block_delta",
                          delta=SimpleNamespace(type="text_delta", text=c))
          for c in chunks],
        SimpleNamespace(type="content_block_stop"),
        SimpleNamespace(type="message_delta",
                        usage=SimpleNamespace(output_tokens=output_tokens)),
    ]


def tool_turn(name, input_obj, tool_id, text="", input_tokens=10, output_tokens=5):
    """One LLM call that (optionally streams text then) emits one tool_use."""
    events = [
        SimpleNamespace(type="message_start",
                        message=SimpleNamespace(usage=SimpleNamespace(input_tokens=input_tokens))),
    ]
    if text:
        events += [
            SimpleNamespace(type="content_block_start",
                            content_block=SimpleNamespace(type="text")),
            SimpleNamespace(type="content_block_delta",
                            delta=SimpleNamespace(type="text_delta", text=text)),
            SimpleNamespace(type="content_block_stop"),
        ]
    payload = json.dumps(input_obj)
    half = len(payload) // 2
    events += [
        SimpleNamespace(type="content_block_start",
                        content_block=SimpleNamespace(type="tool_use", id=tool_id, name=name)),
        # input arrives as partial_json deltas, split in two to exercise reassembly
        SimpleNamespace(type="content_block_delta",
                        delta=SimpleNamespace(type="input_json_delta", partial_json=payload[:half])),
        SimpleNamespace(type="content_block_delta",
                        delta=SimpleNamespace(type="input_json_delta", partial_json=payload[half:])),
        SimpleNamespace(type="content_block_stop"),
        SimpleNamespace(type="message_delta",
                        usage=SimpleNamespace(output_tokens=output_tokens)),
    ]
    return events


class FakeLLM:
    """turns: list where each entry is a list of events (one LLM call),
    or an Exception instance to raise when that call is attempted."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = []
        self.model = "fake-model"
        self.client = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        scripted = self.turns.pop(0)

        @asynccontextmanager
        async def ctx():
            if isinstance(scripted, Exception):
                raise scripted

            async def gen():
                for e in scripted:
                    yield e
            yield gen()
        return ctx()
