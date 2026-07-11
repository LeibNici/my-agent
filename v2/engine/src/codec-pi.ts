// Domain <-> pi message codec — note-3 rules (0B REPORT), toolName backfill.
// pi (@earendil-works/pi-ai) types are confined to this file (and its test) —
// domain.ts/codec-legacy.ts stay pi-agnostic per the three-layer isolation
// constraint.
import type {
  Message as PiMessage,
  UserMessage as PiUserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { DomainMessage, DomainBlock, ToolUseBlock, CodecError } from "./domain.js";

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// pi-ai's Api/ProviderId types accept any string (`KnownApi | (string & {})`);
// DashScope is wired as an Anthropic-compatible endpoint in production (see
// spikes/pi-provider), matching the B6 scenario literal.
const API = "anthropic-messages";

function toDomainBlocks(content: string | DomainBlock[]): DomainBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function domainToPi(
  msgs: DomainMessage[],
  opts: { model: string; provider: string }
): PiMessage[] {
  const out: PiMessage[] = [];
  const toolNameById = new Map<string, string>();
  let clock = Date.now();
  const nextTimestamp = () => clock++;

  for (const msg of msgs) {
    const blocks = toDomainBlocks(msg.content);

    if (msg.role === "assistant") {
      const content: (PiTextContent | PiToolCall)[] = [];
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            content.push({ type: "text", text: block.text });
            break;
          case "tool_use":
            content.push({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: block.input,
            });
            toolNameById.set(block.id, block.name);
            break;
          case "image":
            throw new CodecError(
              "Image blocks in assistant messages are not supported in Phase 1"
            );
          case "tool_result":
            throw new CodecError("Unexpected tool_result block in assistant message");
          default: {
            const _exhaustive: never = block;
            throw new CodecError(`Unknown domain block type: ${_exhaustive}`);
          }
        }
      }
      const hasToolCall = content.some((c) => c.type === "toolCall");
      const assistant: PiAssistantMessage = {
        role: "assistant",
        content,
        api: API,
        provider: opts.provider,
        model: opts.model,
        usage: ZERO_USAGE,
        stopReason: hasToolCall ? "toolUse" : "stop",
        timestamp: nextTimestamp(),
      };
      out.push(assistant);
      continue;
    }

    // role === "user": tool_result blocks each become an independent
    // toolResult message (rule 3); any text blocks trailing them become a
    // separate trailing user message (rule 4, D1 default: pi's own
    // double-user shape, no manual merge — see Task 1 REPORT-phase1.md).
    const trailingText: PiTextContent[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "tool_result": {
          const toolName = toolNameById.get(block.toolUseId);
          if (toolName === undefined) {
            throw new CodecError(
              `toolName backfill failed: no prior tool_use with id ${block.toolUseId}`
            );
          }
          const toolResult: PiToolResultMessage = {
            role: "toolResult",
            toolCallId: block.toolUseId,
            toolName,
            content: [{ type: "text", text: block.content }],
            isError: block.isError,
            timestamp: nextTimestamp(),
          };
          out.push(toolResult);
          break;
        }
        case "text":
          trailingText.push({ type: "text", text: block.text });
          break;
        case "image":
          throw new CodecError(
            "Image blocks in user messages are not supported in Phase 1"
          );
        case "tool_use":
          throw new CodecError("Unexpected tool_use block in user message");
        default: {
          const _exhaustive: never = block;
          throw new CodecError(`Unknown domain block type: ${_exhaustive}`);
        }
      }
    }
    if (trailingText.length > 0) {
      const user: PiUserMessage = {
        role: "user",
        content: trailingText,
        timestamp: nextTimestamp(),
      };
      out.push(user);
    }
  }

  return out;
}

export function piAssistantToDomain(m: PiAssistantMessage): {
  message: DomainMessage;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
} {
  const content: DomainBlock[] = m.content.map((block): DomainBlock => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "toolCall": {
        const toolUse: ToolUseBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        };
        return toolUse;
      }
      case "thinking":
        throw new CodecError(
          "Thinking blocks are not supported in Phase 1 (no domain equivalent)"
        );
      default: {
        const _exhaustive: never = block;
        throw new CodecError(`Unknown pi content type: ${_exhaustive}`);
      }
    }
  });

  return {
    message: { role: "assistant", content },
    usage: { inputTokens: m.usage.input, outputTokens: m.usage.output },
    stopReason: m.stopReason,
  };
}
