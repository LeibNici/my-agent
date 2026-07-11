import { describe, it, expect } from "vitest";
import { prepareModelMessages, HISTORY_IMAGE_PLACEHOLDER } from "../src/history-policy.js";
import { legacyListToDomain } from "../src/codec-legacy.js";

const msg = (role: "user" | "assistant", content: any) => ({ role, content });
const toolHeavyTurn = (i: number) => [
  msg("user", `问题${i}`),
  msg("assistant", [{ type: "text", text: `我查一下${i}` },
    { type: "tool_use", id: `tu_${i}`, name: "code_search", input: { keyword: "x" } }]),
  msg("user", [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "..." }]),
  msg("assistant", `结论${i}`),
];
const D = (raws: any[]) => legacyListToDomain(raws);

describe("prepareModelMessages（test_history_windowing goldens 移植）", () => {
  it("未超限也替换 image 为占位", () => {
    const out = prepareModelMessages(D([
      msg("user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
                   { type: "text", text: "看这个截图" }]),
      msg("assistant", "看到了")]), 60);
    expect((out[0].content as any)[0]).toEqual({ type: "text", text: HISTORY_IMAGE_PLACEHOLDER });
    expect((out[0].content as any)[1]).toEqual({ type: "text", text: "看这个截图" });
    expect(out[1]).toEqual({ role: "assistant", content: "看到了" });
  });
  it("过去回合压缩、当前回合整体保留", () => {
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...toolHeavyTurn(2),
      msg("user", "当前问题"),
      msg("assistant", [{ type: "tool_use", id: "tu_c", name: "file_reader", input: { path: "a.py" } }]),
      msg("user", [{ type: "tool_result", tool_use_id: "tu_c", content: "..." }])]), 6);
    expect(out[out.length - 3]).toEqual({ role: "user", content: "当前问题" });
    const flat = JSON.stringify(out.slice(0, -3));
    expect(flat).not.toContain("tu_1"); expect(flat).not.toContain("tu_2");
    expect(out.slice(0, -3)).toContainEqual({ role: "user", content: "问题2" });
    expect(out[0].role).toBe("user");
  });
  it("limit=5 hand-traced：恰剩回合3压缩体+当前问题（区分压缩与朴素切片）", () => {
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...toolHeavyTurn(2), ...toolHeavyTurn(3),
      msg("user", "当前问题")]), 5);
    expect(out).toEqual(D([
      msg("user", "问题3"),
      msg("assistant", [{ type: "text", text: "我查一下3" }]),
      msg("assistant", "结论3"),
      msg("user", "当前问题")]));
  });
  it("当前回合独自超窗仍整体发送", () => {
    const current = [msg("user", "当前问题"),
      msg("assistant", [{ type: "tool_use", id: "tu_c", name: "file_reader", input: { path: "a.py" } }]),
      msg("user", [{ type: "tool_result", tool_use_id: "tu_c", content: "..." }])];
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...current]), 2);
    expect(out).toEqual(D(current));
    expect(out.length).toBe(3);
  });
  it("limit=0 关闭窗口化", () => {
    const history = Array.from({ length: 40 }, (_, i) => toolHeavyTurn(i)).flat();
    expect(prepareModelMessages(D(history), 0).length).toBe(history.length);
  });
});
