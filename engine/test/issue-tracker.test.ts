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
  pollSubmissionById,
  verifyPendingFixReports,
  periodicTrackingLoop,
  computeTrackingMetrics,
} from "../src/issue-tracker.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Record<string, string | undefined> = {}): Settings {
  return loadSettings({
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

function readFixReportsRaw(dbPath: string, submissionId: number): any[] {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT * FROM issue_fix_reports WHERE submission_id = ? ORDER BY note_id").all(submissionId);
  db.close();
  return rows;
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
      "issue 所在项目(host-b.example.com/group/proj)与仓库当前配置(host-a.example.com/group/proj)不一致，凭证不外发，暂停追踪"
    );
    // 这条护栏在任何网络调用之前就返回了 —— 仓库的 cred_token 从未有机会外发。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Codex full-repo review (2026-07-14, Warning): 原来的护栏只比较了主机名
  // —— 挡住了"仓库迁移到完全不同的 tracker/主机"这种最坏情况，但对"同一个
  // GitLab 实例上，仓库被改指向另一个 group/project"完全没有防护：仓库当
  // 前的（新）cred_token 会被发到旧 issue_url 所在的、和这个 token 毫无关
  // 系的另一个项目——这是真的凭证外泄，不只是数据错位。
  it("issue_url 与仓库当前 url 同主机、不同 project（仓库被改指向了另一个 group/project）-> 同样被护栏拦截，新 token 不外发到旧项目", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/team-b/project-y.git", // 仓库现在指向 team-b/project-y
      credToken: "new-token-after-migration",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 7,
      // 这条记录是仓库还指向 team-a/project-x 时提交的，issue_url 还留在旧项目。
      issueUrl: "https://gitlab.example.com/team-a/project-x/-/issues/7",
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    // 关键断言：即使主机相同，新 token 也绝不能被发到旧项目 team-a/project-x。
    expect(fetchMock).not.toHaveBeenCalled();
    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBe(
      "issue 所在项目(gitlab.example.com/team-a/project-x)与仓库当前配置(gitlab.example.com/team-b/project-y)不一致，凭证不外发，暂停追踪"
    );
  });

  it("issue_url 与仓库当前 url 主机、project 都一致 -> 正常放行轮询（回归保护：新护栏不误伤正常场景）", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/team-a/project-x.git",
      credToken: "still-valid-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 7,
      issueUrl: "https://gitlab.example.com/team-a/project-x/-/issues/7",
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) return { status: 200, json: async () => [] } as unknown as Response;
      if (url.includes("/issues/7")) {
        return { status: 200, json: async () => ({ state: "opened", labels: [], closed_at: null }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    expect(fetchMock).toHaveBeenCalled();
    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBeNull();
    expect(raw.track_status).toBe("submitted");
  });

  it("issue_url 是 github.com 且主机与仓库一致 -> 走 GitHub 轮询路径，用仓库自己的 cred_token 认证（不再有单独的全局 token）", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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

    // Codex 全仓库审查（2026-07-14，生产 QA 复测）：pollGithub 现在还会额外
    // 调一次 Timeline API（/timeline）算真实的 reopen 次数，不再是硬编码的
    // 0——mock 按 URL 区分两个端点，而不是不管什么请求都返回同一个 issue
    // 详情形状（真实 Timeline 响应是数组，不是 issue 详情那样的对象）。
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ state: "open", labels: ["bug"], closed_at: null }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const issueCall = fetchMock.mock.calls.find(([u]) => !String(u).includes("/timeline"))!;
    const [url, init] = issueCall as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/42");
    expect(init.headers.Authorization).toBe("token repo-own-github-token");
    const timelineCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/timeline"))!;
    expect(timelineCall[0]).toBe("https://api.github.com/repos/acme/widgets/issues/42/timeline?per_page=100&page=1");

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_status).toBe("submitted");
    expect(raw.remote_state).toBe("opened");
    expect(JSON.parse(raw.remote_labels)).toEqual(["bug"]);
    expect(raw.reopen_count).toBe(0);
  });

  // 生产 QA 复测（2026-07-14）：外部在 GitHub 上重开一个 issue 后，webhook
  // 回调正常触发 pollGithub 重新轮询，状态从"已关闭"正确变回"已提报"，但
  // reopen 计数一直停在 0——因为 pollGithub 从功能上线起就一直硬编码传 0
  // 给 deriveStatus，从没真的算过。这条测试还原完整场景：仓库当前是
  // opened（真实重开后的状态），Timeline API 返回一条真实的 reopened
  // 事件，验证 reopen_count 落库为 1，而不是永远的 0。
  it("GitHub issue 真实被重开过一次 -> Timeline API 返回一条 reopened 事件，reopen_count 落库为 1（不再永远是 0）", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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
    // 预先埋一个"曾经是 closed"的旧状态，证明重开后不仅状态会变，
    // reopen_count 也会真的从 0 变成非 0。
    await client.updateIssueTracking(
      subId,
      { trackStatus: "closed", remoteState: "closed", reopenCount: 0 },
      await client.beginPoll(subId),
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return {
          status: 200,
          json: async () => [
            { event: "closed", created_at: "2026-07-10T08:00:00Z" },
            { event: "reopened", created_at: "2026-07-14T09:00:00Z" },
            { event: "commented", created_at: "2026-07-14T09:05:00Z" },
          ],
        } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ state: "open", labels: [], closed_at: null }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, settings);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.reopen_count).toBe(1);
    expect(raw.track_status).toBe("reopened"); // deriveStatus: reopenCount > 0 优先于 labels 判断
    expect(raw.remote_state).toBe("opened");
  });

  // 2026-07-15, Codex review follow-up (post-fc64ff40): Timeline API 返回
  // 非 200/404（这里用 429 模拟限流）以前会被 fetchGithubTimelineReopens
  // 悄悄降级成 0，调用方把这个 0 当权威值用——一个真实被重开、目前仍是
  // reopened 状态的 issue，只要这一轮恰好撞上限流，reopen_count 就会被
  // 写回 0、track_status 跟着从 reopened 倒退回 submitted，还会把之前埋的
  // track_error 一并清空，整个过程看起来像"轮询正常完成"而不是"数据不完
  // 整"。这条测试证明修复后：reopen_count 沿用上一次的值（1，不是 0），
  // status 不倒退，track_error 换成明确指出本轮部分数据没拿到的信息，而
  // 不是被 clearError 抹掉；同时 remote_state/remote_labels/closed_at 这些
  // 快照本身成功拿到的数据仍然正常更新，不因为 timeline 那一路失败就整轮
  // 作废。
  it("Timeline API 本轮返回 429（限流）-> reopen_count 沿用上次结果，不倒退回 0/submitted，track_error 说明本轮部分数据缺失而不是被清空", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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
    // 上一轮已经确认过这个 issue 被重开过一次。
    await client.updateIssueTracking(
      subId,
      { trackStatus: "reopened", remoteState: "opened", reopenCount: 1 },
      await client.beginPoll(subId),
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return { status: 429, json: async () => ({ message: "rate limited" }) } as unknown as Response;
      }
      // issue 快照本身这一轮成功拿到了新数据（labels 变了），证明快照更新
      // 不应该被 timeline 那一路的失败拖累。
      return {
        status: 200,
        json: async () => ({ state: "open", labels: ["type::bug"], closed_at: null }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, settings);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.reopen_count).toBe(1); // 沿用上次的值，没有被 429 悄悄改成 0
    expect(raw.track_status).toBe("reopened"); // 没有从 reopened 倒退回 submitted
    expect(raw.remote_state).toBe("opened"); // 快照本身的数据仍然正常更新
    expect(JSON.parse(raw.remote_labels)).toEqual(["type::bug"]);
    expect(raw.track_error).toContain("重开事件数据本轮获取失败"); // 不是被 clearError 悄悄抹掉
  });

  // Timeline API 返回 404（这个 repo/issue 真的没有 timeline，理论上 GitHub
  // 上极少见，但跟 GitLab 那边"老版本没有 resource_state_events 端点"保持
  // 对称处理）—— 这是一个永久性的"这个功能不存在"信号，跟 429 那种瞬时失败
  // 不是一回事，应该继续按"确认为 0"降级，而不是也被当成"未知"。
  it("Timeline API 返回 404 -> 视为确认没有重开事件（0），跟 429 的'未知'区分开，不产生 track_error", async () => {
    const settings = makeSettings();
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return { status: 404, json: async () => ({}) } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ state: "open", labels: [], closed_at: null }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, settings);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.reopen_count).toBe(0);
    expect(raw.track_status).toBe("submitted");
    expect(raw.track_error).toBeNull();
  });

  // 生产 QA 复测（2026-07-14）：一个真实 GitLab 仓库的修复 bot 已经在留
  // codex-report/v1 完成报告，但 fetchAndStoreReports 从功能上线起就只接
  // 在 GitLab 轮询路径里——GitHub 从来没有等价实现，Admin 工单页的已验证
  // 修复/平均修复时长/嫌疑位置命中率对所有 GitHub 仓库永远是空的。这条测
  // 试证明新增的 fetchAndStoreReportsGithub 真的被接进 pollGithub：issue
  // 关闭后（status===closed）应该额外请求 Comments API，解析出匹配
  // issueFixBotUsername 的评论里的标记，落库到 issue_fix_reports。
  it("GitHub issue 关闭且有 bot 完成报告评论 -> codex-report/v1 标记被解析并落库（fetchAndStoreReportsGithub，此前从未实现）", async () => {
    const settings = makeSettings({ APP_ISSUE_FIX_BOT_USERNAME: "botuser" });
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.includes("/comments")) {
        return {
          status: 200,
          json: async () => [
            {
              id: 999,
              body:
                '✅ 修复完成并已合入\n<!-- codex-report/v1 {"worker_id":"w1","commit_sha":"abc123","files":["src/a.ts"]} -->',
              created_at: "2026-07-14T10:00:00Z",
              user: { login: "botuser" },
            },
            {
              id: 1000,
              body: "无关评论，没有标记",
              created_at: "2026-07-14T10:01:00Z",
              user: { login: "someone-else" },
            },
          ],
        } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ state: "closed", labels: [], closed_at: "2026-07-14T10:00:00Z" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    const commentsCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/comments"));
    expect(commentsCall).toBeTruthy();
    expect(commentsCall![0]).toBe("https://api.github.com/repos/acme/widgets/issues/42/comments?per_page=100&page=1");

    const reports = readFixReportsRaw(dbPath, subId);
    expect(reports.length).toBe(1); // 无标记的第二条评论没有产生行
    expect(reports[0].commit_sha).toBe("abc123");
    expect(reports[0].worker_id).toBe("w1");
    expect(JSON.parse(reports[0].files_json)).toEqual(["src/a.ts"]);
  });

  it("GitHub issue 关闭但没配置 issueFixBotUsername -> 完全不请求 comments 端点（跟 GitLab 一样的信任门槛，不是默认信任所有人）", async () => {
    const settings = makeSettings(); // issueFixBotUsername 留空
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) return { status: 200, json: async () => [] } as unknown as Response;
      return {
        status: 200,
        json: async () => ({ state: "closed", labels: [], closed_at: "2026-07-14T10:00:00Z" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/comments"))).toBe(false);
    expect(readFixReportsRaw(dbPath, subId).length).toBe(0);
  });

  it("issue_url 是 github.com 但主机与仓库当前 url 不一致 -> 护栏拦截，不发请求（GitHub 现在和 GitLab 走同一条主机匹配规则）", async () => {
    const settings = makeSettings();
    // 仓库自己的 url 故意指向别的主机：证明 GitHub 分支现在也遵守主机匹配护栏，
    // 不会把仓库凭证发到一个 issue_url 主机不匹配的地方。
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

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pollTrackedIssues(client, settings);

    expect(fetchMock).not.toHaveBeenCalled();
    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBe(
      "issue 所在项目(github.com/acme/widgets)与仓库当前配置(gitlab.example.com/group/proj)不一致，凭证不外发，暂停追踪"
    );
  });

  it("GitLab 成功路径：issue GET + resource_state_events + notes（含 codex-report/v1 标记）-> 落库 derived status/remote_state/labels/reopen_count/closed_at，清空 track_error；fix report 经 getUnverifiedFixReports 可读到", async () => {
    const settings = makeSettings({ APP_ISSUE_FIX_BOT_USERNAME: "codex-fleet-bot" });
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
    await client.updateIssueTracking(subId, { trackError: "previous failure" }, await client.beginPoll(subId));

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
              author: { username: "codex-fleet-bot" },
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

  // 2026-07-15, Codex review follow-up (post-fc64ff40) — GitLab 版本的同一
  // 个修复，跟上面 GitHub Timeline 429 那条测试对称：resource_state_events
  // 本轮返回 429，不应该把 reopen_count 悄悄写回 0、也不应该把 trackStatus
  // 从 reopened 拉回别的状态，更不应该用 clearError 把这次数据不完整的事实
  // 抹掉。
  it("resource_state_events 本轮返回 429（限流）-> reopen_count 沿用上次结果，不倒退，track_error 说明本轮部分数据缺失", async () => {
    const settings = makeSettings({ APP_ISSUE_FIX_BOT_USERNAME: "codex-fleet-bot" });
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
    await client.updateIssueTracking(
      subId,
      { trackStatus: "reopened", remoteState: "opened", reopenCount: 1 },
      await client.beginPoll(subId),
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) {
        return { status: 429, json: async () => ({ message: "rate limited" }) } as unknown as Response;
      }
      if (url.includes("/notes")) {
        // status 仍然算出 reopened（沿用上次的 reopenCount=1），会照常触发
        // fetchAndStoreReports 的 notes 拉取——跟这条测试要证明的东西无关，
        // 给个空列表即可。
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      if (/\/issues\/7(\?|$)/.test(url)) {
        return {
          status: 200,
          json: async () => ({ state: "opened", labels: ["type::bug"], closed_at: null }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await pollTrackedIssues(client, settings);
    expect(count).toBe(1);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.reopen_count).toBe(1); // 沿用上次的值，没有被 429 悄悄改成 0
    expect(raw.track_status).toBe("reopened"); // 没有倒退
    expect(raw.remote_state).toBe("opened"); // 快照本身的数据仍然正常更新
    expect(JSON.parse(raw.remote_labels)).toEqual(["type::bug"]);
    expect(raw.track_error).toContain("重开事件数据本轮获取失败");
  });

  // resource_state_events 返回 404（老版本 GitLab 没有这个端点）—— 永久性
  // 的"这个功能不存在"信号，跟 429 的瞬时失败要区分开，继续按"确认为 0"
  // 降级，不产生 track_error（否则老版本 GitLab 的仓库会永远显示一个错误
  // 标记，而这其实是正常、预期内的行为）。
  it("resource_state_events 返回 404 -> 视为确认没有重开事件（0），跟 429 的'未知'区分开，不产生 track_error", async () => {
    const settings = makeSettings({ APP_ISSUE_FIX_BOT_USERNAME: "codex-fleet-bot" });
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) {
        return { status: 404, json: async () => ({}) } as unknown as Response;
      }
      if (/\/issues\/7(\?|$)/.test(url)) {
        return {
          status: 200,
          json: async () => ({ state: "opened", labels: [], closed_at: null }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const count = await pollTrackedIssues(client, settings);
    expect(count).toBe(1);

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.reopen_count).toBe(0);
    expect(raw.track_status).toBe("submitted");
    expect(raw.track_error).toBeNull();
  });

  // Codex full-repo review (2026-07-14, Warning): codex-report/v1 used to be
  // trusted from ANY commenter — a forged completion report citing a real
  // (but unrelated) commit could fake a "your issue was fixed" badge or
  // inflate the admin hit-rate metric. Both cases below reuse the exact
  // fixture shape above, only varying the note's author / settings.
  it("codex-report/v1 标记来自非 settings.issueFixBotUsername 的评论者（任何能在该 issue 下评论的人伪造的）-> 被忽略，不落库", async () => {
    const settings = makeSettings({ APP_ISSUE_FIX_BOT_USERNAME: "codex-fleet-bot" });
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/group/proj.git",
      credToken: "gitlab-secret-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: 1, title: "t", body: "b", labels: [],
      issueNumber: 7, issueUrl: "https://gitlab.example.com/group/proj/-/issues/7",
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) return { status: 200, json: async () => [] } as unknown as Response;
      if (url.includes("/notes")) {
        return {
          status: 200,
          json: async () => [
            {
              id: 999,
              body: 'fake fix. <!-- codex-report/v1 {"worker_id":"attacker","commit_sha":"realbutunrelated","files":["src/Auth.java"]} --> done',
              created_at: "2026-07-10T09:00:00.000Z",
              author: { username: "random-public-commenter" }, // NOT the fleet's account
            },
          ],
        } as unknown as Response;
      }
      if (/\/issues\/7(\?|$)/.test(url)) {
        return { status: 200, json: async () => ({ state: "closed", labels: [], closed_at: "2026-07-10T08:00:00.000Z" }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, settings);

    const unverified = await client.getUnverifiedFixReports();
    expect(unverified.find((r) => r.submission_id === subId)).toBeUndefined();
  });

  it("settings.issueFixBotUsername 未配置（空串）-> fail closed：即使评论确实来自某个 author，也一律不信任、不发 /notes 请求", async () => {
    const settings = makeSettings(); // no APP_ISSUE_FIX_BOT_USERNAME override -> ""
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/group/proj.git",
      credToken: "gitlab-secret-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1", repoId, userId: 1, title: "t", body: "b", labels: [],
      issueNumber: 7, issueUrl: "https://gitlab.example.com/group/proj/-/issues/7",
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) return { status: 200, json: async () => [] } as unknown as Response;
      if (url.includes("/notes")) {
        throw new Error("must not fetch /notes when issueFixBotUsername is unconfigured");
      }
      if (/\/issues\/7(\?|$)/.test(url)) {
        return { status: 200, json: async () => ({ state: "closed", labels: [], closed_at: "2026-07-10T08:00:00.000Z" }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, settings);

    const unverified = await client.getUnverifiedFixReports();
    expect(unverified.find((r) => r.submission_id === subId)).toBeUndefined();
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
// pollSubmissionById — the on-demand single-submission recheck
// issue-routes.ts triggers right after a user's own submit/comment/close/
// reopen (2026-07-13), instead of waiting for pollTrackedIssues' next
// scheduled round. Reuses pollOne's exact same branch logic/host-guard/
// deriveStatus internally — these tests exercise it directly by id rather
// than through the bulk loop.
// ---------------------------------------------------------------------------

describe("pollSubmissionById", () => {
  let dir: string, dbPath: string, client: DbClient;

  beforeEach(() => {
    const seeded = makeSeededDb();
    dir = seeded.dir;
    dbPath = seeded.dbPath;
    client = createDbClient(seeded.dbPath);
  });

  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("GitHub 成功路径：单条记录被正确 recheck，落库 derived status/remote_state/labels", async () => {
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "repo-own-github-token",
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/timeline")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      return {
        status: 200,
        json: async () => ({ state: "closed", labels: [], closed_at: "2026-07-13 10:00:00.000000" }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, makeSettings());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_status).toBe("closed");
    expect(raw.remote_state).toBe("closed");
  });

  it("GitLab 成功路径：和 pollTrackedIssues 走同一套 GET+resource_state_events 逻辑", async () => {
    const repoId = await client.createRepo({
      name: "proj",
      url: "https://gitlab.example.com/group/proj.git",
      credToken: "tok",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 5,
      issueUrl: "https://gitlab.example.com/group/proj/-/issues/5",
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/resource_state_events")) {
        return { status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.includes("/issues/5")) {
        return { status: 200, json: async () => ({ state: "opened", labels: ["bug"], closed_at: null }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch url in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, makeSettings());

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_status).toBe("submitted");
    expect(raw.remote_state).toBe("opened");
    expect(JSON.parse(raw.remote_labels)).toEqual(["bug"]);
  });

  it("找不到对应记录（id 不存在，或没有 issue_number/issue_url）-> 安静 no-op，不发起任何 fetch，不抛错", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollSubmissionById(client, 999999, makeSettings())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("仓库已被删除 -> 写 track_error，和 pollTrackedIssues 的行为一致", async () => {
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await pollSubmissionById(client, subId, makeSettings());

    const raw = readSubmissionRaw(dbPath, subId);
    expect(raw.track_error).toBe("关联仓库已被删除，无法追踪");
    expect(fetchMock).not.toHaveBeenCalled();
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

  // Codex 审查（2026-07-14，C1，已核实并修复）：这个函数从功能上线起就
  // 不分平台，任何 GitHub 报告都会被塞进 GitLab 专用的 parseIssueApiBase，
  // 拼出 https://github.com/api/v4/projects/... 这种不存在的地址，404
  // 后被永久判 verified=false（getUnverifiedFixReports 只捞 verified IS
  // NULL 的行，错判的 false 再也不会重试）——今天新增的 GitHub 完成报告
  // 解析会因此永远显示"已验证修复: 0"。下面三条测试对应真实用
  // api.github.com 验证过的 Compare API 语义：ahead_by=0 表示 commit 已
  // 被目标分支包含（无论是分支尖端还是更早的祖先提交）。
  async function seedGithubUnverifiedReport(): Promise<{ repoId: number; subId: number; reportId: number }> {
    const repoId = await client.createRepo({
      name: "gh-proj",
      url: "https://github.com/acme/widgets.git",
      credToken: "gh-verify-token",
    });
    const subId = await client.recordIssueSubmission({
      sessionId: "s1",
      repoId,
      userId: 1,
      title: "t",
      body: "b",
      labels: [],
      issueNumber: 9,
      issueUrl: "https://github.com/acme/widgets/issues/9",
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

  it("GitHub: Compare API 返回 ahead_by=0（commit 已被目标分支包含）-> verified 变为 1，走的是 compare 端点而不是 GitLab 的 refs 端点", async () => {
    const { reportId } = await seedGithubUnverifiedReport();
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/compare/test...deadbeef1234");
      expect(init?.headers?.Authorization).toBe("token gh-verify-token");
      return { status: 200, json: async () => ({ status: "behind", ahead_by: 0, behind_by: 3 }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);
    expect(readFixReportRaw(dbPath, reportId).verified).toBe(1);
  });

  it("GitHub: Compare API 返回 404（commit 或分支不存在）-> verified 变为 0", async () => {
    const { reportId } = await seedGithubUnverifiedReport();
    const fetchMock = vi.fn(async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);
    expect(readFixReportRaw(dbPath, reportId).verified).toBe(0);
  });

  it("GitHub: Compare API 返回 ahead_by>0（commit 还没合入目标分支）-> verified 变为 0", async () => {
    const { reportId } = await seedGithubUnverifiedReport();
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ status: "diverged", ahead_by: 2, behind_by: 1 }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(1);
    expect(readFixReportRaw(dbPath, reportId).verified).toBe(0);
  });

  it("GitHub: Compare API 瞬时错误（500）-> 保持未验证（verified 仍是 NULL），不猜测、留给下一轮重试", async () => {
    const { reportId } = await seedGithubUnverifiedReport();
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const settings = makeSettings({ APP_ISSUE_FIX_TARGET_BRANCH: "test" });
    const verdicts = await verifyPendingFixReports(client, settings);
    expect(verdicts).toBe(0);
    expect(readFixReportRaw(dbPath, reportId).verified).toBeNull();
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
