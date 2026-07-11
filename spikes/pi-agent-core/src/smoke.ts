// Phase 0B smoke test: does @earendil-works/pi-agent-core's Agent class
// accept a stream produced by our local mock-anthropic.ts SSE server?
//
// Fully offline — no ANTHROPIC_API_KEY needed. A dummy key is supplied via
// Agent's getApiKey hook purely to satisfy anthropic-messages.js's
// assertRequestAuth() guard (it throws "No API key for provider" if neither
// an apiKey nor an auth header is present); the mock server never inspects
// or validates it.
//
// Run: npx tsx src/smoke.ts
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
} from "@earendil-works/pi-ai";
// Same import path Task 7 verified against the real package (see
// ../../.superpowers/sdd/task-7-report.md) — anthropicMessagesApi lives at
// this lazy sub-path, not the package root.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { startMock, textTurn } from "./mock-anthropic.js";

const DUMMY_API_KEY = "sk-mock-offline-not-a-real-key";

async function main() {
  const mock = startMock([textTurn("hello from the mock")]);

  const models = createModels();
  const mockProvider = createProvider({
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
        baseUrl: mock.url,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
      },
    ],
  });
  models.setProvider(mockProvider);
  const mockModel: Model<"anthropic-messages"> | undefined = models.getModel("mock", "mock") as
    | Model<"anthropic-messages">
    | undefined;
  if (!mockModel) {
    throw new Error("mock/mock model not registered");
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a test fixture. Reply with whatever the mock sends.",
      model: mockModel,
      tools: [],
      messages: [],
    },
    // Agent defaults to pi-ai's bare streamSimple export when streamFn is
    // omitted, which calls provider.streamSimple() without touching `this` —
    // fine there. `models.streamSimple` (the Models *instance* method,
    // needed here so the provider we just registered on `models` is what
    // actually gets used) is a plain prototype method that reads
    // `this.requireProvider(...)` internally, so passing the bare method
    // reference loses its `this` binding and throws "Cannot read properties
    // of undefined (reading 'requireProvider')" the moment Agent invokes it.
    // Wrap it so `this` stays bound to `models`.
    streamFn: (model, context, options) => models.streamSimple(model, context, options),
    getApiKey: () => DUMMY_API_KEY,
  });

  let sawMessageEnd = false;
  agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      sawMessageEnd = true;
    }
  });

  await agent.prompt("ping");

  const finalMessages = agent.state.messages;
  const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
  const text =
    lastAssistant && lastAssistant.role === "assistant"
      ? lastAssistant.content
          .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("")
      : "";

  await mock.close();

  console.log(`text: ${JSON.stringify(text)}`);
  console.log(`requests.length: ${mock.requests.length}`);
  console.log(`saw message_end event: ${sawMessageEnd}`);
  console.log(`errorMessage: ${agent.state.errorMessage ?? "(none)"}`);

  if (text !== "hello from the mock") {
    throw new Error(`expected text "hello from the mock", got ${JSON.stringify(text)}`);
  }
  if (mock.requests.length !== 1) {
    throw new Error(`expected exactly 1 recorded request, got ${mock.requests.length}`);
  }

  console.log("\nOK");
}

main().catch((err) => {
  console.error("[smoke failed]", err);
  process.exitCode = 1;
});
