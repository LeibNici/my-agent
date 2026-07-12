// Task 8 — the end-to-end proof that closes Phase 4a: per-turn ToolContext
// (allowedRepoPaths/unsyncedRepoNames/userId), resolved from the REAL
// permission table by sse.ts's resolveToolContext, actually reaches a REAL
// registered tool (file_reader) during a REAL /api/chat turn. Modeled on
// e2e-smoke.test.ts's composition (startServer() — the exact `npm start`
// path — driving the real runTurn engine against an offline mock LLM) but
// scoped to the permission-resolution behavior this task adds, not the
// whole SSE contract (that's already e2e-smoke's job).
//
// Oracle for the resolution rule itself: v1's chat route inline block
// (`git show v1-python-final:app/main.py`, `_get_visible_repos` +
// `allowed_repo_paths`/`unsynced_repo_names`/repo_id filtering) — see
// sse.ts's resolveToolContext docstring for the exact correspondence.
//
// Four scenarios, one shared mock script (mock.requests[] indexes across
// ALL /api/chat calls made against the same MockServer, in arrival order —
// see mock-anthropic.ts's startMock comment):
//   1. A granted non-admin user's file_reader call sees the granted repo's
//      real local_path (allowedRepoPaths flows through).
//   2. A DIFFERENT non-admin user with NO grants at all gets access.ts's
//      noAccessReason text back from the tool — not a crash, not silent
//      success.
//   3. An admin bypasses the permissions table entirely: reads a file in a
//      repo nobody ever explicitly granted them.
//   4. repo_id narrows a multi-repo grant to one repo: the SAME user who
//      can read a file in repoB with no filter gets denied that same file
//      once repo_id pins the turn to repoA.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../src/server/main.js";
import { startMock, toolTurn, textTurn, type MockServer } from "./mock-anthropic.js";
import { createToken } from "../src/auth.js";

// ==================== SSE frame parsing (mirrors e2e-smoke.test.ts's own parser) ====================

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

/** Drives one real /api/chat turn, returns the tool_result frame's `result`
 * text — the string the tool itself returned, which is what carries the
 * allowed-path/denial evidence this suite is checking. */
async function toolResultText(
  base: string,
  token: string,
  message: string,
  repoId?: number,
): Promise<string> {
  const resp = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, repo_id: repoId ?? null }),
  });
  expect(resp.status).toBe(200);
  const frames = parseFrames(await readFullStream(resp));
  const toolResultFrame = frames.find((f) => f.event === "tool_result");
  if (!toolResultFrame) throw new Error(`no tool_result frame in: ${JSON.stringify(frames)}`);
  return (JSON.parse(toolResultFrame.data) as { result: string }).result;
}

// ==================== Fixture lifecycle ====================

let mock: MockServer | undefined;
let dir: string | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.stop();
  await mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  started = undefined;
  mock = undefined;
  dir = undefined;
});

describe("chat route — per-turn ToolContext wiring (Task 8, closes Phase 4a)", () => {
  it("allowedRepoPaths/unsyncedRepoNames/userId resolve from the real permission table and reach file_reader", async () => {
    dir = mkdtempSync(join(tmpdir(), "codeaxis-chat-tools-"));

    // Two synced repos with real files on disk — repoA/repoB never share a
    // filename, so a successful read of the "wrong" one can only happen if
    // the tool's allowedRepoPaths genuinely included that repo's root.
    const repoADir = join(dir, "repoA");
    const repoBDir = join(dir, "repoB");
    mkdirSync(repoADir, { recursive: true });
    mkdirSync(repoBDir, { recursive: true });
    writeFileSync(join(repoADir, "shared.txt"), "hello from repoA\n");
    writeFileSync(join(repoBDir, "onlyB.txt"), "hello from repoB\n");

    // Absolute paths for the two DENIAL scenarios (bob, carol-filtered):
    // file_reader.ts's resolvePath falls back to a CWD-relative realpath
    // when a relative path isn't found under any allowed root, and this
    // repo's own worktree checkout happens to live under a `.claude/`
    // segment — which would trip the tool's unrelated dotfile guard before
    // ever reaching the permission check being tested here. An absolute
    // path resolves directly via realpath regardless of allowedPaths, so
    // these two scenarios isolate exactly the permission-boundary behavior
    // under test. The two ALLOWED scenarios (alice, admin, carol-
    // unfiltered) use a bare relative filename precisely because that's
    // the realistic shape (a path resolved against a granted repo root).
    const repoASharedAbs = join(repoADir, "shared.txt");
    const repoBOnlyAbs = join(repoBDir, "onlyB.txt");

    // 5 chat turns below, each one tool_use call + one wrap-up text call —
    // queued in the exact order the scenarios fire.
    mock = startMock([
      toolTurn("file_reader", { path: "shared.txt" }, "tu_1"), // 1. alice (granted repoA)
      textTurn("done"),
      toolTurn("file_reader", { path: repoASharedAbs }, "tu_2"), // 2. bob (no grants)
      textTurn("done"),
      toolTurn("file_reader", { path: "onlyB.txt" }, "tu_3"), // 3. admin (no grant row at all)
      textTurn("done"),
      toolTurn("file_reader", { path: "onlyB.txt" }, "tu_4"), // 4a. carol, unfiltered (repoA+repoB granted)
      textTurn("done"),
      toolTurn("file_reader", { path: repoBOnlyAbs }, "tu_5"), // 4b. carol, repo_id=repoA
      textTurn("done"),
    ]);

    const dbPath = join(dir, "agent_data.db");
    started = await startServer({
      env: {
        APP_JWT_SECRET: "chat-tools-integration-test-secret-do-not-use-in-prod",
        APP_DB_PATH: dbPath,
        APP_PORT: "0",
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: "sk-mock-offline-not-a-real-key",
        ANTHROPIC_MODEL: "mock",
      },
    });
    const base = `http://127.0.0.1:${started.port}`;
    const db = started.db;

    // ---- seed repos (synced: local_path set, matching a successfully-
    // cloned repo — Task 3's repo-sync.ts is what populates this in
    // production; this test writes it directly since sync itself is out of
    // scope here) ----
    const repoAId = await db.createRepo({ name: "repoA", url: "https://example.invalid/repoA.git" });
    await db.updateRepo(repoAId, { localPath: repoADir });
    const repoBId = await db.createRepo({ name: "repoB", url: "https://example.invalid/repoB.git" });
    await db.updateRepo(repoBId, { localPath: repoBDir });

    // ---- seed users + grants ----
    const aliceId = await db.createUser("alice", "unused-hash", "user");
    await db.grantPermission(aliceId, repoAId, "read");
    const aliceToken = createToken({ id: aliceId, username: "alice", role: "user" }, started.settings);

    const bobId = await db.createUser("bob", "unused-hash", "user"); // no grants at all
    const bobToken = createToken({ id: bobId, username: "bob", role: "user" }, started.settings);

    const carolId = await db.createUser("carol", "unused-hash", "user");
    await db.grantPermission(carolId, repoAId, "read");
    await db.grantPermission(carolId, repoBId, "read");
    const carolToken = createToken({ id: carolId, username: "carol", role: "user" }, started.settings);

    const admin = await db.getUserByUsername("admin");
    if (!admin) throw new Error("admin bootstrap user missing");
    const adminToken = createToken({ id: admin.id, username: "admin", role: "admin" }, started.settings);

    // ---- 1. granted user sees the granted repo's real local_path ----
    const aliceResult = await toolResultText(base, aliceToken, "读一下 shared.txt");
    expect(aliceResult).toBe("hello from repoA\n");

    // ---- 2. a DIFFERENT non-admin user with no grants at all: denied,
    // via access.ts's noAccessReason (not a crash, not silent success) ----
    const bobResult = await toolResultText(base, bobToken, "读一下 shared.txt");
    expect(bobResult).toBe("Error: Access denied: you have no repository permissions assigned");

    // ---- 3. admin bypasses the permissions table entirely: reads a file
    // in a repo nobody ever explicitly granted the admin account ----
    const adminResult = await toolResultText(base, adminToken, "读一下 onlyB.txt");
    expect(adminResult).toBe("hello from repoB\n");

    // ---- 4a. carol, no repo_id filter: both grants active, onlyB.txt (in
    // repoB) is reachable ----
    const carolUnfiltered = await toolResultText(base, carolToken, "读一下 onlyB.txt");
    expect(carolUnfiltered).toBe("hello from repoB\n");

    // ---- 4b. carol, repo_id=repoA: the SAME file that just succeeded is
    // now denied — proves repo_id genuinely narrowed the granted set to
    // repoA, not just an inert extra field ----
    const carolFiltered = await toolResultText(base, carolToken, "读一下 onlyB.txt", repoAId);
    expect(carolFiltered).toBe("Error: Access denied: path is outside your assigned repositories");
  }, 20000);
});
