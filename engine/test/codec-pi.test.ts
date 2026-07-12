import { describe, it, expect } from "vitest";
import { domainToPi, piAssistantToDomain } from "../src/codec-pi.js";
import { legacyListToDomain } from "../src/codec-legacy.js";
import { legacyToolTurn } from "./fixtures.js";
import { CodecError } from "../src/domain.js";

const OPTS = { model: "qwen3.7-plus", provider: "dashscope" };

describe("domainToPi（注③）", () => {
  it("B6 三段史：角色序列 user/assistant/toolResult，id 与结构保真", () => {
    const pi = domainToPi(legacyListToDomain(legacyToolTurn), OPTS);
    expect(pi.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
    const asst = pi[1] as any;
    expect(asst.content).toEqual([
      { type: "text", text: "算一下" },
      { type: "toolCall", id: "tu_1", name: "calculator", arguments: { expression: "1+1" } }]);
    expect(asst.stopReason).toBe("toolUse");
    const tr = pi[2] as any;
    expect(tr.toolCallId).toBe("tu_1");
    expect(tr.toolName).toBe("calculator");     // ← 回填自 tu_1 的 tool_use 块
    expect(tr.isError).toBe(false);
  });
  it("toolName 回查不到 ⇒ CodecError", () => {
    const orphan = legacyListToDomain([{ role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_ghost", content: "x" }] }]);
    expect(() => domainToPi(orphan, OPTS)).toThrow(CodecError);
  });
  it("timestamp 单调递增", () => {
    const pi = domainToPi(legacyListToDomain(legacyToolTurn), OPTS) as any[];
    for (let i = 1; i < pi.length; i++) expect(pi[i].timestamp).toBeGreaterThanOrEqual(pi[i-1].timestamp);
  });
  it("tool_result 后的尾随 text 块 → 独立尾随 user 消息（D1 形状）", () => {
    const withReminder = legacyListToDomain([
      legacyToolTurn[1],
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "2" },
        { type: "text", text: "本轮调查已过半" } ] }]);
    const pi = domainToPi(withReminder, OPTS);
    expect(pi.map(m => m.role)).toEqual(["assistant", "toolResult", "user"]);
  });
  it("text 块出现在 tool_result 之前 → CodecError（不静默重排，legacy 从不产生这种形状）", () => {
    const textFirst = legacyListToDomain([
      legacyToolTurn[1],
      { role: "user", content: [
        { type: "text", text: "本轮调查已过半" },
        { type: "tool_result", tool_use_id: "tu_1", content: "2" } ] }]);
    expect(() => domainToPi(textFirst, OPTS)).toThrow(CodecError);
  });
  it("image 块 → CodecError（Phase-1 限制）", () => {
    const withImage = legacyListToDomain([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } } ] }]);
    expect(() => domainToPi(withImage, OPTS)).toThrow(CodecError);
  });
});

describe("piAssistantToDomain", () => {
  it("text+toolCall → domain assistant 块，usage/stopReason 提取", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "text", text: "算一下" },
                { type: "toolCall", id: "tu_1", name: "calculator", arguments: { expression: "1+1" } }],
      usage: { input: 10, output: 5 } as any, stopReason: "toolUse", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "text", text: "算一下" },
      { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } }] });
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(out.stopReason).toBe("toolUse");
  });
});
