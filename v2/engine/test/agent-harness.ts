// Shared pi Agent assembly + event-adapter-driving helper.
//
// Extracted from Task 6's event-adapter.test.ts (where it first proved out
// against the golden event sequences) so Task 7's integration test can reuse
// the exact same wiring instead of re-deriving it. Assembly pattern copied
// from spikes/pi-agent-core/src/scenarios.ts's B1 (Model object, wrapped
// streamFn keeping `this` bound to the models instance, pass-through
// convertToLlm via the Agent class default, toolExecution:"sequential",
// subscribe, await agent.prompt) — see that file's header comment for the
// full rationale.
//
// Task 4 lifted this assembly pattern into production code
// (src/engine/turn.ts's buildModelSetup/finalizeAgentRun) — this harness now
// delegates to those instead of duplicating the createModels/createProvider
// wiring and the errorMessage->fail()/finish() dispatch decision.
import {
  Agent,
  type AgentEvent as PiAgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import type { MockServer } from "./mock-anthropic.js";
import { createEventAdapter } from "../src/event-adapter.js";
import { buildModelSetup, finalizeAgentRun, type ModelSetup } from "../src/engine/turn.js";
import type { DomainEvent } from "../src/domain.js";

const DUMMY_API_KEY = "sk-mock-offline-not-a-real-key";
const MODEL_LABEL = "mock";

type Setup = ModelSetup;

export function buildSetup(url: string): Setup {
  return buildModelSetup({ baseUrl: url, apiKey: DUMMY_API_KEY, model: MODEL_LABEL, maxTokens: 4096 });
}

// calculator-shaped stub tool (matches the Python golden's tool name/shape).
const CalculatorParams = Type.Object({ expression: Type.String() });
export function makeCalculatorTool(): AgentTool {
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

export type RunTurnOptions = {
  /** Tools exposed to the Agent for this turn (default: none). */
  tools?: AgentTool[];
  /**
   * Prior-turn pi messages to seed `initialState.messages` with — the
   * per-turn ephemeral Agent assembly pattern (scenarios.ts B6): a fresh
   * Agent is built per turn and prior history is injected here rather than
   * kept on a long-lived Agent instance.
   */
  initialMessages?: AgentMessage[];
};

/** Drives a single real pi Agent turn through createEventAdapter, returning
 * the flattened domain-event sequence — the assembly + finish()/fail()
 * dispatch this helper owns per the task-6 brief. */
export async function runTurnThroughAdapter(
  mock: MockServer,
  prompt: string,
  opts: RunTurnOptions = {},
): Promise<DomainEvent[]> {
  const { model, streamFn } = buildSetup(mock.url);
  const adapter = createEventAdapter({ model: MODEL_LABEL });
  const events: DomainEvent[] = [];

  const agent = new Agent({
    initialState: {
      systemPrompt: "sys",
      model,
      tools: opts.tools ?? [],
      messages: opts.initialMessages ?? [],
    },
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
  // event-adapter.ts's header note). finalizeAgentRun (src/engine/turn.ts)
  // owns the fail()-vs-finish() dispatch on that so the decision isn't
  // duplicated here.
  events.push(...finalizeAgentRun(agent, adapter));
  return events;
}
