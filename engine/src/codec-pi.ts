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
  ImageContent as PiImageContent,
  ThinkingContent as PiThinkingContent,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { DomainMessage, DomainBlock, ToolUseBlock, ThinkingBlock, CodecError } from "./domain.js";

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
      const content: (PiTextContent | PiThinkingContent | PiToolCall)[] = [];
      for (const block of blocks) {
        switch (block.type) {
          case "text":
            content.push({ type: "text", text: block.text });
            break;
          case "thinking":
            content.push({
              type: "thinking",
              thinking: block.thinking,
              thinkingSignature: block.thinkingSignature,
              redacted: block.redacted,
            });
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
            // Not a Phase-1 gap (unlike the old user-message throw this
            // codec used to have) — pi-ai's own AssistantMessage.content
            // type structurally excludes ImageContent (only
            // TextContent|ThinkingContent|ToolCall), matching Anthropic
            // itself never emitting an image block in an assistant turn.
            throw new CodecError("Unexpected image block in assistant message");
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
    // toolResult message (rule 3); any text/image blocks trailing them
    // become a separate trailing user message (rule 4, D1 default: pi's
    // own double-user shape, no manual merge — see Task 1
    // REPORT-phase1.md). This assumes legacy's invariant that text never
    // precedes tool_result in the same message (app/agent.py always
    // builds tool_result_blocks + [reminder_text]) — enforced below
    // rather than silently reordered, matching this switch's fail-loud
    // handling of every other invalid shape (tool_use in a user message).
    // Images are always fresh user input (sse.ts puts them before the
    // text block, matching v1's `user_content = [image blocks..., text]`)
    // — they never coexist with a tool_result in the same domain message,
    // but nothing here assumes that; an image just accumulates into the
    // same trailing array as text, in whatever order it appears.
    const trailingContent: (PiTextContent | PiImageContent)[] = [];
    let seenText = false;
    for (const block of blocks) {
      switch (block.type) {
        case "tool_result": {
          if (seenText) {
            throw new CodecError(
              "tool_result block found after a text block in the same user message"
            );
          }
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
          seenText = true;
          trailingContent.push({ type: "text", text: block.text });
          break;
        case "image":
          // pi-ai's ImageContent field names are data/mimeType, not
          // base64Data/mediaType — a rename, not a structural change; pi's
          // own Anthropic provider re-wraps this into the
          // {type:"image",source:{type:"base64",media_type,data}} shape
          // internally (see anthropic-messages.js's convertContentBlocks).
          trailingContent.push({ type: "image", data: block.base64Data, mimeType: block.mediaType });
          break;
        case "tool_use":
          throw new CodecError("Unexpected tool_use block in user message");
        case "thinking":
          // Structurally assistant-only; this case exists purely to satisfy
          // the exhaustiveness check now that ThinkingBlock is part of
          // DomainBlock — should never fire against data this codec itself
          // produces.
          throw new CodecError("Unexpected thinking block in user message");
        default: {
          const _exhaustive: never = block;
          throw new CodecError(`Unknown domain block type: ${_exhaustive}`);
        }
      }
    }
    if (trailingContent.length > 0) {
      const user: PiUserMessage = {
        role: "user",
        content: trailingContent,
        timestamp: nextTimestamp(),
      };
      out.push(user);
    }
  }

  return out;
}

// Defensive cleanup (2026-07-13 QA follow-up, FLOW-002): DashScope's
// Anthropic-compatible bridge for Qwen3.7-plus occasionally fails to
// cleanly separate hidden reasoning from the visible answer — confirmed
// against a real production sample where a bare `</thinking>` closing tag
// (no matching opening tag) turned up 1057 characters into what pi-ai
// reported as a "text" block, with everything before it being narration
// ("Now I have enough information to write a comprehensive analysis...")
// that should have stayed hidden thinking. This is an upstream DashScope/
// pi-ai limitation, not something a request-side option can prevent — see
// github.com/earendil-works/pi issues #2022 and #2770 (the latter's fix
// isn't in our pinned pi-ai@0.80.6 yet, and it only covers the
// openai-completions API path we don't use anyway). Stripping it here
// rather than showing it to the user; this does not attempt to recover
// anything from inside the leaked span, only to hide it.
const PAIRED_THINKING_TAG_RE = /<thinking>[\s\S]*?<\/thinking>|<think>[\s\S]*?<\/think>/gi;
const ORPHAN_THINKING_CLOSE_RE = /^[\s\S]*?<\/(?:thinking|think)>/i;
const HAS_OPEN_THINKING_TAG_RE = /<(?:thinking|think)>/i;
const HAS_CLOSE_THINKING_TAG_RE = /<\/(?:thinking|think)>/i;

function stripLeakedThinkingTags(text: string): string {
  // Properly paired tags anywhere in the text (either tag name): drop the
  // whole opening-to-closing span, wherever it falls.
  let cleaned = text.replace(PAIRED_THINKING_TAG_RE, "");
  // What's actually been observed in production: a bare closing tag with
  // no opening tag at all (the leading narration was never wrapped in
  // anything) — drop everything from the start through that tag.
  if (HAS_CLOSE_THINKING_TAG_RE.test(cleaned) && !HAS_OPEN_THINKING_TAG_RE.test(cleaned)) {
    cleaned = cleaned.replace(ORPHAN_THINKING_CLOSE_RE, "");
  }
  return cleaned;
}

export function piAssistantToDomain(m: PiAssistantMessage): {
  message: DomainMessage;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
} {
  const content: DomainBlock[] = m.content.map((block): DomainBlock => {
    switch (block.type) {
      case "text":
        return { type: "text", text: stripLeakedThinkingTags(block.text) };
      case "toolCall": {
        const toolUse: ToolUseBlock = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        };
        return toolUse;
      }
      case "thinking": {
        const thinking: ThinkingBlock = {
          type: "thinking",
          thinking: block.thinking,
          thinkingSignature: block.thinkingSignature,
          redacted: block.redacted,
        };
        return thinking;
      }
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
