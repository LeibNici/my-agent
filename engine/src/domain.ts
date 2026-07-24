// Domain DTO layer — the only types exposed outside codec-pi/event-adapter
// Three-layer isolation per Codex constraint

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mediaType: string; base64Data: string };
// A non-image file attachment (2026-07-24). Unlike an image, the model never
// sees the raw bytes: `extractedText` (parsed server-side in attachments.ts)
// is what reaches the model / an issue body, while `base64Data` is kept only
// so the original can be replayed and downloaded. `parseError` (present iff
// parsing failed) makes a broken upload a first-class, non-blocking state —
// the file is still stored, the model/issue just learns it couldn't be read.
export type FileBlock = {
  type: "file";
  filename: string;
  mediaType: string;
  base64Data: string;
  extractedText: string;
  truncated: boolean;
  parseError?: string;
};
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: string; isError: boolean };
export type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type DomainBlock = TextBlock | ImageBlock | FileBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export type DomainMessage = { role: "user" | "assistant"; content: string | DomainBlock[] };

export type DomainEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "llm_metrics"; data: { iteration: number; model: string; inputTokens: number;
      outputTokens: number; ttftMs: number | null; totalMs: number } }
  | { type: "tool_use"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; data: { id: string; result: string } }
  | { type: "tool_exchange"; data: { assistant: DomainBlock[]; results: ToolResultBlock[] } }
  | { type: "done"; data: { text: string; success: boolean; budgetExhausted: boolean } }
  | { type: "error"; data: { message: string } };

export class CodecError extends Error {}

/**
 * Renders a FileBlock as the plain text the MODEL and an issue body see —
 * the one place that shaping lives, so codec-pi's history degrade, the
 * engine's current-turn prompt injection, and issue-body embedding all read
 * identically. A parse failure surfaces as a short note (not the raw bytes);
 * a successful parse shows the extracted text under a filename header, with a
 * truncation marker when it was cut. Never emits the base64 — that is for
 * download/replay only, never for the model.
 */
export function fileBlockToText(b: FileBlock): string {
  const header = `【附件：${b.filename}】`;
  if (b.parseError) return `${header}\n（该文件无法解析：${b.parseError}）`;
  const body = b.extractedText.trim() ? b.extractedText : "（文件为空或无可提取文本）";
  const suffix = b.truncated ? "\n…（内容过长，已截断）" : "";
  return `${header}\n${body}${suffix}`;
}

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
