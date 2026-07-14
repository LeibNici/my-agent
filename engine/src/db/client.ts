import { Worker } from "node:worker_threads";
import { once } from "node:events";
import type {
  StoredMessageRow,
  LlmMetricsRow,
  UserRow,
  SessionRow,
  RepoRow,
  FullRepoRow,
  CreateRepoFields,
  UpdateRepoFields,
  PermissionRow,
  RecordSemanticSearchLogRow,
  RecordIssueSubmissionFields,
  ClaimDraftSubmissionFields,
  ClaimDraftSubmissionResult,
  FinalizeIssueSubmissionFields,
  IssueSubmissionRow,
  TrackableSubmissionRow,
  UpdateIssueTrackingFields,
  UpsertFixReportFields,
  UnverifiedFixReportRow,
  MyIssueSubmissionRow,
  IssueTrackingOverview,
  RecordIssueActionFields,
  IssueActionRow,
  ClaimDraftActionFields,
  ClaimDraftActionResult,
  FinalizeIssueActionFields,
  UsageSummary,
  UsageByUserRow,
  FeedbackSummary,
  NegativeFeedbackRow,
  RecentLlmCallRow,
  SemanticSearchStats,
  SemanticSearchRecentRow,
  LlmConfigRow,
  LlmConfigPatch,
  IssueTrackingConfigRow,
  IssueTrackingConfigPatch,
} from "./storage.js";

export type DbClient = {
  getOrCreateAppSecret(name: string): Promise<string>;
  regenerateAppSecret(name: string): Promise<string>;
  getLlmConfig(): Promise<LlmConfigRow | null>;
  setLlmConfig(patch: LlmConfigPatch): Promise<LlmConfigRow>;
  getIssueTrackingConfig(): Promise<IssueTrackingConfigRow | null>;
  setIssueTrackingConfig(patch: IssueTrackingConfigPatch): Promise<IssueTrackingConfigRow>;
  addMessage(sessionId: string, role: string, content: string | unknown[]): Promise<number>;
  getMessages(sessionId: string): Promise<StoredMessageRow[]>;
  getMessagesForTurn(sessionId: string): Promise<StoredMessageRow[]>;
  recordLlmCallMetrics(rows: LlmMetricsRow[]): Promise<void>;
  getUserByUsername(username: string): Promise<UserRow | null>;
  getUserById(userId: number): Promise<UserRow | null>;
  createUser(
    username: string,
    passwordHash: string,
    role?: string,
    mustChangePassword?: boolean
  ): Promise<number>;
  listUsers(): Promise<Omit<UserRow, "password_hash">[]>;
  updateUserPassword(userId: number, passwordHash: string): Promise<void>;
  setUserActive(userId: number, active: boolean): Promise<void>;
  deleteUser(userId: number): Promise<void>;
  createSession(title: string, ownerId: number | null): Promise<string>;
  listSessions(ownerId: number | null): Promise<SessionRow[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  listRepos(): Promise<RepoRow[]>;
  listReposForUser(userId: number): Promise<RepoRow[]>;
  getUserRepos(userId: number): Promise<RepoRow[]>;
  getRepo(repoId: number): Promise<RepoRow | null>;
  getRepoAdmin(repoId: number): Promise<FullRepoRow | null>;
  // Task 8: full-row (local_path-carrying) bulk accessors for the chat
  // route's ToolContext resolution — server-internal only, never wired to
  // a client-facing route (see storage.ts's listReposFull comment).
  listReposFull(): Promise<FullRepoRow[]>;
  listReposForUserFull(userId: number): Promise<FullRepoRow[]>;
  createRepo(fields: CreateRepoFields): Promise<number>;
  updateRepo(repoId: number, fields: UpdateRepoFields): Promise<void>;
  deleteRepo(repoId: number): Promise<void>;
  grantPermission(userId: number, repoId: number, accessLevel: string): Promise<number>;
  revokePermission(userId: number, repoId: number): Promise<void>;
  listPermissions(): Promise<PermissionRow[]>;
  recordSemanticSearchLog(row: RecordSemanticSearchLogRow): Promise<void>;
  markSessionResolved(sessionId: string): Promise<void>;
  recordIssueSubmission(fields: RecordIssueSubmissionFields): Promise<number>;
  claimDraftSubmission(fields: ClaimDraftSubmissionFields): Promise<ClaimDraftSubmissionResult>;
  finalizeIssueSubmission(id: number, fields: FinalizeIssueSubmissionFields): Promise<void>;
  releaseDraftSubmission(id: number): Promise<void>;
  getIssueSubmissionsForSession(sessionId: string): Promise<IssueSubmissionRow[]>;
  getSubmissionByDraftToolUseId(draftToolUseId: string): Promise<IssueSubmissionRow | null>;
  getSubmissionForTracking(id: number): Promise<TrackableSubmissionRow | null>;
  getSubmissionByIssue(repoId: number | null, issueNumber: number): Promise<TrackableSubmissionRow | null>;
  getTrackableSubmissions(): Promise<TrackableSubmissionRow[]>;
  beginPoll(submissionId: number): Promise<number>;
  updateIssueTracking(submissionId: number, fields: UpdateIssueTrackingFields, generation: number): Promise<void>;
  upsertFixReport(fields: UpsertFixReportFields): Promise<number>;
  getUnverifiedFixReports(): Promise<UnverifiedFixReportRow[]>;
  setFixReportVerified(reportId: number, verified: boolean): Promise<void>;
  getMyIssueSubmissions(userId: number, limit?: number): Promise<MyIssueSubmissionRow[]>;
  getMyUnreadIssueCount(userId: number): Promise<number>;
  markMyIssuesSeen(userId: number): Promise<void>;
  getIssueTrackingOverview(limit?: number): Promise<IssueTrackingOverview>;
  recordIssueAction(fields: RecordIssueActionFields): Promise<number>;
  claimDraftAction(fields: ClaimDraftActionFields): Promise<ClaimDraftActionResult>;
  finalizeIssueAction(id: number, fields: FinalizeIssueActionFields): Promise<void>;
  releaseDraftAction(id: number): Promise<void>;
  getIssueActionsForSession(sessionId: string): Promise<IssueActionRow[]>;
  getUsageSummary(): Promise<UsageSummary>;
  getUsageByUser(): Promise<UsageByUserRow[]>;
  getMessageSessionId(messageId: number): Promise<string | null>;
  setMessageFeedback(messageId: number, sessionId: string, userId: number, rating: number): Promise<void>;
  getFeedbackForSession(sessionId: string, userId: number): Promise<Record<number, number>>;
  getFeedbackSummary(): Promise<FeedbackSummary>;
  getRecentNegativeFeedback(limit?: number): Promise<NegativeFeedbackRow[]>;
  getRecentLlmCalls(limit?: number): Promise<RecentLlmCallRow[]>;
  getSemanticSearchStats(): Promise<SemanticSearchStats>;
  getSemanticSearchRecent(limit?: number, lowScoreOnly?: boolean): Promise<SemanticSearchRecentRow[]>;
  close(): Promise<void>;
};

type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

// A stuck worker call used to hang its caller forever — no timeout anywhere
// in this RPC layer. That silently wedged the issue-tracker poll loop in
// production (2026-07-14): periodicTrackingLoop's tick awaits
// pollTrackedIssues before scheduling the next one, so one never-resolving
// db call froze polling for every tracked issue with nothing in the logs.
// 30s mirrors this codebase's GITHUB/GITLAB_MUTATE_TIMEOUT_MS tier — a real
// DB call is milliseconds, so this only ever fires on a genuine stall. What
// exactly stalled the worker thread that long is still unconfirmed — schema.ts
// sets `busy_timeout = 5000`, so plain lock contention should surface as
// SQLITE_BUSY well under 30s, not hang past it. Left uninstrumented for now
// (queue-wait vs. in-worker execution time aren't split anywhere); if this
// fires again, that split is the next thing to add, not a guess here.
const DB_CALL_TIMEOUT_MS = 30_000;

/**
 * 建一个跑在 worker_threads 里的 sqlite storage 客户端：同步的 better-sqlite3 调用
 * 全部下沉到 worker 线程，主线程只拿 Promise，事件循环不被 DB IO 卡住。
 *
 * `new Worker(...)` 生成的是一个全新的 Node worker 线程，不会继承 vitest/tsx 主线程
 * 的 TS 转译，worker.ts 必须自己想办法把 TS 转成可执行代码。真正的入口是
 * worker-bootstrap.mjs（纯 .mjs，免转译）—— 它在 worker 线程内用 tsx 的编程式 API
 * `tsImport()` 手动加载 worker.ts；`execArgv: ["--import", "tsx"]` 这条路我们也试过，
 * 但 tsx 的自动 hook 注册在 worker 线程里被其内部 `isMainThread` 判断跳过了，
 * 只有显式调用 tsImport() 才能绕开，见 worker-bootstrap.mjs 顶部注释。
 */
export function createDbClient(dbPath: string): DbClient {
  const worker = new Worker(new URL("./worker-bootstrap.mjs", import.meta.url), {
    workerData: { dbPath },
  });
  // 一个泄漏的 client（没有在途调用）不该拖着进程不退出，所以默认 unref。但 unref
  // 的 worker 不会被事件循环当作"还有活干"——如果 close() 期间一直不 ref 回来，
  // 主线程可能在 worker 回完最后一条消息之前就判定"没事可做"提前退出（实测在纯
  // tsx 脚本里会触发 Node 的 "unsettled top-level await" 警告，close() 永远不 resolve）。
  // 所以：只要 pending 里有在途调用就 ref，清空回 0 就 unref。
  worker.unref();

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let fatalError: Error | null = null;
  let closePromise: Promise<void> | null = null;
  let exited = false;

  function settle(id: number, fn: (p: Pending) => void): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (pending.size === 0) worker.unref();
    fn(p);
  }

  worker.on("message", (msg: Response) => {
    settle(msg.id, (p) => (msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error))));
  });

  function drainPending(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
    worker.unref();
  }

  worker.on("error", (err) => {
    fatalError = err instanceof Error ? err : new Error(String(err));
    drainPending(fatalError);
  });

  // 常驻 exit 处理器：干净退出不触发 "error"，而 worker 端 close 后 parentPort 已关，
  // 晚到的请求消息被静默丢弃 —— 没有这个 drain，那些调用就永远 pending。
  // （事件监听器本身不计入事件循环的 ref 计数，不会让 unref 失效。）
  worker.on("exit", () => {
    exited = true;
    drainPending(fatalError ?? new Error("db worker exited before responding"));
  });

  // Codex review (2026-07-14, Critical): a bare per-call timeout only frees
  // the ONE caller waiting on it — a genuinely wedged worker thread is still
  // wedged, so every other call already queued (or issued next) pays its own
  // full DB_CALL_TIMEOUT_MS before failing too, degrading a stuck worker into
  // O(pending calls × timeout) instead of failing fast. And close() awaiting
  // the worker's "exit" with no bound of its own could still hang forever
  // past a timed-out close RPC.
  //
  // First timeout poisons the client instead: fatalError is set (so every
  // future call — from this poll loop or any other request in flight —
  // rejects immediately instead of queuing behind a dead worker) and the
  // worker is force-terminated, which reliably fires "exit" and unblocks
  // close()'s wait. Deliberately not auto-respawning a replacement worker
  // here — restarting a live SQLite connection mid-request risks its own
  // correctness issues (in-flight WAL state, a caller mid-retry against the
  // old instance); a poisoned client should surface loudly (500s, failed
  // polls) and let the process supervisor restart the whole process, the
  // same recovery path `worker.on("error")` above already relies on.
  function poisonAfterTimeout(reason: Error): void {
    if (fatalError) return; // already poisoned by this path, "error", or "exit"
    fatalError = reason;
    drainPending(reason);
    worker.terminate().catch(() => {}); // exit handler drains again — harmless no-op once pending is empty
  }

  // send() 是真正投递到 worker 的底层通道；call() 在其上加 closed 拦截。
  // close() 自己的 RPC 必须走 send() 而不是 call()，因为发出它时 closePromise 已置位。
  function send<T>(method: string, args: unknown[]): Promise<T> {
    if (fatalError) {
      return Promise.reject(fatalError);
    }
    if (exited) {
      return Promise.reject(new Error("db worker exited before responding"));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (pending.size === 0) worker.ref();
      // Late response after this fires is dropped silently by settle()'s
      // `if (!p) return` — same "already gone from `pending`" shape as the
      // exit-drain case above, not a new failure mode.
      const timer = setTimeout(() => {
        const err = new Error(`db worker call "${method}" timed out after ${DB_CALL_TIMEOUT_MS}ms`);
        settle(id, (p) => p.reject(err));
        poisonAfterTimeout(err);
      }, DB_CALL_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      // Codex review (2026-07-14, Warning): a synchronously-thrown
      // postMessage (e.g. an unclonable value in `args`) used to leave the
      // pending entry, its timer, and the worker ref alive for the full
      // DB_CALL_TIMEOUT_MS even though the failure is already known — settle
      // immediately instead of waiting out the clock for a call that never
      // actually went out.
      try {
        worker.postMessage({ id, method, args });
      } catch (err) {
        settle(id, (p) => p.reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  function call<T>(method: string, args: unknown[]): Promise<T> {
    if (closePromise) {
      return Promise.reject(new Error("db client is closed"));
    }
    return send<T>(method, args);
  }

  return {
    getOrCreateAppSecret: (name) => call<string>("getOrCreateAppSecret", [name]),
    regenerateAppSecret: (name) => call<string>("regenerateAppSecret", [name]),
    getLlmConfig: () => call<LlmConfigRow | null>("getLlmConfig", []),
    setLlmConfig: (patch) => call<LlmConfigRow>("setLlmConfig", [patch]),
    getIssueTrackingConfig: () => call<IssueTrackingConfigRow | null>("getIssueTrackingConfig", []),
    setIssueTrackingConfig: (patch) => call<IssueTrackingConfigRow>("setIssueTrackingConfig", [patch]),
    addMessage: (sessionId, role, content) => call<number>("addMessage", [sessionId, role, content]),
    getMessages: (sessionId) => call<StoredMessageRow[]>("getMessages", [sessionId]),
    getMessagesForTurn: (sessionId) => call<StoredMessageRow[]>("getMessagesForTurn", [sessionId]),
    recordLlmCallMetrics: (rows) => call<void>("recordLlmCallMetrics", [rows]),
    getUserByUsername: (username) => call<UserRow | null>("getUserByUsername", [username]),
    createUser: (username, passwordHash, role, mustChangePassword) =>
      call<number>("createUser", [username, passwordHash, role, mustChangePassword]),
    getUserById: (userId) => call<UserRow | null>("getUserById", [userId]),
    listUsers: () => call<Omit<UserRow, "password_hash">[]>("listUsers", []),
    updateUserPassword: (userId, passwordHash) =>
      call<void>("updateUserPassword", [userId, passwordHash]),
    setUserActive: (userId, active) => call<void>("setUserActive", [userId, active]),
    deleteUser: (userId) => call<void>("deleteUser", [userId]),
    createSession: (title, ownerId) => call<string>("createSession", [title, ownerId]),
    listSessions: (ownerId) => call<SessionRow[]>("listSessions", [ownerId]),
    getSession: (sessionId) => call<SessionRow | null>("getSession", [sessionId]),
    updateSessionTitle: (sessionId, title) => call<void>("updateSessionTitle", [sessionId, title]),
    deleteSession: (sessionId) => call<void>("deleteSession", [sessionId]),
    listRepos: () => call<RepoRow[]>("listRepos", []),
    listReposForUser: (userId) => call<RepoRow[]>("listReposForUser", [userId]),
    getUserRepos: (userId) => call<RepoRow[]>("getUserRepos", [userId]),
    getRepo: (repoId) => call<RepoRow | null>("getRepo", [repoId]),
    getRepoAdmin: (repoId) => call<FullRepoRow | null>("getRepoAdmin", [repoId]),
    listReposFull: () => call<FullRepoRow[]>("listReposFull", []),
    listReposForUserFull: (userId) => call<FullRepoRow[]>("listReposForUserFull", [userId]),
    createRepo: (fields) => call<number>("createRepo", [fields]),
    updateRepo: (repoId, fields) => call<void>("updateRepo", [repoId, fields]),
    deleteRepo: (repoId) => call<void>("deleteRepo", [repoId]),
    grantPermission: (userId, repoId, accessLevel) =>
      call<number>("grantPermission", [userId, repoId, accessLevel]),
    revokePermission: (userId, repoId) => call<void>("revokePermission", [userId, repoId]),
    listPermissions: () => call<PermissionRow[]>("listPermissions", []),
    recordSemanticSearchLog: (row) => call<void>("recordSemanticSearchLog", [row]),
    markSessionResolved: (sessionId) => call<void>("markSessionResolved", [sessionId]),
    recordIssueSubmission: (fields) => call<number>("recordIssueSubmission", [fields]),
    claimDraftSubmission: (fields) => call<ClaimDraftSubmissionResult>("claimDraftSubmission", [fields]),
    finalizeIssueSubmission: (id, fields) => call<void>("finalizeIssueSubmission", [id, fields]),
    releaseDraftSubmission: (id) => call<void>("releaseDraftSubmission", [id]),
    getIssueSubmissionsForSession: (sessionId) =>
      call<IssueSubmissionRow[]>("getIssueSubmissionsForSession", [sessionId]),
    getSubmissionByDraftToolUseId: (draftToolUseId) =>
      call<IssueSubmissionRow | null>("getSubmissionByDraftToolUseId", [draftToolUseId]),
    getSubmissionForTracking: (id) => call<TrackableSubmissionRow | null>("getSubmissionForTracking", [id]),
    getSubmissionByIssue: (repoId, issueNumber) =>
      call<TrackableSubmissionRow | null>("getSubmissionByIssue", [repoId, issueNumber]),
    getTrackableSubmissions: () => call<TrackableSubmissionRow[]>("getTrackableSubmissions", []),
    beginPoll: (submissionId) => call<number>("beginPoll", [submissionId]),
    updateIssueTracking: (submissionId, fields, generation) =>
      call<void>("updateIssueTracking", [submissionId, fields, generation]),
    upsertFixReport: (fields) => call<number>("upsertFixReport", [fields]),
    getUnverifiedFixReports: () => call<UnverifiedFixReportRow[]>("getUnverifiedFixReports", []),
    setFixReportVerified: (reportId, verified) =>
      call<void>("setFixReportVerified", [reportId, verified]),
    getMyIssueSubmissions: (userId, limit) =>
      call<MyIssueSubmissionRow[]>("getMyIssueSubmissions", [userId, limit]),
    getMyUnreadIssueCount: (userId) => call<number>("getMyUnreadIssueCount", [userId]),
    markMyIssuesSeen: (userId) => call<void>("markMyIssuesSeen", [userId]),
    getIssueTrackingOverview: (limit) => call<IssueTrackingOverview>("getIssueTrackingOverview", [limit]),
    recordIssueAction: (fields) => call<number>("recordIssueAction", [fields]),
    claimDraftAction: (fields) => call<ClaimDraftActionResult>("claimDraftAction", [fields]),
    finalizeIssueAction: (id, fields) => call<void>("finalizeIssueAction", [id, fields]),
    releaseDraftAction: (id) => call<void>("releaseDraftAction", [id]),
    getIssueActionsForSession: (sessionId) =>
      call<IssueActionRow[]>("getIssueActionsForSession", [sessionId]),
    getUsageSummary: () => call<UsageSummary>("getUsageSummary", []),
    getUsageByUser: () => call<UsageByUserRow[]>("getUsageByUser", []),
    getMessageSessionId: (messageId) => call<string | null>("getMessageSessionId", [messageId]),
    setMessageFeedback: (messageId, sessionId, userId, rating) =>
      call<void>("setMessageFeedback", [messageId, sessionId, userId, rating]),
    getFeedbackForSession: (sessionId, userId) =>
      call<Record<number, number>>("getFeedbackForSession", [sessionId, userId]),
    getFeedbackSummary: () => call<FeedbackSummary>("getFeedbackSummary", []),
    getRecentNegativeFeedback: (limit) =>
      call<NegativeFeedbackRow[]>("getRecentNegativeFeedback", [limit]),
    getRecentLlmCalls: (limit) => call<RecentLlmCallRow[]>("getRecentLlmCalls", [limit]),
    getSemanticSearchStats: () => call<SemanticSearchStats>("getSemanticSearchStats", []),
    getSemanticSearchRecent: (limit, lowScoreOnly) =>
      call<SemanticSearchRecentRow[]>("getSemanticSearchRecent", [limit, lowScoreOnly]),
    close: () => {
      // 幂等：第二次及以后的 close() 返回同一个 promise（resolve-as-noop），不再发 RPC。
      if (!closePromise) {
        closePromise = (async () => {
          try {
            await send<void>("close", []);
          } catch {
            // worker 已经 error/exit 也算"关闭完成"—— close() 的职责是确保关了，
            // 不是复述上一次失败；那些失败已经通过各自调用的 reject 传出去了。
          }
          if (!exited) {
            // send() 在收到回复、pending 归零那一刻已经 unref 过 worker 了——但线程
            // 还没真退出（worker 端 parentPort.close() 是异步生效的）。重新 ref 住，
            // 等真正的 "exit" 事件，否则主线程可能在 worker 退出前就"无事可做"先走。
            worker.ref();
            await once(worker, "exit");
            worker.unref();
          }
        })();
      }
      return closePromise;
    },
  };
}
