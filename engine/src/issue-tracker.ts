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
 * stream is a genuine reopen. */
async function fetchGitlabStateEvents(
  apiBase: string,
  issueNumber: number,
  token: string,
): Promise<{ reopenCount: number; lastClosedAt: string | null }> {
  let reopens = 0;
  let lastClosedAt: string | null = null;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `${apiBase}/issues/${issueNumber}/resource_state_events?per_page=100&page=${page}`,
      { headers: { "PRIVATE-TOKEN": token } },
      POLL_TIMEOUT_MS,
    );
    if (resp.status !== 200) break; // older GitLab without this API -> degrade to snapshot-only
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
async function fetchGithubTimelineReopens(
  owner: string,
  repoName: string,
  issueNumber: number,
  token: string,
): Promise<number> {
  let reopens = 0;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/timeline?per_page=100&page=${page}`,
      { headers: githubHeaders(token) },
      POLL_TIMEOUT_MS,
    );
    if (resp.status !== 200) break; // degrade to snapshot-only, same posture as the GitLab path
    const events = (await resp.json()) as Array<{ event?: string }>;
    for (const ev of events) {
      if (ev.event === "reopened") reopens++;
    }
    if (events.length < 100) break;
  }
  return reopens;
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
    const { error, base } = await parseIssueApiBase(rep.issue_url);
    if (error || !token || !base) continue;

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

  await db.updateIssueTracking(
    sub.id,
    {
      trackStatus: deriveStatus(remoteState, labels, reopenCount),
      remoteState,
      remoteLabels: JSON.stringify(labels),
      reopenCount,
      closedAt: data.closed_at || undefined,
      clearError: true,
    },
    generation,
  );
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
    await pollGithub(sub, repo.cred_token, db, generation);
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
  const status = deriveStatus(remoteState, labels, reopenCount);

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
      reopenCount,
      closedAt,
      clearError: true,
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
  if (subs.length === 0) return 0;

  const reposById = new Map<number, FullRepoRow>();
  for (const r of await db.listReposFull()) reposById.set(r.id, r);

  for (const sub of subs) {
    try {
      await pollOne(sub, reposById, db, settings);
    } catch (e) {
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
    try {
      await pollTrackedIssues(db, settings);
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
