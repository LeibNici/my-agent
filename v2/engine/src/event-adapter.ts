// pi AgentEvent -> legacy domain-event adapter (Task 6). pi types
// (@earendil-works/pi-agent-core, @earendil-works/pi-ai) are confined to this
// file (and its test) — domain.ts/codec-legacy.ts stay pi-agnostic per the
// three-layer isolation constraint.
//
// Oracle: tests/test_agent_events.py (three golden event-type sequences).
// Real pi 0.80.6 event surface (verified against
// node_modules/@earendil-works/pi-agent-core/dist/{types,agent,agent-loop}.d.ts
// /.js and an offline smoke run against the mock server — see task-6-report.md
// for the full deviation log from the brief's sketch table):
//
//   - message_update carries an AssistantMessageEvent sub-type
//     (start/text_start/text_delta/text_end/toolcall_*/thinking_*); only
//     "text_delta" maps to a domain text_delta — the others (including the
//     toolcall_start/delta/end trio that streams tool-call JSON) are no-ops
//     here since tool_use is sourced from tool_execution_start instead.
//   - message_end fires for EVERY AgentMessage (user echoes, assistant
//     responses, and toolResult messages alike) — only assistant messages
//     with a non-error stopReason produce llm_metrics; user/toolResult
//     message_end and error/aborted assistant message_end are no-ops.
//   - There is no distinct pi "error" AgentEvent. A failed LLM call surfaces
//     as message_end(assistant) with stopReason "error"/"aborted" and
//     errorMessage set (confirmed against a real HTTP 500 through the mock —
//     pi's StreamFn contract requires providers to swallow transport/API
//     failures into this shape rather than throw). This adapter treats that
//     message_end as a silent no-op; the caller is expected to notice via
//     `agent.state.errorMessage` after the run settles and call `fail()`
//     instead of `finish()` — see event-adapter.test.ts's runTurnThroughAdapter.
//   - turn_end always fires (even with an empty toolResults array, e.g. after
//     a plain text turn) — only turn_end with a non-empty toolResults array
//     maps to tool_exchange.
import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage as PiAssistantMessage,
  TextContent as PiTextContent,
  ImageContent as PiImageContent,
} from "@earendil-works/pi-ai";
import { piAssistantToDomain } from "./codec-pi.js";
import type { DomainEvent, DomainBlock, ToolResultBlock } from "./domain.js";

function contentToText(content: (PiTextContent | PiImageContent)[]): string {
  return content
    .filter((c): c is PiTextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// piAssistantToDomain always builds an assistant DomainMessage with an array
// `content` (never the plain-string shape DomainMessage.content also allows
// for user messages) — narrow that back out for TS.
function assistantBlocks(content: string | DomainBlock[]): DomainBlock[] {
  return Array.isArray(content) ? content : [];
}

export function createEventAdapter(opts: { model: string }): {
  onPiEvent(e: PiAgentEvent): DomainEvent[];
  finish(): DomainEvent[];
  fail(message: string): DomainEvent[];
} {
  let iteration = 0;
  let callStartMs: number | undefined;
  let firstTextDeltaMs: number | undefined;
  let lastAssistantText = "";

  function onPiEvent(e: PiAgentEvent): DomainEvent[] {
    switch (e.type) {
      case "message_start": {
        if (e.message.role === "assistant") {
          callStartMs = Date.now();
          firstTextDeltaMs = undefined;
        }
        return [];
      }

      case "message_update": {
        const ame = e.assistantMessageEvent;
        if (ame.type === "text_delta") {
          if (firstTextDeltaMs === undefined) firstTextDeltaMs = Date.now();
          return [{ type: "text_delta", data: { text: ame.delta } }];
        }
        return [];
      }

      case "message_end": {
        if (e.message.role !== "assistant") return [];
        const msg = e.message as PiAssistantMessage;
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          // Failure path: no llm_metrics. Caller detects the failed run
          // (agent.state.errorMessage) and calls fail() instead of finish().
          return [];
        }
        const { message, usage } = piAssistantToDomain(msg);
        lastAssistantText = assistantBlocks(message.content)
          .filter((b): b is Extract<DomainBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        const totalMs = callStartMs !== undefined ? Date.now() - callStartMs : 0;
        const ttftMs =
          firstTextDeltaMs !== undefined && callStartMs !== undefined
            ? firstTextDeltaMs - callStartMs
            : null;
        const out: DomainEvent[] = [
          {
            type: "llm_metrics",
            data: {
              iteration,
              model: opts.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ttftMs,
              totalMs,
            },
          },
        ];
        iteration += 1;
        return out;
      }

      case "tool_execution_start":
        return [
          { type: "tool_use", data: { id: e.toolCallId, name: e.toolName, input: e.args } },
        ];

      case "tool_execution_end":
        return [
          {
            type: "tool_result",
            data: { id: e.toolCallId, result: contentToText(e.result?.content ?? []) },
          },
        ];

      case "turn_end": {
        if (e.toolResults.length === 0) return [];
        if (e.message.role !== "assistant") return [];
        const { message } = piAssistantToDomain(e.message as PiAssistantMessage);
        const results: ToolResultBlock[] = e.toolResults.map((tr) => ({
          type: "tool_result",
          toolUseId: tr.toolCallId,
          content: contentToText(tr.content),
          isError: tr.isError,
        }));
        return [{ type: "tool_exchange", data: { assistant: assistantBlocks(message.content), results } }];
      }

      default:
        return [];
    }
  }

  function finish(): DomainEvent[] {
    return [{ type: "done", data: { text: lastAssistantText, success: true } }];
  }

  function fail(message: string): DomainEvent[] {
    return [
      { type: "error", data: { message: `LLM API error: ${message}` } },
      { type: "done", data: { text: "", success: false } },
    ];
  }

  return { onPiEvent, finish, fail };
}
