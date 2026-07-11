// Task 7 — one end-to-end test that walks the entire anticorruption
// pipeline in a single path, exactly as production will chain it per turn:
//
//   legacy JSON history (DB rows)
//     -> legacyListToDomain          (src/codec-legacy.ts)
//     -> prepareModelMessages         (src/history-policy.ts)
//     -> domainToPi                   (src/codec-pi.ts)
//     -> real pi Agent, offline mock  (test/agent-harness.ts, Task 6's rig)
//     -> createEventAdapter           (src/event-adapter.ts)
//     -> domain events
//     -> domainToLegacy on the tool_exchange block (src/codec-legacy.ts)
//        -> a persistable legacy exchange, golden-shape-checked
//
// Reuses the Task 6 harness (test/agent-harness.ts) rather than re-deriving
// the Agent-assembly boilerplate — see that file's header for the pattern
// (scenarios.ts B1) and event-adapter.ts's header for the
// agent.state.errorMessage -> fail()/finish() error-division-of-labor this
// harness already encodes.
import { describe, it, expect } from "vitest";
import { legacyListToDomain, domainToLegacy } from "../src/codec-legacy.js";
import { prepareModelMessages } from "../src/history-policy.js";
import { domainToPi } from "../src/codec-pi.js";
import type { DomainBlock, ToolResultBlock } from "../src/domain.js";
import { startMock, textTurn, textThenToolTurn } from "./mock-anthropic.js";
import { runTurnThroughAdapter, makeCalculatorTool } from "./agent-harness.js";

describe("integration: legacy 史 → historyPolicy → codec → pi Agent(mock) → adapter → 可持久化 legacy 交换", () => {
  it("穿全管道的一条路径", async () => {
    // Two prior legacy tool rounds (variants of the legacyToolTurn shape,
    // different ids/tools so the two rounds are distinguishable) plus the
    // just-persisted current-turn question — mirrors app/main.py's DB order:
    // the new user message is appended to history BEFORE the model is asked.
    const legacyHistory: unknown[] = [
      { role: "user", content: "1+1=?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "算一下" },
          { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "2" }] },
      { role: "user", content: "帮我查一下不合格评审逻辑" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我查一下" },
          { type: "tool_use", id: "tu_2", name: "code_search", input: { keyword: "不合格评审" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "找到 3 处" }] },
      { role: "user", content: "当前问题" },
    ];

    const domain = legacyListToDomain(legacyHistory);
    const shaped = prepareModelMessages(domain, 6);
    const piMsgs = domainToPi(shaped, { model: "qwen3.7-plus", provider: "dashscope" });

    const mock = startMock([
      textThenToolTurn("查", "calculator", { expression: "1+1" }, "tu_9"),
      textTurn("完"),
    ]);
    // NOTE: the prompt text ("当前问题") deliberately repeats the last
    // history message's text — pi's own prompt() call adds it as a NEW
    // trailing user message on top of the injected history (which already
    // ends on that same current-turn question, per the DB-order note
    // above). The wire ends up with two consecutive user messages, which
    // is exactly the double-user shape spikes/pi-provider/REPORT-phase1.md's
    // E1 verified DashScope accepts (GATE.md risk-1 open question, now
    // closed) — harmless here since assertion ③ only checks the FIRST
    // message's role.
    const events = await runTurnThroughAdapter(mock, "当前问题", {
      initialMessages: piMsgs,
      tools: [makeCalculatorTool()],
    });

    // ① 事件序列含完整 tool 回合（text_delta → llm_metrics → tool_use →
    //    tool_result → tool_exchange → text_delta → llm_metrics → done）
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

    // ② tool_exchange 的块经 domainToLegacy 后与 legacy golden 形状逐字相等
    //    （tool_use_id/is_error 拼写复原；is_error 缺省 false 时整段省略）
    const ex = events.find((e) => e.type === "tool_exchange")!.data as {
      assistant: DomainBlock[];
      results: ToolResultBlock[];
    };
    const legacyAssistantExchange = domainToLegacy({ role: "assistant", content: ex.assistant });
    const legacyResultExchange = domainToLegacy({ role: "user", content: ex.results });
    expect(legacyAssistantExchange).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "查" },
        { type: "tool_use", id: "tu_9", name: "calculator", input: { expression: "1+1" } },
      ],
    });
    expect(legacyResultExchange).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_9", content: "1+1 = 2" }],
    });

    // ③ 发到线上的第一条消息是 user —— history policy 的
    //    never-opens-on-assistant 穿透到了真正发出的请求体
    const wireMessages =
      ((mock.requests[0]?.body as { messages?: Array<{ role: string }> })?.messages) ?? [];
    expect(wireMessages[0]?.role).toBe("user");

    await mock.close();
  });
});
