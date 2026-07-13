// GitHub/GitLab webhook receiver (src/server/webhook-routes.ts, 2026-07-13).
// Setup mirrors issue-routes.test.ts's buildApp/createDbClient/makeSeededDb
// pattern. fetch is mocked per test/embedding-client.test.ts's established
// pattern — a webhook that finds a matching submission calls straight
// through to pollSubmissionById (issue-tracker.ts), the SAME function
// issue-routes.ts's own post-action recheck uses, so these tests only need
// to prove "the right submission got rechecked", not re-verify
// pollSubmissionById's own GitHub/GitLab branch logic (that's
// issue-tracker.test.ts's job).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import { buildApp } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";

const noopEngine: RunTurnFn = async function* () {};
const GITHUB_SECRET = "gh-webhook-secret-for-tests";
const GITLAB_SECRET = "gl-webhook-secret-for-tests";

let dir: string, dbPath: string, client: DbClient, settings: Settings;

beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  dbPath = f.dbPath;
  client = createDbClient(f.dbPath);
  settings = loadSettings({
    APP_JWT_SECRET: "test-secret-do-not-use-in-prod",
    APP_GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    APP_GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("unexpected fetch call with no route stubbed");
  }));
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function buildTestApp() {
  return buildApp({ db: client, settings, engine: noopEngine });
}

function githubSignature(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function postGithubWebhook(app: ReturnType<typeof buildApp>, eventType: string, payload: unknown, secretOverride?: string) {
  const body = JSON.stringify(payload);
  const secret = secretOverride ?? GITHUB_SECRET;
  return app.request("/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-hub-signature-256": githubSignature(body, secret),
    },
    body,
  });
}

async function postGitlabWebhook(app: ReturnType<typeof buildApp>, payload: unknown, tokenOverride?: string) {
  return app.request("/api/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": tokenOverride ?? GITLAB_SECRET,
    },
    body: JSON.stringify(payload),
  });
}

// A GET that reports the issue as still open with no labels — the exact
// derived status doesn't matter to these tests, only that pollSubmissionById
// actually ran (last_checked_at goes from null to set).
function stubTrackerReachable() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/resource_state_events")) return { status: 200, json: async () => [] } as unknown as Response;
    return { status: 200, json: async () => ({ state: "open", labels: [], closed_at: null }) } as unknown as Response;
  }));
}

describe("POST /api/webhooks/github", () => {
  it("签名不匹配 -> 401，不发起任何 fetch", async () => {
    const app = buildTestApp();
    const resp = await postGithubWebhook(app, "issues", { action: "closed" }, "wrong-secret");
    expect(resp.status).toBe(401);
  });

  it("完全没有配置 secret -> 401（避免空字符串意外被当成有效密钥）", async () => {
    const noSecretSettings = loadSettings({ APP_JWT_SECRET: "x" }); // githubWebhookSecret 落回默认空串
    const app = buildApp({ db: client, settings: noSecretSettings, engine: noopEngine });
    const resp = await postGithubWebhook(app, "issues", { action: "closed" }, "");
    expect(resp.status).toBe(401);
  });

  it("签名匹配 + 已知仓库 + 已追踪的 issue -> 200，触发了一次真实 recheck（last_checked_at 从 null 变为已设置）", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://github.com/acme/widgets.git" });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 42, issueUrl: "https://github.com/acme/widgets/issues/42",
    });
    stubTrackerReachable();

    const app = buildTestApp();
    const resp = await postGithubWebhook(app, "issues", {
      action: "closed",
      repository: { full_name: "acme/widgets" },
      issue: { number: 42 },
    });
    expect(resp.status).toBe(200);

    const row = await client.getSubmissionForTracking(subId);
    expect(row!.last_checked_at).not.toBeNull();
  });

  it("签名匹配但仓库不是本实例追踪的 -> 200，零副作用（不是错误，只是没什么可做的）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const resp = await postGithubWebhook(app, "issues", {
      action: "closed",
      repository: { full_name: "someone-else/unrelated-repo" },
      issue: { number: 1 },
    });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已知仓库但这个 issue 号码从未被追踪过 -> 200，零副作用", async () => {
    await client.createRepo({ name: "demo", url: "https://github.com/acme/widgets.git" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const resp = await postGithubWebhook(app, "issues", {
      action: "opened",
      repository: { full_name: "acme/widgets" },
      issue: { number: 9999 }, // 从没提交/操作过这个编号
    });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issue_comment 事件（action=created）也会触发 recheck，其它 action（如 deleted）不会", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://github.com/acme/widgets.git" });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 7, issueUrl: "https://github.com/acme/widgets/issues/7",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();

    const deletedResp = await postGithubWebhook(app, "issue_comment", {
      action: "deleted",
      repository: { full_name: "acme/widgets" },
      issue: { number: 7 },
    });
    expect(deletedResp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    stubTrackerReachable();
    const createdResp = await postGithubWebhook(app, "issue_comment", {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 7 },
    });
    expect(createdResp.status).toBe(200);
    const row = await client.getSubmissionForTracking(subId);
    expect(row!.last_checked_at).not.toBeNull();
  });

  it("请求体不是合法 JSON -> 200（签名已过，不当成错误），零副作用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const body = "{not valid json";
    const resp = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": githubSignature(body, GITHUB_SECRET),
      },
      body,
    });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不认识的事件类型 -> 200，零副作用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const resp = await postGithubWebhook(app, "pull_request", { action: "opened" });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/gitlab", () => {
  it("token 不匹配 -> 401，不发起任何 fetch", async () => {
    const app = buildTestApp();
    const resp = await postGitlabWebhook(app, { object_kind: "issue" }, "wrong-token");
    expect(resp.status).toBe(401);
  });

  it("token 匹配 + 已知仓库 + 已追踪的 issue（object_kind=issue）-> 200，触发了一次真实 recheck", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://gitlab.example.com/group/proj.git" });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 5, issueUrl: "https://gitlab.example.com/group/proj/-/issues/5",
    });
    stubTrackerReachable();

    const app = buildTestApp();
    const resp = await postGitlabWebhook(app, {
      object_kind: "issue",
      project: { web_url: "https://gitlab.example.com/group/proj" },
      object_attributes: { iid: 5, state: "closed" },
    });
    expect(resp.status).toBe(200);

    const row = await client.getSubmissionForTracking(subId);
    expect(row!.last_checked_at).not.toBeNull();
  });

  it("note 事件（评论）且 noteable_type=Issue -> 触发 recheck；noteable_type 不是 Issue（比如 MergeRequest）-> 忽略", async () => {
    const uid = await client.createUser("alice", "hashed-pw", "user");
    const repoId = await client.createRepo({ name: "demo", url: "https://gitlab.example.com/group/proj.git" });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: uid,
      title: "t", body: "b", labels: [], issueNumber: 3, issueUrl: "https://gitlab.example.com/group/proj/-/issues/3",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();

    const mrNoteResp = await postGitlabWebhook(app, {
      object_kind: "note",
      project: { web_url: "https://gitlab.example.com/group/proj" },
      object_attributes: { noteable_type: "MergeRequest" },
      issue: { iid: 3 },
    });
    expect(mrNoteResp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    stubTrackerReachable();
    const issueNoteResp = await postGitlabWebhook(app, {
      object_kind: "note",
      project: { web_url: "https://gitlab.example.com/group/proj" },
      object_attributes: { noteable_type: "Issue" },
      issue: { iid: 3 },
    });
    expect(issueNoteResp.status).toBe(200);
    const row = await client.getSubmissionForTracking(subId);
    expect(row!.last_checked_at).not.toBeNull();
  });

  it("仓库不是本实例追踪的 -> 200，零副作用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const resp = await postGitlabWebhook(app, {
      object_kind: "issue",
      project: { web_url: "https://gitlab.example.com/nobody/tracks-this" },
      object_attributes: { iid: 1, state: "opened" },
    });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("请求体不是合法 JSON -> 200，零副作用", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildTestApp();
    const resp = await app.request("/api/webhooks/gitlab", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-token": GITLAB_SECRET },
      body: "{not valid json",
    });
    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/webhooks/* bypasses the normal auth middleware", () => {
  it("no Authorization header at all still reaches the route (signature/token IS the auth) — proven by getting a 401 from OUR check, not the generic 'Not authenticated'", async () => {
    const app = buildTestApp();
    const resp = await app.request("/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "issues" },
      body: "{}",
    });
    expect(resp.status).toBe(401);
    expect((await resp.json()).detail).toBe("invalid signature");
  });
});
