// Legacy JSON shapes (DB/old frontend raw dict) from tests/test_agent_events.py / test_message_codec.py
// Typed as plain arrays/objects to model untyped legacy JSON

export const legacyToolTurn: unknown[] = [
  { role: "user", content: "1+1=?" },
  { role: "assistant", content: [
    { type: "text", text: "算一下" },
    { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } } ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu_1", content: "2" } ] },
];

export const legacyImageMsg: unknown = { role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
  { type: "text", text: "看这个截图" } ] };

export const legacyUnicodeBlocks: unknown[] = [
  { type: "tool_use", id: "tu_1", name: "code_search", input: { keyword: "不合格评审" } } ];
