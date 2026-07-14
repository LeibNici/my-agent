// Task Phase 5 — user-facing issue-tracker routes: submit/action/
// check-duplicates/mine. Oracle: src/server/issue-routes.ts itself (read in
// full before writing this file) + v1-python-final:app/main.py's "Issues"
// section. Setup mirrors admin-routes.test.ts's buildApp/createDbClient/
// makeSeededDb/createToken pattern; fetch is mocked via vi.stubGlobal per
// embedding-client.test.ts's established pattern — issue-routes.ts calls
// through to the REAL HTTP-calling functions in issue-tracker-client.ts
// (submitRepoIssue/applyRepoIssueAction/searchRepoIssues/getRepoLabels), so
// mocking fetch (not those functions) keeps this closer to a true
// integration test of route + client + credential-selection logic together.
//
// Every repo created here uses a GitLab-looking URL (gitlab.example.com) so
// isGithubHosted() is false and the credential/label-governance branches
// engage — matching the brief. gitlab.example.com's DNS lookup fails fast
// (ENOTFOUND, ~ms) in this sandbox, which validateUrl's isDisallowedHost
// treats as "not disallowed" (v1 parity: resolution failure never blocks —
// that's git's/the tracker call's problem, not the SSRF gate's), so no real
// network I/O or hang is involved despite the real-looking host.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import { createToken } from "../src/auth.js";
import { buildApp } from "../src/server/app.js";
import type { RunTurnFn } from "../src/engine/turn.js";
import { __internal as issueTrackerClientInternal } from "../src/tools/issue-tracker-client.js";

const noopEngine: RunTurnFn = async function* () {};

let dir: string, dbPath: string, client: DbClient, settings: Settings;

beforeEach(() => {
  const f = makeSeededDb();
  dir = f.dir;
  dbPath = f.dbPath;
  client = createDbClient(f.dbPath);
  settings = loadSettings({ APP_JWT_SECRET: "test-secret-do-not-use-in-prod" });
  // Module-level cache in issue-tracker-client.ts, keyed by repo id — repo
  // ids restart at 1 in every fresh per-test db, so without this a later
  // test's repo could silently inherit an earlier test's cached label
  // vocabulary and never call fetch at all.
  issueTrackerClientInternal.clearLabelsCache();
  // Default: any unmocked fetch call throws immediately and loudly, instead
  // of a real DNS/TCP attempt hanging or flaking the suite. Tests that need
  // the tracker to actually be reached call stubFetch([...]) themselves.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("unexpected fetch call with no route stubbed");
  }));
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function seedUser(role: "user" | "admin" = "user", username = "alice"): Promise<{ id: number; token: string }> {
  const id = await client.createUser(username, "hashed-pw", role);
  const token = createToken({ id, username, role }, settings);
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

async function seedRepo(overrides: { url?: string; credToken?: string | null } = {}): Promise<number> {
  return client.createRepo({
    name: "r1",
    url: overrides.url ?? "https://gitlab.example.com/group/proj.git",
    credToken: overrides.credToken === undefined ? "glpat-test-token" : overrides.credToken,
  });
}

// ==================== Routed fetch mock (GitLab API surface) ====================

type MockRoute = {
  when: (url: string, init: RequestInit) => boolean;
  status: number;
  body?: unknown;
  text?: string;
};

function routedFetchMock(routes: MockRoute[]) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    for (const r of routes) {
      if (r.when(url, init)) {
        return {
          status: r.status,
          json: async () => r.body,
          text: async () => r.text ?? JSON.stringify(r.body ?? {}),
        } as unknown as Response;
      }
    }
    throw new Error(`Unmocked fetch call: ${init.method ?? "GET"} ${url}`);
  });
}

function stubFetch(routes: MockRoute[] = []) {
  const mock = routedFetchMock(routes);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function findFetchCall(
  mock: ReturnType<typeof routedFetchMock>,
  predicate: (url: string, init: RequestInit) => boolean
): { url: string; init: RequestInit } {
  const call = mock.mock.calls.find(([url, init]) => predicate(url, (init ?? {}) as RequestInit));
  if (!call) throw new Error("expected fetch call not found in mock history");
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

const isLabelsGet = (url: string, init: RequestInit) =>
  (!init.method || init.method === "GET") && url.includes("/labels?");
const isIssuesCreate = (url: string, init: RequestInit) => init.method === "POST" && /\/issues$/.test(url);
const isIssuesSearch = (url: string, init: RequestInit) =>
  (!init.method || init.method === "GET") && url.includes("/issues?");
const isIssueNote = (url: string, init: RequestInit) =>
  init.method === "POST" && /\/issues\/\d+\/notes$/.test(url);
const isIssueState = (url: string, init: RequestInit) => init.method === "PUT" && /\/issues\/\d+$/.test(url);
// The recheck path (pollOne, called via issue-routes.ts's post-action
// bestEffortRecheck) does a plain GET on the issue, then unconditionally a
// second GET for resource_state_events (reopen-count derivation) — both
// need their own routes or the recheck 404s/throws internally (silently,
// since bestEffortRecheck swallows the error — but then the row never
// actually updates, which the recheck-specific tests below need to see).
const isIssueGet = (url: string, init: RequestInit) =>
  (!init.method || init.method === "GET") && /\/issues\/\d+$/.test(url);
const isResourceStateEvents = (url: string, init: RequestInit) =>
  (!init.method || init.method === "GET") && url.includes("/resource_state_events");
// A "closed"/"merged"/"reopened" derived status makes pollOne ALSO fetch
// existing notes (fetchAndStoreReports, looking for a codex-report/v1
// marker) — a GET on the same /notes path issueNoteRoute's POST matcher
// doesn't cover.
const isNotesGet = (url: string, init: RequestInit) =>
  (!init.method || init.method === "GET") && /\/issues\/\d+\/notes\?/.test(url);

const LABELS_ROUTE: MockRoute = {
  when: isLabelsGet,
  status: 200,
  body: [{ name: "bug" }, { name: "enhancement" }],
};

function issuesCreateRoute(status: number, body: unknown, text?: string): MockRoute {
  return { when: isIssuesCreate, status, body, text };
}
function issueNoteRoute(status: number, body: unknown = {}, text?: string): MockRoute {
  return { when: isIssueNote, status, body, text };
}
function issueStateRoute(status: number, body: unknown, text?: string): MockRoute {
  return { when: isIssueState, status, body, text };
}
function issuesSearchRoute(status: number, body: unknown): MockRoute {
  return { when: isIssuesSearch, status, body };
}
function issueGetRoute(status: number, body: unknown): MockRoute {
  return { when: isIssueGet, status, body };
}
// Empty page is enough — fetchGitlabStateEvents stops as soon as a page
// comes back shorter than its 100-per-page size.
const RESOURCE_STATE_EVENTS_ROUTE: MockRoute = { when: isResourceStateEvents, status: 200, body: [] };
const NOTES_GET_ROUTE: MockRoute = { when: isNotesGet, status: 200, body: [] };

// ==================== POST /api/issues/submit ====================

describe("POST /api/issues/submit", () => {
  it("missing repo_id -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ title: "t", body: "b" }),
    });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ detail: "repo_id is required" });
  });

  it("wrong-typed repo_id -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: "not-a-number", title: "t", body: "b" }),
    });
    expect(resp.status).toBe(422);
  });

  it("missing/empty title -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: 1, title: "", body: "b" }),
    });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ detail: "title is required" });
  });

  it("missing/empty body -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: 1, title: "t", body: "" }),
    });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ detail: "body is required" });
  });

  it("repo doesn't exist -> 404, no fetch attempted", async () => {
    const { token } = await seedUser("admin", "root");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: 999999, title: "t", body: "b" }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "Repo not found" });
  });

  it("caller has NO permission on the repo -> 403 'Access denied to this repository'", async () => {
    const { token } = await seedUser("user", "noperm");
    const repoId = await seedRepo();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "t", body: "b" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied to this repository" });
  });

  it("caller has read-only permission -> 403 'Write access required' (distinct detail from no-permission case)", async () => {
    const { id: userId, token } = await seedUser("user", "readonly");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "read");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "t", body: "b" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Write access required" });
  });

  it("session_id belongs to ANOTHER user -> 403 'Access denied to this session'", async () => {
    const { id: userId, token } = await seedUser("user", "submitter");
    const other = await seedUser("user", "other-owner");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "write");
    const sessionId = await client.createSession("New Chat", other.id);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "t", body: "b", session_id: sessionId }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied to this session" });
  });

  it("session is already resolved -> 409", async () => {
    const { id: userId, token } = await seedUser("user", "resolved-submitter");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "write");
    const sessionId = await client.createSession("New Chat", userId);
    await client.markSessionResolved(sessionId);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "t", body: "b", session_id: sessionId }),
    });
    expect(resp.status).toBe(409);
    expect((await resp.json()).detail).toContain("already been resolved");
  });

  it("draft_tool_use_id's stamped repo_id mismatches the submitted repo_id -> 400", async () => {
    const { id: userId, token } = await seedUser("user", "draft-mismatch");
    const repoA = await seedRepo({ url: "https://gitlab.example.com/group/repo-a.git" });
    const repoB = await seedRepo({ url: "https://gitlab.example.com/group/repo-b.git" });
    await client.grantPermission(userId, repoA, "write");
    const sessionId = await client.createSession("New Chat", userId);
    // Raw legacy tool_result block (see src/codec-legacy.ts's convertLegacyBlockToDomain
    // for the exact field names: tool_use_id/content/is_error) stamped with repoB,
    // while the request below submits against repoA.
    await client.addMessage(sessionId, "user", [
      {
        type: "tool_result",
        tool_use_id: "tu_draft_1",
        content: JSON.stringify({ repo_id: repoB, title: "t", body: "b" }),
        is_error: false,
      },
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({
        repo_id: repoA,
        title: "t",
        body: "b",
        session_id: sessionId,
        draft_tool_use_id: "tu_draft_1",
      }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).detail).toContain("提交的仓库与草稿时确认的仓库不一致");
  });

  it("successful submit (with session_id): {ok, issue_number, issue_url}; recorded row; session stays OPEN (QA-reported: used to force-resolve here)", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-admin");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 55, web_url: "https://gitlab.example.com/group/proj/-/issues/55", title: "Bug title" }),
      issueGetRoute(200, { state: "opened", labels: ["bug"], closed_at: null }),
      RESOURCE_STATE_EVENTS_ROUTE,
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "Bug title", body: "Bug body", session_id: sessionId }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      issue_number: 55,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/55",
    });

    const rows = await client.getIssueSubmissionsForSession(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo_id: repoId,
      user_id: userId,
      title: "Bug title",
      issue_number: 55,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/55",
      labels: [],
    });
    expect(rows[0].body).toContain("提报人");
    expect(rows[0].body).toContain("submit-admin");
    // The on-demand recheck (bestEffortRecheck + pollSubmissionById) ran
    // synchronously before the response — track_status/last_checked_at
    // reflect it having actually completed, not just been kicked off.
    expect(rows[0].track_status).toBe("submitted");

    const session = await client.getSession(sessionId);
    expect(session!.resolved_at).toBeNull();
  });

  it("idempotency: resubmitting the SAME draft_tool_use_id returns the existing issue, never calls the tracker a second time", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-idem");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    const fetchMock = stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 61, web_url: "https://gitlab.example.com/group/proj/-/issues/61", title: "Bug title" }),
      issueGetRoute(200, { state: "opened", labels: [], closed_at: null }),
      RESOURCE_STATE_EVENTS_ROUTE,
    ]);
    const app = buildTestApp();
    const body = {
      repo_id: repoId,
      title: "Bug title",
      body: "Bug body",
      session_id: sessionId,
      draft_tool_use_id: "tu_dup_1",
    };

    const first = await authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      issue_number: 61,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/61",
    });
    const createCallsAfterFirst = fetchMock.mock.calls.filter(([url, init]) => isIssuesCreate(url as string, (init ?? {}) as RequestInit)).length;
    expect(createCallsAfterFirst).toBe(1);

    const second = await authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      issue_number: 61,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/61",
      already_submitted: true,
    });
    // Still exactly one — the retry never reached submitRepoIssue at all.
    const createCallsAfterSecond = fetchMock.mock.calls.filter(([url, init]) => isIssuesCreate(url as string, (init ?? {}) as RequestInit)).length;
    expect(createCallsAfterSecond).toBe(1);

    const rows = await client.getIssueSubmissionsForSession(sessionId);
    expect(rows).toHaveLength(1); // no duplicate row either
  });

  // QA-reported 2026-07-14: a real double-click on the confirm button
  // reproducibly filed TWO real GitHub issues for the same draft, even
  // though the sequential test above (one request fully completes before
  // the next starts) always passed — the bug only shows up when both
  // requests are genuinely in flight together. This exercises the actual
  // race via Promise.all against the real worker-backed DbClient, proving
  // claimDraftSubmission's unique-index INSERT (not the old
  // check-then-call-then-record pattern) is what makes only one caller ever
  // win.
  it("idempotency: two CONCURRENT requests for the SAME draft only ever create one real issue", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-concurrent");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    const fetchMock = stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 62, web_url: "https://gitlab.example.com/group/proj/-/issues/62", title: "Bug title" }),
      issueGetRoute(200, { state: "opened", labels: [], closed_at: null }),
      RESOURCE_STATE_EVENTS_ROUTE,
    ]);
    const app = buildTestApp();
    const body = {
      repo_id: repoId,
      title: "Bug title",
      body: "Bug body",
      session_id: sessionId,
      draft_tool_use_id: "tu_concurrent_1",
    };

    const [respA, respB] = await Promise.all([
      authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) }),
      authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) }),
    ]);

    // Exactly one real issue filed upstream — never two.
    const createCalls = fetchMock.mock.calls.filter(([url, init]) =>
      isIssuesCreate(url as string, (init ?? {}) as RequestInit)
    ).length;
    expect(createCalls).toBe(1);

    // Whichever response reflects the loser of the race, it must be either
    // a 409 (told to retry) or a 200 reporting the SAME issue number as the
    // winner — never a 200 with a different, second issue number.
    const bodies = await Promise.all([respA.json(), respB.json()]);
    for (const [resp, respBody] of [[respA, bodies[0]], [respB, bodies[1]]] as const) {
      expect([200, 409]).toContain(resp.status);
      if (resp.status === 200) expect(respBody.issue_number).toBe(62);
    }

    const rows = await client.getIssueSubmissionsForSession(sessionId);
    expect(rows).toHaveLength(1); // never a duplicate row
  });

  // Codex full-repo review (2026-07-14, Warning): a card rendered from a
  // session predating draft_tool_use_id tracking sends draft_tool_use_id:
  // null while session_id IS present — this combination used to skip
  // claiming ENTIRELY and had zero protection against a double-click. The
  // synthetic session+repo+title key (issue-routes.ts's effectiveDraftKey)
  // covers it via the exact same claim path as a real draftToolUseId.
  it("idempotency also covers a SESSION-scoped submission with no draft_tool_use_id at all (legacy card replay)", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-no-draft-id");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    const fetchMock = stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 63, web_url: "https://gitlab.example.com/group/proj/-/issues/63", title: "Bug title" }),
      issueGetRoute(200, { state: "opened", labels: [], closed_at: null }),
      RESOURCE_STATE_EVENTS_ROUTE,
    ]);
    const app = buildTestApp();
    const body = {
      repo_id: repoId,
      title: "Bug title",
      body: "Bug body",
      session_id: sessionId,
      // No draft_tool_use_id — the legacy/pre-tracking case.
    };

    const [respA, respB] = await Promise.all([
      authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) }),
      authed(app, token, "/api/issues/submit", { method: "POST", body: JSON.stringify(body) }),
    ]);

    const createCalls = fetchMock.mock.calls.filter(([url, init]) =>
      isIssuesCreate(url as string, (init ?? {}) as RequestInit)
    ).length;
    expect(createCalls).toBe(1);

    const bodies = await Promise.all([respA.json(), respB.json()]);
    for (const [resp, respBody] of [[respA, bodies[0]], [respB, bodies[1]]] as const) {
      expect([200, 409]).toContain(resp.status);
      if (resp.status === 200) expect(respBody.issue_number).toBe(63);
    }

    const rows = await client.getIssueSubmissionsForSession(sessionId);
    expect(rows).toHaveLength(1);
  });

  it("session stays open across a full issue lifecycle: submit → comment → close → reopen, all against the SAME session_id, resolved_at null throughout", async () => {
    const { id: userId, token } = await seedUser("admin", "lifecycle-admin");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 88, web_url: "https://gitlab.example.com/group/proj/-/issues/88", title: "T" }),
      issueGetRoute(200, { state: "opened", labels: [], closed_at: null }),
      RESOURCE_STATE_EVENTS_ROUTE,
      issueNoteRoute(201),
      issueStateRoute(200, { iid: 88, web_url: "https://gitlab.example.com/group/proj/-/issues/88", title: "T" }),
    ]);
    const app = buildTestApp();

    const submit = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "T", body: "B", session_id: sessionId }),
    });
    expect(submit.status).toBe(200);
    expect((await client.getSession(sessionId))!.resolved_at).toBeNull();

    for (const action of ["comment", "close", "reopen"] as const) {
      const resp = await authed(app, token, "/api/issues/action", {
        method: "POST",
        body: JSON.stringify({ action, repo_id: repoId, issue_number: 88, comment: `doing ${action}`, session_id: sessionId }),
      });
      expect(resp.status).toBe(200);
      expect((await client.getSession(sessionId))!.resolved_at).toBeNull();
    }

    const actions = await client.getIssueActionsForSession(sessionId);
    expect(actions.map((a) => a.action)).toEqual(["comment", "close", "reopen"]);
  });

  it("successful submit (no session_id): submission still succeeds, but nothing is recorded/resolved", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-admin-nosession");
    const repoId = await seedRepo();
    stubFetch([
      LABELS_ROUTE,
      issuesCreateRoute(201, { iid: 77, web_url: "https://gitlab.example.com/group/proj/-/issues/77", title: "T" }),
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "Bug title", body: "Bug body" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      issue_number: 77,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/77",
    });
    expect(await client.getMyIssueSubmissions(userId)).toHaveLength(0);
  });

  it("tracker returns a non-201 error shape -> 502 carrying the tracker's error message; nothing recorded", async () => {
    const { id: userId, token } = await seedUser("admin", "submit-admin-502");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    stubFetch([LABELS_ROUTE, issuesCreateRoute(422, {}, "Validation failed: title too short")]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "Bug title", body: "Bug body", session_id: sessionId }),
    });
    expect(resp.status).toBe(502);
    expect((await resp.json()).detail).toBe("GitLab API error (422): Validation failed: title too short");
    expect(await client.getIssueSubmissionsForSession(sessionId)).toHaveLength(0);
    expect((await client.getSession(sessionId))!.resolved_at).toBeNull();
  });

  it("label re-validation: unknown labels dropped, case-insensitive + suffix matches normalized before the ACTUAL tracker submit", async () => {
    const { token } = await seedUser("admin", "submit-admin-labels");
    const repoId = await seedRepo();
    const fetchMock = stubFetch([
      { when: isLabelsGet, status: 200, body: [{ name: "Type::Bug" }, { name: "Urgency::High" }] },
      issuesCreateRoute(201, { iid: 1, web_url: "https://gitlab.example.com/group/proj/-/issues/1", title: "T" }),
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/submit", {
      method: "POST",
      body: JSON.stringify({
        repo_id: repoId,
        title: "Bug title",
        body: "Bug body",
        labels: ["BUG", "URGENCY::HIGH", "totallyunknown"],
      }),
    });
    expect(resp.status).toBe(200);

    const createCall = findFetchCall(fetchMock, isIssuesCreate);
    const sentBody = JSON.parse(createCall.init.body as string);
    // GitLab wants a comma string, not an array (submitGitlabIssue) — and
    // only the normalized/accepted labels, never the raw un-validated input.
    expect(sentBody.labels).toBe("Type::Bug,Urgency::High");
  });
});

// ==================== POST /api/issues/action ====================

describe("POST /api/issues/action", () => {
  it("invalid action value -> 400 even when repo_id/issue_number are ALSO invalid (proves format checks run first)", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "bogus", repo_id: "nope", issue_number: "nope", comment: "a valid comment" }),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ detail: "action must be one of: comment, close, reopen" });
  });

  it("empty/whitespace comment -> 400", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: 999999, issue_number: 1, comment: "   " }),
    });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ detail: "comment is required" });
  });

  it("missing repo_id -> 422 (after format checks pass)", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", issue_number: 1, comment: "hi" }),
    });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ detail: "repo_id is required" });
  });

  it("missing issue_number -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: 1, comment: "hi" }),
    });
    expect(resp.status).toBe(422);
    expect(await resp.json()).toEqual({ detail: "issue_number is required" });
  });

  it("repo doesn't exist -> 404", async () => {
    const { token } = await seedUser("admin", "action-root");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: 999999, issue_number: 1, comment: "hi" }),
    });
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ detail: "Repo not found" });
  });

  it("caller has NO permission -> 403 'Access denied to this repository'", async () => {
    const { token } = await seedUser("user", "action-noperm");
    const repoId = await seedRepo();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: repoId, issue_number: 1, comment: "hi" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied to this repository" });
  });

  it("caller has read-only permission -> 403 'Write access required'", async () => {
    const { id: userId, token } = await seedUser("user", "action-readonly");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "read");
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: repoId, issue_number: 1, comment: "hi" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Write access required" });
  });

  it("session_id belongs to ANOTHER user -> 403 'Access denied to this session'", async () => {
    const { id: userId, token } = await seedUser("user", "action-submitter");
    const other = await seedUser("user", "action-other-owner");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "write");
    const sessionId = await client.createSession("New Chat", other.id);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: repoId, issue_number: 1, comment: "hi", session_id: sessionId }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied to this session" });
  });

  it("session already resolved -> 409", async () => {
    const { id: userId, token } = await seedUser("user", "action-resolved");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "write");
    const sessionId = await client.createSession("New Chat", userId);
    await client.markSessionResolved(sessionId);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "comment", repo_id: repoId, issue_number: 1, comment: "hi", session_id: sessionId }),
    });
    expect(resp.status).toBe(409);
    expect((await resp.json()).detail).toContain("already been resolved");
  });

  it("draft_tool_use_id's stamped repo_id mismatches the submitted repo_id -> 400", async () => {
    const { id: userId, token } = await seedUser("user", "action-draft-mismatch");
    const repoA = await seedRepo({ url: "https://gitlab.example.com/group/repo-a2.git" });
    const repoB = await seedRepo({ url: "https://gitlab.example.com/group/repo-b2.git" });
    await client.grantPermission(userId, repoA, "write");
    const sessionId = await client.createSession("New Chat", userId);
    await client.addMessage(sessionId, "user", [
      {
        type: "tool_result",
        tool_use_id: "tu_draft_2",
        content: JSON.stringify({ repo_id: repoB }),
        is_error: false,
      },
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({
        action: "comment",
        repo_id: repoA,
        issue_number: 1,
        comment: "hi",
        session_id: sessionId,
        draft_tool_use_id: "tu_draft_2",
      }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).detail).toContain("提交的仓库与草稿时确认的仓库不一致");
  });

  it("successful action (close): {ok, issue_number, issue_url}; recorded row; session stays OPEN (QA-reported: used to force-resolve here)", async () => {
    const { id: userId, token } = await seedUser("admin", "action-admin");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    stubFetch([
      issueNoteRoute(201),
      issueStateRoute(200, { iid: 9, web_url: "https://gitlab.example.com/group/proj/-/issues/9", title: "T" }),
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({
        action: "close",
        repo_id: repoId,
        issue_number: 9,
        comment: "Closing per investigation",
        session_id: sessionId,
      }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      issue_number: 9,
      issue_url: "https://gitlab.example.com/group/proj/-/issues/9",
    });

    const rows = await client.getIssueActionsForSession(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo_id: repoId,
      user_id: userId,
      issue_number: 9,
      action: "close",
      comment: "Closing per investigation",
      issue_url: "https://gitlab.example.com/group/proj/-/issues/9",
    });

    const session = await client.getSession(sessionId);
    expect(session!.resolved_at).toBeNull();
    // No prior submission for repo+issue 9 in this test — getSubmissionByIssue
    // finds nothing, so the post-action recheck is skipped entirely (no
    // extra fetch calls beyond the note+state routes already stubbed above).
  });

  it("recheck fires when the acted-on issue DOES have a matching submission, and updates its tracker state", async () => {
    const { id: userId, token } = await seedUser("admin", "action-recheck");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    // Seed a prior submission for repo+issue 9 (a real submit isn't needed —
    // recordIssueSubmission directly, matching this file's existing style
    // for tests that only care about a pre-existing row).
    await client.recordIssueSubmission({
      sessionId,
      repoId,
      userId,
      title: "T",
      body: "B",
      labels: [],
      issueNumber: 9,
      issueUrl: "https://gitlab.example.com/group/proj/-/issues/9",
    });

    stubFetch([
      issueNoteRoute(201),
      issueStateRoute(200, { iid: 9, web_url: "https://gitlab.example.com/group/proj/-/issues/9", title: "T" }),
      issueGetRoute(200, { state: "closed", labels: [], closed_at: "2026-07-13 12:00:00.000000" }),
      RESOURCE_STATE_EVENTS_ROUTE,
      NOTES_GET_ROUTE, // derived status "closed" -> pollOne also fetches notes looking for a codex-report marker
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "close", repo_id: repoId, issue_number: 9, comment: "Closing", session_id: sessionId }),
    });
    expect(resp.status).toBe(200);

    const rows = await client.getIssueSubmissionsForSession(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].track_status).toBe("closed");
  });

  it("tracker returns a non-201 error shape on the note call -> 502; PUT never reached; nothing recorded", async () => {
    const { id: userId, token } = await seedUser("admin", "action-admin-502");
    const repoId = await seedRepo();
    const sessionId = await client.createSession("New Chat", userId);
    stubFetch([issueNoteRoute(500, {}, "internal server error")]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/action", {
      method: "POST",
      body: JSON.stringify({ action: "close", repo_id: repoId, issue_number: 9, comment: "hi", session_id: sessionId }),
    });
    expect(resp.status).toBe(502);
    expect((await resp.json()).detail).toBe("GitLab note API error (500): internal server error");
    expect(await client.getIssueActionsForSession(sessionId)).toHaveLength(0);
  });
});

// ==================== POST /api/issues/check-duplicates ====================

describe("POST /api/issues/check-duplicates", () => {
  it("missing repo_id -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ title: "dup" }),
    });
    expect(resp.status).toBe(422);
  });

  it("missing title -> 422", async () => {
    const { token } = await seedUser();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ repo_id: 1 }),
    });
    expect(resp.status).toBe(422);
  });

  it("repo not visible to caller (no permission, not admin) -> 403", async () => {
    const { token } = await seedUser("user", "dup-noperm");
    const repoId = await seedRepo();
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "dup" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({ detail: "Access denied to this repository" });
  });

  it("a READ-level grant is enough here (unlike submit/action, which need write)", async () => {
    const { id: userId, token } = await seedUser("user", "dup-readonly");
    const repoId = await seedRepo();
    await client.grantPermission(userId, repoId, "read");
    const app = buildTestApp();
    // Empty title keeps this test isolated from the tracker-search path below.
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ issues: [] });
  });

  it("empty/whitespace title -> {issues:[]} immediately, with ZERO fetch calls", async () => {
    const { token } = await seedUser("admin", "dup-admin");
    const repoId = await seedRepo();
    const fetchMock = stubFetch([]); // any call would throw — asserted explicitly below too
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "   " }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ issues: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-empty title -> calls through to the tracker search and returns its hits", async () => {
    const { token } = await seedUser("admin", "dup-admin2");
    const repoId = await seedRepo();
    stubFetch([
      issuesSearchRoute(200, [
        { iid: 7, title: "existing similar bug", web_url: "https://gitlab.example.com/group/proj/-/issues/7", state: "opened" },
      ]),
    ]);
    const app = buildTestApp();
    const resp = await authed(app, token, "/api/issues/check-duplicates", {
      method: "POST",
      body: JSON.stringify({ repo_id: repoId, title: "similar bug" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      issues: [{ number: 7, title: "existing similar bug", url: "https://gitlab.example.com/group/proj/-/issues/7", state: "opened" }],
    });
  });
});

// ==================== GET /api/issues/mine, unread-count, seen ====================

describe("GET /api/issues/mine / unread-count / POST mine/seen", () => {
  it("GET /api/issues/mine: cross-user isolation — A never sees B's submissions", async () => {
    const a = await seedUser("user", "mine-a");
    const b = await seedUser("user", "mine-b");
    const repoId = await seedRepo();
    const sessionA = await client.createSession("chat", a.id);
    const sessionB = await client.createSession("chat", b.id);
    await client.recordIssueSubmission({
      sessionId: sessionA, repoId, userId: a.id, title: "A's bug", body: "b", labels: [],
      issueNumber: 1, issueUrl: "https://gitlab.example.com/group/proj/-/issues/1",
    });
    await client.recordIssueSubmission({
      sessionId: sessionB, repoId, userId: b.id, title: "B's bug", body: "b", labels: [],
      issueNumber: 2, issueUrl: "https://gitlab.example.com/group/proj/-/issues/2",
    });

    const app = buildTestApp();
    const respA = await authed(app, a.token, "/api/issues/mine");
    const listA = await respA.json();
    expect(listA).toHaveLength(1);
    expect(listA[0].title).toBe("A's bug");

    const respB = await authed(app, b.token, "/api/issues/mine");
    const listB = await respB.json();
    expect(listB).toHaveLength(1);
    expect(listB[0].title).toBe("B's bug");
  });

  it("unread-count reflects status_changed_at vs my_issues_seen_at, scoped per user; mine/seen resets it for the caller only", async () => {
    const a = await seedUser("user", "unread-a");
    const b = await seedUser("user", "unread-b");
    const repoId = await seedRepo();
    const sessionA = await client.createSession("chat", a.id);
    const submissionId = await client.recordIssueSubmission({
      sessionId: sessionA, repoId, userId: a.id, title: "A's bug", body: "b", labels: [],
      issueNumber: 1, issueUrl: "https://gitlab.example.com/group/proj/-/issues/1",
    });
    // updateIssueTracking only stamps status_changed_at when the new status
    // DIFFERS from the current one (schema default is 'submitted') — so this
    // must pick a different value to actually move the needle.
    await client.updateIssueTracking(submissionId, { trackStatus: "closed" });

    const app = buildTestApp();
    const countA1 = await authed(app, a.token, "/api/issues/mine/unread-count");
    expect(await countA1.json()).toEqual({ count: 1 });

    const countB1 = await authed(app, b.token, "/api/issues/mine/unread-count");
    expect(await countB1.json()).toEqual({ count: 0 });

    const seenResp = await authed(app, a.token, "/api/issues/mine/seen", { method: "POST" });
    expect(seenResp.status).toBe(200);
    expect(await seenResp.json()).toEqual({ ok: true });

    const countA2 = await authed(app, a.token, "/api/issues/mine/unread-count");
    expect(await countA2.json()).toEqual({ count: 0 });

    // B was never touched by A's "seen" call.
    const countB2 = await authed(app, b.token, "/api/issues/mine/unread-count");
    expect(await countB2.json()).toEqual({ count: 0 });
  });
});
