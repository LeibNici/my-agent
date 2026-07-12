// Port of v1's app/issue_tracker.py (git show v1-python-final:app/issue_tracker.py).
// src/issue-tracker.ts's own module header documents the design rationale
// this suite exercises: reopen detection via GitLab's resource_state_events
// stream (not snapshot diffing), the poll target parsed from the
// submission's OWN stored issue_url (never the repo's current url) with the
// credential only used once the issue's host still matches the repo's
// current host, closed issues still polled once/day instead of going
// terminal, and deriveStatus's 'reopened' deliberately outranking 'merged'.
//
// Fetch is mocked via vi.stubGlobal (test/embedding-client.test.ts's
// established pattern for this codebase's offline suite). Storage is a real
// sqlite file (createDbClient + makeSeededDb), inspected directly with a
// secondary better-sqlite3 connection wherever the DbClient's own read
// methods don't expose a column this suite needs to assert on (track_error,
// remote_state, remote_labels, reopen_count, closed_at, verified) — the same
// "reopen the same file with the raw driver" idiom test/db-storage.test.ts
// and test/repo-sync.test.ts already use.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { loadSettings, type Settings } from "../src/config.js";
import type { IssueTrackingOverviewRow, FixReportRow } from "../src/db/storage.js";
import {
  deriveStatus,
  pollTrackedIssues,
  verifyPendingFixReports,
  periodicTrackingLoop,
  computeTrackingMetrics,
} from "../src/issue-tracker.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Record<string, string | undefined> = {}): Settings {
  return loadSettings({
    APP_GITHUB_TOKEN: "gh-default-token",
    APP_ISSUE_FIX_TARGET_BRANCH: "test",
    ...overrides,
  });
}

/** Raw column read for issue_submissions — covers track_error/remote_state/
 * remote_labels/reopen_count/closed_at/last_checked_at, none of which
 * IssueSubmissionRow (getIssueSubmissionsForSession's shape) exposes. */
function readSubmissionRaw(dbPath: string, id: number): any {
  const db = new Database(dbPath);
  const row = db.prepare("SELECT * FROM issue_submissions WHERE id = ?").get(id);
  db.close();
  return row;
}

function readFixReportRaw(dbPath: string, id: number): any {
  const db = new Database(dbPath);
  const row = db.prepare("SELECT * FROM issue_fix_reports WHERE id = ?").get(id);
  db.close();
  return row;
}

function makeFixReport(overrides: Partial<FixReportRow> = {}): FixReportRow {
  return {
    submission_id: 1,
    note_id: 1,
    worker_id: "w1",
    commit_sha: "abc123",
    files: [],
    verified: 1,
    reported_at: null,
    ...overrides,
  };
}

/** repo-sync.test.ts's own polling-wait idiom — used instead of vi's fake
 * timers for periodicTrackingLoop: fake timers only mock the MAIN thread's
 * setTimeout, but pollTrackedIssues here runs against a REAL createDbClient,
 * whose calls round-trip through an actual worker_threads MessagePort. That
 * round trip needs a genuine turn of the real event loop to settle — one
 * `vi.advanceTimersByTimeAsync` call doesn't reliably wait for it, so a tick
 * can still be mid-flight when the test's own afterEach calls client.close(),
 * producing a spurious "db client is closed" failure. Real timers + a tiny
 * fractional-minute interval sidesteps this entirely (mirrors why
 * repo-sync.test.ts's own periodicSyncLoop tests use a fake `{} as unknown as
 * DbClient` instead of a real one — periodicTrackingLoop has no equivalent
 * injection point for pollTrackedIssues to swap in a fake). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeOverviewRow(overrides: Partial<IssueTrackingOverviewRow> = {}): IssueTrackingOverviewRow {
  return {
    id: 1,
    repo_id: 1,
    repo_name: "repo",
    title: "title",
    body: "",
    issue_number: 1,
    issue_url: "https://gitlab.example.com/g/p/-/issues/1",
    labels: [],
    submitted_at: "2026-07-01T00:00:00.000000",
    track_status: "closed",
    remote_state: "closed",
    remote_labels: [],
    reopen_count: 0,
    closed_at: null,
    last_checked_at: null,
    track_error: null,
    username: "alice",
    fix_reports: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveStatus — pure priority table
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  it("remoteState 为 closed 时优先级最高：即使 reopenCount 很大、标签里有 merged 也仍返回 closed", () => {
    expect(deriveStatus("closed", [], 0)).toBe("closed");
    expect(deriveStatus("closed", ["codex:merged-to-test"], 500)).toBe("closed");
  });

  it("非 closed + reopenCount>0 -> reopened，即使标签里有 codex:merged-to-test 也不能被读成 merged", () => {
    expect(deriveStatus("opened", [], 1)).toBe("reopened");
    expect(deriveStatus("opened", ["codex:merged-to-test"], 3)).toBe("reopened");
  });

  it("无 reopen + codex:merged-to-test（大小写不敏感）-> merged", () => {
    expect(deriveStatus("opened", ["codex:merged-to-test"], 0)).toBe("merged");
    expect(deriveStatus("opened", ["CODEX:MERGED-TO-TEST"], 0)).toBe("merged");
    expect(deriveStatus("opened", ["Codex:Merged-To-Test"], 0)).toBe("merged");
  });

  it("无 reopen、无 merged 标签，但有 codex:in-progress -> claimed", () => {
    expect(deriveStatus("opened", ["codex:in-progress"], 0)).toBe("claimed");
  });

  it("以上都不满足 -> submitted", () => {
    expect(deriveStatus("opened", [], 0)).toBe("submitted");
    expect(deriveStatus("opened", ["some-other-label"], 0)).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// computeTrackingMetrics — pure aggregation over hand-built fixtures
// ---------------------------------------------------------------------------

describe("computeTrackingMetrics", () => {
  it("fixed_count 只统计至少一条 verified===1 的提交；verified:0 / verified:null / 没有 fix_reports 的都不计入", () => {
    const withVerified = makeOverviewRow({ id: 1, fix_reports: [makeFixReport({ verified: 1 })] });
    const withUnverifiedZero = makeOverviewRow({ id: 2, fix_reports: [makeFixReport({ verified: 0 })] });
    const withUnverifiedNull = makeOverviewRow({ id: 3, fix_reports: [makeFixReport({ verified: null })] });
    const withNoReports = makeOverviewRow({ id: 4, fix_reports: [] });

    const result = computeTrackingMetrics([withVerified, withUnverifiedZero, withUnverifiedNull, withNoReports]);
    expect(result.fixed_count).toBe(1);
  });

  it("avg_fix_hours：naive-local ISO（无 Z 后缀）算出的小时差平均后四舍五入到 1 位小数；closed_at 早于或等于 submitted_at 的提交被排除在平均之外（不计为 0/负值）", () => {
    const s1 = makeOverviewRow({
      id: 1,
      submitted_at: "2026-07-01T10:00:00.000000",
      closed_at: "2026-07-01T11:00:00.000000", // 1.0h
      fix_reports: [makeFixReport({ verified: 1 })],
    });
    const s2 = makeOverviewRow({
      id: 2,
      submitted_at: "2026-07-02T08:00:00.000000",
      closed_at: "2026-07-02T09:50:00.000000", // 1h50m = 1.8333...h
      fix_reports: [makeFixReport({ verified: 1 })],
    });
    const s3Before = makeOverviewRow({
      id: 3,
      submitted_at: "2026-07-03T10:00:00.000000",
      closed_at: "2026-07-03T09:00:00.000000", // BEFORE submitted_at
      fix_reports: [makeFixReport({ verified: 1 })],
    });
    const s4Equal = makeOverviewRow({
      id: 4,
      submitted_at: "2026-07-04T10:00:00.000000",
      closed_at: "2026-07-04T10:00:00.000000", // EQUAL to submitted_at
      fix_reports: [makeFixReport({ verified: 1 })],
    });

    const result = computeTrackingMetrics([s1, s2, s3Before, s4Equal]);
    expect(result.fixed_count).toBe(4); // all 4 count as "fixed" — each has >=1 verified report
    // avg(1.0, 1.8333...) = 1.41666... -> rounds to 1.4; s3/s4 excluded from
    // the average itself (not counted as 0h or negative).
    expect(result.avg_fix_hours).toBe(1.4);
  });

  it("hit_rate/hit_sample：body 含路径引用的计入 hit_sample 分母；verified fix report 的 files 精确匹配或后缀匹配都算命中，不匹配的算 miss", () => {
    const exactHit = makeOverviewRow({
      id: 1,
      body: "see wms/scan/ScanService.java for details",
      fix_reports: [makeFixReport({ verified: 1, files: ["wms/scan/ScanService.java"] })],
    });
    const suffixHit = makeOverviewRow({
      id: 2,
      // body 引用带了额外的 monorepo 前缀，report 里的 file 是它的路径后缀
      body: "see backend/wms/scan/ScanService.java for details",
      fix_reports: [makeFixReport({ verified: 1, files: ["wms/scan/ScanService.java"] })],
    });
    const miss = makeOverviewRow({
      id: 3,
      body: "see wms/scan/OtherService.java for details", // 有引用，但修复动的是别的文件
      fix_reports: [makeFixReport({ verified: 1, files: ["wms/scan/ScanService.java"] })],
    });
    const noRefs = makeOverviewRow({
      id: 4,
      body: "no code paths mentioned here at all",
      fix_reports: [makeFixReport({ verified: 1, files: ["a/b.ts"] })],
    });

    const result = computeTrackingMetrics([exactHit, suffixHit, miss, noRefs]);
    expect(result.hit_sample).toBe(3); // exactHit/suffixHit/miss 都带路径引用；noRefs 不带，不影响分母
    expect(result.hit_rate).toBeCloseTo(2 / 3, 3); // exactHit + suffixHit 命中，miss 不命中
  });

  it("没有任何 fixed 提交时，avg_fix_hours/hit_rate 为 null（不是 0/NaN），hit_sample 为 0", () => {
    const notFixed = makeOverviewRow({ id: 1, fix_reports: [] });
    const result = computeTrackingMetrics([notFixed]);
    expect(result.fixed_count).toBe(0);
    expect(result.avg_fix_hours).toBeNull();
    expect(result.hit_rate).toBeNull();
    expect(result.hit_sample).toBe(0);
  });

  it("有 fixed 提交，但没有一个 body 带路径引用时：hit_rate 为 null、hit_sample 为 0，avg_fix_hours 仍正常计算（两者互不影响）", () => {
    const fixedNoRefs = makeOverviewRow({
      id: 1,
      body: "nothing about file paths here",
      submitted_at: "2026-07-01T10:00:00.000000",
      closed_at: "2026-07-01T11:00:00.000000",
      fix_reports: [makeFixReport({ verified: 1 })],
    });
    const result = computeTrackingMetrics([fixedNoRefs]);
    expect(result.fixed_count).toBe(1);
    expect(result.avg_fix_hours).toBe(1);
    expect(result.hit_rate).toBeNull();
    expect(result.hit_sample).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pollTrackedIssues (exercises the private pollOne/pollGithub indirectly)
// ---------------------------------------------------------------------------

describe("pollTrackedIssues", () => {
  let dir: string, dbPath: string, client: DbClient;

  beforeEach(() => {
    const seeded = makeSeededDb();
    dir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("关联仓库在 listReposFull() 里查不到时，写 track_error 且不改动 track_status；从不发起 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = makeSettings();

    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId: 999999, // 不存在的仓库
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 1,
      issueUrl: "https://gitlab.example.com/g/p/-/issues/1",
    });

    const count = await pollTrackedIssues(client, settings);
    expect(count).toBe(1);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBe("关联仓库已被删除，无法追踪");
    expect(raw.track_status).toBe("submitted"); // 未被改动（schema 默认值）
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issue_url 与仓库当前 url 主机不一致（凭证安全闸）：写 track_error 提及不一致，且从不发起任何 fetch（凭证不外发）", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://host-a.example.com/group/proj.git",
      credToken: "super-secret-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 3,
      issueUrl: "https://host-b.example.com/group/proj/-/issues/3", // 不同主机
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBe(
      "issue 所在主机(host-b.example.com)与仓库当前主机(host-a.example.com)不一致，凭证不外发，暂停追踪"
    );
    // 这条护栏在任何网络调用之前就返回了 —— 仓库的 cred_token 从未有机会外发。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issue_url 是 github.com -> 走 GitHub 轮询路径，用 settings.githubToken 认证，而非仓库自己的 cred_token", async () => {
    const settings = makeSettings({ APP_GITHUB_TOKEN: "gh-global-token-xyz" });
    // 仓库自己的 url 故意用别的主机 + 别的 token：证明 GitHub 分支完全不看仓库主机
    // 是否匹配、也不会把仓库自己的凭证用在这条路径上。
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/group/proj.git",
      credToken: "repo-own-gitlab-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 42,
      issueUrl: "https://github.com/acme/widgets/issues/42",
    });

    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ state: "open", labels: ["bug"], closed_at: null }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/42");
    expect(init.headers.Authorization).toBe("token gh-global-token-xyz");
    expect(init.headers.Authorization).not.toContain("repo-own-gitlab-token");

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_status).toBe("submitted");
    expect(raw.remote_state).toBe("opened");
    expect(JSON.parse(raw.remote_labels)).toEqual(["bug"]);
  });

  it("GitLab 成功路径：issue GET + resource_state_events + notes（含 codex-report/v1 标记）-> 落库 derived status/remote_state/labels/reopen_count/closed_at，清空 track_error；fix report 经 getUnverifiedFixReports 可读到", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/group/proj.git",
      credToken: "gitlab-secret-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 7,
      issueUrl: "https://gitlab.example.com/group/proj/-/issues/7",
    });
    // 预先埋一个失败信息，证明成功轮询后会被清空。
    await client.updateIssueTracking(subId, { trackError: "previous failure" });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) {
        return {
          status: 200,
          json: async () => [
            { state: "reopened", created_at: "2026-07-09T00:00:00.000Z" },
            { state: "closed", created_at: "2026-07-10T08:00:00.000Z" },
          ],
        } as unknown as Response;
      }
      if (url.includes("/notes")) {
        return {
          status: 200,
          json: async () => [
            {
              id: 501,
              body:
                'fixed it. <!-- codex-report/v1 {"worker_id":"w1","commit_sha":"abcd1234","files":["wms/scan/ScanService.java"]} --> thanks',
              created_at: "2026-07-10T09:00:00.000Z",
            },
          ],
        } as unknown as Response;
      }
      if (/\/issues\/7(\?|$)/.test(url)) {
        return {
          status: 200,
          json: async () => ({ state: "closed", labels: ["type::bug"], closed_at: "2026-07-10T08:00:00.000Z" }),
        } as unknown as Response;
      }
      if (url.includes("/repository/commits/")) {
        // pollTrackedIssues 在同一轮结尾会紧接着调 verifyPendingFixReports——
        // 刚存的 fix report 会被它立刻捞到。这里故意返回一个非 404/200 的状态码
        // （resp 两个分支都不落，不记录任何 verdict），让这条测试能纯粹断言
        // "poll 阶段本身落了什么"，而不被同一轮里顺带跑的 verify 阶段干扰——
        // verify 阶段自己的行为在下面 verifyPendingFixReports 那个 describe 里
        // 有专门覆盖。
        return { status: 500, json: async () => ({}), text: async () => "unrelated" } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await pollTrackedIssues(client, settings);
    expect(count).toBe(1);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_status).toBe("closed"); // closed 优先级压过 reopened，即便 reopen_count=1
    expect(raw.remote_state).toBe("closed");
    expect(JSON.parse(raw.remote_labels)).toEqual(["type::bug"]);
    expect(raw.reopen_count).toBe(1);
    expect(raw.closed_at).toBe("2026-07-10T08:00:00.000Z");
    expect(raw.track_error).toBeNull(); // 之前埋的 "previous failure" 被清空

    // 每次 GitLab 调用都必须带上这个仓库自己的 cred_token。
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { headers?: Record<string, string> } | undefined;
      if (init?.headers?.["PRIVATE-TOKEN"] !== undefined) {
        expect(init.headers["PRIVATE-TOKEN"]).toBe("gitlab-secret-token");
      }
    }

    const unverified = await client.getUnverifiedFixReports();
    const mine = unverified.find((r) => r.submission_id === subId);
    expect(mine).toBeDefined();
    expect(mine!.commit_sha).toBe("abcd1234");
    expect(mine!.issue_url).toBe("https://gitlab.example.com/group/proj/-/issues/7");
    expect(mine!.repo_id).toBe(repoId);
  });

  it("一行轮询失败不会中断整轮：第一条 fetch 失败仍记录 track_error，第二条照常成功更新；返回的计数覆盖两条", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj2",
      url: "https://gitlab.example.com/group/proj2.git",
      credToken: "tok2",
    });
    const sub1Id = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t1",
      body: "b1",
      labels: [],
      issueNumber: 100,
      issueUrl: "https://gitlab.example.com/group/proj2/-/issues/100",
    });
    const sub2Id = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t2",
      body: "b2",
      labels: [],
      issueNumber: 200,
      issueUrl: "https://gitlab.example.com/group/proj2/-/issues/200",
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/issues/100")) {
        throw new Error("network boom"); // 第一条（较小 id，先被轮询）的请求失败
      }
      if (url.includes("/resource_state_events")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.includes("/issues/200")) {
        return {
          status: 200,
          json: async () => ({ state: "opened", labels: [], closed_at: null }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await pollTrackedIssues(client, settings);
    expect(count).toBe(2); // 计数不受单行失败影响

    const raw1 = readSubmissionRaw(dbPath, sub1Id);
    expect(raw1.track_error).toBe("Error: network boom");
    expect(raw1.track_status).toBe("submitted"); // 从未走到更新状态那一步

    const raw2 = readSubmissionRaw(dbPath, sub2Id);
    expect(raw2.track_error).toBeNull();
    expect(raw2.track_status).toBe("submitted");
    expect(raw2.remote_state).toBe("opened");
    expect(raw2.reopen_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyPendingFixReports
// ---------------------------------------------------------------------------

describe("verifyPendingFixReports", () => {
  let dir: string, dbPath: string, client: DbClient;

  beforeEach(() => {
    const seeded = makeSeededDb();
    dir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function seedUnverifiedReport(opts: {
    credToken?: string | null;
    issueUrl?: string | null;
  }): Promise<{ repoId: number; subId: number; reportId: number }> {
    const repoId = await client.createRepo({
      name: "proj3",
      url: "https://gitlab.example.com/group/proj3.git",
      credToken: opts.credToken !== undefined ? opts.credToken : "verify-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 9,
      issueUrl: opts.issueUrl !== undefined ? opts.issueUrl : "https://gitlab.example.com/group/proj3/-/issues/9",
    });
    const reportId = await client.upsertFixReport({
      submissionId: subId,
      noteId: 1,
      workerId: "w1",
      commitSha: "deadbeef1234",
      files: ["a.ts"],
      reportedAt: null,
    });
    return { repoId, subId, reportId };
  }

  it("commit refs GET 返回 404（commit 不存在）-> setFixReportVerified(id, false)，verified 变为 0", async () => {
    const { reportId } = await seedUnverifiedReport({});
    const fetchMock = vi.fn(async () => ({
      status: 404,
      json: async () => ({}),
      text: async () => "not found",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings();
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);

    const raw = readFixReportRaw(dbPath, reportId);
    expect(raw.verified).toBe(0);
  });

  it("commit refs GET 返回 200，branches 数组包含 settings.issueFixTargetBranch -> verified 变为 1", async () => {
    const { reportId } = await seedUnverifiedReport({});
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toContain("/repository/commits/deadbeef1234/refs");
      expect(init?.headers?.["PRIVATE-TOKEN"]).toBe("verify-token");
      return { status: 200, json: async () => [{ name: "test" }, { name: "main" }] } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);

    const raw = readFixReportRaw(dbPath, reportId);
    expect(raw.verified).toBe(1);
  });

  it("commit refs GET 返回 200，但 branches 里没有目标分支 -> verified 变为 0", async () => {
    const { reportId } = await seedUnverifiedReport({});
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => [{ name: "main" }, { name: "develop" }],
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);

    const raw = readFixReportRaw(dbPath, reportId);
    expect(raw.verified).toBe(0);
  });

  it("仓库没有配置 cred_token -> 该行保持未验证（verified 仍是 NULL），且从不发起 fetch", async () => {
    const { reportId } = await seedUnverifiedReport({ credToken: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings();
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(0);

    const raw = readFixReportRaw(dbPath, reportId);
    expect(raw.verified).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issue_url 为 null -> 该行保持未验证，且从不发起 fetch", async () => {
    const { reportId } = await seedUnverifiedReport({ issueUrl: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings();
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(0);

    const raw = readFixReportRaw(dbPath, reportId);
    expect(raw.verified).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// periodicTrackingLoop — structural mirror of repo-sync.ts's
// periodicSyncLoop (setTimeout+unref, sleep-then-tick, disabled by a
// non-positive interval, returns {stop}). Unlike that file's own test block,
// this uses REAL timers (tiny fractional-minute intervals) rather than
// vi.useFakeTimers() — see the waitFor helper's comment above for why.
// ---------------------------------------------------------------------------

describe("periodicTrackingLoop", () => {
  let dir: string, dbPath: string, client: DbClient;

  beforeEach(() => {
    const seeded = makeSeededDb();
    dir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(dbPath);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("intervalMinutes<=0 时完全不调度：stop() 是安全的 no-op，且真实等待过后也不会有任何一轮 poll 发生", async () => {
    const settings = makeSettings();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const repoId = await client.createRepo({
      name: "p",
      url: "https://gitlab.example.com/g/p.git",
      credToken: "t",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 1,
      issueUrl: "https://gitlab.example.com/g/p/-/issues/1",
    });

    const { stop } = periodicTrackingLoop(0, client, settings);
    // 真实等待一段远大于下面"正的 interval"测试所用间隔的时间，证明即使时间
    // 正常流逝也绝不会有一轮 poll 发生。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchMock).not.toHaveBeenCalled();
    // updateIssueTracking 每次都会盖章 last_checked_at —— 它全程保持 NULL
    // 就是"从未跑过一轮 poll"最直接的证据。
    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.last_checked_at).toBeNull();
    expect(() => stop()).not.toThrow();
  });

  it("正的 interval：过一个周期后跑了一轮 poll；stop() 之后即便再等待也不会触发下一轮", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "p",
      url: "https://gitlab.example.com/g/p.git",
      credToken: "t",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 5,
      issueUrl: "https://gitlab.example.com/g/p/-/issues/5",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      return { status: 200, json: async () => ({ state: "opened", labels: [], closed_at: null }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    // 分钟数取一个极小的分数（0.0005 分钟 = 30ms 真实间隔）——不用假定时器，
    // 直接用真实定时器 + 真实极短等待，两头都不用 mock 调度本身。
    const intervalMinutes = 0.0005;
    const { stop } = periodicTrackingLoop(intervalMinutes, client, settings);
    expect(fetchMock).not.toHaveBeenCalled(); // 第一个 interval 到之前不触发

    await waitFor(() => readSubmissionRaw(dbPath, subId).remote_state !== null);
    const rawAfterFirst = readSubmissionRaw(dbPath, subId);
    expect(rawAfterFirst.remote_state).toBe("opened"); // 证明确实跑了一轮 poll
    expect(rawAfterFirst.last_checked_at).not.toBeNull();

    stop();
    const checkedAtAfterStop = rawAfterFirst.last_checked_at;
    // 远大于一个 interval 的真实等待——如果 stop() 没生效，这段时间里足够再
    // 触发好几轮。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rawAfterStop = readSubmissionRaw(dbPath, subId);
    expect(rawAfterStop.last_checked_at).toBe(checkedAtAfterStop); // 没有再触发下一轮
  });
});
