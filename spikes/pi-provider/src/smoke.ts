// Minimal streaming smoke test against DashScope qwen3.7-plus via the
// dashscope provider defined in provider.ts. Run with:
//
//   ANTHROPIC_API_KEY=... npx tsx src/smoke.ts
//
// Adapted from the Task 7 brief's --eval sketch. The brief's event check
// (`event.type === "text_delta"`) turned out to match the real pi-ai
// AssistantMessageEvent union exactly — see
// ../../.superpowers/sdd/task-7-report.md for the full API-差异 list,
// including the one meaningful difference: the brief called
// `models.stream(model, { messages: [...] })` with a bare message object
// missing the required `timestamp` field on UserMessage.
import { models, dashscopeModel } from "./provider.js";

async function main() {
  const stream = models.stream(dashscopeModel, {
    messages: [
      {
        role: "user",
        content: "回复一个字:好",
        timestamp: Date.now(),
      },
    ],
  });

  let text = "";
  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta;
      process.stdout.write(event.delta);
    } else if (event.type === "error") {
      console.error("\n[stream error]", event.reason, event.error.errorMessage);
      process.exitCode = 1;
    } else if (event.type === "done") {
      console.log(`\n[done] stopReason=${event.reason} usage=${JSON.stringify(event.message.usage)}`);
    }
  }

  if (!text) {
    console.error("OK but no text_delta content received — see stream events above");
    process.exitCode = 1;
    return;
  }
  console.log("\nOK");
}

main().catch((err) => {
  console.error("[smoke failed]", err);
  process.exitCode = 1;
});
