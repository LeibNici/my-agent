// src/phase1-endpoint.ts — Phase 1 GATE open-question verdicts, against the
// REAL DashScope endpoint (not mock). Closes GATE.md 遗留风险 1's two open
// questions (E1/E2), which offline mocking cannot answer:
//
//   E1: does DashScope accept a raw user(tool_result) message immediately
//       followed by an independent user(text) message — the shape pi's
//       codec produces when it does NOT merge a "reminder" text block into
//       the preceding tool_result user turn (confirmed by pi-agent-core's
//       B6 scenario against a MOCK server: role order
//       "user,assistant,user,user" — i.e. two consecutive user messages).
//       B6 only proved pi-ai *sends* that shape; it never asked whether a
//       real Anthropic-compatible endpoint (DashScope) *accepts* it.
//   E2: does pi-ai even expose `toolChoice` as a StreamOptions field, and if
//       so, does DashScope accept `toolChoice: "none"`?
//
// Run: set -a; source /home/my-agent/.env; set +a
//      npx tsx src/phase1-endpoint.ts   (run twice for flake detection)
//
// --- E2 static-check finding (see Step 2 in the brief) -----------------
// The brief's premise was "a prior quick grep of spikes/pi-agent-core's copy
// found nothing, so E2 is probably NOT-EXPOSED, no network call needed."
// That premise does NOT hold for pi-provider's own installed copy. Exact
// commands run and results:
//
//   $ grep -rn "toolChoice\|tool_choice" node_modules/@earendil-works/pi-ai/dist/ \
//       --include="*.js" --include="*.d.ts"
//   node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.d.ts:58:
//       toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
//   node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:750-757:
//       if (options?.toolChoice) {
//         if (typeof options.toolChoice === "string") {
//           params.tool_choice = { type: options.toolChoice };
//         } else {
//           params.tool_choice = options.toolChoice;
//         }
//       }
//   (plus hits in bedrock-converse-stream/google-vertex/google-generative-ai/
//   mistral-conversations/openai-completions — every API backend pi-ai ships
//   exposes some form of toolChoice; anthropic-messages is no exception.)
//
// So `toolChoice` IS exposed, as the third positional arg to
// `models.stream(model, context, options)` (same slot as S4/S6's
// `sessionId`/`cacheRetention`/`signal` — `AnthropicOptions extends
// StreamOptions`). E2 therefore needs the real network call the brief said
// to skip in the NOT-EXPOSED branch; `e2_tool_choice_none` below does that.
// -------------------------------------------------------------------------
import { Type, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { models, dashscopeModel } from "./provider.js";

type Result = { name: string; pass: boolean; evidence: string };

// pi-ai does not export userText/assistantToolCall/toolResult helpers (see
// pi-agent-core's B6 scenario, which builds these object literals inline
// rather than importing helpers). These are just local sugar over the exact
// same literal shapes S3 (scenarios.ts) and B6 (pi-agent-core/scenarios.ts)
// already use, kept as tiny functions so E1's scenario body reads close to
// the brief's sketch.
let tCounter = Date.now();
function t(): number {
  return tCounter++;
}

function userText(text: string, timestamp: number): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  timestamp: number,
): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic-messages",
    provider: "dashscope",
    model: "qwen3.7-plus",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

// ===========================================================================
// E1 — double consecutive user messages (tool_result-user immediately
// followed by an independent text-user), real streaming call, watch for 4xx.
// ===========================================================================
async function e1_double_user(): Promise<Result> {
  const tools = [
    { name: "echo", description: "原样返回输入的 v 字段", parameters: Type.Object({ v: Type.String() }) },
  ];
  // Two consecutive user messages: [3] is user(tool_result only), [4] would
  // be user(text only) if pi's codec does NOT merge the reminder into the
  // preceding tool_result turn — exactly the shape B6 confirmed pi-ai sends
  // against a mock. Here we point the SAME shape at the real endpoint.
  const messages: Message[] = [
    userText("查一下登录问题", t()),
    assistantToolCall("tu_1", "echo", { v: "login" }, t()),
    toolResult("tu_1", "echo", "echo:login", t()),
    userText("本轮调查已过半，请收敛", t()),
  ];

  let doneMessage: Extract<Message, { role: "assistant" }> | null = null;
  let errored: string | null = null;
  let text = "";
  try {
    const s = models.stream(dashscopeModel, { messages, tools });
    for await (const e of s) {
      if (e.type === "text_delta") text += e.delta;
      if (e.type === "done") doneMessage = e.message;
      if (e.type === "error") errored = e.error?.errorMessage ?? e.reason;
    }
  } catch (err: any) {
    errored = `THREW ${err?.message ?? err}`;
  }

  return {
    name: 'E1 双连续user消息(tool_result-user 紧跟 text-user)',
    pass: !errored && !!doneMessage,
    evidence: errored
      ? `errored: ${errored}`
      : `done stopReason=${doneMessage?.stopReason} textLen=${text.length} textPreview=${JSON.stringify(text.slice(0, 60))}`,
  };
}

// ===========================================================================
// E2 — tool_choice API surface + real endpoint acceptance of
// `toolChoice: "none"`. Static grep (see file header) found toolChoice
// exposed on anthropic-messages' AnthropicOptions, so this makes the real
// call the brief's NOT-EXPOSED shortcut would otherwise have skipped.
// ===========================================================================
async function e2_tool_choice_none(): Promise<Result> {
  const tools = [
    { name: "echo", description: "原样返回输入的 v 字段", parameters: Type.Object({ v: Type.String() }) },
  ];
  let call: ToolCall | null = null;
  let text = "";
  let errored: string | null = null;
  try {
    const s = models.stream(
      dashscopeModel,
      {
        messages: [
          {
            role: "user",
            content: "请务必调用 echo 工具，把参数 v 设为 test",
            timestamp: t(),
          },
        ],
        tools,
      },
      { toolChoice: "none" },
    );
    for await (const e of s) {
      if (e.type === "toolcall_end") call = e.toolCall;
      if (e.type === "text_delta") text += e.delta;
      if (e.type === "error") errored = e.error?.errorMessage ?? e.reason;
    }
  } catch (err: any) {
    errored = `THREW ${err?.message ?? err}`;
  }

  return {
    name: 'E2 tool_choice:"none" 端点验证(pi-ai 确实暴露该字段, 见文件头 grep 记录)',
    pass: !errored,
    evidence: errored
      ? `errored (DashScope rejects tool_choice): ${errored}`
      : `accepted, no 4xx — sawToolCall=${!!call} textLen=${text.length}`,
  };
}

const all: Record<string, () => Promise<Result>> = {
  e1: e1_double_user,
  e2: e2_tool_choice_none,
};

// Unlike scenarios.ts (which runs each scenario twice *within* one process),
// this file runs each scenario ONCE per process — the brief's Step 3 invokes
// the whole script twice from the shell (`... && npx tsx ...`) to get the
// "两轮独立运行" evidence, so flake detection happens at the process level
// instead of doubling up (and doubling real network cost) inside main().
async function main() {
  const pick = process.argv[2] ?? "all";
  const results: Result[] = [];
  for (const [k, fn] of Object.entries(all)) {
    if (pick !== "all" && pick !== k) continue;
    try {
      results.push(await fn());
    } catch (err: any) {
      results.push({ name: k, pass: false, evidence: `THREW ${err?.message ?? err}` });
    }
  }
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  —  ${r.evidence}`);
  }
}

main().catch((err) => {
  console.error("[phase1-endpoint failed]", err);
  process.exitCode = 1;
});
