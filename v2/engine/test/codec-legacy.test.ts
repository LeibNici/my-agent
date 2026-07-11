import { describe, it, expect } from "vitest";
import { isToolRelay } from "../src/domain.js";

describe("domain guards", () => {
  it("isToolRelay: true 仅当块数组中含 tool_result", () => {
    expect(isToolRelay({ role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "x", isError: false }] })).toBe(true);
    expect(isToolRelay({ role: "user", content: "纯文本" })).toBe(false);
    expect(isToolRelay({ role: "user", content: [{ type: "text", text: "x" }] })).toBe(false);
  });
});
