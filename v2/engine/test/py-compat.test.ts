import { describe, it, expect } from "vitest";
import { pythonJsonDumps, pyLocalIsoNow } from "../src/db/py-compat.js";

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
