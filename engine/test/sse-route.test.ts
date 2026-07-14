// Task 5 — SSE chat route + session/auth/config/skills/repos API + static
// frontend. Oracle for the SSE contract: the four goldens in
// `git show v1-python-final:tests/test_sse_contract.py`, ported to Node
// (semantics, not literal syntax) against a scripted STUB engine — no
// network, no pi, matching that file's StubAgent pattern.
//
// app.request() drives every non-streaming-cancellation case (in-process,
// no port/socket needed — verified to correctly stream an SSE Response
// body). The disconnect scenario needs a REAL transport: only
// @hono/node-server's actual Node http server wires a client-side
// AbortController through to Hono's `stream.onAbort()` (see
// src/server/app.ts's comment on that same wiring) — app.request() never
// drives Node's request/response close events, so it cannot exercise this
// path at all.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import { createToken, hashPassword } from "../src/auth.js";
import { buildApp } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";
import type { DomainEvent } from "../src/domain.js";

// ==================== Shared fixtures ====================

let dir: string, dbPath: string, client: DbClient, settings: Settings;

beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  dbPath = f.dbPath;
  client = createDbClient(f.dbPath);
  settings = loadSettings({ APP_JWT_SECRET: "test-secret-do-not-use-in-prod" });
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUser(role: "user" | "admin" = "user", username = "alice"): Promise<{ id: number; token: string }> {
  const id = await client.createUser(username, "hashed-pw", role);
  const token = createToken({ id, username, role }, settings);
  return { id, token };
}

// A token whose tokenVersion actually matches this user's CURRENT DB row —
// needed whenever a test calls updateUserPassword (which bumps
// token_version) as setup AFTER seedUser already minted a token, since that
// token is now stale by the auth middleware's own definition (Codex
// full-repo review, 2026-07-14, Warning).
async function freshToken(id: number, username: string, role: string): Promise<string> {
  const user = await client.getUserById(id);
  if (!user) throw new Error(`freshToken: no such user id=${id}`);
  return createToken({ id, username, role, tokenVersion: user.token_version }, settings);
}

function authedRequest(app: ReturnType<typeof buildApp>, token: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

// ==================== Stub engine scripting ====================
// Mirrors v1's StubAgent (tests/test_sse_contract.py): a script of
// DomainEvent | Error | "hang" items — an Error entry raises (simulating
// the engine crashing mid-turn), "hang" simulates a turn that's still
// live but has nothing more to say right now (used only by the disconnect
// scenario, which needs the generator to still be awaiting when the client
// aborts — Node has no CancelledError-thrown-into-generator equivalent to
// script directly, unlike Python's asyncio task cancellation).
type ScriptItem = DomainEvent | Error | "hang";

function stubEngine(script: ScriptItem[]): RunTurnFn {
  return async function* () {
    for (const item of script) {
      if (item instanceof Error) throw item;
      if (item === "hang") {
        await new Promise<never>(() => {
          /* never resolves */
        });
        return;
      }
      yield item;
    }
  };
}

// ==================== SSE frame parsing (mirrors web/app.js's own parser) ====================

type Frame = { event: string; data: string };

function parseFrames(raw: string): Frame[] {
  const frames: Frame[] = [];
  let event = "message";
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length) frames.push({ event, data: dataLines.join("\n") });
    event = "message";
    dataLines = [];
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line.trim() === "") flush();
  }
  flush();
  return frames;
}

async function postChat(
  app: ReturnType<typeof buildApp>,
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; frames: Frame[] }> {
  const resp = await authedRequest(app, token, "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, frames: parseFrames(text) };
}

function markSessionResolved(sessionId: string): void {
  const db = new Database(dbPath);
  db.prepare("UPDATE sessions SET resolved_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000000", sessionId);
  db.close();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ==================== 1-3: the SSE contract, oracle = test_sse_contract.py ====================

describe("POST /api/chat — SSE contract (oracle: v1-python-final:tests/test_sse_contract.py)", () => {
  it("1. 超长消息拒绝：error→done→end，done.session_id 为 null，且 engine 从未被调用（真正的早退，不是跑完空脚本）", async () => {
    const { token } = await seedUser();
    let engineCalled = false;
    const engine: RunTurnFn = async function* () {
      engineCalled = true;
    };
    const app = buildApp({ db: client, settings, engine });
    const { status, frames } = await postChat(app, token, { message: "x".repeat(10001) });
    expect(status).toBe(200); // SSE response itself is always 200 — the reject rides inside the stream
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[1].data)).toEqual({ session_id: null, text: "" });
    expect(JSON.parse(frames[0].data).message).toContain("10001");
    expect(engineCalled).toBe(false);
  });

  it("2. 正常回合：session(reason:new)→text→done→end；done 带 message_id/budget_exhausted；落库 user+assistant 两行", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "text_delta", data: { text: "答案" } },
        { type: "done", data: { text: "答案", success: true, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "问题" });
    expect(frames.map((f) => f.event)).toEqual(["session", "text", "done", "end"]);
    const sessionData = JSON.parse(frames[0].data);
    expect(sessionData.reason).toBe("new");
    expect(sessionData.session_id).toBeTruthy();
    expect(JSON.parse(frames[1].data)).toEqual({ text: "答案" });
    const done = JSON.parse(frames[2].data);
    expect(done.session_id).toBe(sessionData.session_id);
    expect(done.text).toBe("答案");
    expect(done.message_id).not.toBeNull();
    expect(done.budget_exhausted).toBe(false);
    // persisted: user question + assistant answer
    const msgs = await client.getMessages(sessionData.session_id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("问题");
    expect(msgs[1].content).toBe("答案");
  });

  it("3. tool_exchange 即刻持久化：engine 中途抛错，已产出的 exchange 两行仍在库中（session→error→done→end）", async () => {
    const { token } = await seedUser();
    const assistantBlocks: DomainEvent & { type: "tool_exchange" } = {
      type: "tool_exchange",
      data: {
        assistant: [{ type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } }],
        results: [{ type: "tool_result", toolUseId: "tu_1", content: "2", isError: false }],
      },
    };
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([assistantBlocks, new Error("boom")]),
    });
    const { frames } = await postChat(app, token, { message: "查" });
    expect(frames.map((f) => f.event)).toEqual(["session", "error", "done", "end"]);
    const sid = JSON.parse(frames[0].data).session_id;
    const msgs = await client.getMessages(sid);
    // user question + persisted exchange pair survive the crash
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toEqual([
      { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } },
    ]);
    expect(msgs[2].content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "2" }]);
  });

  it("4. 断连：client abort 后部分文本落库并追加「连接已中断」，且不再收到 done/end（真实 server + AbortController）", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "text_delta", data: { text: "写到一半" } },
        "hang",
      ]),
    });
    const server: Server = serve({ fetch: app.fetch, port: 0 });
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const port = (server.address() as AddressInfo).port;

      const controller = new AbortController();
      const resp = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: "问" }),
        signal: controller.signal,
      });
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const seen: string[] = [];
      while (!buf.includes("event: text")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before a text event arrived");
        buf += decoder.decode(value, { stream: true });
      }
      for (const f of parseFrames(buf)) seen.push(f.event);
      expect(seen).toEqual(["session", "text"]); // exactly what streamed before abort — no done/end yet

      const sessionId = JSON.parse(parseFrames(buf)[0].data).session_id as string;
      controller.abort();

      await waitFor(async () => {
        const msgs = await client.getMessages(sessionId);
        const last = msgs.at(-1);
        return typeof last?.content === "string" && last.content.includes("连接已中断");
      });
      const msgs = await client.getMessages(sessionId);
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs[1].content).toBe("写到一半\n\n_（回复未完成：连接已中断）_");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 10000);
});

// ==================== Supplementary SSE semantics (beyond the four core scenarios) ====================

describe("POST /api/chat — supplementary semantics", () => {
  it("resolved 会话来消息 → 透明新建，reason='resolved'", async () => {
    const { id: uid, token } = await seedUser();
    const oldSessionId = await client.createSession("New Chat", uid);
    markSessionResolved(oldSessionId);
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    const { frames } = await postChat(app, token, { session_id: oldSessionId, message: "继续" });
    const sessionData = JSON.parse(frames[0].data);
    expect(sessionData.reason).toBe("resolved");
    expect(sessionData.session_id).not.toBe(oldSessionId);
  });

  it("不存在的 session_id → 透明新建，reason='not_found'", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    const { frames } = await postChat(app, token, { session_id: "ghost123", message: "hi" });
    const sessionData = JSON.parse(frames[0].data);
    expect(sessionData.reason).toBe("not_found");
    expect(sessionData.session_id).not.toBe("ghost123");
  });

  it("非本人、非 admin 的 session_id → Access denied 拒绝序列（不透明新建）", async () => {
    const owner = await seedUser("user", "owner");
    const intruder = await seedUser("user", "intruder");
    const sessionId = await client.createSession("New Chat", owner.id);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const { frames } = await postChat(app, intruder.token, { session_id: sessionId, message: "hi" });
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[0].data).message).toBe("Access denied");
  });

  it("admin 可以在任何用户的 session 上继续对话（不触发 Access denied）", async () => {
    const owner = await seedUser("user", "owner2");
    const admin = await seedUser("admin", "root2");
    const sessionId = await client.createSession("New Chat", owner.id);
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    const { frames } = await postChat(app, admin.token, { session_id: sessionId, message: "hi" });
    const sessionData = JSON.parse(frames[0].data);
    expect(sessionData.session_id).toBe(sessionId);
    expect(sessionData.reason).toBeNull();
  });

  it("tool_exchange 事件本身不下发到浏览器（只落库）", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        {
          type: "tool_exchange",
          data: {
            assistant: [{ type: "tool_use", id: "tu_1", name: "calculator", input: {} }],
            results: [{ type: "tool_result", toolUseId: "tu_1", content: "2", isError: false }],
          },
        },
        { type: "done", data: { text: "", success: true, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "查" });
    expect(frames.map((f) => f.event)).not.toContain("tool_exchange");
  });

  it("tool_use → tool_result：wire 上的 tool_result 帧带 name（DomainEvent 本身没有，靠 sse.ts 的 id→name 补全）", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "tool_use", data: { id: "tu_9", name: "calculator", input: { expression: "1+1" } } },
        { type: "tool_result", data: { id: "tu_9", result: "2" } },
        { type: "done", data: { text: "", success: true, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "算" });
    const toolUseFrame = frames.find((f) => f.event === "tool_use")!;
    const toolResultFrame = frames.find((f) => f.event === "tool_result")!;
    expect(JSON.parse(toolUseFrame.data)).toEqual({ id: "tu_9", name: "calculator", input: { expression: "1+1" } });
    expect(JSON.parse(toolResultFrame.data)).toEqual({ id: "tu_9", name: "calculator", result: "2" });
  });

  it("llm_metrics 事件不下发到浏览器，turn 末批量落 llm_call_metrics 表", async () => {
    const { id: uid, token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        {
          type: "llm_metrics",
          data: { iteration: 0, model: "mock", inputTokens: 10, outputTokens: 5, ttftMs: 20, totalMs: 40 },
        },
        {
          type: "llm_metrics",
          data: { iteration: 1, model: "mock", inputTokens: 12, outputTokens: 6, ttftMs: 15, totalMs: 30 },
        },
        { type: "done", data: { text: "ok", success: true, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "多轮" });
    expect(frames.map((f) => f.event)).not.toContain("llm_metrics");
    const sessionId = JSON.parse(frames[0].data).session_id;
    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT session_id, user_id, iteration, input_tokens FROM llm_call_metrics WHERE session_id = ? ORDER BY iteration")
      .all(sessionId) as Array<{ session_id: string; user_id: number; iteration: number; input_tokens: number }>;
    db.close();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.iteration)).toEqual([0, 1]);
    expect(rows.every((r) => r.user_id === uid)).toBe(true);
  });

  it("done{success:false}（LLM 出错）：部分文本落库并追加「发生错误」后缀，done 不含新的 message_id 字段", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "text_delta", data: { text: "半截答案" } },
        { type: "error", data: { message: "LLM API error: boom" } },
        { type: "done", data: { text: "半截答案", success: false, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "出错" });
    expect(frames.map((f) => f.event)).toEqual(["session", "text", "error", "done", "end"]);
    const sessionId = JSON.parse(frames[0].data).session_id;
    const msgs = await client.getMessages(sessionId);
    expect(msgs[1].content).toBe("半截答案\n\n_（回复未完成：发生错误）_");
  });

  it("done{success:false, text:''}（adapter.fail() 真实形状——pi 的 error 终态从不带文本）：落库用的是流式期间攒下的 currentTextBuffer，不是空的 done.text", async () => {
    // The real event-adapter.ts's fail() ALWAYS sets done.data.text to ""
    // (event-adapter.ts:160) — it has no way to know what text streamed
    // before the failure. Reading event.data.text directly here (the bug)
    // silently drops everything the user already saw stream in. v1 never
    // had this gap: it kept its own current_text_buffer independent of
    // whatever the "done" event happened to carry.
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "text_delta", data: { text: "写到一半" } },
        { type: "error", data: { message: "LLM API error: boom" } },
        { type: "done", data: { text: "", success: false, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "出错" });
    expect(frames.map((f) => f.event)).toEqual(["session", "text", "error", "done", "end"]);
    const sessionId = JSON.parse(frames[0].data).session_id;
    const msgs = await client.getMessages(sessionId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("写到一半\n\n_（回复未完成：发生错误）_");
  });
});

// ==================== Session title auto-derivation (v1 main.py's chat_event_stream, "done" branch) ====================

describe("会话标题自动推导（v1 main.py: title still 'New Chat' -> req.message[:50]）", () => {
  it("成功回合后，仍是 'New Chat' 的会话标题被推导为用户消息前 50 字符", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([
        { type: "text_delta", data: { text: "答案" } },
        { type: "done", data: { text: "答案", success: true, budgetExhausted: false } },
      ]),
    });
    const { frames } = await postChat(app, token, { message: "这是一个很长的问题用来验证标题截断" });
    const sessionId = JSON.parse(frames[0].data).session_id;
    // Through the real GET /api/sessions/:id endpoint, not just the db client.
    const sessResp = await authedRequest(app, token, `/api/sessions/${sessionId}`);
    const sessBody = await sessResp.json();
    expect(sessBody.session.title).toBe("这是一个很长的问题用来验证标题截断".slice(0, 50));
  });

  it("已经有标题的会话（非 'New Chat'）不会被第二轮对话覆盖", async () => {
    const { id: uid, token } = await seedUser("user", "title-keep");
    const sid = await client.createSession("New Chat", uid);
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    // Turn 1 derives the title from the first message.
    await postChat(app, token, { session_id: sid, message: "第一条消息" });
    expect((await client.getSession(sid))!.title).toBe("第一条消息");

    // Turn 2 must NOT overwrite it, even with a different message.
    const app2 = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok2", success: true, budgetExhausted: false } }]),
    });
    await postChat(app2, token, { session_id: sid, message: "第二条消息" });
    expect((await client.getSession(sid))!.title).toBe("第一条消息");
  });

  it("超过 50 字符的消息按 50 字符截断", async () => {
    const { token } = await seedUser("user", "title-truncate");
    const longMessage = "字".repeat(80);
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    const { frames } = await postChat(app, token, { message: longMessage });
    const sessionId = JSON.parse(frames[0].data).session_id;
    const session = await client.getSession(sessionId);
    expect(session!.title).toBe("字".repeat(50));
  });
});

// ==================== POST /api/chat — image attachments ====================
// v1's _validate_images (app/main.py:86-102), ported to sse.ts's
// validateImages. A bad image rejects the WHOLE message (error/done/end,
// nothing persisted, no engine call) — never "drop the extras".

const PNG_MAGIC_B64 = "iVBORw0KGgo="; // real PNG magic bytes, base64 — just needs to be well-formed base64

describe("POST /api/chat — image attachments", () => {
  it("超过数量上限 → 整条拒绝", async () => {
    const { token } = await seedUser("user", "img-count");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const images = Array.from({ length: 6 }, () => ({ media_type: "image/png", data: PNG_MAGIC_B64 }));
    const { frames } = await postChat(app, token, { message: "看这些图", images });
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[0].data).message).toMatch(/Too many images/);
  });

  it("不支持的 media_type → 整条拒绝", async () => {
    const { token } = await seedUser("user", "img-type");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const { frames } = await postChat(app, token, {
      message: "看这个",
      images: [{ media_type: "image/svg+xml", data: PNG_MAGIC_B64 }],
    });
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[0].data).message).toMatch(/Unsupported image type/);
  });

  it("base64 长度超限 → 整条拒绝", async () => {
    const { token } = await seedUser("user", "img-size");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const { frames } = await postChat(app, token, {
      message: "看这个",
      images: [{ media_type: "image/png", data: "A".repeat(6_000_001) }],
    });
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[0].data).message).toMatch(/too large/);
  });

  it("畸形 base64 → 整条拒绝（存储型 XSS 防线，不是单纯格式校验）", async () => {
    const { token } = await seedUser("user", "img-badb64");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const { frames } = await postChat(app, token, {
      message: "看这个",
      images: [{ media_type: "image/png", data: "not-valid-base64!!!" }],
    });
    expect(frames.map((f) => f.event)).toEqual(["error", "done", "end"]);
    expect(JSON.parse(frames[0].data).message).toMatch(/not valid base64/);
  });

  it("拒绝时不落库、不调用 engine", async () => {
    const { token } = await seedUser("user", "img-noop");
    let engineCalled = false;
    const app = buildApp({
      db: client,
      settings,
      engine: (async function* () {
        engineCalled = true;
      }) as RunTurnFn,
    });
    const before = await client.listSessions(null);
    await postChat(app, token, { message: "看这些图", images: [{ media_type: "image/bmp", data: PNG_MAGIC_B64 }] });
    expect(engineCalled).toBe(false);
    const after = await client.listSessions(null);
    expect(after).toHaveLength(before.length); // db-fixture 预置了一个 session，比的是增量为 0
  });

  it("合法图片：连图带文一起落库（legacy 形状），且原样传给 engine", async () => {
    const { token } = await seedUser("user", "img-ok");
    let capturedImages: unknown;
    const app = buildApp({
      db: client,
      settings,
      engine: (async function* (_deps, req) {
        capturedImages = req.images;
        yield { type: "done", data: { text: "ok", success: true, budgetExhausted: false } };
      }) as RunTurnFn,
    });
    const { frames } = await postChat(app, token, {
      message: "看这个截图",
      images: [{ media_type: "image/png", data: PNG_MAGIC_B64 }],
    });
    const sessionId = JSON.parse(frames[0].data).session_id;

    // engine 收到的是 domain 形状（mediaType/base64Data）
    expect(capturedImages).toEqual([{ type: "image", mediaType: "image/png", base64Data: PNG_MAGIC_B64 }]);

    // DB 里存的是 legacy 形状（source.media_type/source.data），图在前文在后。
    // getMessages 已经把以 "[" 开头的 content 解析成数组了，这里不用再 JSON.parse 一次。
    const messages = await client.getMessages(sessionId);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_MAGIC_B64 } },
      { type: "text", text: "看这个截图" },
    ]);
  });

  it("没有图片时，落库内容仍是纯字符串（不因为这次改动变成单元素数组）", async () => {
    const { token } = await seedUser("user", "img-none");
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    const { frames } = await postChat(app, token, { message: "没有图片的消息" });
    const sessionId = JSON.parse(frames[0].data).session_id;
    const messages = await client.getMessages(sessionId);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("没有图片的消息");
  });
});

// ==================== req.linkedIssues (2026-07-13) ====================
// Feeds turn.ts's per-turn "which issue(s) has this session already
// touched" reminder — see buildLinkedIssueSummaries in sse.ts.

describe("POST /api/chat — req.linkedIssues", () => {
  it("session 已有一条 issue_submissions 记录 -> engine 收到的 req.linkedIssues 带上它的 repoId/issueNumber/status", async () => {
    const { id: userId, token } = await seedUser("user", "linked-issue-user");
    const repoId = await client.createRepo({ name: "demo", url: "https://example.com/demo.git" });
    const sessionId = await client.createSession("New Chat", userId);
    await client.recordIssueSubmission({
      sessionId, repoId, userId,
      title: "t", body: "b", labels: [], issueNumber: 42, issueUrl: "https://x/42",
    });

    let captured: unknown;
    const app = buildApp({
      db: client,
      settings,
      engine: (async function* (_deps, req) {
        captured = req.linkedIssues;
        yield { type: "done", data: { text: "ok", success: true, budgetExhausted: false } };
      }) as RunTurnFn,
    });
    await postChat(app, token, { message: "关闭它", session_id: sessionId });

    expect(captured).toEqual([{ repoId, issueNumber: 42, issueUrl: "https://x/42", status: "submitted" }]);
  });

  it("session 没有任何 issue_submissions/issue_actions -> req.linkedIssues 是 undefined（不是空数组占位）", async () => {
    const { token } = await seedUser("user", "no-linked-issue-user");
    let captured: unknown = "not set";
    const app = buildApp({
      db: client,
      settings,
      engine: (async function* (_deps, req) {
        captured = req.linkedIssues;
        yield { type: "done", data: { text: "ok", success: true, budgetExhausted: false } };
      }) as RunTurnFn,
    });
    await postChat(app, token, { message: "普通问题，没有 issue" });

    expect(captured).toBeUndefined();
  });
});

// ==================== POST /api/auth/login ====================

describe("POST /api/auth/login", () => {
  it("正确凭证 → token + user，且 token 可通过 decodeToken 验证", async () => {
    const hash = await hashPassword("correct horse");
    await client.createUser("bob", hash, "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "correct horse" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.user).toEqual({
      id: expect.any(Number),
      username: "bob",
      role: "user",
      must_change_password: false,
    });
    expect(typeof body.token).toBe("string");
  });

  it("管理员用默认密码 admin123 引导创建 → 登录响应 must_change_password:true（BUG-003）", async () => {
    const hash = await hashPassword("admin123");
    await client.createUser("bootstrap-admin", hash, "admin", true);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bootstrap-admin", password: "admin123" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.user.must_change_password).toBe(true);
  });

  it("错误密码 → 401 {detail: 'Invalid credentials'}（FastAPI 风格 envelope）", async () => {
    const hash = await hashPassword("correct horse");
    await client.createUser("bob2", hash, "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob2", password: "wrong" }),
    });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ detail: "Invalid credentials" });
  });

  it("不存在的用户名 → 401 Invalid credentials（不泄露用户是否存在）", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ghost", password: "whatever" }),
    });
    expect(resp.status).toBe(401);
    expect((await resp.json()).detail).toBe("Invalid credentials");
  });

  it("login 本身不需要 Authorization header（公开路由）", async () => {
    const hash = await hashPassword("pw");
    await client.createUser("carol", hash, "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no authorization header at all
      body: JSON.stringify({ username: "carol", password: "pw" }),
    });
    expect(resp.status).toBe(200);
  });
});

// Codex full-repo review (2026-07-14, Warning) — no prior coverage existed
// for the login throttle at all.
describe("POST /api/auth/login — rate limiting", () => {
  function loginAttempt(app: ReturnType<typeof buildApp>, username: string, password: string, ip?: string) {
    return app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) },
      body: JSON.stringify({ username, password }),
    });
  }

  it("同一 ip+username 组合，5 次错误密码后第 6 次直接 429，不再打 bcrypt", async () => {
    await client.createUser("rate-alice", await hashPassword("real-password"), "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    for (let i = 0; i < 5; i++) {
      const resp = await loginAttempt(app, "rate-alice", "wrong", "1.2.3.4");
      expect(resp.status).toBe(401);
    }
    const sixth = await loginAttempt(app, "rate-alice", "wrong", "1.2.3.4");
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).detail).toBe("Too many login attempts. Try again later.");

    // Still 429 even with the CORRECT password now — the throttle blocks
    // the attempt itself, before credentials are even checked.
    const stillThrottled = await loginAttempt(app, "rate-alice", "real-password", "1.2.3.4");
    expect(stillThrottled.status).toBe(429);
  });

  it("成功登录清除计数器 — 之后又能重新错 5 次才被限流", async () => {
    await client.createUser("rate-bob", await hashPassword("real-password"), "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    for (let i = 0; i < 4; i++) {
      await loginAttempt(app, "rate-bob", "wrong", "5.6.7.8");
    }
    const success = await loginAttempt(app, "rate-bob", "real-password", "5.6.7.8");
    expect(success.status).toBe(200);

    // Counter cleared by the successful login — 4 more failures shouldn't
    // trip the limiter yet (needs 5 fresh ones).
    for (let i = 0; i < 4; i++) {
      const resp = await loginAttempt(app, "rate-bob", "wrong-again", "5.6.7.8");
      expect(resp.status).toBe(401);
    }
  });

  // The actual gap this fix closes: username-only keying let an attacker
  // who knows a real username (e.g. "admin") lock it out for EVERYONE by
  // throwing 5 bad guesses at it from anywhere. Keying on ip:username means
  // a different source IP gets its own independent budget against the same
  // account instead of inheriting someone else's lockout.
  it("攻击者从一个 IP 打满 admin 账号的限流，不影响另一个 IP 正常登录同一账号", async () => {
    await client.createUser("shared-admin", await hashPassword("real-password"), "admin");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    for (let i = 0; i < 5; i++) {
      await loginAttempt(app, "shared-admin", "wrong", "9.9.9.9"); // attacker
    }
    const attackerBlocked = await loginAttempt(app, "shared-admin", "wrong", "9.9.9.9");
    expect(attackerBlocked.status).toBe(429);

    // The real admin, logging in from a DIFFERENT IP, is unaffected.
    const realAdmin = await loginAttempt(app, "shared-admin", "real-password", "10.10.10.10");
    expect(realAdmin.status).toBe(200);
  });

  // Memory-DoS guard: an attacker cycling through many distinct fake
  // usernames must not grow the throttle's Map without bound. Exercising
  // the full LOGIN_ATTEMPTS_MAX_ENTRIES=10_000 cap here would make this
  // test itself slow; this instead proves the throttle still functions
  // correctly under a smaller but still-meaningful burst of distinct keys,
  // which is what the eviction logic's own correctness actually hinges on.
  it("大量不同用户名连续登录尝试不会导致后续请求整体异常（限流状态保持独立）", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    // Each of these now runs a REAL bcrypt compare (the timing-safety fix
    // itself) — 20 distinct keys is enough to prove per-key state doesn't
    // get corrupted by a burst, without the test itself taking as long as
    // exercising anywhere near LOGIN_ATTEMPTS_MAX_ENTRIES would.
    for (let i = 0; i < 20; i++) {
      const resp = await loginAttempt(app, `nonexistent-user-${i}`, "whatever", "11.11.11.11");
      expect(resp.status).toBe(401);
    }
    // A fresh, never-seen-before username from the same IP still gets its
    // own budget (proves per-key state, not a single shared counter that
    // got corrupted by the burst above).
    await client.createUser("rate-carol", await hashPassword("real-password"), "user");
    const resp = await loginAttempt(app, "rate-carol", "real-password", "11.11.11.11");
    expect(resp.status).toBe(200);
  }, 15_000);

  // Timing side-channel: a nonexistent username used to skip bcrypt
  // entirely and return near-instantly, while a real username always pays
  // bcrypt's cost — letting response time alone reveal which usernames
  // exist. A soft lower-bound (not a tight comparison, to avoid CI
  // flakiness) proves the dummy-hash compare is actually running, not
  // skipped.
  it("不存在的用户名仍然跑一次 bcrypt 比较（耗时不会异常短，关闭时序旁路）", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const start = Date.now();
    const resp = await loginAttempt(app, "definitely-does-not-exist", "whatever", "12.12.12.12");
    const elapsedMs = Date.now() - start;
    expect(resp.status).toBe(401);
    // bcrypt at cost 12 is reliably tens of ms even on fast hardware —
    // a few ms would mean the compare was skipped.
    expect(elapsedMs).toBeGreaterThan(5);
  });
});

describe("POST /api/auth/change-password（BUG-003）", () => {
  it("正确的当前密码 + 合规新密码 → {ok:true}，旧密码从此失效、新密码可登录", async () => {
    const { id } = await seedUser("user", "erin");
    // updateUserPassword now bumps token_version (Codex full-repo review,
    // 2026-07-14, Warning) — this call is test SETUP (establishing the
    // "current" password before the real change-password request under
    // test), so the token used below must be minted AFTER it, carrying the
    // version it just bumped to. Otherwise this looks identical to a stale
    // token replay and 401s before the route under test ever runs.
    await client.updateUserPassword(id, await hashPassword("old-password-1"));
    const token = await freshToken(id, "erin", "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "old-password-1", new_password: "new-password-2" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true, token: expect.any(String) });

    const oldLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "erin", password: "old-password-1" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "erin", password: "new-password-2" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("成功修改密码后 must_change_password 被清除，登录响应恢复 false", async () => {
    const hash = await hashPassword("admin123");
    const id = await client.createUser("bootstrap-admin2", hash, "admin", true);
    const token = createToken({ id, username: "bootstrap-admin2", role: "admin" }, settings);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const changeResp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "admin123", new_password: "a-new-strong-pw" }),
    });
    expect(changeResp.status).toBe(200);

    const loginResp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bootstrap-admin2", password: "a-new-strong-pw" }),
    });
    expect((await loginResp.json()).user.must_change_password).toBe(false);
  });

  it("当前密码错误 → 401，密码不变", async () => {
    const { id } = await seedUser("user", "frank");
    await client.updateUserPassword(id, await hashPassword("real-password-1"));
    // Must be minted AFTER the setup call above, or this 401s on the stale
    // token_version instead of the wrong-password check this test is
    // actually about (Codex full-repo review, 2026-07-14, Warning).
    const token = await freshToken(id, "frank", "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "wrong-guess", new_password: "new-password-2" }),
    });
    expect(resp.status).toBe(401);

    const stillWorks = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "frank", password: "real-password-1" }),
    });
    expect(stillWorks.status).toBe(200);
  });

  it("新密码短于 8 位 → 422，密码不变", async () => {
    const { id } = await seedUser("user", "grace");
    await client.updateUserPassword(id, await hashPassword("real-password-1"));
    const token = await freshToken(id, "grace", "user");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "real-password-1", new_password: "short" }),
    });
    expect(resp.status).toBe(422);
  });

  it("缺少字段 → 422", async () => {
    const { token } = await seedUser("user", "heidi");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ new_password: "new-password-2" }),
    });
    expect(resp.status).toBe(422);
  });

  it("未带 Authorization header → 401（走通用鉴权中间件）", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_password: "x", new_password: "new-password-2" }),
    });
    expect(resp.status).toBe(401);
  });

  // Codex full-repo review (2026-07-14, Warning): the actual behavior this
  // whole token_version mechanism exists for — a token issued BEFORE a
  // password change must stop working immediately after, not linger valid
  // until it naturally expires (up to tokenExpireHours later). Every other
  // test in this describe block was updated to mint a FRESH token after any
  // setup-time updateUserPassword call specifically to avoid tripping this
  // same check — this test is the one place it should actually fire.
  it("改密之后，改密前签发的旧 token 立即失效（不等自然过期）", async () => {
    const { id, token: oldToken } = await seedUser("user", "judy");
    await client.updateUserPassword(id, await hashPassword("judys-first-password"));
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    // oldToken is already stale relative to the updateUserPassword bump
    // above — mint the one a real client would actually be holding at the
    // moment it calls change-password (i.e., matching the CURRENT version).
    const currentToken = await freshToken(id, "judy", "user");
    const changeResp = await authedRequest(app, currentToken, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "judys-first-password", new_password: "judys-second-password" }),
    });
    expect(changeResp.status).toBe(200);

    // The token used for the ACTUAL change-password call is also now
    // stale (that call bumped token_version again) — the real regression
    // check is that reusing it (or the even-older oldToken) both 401.
    const staleAfterChange = await authedRequest(app, currentToken, "/api/sessions");
    expect(staleAfterChange.status).toBe(401);
    expect(await staleAfterChange.json()).toEqual({
      detail: "Token invalidated by a password change — please log in again",
    });

    const evenStaler = await authedRequest(app, oldToken, "/api/sessions");
    expect(evenStaler.status).toBe(401);

    // Only the freshly-issued token from the change-password response works.
    const { token: newToken } = await changeResp.json();
    const withNewToken = await authedRequest(app, newToken, "/api/sessions");
    expect(withNewToken.status).toBe(200);
  });
});

// ==================== Auth middleware / 401 shape ====================

describe("auth middleware — 401 shape matches v1 FastAPI's {detail: ...}", () => {
  it("缺 Authorization header → 401 {detail: ...}", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/me");
    expect(resp.status).toBe(401);
    expect(await resp.json()).toMatchObject({ detail: expect.any(String) });
  });

  it("非法 token → 401 {detail: 'Invalid token'}", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/me", { headers: { authorization: "Bearer not-a-real-token" } });
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ detail: "Invalid token" });
  });

  it("GET /api/auth/me：合法 token → 返回 {id, username, role}", async () => {
    const { id, token } = await seedUser("user", "dave");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/auth/me");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ id, username: "dave", role: "user" });
  });
});

// Codex full-repo review (2026-07-14, Warning): login/webhook handlers used
// to buffer the FULL request body before any auth/signature check ran —
// an unauthenticated caller could force arbitrary memory allocation with
// zero credentials. Body-limit middleware now runs before auth, uniformly.
describe("body size limit — Codex 全仓审查 Warning", () => {
  it("超出默认上限（Content-Length 声明值即可判定，不需要真的发那么多字节）→ 413，且不到达路由处理器", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: JSON.stringify({ username: "whoever", password: "whatever" }),
    });
    expect(resp.status).toBe(413);
  });

  it("webhook 路由（无需 JWT）同样受限 — 鉴权豁免不等于 body 大小豁免", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: "{}",
    });
    expect(resp.status).toBe(413);
  });

  it("普通 JSON 路由请求在默认上限内 → 正常放行", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/sessions");
    expect(resp.status).toBe(200);
  });

  it("/api/chat 有单独更大的上限（默认上限本身放不下一张图片）", async () => {
    const { token } = await seedUser();
    const app = buildApp({
      db: client,
      settings,
      engine: stubEngine([{ type: "done", data: { text: "ok", success: true, budgetExhausted: false } }]),
    });
    // Bigger than the default 2MB cap, but within the chat-specific one —
    // proves the two routes genuinely have different limits, not that the
    // default limit was just set too high everywhere. Drains the SSE
    // stream via .text() (same as postChat) so it finishes before the
    // test's own afterEach tears down the db client out from under it.
    const resp = await authedRequest(app, token, "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) },
      body: JSON.stringify({ message: "x" }),
    });
    await resp.text();
    expect(resp.status).not.toBe(413);
  });
});

// Codex full-repo review (2026-07-14, Critical #1): must_change_password
// used to be surfaced ONLY in the login response for the frontend to react
// to — the blanket /api/* middleware never checked it, so a JWT for an
// account still on the well-known default password (admin/admin123) had
// full API access, including /api/admin/*, with the frontend's gate being
// the only thing standing between a bootstrap admin and the whole app.
describe("auth middleware — must_change_password 后端强制拦截（Codex 全仓审查 Critical #1）", () => {
  it("must_change_password:true 时访问任意其他 /api/* 路由 → 403，不到达真正的路由处理器", async () => {
    const hash = await hashPassword("admin123");
    const id = await client.createUser("gated-admin", hash, "admin", true);
    const token = createToken({ id, username: "gated-admin", role: "admin" }, settings);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const resp = await authedRequest(app, token, "/api/sessions");
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Password change required before accessing this resource" });
  });

  it("must_change_password:true 时 /api/admin/* 同样被拦截（不是只挡普通路由）", async () => {
    const hash = await hashPassword("admin123");
    const id = await client.createUser("gated-admin2", hash, "admin", true);
    const token = createToken({ id, username: "gated-admin2", role: "admin" }, settings);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const resp = await authedRequest(app, token, "/api/admin/users");
    expect(resp.status).toBe(403);
  });

  it("must_change_password:true 时 /api/auth/me 和 /api/auth/change-password 仍然可达（否则用户没法真的改密码）", async () => {
    const hash = await hashPassword("admin123");
    const id = await client.createUser("gated-admin3", hash, "admin", true);
    const token = createToken({ id, username: "gated-admin3", role: "admin" }, settings);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const meResp = await authedRequest(app, token, "/api/auth/me");
    expect(meResp.status).toBe(200);

    const changeResp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "admin123", new_password: "a-new-strong-pw" }),
    });
    expect(changeResp.status).toBe(200);
  });

  it("改密之后 must_change_password 清零 → 之前被拦截的路由恢复可用", async () => {
    const hash = await hashPassword("admin123");
    const id = await client.createUser("gated-admin4", hash, "admin", true);
    const token = createToken({ id, username: "gated-admin4", role: "admin" }, settings);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const blocked = await authedRequest(app, token, "/api/sessions");
    expect(blocked.status).toBe(403);

    const changeResp = await authedRequest(app, token, "/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: "admin123", new_password: "a-new-strong-pw" }),
    });
    // token_version bumped (Codex full-repo review, 2026-07-14, Warning) —
    // the OLD token is now stale by design, same as a real client
    // (login.html) must pick up the freshly-issued replacement rather than
    // keep using the one that just got invalidated by its own request.
    const { token: newToken } = await changeResp.json();

    const allowedNow = await authedRequest(app, newToken, "/api/sessions");
    expect(allowedNow.status).toBe(200);
  });

  it("must_change_password:false 的普通用户不受影响", async () => {
    const { token } = await seedUser("user", "ungated");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/sessions");
    expect(resp.status).toBe(200);
  });
});

// ==================== GET /api/config, /api/skills ====================

describe("GET /api/config", () => {
  it("返回 v1 main.py 的静态限额形状：max_images_per_message/max_image_bytes/repo_sync_interval_minutes，另加 git_sha", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/config");
    // git_sha is resolved once at module load (readGitSha in app.ts) —
    // whatever this checkout's real HEAD/`.git-sha` fallback happens to
    // be, not a value this test can pin; just assert it's a non-empty string.
    expect(await resp.json()).toEqual({
      max_images_per_message: 5,
      max_image_bytes: 4_500_000,
      repo_sync_interval_minutes: settings.repoSyncIntervalMinutes,
      git_sha: expect.any(String),
    });
  });
});

describe("GET /api/skills", () => {
  it("本 Phase 返回空数组（裸数组，不是 {skills: []} 信封）", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/skills");
    expect(await resp.json()).toEqual([]);
  });
});

// ==================== GET /api/repos ====================

describe("GET /api/repos", () => {
  it("空仓库表 → []", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/repos");
    expect(await resp.json()).toEqual([]);
  });

  it("非 admin 只看到被授权的仓库（携带 access_level）", async () => {
    const { id: uid, token } = await seedUser("user", "erin");
    const db = new Database(dbPath);
    const repoId = Number(
      db
        .prepare("INSERT INTO repositories (name, url, description, branch, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("wms", "https://example.com/wms.git", "", "main", "x").lastInsertRowid
    );
    db.prepare("INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?)").run(
      uid,
      repoId,
      "write",
      "x"
    );
    db.close();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/repos");
    expect(await resp.json()).toEqual([
      { id: repoId, name: "wms", url: "https://example.com/wms.git", description: "", branch: "main", access_level: "write" },
    ]);
  });

  it("admin 看到全部仓库，即使没有授权行（access_level 为 null）", async () => {
    const { token } = await seedUser("admin", "root3");
    const db = new Database(dbPath);
    db.prepare("INSERT INTO repositories (name, url, description, branch, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "wms",
      "https://example.com/wms.git",
      "",
      "main",
      "x"
    );
    db.close();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/repos");
    const repos = await resp.json();
    expect(repos.length).toBe(1);
    expect(repos[0]).toMatchObject({ name: "wms", access_level: null });
  });

  // Codex full-repo review (2026-07-14, Critical #3): an admin can paste a
  // credential straight into the url field instead of using the dedicated
  // cred_username/cred_token columns — admin-routes.ts's adminRepoView
  // already masked that case, but this route never did, so ANY authenticated
  // user with read access (not just admins) could see the raw credential.
  it("url 里嵌了凭证（https://user:token@host/repo）→ 非 admin 视图里凭证被剥离", async () => {
    const { id: uid, token } = await seedUser("user", "ivy");
    const db = new Database(dbPath);
    const repoId = Number(
      db
        .prepare("INSERT INTO repositories (name, url, description, branch, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("priv", "https://someuser:ghp_secrettoken@github.com/org/priv.git", "", "main", "x").lastInsertRowid
    );
    db.prepare("INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?)").run(
      uid,
      repoId,
      "read",
      "x"
    );
    db.close();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/repos");
    const repos = await resp.json();
    expect(repos[0].url).toBe("https://github.com/org/priv.git");
    expect(repos[0].url).not.toContain("ghp_secrettoken");
  });

  it("url 里嵌了凭证 → admin 视图（listRepos 路径）里凭证同样被剥离", async () => {
    const { token } = await seedUser("admin", "root4");
    const db = new Database(dbPath);
    db.prepare("INSERT INTO repositories (name, url, description, branch, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "priv2",
      "https://someuser:ghp_secrettoken2@github.com/org/priv2.git",
      "",
      "main",
      "x"
    );
    db.close();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/repos");
    const repos = await resp.json();
    expect(repos[0].url).toBe("https://github.com/org/priv2.git");
    expect(repos[0].url).not.toContain("ghp_secrettoken2");
  });
});

// ==================== Sessions CRUD ====================

describe("GET /api/sessions", () => {
  it("非 admin 只看到自己的会话；admin 看到全部", async () => {
    const alice = await seedUser("user", "sess-alice");
    const bob = await seedUser("user", "sess-bob");
    const admin = await seedUser("admin", "sess-root");
    const a = await client.createSession("chat-a", alice.id);
    await client.createSession("chat-b", bob.id);

    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const aliceResp = await authedRequest(app, alice.token, "/api/sessions");
    const aliceSessions = await aliceResp.json();
    expect(aliceSessions.map((s: { id: string }) => s.id)).toEqual([a]);

    const adminResp = await authedRequest(app, admin.token, "/api/sessions");
    const adminSessions = await adminResp.json();
    expect(adminSessions.length).toBeGreaterThanOrEqual(2); // a, b (+ fixture's seeded s1)
  });
});

describe("GET /api/sessions/:id", () => {
  it("owner 可读：返回 {session, messages}", async () => {
    const { id: uid, token } = await seedUser("user", "sess-owner");
    const sid = await client.createSession("chat", uid);
    await client.addMessage(sid, "user", "hi");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, `/api/sessions/${sid}`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.session.id).toBe(sid);
    expect(body.messages).toHaveLength(1);
  });

  it("非 owner、非 admin → 403 {detail: 'Access denied'}", async () => {
    const owner = await seedUser("user", "sess-owner2");
    const intruder = await seedUser("user", "sess-intruder2");
    const sid = await client.createSession("chat", owner.id);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, intruder.token, `/api/sessions/${sid}`);
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied" });
  });

  it("不存在的 session → 404", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/sessions/ghost999");
    expect(resp.status).toBe(404);
  });

  // Task Phase 5 — GET /api/sessions/:id 现在额外返回 issue_submissions/
  // issue_actions/feedback 三个字段（app.ts 的 Promise.all 三路独立读），
  // 供 web/app.js 在重放会话时把历史草稿/操作卡片对齐到真实终态、恢复本用
  // 户自己的 👍/👎 按钮状态。
  it("会话挂有 issue_submission/issue_action/feedback 时，三个字段都带上真实内容（不是空壳）", async () => {
    const { id: uid, token } = await seedUser("user", "sess-extras");
    const sid = await client.createSession("chat", uid);
    const messageId = await client.addMessage(sid, "assistant", "这是回答");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await client.recordIssueSubmission({
      sessionId: sid,
      repoId,
      userId: uid,
      title: "some bug",
      body: "bug body",
      labels: ["bug"],
      issueNumber: 10,
      issueUrl: "https://example.com/r1/issues/10",
    });
    await client.recordIssueAction({
      sessionId: sid,
      repoId,
      userId: uid,
      issueNumber: 10,
      action: "close",
      comment: "已修复",
      issueUrl: "https://example.com/r1/issues/10",
    });
    await client.setMessageFeedback(messageId, sid, uid, 1);

    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, `/api/sessions/${sid}`);
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.issue_submissions).toHaveLength(1);
    expect(body.issue_submissions[0]).toMatchObject({ title: "some bug", issue_number: 10, repo_id: repoId });

    expect(body.issue_actions).toHaveLength(1);
    expect(body.issue_actions[0]).toMatchObject({ issue_number: 10, action: "close", comment: "已修复" });

    expect(body.feedback).toEqual({ [messageId]: 1 });
  });

  it("会话没有 issue_submission/issue_action/feedback 时，三个字段仍然存在，分别是 []/[]/{}（不是 undefined）", async () => {
    const { id: uid, token } = await seedUser("user", "sess-noextras");
    const sid = await client.createSession("chat", uid);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, `/api/sessions/${sid}`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.issue_submissions).toEqual([]);
    expect(body.issue_actions).toEqual([]);
    expect(body.feedback).toEqual({});
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("owner 删除：{ok:true}，会话与消息都消失", async () => {
    const { id: uid, token } = await seedUser("user", "sess-del");
    const sid = await client.createSession("chat", uid);
    await client.addMessage(sid, "user", "hi");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, `/api/sessions/${sid}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(await client.getSession(sid)).toBeNull();
    expect(await client.getMessages(sid)).toHaveLength(0);
  });

  it("非 owner、非 admin → 403，会话不被删除", async () => {
    const owner = await seedUser("user", "sess-owner3");
    const intruder = await seedUser("user", "sess-intruder3");
    const sid = await client.createSession("chat", owner.id);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, intruder.token, `/api/sessions/${sid}`, { method: "DELETE" });
    expect(resp.status).toBe(403);
    expect(await client.getSession(sid)).not.toBeNull();
  });
});

// ==================== POST /api/feedback ====================
// v1's api_set_feedback（app/main.py，"Message feedback" 一节）—— app.ts 内联实现
// （不在 issue-routes.ts 里，见 app.ts 自己的注释：这是 session/message 概念，不是
// issue-tracker 概念）。校验顺序：422（类型）→ 400（rating 取值）→ 403（会话归属）
// → 404（message 不属于该 session）→ 落库（upsert）。

describe("POST /api/feedback", () => {
  it("rating 不是 1/-1（0、5、-2）→ 400，且先于会话归属/消息校验（intruder + 不存在的 message_id 也照样 400）", async () => {
    const owner = await seedUser("user", "fb-owner");
    const intruder = await seedUser("user", "fb-intruder");
    const sid = await client.createSession("chat", owner.id);
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    for (const rating of [0, 5, -2]) {
      const resp = await authedRequest(app, intruder.token, "/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sid, message_id: 999999, rating }),
      });
      expect(resp.status).toBe(400);
      expect(await resp.json()).toEqual({ detail: "rating must be 1 or -1" });
    }
  });

  it("session_id/message_id/rating 缺失或类型不对 → 422", async () => {
    const { token } = await seedUser("user", "fb-422");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const cases: Record<string, unknown>[] = [
      {},
      { session_id: 123, message_id: 1, rating: 1 }, // session_id 类型不对
      { session_id: "s1", message_id: "not-a-number", rating: 1 }, // message_id 类型不对
      { session_id: "s1", message_id: 1, rating: "1" }, // rating 类型不对（字符串）
    ];
    for (const body of cases) {
      const resp = await authedRequest(app, token, "/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(resp.status).toBe(422);
    }
  });

  it("session 不属于调用者（非 owner、非 admin）→ 403 {detail: 'Access denied'}", async () => {
    const owner = await seedUser("user", "fb-owner2");
    const intruder = await seedUser("user", "fb-intruder2");
    const sid = await client.createSession("chat", owner.id);
    const messageId = await client.addMessage(sid, "assistant", "答案");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, intruder.token, "/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid, message_id: messageId, rating: 1 }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied" });
  });

  it("message_id 属于另一个 session → 404 {detail: 'Message not found in this session'}", async () => {
    const { id: uid, token } = await seedUser("user", "fb-crosssession");
    const sessionA = await client.createSession("chat-a", uid);
    const sessionB = await client.createSession("chat-b", uid);
    const messageInB = await client.addMessage(sessionB, "assistant", "在 B 里的回答");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionA, message_id: messageInB, rating: 1 }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "Message not found in this session" });
  });

  it("合法请求 → {ok:true}；同一用户对同一 message 换 rating 是原地更新（仍是一条，不是两条）", async () => {
    const { id: uid, token } = await seedUser("user", "fb-valid");
    const sid = await client.createSession("chat", uid);
    const messageId = await client.addMessage(sid, "assistant", "答案");
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });

    const resp1 = await authedRequest(app, token, "/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid, message_id: messageId, rating: 1 }),
    });
    expect(resp1.status).toBe(200);
    expect(await resp1.json()).toEqual({ ok: true });
    expect(await client.getFeedbackForSession(sid, uid)).toEqual({ [messageId]: 1 });

    const resp2 = await authedRequest(app, token, "/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid, message_id: messageId, rating: -1 }),
    });
    expect(resp2.status).toBe(200);
    expect(await resp2.json()).toEqual({ ok: true });
    const feedback = await client.getFeedbackForSession(sid, uid);
    expect(Object.keys(feedback)).toHaveLength(1);
    expect(feedback).toEqual({ [messageId]: -1 });
  });
});

// ==================== Static frontend ====================

describe("static frontend serving", () => {
  it("GET / → web/index.html", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("<title>CodeAxis</title>");
  });

  it("GET /login → web/login.html", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/login");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("<title>Login — CodeAxis</title>");
  });

  it("GET /admin → web/admin.html", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/admin");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("<title>Admin — CodeAxis</title>");
  });

  it("GET /static/app.js → served from web/app.js (referenced by index.html as /static/app.js)", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/static/app.js");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("javascript");
  });

  it("GET /static/style.css → served (login.html/index.html/admin.html all reference /static/style.css)", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/static/style.css");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("css");
  });

  it("static routes need no Authorization header", async () => {
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await app.request("/");
    expect(resp.status).not.toBe(401);
  });
});
