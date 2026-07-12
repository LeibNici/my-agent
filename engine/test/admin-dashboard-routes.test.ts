// Task Phase 5 — admin dashboard reporting routes: usage/feedback/
// semantic-search/issue-tracking, all under /api/admin/*. Oracle:
// src/server/admin-dashboard-routes.ts itself (read in full before writing
// this file). Setup mirrors admin-routes.test.ts's buildApp/createDbClient/
// makeSeededDb/createToken + admin-authed-request pattern; the
// admin-only-middleware 403 case is already covered by admin-routes.test.ts
// ("admin-only guard" describe block) against app.ts's shared middleware, so
// it isn't re-tested here.
//
// These routes are read-only reporting (plus one manual poll trigger) over
// storage methods that are themselves exact ports of v1's database.py
// queries — db-storage.test.ts doesn't yet carry Phase 5 storage coverage,
// so rather than re-deriving the aggregation math here too, most assertions
// compare the ROUTE's JSON response directly against calling the same
// DbClient storage method ourselves — proving the route wires the right
// call and shape without duplicating what's fundamentally a storage-layer
// correctness question. The issues/tracking body-stripping/metrics-merge and
// the low_score_only string-parsing ARE route-specific behavior, so those
// get real assertions.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import { createToken } from "../src/auth.js";
import { buildApp } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";

const noopEngine: RunTurnFn = async function* () {};

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

async function seedAdmin(username = "root"): Promise<{ id: number; token: string }> {
  const id = await client.createUser(username, "hashed-pw", "admin");
  const token = createToken({ id, username, role: "admin" }, settings);
  return { id, token };
}

function buildTestApp() {
  return buildApp({ db: client, settings, engine: noopEngine });
}

function authed(app: ReturnType<typeof buildApp>, token: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

// ==================== Usage metrics ====================

describe("GET /api/admin/usage/summary, /usage/by-user, /usage/recent", () => {
  async function seedMetrics(userId: number, n: number): Promise<void> {
    const sessionId = await client.createSession("chat", userId);
    const rows = Array.from({ length: n }, (_, i) => ({
      session_id: sessionId,
      user_id: userId,
      model: "mock-model",
      iteration: i,
      input_tokens: 10 + i,
      output_tokens: 5 + i,
      ttft_ms: 20 + i,
      total_ms: 40 + i,
    }));
    await client.recordLlmCallMetrics(rows);
  }

  it("GET /usage/summary wires getUsageSummary() and returns it verbatim", async () => {
    const { id: userId, token } = await seedAdmin();
    await seedMetrics(userId, 3);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/usage/summary");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(await client.getUsageSummary());
  });

  it("GET /usage/by-user wires getUsageByUser() and returns it verbatim", async () => {
    const { id: userId, token } = await seedAdmin();
    await seedMetrics(userId, 2);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/usage/by-user");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(await client.getUsageByUser());
  });

  it("GET /usage/recent: ?limit= actually changes the row count returned", async () => {
    const { id: userId, token } = await seedAdmin();
    await seedMetrics(userId, 3);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/usage/recent?limit=1");
    const body = await resp.json();
    expect(body).toHaveLength(1);
    expect(body).toEqual(await client.getRecentLlmCalls(1));
  });

  it("GET /usage/recent: absent limit falls back to the default (50)", async () => {
    const { id: userId, token } = await seedAdmin();
    await seedMetrics(userId, 3);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/usage/recent");
    expect(await resp.json()).toEqual(await client.getRecentLlmCalls(50));
  });

  it("GET /usage/recent: invalid (non-numeric) limit falls back to the default rather than erroring", async () => {
    const { id: userId, token } = await seedAdmin();
    await seedMetrics(userId, 3);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/usage/recent?limit=not-a-number");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual(await client.getRecentLlmCalls(50));
  });
});

// ==================== Feedback ====================

describe("GET /api/admin/feedback/summary", () => {
  it("merges up/down counts AND a recent_negative array into one response", async () => {
    const { token } = await seedAdmin("fb-admin");
    const rater = await client.createUser("fb-rater", "hash", "user");
    const sessionId = await client.createSession("chat", rater);
    const msg1 = await client.addMessage(sessionId, "assistant", "answer 1");
    const msg2 = await client.addMessage(sessionId, "assistant", "answer 2");
    const msg3 = await client.addMessage(sessionId, "assistant", "answer 3");
    await client.setMessageFeedback(msg1, sessionId, rater, 1);
    await client.setMessageFeedback(msg2, sessionId, rater, 1);
    await client.setMessageFeedback(msg3, sessionId, rater, -1);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/feedback/summary");
    expect(resp.status).toBe(200);
    const body = await resp.json();

    const expectedSummary = await client.getFeedbackSummary();
    const expectedNegative = await client.getRecentNegativeFeedback(20);
    expect(expectedSummary).toEqual({ up_count: 2, down_count: 1 });
    expect(body).toEqual({ ...expectedSummary, recent_negative: expectedNegative });
    expect(body.recent_negative).toHaveLength(1);
    expect(body.recent_negative[0]).toMatchObject({ message_id: msg3, session_id: sessionId });
  });
});

// ==================== Issue progress tracking ====================

describe("GET /api/admin/issues/tracking", () => {
  it("strips body from each submission but includes a metrics field alongside counts", async () => {
    const { id: adminId, token } = await seedAdmin("track-admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    const sessionId = await client.createSession("chat", adminId);
    await client.recordIssueSubmission({
      sessionId,
      repoId,
      userId: adminId,
      title: "Some bug",
      body: "## Steps to reproduce\n\nSomething broke in `path/to/File.java`.",
      labels: [],
      issueNumber: 42,
      issueUrl: "https://gitlab.example.com/group/proj/-/issues/42",
    });

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/issues/tracking");
    expect(resp.status).toBe(200);
    const body = await resp.json();

    expect(body.submissions).toHaveLength(1);
    expect(body.submissions[0].title).toBe("Some bug");
    expect(body.submissions[0].body).toBeUndefined();
    expect("body" in body.submissions[0]).toBe(false);

    // Underlying storage call DOES carry body — confirms the route is the
    // one stripping it, not the storage method.
    const rawOverview = await client.getIssueTrackingOverview(100);
    expect(rawOverview.submissions[0].body).toContain("Steps to reproduce");

    expect(body.counts).toEqual({ submitted: 1 });
    // No fix reports exist for this submission, so every derived metric is
    // deterministically the documented "no evidence" shape — this proves
    // the metrics field is computed and shaped correctly without needing to
    // re-verify computeTrackingMetrics' math on richer data (that's
    // issue-tracker.test.ts's job).
    expect(body.metrics).toEqual({ fixed_count: 0, avg_fix_hours: null, hit_rate: null, hit_sample: 0 });
  });

  it("?limit= is honored (mirrors getIssueTrackingOverview's own limit param)", async () => {
    const { id: adminId, token } = await seedAdmin("track-admin2");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    for (let i = 0; i < 3; i++) {
      const sessionId = await client.createSession("chat", adminId);
      await client.recordIssueSubmission({
        sessionId, repoId, userId: adminId, title: `bug ${i}`, body: "b", labels: [],
        issueNumber: i + 1, issueUrl: `https://gitlab.example.com/group/proj/-/issues/${i + 1}`,
      });
    }
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/issues/tracking?limit=2");
    const body = await resp.json();
    expect(body.submissions).toHaveLength(2);
  });
});

describe("POST /api/admin/issues/tracking/poll", () => {
  it("with no trackable submissions seeded, runs pollTrackedIssues for real and returns {ok:true, polled:0}", async () => {
    const { token } = await seedAdmin("poll-admin");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/issues/tracking/poll", { method: "POST" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, polled: 0 });
  });
});

// ==================== Semantic search recall log ====================

describe("GET /api/admin/semantic-search/summary, /semantic-search/recent", () => {
  async function seedSearchLogs(adminId: number, repoId: number): Promise<void> {
    await client.recordSemanticSearchLog({
      userId: adminId, repoId, query: "high score query", resultCount: 3, top1Score: 0.9, resultsJson: "[]", durationMs: 120,
    });
    await client.recordSemanticSearchLog({
      userId: adminId, repoId, query: "no result query", resultCount: 0, top1Score: null, resultsJson: "[]", durationMs: 80,
    });
    await client.recordSemanticSearchLog({
      userId: adminId, repoId, query: "low score query", resultCount: 2, top1Score: 0.2, resultsJson: "[]", durationMs: 60,
    });
  }

  it("GET /summary wires getSemanticSearchStats() and returns it verbatim", async () => {
    const { id: adminId, token } = await seedAdmin("search-admin");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await seedSearchLogs(adminId, repoId);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/semantic-search/summary");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual(await client.getSemanticSearchStats());
    expect(body.query_count).toBe(3);
  });

  it("GET /recent with no query param returns everything (both low- and high-score rows)", async () => {
    const { id: adminId, token } = await seedAdmin("search-admin2");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await seedSearchLogs(adminId, repoId);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/semantic-search/recent");
    const body = await resp.json();
    expect(body).toHaveLength(3);
  });

  it("GET /recent?low_score_only=true filters to the null/<0.5 rows only", async () => {
    const { id: adminId, token } = await seedAdmin("search-admin3");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await seedSearchLogs(adminId, repoId);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/semantic-search/recent?low_score_only=true");
    const body = await resp.json();
    expect(body).toHaveLength(2);
    expect(body.map((r: { query: string }) => r.query).sort()).toEqual(["low score query", "no result query"]);
    expect(body).toEqual(await client.getSemanticSearchRecent(50, true));
  });

  it("GET /recent?low_score_only=false behaves as false (literal-string parsing), not as a truthy non-empty string", async () => {
    const { id: adminId, token } = await seedAdmin("search-admin4");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await seedSearchLogs(adminId, repoId);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/semantic-search/recent?low_score_only=false");
    const body = await resp.json();
    expect(body).toHaveLength(3);
  });

  it("GET /recent?low_score_only=<anything else> also behaves as false, not as truthy", async () => {
    const { id: adminId, token } = await seedAdmin("search-admin5");
    const repoId = await client.createRepo({ name: "r1", url: "https://example.com/r1.git" });
    await seedSearchLogs(adminId, repoId);

    const app = buildTestApp();
    const resp = await authed(app, token, "/api/admin/semantic-search/recent?low_score_only=yes");
    const body = await resp.json();
    expect(body).toHaveLength(3);
  });
});
