// Phase 0B control-plane capability matrix — B1..B6.
//
// Each scenario probes whether @earendil-works/pi-agent-core's high-level
// `Agent` class (and, where it can't, the low-level `agentLoop`) can reproduce
// a specific checkpoint semantic that the legacy Python agent (app/agent.py)
// relies on. The oracle for the budget/reminder semantics is
// tests/test_agent_budget.py. The instrument throughout is the mock server's
// `requests[N].body.messages` (what the model actually received on call N) and
// `requests[N].at` (wall-clock timestamps, for ordering/barrier proofs).
//
// Design rules honored here (from the brief):
//   - fully offline (mock only), a FRESH Agent per scenario (per-turn ephemeral
//     is the target architecture — never reuse an agent across scenarios),
//   - all tools sequential (match legacy),
//   - for B2/B3/B4, exercise BOTH the Agent class and the agentLoop export and
//     record them separately — "which layer can do this" is the core question.
//
// Run: `npx tsx src/scenarios.ts all` or `npx tsx src/scenarios.ts B3`.
import {
  Agent,
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { Type, type Static } from "typebox";
import {
  startMock,
  textTurn,
  textThenToolTurn,
  toolTurn,
  type MockServer,
} from "./mock-anthropic.js";

const DUMMY_API_KEY = "sk-mock-offline-not-a-real-key";

// Legacy-parallel reminder/wrap-up strings (verbatim from app/agent.py) so the
// evidence prints show the exact text the golden test (test_agent_budget.py)
// pins — "本轮调查已过半" (midpoint), "仅剩" (endgame), "预算已用尽" (wrap-up).
const MIDPOINT_REMINDER =
  "[系统提示] 本轮调查已过半。请先在心里核对：真正要回答的问题是什么？";
const WRAPUP_PROMPT =
  "[系统提示] 本轮工具调用预算已用尽，不要再调用任何工具。请直接用文字给出阶段性汇报。";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared offline setup: build a Models instance whose single provider points at
// the mock, plus the wrapped streamFn that keeps `this` bound to `models` (the
// this-binding trap documented in Task 9's report).
// ---------------------------------------------------------------------------
type Setup = { models: ReturnType<typeof createModels>; model: Model<"anthropic-messages">; streamFn: StreamFn };

function buildSetup(url: string): Setup {
  const models = createModels();
  const provider = createProvider({
    id: "mock",
    name: "Mock Anthropic (offline, Phase 0B)",
    auth: { apiKey: envApiKeyAuth("Mock", ["MOCK_ANTHROPIC_API_KEY"]) },
    api: anthropicMessagesApi(),
    models: [
      {
        id: "mock",
        name: "mock",
        api: "anthropic-messages",
        provider: "mock",
        baseUrl: url,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      },
    ],
  });
  models.setProvider(provider);
  const model = models.getModel("mock", "mock") as Model<"anthropic-messages"> | undefined;
  if (!model) throw new Error("mock/mock model not registered");
  // Wrap so streamSimple keeps its `this` bound to the models instance.
  const streamFn: StreamFn = (m, ctx, opts) => models.streamSimple(m, ctx, opts);
  return { models, model, streamFn };
}

// echo: a fake read-only tool that records its calls. Sequential (match legacy).
const EchoParams = Type.Object({ v: Type.String() });
function makeEchoTool(log: string[]): AgentTool {
  return {
    name: "echo",
    label: "Echo",
    description: "returns v",
    parameters: EchoParams,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const v = (params as Static<typeof EchoParams>).v;
      log.push(v);
      return { content: [{ type: "text", text: `echo:${v}` }], details: {} };
    },
  };
}

// The Agent-class default convertToLlm (pass LLM-shaped messages through). Also
// used for the low-level agentLoop, which — unlike the Agent class — has no
// built-in default and REQUIRES convertToLlm.
const passThroughConvert = (messages: AgentMessage[]): Message[] =>
  messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  ) as Message[];

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "PARTIAL";
type ScenarioResult = {
  name: string;
  verdict: Verdict;
  agent: Verdict | "n/a";
  loop: Verdict | "n/a";
  evidence: string[];
};

function ok(cond: boolean, msg: string, ev: string[]): boolean {
  ev.push(`${cond ? "✓" : "✗"} ${msg}`);
  return cond;
}

// A tiny "collect every request body's messages as a stringified blob" helper.
const bodyMessages = (mock: MockServer, i: number): unknown[] =>
  ((mock.requests[i]?.body as { messages?: unknown[] })?.messages ?? []) as unknown[];
const bodyHas = (mock: MockServer, i: number, needle: string): boolean =>
  JSON.stringify(bodyMessages(mock, i)).includes(needle);

// ===========================================================================
// B1 — event → legacy SSE reconstruction
// ===========================================================================
// Legacy emits, per exchange: text_delta* → tool_use{id,name,full input} →
// tool_result → tool_exchange (barrier) → next turn → done. Prove a faithful
// adapter is writable FROM AGENT EVENTS ALONE, and note any missing data.
async function B1(): Promise<ScenarioResult> {
  const ev: string[] = [];
  const log: string[] = [];
  // One combined text+tool_use assistant turn, then a closing text turn.
  const mock = startMock([
    textThenToolTurn("正在查登录逻辑", "echo", { v: "login" }, "tu_1"),
    textTurn("已定位问题"),
  ]);
  const { model, streamFn } = buildSetup(mock.url);
  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      model,
      tools: [makeEchoTool(log)],
      messages: [],
    },
    streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  });

  const events: AgentEvent[] = [];
  agent.subscribe((e) => {
    events.push(e);
  });
  await agent.prompt("查登录问题");
  await mock.close();

  // Reconstruct the legacy sequence from events alone.
  const textDeltas = events.filter(
    (e): e is Extract<AgentEvent, { type: "message_update" }> =>
      e.type === "message_update" && e.assistantMessageEvent.type === "text_delta",
  );
  const toolStart = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_execution_start" }> =>
      e.type === "tool_execution_start",
  );
  const toolEnd = events.find(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end",
  );
  const barriers = events.filter(
    (e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end",
  );
  const firstBarrier = barriers.find((b) => b.toolResults.length > 0);
  const agentEnd = events.find((e) => e.type === "agent_end");

  ok(textDeltas.length > 0, "text_delta events present (→ legacy text delta)", ev);
  const argsOk =
    !!toolStart &&
    toolStart.toolName === "echo" &&
    typeof toolStart.toolCallId === "string" &&
    !!(toolStart.args as { v?: string })?.v;
  ok(
    argsOk,
    `tool_execution_start carries {id,name,PARSED input}: id=${toolStart?.toolCallId} name=${toolStart?.toolName} input=${JSON.stringify(toolStart?.args)}`,
    ev,
  );
  ok(
    !!toolEnd && Array.isArray(toolEnd.result?.content),
    `tool_execution_end carries the result (→ legacy tool_result): ${JSON.stringify(toolEnd?.result?.content)}`,
    ev,
  );
  ok(
    !!firstBarrier && firstBarrier.toolResults.length === 1,
    "turn_end after tool exchange carries toolResults (→ legacy tool_exchange barrier)",
    ev,
  );
  // "next turn" — a second assistant turn producing text after the barrier.
  const turnStarts = events.filter((e) => e.type === "turn_start").length;
  ok(turnStarts >= 2, `>=2 turn_start events (barrier then next turn): ${turnStarts}`, ev);
  ok(!!agentEnd, "agent_end present (→ legacy done)", ev);

  // The one gap worth naming for the adapter spec.
  ev.push(
    "note: parsed tool args arrive on tool_execution_start.args AND on the final " +
      "message_end assistant.content toolCall block; partial input DOES stream via " +
      "message_update(toolcall_delta) but our mock sends it in one chunk, so " +
      "incremental JSON assembly is untested here (single-delta only).",
  );

  const verdict: Verdict = argsOk && !!firstBarrier && !!agentEnd ? "PASS" : "FAIL";
  return { name: "B1", verdict, agent: verdict, loop: "n/a", evidence: ev };
}

// ===========================================================================
// B2 — turn barrier (run async work between "tool results ready" and next call)
// ===========================================================================
async function B2(): Promise<ScenarioResult> {
  const ev: string[] = [];
  const BARRIER_MS = 200;

  // --- Agent class: subscriber await as the barrier ---
  const logA: string[] = [];
  const mockA = startMock([toolTurn("echo", { v: "a" }, "tu_1"), textTurn("done")]);
  const a = buildSetup(mockA.url);
  const agent = new Agent({
    initialState: { systemPrompt: "sys", model: a.model, tools: [makeEchoTool(logA)], messages: [] },
    streamFn: a.streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  });
  agent.subscribe(async (e) => {
    if (e.type === "turn_end" && e.toolResults.length > 0) {
      await delay(BARRIER_MS); // async work between tool results and next call
    }
  });
  await agent.prompt("go");
  await mockA.close();
  const gapAgent = (mockA.requests[1]?.at ?? 0) - (mockA.requests[0]?.at ?? 0);
  const agentPass = ok(
    mockA.requests.length === 2 && gapAgent >= BARRIER_MS - 40,
    `Agent: request#1 left ${gapAgent}ms after request#0 (barrier target ${BARRIER_MS}ms) — subscriber await held the loop`,
    ev,
  );

  // --- agentLoop: same barrier via the awaited emit sink (and prepareNextTurn) ---
  const logL: string[] = [];
  const mockL = startMock([toolTurn("echo", { v: "b" }, "tu_1"), textTurn("done")]);
  const l = buildSetup(mockL.url);
  const ctx: AgentContext = { systemPrompt: "sys", messages: [], tools: [makeEchoTool(logL)] };
  const cfg: AgentLoopConfig = {
    model: l.model,
    convertToLlm: passThroughConvert,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  };
  await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
    ctx,
    cfg,
    async (e) => {
      if (e.type === "turn_end" && e.toolResults.length > 0) await delay(BARRIER_MS);
    },
    undefined,
    l.streamFn,
  );
  await mockL.close();
  const gapLoop = (mockL.requests[1]?.at ?? 0) - (mockL.requests[0]?.at ?? 0);
  const loopPass = ok(
    mockL.requests.length === 2 && gapLoop >= BARRIER_MS - 40,
    `agentLoop: request#1 left ${gapLoop}ms after request#0 — awaited emit sink is a hard barrier`,
    ev,
  );

  const verdict: Verdict = agentPass && loopPass ? "PASS" : agentPass || loopPass ? "PARTIAL" : "FAIL";
  return {
    name: "B2",
    verdict,
    agent: agentPass ? "PASS" : "FAIL",
    loop: loopPass ? "PASS" : "FAIL",
    evidence: ev,
  };
}

// ===========================================================================
// B3 — inject a non-persisted reminder after tool results into call N+1
// ===========================================================================
async function B3(): Promise<ScenarioResult> {
  const ev: string[] = [];

  // --- Agent class: transformContext (model-only copy, state stays clean) ---
  const logA: string[] = [];
  const mockA = startMock([toolTurn("echo", { v: "a" }, "tu_1"), textTurn("done")]);
  const a = buildSetup(mockA.url);
  const agent = new Agent({
    initialState: { systemPrompt: "sys", model: a.model, tools: [makeEchoTool(logA)], messages: [] },
    streamFn: a.streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
    // Runs on EVERY llm call, on a COPY of the transcript, and its return value
    // feeds convertToLlm only — it never mutates state.messages / the persisted
    // transcript. Inject the reminder right after the tool results (i.e. when
    // the last message is a toolResult), exactly like legacy's model-only nudge.
    transformContext: async (messages) => {
      const last = messages[messages.length - 1];
      if (last && last.role === "toolResult") {
        return [
          ...messages,
          { role: "user", content: [{ type: "text", text: MIDPOINT_REMINDER }], timestamp: Date.now() },
        ];
      }
      return messages;
    },
  });
  await agent.prompt("go");
  await mockA.close();

  const inCall1 = bodyHas(mockA, 1, "本轮调查已过半");
  const inCall0 = bodyHas(mockA, 0, "本轮调查已过半");
  const persisted = JSON.stringify(agent.state.messages);
  const notPersisted = !persisted.includes("本轮调查已过半");
  ok(inCall1, "Agent: call#1 body.messages contains the reminder (rides after tool results)", ev);
  ok(!inCall0, "Agent: call#0 body.messages does NOT contain it (boundary respected)", ev);
  ok(notPersisted, "Agent: agent.state.messages is CLEAN of the reminder (non-persisted)", ev);
  const agentPass = inCall1 && !inCall0 && notPersisted;

  // --- agentLoop: identical transformContext hook ---
  const logL: string[] = [];
  const mockL = startMock([toolTurn("echo", { v: "b" }, "tu_1"), textTurn("done")]);
  const l = buildSetup(mockL.url);
  const persistedSeen: string[] = [];
  await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
    { systemPrompt: "sys", messages: [], tools: [makeEchoTool(logL)] },
    {
      model: l.model,
      convertToLlm: passThroughConvert,
      getApiKey: () => DUMMY_API_KEY,
      toolExecution: "sequential",
      transformContext: async (messages) => {
        const last = messages[messages.length - 1];
        if (last && last.role === "toolResult") {
          return [
            ...messages,
            { role: "user", content: [{ type: "text", text: MIDPOINT_REMINDER }], timestamp: Date.now() },
          ];
        }
        return messages;
      },
    },
    async (e) => {
      if (e.type === "message_end") persistedSeen.push(JSON.stringify(e.message));
    },
    undefined,
    l.streamFn,
  );
  await mockL.close();
  const loopInCall1 = bodyHas(mockL, 1, "本轮调查已过半");
  const loopNotPersisted = !persistedSeen.join("").includes("本轮调查已过半");
  ok(loopInCall1, "agentLoop: call#1 body.messages contains the reminder", ev);
  ok(loopNotPersisted, "agentLoop: no emitted (persisted) message carries it", ev);
  const loopPass = loopInCall1 && loopNotPersisted;

  ev.push(
    "note: pi's message model forces the reminder into a SEPARATE trailing user " +
      "message; legacy appends it as a trailing text block inside the SAME " +
      "tool_result user message. Model sees it after the results either way, but a " +
      "byte-for-byte match would need a custom convertToLlm / API codec — capability " +
      "holds, structure differs. Also: two consecutive user messages may need " +
      "merging for strict Anthropic endpoints (mock accepts them).",
  );

  const verdict: Verdict = agentPass && loopPass ? "PASS" : agentPass || loopPass ? "PARTIAL" : "FAIL";
  return {
    name: "B3",
    verdict,
    agent: agentPass ? "PASS" : "FAIL",
    loop: loopPass ? "PASS" : "FAIL",
    evidence: ev,
  };
}

// ===========================================================================
// B4 — budget stop after N turns + ONE separate tool-free wrap-up call
// ===========================================================================
async function B4(): Promise<ScenarioResult> {
  const ev: string[] = [];
  const BUDGET = 2; // stop after 2 tool turns

  // A standalone tool-free wrap-up call against the mock (plain pi-ai stream).
  async function wrapUp(setup: Setup, mock: MockServer): Promise<number> {
    const before = mock.requests.length;
    const stream = await setup.models.streamSimple(
      setup.model,
      { systemPrompt: "sys", messages: [{ role: "user", content: WRAPUP_PROMPT, timestamp: Date.now() }], tools: [] },
      { apiKey: DUMMY_API_KEY },
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) {
      /* drain */
    }
    return before; // index of the wrap-up request
  }

  // --- Agent class: afterToolCall sets terminate once budget is spent ---
  const logA: string[] = [];
  const mockA = startMock([
    toolTurn("echo", { v: "1" }, "tu_1"),
    toolTurn("echo", { v: "2" }, "tu_2"),
    // extra tool turn the agent must NEVER reach; wrap-up (below) becomes req#2.
    textTurn("wrapup-report"),
  ]);
  const a = buildSetup(mockA.url);
  let executed = 0;
  const agent = new Agent({
    initialState: { systemPrompt: "sys", model: a.model, tools: [makeEchoTool(logA)], messages: [] },
    streamFn: a.streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
    afterToolCall: async () => {
      executed += 1;
      return executed >= BUDGET ? { terminate: true } : undefined;
    },
  });
  await agent.prompt("go");
  const agentReqAfterLoop = mockA.requests.length;
  const wrapIdx = await wrapUp(a, mockA);
  await mockA.close();

  const stoppedAt2 = ok(
    agentReqAfterLoop === BUDGET,
    `Agent: loop made exactly ${agentReqAfterLoop} calls then stopped (budget ${BUDGET}); 3rd tool turn never requested`,
    ev,
  );
  const wrapToolFree = ok(
    (mockA.requests[wrapIdx]?.body as { tools?: unknown[] })?.tools === undefined,
    `Agent: separate wrap-up call (req#${wrapIdx}) carried NO tools`,
    ev,
  );
  const noExtra = ok(
    mockA.requests.length === BUDGET + 1,
    `Agent: total requests = ${mockA.requests.length} (=${BUDGET} loop + 1 wrap-up); agent made no further calls`,
    ev,
  );
  const agentPass = stoppedAt2 && wrapToolFree && noExtra;

  // --- agentLoop: shouldStopAfterTurn is the cleaner, purpose-built primitive ---
  const logL: string[] = [];
  const mockL = startMock([
    toolTurn("echo", { v: "1" }, "tu_1"),
    toolTurn("echo", { v: "2" }, "tu_2"),
    textTurn("wrapup-report"),
  ]);
  const l = buildSetup(mockL.url);
  let turns = 0;
  await runAgentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
    { systemPrompt: "sys", messages: [], tools: [makeEchoTool(logL)] },
    {
      model: l.model,
      convertToLlm: passThroughConvert,
      getApiKey: () => DUMMY_API_KEY,
      toolExecution: "sequential",
      shouldStopAfterTurn: () => {
        turns += 1;
        return turns >= BUDGET; // stop after turn N regardless of tool state
      },
    },
    async () => {},
    undefined,
    l.streamFn,
  );
  const loopReqAfterLoop = mockL.requests.length;
  const loopWrapIdx = await wrapUp(l, mockL);
  await mockL.close();
  const loopStopped = ok(
    loopReqAfterLoop === BUDGET,
    `agentLoop: shouldStopAfterTurn halted after ${loopReqAfterLoop} calls`,
    ev,
  );
  const loopWrapFree = ok(
    (mockL.requests[loopWrapIdx]?.body as { tools?: unknown[] })?.tools === undefined,
    `agentLoop: wrap-up call (req#${loopWrapIdx}) carried NO tools`,
    ev,
  );
  const loopPass = loopStopped && loopWrapFree;

  ev.push(
    "note: Agent class has no shouldStopAfterTurn — the terminate route needs " +
      "EVERY tool in a batch to set terminate (fine for legacy's one-tool-per-turn " +
      "sequential shape, brittle for parallel/multi-tool turns). agentLoop's " +
      "shouldStopAfterTurn is unconditional and is the faithful match to legacy's " +
      "'stop after iteration N' budget cap.",
  );

  const verdict: Verdict = agentPass && loopPass ? "PASS" : agentPass || loopPass ? "PARTIAL" : "FAIL";
  return {
    name: "B4",
    verdict,
    agent: agentPass ? "PASS" : "FAIL",
    loop: loopPass ? "PASS" : "FAIL",
    evidence: ev,
  };
}

// ===========================================================================
// B5 — clean cancel mid-tool-execution
// ===========================================================================
async function B5(): Promise<ScenarioResult> {
  const ev: string[] = [];
  const rejections: unknown[] = [];
  const onRej = (r: unknown): void => {
    rejections.push(r);
  };
  process.on("unhandledRejection", onRej);

  const mock = startMock([toolTurn("echo", { v: "block" }, "tu_1"), textTurn("should-never-happen")]);
  const s = buildSetup(mock.url);

  let started!: () => void;
  const startedP = new Promise<void>((res) => {
    started = res;
  });
  let sawAbortInTool = false;

  // A tool that blocks until its AbortSignal fires — so abort() lands squarely
  // mid-execution rather than before prepare or after completion.
  const blockingTool: AgentTool = {
    name: "echo",
    label: "Echo",
    description: "blocks until aborted",
    parameters: EchoParams,
    executionMode: "sequential",
    execute: async (_id, _params, signal) => {
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => {
          sawAbortInTool = signal.aborted;
          resolve();
        });
      });
      return { content: [{ type: "text", text: "aborted" }], details: {} };
    },
  };

  const agent = new Agent({
    initialState: { systemPrompt: "sys", model: s.model, tools: [blockingTool], messages: [] },
    streamFn: s.streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  });

  const run = agent.prompt("go");
  await startedP; // tool is now in-flight
  const requestsBeforeAbort = mock.requests.length; // = 1 (the tool-call turn)
  agent.abort();
  await run; // settles via aborted-run failure path

  await delay(60); // settle window for any late microtask rejections
  process.off("unhandledRejection", onRej);
  await mock.close();

  const noNewReq = ok(
    mock.requests.length === requestsBeforeAbort,
    `no further requests after abort (before=${requestsBeforeAbort}, after=${mock.requests.length})`,
    ev,
  );
  ok(sawAbortInTool, "tool's AbortSignal fired (execute observed signal.aborted === true)", ev);
  const noRej = ok(rejections.length === 0, `no unhandled rejections in settle window (${rejections.length})`, ev);
  ok(!!agent.state.errorMessage, `run recorded an aborted/error state: ${JSON.stringify(agent.state.errorMessage)}`, ev);

  const verdict: Verdict = noNewReq && sawAbortInTool && noRej ? "PASS" : "FAIL";
  return { name: "B5", verdict, agent: verdict, loop: "n/a", evidence: ev };
}

// ===========================================================================
// B6 — external history injection fidelity (Phase-1 codec spec)
// ===========================================================================
async function B6(): Promise<ScenarioResult> {
  const ev: string[] = [];

  // Legacy-shaped Anthropic history: user → assistant(text + tool_use) →
  // user(tool_result). This is the exact shape app/agent.py builds and persists.
  const legacyHistory = [
    { role: "user", content: "查一下登录问题" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我查一下" },
        { type: "tool_use", id: "tu_1", name: "echo", input: { v: "login" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "echo:login" }] },
  ];

  // --- Codec: legacy Anthropic shapes → pi AgentMessage shapes ---
  // Rules (this is the Phase-1 codec spec):
  //   user string/text        → { role:"user", content:[{type:"text",text}], timestamp }
  //   assistant text block     → { type:"text", text }
  //   assistant tool_use block → { type:"toolCall", id, name, arguments:input }
  //     wrapped in { role:"assistant", ...provider/model/usage, stopReason:"toolUse" }
  //   user tool_result block   → { role:"toolResult", toolCallId:tool_use_id,
  //                                 toolName, content:[{type:"text",text}], isError:false }
  const injected: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "查一下登录问题" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我查一下" },
        { type: "toolCall", id: "tu_1", name: "echo", arguments: { v: "login" } },
      ],
      api: "anthropic-messages",
      provider: "mock",
      model: "mock",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "tu_1",
      toolName: "echo",
      content: [{ type: "text", text: "echo:login" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const mock = startMock([textTurn("继续排查")]);
  const s = buildSetup(mock.url);
  const agent = new Agent({
    initialState: { systemPrompt: "sys", model: s.model, tools: [], messages: injected },
    streamFn: s.streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  });
  // One fresh turn on top of the injected history.
  await agent.prompt("还有别的线索吗");
  await mock.close();

  const msgs = bodyMessages(mock, 0) as Array<{ role: string; content: unknown }>;
  const asStr = JSON.stringify(msgs);

  // Faithful carry: order, roles, and tool blocks preserved.
  const roleOrder = msgs.map((m) => m.role).join(",");
  ok(roleOrder === "user,assistant,user,user", `role order preserved: [${roleOrder}] (tool_result renders as user)`, ev);
  const userText = ok(
    (msgs[0]?.content as Array<{ text?: string }>)?.[0]?.text === "查一下登录问题",
    "injected user text carried verbatim",
    ev,
  );
  const asstBlocks = (msgs[1]?.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) ?? [];
  const toolUse = asstBlocks.find((b) => b.type === "tool_use");
  const toolUseOk = ok(
    !!toolUse && toolUse.id === "tu_1" && toolUse.name === "echo" && JSON.stringify(toolUse.input) === '{"v":"login"}',
    `assistant tool_use block intact: ${JSON.stringify(toolUse)}`,
    ev,
  );
  const trBlocks = (msgs[2]?.content as Array<{ type: string; tool_use_id?: string }>) ?? [];
  const toolResult = trBlocks.find((b) => b.type === "tool_result");
  const trOk = ok(
    !!toolResult && toolResult.tool_use_id === "tu_1",
    `tool_result block intact & id-matched: ${JSON.stringify(toolResult)}`,
    ev,
  );
  ok(asStr.includes("还有别的线索吗"), "fresh prompt appended after the injected history", ev);

  ev.push(
    "codec spec: user(string|text)→user w/ text block; assistant tool_use→toolCall " +
      "{id,name,arguments}; user tool_result→toolResult message {toolCallId,toolName," +
      "content,isError}. pi re-serializes toolResult back to a user/tool_result block " +
      "(consecutive toolResults merge into one user message). toolName is NOT present " +
      "in the legacy shape — the codec must recover it from the matching tool_use by id.",
  );

  const verdict: Verdict = userText && toolUseOk && trOk ? "PASS" : "FAIL";
  return { name: "B6", verdict, agent: verdict, loop: "n/a", evidence: ev };
}

// ===========================================================================
// Runner
// ===========================================================================
const SCENARIOS: Record<string, () => Promise<ScenarioResult>> = { B1, B2, B3, B4, B5, B6 };

function printResult(r: ScenarioResult): void {
  const badge = r.verdict === "PASS" ? "✅ PASS" : r.verdict === "PARTIAL" ? "⚠️  PARTIAL" : "❌ FAIL";
  console.log(`\n=== ${r.name}: ${badge}  (Agent=${r.agent} / agentLoop=${r.loop}) ===`);
  for (const line of r.evidence) console.log(`   ${line}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "all";
  const names = arg === "all" ? Object.keys(SCENARIOS) : [arg];
  const results: ScenarioResult[] = [];
  for (const name of names) {
    const fn = SCENARIOS[name];
    if (!fn) {
      console.error(`unknown scenario: ${name} (have: ${Object.keys(SCENARIOS).join(", ")}, all)`);
      process.exitCode = 1;
      return;
    }
    results.push(await fn());
  }
  for (const r of results) printResult(r);

  const line = results
    .map((r) => `${r.name}=${r.verdict === "PASS" ? "P" : r.verdict === "PARTIAL" ? "~" : "F"}`)
    .join(" ");
  console.log(`\nMATRIX: ${line}`);
  if (results.some((r) => r.verdict === "FAIL")) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[scenarios failed]", err);
  process.exitCode = 1;
});
