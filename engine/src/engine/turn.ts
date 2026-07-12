// runTurn — the per-turn ephemeral pi-Agent assembler (Task 4, the heart of
// Phase 3). Lifts test/agent-harness.ts's Agent-assembly pattern (wrapped
// streamFn keeping `this` bound, pass-through convertToLlm via the Agent
// class default, toolExecution:"sequential") into production code and adds
// v1's budget-checkpoint semantics, ported verbatim from
// `git show v1-python-final:app/agent.py` (_budget_reminder/_WRAPUP_PROMPT)
// with the call-index arithmetic pinned by
// `git show v1-python-final:tests/test_agent_budget.py`.
//
// pi types are allowed in this file per the Phase-3 Global Constraints
// amendment — otherwise the three-layer isolation confines them to
// codec-pi.ts/event-adapter.ts.
//
// runTurn is deliberately pure: history in, DomainEvents out. Persisting
// those events (tool_exchange as it lands, llm_metrics batched, etc.) is
// Task 5's SSE layer; `deps.db` is accepted for forward signature
// compatibility but unused here.
import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Message,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { Settings } from "../config.js";
import type { DbClient } from "../db/client.js";
import type { ToolDef, ToolContext } from "../tools/registry.js";
import { toPiTools } from "./pi-tools.js";
import { createEventAdapter } from "../event-adapter.js";
import { legacyListToDomain } from "../codec-legacy.js";
import { prepareModelMessages } from "../history-policy.js";
import { domainToPi } from "../codec-pi.js";
import type { DomainEvent } from "../domain.js";

const PROVIDER_ID = "anthropic";

// ==================== v1-python-final:app/agent.py, verbatim ====================
//
// These texts go only into the copy of the conversation sent to the model —
// never persisted (see budgetReminder's call site: transformContext returns
// a NEW array, agent.state.messages is never touched).

const MIDPOINT_CHECK =
  "[系统提示] 本轮调查已过半。请先在心里核对：真正要回答的问题是什么？" +
  "目前已确认了什么、已排除了什么？当前这条调查路线还有证据支撑吗？" +
  "如果没有，立刻换方向，不要沿着无证据的假设继续深挖。";

const endgameCheck = (remaining: number): string =>
  `[系统提示] 本轮调查仅剩 ${remaining} 轮。请停止扩大搜索范围，开始收敛：` +
  "基于已掌握的信息整理结论——已确认什么、已排除什么、还缺什么证据。" +
  "除非有一个明确的关键缺口必须补齐，否则现在就给出结论。";

const WRAPUP_PROMPT =
  "[系统提示] 本轮工具调用预算已用尽，不要再调用任何工具。" +
  "请直接用文字给出阶段性汇报：\n" +
  "1. 目前已确认的结论（附代码位置）\n" +
  "2. 已排除的可能性\n" +
  "3. 还缺什么证据、下一步应该查什么\n" +
  "即使结论不完整也要如实汇报，这份汇报会直接展示给用户。";

// v1's checkpoint-of-last-resort: when the wrap-up call streams no usable
// text (empty completion OR an in-band error terminal — pi never throws),
// this copy carries the turn instead. v1 gates on `not wrap_text.strip()`
// (whitespace-only counts as empty) and the fallback REPLACES wrap_text, so
// done.text is exactly this string.
const WRAPUP_FALLBACK =
  "本轮工具调用预算已用尽，且未能生成阶段性汇报。" +
  "上面的工具调用记录包含了已经查到的信息，可点击「继续调查」在此基础上继续。";

// v1's _WRAPUP_MAX_TOKENS: "a synthesis call, not another investigation
// window" — caps ONLY the wrap-up request; loop calls keep settings.maxTokens
// (riding on the Model object's own maxTokens field).
const WRAPUP_MAX_TOKENS = 1200;

/** Port of app/agent.py::_budget_reminder. `nextIteration` is the 0-based
 * call index of the LLM call ABOUT TO BE MADE (matches v1's `iteration + 1`
 * — computed once per completed iteration and read by the following call).
 * Endgame outranks midpoint when a small maxIterations makes both fire. */
function budgetReminder(nextIteration: number, maxIterations: number): string | null {
  const remaining = maxIterations - nextIteration;
  if (remaining >= 1 && remaining <= 3) return endgameCheck(remaining);
  if (maxIterations >= 6 && nextIteration === Math.floor(maxIterations / 2)) return MIDPOINT_CHECK;
  return null;
}

// ==================== Agent assembly (lifted from test/agent-harness.ts) ====================

export type ModelSetup = { models: MutableModels; model: Model<"anthropic-messages">; streamFn: StreamFn };

/** Builds a single-model Models/Provider pointed at `settings.baseUrl`, plus
 * the `this`-bound streamFn wrapper (see agent-harness.ts's header for why
 * the wrapping is needed: passing `models.streamSimple` bare loses its
 * `this` binding). Driven entirely by Settings so the SAME function serves
 * production (real Anthropic-compatible endpoint) and tests (mock.url) —
 * test/agent-harness.ts's buildSetup delegates here instead of duplicating
 * the createModels/createProvider wiring. */
export function buildModelSetup(
  settings: Pick<Settings, "baseUrl" | "apiKey" | "model" | "maxTokens" | "promptCache">,
): ModelSetup {
  const models = createModels();
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Anthropic-compatible",
    auth: { apiKey: envApiKeyAuth("Anthropic", ["ANTHROPIC_API_KEY"]) },
    api: anthropicMessagesApi(),
    models: [
      {
        id: settings.model,
        name: settings.model,
        api: "anthropic-messages",
        provider: PROVIDER_ID,
        baseUrl: settings.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: settings.maxTokens,
      },
    ],
  });
  models.setProvider(provider);
  const model = models.getModel(PROVIDER_ID, settings.model) as Model<"anthropic-messages"> | undefined;
  if (!model) throw new Error(`model not registered: ${PROVIDER_ID}/${settings.model}`);
  // GATE-backed decision (0A spike S4: DashScope prompt caching is real,
  // cacheRead=4005 on the second call) — default stays ON by omitting
  // cacheRetention entirely, which lets pi-ai apply its own default
  // ("short", unconditional cache_control on system/tools/last-user-turn —
  // see node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js's
  // resolveCacheRetention). "off" is the one value that needs to be wired
  // through explicitly, as cacheRetention:"none" — pi-ai only omits
  // cache_control when told to.
  const cacheRetention = settings.promptCache === "off" ? ("none" as const) : undefined;
  const streamFn: StreamFn = (m, ctx, opts) =>
    models.streamSimple(m, ctx, cacheRetention ? { ...opts, cacheRetention } : opts);
  return { models, model, streamFn };
}

/** The error division-of-labor test/agent-harness.ts originated (Task 6):
 * pi never throws for LLM/transport failures — a failed run surfaces as
 * `agent.state.errorMessage` after prompt() settles, dispatched to
 * adapter.fail() instead of finish(). Shared by runTurn's own
 * normal-completion path and the harness so this decision isn't duplicated.
 * Callers that need to intercept the terminal event (runTurn's
 * budget-exhausted/wrap-up branch) check agent.state.errorMessage
 * themselves instead of calling this. */
export function finalizeAgentRun(
  agent: Agent,
  adapter: ReturnType<typeof createEventAdapter>,
): DomainEvent[] {
  return agent.state.errorMessage ? adapter.fail(agent.state.errorMessage) : adapter.finish();
}

// ==================== Callback -> AsyncGenerator bridge ====================

/** Minimal single-consumer push queue. agent.subscribe() delivers events via
 * callback; runTurn must yield them AS THEY HAPPEN (tool_exchange has to be
 * observable before the next LLM call, per checklist item 2) rather than
 * buffering the whole turn and yielding at the end. Local to this module —
 * nothing else needs an AsyncGenerator built from a callback event source. */
function makeChannel<T>(): { put(item: T): void; close(err?: unknown): void; drain(): AsyncGenerator<T> } {
  const buffered: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: unknown;

  function put(item: T): void {
    buffered.push(item);
    if (wake) {
      const w = wake;
      wake = undefined;
      w();
    }
  }
  function close(err?: unknown): void {
    closed = true;
    failure = err;
    if (wake) {
      const w = wake;
      wake = undefined;
      w();
    }
  }
  async function* drain(): AsyncGenerator<T> {
    for (;;) {
      while (buffered.length > 0) yield buffered.shift() as T;
      if (closed) {
        if (failure !== undefined) throw failure;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return { put, close, drain };
}

// ==================== Wrap-up (budget-exhaustion checkpoint 4) ====================

/** One separate, tool-free wrap-up call — NOT through the Agent
 * (transformContext/afterToolCall don't apply to it). `tools: []` rather
 * than omitting the field is what makes pi-ai serialize the wire request
 * WITHOUT a `tools` key at all (0B spike B4-verified, see
 * spikes/pi-agent-core/src/scenarios.ts) — v2's TOOLS-OMITTED replacement
 * for v1's tool_choice:"none"-then-retry dance, which retired along with
 * the Python implementation (Global Constraints: not ported). */
async function runWrapup(
  setup: ModelSetup,
  settings: Settings,
  transcript: Message[],
  channel: { put(e: DomainEvent): void },
): Promise<void> {
  const wrapupMessage: Message = {
    role: "user",
    content: [{ type: "text", text: WRAPUP_PROMPT }],
    timestamp: Date.now(),
  };
  const callStartMs = Date.now();
  let firstTextDeltaMs: number | undefined;
  const stream = await setup.models.streamSimple(
    setup.model,
    { systemPrompt: settings.systemPrompt, messages: [...transcript, wrapupMessage], tools: [] },
    {
      apiKey: settings.apiKey,
      maxTokens: WRAPUP_MAX_TOKENS,
      // Same off-switch as buildModelSetup's streamFn — this call bypasses
      // the Agent entirely (see file header), so the wiring has to be
      // repeated here rather than inherited.
      ...(settings.promptCache === "off" ? { cacheRetention: "none" as const } : {}),
    },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      if (firstTextDeltaMs === undefined) firstTextDeltaMs = Date.now();
      text += event.delta;
      channel.put({ type: "text_delta", data: { text: event.delta } });
    }
  }
  // result() resolves for BOTH terminal shapes (done => message, in-band
  // error => the error AssistantMessage with zeroed usage) — pi's StreamFn
  // contract means this await can't reject for LLM/transport failures.
  const result = await stream.result();
  // The wrap-up's own metrics row, numbered exactly like v1's wrap-up yield:
  // `"iteration": settings.max_tool_iterations` — the loop's rows are 0-based
  // 0..max-1, so the wrap-up continues the sequence at max. ttft/total are
  // measured wall-clock the same way the event adapter does for loop calls
  // (v1 hardcoded ttft_ms=None here; measuring is a deliberate v2 upgrade —
  // see task-4-report.md).
  channel.put({
    type: "llm_metrics",
    data: {
      iteration: settings.maxToolIterations,
      model: settings.model,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      ttftMs: firstTextDeltaMs !== undefined ? firstTextDeltaMs - callStartMs : null,
      totalMs: Date.now() - callStartMs,
    },
  });
  // v1 order preserved: metrics first, THEN the fallback delta (if the
  // stream produced nothing), then done carrying the same text.
  if (!text.trim()) {
    text = WRAPUP_FALLBACK;
    channel.put({ type: "text_delta", data: { text } });
  }
  channel.put({ type: "done", data: { text, success: true, budgetExhausted: true } });
}

// ==================== runTurn ====================

// ctx is per-turn (Task 8): sse.ts's resolveToolContext resolves it fresh
// from the current user's repo permissions before every runTurn call —
// required, not optional, so a call site can't silently fall back to
// Task 2/3's placeholder empty-access default and grant a tool nothing to
// read without anyone noticing at the type level.
export type RunTurnDeps = { db?: DbClient; settings: Settings; tools: ToolDef[]; ctx: ToolContext };
// history carries legacy JSON message dicts (DB row shape) — see
// codec-legacy.ts's legacyListToDomain, which is the validating boundary
// that turns this `unknown[]` into typed DomainMessage[].
export type RunTurnRequest = { sessionId: string; history: unknown[]; userText: string };

// The injectable shape of runTurn itself (Task 5's buildApp takes this as
// `deps.engine` — SSE route tests inject a stub matching this signature
// instead of the real per-turn pi Agent assembly, so the SSE contract can
// be verified with no network/no pi involved).
export type RunTurnFn = (deps: RunTurnDeps, req: RunTurnRequest) => AsyncGenerator<DomainEvent>;

export async function* runTurn(deps: RunTurnDeps, req: RunTurnRequest): AsyncGenerator<DomainEvent> {
  const { settings, tools, ctx } = deps;
  const setup = buildModelSetup(settings);
  const adapter = createEventAdapter({ model: settings.model });

  // legacy history -> domain -> windowed/condensed -> pi AgentMessage[],
  // the same anticorruption pipeline integration.test.ts already proved out
  // end to end (Task 7).
  const domainHistory = legacyListToDomain(req.history);
  const shaped = prepareModelMessages(domainHistory, settings.maxHistoryMessages);
  const initialMessages: AgentMessage[] = domainToPi(shaped, { model: settings.model, provider: PROVIDER_ID });

  // Per-turn budget bookkeeping. Fresh closures every runTurn call — no
  // module-level state — is what makes "each turn gets a brand-new Agent"
  // (checklist item 6) hold: nothing here can leak into the next call.
  let callsMade = 0;
  let budgetExhausted = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: settings.systemPrompt,
      model: setup.model,
      tools: toPiTools(tools, ctx),
      messages: initialMessages,
    },
    streamFn: setup.streamFn,
    getApiKey: () => settings.apiKey,
    toolExecution: "sequential",
    // Budget checkpoints 1/2 (midpoint/endgame): a model-only reminder,
    // injected fresh into a COPY of the context every call — agent.state
    // stays clean (D1-verified shape, spikes/pi-agent-core/src/scenarios.ts
    // B3). nextIteration === callsMade BEFORE incrementing mirrors v1's
    // `iteration + 1` exactly: transformContext runs once per LLM call,
    // right before that call is dispatched.
    transformContext: async (messages) => {
      const nextIteration = callsMade;
      callsMade += 1;
      const reminder = budgetReminder(nextIteration, settings.maxToolIterations);
      if (!reminder) return messages;
      return [...messages, { role: "user", content: [{ type: "text", text: reminder }], timestamp: Date.now() }];
    },
    // Budget checkpoint 3 (exhaustion): once every call in the budget has
    // been made, stop the pi loop after this tool batch instead of starting
    // call N+1 — the faithful equivalent of v1's
    // `for iteration in range(max_iterations)` simply running out (B4 in
    // the same spike file). callsMade is already the POST-increment count
    // for the call that just finished (transformContext ran before it).
    afterToolCall: async () => {
      if (callsMade < settings.maxToolIterations) return undefined;
      budgetExhausted = true;
      return { terminate: true };
    },
  });

  const channel = makeChannel<DomainEvent>();
  agent.subscribe((e) => {
    for (const de of adapter.onPiEvent(e)) channel.put(de);
  });

  const run = agent
    .prompt(req.userText)
    .then(async () => {
      if (agent.state.errorMessage || !budgetExhausted) {
        for (const de of finalizeAgentRun(agent, adapter)) channel.put(de);
        return;
      }
      // Route through the Agent's own convertToLlm (default: pass-through
      // filter for user/assistant/toolResult roles — agent.d.ts's
      // AgentOptions.convertToLlm, unchanged from the Task 6 assembly
      // pattern) rather than agent.state.messages directly: AgentMessage is
      // a wider union than Message once anything imports pi-agent-core's
      // harness module (declaration-merges custom message types onto
      // CustomAgentMessages), so this is also the type-correct way to get a
      // Message[] for the wrap-up Context.
      const transcript = await agent.convertToLlm(agent.state.messages);
      await runWrapup(setup, settings, transcript, channel);
    })
    .then(
      () => channel.close(),
      (err: unknown) => channel.close(err),
    );

  // If the consumer stops iterating early (sse.ts's raceAbort calling
  // engineIter.return() on client disconnect), yield*'s delegation makes
  // this generator perform its own return right here — without this
  // finally, `await run` below is simply never reached, so the in-flight
  // agent.prompt() (LLM call + tool loop) keeps running server-side with
  // nothing consuming its output. agent.abort() is a documented no-op if
  // the run has already finished normally, so this is safe on every exit
  // path, not just the early one. `run` itself can't reject (its own
  // .then(onFulfilled, onRejected) above already funnels every failure,
  // abort included, into channel.close(err)) — the .catch is defensive
  // only, so callers awaiting engineIter.return() see this fully settled
  // before their own await resolves.
  try {
    yield* channel.drain();
    await run;
  } finally {
    agent.abort();
    await run.catch(() => {});
  }
}
