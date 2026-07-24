import { describe, it, expect } from "vitest";
import { isToolRelay, CodecError } from "../src/domain.js";
import { legacyToDomain, domainToLegacy, legacyListToDomain } from "../src/codec-legacy.js";
import { legacyToolTurn, legacyImageMsg, legacyFileMsg, legacyUnicodeBlocks } from "./fixtures.js";

describe("domain guards", () => {
  it("isToolRelay: true 仅当块数组中含 tool_result", () => {
    expect(isToolRelay({ role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "x", isError: false }] })).toBe(true);
    expect(isToolRelay({ role: "user", content: "纯文本" })).toBe(false);
    expect(isToolRelay({ role: "user", content: [{ type: "text", text: "x" }] })).toBe(false);
  });
});

describe("codec-legacy", () => {
  it("round-trip 是恒等（工具回合三连）", () => {
    for (const raw of legacyToolTurn)
      expect(domainToLegacy(legacyToDomain(raw))).toEqual(raw);
  });
  it("tool_result 缺省 is_error 补 false，回程省略", () => {
    const d = legacyToDomain(legacyToolTurn[2]);
    expect((d.content as any)[0].isError).toBe(false);
    expect(domainToLegacy(d)).toEqual(legacyToolTurn[2]);  // 回程不多出 is_error 字段
  });
  it("image 块字段换名双向", () => {
    const d = legacyToDomain(legacyImageMsg);
    expect((d.content as any)[0]).toEqual({ type: "image", mediaType: "image/png", base64Data: "AAA" });
    expect(domainToLegacy(d)).toEqual(legacyImageMsg);
  });
  it("file 块双向：source 换名 + extracted_text/truncated 保真，round-trip 恒等", () => {
    const d = legacyToDomain(legacyFileMsg);
    expect((d.content as any)[0]).toEqual({
      type: "file", filename: "orders.csv", mediaType: "text/csv", base64Data: "QUFB",
      extractedText: "订单号,数量\nA100,3", truncated: false,
    });
    expect(domainToLegacy(d)).toEqual(legacyFileMsg); // parse_error 未出现，回程也不多这个键
  });
  it("file 块 parse_error 存在时双向保真", () => {
    const raw = { role: "user", content: [
      { type: "file", filename: "broken.xlsx",
        source: { type: "base64", media_type: "application/octet-stream", data: "AAA" },
        extracted_text: "", truncated: false, parse_error: "已损坏" } ] };
    const d = legacyToDomain(raw);
    expect((d.content as any)[0].parseError).toBe("已损坏");
    expect(domainToLegacy(d)).toEqual(raw);
  });
  it("file 块缺 filename / source / extracted_text 时 fail-loud", () => {
    const bad = (block: unknown) => () => legacyToDomain({ role: "user", content: [block] });
    expect(bad({ type: "file", source: { type: "base64", media_type: "t", data: "A" }, extracted_text: "" })).toThrow(CodecError);
    expect(bad({ type: "file", filename: "a.txt", extracted_text: "" })).toThrow(CodecError);
    expect(bad({ type: "file", filename: "a.txt", source: { type: "base64", media_type: "t", data: "A" } })).toThrow(CodecError);
  });
  it("thinking 块字段换名双向（thinkingSignature ↔ thinking_signature）", () => {
    const raw = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "先算一下这两个数", thinking_signature: "sig_abc123" }],
    };
    const d = legacyToDomain(raw);
    expect((d.content as any)[0]).toEqual({
      type: "thinking",
      thinking: "先算一下这两个数",
      thinkingSignature: "sig_abc123",
    });
    expect(domainToLegacy(d)).toEqual(raw);
  });
  it("thinking 块 redacted:true + 空正文 + 有签名 → 双向保真", () => {
    const raw = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinking_signature: "redacted_opaque_blob", redacted: true }],
    };
    const d = legacyToDomain(raw);
    expect((d.content as any)[0]).toEqual({
      type: "thinking",
      thinking: "",
      thinkingSignature: "redacted_opaque_blob",
      redacted: true,
    });
    expect(domainToLegacy(d)).toEqual(raw);
  });
  it("thinking 块 thinking_signature/redacted 缺省时双向省略（同 is_error 惯例）", () => {
    const raw = { role: "assistant", content: [{ type: "thinking", thinking: "嗯" }] };
    const d = legacyToDomain(raw);
    expect((d.content as any)[0]).toEqual({ type: "thinking", thinking: "嗯" });
    expect(domainToLegacy(d)).toEqual(raw); // 回程不多出 thinking_signature/redacted 字段
  });
  it("thinking_signature 非字符串 throw CodecError (fail-loud)", () => {
    expect(() =>
      legacyToDomain({
        role: "assistant",
        content: [{ type: "thinking", thinking: "x", thinking_signature: 123 }],
      })
    ).toThrow(CodecError);
  });
  it("redacted 非布尔值 throw CodecError (fail-loud)", () => {
    expect(() =>
      legacyToDomain({ role: "assistant", content: [{ type: "thinking", thinking: "x", redacted: "yes" }] })
    ).toThrow(CodecError);
  });
  it("thinking 块缺少 'thinking' 字段 throw CodecError", () => {
    expect(() =>
      legacyToDomain({ role: "assistant", content: [{ type: "thinking" }] })
    ).toThrow(CodecError);
  });
  it("unicode 原样（不合格评审）", () => {
    const raw = { role: "assistant", content: legacyUnicodeBlocks };
    expect(domainToLegacy(legacyToDomain(raw))).toEqual(raw);
  });
  it("未知块类型 throw CodecError", () => {
    expect(() => legacyToDomain({ role: "user", content: [{ type: "banana" }] })).toThrow(CodecError);
  });
  it("is_error 非布尔值 throw CodecError (fail-loud)", () => {
    expect(() => legacyToDomain({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x", is_error: "yes" }] })).toThrow(CodecError);
  });
  it("tool_use input 为数组 throw CodecError", () => {
    expect(() => legacyToDomain({ role: "user", content: [{ type: "tool_use", id: "t", name: "foo", input: [1, 2] }] })).toThrow(CodecError);
  });
});
