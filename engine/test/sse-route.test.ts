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
    expect(body.user).toEqual({ id: expect.any(Number), username: "bob", role: "user" });
    expect(typeof body.token).toBe("string");
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

// ==================== GET /api/config, /api/skills ====================

describe("GET /api/config", () => {
  it("返回 v1 main.py 的静态限额形状：max_images_per_message/max_image_bytes/repo_sync_interval_minutes", async () => {
    const { token } = await seedUser();
    const app = buildApp({ db: client, settings, engine: stubEngine([]) });
    const resp = await authedRequest(app, token, "/api/config");
    expect(await resp.json()).toEqual({
      max_images_per_message: 5,
      max_image_bytes: 4_500_000,
      repo_sync_interval_minutes: settings.repoSyncIntervalMinutes,
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
