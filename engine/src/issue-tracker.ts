// Issue progress tracking — polls the tracker for what happened to issues
// filed from CodeAxis. Port of v1's app/issue_tracker.py (git show
// v1-python-final:app/issue_tracker.py) — see that file's module docstring
// for the full design rationale (reopen detection via GitLab's event
// stream rather than snapshot diffing, why the poll target is parsed from
// the submission's OWN stored issue_url rather than the repo's current
// url, why closed issues still get polled once a day instead of going
// terminal, why 'reopened' outranks 'merged').
//
// Lives at the top level, sibling to repo-sync.ts — this is
// orchestration/infrastructure (a background poller), not a ToolDef, so it
// doesn't belong under tools/. periodicTrackingLoop mirrors repo-sync.ts's
// periodicSyncLoop byte-for-byte (setTimeout+unref, sleep-then-tick,
// disabled by a non-positive interval, returns {stop}).
//
// Every repo lookup goes through db.getRepoAdmin/listReposFull (the full
// row, cred_token included) — never db.getRepo/listRepos — matching every
// other tracker-facing file in this phase.
import type { DbClient } from "./db/client.js";
import type { Settings } from "./config.js";
import type { FullRepoRow, TrackableSubmissionRow, IssueTrackingOverviewRow } from "./db/storage.js";
import { validateUrl } from "./repo-sync.js";
import { fetchWithTimeout, githubHeaders } from "./tools/issue-tracker-client.js";

const EVENTS_MAX_PAGES = 5; // 100/page; >500 state events on one issue isn't a real case
const NOTES_MAX_PAGES = 5;
const POLL_TIMEOUT_MS = 20_000; // v1's httpx timeout=20, uniform across every call in this file

// The fleet's finish-issue tool embeds this machine-readable marker in its
// completion comment (see deploy/codex-issue). Parsed as an event stream —
// an issue reopened and re-fixed legitimately carries several reports.
const REPORT_RE = /<!--\s*codex-report\/v1\s*(\{.*?\})\s*-->/s;

// Repo-relative code references CodeAxis embeds in issue bodies
// (path/to/File.java:12-34) — the "suspect locations" side of the hit-rate
// metric. Requires at least one '/' so bare filenames don't count.
const PATH_REF_RE = /[\w.-]+(?:\/[\w.-]+)+\.(?:java|vue|ts|tsx|js|jsx|xml|py|sql|css|scss|html|go|kt)\b/g;

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

// Codex full-repo review (2026-07-14, Warning): pollOne's original guard
// only compared hostnames (issueHost !== repoHost) — that closes the worst
// case (a repo migrating to an entirely different tracker/host) but does
// nothing for a same-host migration: an admin repointing repo_id=5 from
// gitlab.example.com/team-a/project-x to gitlab.example.com/team-b/project-y
// (a different project, same GitLab instance) would still pass the
// hostname check, and the repo's NEW cred_token would then be sent as a
// PRIVATE-TOKEN header to project-x's API on every poll of a
// pre-migration submission — real credential exposure to a project that
// token was never meant to authenticate against, not just stale/wrong
// status data. Extracts a normalized "host + project path" identity from
// EITHER a repo git URL or an issue web URL (stripping the /issues/N or
// /-/issues/N suffix and a trailing .git) so pollOne can require the
// submission's issue and the repo's CURRENT url to point at the exact
// same project, not just the same host.
function projectIdentityFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (path.includes("/-/issues/")) path = path.split("/-/issues/")[0]; // GitLab issue URL
  else if (path.includes("/issues/")) path = path.split("/issues/")[0]; // GitHub issue URL
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  if (!path) return null;
  return `${parsed.hostname.toLowerCase()}/${path.toLowerCase()}`;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** v1's `str(x or "") or None` idiom: falsy input -> null, truthy -> its
 * string form. Used for worker_id/commit_sha fields pulled out of a
 * loosely-typed JSON payload embedded in an issue comment. */
function truthyToString(v: unknown): string | null {
  return v ? String(v) : null;
}

/** v1's `_parse_issue_api_base` — GitLab issue web URL -> its project's
 * API base (https://host/group/project/-/issues/123 ->
 * https://host/api/v4/projects/group%2Fproject). Distinct from
 * issue-tracker-client.ts's gitlabProjectApiBaseFromRepoUrl, which parses
 * a bare repo git URL instead of an issue URL — the project path has to be
 * extracted differently (split on "/-/issues/"), but both reuse the same
 * SSRF gate. */
async function parseIssueApiBase(issueUrl: string): Promise<{ error: string | null; base: string | null }> {
  const err = await validateUrl(issueUrl);
  if (err) return { error: err, base: null };

  let parsed: URL;
  try {
    parsed = new URL(issueUrl);
  } catch {
    return { error: `无法从 issue URL 解析项目路径: ${issueUrl}`, base: null };
  }
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  let projectPath: string;
  if (parsed.pathname.includes("/-/issues/")) {
    projectPath = path.split("/-/issues/")[0];
  } else if (parsed.pathname.includes("/issues/")) {
    projectPath = path.split("/issues/")[0];
  } else {
    return { error: `无法从 issue URL 解析项目路径: ${issueUrl}`, base: null };
  }
  if (!projectPath) return { error: `无法从 issue URL 解析项目路径: ${issueUrl}`, base: null };

  return {
    error: null,
    base: `${parsed.protocol}//${parsed.host}/api/v4/projects/${encodeURIComponent(projectPath)}`,
  };
}

/** (reopenCount, lastClosedAt) from GitLab's resource_state_events stream —
 * the authoritative event log, not snapshot diffing: a close→reopen cycle
 * happening entirely between two polls is invisible to snapshots but
 * permanent here. GitLab versions disagree on the reopen event's `state`
 * value ("reopened" vs "opened"); both are accepted — safe because issue
 * CREATION never emits a state event, so any opened/reopened event in this
 * stream is a genuine reopen.
 *
 * reopenCount is `null`, not `0`, when the event stream couldn't actually
 * be read — 2026-07-15, Codex review (post-fc64ff40 follow-up): the caller
 * used to get a bare `number` and treat it as authoritative regardless of
 * WHY the loop stopped early, so a transient 429/5xx on this endpoint
 * looked identical to "genuinely zero reopens" — deriveStatus could then
 * regress an actually-reopened issue back to submitted/claimed/merged, and
 * the caller's `clearError: true` would erase any trace that the data was
 * incomplete. 404 is kept as a confirmed `0` (not `null`): it means this
 * GitLab instance doesn't have the endpoint at all, a permanent condition
 * worth degrading gracefully for, not a transient failure worth flagging
 * every single poll forever. Any other non-200 (429/403/5xx/network
 * hiccup surfaced as a completed-but-failed response) is `null` — "we
 * don't actually know" — so the caller can fall back to the submission's
 * last-known reopen_count instead of silently overwriting it with 0. */
async function fetchGitlabStateEvents(
  apiBase: string,
  issueNumber: number,
  token: string,
): Promise<{ reopenCount: number | null; lastClosedAt: string | null }> {
  let reopens = 0;
  let lastClosedAt: string | null = null;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `${apiBase}/issues/${issueNumber}/resource_state_events?per_page=100&page=${page}`,
      { headers: { "PRIVATE-TOKEN": token } },
      POLL_TIMEOUT_MS,
    );
    if (resp.status === 404) break; // older GitLab without this API -> confirmed 0, degrade to snapshot-only
    if (resp.status !== 200) return { reopenCount: null, lastClosedAt: null }; // transient failure — unknown, not zero
    const events = (await resp.json()) as Array<{ state?: string; created_at?: string }>;
    for (const ev of events) {
      if (ev.state === "reopened" || ev.state === "opened") reopens++;
      else if (ev.state === "closed") lastClosedAt = ev.created_at || null;
    }
    if (events.length < 100) break;
  }
  return { reopenCount: reopens, lastClosedAt };
}

// 生产 QA 复测（2026-07-14）：GitHub 路径的 reopen_count 从功能上线起就
// 一直硬编码传 0（从未真正计算过，不是回归——deriveStatus(remoteState,
// labels, 0) 这行字面量 0 从 pollGithub 和 fetchGitlabStateEvents 同一次提
// 交起就是这样）。GitHub REST API 没有 GitLab resource_state_events 那样
// 专门的状态事件端点，但有 Timeline API（/issues/{n}/timeline），事件里
// 类型为 "reopened" 的条目就是每一次重新打开——镜像
// fetchGitlabStateEvents 的分页/计数写法，让 GitHub 也有真实的重开计数，
// 而不是永远停在初始值。
//
// null vs 0 (2026-07-15, Codex review follow-up): same fix and same
// rationale as fetchGitlabStateEvents above — a 404 (repo/issue genuinely
// has no timeline, essentially never happens for GitHub but kept for
// symmetry) degrades to a confirmed 0; any other non-200 (429 rate limit
// being the realistic case here) returns null so the caller doesn't treat
// an unreadable timeline as "confirmed zero reopens".
async function fetchGithubTimelineReopens(
  owner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<number | null> {
  let reopens = 0;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/timeline?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
      POLL_TIMEOUT_MS,
    );
    if (resp.status === 404) break; // repo/issue has no timeline -> confirmed 0, degrade to snapshot-only
    if (resp.status !== 200) return null; // transient failure — unknown, not zero
    const events = (await resp.json()) as Array<{ event?: string }>;
    for (const ev of events) {
      if (ev.event === "reopened") reopens++;
    }
    if (events.length < 100) break;
  }
  return reopens;
}

// 生产 QA 复测（2026-07-14）：fetchAndStoreReports（下方）从功能上线起就
// 只接在 GitLab 轮询路径里——GitHub issue 即使真的收到了 bot 格式正确的
// codex-report/v1 完成报告，也从来没有被抓取过，Admin 工单页的已验证修复/
// 平均修复时长/嫌疑位置命中率统计对所有 GitHub 仓库永远是空的。GitHub
// REST 用 Issue Comments API（/issues/{n}/comments）而不是 GitLab 的
// notes 端点，作者字段是 comment.user.login 而不是 note.author.username，
// 其余逻辑（REPORT_RE 解析、按 settings.issueFixBotUsername 判定信任、
// upsertFixReport 落库）与 GitLab 版本完全一致，镜像写一份而不是抽公共
// 函数——两边端点形状和字段名不同，跟本文件里 fetchGithubLabels/
// fetchGitlabLabels（issue-tracker-client.ts）已经确立的写法一致。
async function fetchAndStoreReportsGithub(
  owner: string,
  repoName: string,
  sub: { id: number; issue_number: number },
  token: string,
  db: DbClient,
  settings: Settings,
): Promise<void> {
  if (!settings.issueFixBotUsername) return;
  for (let page = 1; page <= NOTES_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repoName}/issues/${sub.issue_number}/comments?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
      POLL_TIMEOUT_MS,
    );
    if (resp.status !== 200) return;
    const comments = (await resp.json()) as Array<{
      id: number;
      body?: string;
      created_at?: string;
      user?: { login?: string };
    }>;
    for (const comment of comments) {
      const m = REPORT_RE.exec(comment.body ?? "");
      if (!m) continue;
      if (comment.user?.login !== settings.issueFixBotUsername) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(m[1]);
      } catch {
        continue;
      }
      if (!isPlainObject(payload)) continue;
      const filesRaw = payload.files;
      const files = Array.isArray(filesRaw) ? filesRaw.map((f) => String(f)) : [];
      await db.upsertFixReport({
        submissionId: sub.id,
        noteId: comment.id,
        workerId: truthyToString(payload.worker_id),
        commitSha: truthyToString(payload.commit_sha),
        files,
        reportedAt: comment.created_at || null,
      });
    }
    if (comments.length < 100) return;
  }
}

/** Pulls the issue's comments and persists every codex-report/v1 marker.
 * Keyed by note_id (upsertFixReport's ON CONFLICT), so re-polling is
 * idempotent and a re-fix after reopen adds a second report instead of
 * overwriting the first.
 *
 * Codex full-repo review (2026-07-14, Warning): this used to trust the
 * marker from ANY note regardless of who posted it — on a shared/public
 * GitLab issue, any commenter could plant a fake completion report citing
 * a real, already-merged commit (verifyPendingFixReports only checks the
 * commit is reachable from the target branch, not that it actually relates
 * to this issue) and forge a "your issue was fixed" badge, or inflate the
 * admin hit-rate metric with a fabricated `files` list. Only a note whose
 * author matches settings.issueFixBotUsername (the fleet's own fixed
 * GitLab account — see deploy/codex-issue's module docstring) is now
 * trusted; with no username configured, every marker is skipped rather
 * than trusting everyone by default. */
async function fetchAndStoreReports(
  apiBase: string,
  sub: { id: number; issue_number: number },
  token: string,
  db: DbClient,
  settings: Settings,
): Promise<void> {
  if (!settings.issueFixBotUsername) return;
  for (let page = 1; page <= NOTES_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `${apiBase}/issues/${sub.issue_number}/notes?per_page=100&page=${page}`,
      { headers: { "PRIVATE-TOKEN": token } },
      POLL_TIMEOUT_MS,
    );
    if (resp.status !== 200) return;
    const notes = (await resp.json()) as Array<{
      id: number;
      body?: string;
      created_at?: string;
      author?: { username?: string };
    }>;
    for (const note of notes) {
      const m = REPORT_RE.exec(note.body ?? "");
      if (!m) continue;
      if (note.author?.username !== settings.issueFixBotUsername) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(m[1]);
      } catch {
        continue;
      }
      if (!isPlainObject(payload)) continue;
      const filesRaw = payload.files;
      const files = Array.isArray(filesRaw) ? filesRaw.map((f) => String(f)) : [];
      await db.upsertFixReport({
        submissionId: sub.id,
        noteId: note.id,
        workerId: truthyToString(payload.worker_id),
        commitSha: truthyToString(payload.commit_sha),
        files,
        reportedAt: note.created_at || null,
      });
    }
    if (notes.length < 100) return;
  }
}

// Codex review (2026-07-14, C1): this used to run EVERY pending report
// (GitHub included, once fetchAndStoreReportsGithub started producing them)
// through GitLab's own commits/{sha}/refs endpoint — for a github.com
// issue_url that built a nonsense URL (`https://github.com/api/v4/...`),
// which 404s, which this function reads as "commit doesn't exist" and
// permanently writes verified=false (getUnverifiedFixReports only ever
// re-considers verified IS NULL rows, so a wrong `false` never retries).
// Every GitHub completion report would have been silently and permanently
// mis-verified — the exact feature this session added would report
// "已验证修复: 0" forever. Verified live against the real GitHub API
// (api.github.com/repos/.../compare/{branch}...{sha}): a commit that IS
// the branch tip returns status=identical/ahead_by=0, an ancestor commit
// returns status=behind/ahead_by=0, and a nonexistent commit 404s — so
// `ahead_by === 0` is the GitHub equivalent of GitLab's "branch list
// includes this commit" check.
async function verifyGithubCommit(
  issueUrl: string,
  commitSha: string,
  token: string,
  targetBranch: string,
): Promise<boolean | null> {
  let path = "";
  try {
    path = new URL(issueUrl).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return null;
  }
  const [owner, repoName] = path.split("/");
  if (!owner || !repoName) return null;

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repoName}/compare/` +
        `${encodeURIComponent(targetBranch)}...${encodeURIComponent(commitSha)}`,
      { headers: githubHeaders(token) },
      POLL_TIMEOUT_MS,
    );
  } catch {
    return null; // network failure — leave verified=NULL, retried next round
  }
  if (resp.status === 404) return false; // commit or branch genuinely doesn't exist
  if (resp.status !== 200) return null; // rate-limited/transient — don't guess, retry next round
  const data = (await resp.json()) as { ahead_by?: number };
  return data.ahead_by === 0;
}

/** Platform-side check that each reported commit is actually reachable
 * from the target branch (settings.issueFixTargetBranch) — a worker's
 * self-reported "merged" claim is never taken at face value. Runs after
 * each poll round. Returns how many reports got a verdict. */
export async function verifyPendingFixReports(db: DbClient, settings: Settings): Promise<number> {
  const reports = await db.getUnverifiedFixReports();
  if (reports.length === 0) return 0;

  let verdicts = 0;
  for (const rep of reports) {
    if (!rep.issue_url) continue; // leave NULL — retried next round once fixable
    const repo = rep.repo_id !== null ? await db.getRepoAdmin(rep.repo_id) : null;
    const token = repo?.cred_token;
    if (!token) continue;

    const host = safeHostname(rep.issue_url).toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const verified = await verifyGithubCommit(rep.issue_url, rep.commit_sha, token, settings.issueFixTargetBranch);
      if (verified !== null) {
        await db.setFixReportVerified(rep.id, verified);
        verdicts++;
      }
      continue;
    }

    const { error, base } = await parseIssueApiBase(rep.issue_url);
    if (error || !base) continue;

    let resp: Response;
    try {
      resp = await fetchWithTimeout(
        `${base}/repository/commits/${encodeURIComponent(rep.commit_sha)}/refs?type=branch&per_page=100`,
        { headers: { "PRIVATE-TOKEN": token } },
        POLL_TIMEOUT_MS,
      );
    } catch {
      continue;
    }
    if (resp.status === 404) {
      await db.setFixReportVerified(rep.id, false); // commit doesn't exist
      verdicts++;
    } else if (resp.status === 200) {
      const branches = (await resp.json()) as Array<{ name?: string }>;
      const names = new Set(branches.map((b) => b.name));
      await db.setFixReportVerified(rep.id, names.has(settings.issueFixTargetBranch));
      verdicts++;
    }
  }
  return verdicts;
}

/** Priority: closed > reopened > merged > claimed > submitted. 'reopened'
 * deliberately outranks 'merged' — the fleet's own protocol treats a stale
 * merged-label on a reopened issue as invalid until re-verified. */
export function deriveStatus(remoteState: string, labels: string[], reopenCount: number): string {
  if (remoteState === "closed") return "closed";
  if (reopenCount > 0) return "reopened";
  const lowered = labels.map((l) => l.toLowerCase());
  if (lowered.includes("codex:merged-to-test")) return "merged";
  if (lowered.includes("codex:in-progress")) return "claimed";
  return "submitted";
}

async function pollGithub(
  sub: TrackableSubmissionRow,
  credToken: string | null,
  db: DbClient,
  settings: Settings,
  generation: number,
): Promise<void> {
  const token = credToken;
  if (!token) {
    await db.updateIssueTracking(sub.id, { trackError: "仓库未配置凭证，无法调用 GitHub API" }, generation);
    return;
  }
  const issueUrl = sub.issue_url ?? "";
  let path = "";
  try {
    path = new URL(issueUrl).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    // path stays "" -> falls through to the parts.length < 4 guard below
  }
  const parts = path.split("/"); // owner/repo/issues/123
  if (parts.length < 4 || parts[2] !== "issues") {
    await db.updateIssueTracking(sub.id, { trackError: `无法解析 GitHub issue URL: ${issueUrl}` }, generation);
    return;
  }
  const [owner, repoName] = parts;

  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${sub.issue_number}`,
    { headers: githubHeaders(token) },
    POLL_TIMEOUT_MS,
  );
  if (resp.status !== 200) {
    await db.updateIssueTracking(sub.id, { trackError: `GitHub API ${resp.status}` }, generation);
    return;
  }

  const data = (await resp.json()) as {
    state?: string;
    labels?: Array<string | { name?: string }>;
    closed_at?: string | null;
  };
  const remoteState = data.state === "closed" ? "closed" : "opened";
  const labels = (data.labels || []).map((l) =>
    typeof l === "object" && l !== null ? String(l.name) : String(l),
  );

  const reopenCount = await fetchGithubTimelineReopens(owner, repoName, sub.issue_number, token);
  // 2026-07-15, Codex review follow-up: same fix as pollOne's GitLab
  // branch — null means the timeline couldn't be read this round, fall
  // back to the submission's last-known reopen_count for status instead
  // of treating "unknown" as "confirmed zero".
  const reopenCountKnown = reopenCount !== null;
  const status = deriveStatus(remoteState, labels, reopenCountKnown ? reopenCount : sub.reopen_count);

  await db.updateIssueTracking(
    sub.id,
    {
      trackStatus: status,
      remoteState,
      remoteLabels: JSON.stringify(labels),
      ...(reopenCountKnown ? { reopenCount } : {}),
      closedAt: data.closed_at || undefined,
      ...(reopenCountKnown
        ? { clearError: true }
        : { trackError: "重开事件数据本轮获取失败（GitHub API 非 200），其余状态已更新，reopen 计数沿用上次结果" }),
    },
    generation,
  );

  // Completion reports only exist once fix activity has happened — mirrors
  // the equivalent guard in pollOne's GitLab path below, an untouched open
  // issue skips the comments round-trip entirely.
  if (status === "merged" || status === "closed" || status === "reopened") {
    await fetchAndStoreReportsGithub(
      owner,
      repoName,
      { id: sub.id, issue_number: sub.issue_number },
      token,
      db,
      settings,
    );
  }
}

export async function pollOne(
  sub: TrackableSubmissionRow,
  reposById: Map<number, FullRepoRow>,
  db: DbClient,
  settings: Settings,
): Promise<void> {
  // Codex full-repo review (2026-07-14, Warning): claimed BEFORE any
  // network round-trip — the cron poller, the webhook receiver, and an
  // on-demand post-action recheck can all call pollOne for the same
  // submission around the same time, and whichever finishes LAST used to
  // win unconditionally even if it started EARLIEST (and thus reflects the
  // OLDEST remote state). Every updateIssueTracking call below carries
  // this ticket; see storage.ts's beginPoll/updateIssueTracking.
  const generation = await db.beginPoll(sub.id);

  const repo = sub.repo_id !== null ? reposById.get(sub.repo_id) : undefined;
  if (!repo) {
    await db.updateIssueTracking(sub.id, { trackError: "关联仓库已被删除，无法追踪" }, generation);
    return;
  }

  const issueUrl = sub.issue_url ?? "";
  const issueHost = safeHostname(issueUrl).toLowerCase();

  // The poll target's host/project comes from the submission's OWN stored
  // issue_url, never the repo's current url (see module header) — but the
  // credential still comes from the repo record, and only gets used if
  // that repo's CURRENT url still resolves to the SAME project the issue
  // actually lives in (not just the same host — see projectIdentityFromUrl's
  // own comment on why a same-host migration to a DIFFERENT project needed
  // its own check). Applies to GitHub too, now that it authenticates with
  // the repo's own cred_token instead of a separate global token.
  const issueIdentity = projectIdentityFromUrl(issueUrl);
  const repoIdentity = projectIdentityFromUrl(repo.url);
  if (!issueIdentity || !repoIdentity || issueIdentity !== repoIdentity) {
    await db.updateIssueTracking(
      sub.id,
      { trackError: `issue 所在项目(${issueIdentity ?? issueUrl})与仓库当前配置(${repoIdentity ?? repo.url})不一致，凭证不外发，暂停追踪` },
      generation,
    );
    return;
  }

  if (issueHost === "github.com" || issueHost === "www.github.com") {
    await pollGithub(sub, repo.cred_token, db, settings, generation);
    return;
  }

  const token = repo.cred_token;
  if (!token) {
    await db.updateIssueTracking(sub.id, { trackError: "仓库未配置凭证，无法调用 GitLab API" }, generation);
    return;
  }

  const { error, base } = await parseIssueApiBase(issueUrl);
  if (error || !base) {
    await db.updateIssueTracking(sub.id, { trackError: error ?? "unknown GitLab API base error" }, generation);
    return;
  }

  const resp = await fetchWithTimeout(
    `${base}/issues/${sub.issue_number}`,
    { headers: { "PRIVATE-TOKEN": token } },
    POLL_TIMEOUT_MS,
  );
  if (resp.status === 404) {
    await db.updateIssueTracking(sub.id, { trackError: "issue 在 GitLab 上已不存在（404）" }, generation);
    return;
  }
  if (resp.status !== 200) {
    await db.updateIssueTracking(sub.id, { trackError: `GitLab API ${resp.status}` }, generation);
    return;
  }

  const data = (await resp.json()) as { state?: string; labels?: string[]; closed_at?: string | null };
  const remoteState = data.state || "opened";
  const labels = data.labels || [];

  const { reopenCount, lastClosedAt } = await fetchGitlabStateEvents(base, sub.issue_number, token);
  const closedAt = data.closed_at || lastClosedAt || undefined;
  // 2026-07-15, Codex review follow-up: reopenCount === null means the
  // event stream couldn't be read this round (see fetchGitlabStateEvents's
  // doc comment) — fall back to the submission's own last-known
  // reopen_count instead of treating "unknown" as "confirmed zero", which
  // used to be able to regress an actually-reopened issue's status back to
  // submitted/claimed/merged on a single transient 429/5xx.
  const reopenCountKnown = reopenCount !== null;
  const status = deriveStatus(remoteState, labels, reopenCountKnown ? reopenCount : sub.reopen_count);

  // Completion reports only exist once fix activity has happened — an
  // untouched open issue skips the notes round-trip entirely.
  if (status === "merged" || status === "closed" || status === "reopened") {
    await fetchAndStoreReports(base, { id: sub.id, issue_number: sub.issue_number }, token, db, settings);
  }

  await db.updateIssueTracking(
    sub.id,
    {
      trackStatus: status,
      remoteState,
      remoteLabels: JSON.stringify(labels),
      // Omitted (not overwritten with a stale 0) when unknown — leaves the
      // column at its current value, same as reopenCountKnown's fallback
      // above already assumed for this round's status.
      ...(reopenCountKnown ? { reopenCount } : {}),
      closedAt,
      ...(reopenCountKnown
        ? { clearError: true }
        : { trackError: "重开事件数据本轮获取失败（GitLab API 非 200），其余状态已更新，reopen 计数沿用上次结果" }),
    },
    generation,
  );
}

/** On-demand recheck of exactly ONE submission — called right after the
 * user's own submit/comment/close/reopen (issue-routes.ts) so the UI
 * reflects the just-made change without waiting for the next scheduled
 * `pollTrackedIssues` round (default every 10 minutes). Reuses `pollOne`'s
 * GitHub/GitLab branch logic, host-match guard, and `deriveStatus`
 * verbatim — no separate recheck implementation to keep in sync. A no-op
 * (not an error) if the submission has no issue_number/issue_url yet, or
 * the row/repo has since been deleted. */
export async function pollSubmissionById(
  db: DbClient,
  submissionId: number,
  settings: Settings,
): Promise<void> {
  const sub = await db.getSubmissionForTracking(submissionId);
  if (!sub) return;
  const reposById = new Map<number, FullRepoRow>();
  if (sub.repo_id !== null) {
    const repo = await db.getRepoAdmin(sub.repo_id);
    if (repo) reposById.set(repo.id, repo);
  }
  await pollOne(sub, reposById, db, settings);
}

/** One reconciliation round over every due submission. Returns how many
 * were polled. Per-issue failures are recorded on that row (track_error)
 * and never abort the round. */
export async function pollTrackedIssues(db: DbClient, settings: Settings): Promise<number> {
  const subs = await db.getTrackableSubmissions();

  // Real production bug found while verifying the DB-timeout fix above
  // (2026-07-15): this used to `return 0` right here when nothing was due
  // for a tracking re-check, which skipped verifyPendingFixReports() below
  // entirely for that whole tick. getTrackableSubmissions() excludes a
  // closed issue for 24h after its last check (see that query's comment),
  // so once every tracked issue is closed-and-recently-checked — exactly
  // the production state right now — EVERY tick hit this early return and
  // fix-report verification silently never ran again, regardless of how
  // healthy the poll loop itself was. That's what actually left #1242's
  // fix report stuck at verified=null, not the DB-timeout bug above (a
  // manual replay of the same GitLab verify call succeeded immediately).
  // Verification is an unrelated concern from "is any submission's tracking
  // status due for a re-check" and must run every tick independent of it.
  if (subs.length > 0) {
    const reposById = new Map<number, FullRepoRow>();
    for (const r of await db.listReposFull()) reposById.set(r.id, r);

    // Codex review (2026-07-14, Warning): the return value here is an
    // *attempted* count, not a success count — every failure is swallowed
    // into that submission's track_error and the loop moves on by design (see
    // the doc comment above). That's correct for "never abort the round", but
    // it meant a round where every single submission failed still logged as
    // "N submissions checked" below, indistinguishable from a healthy run.
    // Tracked separately here (not via the return value, to avoid changing
    // pollTrackedIssues's signature/the callers and tests keyed on a plain
    // count) so a bad round is visible without inflating a "healthy" log line.
    let failed = 0;
    for (const sub of subs) {
      try {
        await pollOne(sub, reposById, db, settings);
      } catch (e) {
        failed++;
        const label = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
        try {
          // A fresh ticket, not whatever pollOne claimed internally before
          // throwing — recording "this attempt failed" is itself the newest
          // event for this submission, so it should win over anything an
          // even-more-recent concurrent poll might still be mid-flight on.
          const generation = await db.beginPoll(sub.id);
          await db.updateIssueTracking(sub.id, { trackError: label }, generation);
        } catch {
          // best-effort — a failure recording the failure is not fatal
        }
      }
    }
    if (failed > 0) {
      console.log(`  ⚠️  issue tracking poll: ${failed}/${subs.length} submission(s) failed this round`);
    }
  }

  try {
    await verifyPendingFixReports(db, settings);
  } catch (e) {
    const label = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    console.log(`  ❌ fix-report verification failed: ${label}`);
  }

  return subs.length;
}

/** Background task, started in main.ts next to repo-sync.ts's
 * periodicSyncLoop — same shape (setTimeout+unref, sleep-then-tick,
 * disabled by a non-positive interval, returns {stop}), copied on purpose
 * rather than re-derived. */
export function periodicTrackingLoop(
  intervalMinutes: number,
  db: DbClient,
  settings: Settings,
): { stop: () => void } {
  if (!intervalMinutes || intervalMinutes <= 0) {
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, intervalMinutes * 60_000);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    // Heartbeat, not just the failure path below — this tick previously had
    // zero log output on success, so a wedged poll loop (e.g. a stuck db
    // call before DB_CALL_TIMEOUT_MS existed, client.ts) looked identical to
    // "nothing due to poll" in the logs. A gap in this line is now the signal.
    const startedAt = Date.now();
    try {
      const count = await pollTrackedIssues(db, settings);
      console.log(`  🔁 issue tracking poll: ${count} submission(s) attempted in ${Date.now() - startedAt}ms`);
    } catch (e) {
      const label = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
      console.log(`  ❌ issue tracking poll failed: ${label}`);
    }
    scheduleNext();
  };

  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// ==================== Admin-dashboard metrics (Phase 5 usage panel) ====================

function parseLocalMs(ts: string | null | undefined): number | null {
  // Every timestamp this function ever sees (submitted_at: naive-local via
  // py-compat.ts's pyLocalIsoNow; closed_at: GitLab's UTC-Z-suffixed ISO)
  // parses correctly as-is under JS's Date Time String Format — a
  // date-TIME string with no zone offset is interpreted as LOCAL time
  // (verified against the actual 6-fractional-digit format this codebase
  // stores), while a Z/offset-suffixed string parses as that explicit
  // instant. Unlike Python's datetime, every JS Date is already an
  // absolute instant, so there's no naive/aware reconciliation to do —
  // v1's astimezone()/replace(tzinfo=None) dance has no JS equivalent to
  // port because the problem it solves doesn't exist here.
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
}

function pathsHit(refs: Set<string>, files: string[]): boolean {
  for (const ref of refs) {
    for (const f of files) {
      if (ref === f || ref.endsWith("/" + f) || f.endsWith("/" + ref)) return true;
    }
  }
  return false;
}

export type TrackingMetrics = {
  fixed_count: number;
  avg_fix_hours: number | null;
  hit_rate: number | null;
  hit_sample: number;
};

/** Phase-2 outcome metrics, computed only over evidence that exists:
 * - fixed: has >=1 PLATFORM-verified completion report (verified===1).
 *   Plain 'closed' stays out of the numerator — it includes
 *   won't-fix/duplicate.
 * - avg_fix_hours: submitted->closed wall time over verified-fixed issues.
 * - hit rate: of verified-fixed issues whose body carried path references
 *   (CodeAxis's suspect locations), how many had the real fix touch at
 *   least one of them. Measures issue-draft/retrieval quality end to end. */
export function computeTrackingMetrics(submissions: IssueTrackingOverviewRow[]): TrackingMetrics {
  const fixed = submissions.filter((s) => s.fix_reports.some((r) => r.verified === 1));
  const fixHours: number[] = [];
  let hits = 0;
  let withRefs = 0;

  for (const s of fixed) {
    const submittedMs = parseLocalMs(s.submitted_at);
    const closedMs = parseLocalMs(s.closed_at);
    if (submittedMs !== null && closedMs !== null && closedMs > submittedMs) {
      fixHours.push((closedMs - submittedMs) / 1000 / 3600);
    }
    const refs = new Set(s.body.match(PATH_REF_RE) ?? []);
    if (refs.size > 0) {
      withRefs++;
      const files = s.fix_reports.filter((r) => r.verified === 1).flatMap((r) => r.files);
      if (pathsHit(refs, files)) hits++;
    }
  }

  return {
    fixed_count: fixed.length,
    avg_fix_hours:
      fixHours.length > 0 ? Math.round((fixHours.reduce((a, b) => a + b, 0) / fixHours.length) * 10) / 10 : null,
    hit_rate: withRefs > 0 ? Math.round((hits / withRefs) * 1000) / 1000 : null,
    hit_sample: withRefs,
  };
}
