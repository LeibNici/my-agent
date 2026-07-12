// Task 4 — runTurn: the per-turn ephemeral pi-Agent assembler. Six pinned
// semantics (task-4-brief.md's checklist, each = one test), oracle =
// `git show v1-python-final:app/agent.py` (_budget_reminder/_WRAPUP_PROMPT)
// and `git show v1-python-final:tests/test_agent_budget.py` (call-index
// arithmetic) for items 3/4; Phase-1 goldens (test_agent_events.py) reused
// for items 1/2/5 via the same mock-anthropic.ts rig agent-harness.ts uses.
//
// Fully offline: startMock scripts every LLM response, mock.requests[] is
// the oracle for "how many actual calls were made" and "what did call N's
// body contain".
import { describe, it, expect } from "vitest";
import { loadSettings, type Settings } from "../src/config.js";
import { calculatorTool } from "../src/tools/calculator.js";
import { runTurn } from "../src/engine/turn.js";
import { startMock, textTurn, toolTurn, textThenToolTurn, type MockServer } from "./mock-anthropic.js";
import type { DomainEvent } from "../src/domain.js";

// loadSettings({}) yields every field at its documented default (no env,
// no dotenv read — see config.test.ts) — cheapest way to get a fully-typed
// Settings object, then override just what a given test cares about
// (baseUrl -> mock.url is the one every test needs).
function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...loadSettings({}), apiKey: "sk-mock-offline-not-a-real-key", model: "mock", ...overrides };
}

async function collect(gen: AsyncGenerator<DomainEvent>): Promise<DomainEvent[]> {
  const out: DomainEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// 8 tool-call turns (burn the whole budget) + 1 wrap-up text turn — the same
// shape as v1's tests/test_agent_budget.py::_exhausting_turns().
function exhaustingTurns() {
  const turns = Array.from({ length: 8 }, (_, i) => toolTurn("calculator", { expression: `${i}+1` }, `tu_${i}`));
  turns.push(textTurn("阶段性汇报"));
  return turns;
}

describe("runTurn — turn engine (Task 4)", () => {
  it("1. 纯文本回合：text_delta* → llm_metrics → done{success:true}（Phase-1 golden 复用）", async () => {
    const mock = startMock([textTurn("你好")]);
    const settings = testSettings({ baseUrl: mock.url });
    const events = await collect(
      runTurn({ settings, tools: [] }, { sessionId: "s1", history: [], userText: "hi" }),
    );
    expect(events.map((e) => e.type)).toEqual(["text_delta", "llm_metrics", "done"]);
    expect(events.at(-1)!.data).toMatchObject({ text: "你好", success: true, budgetExhausted: false });
    await mock.close();
  });

  it("2. 工具回合：… tool_use → tool_result → tool_exchange → … → done；tool_exchange 产出时即刻可持久化（顺序断言）", async () => {
    const mock = startMock([
      textThenToolTurn("算一下", "calculator", { expression: "1+1" }, "tu_1"),
      textTurn("答案是2"),
    ]);
    const settings = testSettings({ baseUrl: mock.url });
    const events: DomainEvent[] = [];
    let requestsSeenAtExchange = -1;
    for await (const e of runTurn(
      { settings, tools: [calculatorTool] },
      { sessionId: "s1", history: [], userText: "1+1=?" },
    )) {
      events.push(e);
      // Captured the INSTANT tool_exchange is yielded — if runTurn buffered
      // the whole turn before yielding anything, the 2nd LLM call would
      // already have happened by now and this would read 2, not 1.
      if (e.type === "tool_exchange") requestsSeenAtExchange = mock.requests.length;
    }
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
    expect(requestsSeenAtExchange).toBe(1);
    expect(events.at(-1)!.data).toMatchObject({ success: true, budgetExhausted: false });
    await mock.close();
  });

  it("3. budget midpoint：maxToolIterations=8 时第 5 次 LLM 调用（0-based 索引 4）的请求体含 reminder 原文；不落库", async () => {
    const mock = startMock(exhaustingTurns());
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const events = await collect(
      runTurn({ settings, tools: [calculatorTool] }, { sessionId: "s1", history: [], userText: "查" }),
    );
    const call3 = JSON.stringify(mock.requests[3]?.body);
    const call4 = JSON.stringify(mock.requests[4]?.body);
    expect(call3).not.toContain("本轮调查已过半");
    expect(call4).toContain("本轮调查已过半");
    // agent state stays clean: the reminder never rides along in anything
    // that would get persisted (v1's test_reminders_never_appear_in_persisted_exchanges).
    for (const e of events) {
      if (e.type === "tool_exchange") {
        const persisted = JSON.stringify(e.data);
        expect(persisted).not.toContain("本轮调查已过半");
        expect(persisted).not.toContain("仅剩");
      }
    }
    await mock.close();
  });

  it("4. budget 耗尽 + wrap-up：达 8 次后 afterToolCall terminate；单独 wrap-up 调用无 tools 字段；done.budgetExhausted===true", async () => {
    const mock = startMock(exhaustingTurns());
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const events = await collect(
      runTurn({ settings, tools: [calculatorTool] }, { sessionId: "s1", history: [], userText: "查" }),
    );
    // mock.requests.length is the oracle for "how many LLM calls happened":
    // 8 tool-loop calls (the budget) + 1 separate wrap-up call.
    expect(mock.requests.length).toBe(9);
    const wrapupBody = mock.requests[8]?.body as { tools?: unknown; messages?: unknown[] };
    expect(wrapupBody.tools).toBeUndefined();
    expect(JSON.stringify(wrapupBody.messages)).toContain("本轮工具调用预算已用尽");
    const textDeltas = events
      .filter((e): e is Extract<DomainEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.data.text);
    expect(textDeltas.join("")).toBe("阶段性汇报"); // wrap-up text streamed via text_delta
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.data).toEqual({ text: "阶段性汇报", success: true, budgetExhausted: true });
    await mock.close();
  });

  it("5. LLM 错误：error → done{success:false}（errorMessage 检查模式照 harness）", async () => {
    const mock = startMock([]); // 空脚本 ⇒ mock 返 500
    const settings = testSettings({ baseUrl: mock.url });
    const events = await collect(
      runTurn({ settings, tools: [] }, { sessionId: "s1", history: [], userText: "hi" }),
    );
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect((events[0].data as { message: string }).message).toMatch(/^LLM API error: /);
    expect(events[1].data).toEqual({ text: "", success: false, budgetExhausted: false });
    await mock.close();
  });

  it("6. 每 turn 新 Agent：连续两次 runTurn，第二次的请求体只来自入参 history（无第一 turn 残留）", async () => {
    const mock: MockServer = startMock([textTurn("第一轮回复"), textTurn("第二轮回复")]);
    const settings = testSettings({ baseUrl: mock.url });
    await collect(runTurn({ settings, tools: [] }, { sessionId: "s1", history: [], userText: "第一轮问题" }));
    // Turn 2 also gets an EMPTY history argument — if runTurn cached/reused
    // an Agent (or any module-level state) across calls, turn 1's Q&A would
    // still leak onto the wire here even though nothing was passed for it.
    await collect(runTurn({ settings, tools: [] }, { sessionId: "s1", history: [], userText: "第二轮问题" }));
    expect(mock.requests.length).toBe(2);
    const secondBody = JSON.stringify(mock.requests[1]?.body);
    expect(secondBody).not.toContain("第一轮问题");
    expect(secondBody).not.toContain("第一轮回复");
    expect(secondBody).toContain("第二轮问题");
    await mock.close();
  });
});
