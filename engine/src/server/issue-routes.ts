// Issue-tracking user-facing routes — submit/action/check-duplicates/mine.
// Port of v1's app/main.py "Issues" section (git show v1-python-final:
// app/main.py, search "==================== Issues ===================="
// through the /api/issues/mine/seen route). Mounted by buildApp
// (src/server/app.ts) the same way admin-routes.ts's mountAdminRoutes is.
//
// /api/feedback lives in app.ts instead of here — it's a session/message
// concept, not an issue-tracker one (matches v1's own file layout: it sits
// under main.py's "Message feedback" section, nowhere near "Issues").
//
// Every route that reaches the tracker (submit/action/check-duplicates)
// MUST read the repo via db.getRepoAdmin/listReposFull/listReposForUserFull
// (the full row, cred_token included) — never db.getRepo/listRepos (the
// client-safe view) — or every tracker call silently authenticates with
// `undefined` forever.
import type { Hono, Context } from "hono";
import { createHash } from "node:crypto";
import type { DbClient } from "../db/client.js";
import type { Env } from "./app.js";
import { userOwnsSession, type CurrentUser } from "./sse.js";
import {
  getRepoLabels,
  normalizeLabels,
  isGithubHosted,
  submitRepoIssue,
  applyRepoIssueAction,
  searchRepoIssues,
  uploadSessionScreenshots,
} from "../tools/issue-tracker-client.js";
import { truncateChars } from "../tools/chunking.js";
import type { FullRepoRow } from "../db/storage.js";
import { pollSubmissionById } from "../issue-tracker.js";

export type IssueRoutesDeps = { db: DbClient };

async function parseBody<T = Record<string, unknown>>(c: Context<Env>): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

// Stable dedupe key for the (rare, legacy) submit path that has a session
// but no real draft_tool_use_id — see /api/issues/submit's effectiveDraftKey.
function sessionKey(sessionId: string, repoId: number, title: string): string {
  return createHash("sha256").update(`${sessionId}:${repoId}:${title}`).digest("hex");
}

// A recheck right after the user's own action should reflect promptly in
// the UI, but must never make the user wait on a slow/stuck tracker API —
// race it against a timeout and let it keep running in the background if
// it's still in flight (its own result still lands in the DB whenever it
// finishes; this just stops blocking the HTTP response). 8s is a starting
// estimate, not empirically tuned.
const ON_DEMAND_POLL_TIMEOUT_MS = 8_000;
async function bestEffortRecheck(pollPromise: Promise<void>): Promise<void> {
  await Promise.race([
    pollPromise.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, ON_DEMAND_POLL_TIMEOUT_MS)),
  ]);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** v1's `_require_repo_write_access` — shared by submit/action, the two
 * routes that write to an external issue tracker (as opposed to the
 * read-only repo browsing every tool goes through). Returns the repo row
 * on success, or the Response to return immediately on failure. */
async function requireRepoWriteAccess(
  c: Context<Env>,
  db: DbClient,
  repoId: number,
  user: CurrentUser,
): Promise<FullRepoRow | Response> {
  const repo = await db.getRepoAdmin(repoId);
  if (!repo) return c.json({ detail: "Repo not found" }, 404);
  if (user.role !== "admin") {
    const userRepos = await db.listReposForUserFull(user.id);
    const perm = userRepos.find((r) => r.id === repoId);
    if (!perm) return c.json({ detail: "Access denied to this repository" }, 403);
    if (perm.access_level !== "write" && perm.access_level !== "admin") {
      return c.json({ detail: "Write access required" }, 403);
    }
  }
  return repo;
}

/** v1's `_require_open_session` — if session_id is given, verify the
 * caller owns it and it isn't already resolved. Shared by submit/action —
 * both close out the session once their tracker write succeeds, so both
 * must refuse to write again against a session already closed that way. */
async function requireOpenSession(
  c: Context<Env>,
  db: DbClient,
  sessionId: string | null,
  user: CurrentUser,
): Promise<Response | null> {
  if (!sessionId) return null;
  const session = await db.getSession(sessionId);
  if (!session || !userOwnsSession(session, user)) {
    return c.json({ detail: "Access denied to this session" }, 403);
  }
  if (session.resolved_at) {
    return c.json(
      {
        detail:
          "This session has already been resolved. Start a new session to submit another issue-tracker action.",
      },
      409,
    );
  }
  return null;
}

/** v1's `_verify_draft_repo_id` — if a draft_tool_use_id is given, confirm
 * `repoId` is the SAME repo draft_issue/manage_issue actually stamped on
 * that draft when it was created. Best-effort in the "can't verify"
 * direction: a missing session/tool_use_id/unparseable stored result never
 * blocks a legitimate submission — only an ACTUAL stamped-repo mismatch
 * does. Reads the raw legacy content shape directly (duck-typed), same
 * rationale as uploadSessionScreenshots — see that function's comment. */
async function verifyDraftRepoId(
  c: Context<Env>,
  db: DbClient,
  sessionId: string | null,
  draftToolUseId: string | null,
  repoId: number,
): Promise<Response | null> {
  if (!sessionId || !draftToolUseId) return null;
  const messages = await db.getMessages(sessionId);
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (
        !isPlainObject(block) ||
        block.type !== "tool_result" ||
        block.tool_use_id !== draftToolUseId
      ) {
        continue;
      }
      const content = block.content;
      if (typeof content === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return null;
        }
        const stampedRepoId = isPlainObject(parsed) ? parsed.repo_id : null;
        if (stampedRepoId !== undefined && stampedRepoId !== null && stampedRepoId !== repoId) {
          return c.json(
            { detail: "提交的仓库与草稿时确认的仓库不一致，请重新生成草稿后再提交。" },
            400,
          );
        }
      }
      // Found the one tool_result block we care about — done either way,
      // matching v1's unconditional `return` right after handling it.
      return null;
    }
  }
  return null;
}

export function mountIssueRoutes(app: Hono<Env>, deps: IssueRoutesDeps): void {
  app.post("/api/issues/submit", async (c) => {
    const user = c.get("user");
    const body = await parseBody<{
      repo_id?: unknown;
      title?: unknown;
      expected_behavior?: unknown;
      body?: unknown;
      labels?: unknown;
      session_id?: unknown;
      draft_tool_use_id?: unknown;
    }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    if (typeof body.repo_id !== "number") return c.json({ detail: "repo_id is required" }, 422);
    if (typeof body.title !== "string" || !body.title) return c.json({ detail: "title is required" }, 422);
    if (typeof body.body !== "string" || !body.body) return c.json({ detail: "body is required" }, 422);
    const expectedBehavior = typeof body.expected_behavior === "string" ? body.expected_behavior : "";
    let labels = Array.isArray(body.labels)
      ? body.labels.filter((l): l is string => typeof l === "string")
      : [];
    const sessionId = typeof body.session_id === "string" ? body.session_id : null;
    const draftToolUseId = typeof body.draft_tool_use_id === "string" ? body.draft_tool_use_id : null;

    const repoOrResp = await requireRepoWriteAccess(c, deps.db, body.repo_id, user);
    if (repoOrResp instanceof Response) return repoOrResp;
    const repo = repoOrResp;

    const sessionResp = await requireOpenSession(c, deps.db, sessionId, user);
    if (sessionResp) return sessionResp;

    const draftResp = await verifyDraftRepoId(c, deps.db, sessionId, draftToolUseId, body.repo_id);
    if (draftResp) return draftResp;

    // Backstop for the draft-time validation in draft_issue: the client
    // sends back the card's labels verbatim, so re-filter against the
    // tracker's vocabulary here too — unknown labels are dropped, never
    // auto-created on the tracker.
    const vocabulary = await getRepoLabels(repo);
    if (vocabulary !== null) {
      labels = normalizeLabels(labels, vocabulary).accepted;
    } else if (!isGithubHosted(repo)) {
      // GitLab governance is unavailable right now (API outage/auth
      // issue, not "no labels configured") — don't pass the model's
      // un-validated free-form labels straight through. GitHub has no
      // equivalent governance at all (getRepoLabels always returns null
      // for it), so its labels pass through untouched either way — this
      // branch must stay GitLab-only, mirroring v1's asymmetry exactly.
      labels = [];
    }

    // The tracker only takes one body string, so the structured
    // expected_behavior field (its own block on the confirmation card,
    // separate from body — see draft_issue) gets folded back in as a
    // leading section here. The tracker records the issue author as the
    // owner of the stored API token, not the platform user who confirmed
    // submission — so stamp the actual reporter into the body too.
    const expectedSection = expectedBehavior.trim() ? `## 期望行为\n\n${expectedBehavior}\n\n` : "";
    const reporterStamp = `\n\n---\n\n**提报人**: ${user.username}（经内部代码助手确认后提交）`;

    // Codex full-repo review (2026-07-14, Warning): a real draftToolUseId is
    // what draft_issue normally always stamps, but a card rendered from a
    // session predating that tracking (dataset.toolUseId missing) can still
    // send draft_tool_use_id: null while session_id IS present — that
    // combination used to skip claiming ENTIRELY and fall straight to
    // "record after the tracker call succeeds", with zero protection
    // against a double-click. Derive a stable key from session+repo+title
    // so the SAME claim/dedupe path covers it too. Known, accepted
    // narrowing: two genuinely different submissions in this one legacy
    // path that happen to share session+repo+title would be treated as one
    // retry of the other — an acceptable trade given the alternative is no
    // protection at all, and this only affects pre-tracking historical
    // cards.
    const effectiveDraftKey =
      draftToolUseId ?? (sessionId ? `synthetic:${sessionKey(sessionId, body.repo_id, body.title)}` : null);

    // Idempotency (QA-reported 2026-07-14, structural fix): claim the draft
    // BEFORE ever calling the tracker, not after. The earlier version did
    // "check getSubmissionByDraftToolUseId, THEN submitRepoIssue, THEN
    // recordIssueSubmission" — a real double-click sent two requests through
    // that check before either's INSERT landed, and both went on to file a
    // real GitHub/GitLab issue even though local bookkeeping never showed a
    // duplicate row. This INSERT (claimDraftSubmission, via the unique index
    // on draft_tool_use_id) is now the single atomic decision point: only
    // one caller can ever win it and proceed to actually file the issue.
    // Claimed with a PLACEHOLDER body (screenshots not uploaded yet) — the
    // screenshot upload below is a real external call with its own cost
    // when done twice, so it's deferred until AFTER a successful claim, and
    // the loser of a race never uploads anything that ends up orphaned on
    // the tracker. Only meaningful when there's a session to attribute the
    // claim row to (session_id is NOT NULL in the schema) — with no session
    // at all there's nothing to dedupe against and this falls through to
    // the direct recordIssueSubmission below, same as before.
    let claimedId: number | null = null;
    if (sessionId && effectiveDraftKey) {
      const claim = await deps.db.claimDraftSubmission({
        sessionId,
        repoId: body.repo_id,
        userId: user.id,
        title: body.title,
        body: `${expectedSection}${body.body}${reporterStamp}`,
        labels,
        draftToolUseId: effectiveDraftKey,
      });
      if (!claim.claimed) {
        if (claim.existing.issue_number !== null) {
          return c.json({
            ok: true,
            issue_number: claim.existing.issue_number,
            issue_url: claim.existing.issue_url,
            already_submitted: true,
          });
        }
        // Another request already claimed this draft and is still filing it
        // (or crashed before finalizing/releasing its claim, in which case
        // claimDraftSubmission's own staleness check will already have
        // reclaimed it — this 409 only fires while that claim is still
        // genuinely live). The client should back off and retry shortly; a
        // subsequent retry finds the finalized result via the branch above
        // once the winning request completes.
        return c.json(
          { detail: "This draft is already being submitted — please wait a moment and retry." },
          409
        );
      }
      claimedId = claim.id;
    }

    // The screenshots the user pasted in chat are the evidence the
    // analysis was based on — attach them to the tracker issue
    // (GitLab-hosted repos only) instead of leaving them stranded in chat
    // history. Deliberately AFTER the claim above (see that comment) so
    // only the winner of a race ever uploads anything.
    const screenshotsSection = await uploadSessionScreenshots(repo, sessionId, deps.db);
    const fullBody = `${expectedSection}${body.body}${screenshotsSection}${reporterStamp}`;

    // Submits against the stored repo URL/credentials (not client-supplied).
    const result = await submitRepoIssue(repo, body.title, fullBody, labels);
    if ("error" in result) {
      // Release the claim on failure so a legitimate retry (the tracker API
      // was down, network blip, etc.) isn't permanently locked out by its
      // own earlier claim — otherwise this draft_tool_use_id stays claimed
      // forever with issue_number still NULL. (claimDraftSubmission's own
      // staleness reclaim is the backstop for a retry that never actually
      // arrives at all — a crash right here, for instance.)
      if (claimedId !== null) await deps.db.releaseDraftSubmission(claimedId);
      return c.json({ detail: result.error }, 502);
    }

    // This is the only place the real submission outcome (issue number,
    // URL, who filed it) is durably recorded — chat history only ever
    // showed the draft card live, and never remembered whether it was
    // actually filed. The session is deliberately left open (no
    // markSessionResolved) — QA-reported (2026-07-13): resolving it here
    // forced every follow-up on the same issue (comment/close/reopen) into
    // a brand-new session with no memory of which issue it was even about.
    let submissionId: number | null = claimedId;
    if (claimedId !== null) {
      await deps.db.finalizeIssueSubmission(claimedId, {
        issueNumber: result.number,
        issueUrl: result.url,
        body: fullBody,
      });
    } else if (sessionId) {
      submissionId = await deps.db.recordIssueSubmission({
        sessionId,
        repoId: body.repo_id,
        userId: user.id,
        title: body.title,
        body: fullBody,
        labels,
        issueNumber: result.number,
        issueUrl: result.url,
        draftToolUseId,
      });
    }
    if (submissionId !== null) {
      // Best-effort, doesn't block the response — reflects the just-filed
      // issue's real tracker state (e.g. auto-labels a bot applied) without
      // waiting for the next 10-minute background poll.
      await bestEffortRecheck(pollSubmissionById(deps.db, submissionId));
    }

    return c.json({ ok: true, issue_number: result.number, issue_url: result.url });
  });

  app.post("/api/issues/action", async (c) => {
    const user = c.get("user");
    const body = await parseBody<{
      repo_id?: unknown;
      issue_number?: unknown;
      action?: unknown;
      comment?: unknown;
      session_id?: unknown;
      draft_tool_use_id?: unknown;
    }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    // Format checks first — 400, no DB/repo access touched yet — matching
    // v1's own explicit validation order (these two are hand-checked in
    // v1's handler body, unlike repo_id/issue_number which Pydantic would
    // reject before the handler even runs).
    if (body.action !== "comment" && body.action !== "close" && body.action !== "reopen") {
      return c.json({ detail: "action must be one of: comment, close, reopen" }, 400);
    }
    if (typeof body.comment !== "string" || !body.comment.trim()) {
      return c.json({ detail: "comment is required" }, 400);
    }
    if (typeof body.repo_id !== "number") return c.json({ detail: "repo_id is required" }, 422);
    if (typeof body.issue_number !== "number") {
      return c.json({ detail: "issue_number is required" }, 422);
    }
    const sessionId = typeof body.session_id === "string" ? body.session_id : null;
    const draftToolUseId = typeof body.draft_tool_use_id === "string" ? body.draft_tool_use_id : null;

    const repoOrResp = await requireRepoWriteAccess(c, deps.db, body.repo_id, user);
    if (repoOrResp instanceof Response) return repoOrResp;
    const repo = repoOrResp;

    const sessionResp = await requireOpenSession(c, deps.db, sessionId, user);
    if (sessionResp) return sessionResp;

    const draftResp = await verifyDraftRepoId(c, deps.db, sessionId, draftToolUseId, body.repo_id);
    if (draftResp) return draftResp;

    const result = await applyRepoIssueAction(repo, body.issue_number, body.action, body.comment);
    if ("error" in result) return c.json({ detail: result.error }, 502);

    if (sessionId) {
      // Session deliberately left open here too — same rationale as
      // /api/issues/submit above: a comment/close/reopen shouldn't force
      // the next message onto a fresh session with no memory of this issue.
      await deps.db.recordIssueAction({
        sessionId,
        repoId: body.repo_id,
        userId: user.id,
        issueNumber: body.issue_number,
        action: body.action,
        comment: body.comment,
        issueUrl: result.url,
        draftToolUseId,
      });
      // Best-effort recheck of whatever submission (if any) this repo+issue
      // number corresponds to — manage_issue can act on an issue CodeAxis
      // never itself filed, so a matching row isn't guaranteed.
      const matching = await deps.db.getSubmissionByIssue(body.repo_id, body.issue_number);
      if (matching) {
        await bestEffortRecheck(pollSubmissionById(deps.db, matching.id));
      }
    }

    return c.json({ ok: true, issue_number: result.number, issue_url: result.url });
  });

  app.post("/api/issues/check-duplicates", async (c) => {
    const user = c.get("user");
    const body = await parseBody<{ repo_id?: unknown; title?: unknown }>(c);
    if (body === null) return c.json({ detail: "Invalid JSON body" }, 422);
    if (typeof body.repo_id !== "number") return c.json({ detail: "repo_id is required" }, 422);
    if (typeof body.title !== "string") return c.json({ detail: "title is required" }, 422);

    const repos =
      user.role === "admin" ? await deps.db.listReposFull() : await deps.db.listReposForUserFull(user.id);
    const repo = repos.find((r) => r.id === body.repo_id);
    if (!repo) return c.json({ detail: "Access denied to this repository" }, 403);

    const query = truncateChars(body.title.trim(), 100);
    if (!query) return c.json({ issues: [] });
    return c.json({ issues: await searchRepoIssues(repo, query, 5) });
  });

  app.get("/api/issues/mine", async (c) => {
    const user = c.get("user");
    return c.json(await deps.db.getMyIssueSubmissions(user.id));
  });

  app.get("/api/issues/mine/unread-count", async (c) => {
    const user = c.get("user");
    return c.json({ count: await deps.db.getMyUnreadIssueCount(user.id) });
  });

  app.post("/api/issues/mine/seen", async (c) => {
    const user = c.get("user");
    await deps.db.markMyIssuesSeen(user.id);
    return c.json({ ok: true });
  });
}
