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


# ==================== Tool-call budget ====================
#
# The iteration cap is a COST guard, not a quality ceiling. A real session
# spent all 30 rounds on a legitimate, non-repetitive cross-layer trace and
# got back nothing but "Reached max tool iterations" — the whole turn's
# findings were thrown away, and the user recovered only by manually typing
# "继续". No fixed N fixes that: an agent that misreads the question can
# burn any budget on the wrong path. So instead of a bigger number:
#
#   - at the midpoint, make the model re-check its trajectory (catching a
#     wrong path at round 15 is worth far more than warning at round 27);
#   - in the last rounds, push it to consolidate rather than keep searching;
#   - when the budget IS gone, spend one final tool-free call turning
#     whatever was learned into a checkpoint report, and let the human
#     authorize another budget window with one click.
#
# The human between windows IS the design. These texts go only into the copy
# of the conversation sent to the model — never persisted, or they'd render
# as user messages in the transcript.

_MIDPOINT_CHECK = (
    "[系统提示] 本轮调查已过半。请先在心里核对：真正要回答的问题是什么？"
    "目前已确认了什么、已排除了什么？当前这条调查路线还有证据支撑吗？"
    "如果没有，立刻换方向，不要沿着无证据的假设继续深挖。"
)

_ENDGAME_CHECK = (
    "[系统提示] 本轮调查仅剩 {n} 轮。请停止扩大搜索范围，开始收敛："
    "基于已掌握的信息整理结论——已确认什么、已排除什么、还缺什么证据。"
    "除非有一个明确的关键缺口必须补齐，否则现在就给出结论。"
)

_WRAPUP_PROMPT = (
    "[系统提示] 本轮工具调用预算已用尽，不要再调用任何工具。"
    "请直接用文字给出阶段性汇报：\n"
    "1. 目前已确认的结论（附代码位置）\n"
    "2. 已排除的可能性\n"
    "3. 还缺什么证据、下一步应该查什么\n"
    "即使结论不完整也要如实汇报，这份汇报会直接展示给用户。"
)

_WRAPUP_FALLBACK = (
    "本轮工具调用预算已用尽，且未能生成阶段性汇报。"
    "上面的工具调用记录包含了已经查到的信息，可点击「继续调查」在此基础上继续。"
)

_WRAPUP_MAX_TOKENS = 1200  # a synthesis call, not another investigation window


def _budget_reminder(next_iteration: int, max_iterations: int) -> str | None:
    """The model-only nudge to append to the tool results that iteration
    `next_iteration` will read, or None. Endgame outranks the midpoint check
    when a small max_iterations makes both fire."""
    remaining = max_iterations - next_iteration  # rounds left, including the next one
    if 1 <= remaining <= 3:
        return _ENDGAME_CHECK.format(n=remaining)
    if max_iterations >= 6 and next_iteration == max_iterations // 2:
        return _MIDPOINT_CHECK
    return None


def _apply_cache_control(messages: list[dict]) -> None:
    """Move the conversation cache breakpoint to the last content block.

    Prompt caching is a prefix match: marking the newest block lets every
    LLM call in the tool loop (and the next user turn) reuse the whole prior
    conversation at cache-read prices. Old markers are stripped first so the
    request never exceeds the 4-breakpoint API limit as the loop appends
    messages. Mutates `messages` in place; string contents are converted to
    a single text block so they can carry the marker.
    """
    for msg in messages:
        if isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if isinstance(block, dict):
                    block.pop("cache_control", None)
    if not messages:
        return
    last = messages[-1]
    if isinstance(last.get("content"), str):
        last["content"] = [{"type": "text", "text": last["content"]}]
    if isinstance(last.get("content"), list) and last["content"]:
        block = last["content"][-1]
        if isinstance(block, dict) and block.get("type") in ("text", "tool_result", "image"):
            block["cache_control"] = {"type": "ephemeral"}


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
        active_repo: dict | None = None,
        user_id: int | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Run the agent loop, yielding events as they occur.

        This implements the standard Anthropic tool-use loop:
        1. Send messages + tools to the LLM
        2. If LLM returns tool_use → execute → append result → go to 1
        3. If LLM returns text → done
        """
        # Build system prompt with active skills
        system = build_system_prompt(settings.system_prompt, active_skills or [])
        # With caching on, the system prompt becomes a cached prefix block —
        # tools render before system, so this one breakpoint covers both.
        cache_enabled = settings.prompt_cache_enabled
        if cache_enabled:
            system = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]

        # Set tool context for permission-aware tools
        tool_context.set({
            "allowed_repo_paths": allowed_repo_paths or [],
            # Granted but never-synced repos — lets tools report the real
            # cause instead of a blanket "no permissions" when paths are empty.
            "unsynced_repo_names": unsynced_repo_names or [],
            # The repo this chat turn is scoped to ({id, name}) — draft_issue
            # stamps it into drafts so submission can't target the wrong repo.
            "active_repo": active_repo,
            # For tools that log their own per-user activity (semantic_search).
            "user_id": user_id,
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

            if cache_enabled:
                _apply_cache_control(messages)

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

                # Budget nudge rides along on the message the next round already
                # has to read — no extra LLM call. It goes into a NEW list so the
                # blocks just persisted above stay clean; the API requires the
                # tool_result blocks to come before any trailing text block.
                model_content = tool_result_blocks
                reminder = _budget_reminder(iteration + 1, settings.max_tool_iterations)
                if reminder:
                    model_content = tool_result_blocks + [{"type": "text", "text": reminder}]

                messages.append({"role": "user", "content": model_content})
                # Loop continues — LLM will see tool results

            else:
                # No tool calls — the response is final text, we're done
                yield AgentEvent(type="done", data={
                    "text": full_text,
                    "success": True,
                })
                return

        # Budget exhausted. NOT an error — the tool results gathered so far are
        # real work. Spend one final tool-free call converting them into a
        # checkpoint report the user can act on (and continue from), instead of
        # discarding the entire turn.
        messages.append({"role": "user", "content": [{"type": "text", "text": _WRAPUP_PROMPT}]})
        if cache_enabled:
            _apply_cache_control(messages)

        wrap_text = ""
        t_wrap_start = time.monotonic()
        wrap_in_tokens = wrap_out_tokens = 0
        # tool_choice=none is the real enforcement; the instruction alone is
        # only a request. Some Anthropic-compatible endpoints reject the field,
        # so fall back to instruction-only — and either way any tool_use the
        # model still emits is simply never executed, text is the deliverable.
        for attempt, extra in enumerate(({"tool_choice": {"type": "none"}}, {})):
            try:
                async with self.llm.client.messages.stream(
                    model=self.llm.model,
                    max_tokens=_WRAPUP_MAX_TOKENS,
                    messages=messages,
                    system=system,
                    tools=tools if tools else None,
                    **extra,
                ) as stream:
                    async for event in stream:
                        etype = getattr(event, "type", None)
                        if etype == "message_start":
                            wrap_in_tokens = event.message.usage.input_tokens
                        elif etype == "message_delta":
                            wrap_out_tokens = event.usage.output_tokens
                        elif etype == "content_block_delta":
                            delta = event.delta
                            if getattr(delta, "type", None) == "text_delta":
                                wrap_text += delta.text
                                yield AgentEvent(type="text_delta", data={"text": delta.text})
                break
            except Exception:
                # Only retry the un-streamed case: once text has reached the
                # client, a retry would duplicate it in the transcript.
                if attempt == 0 and not wrap_text:
                    continue
                break

        yield AgentEvent(type="llm_metrics", data={
            "iteration": settings.max_tool_iterations,
            "model": self.llm.model,
            "input_tokens": wrap_in_tokens,
            "output_tokens": wrap_out_tokens,
            "ttft_ms": None,
            "total_ms": int((time.monotonic() - t_wrap_start) * 1000),
        })

        if not wrap_text.strip():
            wrap_text = _WRAPUP_FALLBACK
            yield AgentEvent(type="text_delta", data={"text": wrap_text})

        yield AgentEvent(type="done", data={
            "text": wrap_text,
            "success": True,
            "budget_exhausted": True,
        })
