// Domain DTO layer — the only types exposed outside codec-pi/event-adapter
// Three-layer isolation per Codex constraint

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mediaType: string; base64Data: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: string; isError: boolean };
export type DomainBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export type DomainMessage = { role: "user" | "assistant"; content: string | DomainBlock[] };

export type DomainEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "llm_metrics"; data: { iteration: number; model: string; inputTokens: number;
      outputTokens: number; ttftMs: number | null; totalMs: number } }
  | { type: "tool_use"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; data: { id: string; result: string } }
  | { type: "tool_exchange"; data: { assistant: DomainBlock[]; results: ToolResultBlock[] } }
  | { type: "done"; data: { text: string; success: boolean } }
  | { type: "error"; data: { message: string } };

export class CodecError extends Error {}

/**
 * Guard: returns true iff content is a block array containing at least one tool_result block
 */
export function isToolRelay(m: DomainMessage): boolean {
  if (typeof m.content === "string") {
    return false;
  }
  return Array.isArray(m.content) && m.content.some(
    (block): block is ToolResultBlock => block.type === "tool_result"
  );
}
