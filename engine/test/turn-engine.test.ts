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
import { runTurn, buildModelSetup } from "../src/engine/turn.js";
import { startMock, textTurn, toolTurn, textThenToolTurn, type MockServer, type SseEvent } from "./mock-anthropic.js";
import type { DomainEvent } from "../src/domain.js";
import type { ToolContext } from "../src/tools/registry.js";

// This suite's tests are about budget/text/tool-call plumbing, not repo
// permissions (Task 8 owns that — see chat-tools-integration.test.ts) —
// every call site here just needs SOME valid ctx to satisfy RunTurnDeps'
// now-required `ctx` field.
const EMPTY_CTX: ToolContext = { allowedRepoPaths: [], unsyncedRepoNames: [], userId: null };

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

describe("buildModelSetup", () => {
  it("declares image input support (QA-reported: stale \"text\"-only declaration made pi-ai silently drop every uploaded image — verified live against DashScope that qwen3.7-plus genuinely understands images via the Anthropic-compatible endpoint)", () => {
    const { model } = buildModelSetup(testSettings());
    expect(model.input).toContain("image");
    expect(model.input).toContain("text");
  });
});

describe("runTurn — turn engine (Task 4)", () => {
  it("1. 纯文本回合：text_delta* → llm_metrics → done{success:true}（Phase-1 golden 复用）", async () => {
    const mock = startMock([textTurn("你好")]);
    const settings = testSettings({ baseUrl: mock.url });
    const events = await collect(
      runTurn({ settings, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "hi" }),
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
      { settings, tools: [calculatorTool], ctx: EMPTY_CTX },
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
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
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
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
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
      runTurn({ settings, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "hi" }),
    );
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect((events[0].data as { message: string }).message).toMatch(/^LLM API error: /);
    expect(events[1].data).toEqual({ text: "", success: false, budgetExhausted: false });
    await mock.close();
  });

  it("7. promptCache:'off' -> 请求体不含任何 cache_control；默认（'auto'）-> 请求体含 cache_control（GATE 的 0A S4：DashScope 缓存真实生效，cacheRead=4005，默认保持开启）", async () => {
    const mockOff = startMock([textTurn("ok")]);
    const settingsOff = testSettings({ baseUrl: mockOff.url, promptCache: "off" });
    await collect(runTurn({ settings: settingsOff, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "hi" }));
    expect(JSON.stringify(mockOff.requests[0]?.body)).not.toContain("cache_control");
    await mockOff.close();

    const mockDefault = startMock([textTurn("ok")]);
    const settingsDefault = testSettings({ baseUrl: mockDefault.url }); // promptCache defaults to "auto"
    await collect(
      runTurn({ settings: settingsDefault, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "hi" }),
    );
    expect(JSON.stringify(mockDefault.requests[0]?.body)).toContain("cache_control");
    await mockDefault.close();
  });

  it("8. promptCache:'off' 同样作用于 wrap-up 的单独 streamSimple 调用（不止 Agent 循环调用）", async () => {
    const turns = exhaustingTurns();
    const mock = startMock(turns);
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8, promptCache: "off" });
    await collect(
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
    );
    // request[8] is the wrap-up call (see test 4/6's numbering).
    expect(JSON.stringify(mock.requests[8]?.body)).not.toContain("cache_control");
    await mock.close();
  });

  // Codex full-repo review (2026-07-14, Warning): the wrap-up call
  // (runWrapup) bypasses the Agent entirely, so agent.abort() in runTurn's
  // finally — the mechanism a client disconnect relies on to cancel the
  // Agent's own in-flight LLM call — used to be a no-op for THIS call: by
  // the time wrap-up starts, the Agent has already torn down its own
  // AbortController in its own finally. Without a signal of its own, a
  // disconnect during wrap-up left the upstream fetch running to
  // completion in the background, wasting real API cost for a response
  // nothing was left consuming. Proven end-to-end against a REAL mock HTTP
  // server (not a stubbed engine) — delays exactly the wrap-up request so
  // there's a genuine window to abort mid-flight, then checks the mock
  // observed the underlying TCP connection actually torn down, not merely
  // "the consumer stopped reading an already-complete response."
  it("9. client 断连发生在 wrap-up 请求进行中 -> wrap-up 自己的上游请求也被真正取消，不是只停止消费", async () => {
    const turns = exhaustingTurns();
    // Long delay relative to the poll/assert windows below — gives a wide,
    // unambiguous margin for "genuinely still in flight" rather than a
    // coincidence of timing.
    const mock = startMock(turns, { delayRequestIndex: 8, delayMs: 5000 });
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const gen = runTurn(
      { settings, tools: [calculatorTool], ctx: EMPTY_CTX },
      { sessionId: "s1", history: [], userText: "查" },
    );

    // makeChannel's put() is non-blocking (plain array push, no
    // backpressure — see turn.ts) — the Agent's own tool loop and the
    // eventual wrap-up call are driven entirely by real HTTP round-trips
    // to the mock, independent of whether this test is consuming events.
    // A single .next() call is enough to kick off runTurn's (lazy) async
    // generator body; after that, polling mock.requests.length directly
    // (NOT via more .next() calls, which would block waiting for the next
    // channel item — i.e. until the delayed wrap-up response actually
    // starts arriving, defeating the point of aborting mid-flight) lets
    // this test observe "the wrap-up request has been sent" well before
    // its artificially delayed response would ever arrive.
    void gen.next();

    const start = Date.now();
    while (mock.requests.length < 9 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Reached with ~4.5s+ still left on the mock's 5s delay — genuinely
    // mid-flight, not a race against the response arriving.
    expect(mock.requests.length).toBe(9);

    // Simulate sse.ts's raceAbort calling engineIter.return() on client
    // disconnect, mid-wrap-up.
    const returnStart = Date.now();
    await gen.return(undefined);
    const returnElapsed = Date.now() - returnStart;

    // Resolved promptly — nowhere near the mock's 5s artificial delay —
    // proving the wrap-up's own fetch was actually aborted rather than
    // awaited to completion in the background.
    expect(returnElapsed).toBeLessThan(2000);
    expect(mock.abortedRequestIndexes).toContain(8);

    await mock.close();
  });

  it("6. 每 turn 新 Agent：连续两次 runTurn，第二次的请求体只来自入参 history（无第一 turn 残留）", async () => {
    const mock: MockServer = startMock([textTurn("第一轮回复"), textTurn("第二轮回复")]);
    const settings = testSettings({ baseUrl: mock.url });
    await collect(runTurn({ settings, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "第一轮问题" }));
    // Turn 2 also gets an EMPTY history argument — if runTurn cached/reused
    // an Agent (or any module-level state) across calls, turn 1's Q&A would
    // still leak onto the wire here even though nothing was passed for it.
    await collect(runTurn({ settings, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "第二轮问题" }));
    expect(mock.requests.length).toBe(2);
    const secondBody = JSON.stringify(mock.requests[1]?.body);
    expect(secondBody).not.toContain("第一轮问题");
    expect(secondBody).not.toContain("第一轮回复");
    expect(secondBody).toContain("第二轮问题");
    await mock.close();
  });
});

// QA-reported (2026-07-13): sessions no longer force-resolve after an issue
// action, so a user can say "close it" without repeating the issue number —
// but only if the model is actually told which issue(s) this session has
// already touched. Fed in per-turn via req.linkedIssues, injected through
// the same transformContext hook the budget reminder already uses.
describe("runTurn — linkedIssues 上下文注入", () => {
  it("非空 linkedIssues：首次 LLM 调用的请求体里带上 issue 编号和状态；第二次调用不重复注入", async () => {
    const mock = startMock([
      textThenToolTurn("查一下", "calculator", { expression: "1+1" }, "tu_1"),
      textTurn("答案是2"),
    ]);
    const settings = testSettings({ baseUrl: mock.url });
    await collect(
      runTurn(
        { settings, tools: [calculatorTool], ctx: EMPTY_CTX },
        {
          sessionId: "s1",
          history: [],
          userText: "关闭它",
          linkedIssues: [{ repoId: 3, issueNumber: 42, issueUrl: "https://gitlab.example.com/g/p/-/issues/42", status: "submitted" }],
        },
      ),
    );
    expect(mock.requests.length).toBe(2);
    const firstBody = JSON.stringify(mock.requests[0]?.body);
    expect(firstBody).toContain("#42");
    expect(firstBody).toContain("submitted");
    expect(firstBody).toContain("https://gitlab.example.com/g/p/-/issues/42");
    // Second call (after the tool result) must NOT repeat it — only the
    // first LLM call of the turn gets it.
    const secondBody = JSON.stringify(mock.requests[1]?.body);
    expect(secondBody).not.toContain("[系统提示] 本次会话已经提交/操作过以下 issue");
    await mock.close();
  });

  it("linkedIssues 为空/未传：不注入任何内容（回归保护，不影响现有无 issue 的普通对话）", async () => {
    const mock = startMock([textTurn("你好")]);
    const settings = testSettings({ baseUrl: mock.url });
    await collect(
      runTurn({ settings, tools: [], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "hi", linkedIssues: [] }),
    );
    const body = JSON.stringify(mock.requests[0]?.body);
    expect(body).not.toContain("[系统提示]");
    await mock.close();
  });

  it("同一次调用里 issue 上下文和 budget reminder 同时触发时，两段文本都在", async () => {
    const mock = startMock(exhaustingTurns());
    // maxToolIterations=6 -> MIDPOINT_CHECK fires at nextIteration===3, not 0,
    // so use a small budget where the FIRST call (nextIteration 0) is also
    // within the endgame window (remaining 1..3) by setting maxToolIterations
    // low enough that call 0 already sees remaining<=3.
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 2 });
    await collect(
      runTurn(
        { settings, tools: [calculatorTool], ctx: EMPTY_CTX },
        {
          sessionId: "s1",
          history: [],
          userText: "查",
          linkedIssues: [{ repoId: null, issueNumber: 7, issueUrl: null, status: "已处理（评论/关闭/重新打开）" }],
        },
      ),
    );
    const firstBody = JSON.stringify(mock.requests[0]?.body);
    expect(firstBody).toContain("#7");
    expect(firstBody).toContain("仅剩"); // endgame reminder's own text
    await mock.close();
  });
});

// v1-python-final:app/agent.py::_WRAPUP_FALLBACK, verbatim (byte-verified
// against the tagged source via the same extraction script as the other
// reminder strings — 180 bytes). Deliberately HARDCODED here rather than
// imported from turn.ts: importing would make the assertion circular (a
// typo in the production constant would pass its own echo).
const WRAPUP_FALLBACK =
  "本轮工具调用预算已用尽，且未能生成阶段性汇报。" +
  "上面的工具调用记录包含了已经查到的信息，可点击「继续调查」在此基础上继续。";

/** A scripted assistant turn that completes normally but streams NO text at
 * all (no content blocks) — the Node twin of v1's `text_turn([])`, which is
 * what test_wrapup_falls_back_when_first_attempt_streams_no_text drives:
 * "completes successfully yet produces zero text" is NOT the error path. */
function emptyTextTurn(): SseEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [],
        model: "mock",
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
}

describe("runTurn — wrap-up v1 parity（review fix：fallback 文本、metrics 行、1200 token 上限）", () => {
  it("wrap-up 零文本 ⇒ _WRAPUP_FALLBACK 逐字：单条 text_delta + done.text 都是 fallback（v1 test_wrapup_falls_back_when_first_attempt_streams_no_text）", async () => {
    const turns = exhaustingTurns();
    turns[8] = emptyTextTurn(); // wrap-up completes normally, streams no text
    const mock = startMock(turns);
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const events = await collect(
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
    );
    expect(mock.requests.length).toBe(9); // no retry — the attempt didn't fail
    const textDeltas = events
      .filter((e): e is Extract<DomainEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.data.text);
    expect(textDeltas).toEqual([WRAPUP_FALLBACK]); // only the fallback was emitted, as ONE delta
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.data).toEqual({ text: WRAPUP_FALLBACK, success: true, budgetExhausted: true });
    await mock.close();
  });

  // Codex full-repo review (2026-07-14, Warning): runWrapup bypasses the
  // Agent/event-adapter.ts entirely (see the file header's design note),
  // so it never went through piAssistantToDomain's stripLeakedThinkingTags
  // — the DashScope/Qwen reasoning-leak defense (FLOW-002) every normal
  // tool-loop turn's final text gets. Worse than the sse.ts-level gap:
  // for a wrap-up turn this meant even the PERSISTED text (not just what
  // streamed live) carried the leaked span. Proven against a real mock
  // response containing an orphan `</thinking>` close tag (the actually-
  // observed production shape, per codec-pi.ts's own doc comment) in the
  // wrap-up's text.
  it("wrap-up 文本里的泄漏 <thinking> 残留同样被 stripLeakedThinkingTags 清洗（不只是循环调用的最终文本）", async () => {
    const turns = exhaustingTurns();
    turns[8] = textTurn("Now I have enough info to answer.</thinking>真正的阶段性汇报");
    const mock = startMock(turns);
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const events = await collect(
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
    );
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.data).toEqual({ text: "真正的阶段性汇报", success: true, budgetExhausted: true });
    await mock.close();
  });

  it("wrap-up 有自己的 llm_metrics 行：共 maxToolIterations+1 条，末条 iteration === maxToolIterations（v1 的 numbering），usage 来自 wrap-up 响应", async () => {
    const mock = startMock(exhaustingTurns());
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    const events = await collect(
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
    );
    const metrics = events.filter(
      (e): e is Extract<DomainEvent, { type: "llm_metrics" }> => e.type === "llm_metrics",
    );
    expect(metrics.length).toBe(9); // 8 loop calls + 1 wrap-up
    // Loop metrics keep the adapter's 0..7; the wrap-up row continues at
    // exactly settings.max_tool_iterations — v1's literal
    // `"iteration": settings.max_tool_iterations` in the wrap-up yield.
    expect(metrics.map((m) => m.data.iteration)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const wrap = metrics.at(-1)!.data;
    expect(wrap.model).toBe("mock");
    expect(wrap.inputTokens).toBe(10); // mock's message_start usage
    expect(wrap.outputTokens).toBe(5); // mock's message_delta usage
    expect(typeof wrap.totalMs).toBe("number");
    expect(typeof wrap.ttftMs).toBe("number"); // text streamed ⇒ measured, adapter-style
    // v1 event order around the wrap-up: …text_delta → llm_metrics → done
    // (metrics is yielded right after the stream ends, before done).
    expect(events.slice(-3).map((e) => e.type)).toEqual(["text_delta", "llm_metrics", "done"]);
    await mock.close();
  });

  it("wrap-up 请求体 max_tokens === 1200（v1 _WRAPUP_MAX_TOKENS——收敛调用，不是又一轮调查窗口）；循环调用不受影响", async () => {
    const mock = startMock(exhaustingTurns());
    const settings = testSettings({ baseUrl: mock.url, maxToolIterations: 8 });
    await collect(
      runTurn({ settings, tools: [calculatorTool], ctx: EMPTY_CTX }, { sessionId: "s1", history: [], userText: "查" }),
    );
    const loopBody = mock.requests[0]?.body as { max_tokens?: number };
    const wrapBody = mock.requests[8]?.body as { max_tokens?: number };
    expect(loopBody.max_tokens).toBe(4096); // settings default rides the loop calls
    expect(wrapBody.max_tokens).toBe(1200); // _WRAPUP_MAX_TOKENS caps only the wrap-up
    await mock.close();
  });
});
