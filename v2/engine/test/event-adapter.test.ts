// Task 6 — golden-sequence tests for the pi AgentEvent -> DomainEvent
// adapter. Fully offline: a REAL pi Agent driven against the local mock
// Anthropic server (test/mock-anthropic.ts). Oracle = the three golden event
// sequences in tests/test_agent_events.py (Python characterization tests).
//
// Agent assembly copied from spikes/pi-agent-core/src/scenarios.ts's B1
// (Model object, wrapped streamFn keeping `this` bound to the models
// instance, pass-through convertToLlm via the Agent class default,
// toolExecution:"sequential", subscribe, await agent.prompt).
import { describe, it, expect } from "vitest";
import {
  Agent,
  type AgentEvent as PiAgentEvent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { Type, type Static } from "typebox";
import { startMock, textTurn, textThenToolTurn, type MockServer } from "./mock-anthropic.js";
import { createEventAdapter } from "../src/event-adapter.js";
import type { DomainEvent } from "../src/domain.js";

const DUMMY_API_KEY = "sk-mock-offline-not-a-real-key";
const MODEL_LABEL = "mock";

type Setup = { models: ReturnType<typeof createModels>; model: Model<"anthropic-messages">; streamFn: StreamFn };

function buildSetup(url: string): Setup {
  const models = createModels();
  const provider = createProvider({
    id: "mock",
    name: "Mock Anthropic (offline, Task 6)",
    auth: { apiKey: envApiKeyAuth("Mock", ["MOCK_ANTHROPIC_API_KEY"]) },
    api: anthropicMessagesApi(),
    models: [
      {
        id: MODEL_LABEL,
        name: MODEL_LABEL,
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
  const model = models.getModel("mock", MODEL_LABEL) as Model<"anthropic-messages"> | undefined;
  if (!model) throw new Error("mock/mock model not registered");
  // Wrap so streamSimple keeps its `this` bound to the models instance.
  const streamFn: StreamFn = (m, ctx, opts) => models.streamSimple(m, ctx, opts);
  return { models, model, streamFn };
}

// calculator-shaped stub tool (matches the Python golden's tool name/shape).
const CalculatorParams = Type.Object({ expression: Type.String() });
function makeCalculatorTool(): AgentTool {
  return {
    name: "calculator",
    label: "Calculator",
    description: "evaluates a simple arithmetic expression",
    parameters: CalculatorParams,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const expr = (params as Static<typeof CalculatorParams>).expression;
      return { content: [{ type: "text", text: `${expr} = 2` }], details: {} };
    },
  };
}

/** Drives a single real pi Agent turn through createEventAdapter, returning
 * the flattened domain-event sequence — the assembly + finish()/fail()
 * dispatch this test file owns per the task-6 brief. */
async function runTurnThroughAdapter(
  mock: MockServer,
  prompt: string,
  tools: AgentTool[] = [],
): Promise<DomainEvent[]> {
  const { model, streamFn } = buildSetup(mock.url);
  const adapter = createEventAdapter({ model: MODEL_LABEL });
  const events: DomainEvent[] = [];

  const agent = new Agent({
    initialState: { systemPrompt: "sys", model, tools, messages: [] },
    streamFn,
    getApiKey: () => DUMMY_API_KEY,
    toolExecution: "sequential",
  });
  agent.subscribe((e: PiAgentEvent) => {
    events.push(...adapter.onPiEvent(e));
  });

  await agent.prompt(prompt);

  // pi never throws for LLM/transport failures (StreamFn contract) — a
  // failed run surfaces as agent.state.errorMessage instead (see
  // event-adapter.ts's header note). Dispatch finish() vs fail() on that.
  if (agent.state.errorMessage) {
    events.push(...adapter.fail(agent.state.errorMessage));
  } else {
    events.push(...adapter.finish());
  }
  return events;
}

describe("event-adapter — golden sequences from test_agent_events.py", () => {
  it("纯文本回合：text_delta* → llm_metrics → done（test_text_only_turn_sequence）", async () => {
    const mock = startMock([textTurn("你好")]);
    const events = await runTurnThroughAdapter(mock, "hi");
    expect(events.map((e) => e.type)).toEqual(["text_delta", "llm_metrics", "done"]);
    expect(events.at(-1)!.data).toMatchObject({ text: "你好", success: true });
    await mock.close();
  });

  it("工具回合：text_delta → llm_metrics → tool_use → tool_result → tool_exchange → … → done（test_tool_round_sequence）", async () => {
    const mock = startMock([
      textThenToolTurn("算一下", "calculator", { expression: "1+1" }, "tu_1"),
      textTurn("答案是2"),
    ]);
    const events = await runTurnThroughAdapter(mock, "1+1=?", [makeCalculatorTool()]);
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
    await mock.close();
  });
});
