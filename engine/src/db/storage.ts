import Database from "better-sqlite3";
import { randomUUID, randomBytes } from "node:crypto";
import { pythonJsonDumps, pyLocalIsoNow } from "./py-compat.js";

export class SchemaError extends Error {}

export type StoredMessageRow = {
  id: number;
  role: string;
  content: string | unknown[];
  timestamp: string;
};

export type LlmMetricsRow = {
  session_id: string;
  user_id: number | null;
  model: string | null;
  iteration: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
};

export type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  is_active: number;
  created_at: string;
  // BUG-003: set on the bootstrap admin when it's created with the
  // well-known default password (see auth.ts's ensureAdminUser) — the
  // login route surfaces this so the frontend can block on a mandatory
  // change before letting the user past the login screen.
  must_change_password: number;
  // Bumped by updateUserPassword on every password change/reset — a JWT's
  // own token_version claim must match this or the auth middleware treats
  // it as stale (Codex full-repo review, 2026-07-14, Warning).
  token_version: number;
};

export type SessionRow = {
  id: string;
  title: string;
  owner_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

// Client-safe repo fields only (id/name/url/description/branch) — matches
// v1's `_public_repo` (app/main.py) selection, which never exposes
// local_path/cred_username/cred_token to a browser response. access_level
// is populated by listReposForUser's permissions JOIN; listRepos (the
// admin "sees everything, no grant row" path) always reports it as null,
// mirroring v1's `r.get("access_level")` on a plain `list_repos()` row
// (no "access_level" key present at all there, so the dict .get() is None).
export type RepoRow = {
  id: number;
  name: string;
  url: string;
  description: string;
  branch: string | null;
  access_level: string | null;
};

// create_repo's writable fields (Task 1 / v1's create_repo — local_path is
// deliberately excluded: it's populated later by the sync process, not at
// creation time).
export type CreateRepoFields = {
  name: string;
  url: string;
  description?: string;
  branch?: string | null;
  credUsername?: string | null;
  credToken?: string | null;
};

// update_repo's dynamic SET builder — every field is optional-and-omittable
// (undefined = "leave column untouched"); branch/credUsername/credToken
// additionally fold "" to NULL on write, matching v1's `x or None`.
export type UpdateRepoFields = Partial<{
  name: string;
  url: string;
  description: string;
  localPath: string;
  branch: string | null;
  credUsername: string | null;
  credToken: string | null;
  lastSyncAt: string;
  lastSyncStatus: string;
  lastSyncMessage: string;
  indexStatus: string;
  lastSyncSha: string | null;
}>;

// Admin-only full row — v1's get_repo (`SELECT *` from repositories).
// Unlike RepoRow (the client-safe subset), this exposes cred_username/
// cred_token/local_path/last_sync_*/index_status — the admin routes (Task 7)
// need these to diff PATCH changes, compute has_token, and pass credentials
// to sync_and_persist. Masking (strip cred_token to a has_token bool, mask
// the URL) is the route layer's job, NOT this method's — it returns raw data.
export type FullRepoRow = RepoRow & {
  cred_username: string | null;
  cred_token: string | null;
  local_path: string | null;
  created_at: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
  index_status: string | null;
  last_sync_sha: string | null;
};

// Phase 4b Task 4: semantic_search's best-effort recall-quality log row —
// v1's _log_search (app/tools/semantic_index.py) INSERT, ported field for
// field. repoId is deliberately `number | null`, NOT the raw repo_id string
// semantic-search.ts computes hits with (see that file's repoIdForLog) —
// v1 stores `int(top1["repo_id"]) if ... isdigit() else None` into this
// column despite the column itself being an untyped SQLite INTEGER FK that
// was never actually enforced against `repositories.id`; the caller does
// the string->int-or-null conversion, this method just takes the already-
// resolved value.
export type RecordSemanticSearchLogRow = {
  userId: number | null;
  repoId: number | null;
  query: string;
  resultCount: number;
  top1Score: number | null;
  resultsJson: string;
  durationMs: number;
};

// list_permissions' JOIN row — username/repo_name resolved through
// users/repositories so callers don't need a second round-trip.
export type PermissionRow = {
  id: number;
  user_id: number;
  username: string;
  repo_id: number;
  repo_name: string;
  access_level: string;
  created_at: string;
};

// ==================== Issue submissions / tracking / fix reports ====================

// record_issue_submission's writable fields (database.py:661) — the
// authoritative outcome of a real issue filing; the chat history only ever
// shows the draft card live, never whether/where it was actually filed.
export type RecordIssueSubmissionFields = {
  sessionId: string;
  repoId: number;
  userId: number;
  title: string;
  body: string;
  labels: string[];
  issueNumber: number;
  // Nullable to match the schema column (issue_submissions.issue_url has
  // no NOT NULL constraint) and TrackerResult's success shape — a
  // comment-only GitLab issue action can come back with url:null when its
  // post-action re-fetch fails, and submitRepoIssue's own success shape is
  // shared with that same type even though a submit's url is realistically
  // always populated.
  issueUrl: string | null;
  draftToolUseId?: string | null;
};

// claimDraftSubmission's input — same shape as RecordIssueSubmissionFields
// minus issueNumber/issueUrl (not known yet — the whole point is to claim
// the draft_tool_use_id BEFORE calling the tracker) and with draftToolUseId
// required rather than optional (only the draft-card submit path claims;
// the no-draft-id legacy path still goes straight through
// recordIssueSubmission, nothing to dedupe against there).
export type ClaimDraftSubmissionFields = {
  sessionId: string;
  repoId: number;
  userId: number;
  title: string;
  body: string;
  labels: string[];
  draftToolUseId: string;
};

export type ClaimDraftSubmissionResult =
  | { claimed: true; id: number }
  | { claimed: false; existing: IssueSubmissionRow };

export type FinalizeIssueSubmissionFields = {
  issueNumber: number;
  issueUrl: string | null;
  body: string;
};

// How long a claim is allowed to stay unfinished (issue_number still NULL)
// before it's treated as abandoned and reclaimable — generous enough to
// cover a real GitHub/GitLab API call plus a screenshot upload, bounded
// enough that a genuinely crashed request doesn't block that draft forever.
export const CLAIM_TTL_MS = 60_000;

// get_issue_submissions_for_session's row (database.py:688) — used to
// reconcile historical draft cards to their real final state on replay.
export type IssueSubmissionRow = {
  id: number;
  repo_id: number | null;
  user_id: number | null;
  title: string;
  body: string;
  labels: string[];
  issue_number: number | null;
  issue_url: string | null;
  draft_tool_use_id: string | null;
  submitted_at: string;
  track_status: string;
  reopen_count: number;
};

// get_trackable_submissions' row (database.py:710) — the poller's per-round
// worklist: everything open/unknown is polled every round, closed issues at
// most once a day (so a late reopen is still caught).
export type TrackableSubmissionRow = {
  id: number;
  repo_id: number | null;
  issue_number: number;
  issue_url: string;
  track_status: string | null;
  remote_state: string | null;
  reopen_count: number;
  closed_at: string | null;
  last_checked_at: string | null;
};

// update_issue_tracking's dynamic SET builder (database.py:732) — only
// fields actually passed are touched; last_checked_at is always stamped
// (it marks the poll ATTEMPT, success or failure). clearError takes
// precedence over trackError when both would apply, matching v1's
// if/elif.
export type UpdateIssueTrackingFields = Partial<{
  trackStatus: string;
  remoteState: string;
  remoteLabels: string;
  reopenCount: number;
  closedAt: string;
  trackError: string;
  clearError: boolean;
}>;

// upsert_fix_report's writable fields (database.py:765) — verified is
// deliberately absent here: it's never set through this path, only via
// setFixReportVerified, and the ON CONFLICT branch preserves whatever
// value it already has.
export type UpsertFixReportFields = {
  submissionId: number;
  noteId: number;
  workerId: string | null;
  commitSha: string | null;
  files: string[];
  reportedAt: string | null;
};

// get_unverified_fix_reports' row (database.py:788).
export type UnverifiedFixReportRow = {
  id: number;
  submission_id: number;
  commit_sha: string;
  issue_url: string | null;
  repo_id: number | null;
};

// get_fix_reports_for_submissions' per-report row (database.py:812) — used
// by getMyIssueSubmissions/getIssueTrackingOverview, never exposed as its
// own DbClient/RPC method (see getFixReportsForSubmissionsSync below —
// routing every list request through an extra worker round-trip would be
// pure overhead for a call that's always immediately followed by one).
export type FixReportRow = {
  submission_id: number;
  note_id: number;
  worker_id: string | null;
  commit_sha: string | null;
  files: string[];
  verified: number | null;
  reported_at: string | null;
};

// get_my_issue_submissions' row (database.py:835) — powers the 我的提报
// drawer. fresh is computed server-side against the user's own
// my_issues_seen_at so it can't be thrown off by the browser's clock.
export type MyIssueSubmissionRow = {
  id: number;
  repo_id: number | null;
  repo_name: string | null;
  title: string;
  issue_number: number;
  issue_url: string;
  submitted_at: string;
  track_status: string;
  reopen_count: number;
  closed_at: string | null;
  status_changed_at: string | null;
  fix_verified: boolean;
  fix_files_count: number | null;
  fix_commit: string | null;
  fresh: boolean;
};

// get_issue_tracking_overview's row (database.py:892) — the 工单 tab's
// per-submission listing; deliberately no "fix rate" derived field (v1's
// own comment: counting closed as fixed would be a fake number until
// structured completion reports can distinguish real fixes).
export type IssueTrackingOverviewRow = {
  id: number;
  repo_id: number | null;
  repo_name: string | null;
  title: string;
  body: string;
  issue_number: number;
  issue_url: string;
  labels: string[];
  submitted_at: string;
  track_status: string;
  remote_state: string | null;
  remote_labels: string[];
  reopen_count: number;
  closed_at: string | null;
  last_checked_at: string | null;
  track_error: string | null;
  username: string;
  fix_reports: FixReportRow[];
};

export type IssueTrackingOverview = {
  counts: Record<string, number>;
  submissions: IssueTrackingOverviewRow[];
};

// record_issue_action's writable fields (database.py:935) — same
// rationale as RecordIssueSubmissionFields: the chat history only ever
// shows the confirmation card live, never the real tracker outcome.
export type RecordIssueActionFields = {
  sessionId: string;
  repoId: number;
  userId: number;
  issueNumber: number;
  action: string;
  comment: string;
  issueUrl?: string | null;
  draftToolUseId?: string | null;
};

// get_issue_actions_for_session's row (database.py:955).
export type IssueActionRow = {
  id: number;
  repo_id: number | null;
  user_id: number | null;
  issue_number: number;
  action: string;
  comment: string;
  issue_url: string | null;
  draft_tool_use_id: string | null;
  applied_at: string;
};

// Codex full-repo review (2026-07-14, Warning) — same claim-before-the-
// real-call idempotency shape as ClaimDraftSubmissionFields, applied to
// issue_actions (comment/close/reopen) instead of issue_submissions.
export type ClaimDraftActionFields = {
  sessionId: string;
  repoId: number;
  userId: number;
  issueNumber: number;
  action: string;
  comment: string;
  draftToolUseId: string;
};

export type ClaimDraftActionResult =
  | { claimed: true; id: number }
  | { claimed: false; existing: IssueActionRow & { pending: number } };

export type FinalizeIssueActionFields = {
  issueUrl: string | null;
};

// ==================== Usage / feedback / semantic-search reporting ====================

// get_usage_summary's row (database.py:992) — overall totals across every
// recorded LLM call.
export type UsageSummary = {
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_ttft_ms: number;
  max_ttft_ms: number;
  avg_total_ms: number;
  max_total_ms: number;
};

// get_usage_by_user's row (database.py:1011) — LEFT JOIN + grouped by
// m.user_id (not u.id) so metrics recorded before a user was deleted still
// show up here, matching getUsageSummary (no join) and getRecentLlmCalls
// (LEFT JOIN) instead of silently vanishing from just this one view.
export type UsageByUserRow = {
  user_id: number | null;
  username: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_ttft_ms: number;
  avg_total_ms: number;
};

// get_feedback_summary's row (database.py:1072).
export type FeedbackSummary = { up_count: number; down_count: number };

// get_recent_negative_feedback's row (database.py:1085) — the admin's
// review queue for answers that missed.
export type NegativeFeedbackRow = {
  message_id: number;
  session_id: string;
  session_title: string | null;
  user_id: number | null;
  username: string | null;
  created_at: string;
};

// get_recent_llm_calls' row (database.py:1103).
export type RecentLlmCallRow = {
  id: number;
  session_id: string;
  session_title: string | null;
  user_id: number | null;
  username: string | null;
  model: string | null;
  iteration: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
  created_at: string;
};

// get_semantic_search_stats' row (database.py:1125) — 0.5 is the same
// low-score threshold getSemanticSearchRecent's low_score_only uses; the
// distribution buckets let the panel show a spread instead of one average
// masking a bimodal (great queries + garbage queries) mix.
export type SemanticSearchStats = {
  query_count: number;
  avg_top1_score: number;
  avg_duration_ms: number;
  low_score_count: number;
  no_result_count: number;
  distribution: {
    bucket_none: number;
    bucket_0_3: number;
    bucket_3_5: number;
    bucket_5_7: number;
    bucket_7_10: number;
  };
};

// get_semantic_search_recent's row (database.py:1156).
export type SemanticSearchRecentRow = {
  id: number;
  query: string;
  repo_id: number | null;
  repo_name: string | null;
  result_count: number;
  top1_score: number | null;
  duration_ms: number | null;
  created_at: string;
  username: string;
};

export type Storage = {
  getOrCreateAppSecret(name: string): string;
  regenerateAppSecret(name: string): string;
  addMessage(sessionId: string, role: string, content: string | unknown[]): number;
  getMessages(sessionId: string): StoredMessageRow[];
  recordLlmCallMetrics(rows: LlmMetricsRow[]): void;
  getUserByUsername(username: string): UserRow | null;
  getUserById(userId: number): UserRow | null;
  createUser(username: string, passwordHash: string, role?: string, mustChangePassword?: boolean): number;
  listUsers(): Omit<UserRow, "password_hash">[];
  updateUserPassword(userId: number, passwordHash: string): void;
  setUserActive(userId: number, active: boolean): void;
  deleteUser(userId: number): void;
  createSession(title: string, ownerId: number | null): string;
  listSessions(ownerId: number | null): SessionRow[];
  getSession(sessionId: string): SessionRow | null;
  updateSessionTitle(sessionId: string, title: string): void;
  deleteSession(sessionId: string): void;
  listRepos(): RepoRow[];
  listReposForUser(userId: number): RepoRow[];
  getUserRepos(userId: number): RepoRow[];
  getRepo(repoId: number): RepoRow | null;
  getRepoAdmin(repoId: number): FullRepoRow | null;
  listReposFull(): FullRepoRow[];
  listReposForUserFull(userId: number): FullRepoRow[];
  createRepo(fields: CreateRepoFields): number;
  updateRepo(repoId: number, fields: UpdateRepoFields): void;
  deleteRepo(repoId: number): void;
  grantPermission(userId: number, repoId: number, accessLevel: string): number;
  revokePermission(userId: number, repoId: number): void;
  listPermissions(): PermissionRow[];
  recordSemanticSearchLog(row: RecordSemanticSearchLogRow): void;
  markSessionResolved(sessionId: string): void;
  recordIssueSubmission(fields: RecordIssueSubmissionFields): number;
  claimDraftSubmission(fields: ClaimDraftSubmissionFields, retrying?: boolean): ClaimDraftSubmissionResult;
  finalizeIssueSubmission(id: number, fields: FinalizeIssueSubmissionFields): void;
  releaseDraftSubmission(id: number): void;
  getIssueSubmissionsForSession(sessionId: string): IssueSubmissionRow[];
  getSubmissionByDraftToolUseId(draftToolUseId: string): IssueSubmissionRow | null;
  getSubmissionForTracking(id: number): TrackableSubmissionRow | null;
  getSubmissionByIssue(repoId: number | null, issueNumber: number): TrackableSubmissionRow | null;
  getTrackableSubmissions(): TrackableSubmissionRow[];
  beginPoll(submissionId: number): number;
  updateIssueTracking(submissionId: number, fields: UpdateIssueTrackingFields, generation: number): void;
  upsertFixReport(fields: UpsertFixReportFields): number;
  getUnverifiedFixReports(): UnverifiedFixReportRow[];
  setFixReportVerified(reportId: number, verified: boolean): void;
  getMyIssueSubmissions(userId: number, limit?: number): MyIssueSubmissionRow[];
  getMyUnreadIssueCount(userId: number): number;
  markMyIssuesSeen(userId: number): void;
  getIssueTrackingOverview(limit?: number): IssueTrackingOverview;
  recordIssueAction(fields: RecordIssueActionFields): number;
  claimDraftAction(fields: ClaimDraftActionFields, retrying?: boolean): ClaimDraftActionResult;
  finalizeIssueAction(id: number, fields: FinalizeIssueActionFields): void;
  releaseDraftAction(id: number): void;
  getIssueActionsForSession(sessionId: string): IssueActionRow[];
  getUsageSummary(): UsageSummary;
  getUsageByUser(): UsageByUserRow[];
  getMessageSessionId(messageId: number): string | null;
  setMessageFeedback(messageId: number, sessionId: string, userId: number, rating: number): void;
  getFeedbackForSession(sessionId: string, userId: number): Record<number, number>;
  getFeedbackSummary(): FeedbackSummary;
  getRecentNegativeFeedback(limit?: number): NegativeFeedbackRow[];
  getRecentLlmCalls(limit?: number): RecentLlmCallRow[];
  getSemanticSearchStats(): SemanticSearchStats;
  getSemanticSearchRecent(limit?: number, lowScoreOnly?: boolean): SemanticSearchRecentRow[];
  close(): void;
};

function checkSchema(db: Database.Database): void {
  // Check for required tables and columns using PRAGMA table_info
  const getTableColumns = (tableName: string): Set<string> => {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
    return new Set(cols.map((c) => c.name));
  };

  const messagesColumns = getTableColumns("messages");
  if (
    !messagesColumns.has("id") ||
    !messagesColumns.has("session_id") ||
    !messagesColumns.has("role") ||
    !messagesColumns.has("content") ||
    !messagesColumns.has("timestamp")
  ) {
    throw new SchemaError(
      "missing messages table or required columns (id, session_id, role, content, timestamp)"
    );
  }

  const sessionsColumns = getTableColumns("sessions");
  if (
    !sessionsColumns.has("id") ||
    !sessionsColumns.has("title") ||
    !sessionsColumns.has("owner_id") ||
    !sessionsColumns.has("updated_at") ||
    !sessionsColumns.has("resolved_at")
  ) {
    throw new SchemaError(
      "missing sessions table or required columns (id, title, owner_id, updated_at, resolved_at)"
    );
  }

  const metricsColumns = getTableColumns("llm_call_metrics");
  if (
    !metricsColumns.has("session_id") ||
    !metricsColumns.has("user_id") ||
    !metricsColumns.has("model") ||
    !metricsColumns.has("iteration") ||
    !metricsColumns.has("input_tokens") ||
    !metricsColumns.has("output_tokens") ||
    !metricsColumns.has("ttft_ms") ||
    !metricsColumns.has("total_ms") ||
    !metricsColumns.has("created_at")
  ) {
    throw new SchemaError(
      "missing llm_call_metrics table or required columns"
    );
  }

  const usersColumns = getTableColumns("users");
  if (
    !usersColumns.has("id") ||
    !usersColumns.has("username") ||
    !usersColumns.has("password_hash") ||
    !usersColumns.has("role") ||
    !usersColumns.has("created_at")
  ) {
    throw new SchemaError(
      "missing users table or required columns (id, username, password_hash, role, created_at)"
    );
  }

  const reposColumns = getTableColumns("repositories");
  if (
    !reposColumns.has("id") ||
    !reposColumns.has("name") ||
    !reposColumns.has("url")
  ) {
    throw new SchemaError(
      "missing repositories table or required columns (id, name, url)"
    );
  }

  const permissionsColumns = getTableColumns("permissions");
  if (
    !permissionsColumns.has("user_id") ||
    !permissionsColumns.has("repo_id") ||
    !permissionsColumns.has("access_level")
  ) {
    throw new SchemaError(
      "missing permissions table or required columns (user_id, repo_id, access_level)"
    );
  }
}

// v1's inline `try: json.loads(x) except (JSONDecodeError, TypeError): []`
// idiom, repeated across get_issue_submissions_for_session/
// get_issue_tracking_overview for the labels/remote_labels columns —
// falsy (null/"") folds to [] without even attempting a parse, matching
// v1's `json.loads(r[key]) if r[key] else []`.
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function openStorage(dbPath: string): Storage {
  const db = new Database(dbPath);

  // Apply PRAGMAs
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Check schema
  checkSchema(db);

  // v1's get_fix_reports_for_submissions (database.py:812) — {submission_id:
  // [report, ...]} for the 工单/我的提报 rows. Kept as a plain closure over
  // `db`, not a Storage method: every caller immediately follows it with
  // its own list query, so a separate DbClient/RPC round-trip per call
  // would be pure overhead.
  function getFixReportsForSubmissionsSync(submissionIds: number[]): Map<number, FixReportRow[]> {
    const out = new Map<number, FixReportRow[]>();
    if (submissionIds.length === 0) return out;
    const placeholders = submissionIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT submission_id, note_id, worker_id, commit_sha, files_json, verified, reported_at
         FROM issue_fix_reports WHERE submission_id IN (${placeholders}) ORDER BY note_id`
      )
      .all(...submissionIds) as Array<{
      submission_id: number;
      note_id: number;
      worker_id: string | null;
      commit_sha: string | null;
      files_json: string;
      verified: number | null;
      reported_at: string | null;
    }>;
    for (const { files_json, ...rest } of rows) {
      const report: FixReportRow = { ...rest, files: parseJsonArray(files_json) };
      const list = out.get(report.submission_id);
      if (list) list.push(report);
      else out.set(report.submission_id, [report]);
    }
    return out;
  }

  // `storage` is bound to the object below, but its methods only read the
  // binding at call time (not during literal construction) — self-reference
  // (getUserRepos delegating to listReposForUser) is safe.
  const storage: Storage = {
    // DB-backed replacement for the old file-based webhook secrets
    // (2026-07-14, GitHub issue #6) — same "atomic create-if-absent, return
    // existing on conflict" shape as config.ts's loadOrCreateSecretFile,
    // but via SQLite's own INSERT ... ON CONFLICT instead of a filesystem
    // exclusive-create + EEXIST dance. No separate "is it empty" branch to
    // get wrong: a row either exists with a real value, or it doesn't yet.
    getOrCreateAppSecret(name: string): string {
      const now = pyLocalIsoNow();
      const value = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO app_secrets (name, value, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(name) DO NOTHING"
      ).run(name, value, now);
      const row = db.prepare("SELECT value FROM app_secrets WHERE name = ?").get(name) as
        | { value: string }
        | undefined;
      // The SELECT is guaranteed to find a row: either this INSERT just
      // created it, or a concurrent/prior call already did.
      return row!.value;
    },

    // Admin-triggered rotation (the DB migration's whole point over the old
    // file-based approach: a leaked/rotated secret needed an SSH session
    // and a container restart before; this is just an UPDATE). Callers must
    // also update their in-memory Settings copy — this only changes what's
    // durably stored, not what any already-running process holds.
    regenerateAppSecret(name: string): string {
      const now = pyLocalIsoNow();
      const value = randomBytes(32).toString("hex");
      db.prepare(
        "INSERT INTO app_secrets (name, value, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET value = excluded.value"
      ).run(name, value, now);
      return value;
    },

    addMessage(sessionId: string, role: string, content: string | unknown[]): number {
      const now = pyLocalIsoNow();
      const contentStr =
        typeof content === "string" ? content : pythonJsonDumps(content);

      const txn = db.transaction(() => {
        const insertStmt = db.prepare(
          "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)"
        );
        const res = insertStmt.run(sessionId, role, contentStr, now);
        const msgId = Number(res.lastInsertRowid);

        db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
          now,
          sessionId
        );

        return msgId;
      });

      return txn();
    },

    getMessages(sessionId: string): StoredMessageRow[] {
      const rows = db
        .prepare(
          "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id"
        )
        .all(sessionId) as Array<{
        id: number;
        role: string;
        content: string;
        timestamp: string;
      }>;

      return rows.map((row) => {
        let parsedContent: string | unknown[] = row.content;

        if (
          typeof row.content === "string" &&
          row.content.startsWith("[")
        ) {
          try {
            parsedContent = JSON.parse(row.content);
          } catch {
            // Keep raw content on parse failure
            parsedContent = row.content;
          }
        }

        return {
          id: row.id,
          role: row.role,
          content: parsedContent,
          timestamp: row.timestamp,
        };
      });
    },

    recordLlmCallMetrics(rows: LlmMetricsRow[]): void {
      if (rows.length === 0) {
        return;
      }

      const now = pyLocalIsoNow();
      const txn = db.transaction(() => {
        const insertStmt = db.prepare(
          "INSERT INTO llm_call_metrics " +
            "(session_id, user_id, model, iteration, input_tokens, output_tokens, ttft_ms, total_ms, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );

        for (const row of rows) {
          insertStmt.run(
            row.session_id,
            row.user_id,
            row.model,
            row.iteration,
            row.input_tokens,
            row.output_tokens,
            row.ttft_ms,
            row.total_ms,
            now
          );
        }
      });

      txn();
    },

    getUserByUsername(username: string): UserRow | null {
      const row = db
        .prepare("SELECT * FROM users WHERE username = ?")
        .get(username) as UserRow | undefined;
      return row ?? null;
    },

    // mustChangePassword (BUG-003): only ensureAdminUser sets this true
    // today, specifically when bootstrapping the admin with the well-known
    // default password — admin-created users (POST /api/admin/users) keep
    // the false default, out of scope for this fix (see that route's own
    // comment).
    createUser(
      username: string,
      passwordHash: string,
      role: string = "user",
      mustChangePassword: boolean = false
    ): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO users (username, password_hash, role, created_at, must_change_password) VALUES (?, ?, ?, ?, ?)"
        )
        .run(username, passwordHash, role, now, mustChangePassword ? 1 : 0);
      return Number(res.lastInsertRowid);
    },

    getUserById(userId: number): UserRow | null {
      const row = db
        .prepare("SELECT * FROM users WHERE id = ?")
        .get(userId) as UserRow | undefined;
      return row ?? null;
    },

    // v1's list_users: password_hash deliberately excluded from the SELECT
    // (not just stripped after the fact) — never round-trips through this path.
    listUsers(): Omit<UserRow, "password_hash">[] {
      const rows = db
        .prepare("SELECT id, username, role, is_active, created_at FROM users ORDER BY id")
        .all();
      return rows as Omit<UserRow, "password_hash">[];
    },

    // Clears must_change_password unconditionally alongside the password
    // itself (BUG-003) — whoever changed it (the user via self-service, or
    // an admin resetting it for them), the force-flag no longer applies to
    // the password that's now live. Also bumps token_version (Codex
    // full-repo review, 2026-07-14, Warning) so every JWT issued before
    // this change stops passing the auth middleware's version check
    // immediately, instead of staying valid until it naturally expires —
    // whether that's a legitimate self-service change or an admin
    // responding to a suspected compromise.
    updateUserPassword(userId: number, passwordHash: string): void {
      db.prepare(
        "UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?"
      ).run(passwordHash, userId);
    },

    setUserActive(userId: number, active: boolean): void {
      db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, userId);
    },

    // No explicit permissions/sessions cleanup here — matches v1's single
    // DELETE FROM users; the schema's FKs (permissions.user_id ON DELETE
    // CASCADE, sessions.owner_id ON DELETE SET NULL) do the rest.
    deleteUser(userId: number): void {
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    },

    // v1's create_session: mint uuid4()[:8] (first 8 hex chars — the
    // segment before the first '-' in a v4 UUID string), retry up to 5x on
    // the rare PK collision, then give up loudly rather than hang forever.
    createSession(title: string, ownerId: number | null): string {
      const now = pyLocalIsoNow();
      const insertStmt = db.prepare(
        "INSERT INTO sessions (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (let attempt = 0; attempt < 5; attempt++) {
        const sessionId = randomUUID().slice(0, 8);
        try {
          insertStmt.run(sessionId, title, ownerId, now, now);
          return sessionId;
        } catch (err) {
          // Narrowly matched to the id-collision case (PRIMARY KEY violation)
          // — NOT a blanket SQLITE_CONSTRAINT* match, which would also catch
          // (and silently retry-then-mask behind "failed to allocate an id")
          // an invalid owner_id's FOREIGN KEY violation. better-sqlite3
          // exposes the specific extended code so there's no need to accept
          // v1's coarser `except aiosqlite.IntegrityError` ambiguity here.
          if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
            continue; // collided with an existing id — try another
          }
          throw err;
        }
      }
      throw new Error("Failed to allocate a unique session ID after 5 attempts");
    },

    listSessions(ownerId: number | null): SessionRow[] {
      const sql =
        "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions " +
        (ownerId !== null ? "WHERE owner_id = ? " : "") +
        "ORDER BY updated_at DESC";
      const rows = ownerId !== null ? db.prepare(sql).all(ownerId) : db.prepare(sql).all();
      return rows as SessionRow[];
    },

    getSession(sessionId: string): SessionRow | null {
      const row = db
        .prepare(
          "SELECT id, title, owner_id, created_at, updated_at, resolved_at FROM sessions WHERE id = ?"
        )
        .get(sessionId) as SessionRow | undefined;
      return row ?? null;
    },

    // v1 database.py's update_session_title: title + updated_at, nothing
    // else touched (created_at/owner_id/resolved_at all untouched).
    updateSessionTitle(sessionId: string, title: string): void {
      const now = pyLocalIsoNow();
      db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
        title,
        now,
        sessionId
      );
    },

    // Explicit two DELETEs (messages then sessions), matching v1's
    // delete_session exactly, rather than relying solely on the schema's
    // `ON DELETE CASCADE` — both in one transaction for atomicity.
    deleteSession(sessionId: string): void {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      });
      txn();
    },

    // Admin "sees every repo" path — v1's list_repos(), no permissions
    // filter. access_level is always null here (no grant row backs it).
    listRepos(): RepoRow[] {
      const rows = db
        .prepare("SELECT id, name, url, description, branch FROM repositories ORDER BY name")
        .all() as Array<Omit<RepoRow, "access_level">>;
      return rows.map((r) => ({ ...r, access_level: null }));
    },

    // Non-admin "only granted repos" path — v1's get_user_repos(), JOINed
    // through permissions for this user's access_level per repo.
    listReposForUser(userId: number): RepoRow[] {
      const rows = db
        .prepare(
          `SELECT r.id, r.name, r.url, r.description, r.branch, p.access_level
           FROM repositories r
           JOIN permissions p ON r.id = p.repo_id
           WHERE p.user_id = ?
           ORDER BY r.name`
        )
        .all(userId);
      return rows as RepoRow[];
    },

    // v1's get_user_repos — same JOIN as listReposForUser, exposed under
    // its own v1-matching name for the admin API (Task 1 brief). Delegates
    // rather than re-running the query so the JOIN has one source of truth.
    getUserRepos(userId: number): RepoRow[] {
      return storage.listReposForUser(userId);
    },

    // Admin single-repo lookup. Mirrors listRepos' public column set
    // (access_level always null, no permissions JOIN) rather than v1's
    // `SELECT *` — the credential/sync-status columns stay internal to
    // updateRepo's dynamic SET builder per the Task 1 brief's signature.
    getRepo(repoId: number): RepoRow | null {
      const row = db
        .prepare("SELECT id, name, url, description, branch FROM repositories WHERE id = ?")
        .get(repoId) as Omit<RepoRow, "access_level"> | undefined;
      return row ? { ...row, access_level: null } : null;
    },

    // Admin full-row lookup — v1's get_repo (`SELECT *`). Exposes the
    // credential/local_path/sync-status columns getRepo omits; the admin
    // routes (Task 7) need this to diff PATCH changes, compute has_token,
    // and pass credentials to sync_and_persist. No masking here — that's
    // the route layer's job (_admin_repo_view in v1).
    getRepoAdmin(repoId: number): FullRepoRow | null {
      const row = db
        .prepare("SELECT * FROM repositories WHERE id = ?")
        .get(repoId) as Omit<FullRepoRow, "access_level"> | undefined;
      return row ? { ...row, access_level: null } : null;
    },

    // Task 8: the chat route's ToolContext resolution needs local_path
    // (which RepoRow's `_public_repo`-equivalent column set never
    // includes — see RepoRow's own comment) to build allowedRepoPaths.
    // v1 didn't need this distinction: its list_repos()/get_user_repos()
    // DB functions always returned the full sqlite row (local_path
    // included), and masking only happened at the `/api/repos` ROUTE via
    // `_public_repo()`. v2 baked the masking into listRepos/listReposForUser
    // itself instead, which is safer by construction for that endpoint but
    // left no full-row bulk accessor for a server-internal caller like
    // resolveToolContext (src/server/sse.ts) that legitimately needs
    // local_path and must never let it leak to the browser. These two
    // mirror listRepos/listReposForUser's admin-bypass shape exactly, just
    // with the full column set (like getRepoAdmin) — for internal callers
    // only, never wired to a client-facing route.
    listReposFull(): FullRepoRow[] {
      const rows = db
        .prepare("SELECT * FROM repositories ORDER BY name")
        .all() as Array<Omit<FullRepoRow, "access_level">>;
      return rows.map((r) => ({ ...r, access_level: null }));
    },

    listReposForUserFull(userId: number): FullRepoRow[] {
      const rows = db
        .prepare(
          `SELECT r.*, p.access_level
           FROM repositories r
           JOIN permissions p ON r.id = p.repo_id
           WHERE p.user_id = ?
           ORDER BY r.name`
        )
        .all(userId);
      return rows as FullRepoRow[];
    },

    // v1's create_repo — local_path intentionally omitted from the writable
    // fields (Task 1 brief): it's populated later by the sync process, not
    // at creation time.
    createRepo(fields: CreateRepoFields): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO repositories (name, url, description, branch, cred_username, cred_token, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          fields.name,
          fields.url,
          fields.description ?? "",
          fields.branch ?? null,
          fields.credUsername ?? null,
          fields.credToken ?? null,
          now
        );
      return Number(res.lastInsertRowid);
    },

    // v1's update_repo: dynamic SET builder — only fields actually passed
    // (undefined) are touched; a no-op call (no fields) skips the UPDATE
    // entirely. branch/credUsername/credToken fold "" to NULL on write,
    // matching v1's `x or None`.
    updateRepo(repoId: number, fields: UpdateRepoFields): void {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        setClauses.push(`${column} = ?`);
        values.push(value);
      };

      if (fields.name !== undefined) set("name", fields.name);
      if (fields.url !== undefined) set("url", fields.url);
      if (fields.branch !== undefined) set("branch", fields.branch || null);
      if (fields.credUsername !== undefined) set("cred_username", fields.credUsername || null);
      if (fields.credToken !== undefined) set("cred_token", fields.credToken || null);
      if (fields.description !== undefined) set("description", fields.description);
      if (fields.localPath !== undefined) set("local_path", fields.localPath);
      if (fields.lastSyncAt !== undefined) set("last_sync_at", fields.lastSyncAt);
      if (fields.lastSyncStatus !== undefined) set("last_sync_status", fields.lastSyncStatus);
      if (fields.lastSyncMessage !== undefined) set("last_sync_message", fields.lastSyncMessage);
      if (fields.indexStatus !== undefined) set("index_status", fields.indexStatus);
      if (fields.lastSyncSha !== undefined) set("last_sync_sha", fields.lastSyncSha);

      if (setClauses.length === 0) return;
      values.push(repoId);
      db.prepare(`UPDATE repositories SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    },

    // Explicit two DELETEs (permissions then repositories), matching v1's
    // delete_repo exactly, both in one transaction for atomicity.
    deleteRepo(repoId: number): void {
      const txn = db.transaction(() => {
        db.prepare("DELETE FROM permissions WHERE repo_id = ?").run(repoId);
        db.prepare("DELETE FROM repositories WHERE id = ?").run(repoId);
      });
      txn();
    },

    // v1's grant_permission: INSERT ... ON CONFLICT(user_id, repo_id) DO
    // UPDATE — re-granting an existing (user, repo) pair updates its
    // access_level in place rather than erroring on the UNIQUE constraint.
    grantPermission(userId: number, repoId: number, accessLevel: string): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO permissions (user_id, repo_id, access_level, created_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(user_id, repo_id) DO UPDATE SET access_level = excluded.access_level"
        )
        .run(userId, repoId, accessLevel, now);
      return Number(res.lastInsertRowid);
    },

    revokePermission(userId: number, repoId: number): void {
      db.prepare("DELETE FROM permissions WHERE user_id = ? AND repo_id = ?").run(userId, repoId);
    },

    // v1's list_permissions — JOINed through users/repositories so callers
    // get username/repo_name without a second round-trip.
    listPermissions(): PermissionRow[] {
      const rows = db
        .prepare(
          `SELECT p.id, p.user_id, u.username, p.repo_id, r.name as repo_name,
                  p.access_level, p.created_at
           FROM permissions p
           JOIN users u ON p.user_id = u.id
           JOIN repositories r ON p.repo_id = r.id
           ORDER BY u.username, r.name`
        )
        .all();
      return rows as PermissionRow[];
    },

    // v1's _log_search INSERT — created_at generated here (like every other
    // write method in this file), not accepted from the caller, so every
    // row's timestamp source stays consistent regardless of who's calling.
    recordSemanticSearchLog(row: RecordSemanticSearchLogRow): void {
      const now = pyLocalIsoNow();
      db.prepare(
        "INSERT INTO semantic_search_log " +
          "(user_id, repo_id, query, result_count, top1_score, results_json, duration_ms, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        row.userId,
        row.repoId,
        row.query,
        row.resultCount,
        row.top1Score,
        row.resultsJson,
        row.durationMs,
        now
      );
    },

    // v1's mark_session_resolved (database.py:590) — the next message sent
    // against this session_id should land in a fresh session instead of
    // continuing this one.
    markSessionResolved(sessionId: string): void {
      const now = pyLocalIsoNow();
      db.prepare("UPDATE sessions SET resolved_at = ? WHERE id = ?").run(now, sessionId);
    },

    // v1's record_issue_submission (database.py:661) — the authoritative
    // outcome of a real issue filing; the chat message history only ever
    // shows the draft card live, never whether/where it was actually filed.
    recordIssueSubmission(fields: RecordIssueSubmissionFields): number {
      const now = pyLocalIsoNow();
      try {
        const res = db
          .prepare(
            "INSERT INTO issue_submissions " +
              "(session_id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            fields.sessionId,
            fields.repoId,
            fields.userId,
            fields.title,
            fields.body,
            pythonJsonDumps(fields.labels),
            fields.issueNumber,
            fields.issueUrl,
            fields.draftToolUseId ?? null,
            now
          );
        return Number(res.lastInsertRowid);
      } catch (err) {
        // Narrow backstop for the route-level idempotency check's own race
        // window (two requests both pass "not yet submitted" before either
        // INSERT lands) — same narrow-match style as createSession's
        // PK-collision retry above, not a blanket SQLITE_CONSTRAINT* catch.
        if (
          err instanceof Database.SqliteError &&
          err.code === "SQLITE_CONSTRAINT_UNIQUE" &&
          fields.draftToolUseId
        ) {
          const existing = db
            .prepare("SELECT id FROM issue_submissions WHERE draft_tool_use_id = ?")
            .get(fields.draftToolUseId) as { id: number } | undefined;
          if (existing) return existing.id;
        }
        throw err;
      }
    },

    // Structural idempotency fix (QA-reported 2026-07-14): the route used to
    // check getSubmissionByDraftToolUseId, THEN call the tracker, THEN
    // recordIssueSubmission — leaving a real window where two
    // near-simultaneous requests (an actual double-click, not just a
    // theoretical race) both passed the check and both called
    // submitRepoIssue, filing two real GitHub issues even though local
    // bookkeeping only ever showed one. Claiming draft_tool_use_id via this
    // INSERT BEFORE the tracker is ever called makes the unique index the
    // single atomic decision point — only one caller can ever proceed past
    // it to actually file the issue. Pair with finalizeIssueSubmission (on
    // tracker success) or releaseDraftSubmission (on tracker failure).
    // claimTtlMs (Codex full-repo review, 2026-07-14, Warning): a claim
    // whose owning request crashed/timed out before finalize/release used
    // to block that draft_tool_use_id FOREVER (permanent 409, no recovery
    // path). Anything still unfinished (issue_number IS NULL) past its own
    // claim_expires_at is treated as abandoned and reclaimed — deleted and
    // re-inserted in the SAME transaction as this call, so a genuinely
    // concurrent second claimant still can't slip in between the delete and
    // the insert. `retrying` guards against infinite recursion (there is
    // at most one stale row to reclaim per call).
    claimDraftSubmission(fields: ClaimDraftSubmissionFields, retrying = false): ClaimDraftSubmissionResult {
      const now = pyLocalIsoNow();
      const claimExpiresAt = Date.now() + CLAIM_TTL_MS;
      try {
        const res = db
          .prepare(
            "INSERT INTO issue_submissions " +
              "(session_id, repo_id, user_id, title, body, labels, draft_tool_use_id, submitted_at, claim_expires_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            fields.sessionId,
            fields.repoId,
            fields.userId,
            fields.title,
            fields.body,
            pythonJsonDumps(fields.labels),
            fields.draftToolUseId,
            now,
            claimExpiresAt
          );
        return { claimed: true, id: Number(res.lastInsertRowid) };
      } catch (err) {
        if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
          const row = db
            .prepare(
              `SELECT id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at,
                      COALESCE(track_status, 'submitted') as track_status, reopen_count, claim_expires_at
               FROM issue_submissions WHERE draft_tool_use_id = ?`
            )
            .get(fields.draftToolUseId) as
            | (Omit<IssueSubmissionRow, "labels"> & { labels: string; claim_expires_at: number | null })
            | undefined;
          if (!row) throw err; // conflicted row vanished between INSERT and SELECT — surface the original error rather than loop
          if (
            !retrying &&
            row.issue_number === null &&
            row.claim_expires_at !== null &&
            row.claim_expires_at < Date.now()
          ) {
            const txn = db.transaction(() => {
              db.prepare("DELETE FROM issue_submissions WHERE id = ? AND issue_number IS NULL").run(row.id);
            });
            txn();
            return storage.claimDraftSubmission(fields, true);
          }
          return { claimed: false, existing: { ...row, labels: parseJsonArray(row.labels) } };
        }
        throw err;
      }
    },

    // Fills in the real outcome once submitRepoIssue actually succeeds for a
    // row claimDraftSubmission already created. Also persists the FINAL body
    // (screenshots section folded in after the claim succeeded, see
    // issue-routes.ts) and clears claim_expires_at — a finalized row is
    // never eligible for staleness-reclaim regardless (issue_number is no
    // longer NULL), but NULLing it out avoids a stale-looking timestamp
    // hanging around on a row that's actually done.
    finalizeIssueSubmission(id: number, fields: FinalizeIssueSubmissionFields): void {
      db.prepare(
        "UPDATE issue_submissions SET issue_number = ?, issue_url = ?, body = ?, claim_expires_at = NULL WHERE id = ?"
      ).run(fields.issueNumber, fields.issueUrl, fields.body, id);
    },

    // Releases a claim when the tracker call itself failed (network error,
    // 502, etc.) — otherwise draft_tool_use_id stays permanently claimed
    // with issue_number still NULL and a legitimate retry can never get past
    // claimDraftSubmission again. Guarded on issue_number IS NULL so this can
    // never delete a row a concurrent request has since finalized.
    releaseDraftSubmission(id: number): void {
      db.prepare("DELETE FROM issue_submissions WHERE id = ? AND issue_number IS NULL").run(id);
    },

    // Idempotency lookup for /api/issues/submit — draft_tool_use_id is
    // stable per draft card, so a hit here means this exact draft was
    // already filed; the route hands back the existing issue instead of
    // calling the tracker again.
    getSubmissionByDraftToolUseId(draftToolUseId: string): IssueSubmissionRow | null {
      const row = db
        .prepare(
          `SELECT id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at,
                  COALESCE(track_status, 'submitted') as track_status, reopen_count
           FROM issue_submissions WHERE draft_tool_use_id = ?`
        )
        .get(draftToolUseId) as (Omit<IssueSubmissionRow, "labels"> & { labels: string }) | undefined;
      return row ? { ...row, labels: parseJsonArray(row.labels) } : null;
    },

    // On-demand single-submission recheck (right after the user's own
    // submit/action) — same shape as getTrackableSubmissions but by id and
    // with no "is it due yet" staleness filter, since an on-demand recheck
    // always runs regardless of when it was last checked.
    getSubmissionForTracking(id: number): TrackableSubmissionRow | null {
      const row = db
        .prepare(
          `SELECT id, repo_id, issue_number, issue_url, track_status, remote_state,
                  reopen_count, closed_at, last_checked_at
           FROM issue_submissions
           WHERE id = ? AND issue_number IS NOT NULL AND issue_url IS NOT NULL`
        )
        .get(id);
      return (row as TrackableSubmissionRow) ?? null;
    },

    // manage_issue can act on an issue CodeAxis never itself filed, so
    // "the issue this action just touched" isn't always the same row as
    // "the submission this session filed" — look it up by repo+number
    // instead. Most-recent row wins if somehow more than one exists.
    getSubmissionByIssue(repoId: number | null, issueNumber: number): TrackableSubmissionRow | null {
      const row = db
        .prepare(
          `SELECT id, repo_id, issue_number, issue_url, track_status, remote_state,
                  reopen_count, closed_at, last_checked_at
           FROM issue_submissions
           WHERE repo_id ${repoId === null ? "IS NULL" : "= ?"} AND issue_number = ?
             AND issue_number IS NOT NULL AND issue_url IS NOT NULL
           ORDER BY id DESC LIMIT 1`
        )
        .get(...(repoId === null ? [issueNumber] : [repoId, issueNumber]));
      return (row as TrackableSubmissionRow) ?? null;
    },

    // v1's get_issue_submissions_for_session (database.py:688) — used to
    // reconcile historical draft cards to their real final state on replay.
    getIssueSubmissionsForSession(sessionId: string): IssueSubmissionRow[] {
      const rows = db
        .prepare(
          `SELECT id, repo_id, user_id, title, body, labels, issue_number, issue_url, draft_tool_use_id, submitted_at,
                  COALESCE(track_status, 'submitted') as track_status, reopen_count
           FROM issue_submissions WHERE session_id = ? ORDER BY id`
        )
        .all(sessionId) as Array<Omit<IssueSubmissionRow, "labels"> & { labels: string }>;
      return rows.map((r) => ({ ...r, labels: parseJsonArray(r.labels) }));
    },

    // v1's get_trackable_submissions (database.py:710) — everything still
    // open/unknown is polled every round; closed issues drop to at most one
    // check per day so a late reopen is still caught.
    getTrackableSubmissions(): TrackableSubmissionRow[] {
      const rows = db
        .prepare(
          `SELECT id, repo_id, issue_number, issue_url, track_status, remote_state,
                  reopen_count, closed_at, last_checked_at
           FROM issue_submissions
           WHERE issue_number IS NOT NULL AND issue_url IS NOT NULL
             AND (
               remote_state IS NULL OR remote_state != 'closed'
               OR last_checked_at IS NULL
               OR last_checked_at < datetime('now', 'localtime', '-1 day')
             )
           ORDER BY id`
        )
        .all();
      return rows as TrackableSubmissionRow[];
    },

    // Codex full-repo review (2026-07-14, Warning): cron poll, webhook
    // receiver, and on-demand recheck can all race to update the SAME
    // submission — beginPoll hands out a monotonically increasing ticket
    // per attempt (pollOne calls this BEFORE any network round-trip), and
    // this write only commits if no NEWER attempt has started in the
    // meantime, regardless of which one finishes first. Self-healing: if
    // the newest attempt crashes without ever writing, the row's
    // poll_generation just stays wherever it left off, and the NEXT poll
    // attempt (of any kind) claims a fresh, higher ticket for itself.
    beginPoll(submissionId: number): number {
      db.prepare("UPDATE issue_submissions SET poll_generation = poll_generation + 1 WHERE id = ?").run(
        submissionId
      );
      const row = db.prepare("SELECT poll_generation FROM issue_submissions WHERE id = ?").get(submissionId) as
        | { poll_generation: number }
        | undefined;
      return row?.poll_generation ?? 0;
    },

    // v1's update_issue_tracking (database.py:732) — only touches fields
    // actually passed; status_changed_at is stamped via a CASE expression
    // in the SAME UPDATE as track_status so a poll that re-observes the
    // same status can't race between "check old status" and "write new
    // status" as two separate statements would. `generation` (Codex
    // full-repo review, 2026-07-14, Warning) must match the row's CURRENT
    // poll_generation for this write to take — see beginPoll above.
    updateIssueTracking(submissionId: number, fields: UpdateIssueTrackingFields, generation: number): void {
      const now = pyLocalIsoNow();
      const setClauses: string[] = ["last_checked_at = ?"];
      const values: unknown[] = [now];

      if (fields.trackStatus !== undefined) {
        setClauses.push(
          "status_changed_at = CASE WHEN COALESCE(track_status, 'submitted') != ? THEN ? ELSE status_changed_at END"
        );
        values.push(fields.trackStatus, now);
        setClauses.push("track_status = ?");
        values.push(fields.trackStatus);
      }
      if (fields.remoteState !== undefined) {
        setClauses.push("remote_state = ?");
        values.push(fields.remoteState);
      }
      if (fields.remoteLabels !== undefined) {
        setClauses.push("remote_labels = ?");
        values.push(fields.remoteLabels);
      }
      if (fields.reopenCount !== undefined) {
        setClauses.push("reopen_count = ?");
        values.push(fields.reopenCount);
      }
      if (fields.closedAt !== undefined) {
        setClauses.push("closed_at = ?");
        values.push(fields.closedAt);
      }
      if (fields.clearError) {
        setClauses.push("track_error = NULL");
      } else if (fields.trackError !== undefined) {
        setClauses.push("track_error = ?");
        values.push(fields.trackError);
      }

      values.push(submissionId, generation);
      db.prepare(`UPDATE issue_submissions SET ${setClauses.join(", ")} WHERE id = ? AND poll_generation = ?`).run(
        ...values
      );
    },

    // v1's upsert_fix_report (database.py:765) — on a re-poll of a known
    // note, refreshes the payload fields but PRESERVES `verified` (omitted
    // from the SET clause entirely): verification is the platform's own
    // conclusion and a re-parse of the same comment must not reset it.
    upsertFixReport(fields: UpsertFixReportFields): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO issue_fix_reports " +
            "(submission_id, note_id, worker_id, commit_sha, files_json, reported_at, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(submission_id, note_id) DO UPDATE SET " +
            "worker_id = excluded.worker_id, commit_sha = excluded.commit_sha, " +
            "files_json = excluded.files_json, reported_at = excluded.reported_at"
        )
        .run(
          fields.submissionId,
          fields.noteId,
          fields.workerId,
          fields.commitSha,
          pythonJsonDumps(fields.files),
          fields.reportedAt,
          now
        );
      return Number(res.lastInsertRowid);
    },

    // v1's get_unverified_fix_reports (database.py:788) — verified 0
    // (checked, NOT on the branch) is a conclusion, not a retry queue; only
    // NULL (never checked) rows come back here.
    getUnverifiedFixReports(): UnverifiedFixReportRow[] {
      const rows = db
        .prepare(
          `SELECT f.id, f.submission_id, f.commit_sha, s.issue_url, s.repo_id
           FROM issue_fix_reports f
           JOIN issue_submissions s ON s.id = f.submission_id
           WHERE f.verified IS NULL AND f.commit_sha IS NOT NULL`
        )
        .all();
      return rows as UnverifiedFixReportRow[];
    },

    setFixReportVerified(reportId: number, verified: boolean): void {
      db.prepare("UPDATE issue_fix_reports SET verified = ? WHERE id = ?").run(verified ? 1 : 0, reportId);
    },

    // v1's get_my_issue_submissions (database.py:835) — powers the 我的提报
    // drawer. fresh is computed against the user's own my_issues_seen_at —
    // both timestamps are server-local, so unlike a client-side check this
    // can't be thrown off by the browser's clock disagreeing with the
    // server's.
    getMyIssueSubmissions(userId: number, limit: number = 50): MyIssueSubmissionRow[] {
      const seenRow = db.prepare("SELECT my_issues_seen_at FROM users WHERE id = ?").get(userId) as
        | { my_issues_seen_at: string | null }
        | undefined;
      const seenAt = seenRow?.my_issues_seen_at ?? null;

      const rows = db
        .prepare(
          `SELECT s.id, s.repo_id, r.name as repo_name, s.title, s.issue_number, s.issue_url,
                  s.submitted_at, COALESCE(s.track_status, 'submitted') as track_status,
                  s.reopen_count, s.closed_at, s.status_changed_at
           FROM issue_submissions s
           LEFT JOIN repositories r ON r.id = s.repo_id
           WHERE s.user_id = ? AND s.issue_number IS NOT NULL
           ORDER BY s.id DESC
           LIMIT ?`
        )
        .all(userId, limit) as Array<
        Omit<MyIssueSubmissionRow, "fix_verified" | "fix_files_count" | "fix_commit" | "fresh">
      >;

      const reports = getFixReportsForSubmissionsSync(rows.map((r) => r.id));

      return rows.map((r) => {
        const verified = (reports.get(r.id) ?? []).filter((rep) => rep.verified === 1);
        const last = verified[verified.length - 1];
        const statusChangedAt = r.status_changed_at;
        return {
          ...r,
          fix_verified: verified.length > 0,
          fix_files_count: last ? last.files.length : null,
          fix_commit: last ? (last.commit_sha ?? "").slice(0, 10) : null,
          fresh: statusChangedAt !== null && (seenAt === null || statusChangedAt > seenAt),
        };
      });
    },

    // v1's get_my_unread_issue_count (database.py:868) — a cheap COUNT for
    // the sidebar badge, avoiding the full submissions+fix-reports payload
    // just to render a number on every page load.
    getMyUnreadIssueCount(userId: number): number {
      const seenRow = db.prepare("SELECT my_issues_seen_at FROM users WHERE id = ?").get(userId) as
        | { my_issues_seen_at: string | null }
        | undefined;
      const seenAt = seenRow?.my_issues_seen_at ?? null;
      const row = db
        .prepare(
          `SELECT COUNT(*) as n FROM issue_submissions
           WHERE user_id = ? AND issue_number IS NOT NULL AND status_changed_at IS NOT NULL
           AND (? IS NULL OR status_changed_at > ?)`
        )
        .get(userId, seenAt, seenAt) as { n: number };
      return row.n;
    },

    markMyIssuesSeen(userId: number): void {
      const now = pyLocalIsoNow();
      db.prepare("UPDATE users SET my_issues_seen_at = ? WHERE id = ?").run(now, userId);
    },

    // v1's get_issue_tracking_overview (database.py:892) — the 工单 tab's
    // data: status counts + the tracked-submission list. Deliberately no
    // "fix rate" derived field here — 'closed' includes won't-fix/duplicate
    // closures, and calling that a fix rate would be a fake number.
    getIssueTrackingOverview(limit: number = 100): IssueTrackingOverview {
      const countRows = db
        .prepare(
          `SELECT COALESCE(track_status, 'submitted') as status, COUNT(*) as n
           FROM issue_submissions WHERE issue_number IS NOT NULL
           GROUP BY COALESCE(track_status, 'submitted')`
        )
        .all() as Array<{ status: string; n: number }>;
      const counts: Record<string, number> = {};
      for (const r of countRows) counts[r.status] = r.n;

      const rawRows = db
        .prepare(
          `SELECT s.id, s.repo_id, r.name as repo_name, s.title, s.body, s.issue_number, s.issue_url,
                  s.labels, s.submitted_at,
                  COALESCE(s.track_status, 'submitted') as track_status,
                  s.remote_state, s.remote_labels, s.reopen_count, s.closed_at,
                  s.last_checked_at, s.track_error,
                  COALESCE(u.username, '(已删除用户 #' || s.user_id || ')') as username
           FROM issue_submissions s
           LEFT JOIN users u ON u.id = s.user_id
           LEFT JOIN repositories r ON r.id = s.repo_id
           WHERE s.issue_number IS NOT NULL
           ORDER BY s.id DESC
           LIMIT ?`
        )
        .all(limit) as Array<
        Omit<IssueTrackingOverviewRow, "labels" | "remote_labels" | "fix_reports"> & {
          labels: string;
          remote_labels: string | null;
        }
      >;

      const reports = getFixReportsForSubmissionsSync(rawRows.map((r) => r.id));
      const submissions: IssueTrackingOverviewRow[] = rawRows.map((r) => ({
        ...r,
        labels: parseJsonArray(r.labels),
        remote_labels: parseJsonArray(r.remote_labels),
        fix_reports: reports.get(r.id) ?? [],
      }));
      return { counts, submissions };
    },

    // v1's record_issue_action (database.py:935) — same rationale as
    // recordIssueSubmission: the chat history only ever shows the
    // confirmation card live, never the real tracker outcome.
    recordIssueAction(fields: RecordIssueActionFields): number {
      const now = pyLocalIsoNow();
      const res = db
        .prepare(
          "INSERT INTO issue_actions " +
            "(session_id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, applied_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          fields.sessionId,
          fields.repoId,
          fields.userId,
          fields.issueNumber,
          fields.action,
          fields.comment,
          fields.issueUrl ?? null,
          fields.draftToolUseId ?? null,
          now
        );
      return Number(res.lastInsertRowid);
    },

    // Codex full-repo review (2026-07-14, Warning): comment/close/reopen
    // had zero idempotency — applyRepoIssueAction (a real POST to
    // GitHub/GitLab) ran unconditionally before this row was ever
    // recorded, so a double-click posted the same comment twice on the
    // tracker. Same claim-before-the-real-call shape as
    // claimDraftSubmission: this INSERT (via the unique index on
    // draft_tool_use_id) is the atomic decision point. `pending` marks a
    // row as claimed-but-not-yet-confirmed — issue_url can legitimately be
    // NULL even on a SUCCESSFUL action (a comment-only GitLab action whose
    // post-action re-fetch fails), so unlike issue_submissions'
    // issue_number, issue_url can't double as the "still pending" signal.
    claimDraftAction(fields: ClaimDraftActionFields, retrying = false): ClaimDraftActionResult {
      const now = pyLocalIsoNow();
      const claimExpiresAt = Date.now() + CLAIM_TTL_MS;
      try {
        const res = db
          .prepare(
            "INSERT INTO issue_actions " +
              "(session_id, repo_id, user_id, issue_number, action, comment, draft_tool_use_id, applied_at, pending, claim_expires_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"
          )
          .run(
            fields.sessionId,
            fields.repoId,
            fields.userId,
            fields.issueNumber,
            fields.action,
            fields.comment,
            fields.draftToolUseId,
            now,
            claimExpiresAt
          );
        return { claimed: true, id: Number(res.lastInsertRowid) };
      } catch (err) {
        if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
          const row = db
            .prepare(
              `SELECT id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, applied_at,
                      pending, claim_expires_at
               FROM issue_actions WHERE draft_tool_use_id = ?`
            )
            .get(fields.draftToolUseId) as
            | (IssueActionRow & { pending: number; claim_expires_at: number | null })
            | undefined;
          if (!row) throw err;
          if (
            !retrying &&
            row.pending === 1 &&
            row.claim_expires_at !== null &&
            row.claim_expires_at < Date.now()
          ) {
            const txn = db.transaction(() => {
              db.prepare("DELETE FROM issue_actions WHERE id = ? AND pending = 1").run(row.id);
            });
            txn();
            return storage.claimDraftAction(fields, true);
          }
          return { claimed: false, existing: row };
        }
        throw err;
      }
    },

    finalizeIssueAction(id: number, fields: FinalizeIssueActionFields): void {
      db.prepare("UPDATE issue_actions SET issue_url = ?, pending = 0, claim_expires_at = NULL WHERE id = ?").run(
        fields.issueUrl,
        id
      );
    },

    // Guarded on pending = 1 so this can never delete a row a concurrent
    // request has since finalized.
    releaseDraftAction(id: number): void {
      db.prepare("DELETE FROM issue_actions WHERE id = ? AND pending = 1").run(id);
    },

    // v1's get_issue_actions_for_session (database.py:955) — used to
    // reconcile historical action cards to their real final state on replay.
    getIssueActionsForSession(sessionId: string): IssueActionRow[] {
      const rows = db
        .prepare(
          `SELECT id, repo_id, user_id, issue_number, action, comment, issue_url, draft_tool_use_id, applied_at
           FROM issue_actions WHERE session_id = ? ORDER BY id`
        )
        .all(sessionId);
      return rows as IssueActionRow[];
    },

    // v1's get_usage_summary (database.py:992) — overall totals across
    // every recorded LLM call.
    getUsageSummary(): UsageSummary {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) as call_count,
             COALESCE(SUM(input_tokens), 0) as total_input_tokens,
             COALESCE(SUM(output_tokens), 0) as total_output_tokens,
             COALESCE(AVG(ttft_ms), 0) as avg_ttft_ms,
             COALESCE(MAX(ttft_ms), 0) as max_ttft_ms,
             COALESCE(AVG(total_ms), 0) as avg_total_ms,
             COALESCE(MAX(total_ms), 0) as max_total_ms
           FROM llm_call_metrics`
        )
        .get();
      return row as UsageSummary;
    },

    // v1's get_usage_by_user (database.py:1011) — LEFT JOIN (not INNER) and
    // grouped by m.user_id (not u.id) so metrics recorded before a user was
    // deleted are still counted here, matching getUsageSummary (no join)
    // and getRecentLlmCalls (LEFT JOIN) instead of silently vanishing from
    // just this one view.
    getUsageByUser(): UsageByUserRow[] {
      const rows = db
        .prepare(
          `SELECT
             m.user_id,
             COALESCE(u.username, '(已删除用户 #' || m.user_id || ')') as username,
             COUNT(m.id) as call_count,
             COALESCE(SUM(m.input_tokens), 0) as total_input_tokens,
             COALESCE(SUM(m.output_tokens), 0) as total_output_tokens,
             COALESCE(AVG(m.ttft_ms), 0) as avg_ttft_ms,
             COALESCE(AVG(m.total_ms), 0) as avg_total_ms
           FROM llm_call_metrics m
           LEFT JOIN users u ON u.id = m.user_id
           GROUP BY m.user_id
           ORDER BY (total_input_tokens + total_output_tokens) DESC`
        )
        .all();
      return rows as UsageByUserRow[];
    },

    // v1's get_message_session_id (database.py:1040) — used to validate
    // feedback targets.
    getMessageSessionId(messageId: number): string | null {
      const row = db.prepare("SELECT session_id FROM messages WHERE id = ?").get(messageId) as
        | { session_id: string }
        | undefined;
      return row?.session_id ?? null;
    },

    // v1's set_message_feedback (database.py:1048) — records a 👍(+1)/👎(-1)
    // on an assistant message; re-rating overwrites (ON CONFLICT upsert,
    // same idiom as grantPermission).
    setMessageFeedback(messageId: number, sessionId: string, userId: number, rating: number): void {
      const now = pyLocalIsoNow();
      db.prepare(
        "INSERT INTO message_feedback (message_id, session_id, user_id, rating, created_at) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(message_id, user_id) DO UPDATE SET rating = excluded.rating, created_at = excluded.created_at"
      ).run(messageId, sessionId, userId, rating, now);
    },

    // v1's get_feedback_for_session (database.py:1061) — this user's
    // ratings in a session, used to restore button state when a session is
    // replayed.
    getFeedbackForSession(sessionId: string, userId: number): Record<number, number> {
      const rows = db
        .prepare("SELECT message_id, rating FROM message_feedback WHERE session_id = ? AND user_id = ?")
        .all(sessionId, userId) as Array<{ message_id: number; rating: number }>;
      const out: Record<number, number> = {};
      for (const r of rows) out[r.message_id] = r.rating;
      return out;
    },

    getFeedbackSummary(): FeedbackSummary {
      const row = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END), 0) as up_count,
             COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) as down_count
           FROM message_feedback`
        )
        .get();
      return row as FeedbackSummary;
    },

    // v1's get_recent_negative_feedback (database.py:1085) — the admin's
    // review queue for answers that missed.
    getRecentNegativeFeedback(limit: number = 20): NegativeFeedbackRow[] {
      const rows = db
        .prepare(
          `SELECT f.message_id, f.session_id, s.title as session_title,
                  f.user_id, u.username, f.created_at
           FROM message_feedback f
           LEFT JOIN users u ON u.id = f.user_id
           LEFT JOIN sessions s ON s.id = f.session_id
           WHERE f.rating < 0
           ORDER BY f.id DESC
           LIMIT ?`
        )
        .all(limit);
      return rows as NegativeFeedbackRow[];
    },

    // v1's get_recent_llm_calls (database.py:1103) — for diagnosing a
    // specific slow session after the fact.
    getRecentLlmCalls(limit: number = 50): RecentLlmCallRow[] {
      const rows = db
        .prepare(
          `SELECT
             m.id, m.session_id, s.title as session_title,
             m.user_id, u.username,
             m.model, m.iteration, m.input_tokens, m.output_tokens,
             m.ttft_ms, m.total_ms, m.created_at
           FROM llm_call_metrics m
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN sessions s ON s.id = m.session_id
           ORDER BY m.id DESC
           LIMIT ?`
        )
        .all(limit);
      return rows as RecentLlmCallRow[];
    },

    // v1's get_semantic_search_stats (database.py:1125) — aggregate
    // recall-quality signal: how many queries ran, how often the top hit
    // was a weak match (top1_score < 0.5), how often nothing came back.
    getSemanticSearchStats(): SemanticSearchStats {
      const summary = db
        .prepare(
          `SELECT
             COUNT(*) as query_count,
             COALESCE(AVG(top1_score), 0) as avg_top1_score,
             COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
             SUM(CASE WHEN top1_score IS NOT NULL AND top1_score < 0.5 THEN 1 ELSE 0 END) as low_score_count,
             SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) as no_result_count
           FROM semantic_search_log`
        )
        .get() as Omit<SemanticSearchStats, "distribution">;
      const distribution = db
        .prepare(
          `SELECT
             SUM(CASE WHEN top1_score IS NULL THEN 1 ELSE 0 END) as bucket_none,
             SUM(CASE WHEN top1_score < 0.3 THEN 1 ELSE 0 END) as bucket_0_3,
             SUM(CASE WHEN top1_score >= 0.3 AND top1_score < 0.5 THEN 1 ELSE 0 END) as bucket_3_5,
             SUM(CASE WHEN top1_score >= 0.5 AND top1_score < 0.7 THEN 1 ELSE 0 END) as bucket_5_7,
             SUM(CASE WHEN top1_score >= 0.7 THEN 1 ELSE 0 END) as bucket_7_10
           FROM semantic_search_log`
        )
        .get() as SemanticSearchStats["distribution"];
      return { ...summary, distribution };
    },

    // v1's get_semantic_search_recent (database.py:1156) — low_score_only
    // filters to top1_score < 0.5 (or no hits at all), the same threshold
    // getSemanticSearchStats uses.
    getSemanticSearchRecent(limit: number = 50, lowScoreOnly: boolean = false): SemanticSearchRecentRow[] {
      const where = lowScoreOnly ? "WHERE l.top1_score IS NULL OR l.top1_score < 0.5" : "";
      const rows = db
        .prepare(
          `SELECT l.id, l.query, l.repo_id, r.name as repo_name, l.result_count,
                  l.top1_score, l.duration_ms, l.created_at,
                  COALESCE(u.username, '(已删除用户 #' || l.user_id || ')') as username
           FROM semantic_search_log l
           LEFT JOIN users u ON u.id = l.user_id
           LEFT JOIN repositories r ON r.id = l.repo_id
           ${where}
           ORDER BY l.id DESC
           LIMIT ?`
        )
        .all(limit);
      return rows as SemanticSearchRecentRow[];
    },

    close(): void {
      db.close();
    },
  };

  return storage;
}
