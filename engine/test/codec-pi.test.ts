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
  it("user 消息里的 image 块 → 转成 pi ImageContent（data/mimeType 改名，不是结构变化）", () => {
    const withImage = legacyListToDomain([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "看这个截图" } ] }]);
    const pi = domainToPi(withImage, OPTS);
    expect(pi).toEqual([{
      role: "user",
      content: [
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "text", text: "看这个截图" },
      ],
      timestamp: expect.any(Number),
    }]);
  });
  it("assistant 消息里的 image 块 → CodecError（pi-ai 的 AssistantMessage.content 类型上就不允许图片，不是 Phase-1 占位）", () => {
    const withImage = legacyListToDomain([
      { role: "assistant", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } } ] }]);
    expect(() => domainToPi(withImage, OPTS)).toThrow(CodecError);
  });
  it("thinking 块 + tool_use 同一 assistant 消息 → pi content 顺序原样保留（不重排）", () => {
    const withThinking = legacyListToDomain([{ role: "assistant", content: [
      { type: "thinking", thinking: "先想想", thinking_signature: "sig_1" },
      { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } } ] }]);
    const pi = domainToPi(withThinking, OPTS);
    const asst = pi[0] as any;
    expect(asst.content).toEqual([
      { type: "thinking", thinking: "先想想", thinkingSignature: "sig_1" },
      { type: "toolCall", id: "tu_1", name: "calculator", arguments: { expression: "1+1" } }]);
    expect(asst.stopReason).toBe("toolUse");
  });
  it("assistant 消息里单独的 thinking 块 → stopReason 仍为 stop", () => {
    const thinkingOnly = legacyListToDomain([{ role: "assistant", content: [
      { type: "thinking", thinking: "只是想了想，没工具调用" } ] }]);
    const pi = domainToPi(thinkingOnly, OPTS) as any[];
    expect(pi[0].stopReason).toBe("stop");
  });
  it("user 消息里的 thinking 块 → CodecError（结构上只属于 assistant）", () => {
    const badShape = legacyListToDomain([
      { role: "user", content: [{ type: "thinking", thinking: "不应该在这" }] }]);
    expect(() => domainToPi(badShape, OPTS)).toThrow(CodecError);
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
  it("thinking 块 → domain thinking 块（曾在此 throw CodecError，修复生产崩溃）", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [
        { type: "thinking", thinking: "先想想怎么算", thinkingSignature: "sig_xyz" },
        { type: "text", text: "答案是 2" } ],
      usage: { input: 10, output: 5 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "thinking", thinking: "先想想怎么算", thinkingSignature: "sig_xyz" },
      { type: "text", text: "答案是 2" } ] });
  });
  it("redacted thinking 块（空正文+签名）→ domain 块 redacted:true 原样保留", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque_redacted_blob", redacted: true }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "thinking", thinking: "", thinkingSignature: "opaque_redacted_blob", redacted: true } ] });
  });

  // FLOW-002 (2026-07-13 QA follow-up): DashScope's Anthropic-compatible
  // bridge for Qwen3.7-plus occasionally leaks residual thinking-tag text
  // into what pi-ai reports as a "text" block instead of "thinking".
  it("孤立的 </thinking> 闭合标签（无开标签，实测生产案例的真实形状）→ 标签及之前内容整体丢弃", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{
        type: "text",
        text: "Now I have enough information to write a comprehensive analysis. I should cite specific files.</thinking>Based on my investigation, the URL normalization...",
      }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "text", text: "Based on my investigation, the URL normalization..." } ] });
  });
  it("配对的 <thinking>...</thinking> → 整段丢弃，标签外的文本保留", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{
        type: "text",
        text: "前言。<thinking>这段是模型的内部推理，不应该出现</thinking>这才是真正的回答。",
      }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "text", text: "前言。这才是真正的回答。" } ] });
  });
  it("更短的 <think>/</think> 变体（Qwen 原生模板更常见的写法）→ 同样处理", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "text", text: "internal draft notes</think>the real answer" }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [{ type: "text", text: "the real answer" }] });
  });
  it("大小写不敏感（</THINKING> / </Think>）", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "text", text: "leaked reasoning</THINKING>the answer" }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [{ type: "text", text: "the answer" }] });
  });
  it("没有任何 thinking 标签的普通文本 → 原样不动（回归保护）", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "text", text: "普通回答，完全没有任何标签，也提到了 thinking 这个词。" }],
      usage: { input: 3, output: 0 } as any, stopReason: "stop", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "text", text: "普通回答，完全没有任何标签，也提到了 thinking 这个词。" } ] });
  });
});
