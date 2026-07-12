// Task 6 — end-to-end smoke test: a REAL server (src/server/main.ts's
// startServer(), the exact composition `npm start` uses) driving the REAL
// runTurn engine, over REAL HTTP/SSE, against nothing but an offline mock
// LLM (test/mock-anthropic.ts) and a tmp sqlite db. Every layer exercised
// individually by Tasks 1-5's tests (auth, schema, tools, turn engine, SSE
// route) gets proven end-to-end here in one path — this is what closes
// Phase 3: after this test is green, the product runs on Node.
//
// "no leaked handles" is itself part of the assertion (see the brief): if
// startServer()'s stop() doesn't actually close the HTTP server and the db
// worker thread, `npm test` (vitest run, not watch mode) hangs after
// printing results instead of exiting — that failure mode wouldn't show up
// as a red assertion, it'd show up as the test command never returning.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../src/server/main.js";
import { startMock, textThenToolTurn, textTurn, type MockServer } from "./mock-anthropic.js";

// ==================== SSE frame parsing (mirrors sse-route.test.ts's own parser) ====================

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

/** Manually drains a real fetch Response body via its raw reader (rather
 * than `.text()`) — the brief's explicit ask, so this test exercises actual
 * chunked streaming over the wire rather than just a fully-buffered body. */
async function readFullStream(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// ==================== Fixture lifecycle ====================

let mock: MockServer | undefined;
let dir: string | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  // Order doesn't matter for correctness (independent resources) but stop()
  // is the one under test here — let it run before the mock/tmp-dir teardown
  // so a failure in stop() itself isn't masked by cleanup ordering.
  await started?.stop();
  await mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  started = undefined;
  mock = undefined;
  dir = undefined;
});

describe("e2e smoke — real server + real runTurn engine against an offline mock LLM", () => {
  it("login → chat (SSE, text+tool_use+tool_result+text) → session replay → delete, then a clean shutdown with no leaked handles", async () => {
    // A leading text block ("算一下") then a tool_use block in ONE assistant
    // turn, followed by a plain text turn — the exact script named in the
    // brief, and the same shape turn-engine.test.ts's "2. 工具回合" case
    // proves out at the runTurn layer alone. Driving it through the real
    // HTTP surface here is what's new.
    mock = startMock([
      textThenToolTurn("算一下", "calculator", { expression: "1+1" }, "tu_1"),
      textTurn("答案是2"),
    ]);
    dir = mkdtempSync(join(tmpdir(), "codeaxis-e2e-"));
    const dbPath = join(dir, "agent_data.db");

    started = await startServer({
      env: {
        APP_JWT_SECRET: "e2e-smoke-test-secret-do-not-use-in-prod",
        APP_DB_PATH: dbPath,
        APP_PORT: "0", // ephemeral — parallel test files must not collide on a fixed port
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: "sk-mock-offline-not-a-real-key",
        ANTHROPIC_MODEL: "mock",
      },
    });
    const base = `http://127.0.0.1:${started.port}`;

    // ---- static frontend: GET / → 200 html (login-redirect is client-side
    // JS in web/app.js; the server route itself always serves index.html) ----
    const indexResp = await fetch(`${base}/`);
    expect(indexResp.status).toBe(200);
    expect(indexResp.headers.get("content-type")).toContain("html");
    await indexResp.text();

    // ---- POST /api/auth/login — admin/admin123 bootstrap (ensureAdminUser
    // ran during startServer() against the fresh tmp db) ----
    const loginResp = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    expect(loginResp.status).toBe(200);
    const loginBody = (await loginResp.json()) as { token: string; user: { username: string; role: string } };
    expect(loginBody.user).toEqual({ id: expect.any(Number), username: "admin", role: "admin" });
    const token = loginBody.token;
    expect(typeof token).toBe("string");

    // ---- POST /api/chat — real runTurn, real SSE, over real HTTP ----
    const chatResp = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "帮我算一下 1+1" }),
    });
    expect(chatResp.status).toBe(200);
    expect(chatResp.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseFrames(await readFullStream(chatResp));

    expect(frames.map((f) => f.event)).toEqual([
      "session",
      "text",
      "tool_use",
      "tool_result",
      "text",
      "done",
      "end",
    ]);

    const sessionFrame = JSON.parse(frames[0].data) as { session_id: string; reason: string | null };
    expect(sessionFrame.reason).toBe("new");
    expect(sessionFrame.session_id).toBeTruthy();
    const sessionId = sessionFrame.session_id;

    expect(JSON.parse(frames[1].data)).toEqual({ text: "算一下" });
    expect(JSON.parse(frames[2].data)).toEqual({ id: "tu_1", name: "calculator", input: { expression: "1+1" } });
    expect(JSON.parse(frames[3].data)).toEqual({ id: "tu_1", name: "calculator", result: "2" });
    expect(JSON.parse(frames[4].data)).toEqual({ text: "答案是2" });

    const done = JSON.parse(frames[5].data) as {
      session_id: string;
      text: string;
      message_id: number | null;
      budget_exhausted: boolean;
    };
    expect(done.session_id).toBe(sessionId);
    expect(done.text).toBe("算一下答案是2"); // wire's fullText: every text_delta this turn, concatenated
    expect(done.message_id).not.toBeNull();
    expect(done.budget_exhausted).toBe(false);
    expect(frames[6].data).toBe("");

    // ---- GET /api/sessions/{id} — replay shows the user/assistant pair
    // PLUS the tool_exchange pair persisted mid-stream (4 rows total) ----
    const replayResp = await fetch(`${base}/api/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replayResp.status).toBe(200);
    const replay = (await replayResp.json()) as {
      session: { id: string };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(replay.session.id).toBe(sessionId);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(replay.messages[0].content).toBe("帮我算一下 1+1");
    expect(replay.messages[1].content).toEqual([
      { type: "text", text: "算一下" },
      { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } },
    ]);
    expect(replay.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "2" }]);
    expect(replay.messages[3].content).toBe("答案是2");

    // ---- DELETE /api/sessions/{id} ----
    const deleteResp = await fetch(`${base}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteResp.status).toBe(200);
    expect(await deleteResp.json()).toEqual({ ok: true });

    const goneResp = await fetch(`${base}/api/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(goneResp.status).toBe(404);

    // ---- shut down cleanly; afterEach also calls stop() but doing it here
    // too means a hang shows up as THIS test timing out, not as vitest's
    // process failing to exit after every test already reported passed ----
    await started.stop();
    started = undefined;
  }, 15000);
});
