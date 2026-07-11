// src/scenarios.ts — Phase 0A verdict scenarios S1..S7 against DashScope
// qwen3.7-plus via pi-ai@0.80.6. Each scenario prints PASS/FAIL + one-line
// evidence; results feed spikes/pi-provider/REPORT.md.
//
// Run: ANTHROPIC_API_KEY=... npx tsx src/scenarios.ts [s1|s2|...|all]
//
// This file adapts the Task 8 brief's sketch to pi-ai's REAL API, checked
// directly against dist/types.d.ts and dist/api/anthropic-messages.js (not
// assumed from the brief). Every place this diverges from the brief's sketch
// is called out inline below; the summary also lives in task-8-report.md.
//
//   - `Type` (typebox) is re-exported from the package root
//     (`export { Type } from "typebox"` in dist/index.d.ts) — no need for
//     `@sinclair/typebox` (brief's guess) or even a direct `typebox` import.
//   - `UserMessage`/`ToolResultMessage`/`AssistantMessage` all require a
//     `timestamp: number` field (Task 7 finding). Every message literal below
//     sets it.
//   - `ToolResultMessage` also requires `toolName: string` — the brief's S3
//     sketch omitted it (`{ role: "toolResult", toolCallId, content }`).
//   - Stream events: tool calls surface as `toolcall_end` with a `toolCall:
//     ToolCall` field (`{type:"toolCall", id, name, arguments}`), matching
//     the brief. `usage` is NOT a field directly on most events — it only
//     appears via the terminal `done`/`error` events' `message.usage`
//     (`AssistantMessage.usage`), never as `(event as any).usage` the way S4
//     and S7's sketch assumed. Rewritten to read `event.message.usage` off
//     the `done` event.
//   - Usage field names are camelCase (`cacheRead`, not
//     `cache_read_input_tokens` as S4's sketch guessed) — confirmed in Task 7
//     smoke output.
//   - S3: instead of hand-building a partial `{role:"assistant", content:
//     [...]}` message (the brief's sketch), we push the exact
//     `AssistantMessage` object returned by the `done` event back into
//     `messages` — it already satisfies the full `Message` union (api,
//     provider, model, usage, stopReason, timestamp all present), so there's
//     no risk of a hand-rolled shape drifting from what pi-ai expects on the
//     next call.
//   - S6 (abort): pi-ai does NOT let `AbortController.abort()` propagate as a
//     thrown exception out of the `for await` loop over the stream. Reading
//     dist/api/anthropic-messages.js's outer try/catch: an abort is caught
//     internally and re-emitted as a terminal `{type: "error", reason:
//     "aborted", error: AssistantMessage}` event, then the stream ends
//     normally. The brief's sketch (`try { ... } catch (err) { threw =
//     err.name }`) would never observe a throw on the happy/expected abort
//     path — rewritten to watch for the `error` event's `reason` field
//     instead, while *still* keeping the try/catch as a backstop in case a
//     lower-level abort throws synchronously some other way. Also installs a
//     process `unhandledRejection` listener around the call per the brief's
//     explicit ask to verify no unhandled rejection survives an abort.
//   - S4: cache_control is attached unconditionally by
//     `getCacheControl`/`convertMessages` for ANY anthropic-messages baseUrl
//     whenever `cacheRetention !== "none"` (default "short") — it is not
//     gated by an Anthropic-host check anywhere in anthropic-messages.js. So
//     the brief's "if pi-ai doesn't send cache_control to non-Anthropic
//     baseUrls at all" scenario does not apply here: pi-ai always tries. The
//     open question this scenario actually tests is whether DashScope's
//     endpoint (a) rejects the field outright (400) or (b) silently accepts
//     and ignores it (cacheRead stays 0 forever). Implemented to distinguish
//     the two and, on a 400, retry once with conservative `model.compat`
//     flags per the brief's note, recording both outcomes either way.
import { Type, type Message, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import { models, dashscopeModel } from "./provider.js";

type Result = { name: string; pass: boolean; evidence: string };

async function s1_streaming(): Promise<Result> {
  let chunks = 0;
  let text = "";
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "用两句话介绍SQLite", timestamp: Date.now() }],
  });
  for await (const e of s) {
    if (e.type === "text_delta") {
      chunks++;
      text += e.delta;
    }
  }
  return {
    name: "S1 流式文本",
    pass: chunks > 3 && text.length > 10,
    evidence: `chunks=${chunks} len=${text.length}`,
  };
}

async function s2_toolcall(): Promise<Result> {
  const tools = [
    {
      name: "code_search",
      description: "在代码库中做固定字符串搜索",
      parameters: Type.Object({ keyword: Type.String() }),
    },
  ];
  let call: ToolCall | null = null;
  const s = models.stream(dashscopeModel, {
    messages: [
      { role: "user", content: "请用 code_search 工具搜索关键字 UserService", timestamp: Date.now() },
    ],
    tools,
  });
  for await (const e of s) {
    if (e.type === "toolcall_end") call = e.toolCall;
  }
  return {
    name: "S2 工具调用+schema校验",
    pass: !!call && call.name === "code_search" && typeof call.arguments?.keyword === "string",
    evidence: JSON.stringify(call).slice(0, 160),
  };
}

async function s3_multiturn_tools(): Promise<Result> {
  // 10 tool round-trips: push the real `done` AssistantMessage back into
  // messages (not a hand-rolled partial — see file header), plus a
  // ToolResultMessage with the required `toolName` field, and watch for 4xx.
  const tools = [
    { name: "echo", description: "原样返回输入的 v 字段", parameters: Type.Object({ v: Type.String() }) },
  ];
  const messages: Message[] = [
    {
      role: "user",
      content:
        "请连续调用 echo 工具10轮，每轮把参数 v 设为当前轮次编号(字符串,从0到9)，每轮只调用一次工具，" +
        "工具返回结果后立即进行下一轮调用，不要输出多余文字。现在开始第0轮。",
      timestamp: Date.now(),
    },
  ];
  for (let i = 0; i < 10; i++) {
    let doneMessage: Extract<Message, { role: "assistant" }> | null = null;
    let errored: string | null = null;
    const s = models.stream(dashscopeModel, { messages, tools });
    for await (const e of s) {
      if (e.type === "done") doneMessage = e.message;
      if (e.type === "error") errored = e.error.errorMessage ?? e.reason;
    }
    if (errored) {
      return { name: "S3 长工具会话", pass: false, evidence: `round ${i} errored: ${errored}` };
    }
    const toolCall = doneMessage?.content.find((b): b is ToolCall => b.type === "toolCall");
    if (!toolCall) {
      return {
        name: "S3 长工具会话",
        pass: i >= 5,
        evidence: `stopped calling tools at round ${i} (stopReason=${doneMessage?.stopReason})`,
      };
    }
    messages.push(doneMessage!);
    messages.push({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `echo:${i}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  return { name: "S3 长工具会话", pass: true, evidence: "10 rounds completed, no 4xx" };
}

async function s4_prompt_cache(): Promise<Result> {
  // Same sessionId, two calls with an identical oversized prefix. Pass
  // criterion: real cacheRead > 0 on the SECOND call's usage, not merely
  // "the request didn't error."
  const big = "系统背景资料：".padEnd(4000, "码");

  const callOnce = async (
    model: typeof dashscopeModel,
    cacheRetention: "short" | "none",
  ): Promise<Usage> => {
    // Context (messages/tools) and StreamOptions (sessionId/cacheRetention)
    // are separate positional args to models.stream() — see models.d.ts
    // `stream(model, context, options?)`. The brief's sketch merged them
    // into one object; that's a TS error (and would silently drop the
    // options fields under plain tsx with no typecheck).
    const s = models.stream(
      model,
      { messages: [{ role: "user", content: `${big}\n回复:1`, timestamp: Date.now() }] },
      { sessionId: "spike-cache-1", cacheRetention },
    );
    let usage: Usage | null = null;
    for await (const e of s) {
      if (e.type === "done") usage = e.message.usage;
      if (e.type === "error") throw new Error(e.error.errorMessage ?? e.reason);
    }
    if (!usage) throw new Error("no done event / usage");
    return usage;
  };

  const attempt = async (model: typeof dashscopeModel, cacheRetention: "short" | "none") => {
    const u1 = await callOnce(model, cacheRetention);
    const u2 = await callOnce(model, cacheRetention);
    return { u1, u2 };
  };

  try {
    const { u2 } = await attempt(dashscopeModel, "short");
    if (u2.cacheRead > 0) {
      return {
        name: "S4 prompt caching 真实生效",
        pass: true,
        evidence: `second-call usage=${JSON.stringify(u2)}`,
      };
    }
    return {
      name: "S4 prompt caching 真实生效",
      pass: false,
      evidence: `no 4xx, but cacheRead=0 on second call — DashScope accepts cache_control but doesn't cache: usage=${JSON.stringify(u2)}`,
    };
  } catch (primaryErr: any) {
    // Retry with conservative model.compat flags per the Task 7 review note,
    // to see whether a narrower cache_control shape is accepted. `compat`'s
    // declared type is keyed off the model's own (widened) `Api` type param,
    // which resolves to `never` for `dashscopeModel`'s `Model<Api>` type —
    // structurally fine at runtime (it's a plain optional field consumed by
    // string-keyed lookups in anthropic-messages.js), so a double assertion
    // is the pragmatic way to attach it in this spike harness.
    const conservativeModel = {
      ...dashscopeModel,
      compat: {
        supportsCacheControlOnTools: false,
        supportsLongCacheRetention: false,
        supportsEagerToolInputStreaming: false,
      },
    } as unknown as typeof dashscopeModel;
    try {
      const { u2 } = await attempt(conservativeModel, "short");
      return {
        name: "S4 prompt caching 真实生效",
        pass: false,
        evidence: `default compat threw "${primaryErr?.message}"; conservative compat retry succeeded but cacheRead=${u2.cacheRead} (usage=${JSON.stringify(u2)}) — record both, still FAIL since read=${u2.cacheRead > 0}`,
      };
    } catch (retryErr: any) {
      // Final isolation: does the endpoint work at all without cache_control?
      try {
        await attempt(dashscopeModel, "none");
        return {
          name: "S4 prompt caching 真实生效",
          pass: false,
          evidence: `cache_control request 400s ("${primaryErr?.message}"); conservative-compat retry also failed ("${retryErr?.message}"); cacheRetention="none" (no cache_control sent) succeeds — DashScope rejects cache_control on this endpoint`,
        };
      } catch (baselineErr: any) {
        return {
          name: "S4 prompt caching 真实生效",
          pass: false,
          evidence: `all attempts failed: default="${primaryErr?.message}" conservative-compat="${retryErr?.message}" no-cache-control="${baselineErr?.message}"`,
        };
      }
    }
  }
}

async function s5_no_tools_forced(): Promise<Result> {
  // wrap-up scenario: tools: [] must not produce a toolcall event.
  let sawTool = false;
  let text = "";
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "总结：SQLite是嵌入式数据库", timestamp: Date.now() }],
    tools: [],
  });
  for await (const e of s) {
    if (e.type.startsWith("toolcall")) sawTool = true;
    if (e.type === "text_delta") text += e.delta;
  }
  return {
    name: "S5 空tools强制纯文本(wrap-up替代tool_choice:none)",
    pass: !sawTool && text.length > 0,
    evidence: `sawTool=${sawTool} len=${text.length}`,
  };
}

async function s6_abort(): Promise<Result> {
  let unhandled: string | null = null;
  const onUnhandledRejection = (reason: unknown) => {
    unhandled = reason instanceof Error ? reason.message : String(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const ac = new AbortController();
  let chunks = 0;
  let terminal = "none";
  let terminalReason = "";
  try {
    const s = models.stream(
      dashscopeModel,
      { messages: [{ role: "user", content: "写一篇500字的散文，主题不限", timestamp: Date.now() }] },
      { signal: ac.signal },
    );
    for await (const e of s) {
      if (e.type === "text_delta" && ++chunks === 3) ac.abort();
      if (e.type === "done") {
        terminal = "done";
        terminalReason = e.reason;
      }
      if (e.type === "error") {
        terminal = "error";
        terminalReason = e.reason;
      }
    }
  } catch (err: any) {
    // Backstop: real pi-ai turns abort into a terminal `error` event rather
    // than a thrown exception (see file header), so hitting this branch on
    // an abort would itself be a finding worth recording.
    terminal = "threw";
    terminalReason = err?.name ?? String(err);
  }

  // Give the event loop a beat so any lingering rejection from the aborted
  // fetch/SDK request surfaces before we check the flag.
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.off("unhandledRejection", onUnhandledRejection);

  const pass = chunks >= 3 && chunks <= 8 && terminal === "error" && terminalReason === "aborted" && !unhandled;
  return {
    name: "S6 中途取消",
    pass,
    evidence: `chunks=${chunks} terminal=${terminal}(${terminalReason}) unhandledRejection=${unhandled ?? "none"}`,
  };
}

async function s7_usage_ttft(): Promise<Result> {
  const t0 = Date.now();
  let tFirst = 0;
  let usage: Usage | null = null;
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "回复:好", timestamp: Date.now() }],
  });
  for await (const e of s) {
    if (!tFirst && e.type === "text_delta") tFirst = Date.now();
    if (e.type === "done") usage = e.message.usage;
  }
  const ok = !!usage && usage.input > 0 && usage.output > 0 && tFirst > 0;
  return {
    name: "S7 usage/TTFT数据完整(llm_call_metrics可移植)",
    pass: ok,
    evidence: `ttft=${tFirst - t0}ms usage=${JSON.stringify(usage)}`,
  };
}

const all: Record<string, () => Promise<Result>> = {
  s1: s1_streaming,
  s2: s2_toolcall,
  s3: s3_multiturn_tools,
  s4: s4_prompt_cache,
  s5: s5_no_tools_forced,
  s6: s6_abort,
  s7: s7_usage_ttft,
};

// Run each scenario twice to catch flakiness (brief requirement: "run each
// at least twice to spot flakiness (record flaky as FAIL with note)").
// pass/pass and fail/fail collapse to one verdict; a pass/fail split is
// recorded as FAIL with a FLAKY note rather than picking a winner.
async function runTwice(fn: () => Promise<Result>): Promise<Result> {
  const safeRun = async (): Promise<Result> => {
    try {
      return await fn();
    } catch (err: any) {
      return { name: "?", pass: false, evidence: `THREW ${err?.message ?? err}` };
    }
  };
  const r1 = await safeRun();
  const r2 = await safeRun();
  const name = r1.name !== "?" ? r1.name : r2.name;
  if (r1.pass && r2.pass) {
    return { name, pass: true, evidence: `run1[${r1.evidence}] run2[${r2.evidence}]` };
  }
  if (!r1.pass && !r2.pass) {
    return { name, pass: false, evidence: `run1[${r1.evidence}] run2[${r2.evidence}]` };
  }
  return {
    name,
    pass: false,
    evidence: `FLAKY run1(pass=${r1.pass})[${r1.evidence}] run2(pass=${r2.pass})[${r2.evidence}]`,
  };
}

async function main() {
  const pick = process.argv[2] ?? "all";
  const results: Result[] = [];
  for (const [k, fn] of Object.entries(all)) {
    if (pick !== "all" && pick !== k) continue;
    results.push(await runTwice(fn));
  }
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  —  ${r.evidence}`);
  }
}

main().catch((err) => {
  console.error("[scenarios failed]", err);
  process.exitCode = 1;
});
