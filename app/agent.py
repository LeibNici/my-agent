"""Agent core — tool-use loop with streaming support."""

from __future__ import annotations

import json
import time
import traceback
from dataclasses import dataclass, field
from typing import AsyncIterator

from app.config import settings
from app.llm import LLMClient
from app.tools.registry import execute_tool, get_tools_schema, tool_context
from app.skills.base import build_system_prompt, get_tools_for_skills


@dataclass
class AgentEvent:
    """An event emitted by the agent during processing."""
    type: str  # "text_delta" | "tool_use" | "tool_result" | "tool_exchange" | "llm_metrics" | "done" | "error"
    data: dict = field(default_factory=dict)


class Agent:
    """Core agent that runs the tool-use loop with streaming."""

    def __init__(self, llm: LLMClient | None = None):
        self.llm = llm or LLMClient()

    async def run(
        self,
        messages: list[dict],
        active_skills: list[str] | None = None,
        allowed_repo_paths: list[str] | None = None,
        unsynced_repo_names: list[str] | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Run the agent loop, yielding events as they occur.

        This implements the standard Anthropic tool-use loop:
        1. Send messages + tools to the LLM
        2. If LLM returns tool_use → execute → append result → go to 1
        3. If LLM returns text → done
        """
        # Build system prompt with active skills
        system = build_system_prompt(settings.system_prompt, active_skills or [])

        # Set tool context for permission-aware tools
        tool_context.set({
            "allowed_repo_paths": allowed_repo_paths or [],
            # Granted but never-synced repos — lets tools report the real
            # cause instead of a blanket "no permissions" when paths are empty.
            "unsynced_repo_names": unsynced_repo_names or [],
        })

        # Collect available tools (all tools if no skills, or skill-specific tools)
        if active_skills:
            allowed_tools = get_tools_for_skills(active_skills)
            all_schemas = get_tools_schema()
            tools = [s for s in all_schemas if s["name"] in allowed_tools]
        else:
            tools = get_tools_schema()

        # Tool-use loop with iteration limit
        for iteration in range(settings.max_tool_iterations):
            # Stream the response
            full_text = ""
            tool_calls = []  # collect tool_use blocks

            # Timing/usage for this single LLM call — lets slow sessions be
            # diagnosed from real numbers (time-to-first-token vs. total call
            # time, token counts) instead of inferring everything from
            # message timestamps after the fact.
            t_request_start = time.monotonic()
            t_first_token = None
            input_tokens = 0
            output_tokens = 0

            try:
                async with self.llm.client.messages.stream(
                    model=self.llm.model,
                    max_tokens=settings.max_tokens,
                    messages=messages,
                    system=system,
                    tools=tools if tools else None,
                ) as stream:
                    current_tool = None
                    tool_input_json = ""

                    async for event in stream:
                        etype = getattr(event, "type", None)

                        if t_first_token is None and etype in ("content_block_start", "content_block_delta"):
                            t_first_token = time.monotonic()

                        if etype == "message_start":
                            input_tokens = event.message.usage.input_tokens
                        elif etype == "message_delta":
                            output_tokens = event.usage.output_tokens

                        # Text delta
                        if etype == "content_block_delta":
                            delta = event.delta
                            if getattr(delta, "type", None) == "text_delta":
                                text = delta.text
                                full_text += text
                                yield AgentEvent(type="text_delta", data={"text": text})
                            elif getattr(delta, "type", None) == "input_json_delta":
                                tool_input_json += delta.partial_json

                        # Content block start — could be text or tool_use
                        elif etype == "content_block_start":
                            block = event.content_block
                            if getattr(block, "type", None) == "tool_use":
                                current_tool = {
                                    "id": block.id,
                                    "name": block.name,
                                    "input_json": "",
                                }
                                tool_input_json = ""

                        # Content block stop
                        elif etype == "content_block_stop":
                            if current_tool:
                                current_tool["input_json"] = tool_input_json
                                tool_calls.append(current_tool)
                                current_tool = None
                                tool_input_json = ""

            except Exception as e:
                # LLM API error — emit error but do NOT emit a success-shaped done.
                # The done event carries success=false so main.py won't persist.
                yield AgentEvent(type="error", data={
                    "message": f"LLM API error: {type(e).__name__}: {str(e)}"
                })
                yield AgentEvent(type="done", data={
                    "text": full_text,
                    "success": False,
                })
                return

            t_request_end = time.monotonic()
            yield AgentEvent(type="llm_metrics", data={
                "iteration": iteration,
                "model": self.llm.model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "ttft_ms": int((t_first_token - t_request_start) * 1000) if t_first_token else None,
                "total_ms": int((t_request_end - t_request_start) * 1000),
            })

            # If there were tool calls, execute them and continue the loop
            if tool_calls:
                # Parse each tool call's input once — reused below both when
                # building the assistant message and when executing the tool.
                for tc in tool_calls:
                    try:
                        tc["input"] = json.loads(tc["input_json"]) if tc["input_json"] else {}
                    except json.JSONDecodeError:
                        tc["input"] = {}

                # Build assistant message with tool_use blocks
                assistant_blocks = []
                if full_text:
                    assistant_blocks.append({"type": "text", "text": full_text})
                for tc in tool_calls:
                    assistant_blocks.append({
                        "type": "tool_use",
                        "id": tc["id"],
                        "name": tc["name"],
                        "input": tc["input"],
                    })

                messages.append({"role": "assistant", "content": assistant_blocks})

                # Execute each tool and collect results
                tool_result_blocks = []
                for tc in tool_calls:
                    inp = tc["input"]

                    yield AgentEvent(type="tool_use", data={
                        "id": tc["id"],
                        "name": tc["name"],
                        "input": inp,
                    })

                    result = await execute_tool(tc["name"], inp, available_tools=[t["name"] for t in tools])

                    yield AgentEvent(type="tool_result", data={
                        "id": tc["id"],
                        "name": tc["name"],
                        "result": result,
                    })

                    tool_result_blocks.append({
                        "type": "tool_result",
                        "tool_use_id": tc["id"],
                        "content": result,
                    })

                # Emit this completed exchange immediately (not batched until the
                # end) so the caller can persist it right away — if the request
                # gets cancelled or errors out in a later iteration, exchanges
                # that already fully completed aren't lost.
                yield AgentEvent(type="tool_exchange", data={
                    "assistant": assistant_blocks,
                    "results": tool_result_blocks,
                })

                messages.append({"role": "user", "content": tool_result_blocks})
                # Loop continues — LLM will see tool results

            else:
                # No tool calls — the response is final text, we're done
                yield AgentEvent(type="done", data={
                    "text": full_text,
                    "success": True,
                })
                return

        # Hit iteration limit — error, not success
        yield AgentEvent(type="error", data={
            "message": f"Reached max tool iterations ({settings.max_tool_iterations})"
        })
        yield AgentEvent(type="done", data={
            "text": "",
            "success": False,
        })
