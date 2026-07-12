import { describe, it, expect } from "vitest";
import { pythonJsonDumps, pyLocalIsoNow, PyFloat } from "../src/db/py-compat.js";

describe("pythonJsonDumps（json.dumps ensure_ascii=False 字节对齐）", () => {
  it("分隔符带空格 + unicode 原样", () => {
    expect(pythonJsonDumps([{ type: "tool_use", id: "tu_1", name: "code_search",
      input: { keyword: "不合格评审" } }]))
      .toBe('[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]');
  });
  it("字符串转义与 Python 一致", () => {
    expect(pythonJsonDumps([{ type: "text", text: 'a"b\\c\n中' }]))
      .toBe('[{"type": "text", "text": "a\\"b\\\\c\\n中"}]');
  });
  it("布尔/null/数字", () => {
    expect(pythonJsonDumps([{ n: 1.5, i: 2, z: null, b: true }]))
      .toBe('[{"n": 1.5, "i": 2, "z": null, "b": true}]');
    expect(pythonJsonDumps([{ type: "tool_result", tool_use_id: "tu_1", content: "", is_error: false }]))
      .toBe('[{"type": "tool_result", "tool_use_id": "tu_1", "content": "", "is_error": false}]');
  });
  it("非有限数抛错（Python 会产出非法 JSON 的 NaN/Infinity，禁止进库）", () => {
    expect(() => pythonJsonDumps([{ x: NaN }])).toThrow();
  });
});

// Phase 4b Task 4 self-review fix: semantic_search's resultsJson embeds a
// rounded cosine score (a Python float that's frequently whole-valued —
// e.g. two axis-aligned unit vectors -> exactly 1.0). Plain JS numbers have
// no separate int/float type, so the generic number branch above can't
// distinguish "this is conceptually a float" from "this is conceptually an
// int" — PyFloat is the opt-in marker for the former.
describe("PyFloat（Python float 的 json.dumps 渲染：整数值也带 .0）", () => {
  it("整数值的 float 仍带 .0", () => {
    expect(pythonJsonDumps(new PyFloat(1))).toBe("1.0");
    expect(pythonJsonDumps(new PyFloat(0))).toBe("0.0");
    expect(pythonJsonDumps(new PyFloat(-1))).toBe("-1.0");
  });
  it("非整数值原样渲染（本就带小数点）", () => {
    expect(pythonJsonDumps(new PyFloat(0.856))).toBe("0.856");
    expect(pythonJsonDumps(new PyFloat(-0.6))).toBe("-0.6");
  });
  it("负零渲染为 -0.0，而不是和正零一样的 0.0（Python repr(-0.0) == '-0.0'）", () => {
    expect(pythonJsonDumps(new PyFloat(-0))).toBe("-0.0");
    expect(pythonJsonDumps(new PyFloat(0))).toBe("0.0");
  });
  it("嵌套在对象/数组里同样生效，与普通 int 字段区分开", () => {
    expect(pythonJsonDumps([{ start: 1, end: 2, score: new PyFloat(1) }]))
      .toBe('[{"start": 1, "end": 2, "score": 1.0}]');
  });
  it("非有限数在构造时就抛错，而不是延迟到序列化", () => {
    expect(() => new PyFloat(NaN)).toThrow();
    expect(() => new PyFloat(Infinity)).toThrow();
  });
});

describe("pyLocalIsoNow（datetime.now().isoformat() 对齐）", () => {
  it("格式：本地时间、无 Z、6 位微秒", () => {
    expect(pyLocalIsoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
  it("确定性：给定 Date 产出给定字符串（毫秒 328 → 328000）", () => {
    expect(pyLocalIsoNow(new Date(2026, 6, 11, 23, 24, 52, 328)))
      .toBe("2026-07-11T23:24:52.328000");
  });
  it("禁 toISOString 语义：结果不含 Z、不含时区偏移", () => {
    expect(pyLocalIsoNow()).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);
  });
});
