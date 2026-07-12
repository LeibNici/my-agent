// Task 6 — golden-sequence tests for the pi AgentEvent -> DomainEvent
// adapter. Fully offline: a REAL pi Agent driven against the local mock
// Anthropic server (test/mock-anthropic.ts). Oracle = the three golden event
// sequences in tests/test_agent_events.py (Python characterization tests).
//
// Agent assembly + the runTurnThroughAdapter driver live in
// test/agent-harness.ts (extracted here, Task 7 reuses it for the
// end-to-end integration test rather than duplicating this wiring).
import { describe, it, expect } from "vitest";
import { startMock, textTurn, textThenToolTurn } from "./mock-anthropic.js";
import { runTurnThroughAdapter, makeCalculatorTool } from "./agent-harness.js";

describe("event-adapter — golden sequences from test_agent_events.py", () => {
  it("纯文本回合：text_delta* → llm_metrics → done（test_text_only_turn_sequence）", async () => {
    const mock = startMock([textTurn("你好")]);
    const events = await runTurnThroughAdapter(mock, "hi");
    expect(events.map((e) => e.type)).toEqual(["text_delta", "llm_metrics", "done"]);
    expect(events.at(-1)!.data).toMatchObject({ text: "你好", success: true, budgetExhausted: false });
    await mock.close();
  });

  it("工具回合：text_delta → llm_metrics → tool_use → tool_result → tool_exchange → … → done（test_tool_round_sequence）", async () => {
    const mock = startMock([
      textThenToolTurn("算一下", "calculator", { expression: "1+1" }, "tu_1"),
      textTurn("答案是2"),
    ]);
    const events = await runTurnThroughAdapter(mock, "1+1=?", { tools: [makeCalculatorTool()] });
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "llm_metrics",
      "tool_use",
      "tool_result",
      "tool_exchange",
      "text_delta",
      "llm_metrics",
      "done",
    ]);
    const toolUse = events.find((e) => e.type === "tool_use")!.data as any;
    expect(toolUse).toEqual({ id: "tu_1", name: "calculator", input: { expression: "1+1" } });
    const toolResult = events.find((e) => e.type === "tool_result")!.data as any;
    expect(toolResult.id).toBe("tu_1");
    expect(toolResult.result).toContain("2");
    const ex = events.find((e) => e.type === "tool_exchange")!.data as any;
    expect(ex.assistant[0]).toEqual({ type: "text", text: "算一下" });
    expect(ex.assistant[1].id).toBe("tu_1");
    expect(ex.results[0].toolUseId).toBe("tu_1");
    await mock.close();
  });

  it("LLM 报错：error → done(success:false)（test_llm_error_yields_error_then_unsuccessful_done）", async () => {
    const mock = startMock([]); // 空脚本 ⇒ mock 返 500（见 mock-anthropic.ts 的 Task 6 补丁）
    const events = await runTurnThroughAdapter(mock, "hi");
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect((events[0].data as any).message).toMatch(/^LLM API error: /);
    expect((events[1].data as any).success).toBe(false);
    expect((events[1].data as any).budgetExhausted).toBe(false);
    await mock.close();
  });
});
