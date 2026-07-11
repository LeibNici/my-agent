import { describe, it, expect } from "vitest";
import { isToolRelay, CodecError } from "../src/domain.js";
import { legacyToDomain, domainToLegacy, legacyListToDomain } from "../src/codec-legacy.js";
import { legacyToolTurn, legacyImageMsg, legacyUnicodeBlocks } from "./fixtures.js";

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
