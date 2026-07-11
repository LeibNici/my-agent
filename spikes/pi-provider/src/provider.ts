// DashScope Anthropic-compatible endpoint + qwen3.7-plus, mirroring the
// values production reads from /home/my-agent/.env (ANTHROPIC_BASE_URL/MODEL).
//
// This file adapts the Task 7 brief's sketch to pi-ai@0.80.6's real exports.
// See ../../.superpowers/sdd/task-7-report.md for the full "API 差异" list;
// the short version:
//   - createModels / createProvider / envApiKeyAuth / anthropicMessagesApi
//     import from the same paths the brief guessed. No rename needed there.
//   - UserMessage requires a `timestamp: number` field the brief's sketch
//     omitted (TS type is strict about it even though the runtime doesn't
//     enforce it under tsx).
//   - CreateProviderOptions.models entries must satisfy the *full* Model<TApi>
//     interface, not just {id, name, api, baseUrl} as the brief's sketch had.
//     Missing fields (provider/reasoning/input/cost/contextWindow/maxTokens)
//     cause a TS error, and maxTokens/contextWindow are NOT cosmetic: the
//     anthropic-messages api implementation reads model.maxTokens directly
//     as the outgoing request's `max_tokens` when the caller doesn't pass
//     options.maxTokens. cost/contextWindow for qwen3.7-plus via DashScope
//     are unverified placeholders — replace with real numbers before this
//     leaves spike status.
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
// Matches the brief's guess exactly — anthropicMessagesApi lives at this
// path in the real package too (dist/api/anthropic-messages.lazy.js).
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export const models = createModels();

const dashscope = createProvider({
  id: "dashscope",
  name: "DashScope (Anthropic-compatible)",
  auth: { apiKey: envApiKeyAuth("DashScope", ["ANTHROPIC_API_KEY"]) },
  api: anthropicMessagesApi(),
  models: [
    {
      id: "qwen3.7-plus",
      name: "Qwen 3.7 Plus (DashScope anthropic-compat)",
      api: "anthropic-messages",
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      // --- unverified placeholders (spike-only, see note above) ---
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 4096,
    },
  ],
});

models.setProvider(dashscope);

const model = models.getModel("dashscope", "qwen3.7-plus");
if (!model) {
  throw new Error("dashscope/qwen3.7-plus model not registered");
}
export const dashscopeModel = model;
