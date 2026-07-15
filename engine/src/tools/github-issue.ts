// Issue tools — draft_issue/manage_issue, port of v1's app/tools/
// github_issue.py's tool-facing half (git show v1-python-final:
// app/tools/github_issue.py). The tracker-facing half (HTTP calls to
// GitHub/GitLab) lives in issue-tracker-client.ts, shared with
// issue-routes.ts and issue-tracker.ts's poller.
//
// v1 resolved "which repo is this issue about" from an AsyncLocalStorage
// ContextVar (tool_context.get()["active_repo"]); v2 gets the same value
// explicitly via ToolContext.grantedRepos + access.ts's getActiveRepo — see
// that function's own comment for why "exactly one visible repo" is the
// only unambiguous case.
//
// Neither tool needs Settings (getRepoLabels/normalizeLabels are pure
// tracker-vocabulary lookups — GitHub and GitLab both, as of the 2026-07-14
// production QA fix; see issue-tracker-client.ts's getRepoLabels — no LLM
// settings involved) — unlike semantic-search.ts, there's no module-level
// SETTINGS singleton here.
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef, type ToolContext } from "./registry.js";
import { getActiveRepo } from "./access.js";
import { getRepoLabels, normalizeLabels, searchRepoIssues } from "./issue-tracker-client.js";

const DraftIssueParams = Type.Object({
  title: Type.String(),
  expected_behavior: Type.String(),
  body: Type.String(),
  labels: Type.Optional(Type.Array(Type.String(), { default: ["bug"] })),
});

const DRAFT_ISSUE_DESCRIPTION =
  "Generate an issue draft with title, expected_behavior, body (markdown), and labels. This creates " +
  "a preview for the user to confirm before submission. Call this tool directly using the investigation " +
  "and conclusions you ALREADY established earlier in this conversation — do NOT call semantic_search/" +
  "code_search/file_reader/list_directory again first just to re-confirm what you already found; call " +
  "any of those four again only if the user's latest message raises something genuinely not yet covered. " +
  "Redoing an investigation that already reached a clear conclusion just delays the draft for no benefit. " +
  "The conditional analogous-site code_search described below, and search_repo_issues's own stale-premise " +
  "check further down, are both separate from this rule — each has its own trigger condition and doesn't " +
  "require new information from the user. " +
  "That said, 'already established' means grounded in code you actually read THIS conversation, not an " +
  "assumption carried over from earlier chat history or the user's phrasing — if the draft hinges on a " +
  "specific method/function/file still behaving a certain way, make sure your own investigation actually " +
  "confirmed it's still there and still does that, since another change could have already altered or " +
  "removed it. When the target method/file plausibly has related history (recently touched, or the user's " +
  "description sounds like it follows on from other work), a quick search_repo_issues call for that method/" +
  "file name is worth the one extra tool call — mention what you find in the body (e.g. 'relates to #12, " +
  "which removed this method — confirm the request below still applies') rather than drafting past it " +
  "silently. Not required for routine issues with no such signal — use judgment, don't search reflexively. " +
  "After the root cause is confirmed, reuse any equivalent repository-wide code_search results already " +
  "obtained in THIS conversation. Otherwise, make exactly ONE additional repository-wide code_search for " +
  "analogous sites, and only when the confirmed root cause itself is a repeatable call or implementation " +
  "pattern with a concrete reason to expect it recurs elsewhere — e.g. the same function used through the " +
  "same incorrect calling convention in multiple places, or the same faulty logic copied across files. " +
  "Do not run this scan for an isolated configuration error, a typo, a bad literal, or any other one-off " +
  "mistake, and do not treat the mere existence of multiple callers as evidence of a pattern by itself. " +
  "For a call-pattern issue, search the shared symbol name; for duplicated logic, use one distinctive " +
  "shared literal. Do not retry with alternate queries or run a second code_search solely to widen impact " +
  "scope. search_repo_issues stays a separate tracker-history check for a stale premise — do not use it " +
  "for this code scan, and do not trigger it merely because this scan ran. " +
  "Use that single result set for both the analogous-issue and candidate-impact reporting — do not search " +
  "twice for two purposes. If the scan ran, add a 同类问题排查 section to body and split its entries into " +
  "已确认同类问题 (only when code you actually read THIS conversation shows the same failure pattern, not " +
  "just a text match) and 疑似同类问题 (a plausible match the available evidence doesn't establish — write " +
  "these using '推测：...，请确认'). Add a separate 候选影响范围/关联调用 section for other results from " +
  "that same search — other call sites of the shared symbol, or other locations containing the shared " +
  "literal — whose read context shows they do NOT reproduce the bug — keep the three buckets mutually " +
  "exclusive, never promote a bare text/symbol-name hit to 已确认. That section must " +
  "include, verbatim: '这是基于文本搜索的候选清单，不是完整调用图，不能当作详尽的影响分析。' If a bucket " +
  "is empty, say only that the returned results contained no such hit — never claim none exists in the " +
  "repository. If the scan wasn't warranted, omit both sections entirely rather than searching just to " +
  "fill them. " +
  "expected_behavior is a separate REQUIRED field, " +
  "not a section inside body — the confirmation card renders it as its own highlighted block above the " +
  "rest so the user can catch a wrong assumption before submitting, instead of it being buried inside a " +
  "long technical body. State plainly what the correct/expected behavior should be; if you're inferring " +
  "it rather than restating something the user said explicitly, say so (e.g. '推测：...，请确认') so the " +
  "user knows to double-check it rather than rubber-stamp it. " +
  "This same rule applies to every material claim about code or repository behavior anywhere in body — " +
  "current behavior, code location, root cause, analogous occurrences, affected call sites. State it as " +
  "established only when it's backed by something a tool actually returned THIS conversation (cite the " +
  "file/function/line, and a short excerpt of the key line when useful); otherwise write it as " +
  "'推测：...，请确认' rather than in a confident tone. User-provided reproduction details (工单号, steps " +
  "they described) may be recorded as-is as what the user reported — that's not a code claim and doesn't " +
  "need this treatment. Structure body (markdown) for the " +
  "development team with these core sections: 问题描述 (what is wrong and how it manifests — the actual/current " +
  "behavior), 复现步骤 (preconditions/data state + steps + any具体单号 the user mentioned — include them " +
  "verbatim), 代码位置 (the specific file/function/line, from your investigation), 影响 (who/what is " +
  "affected), and 修复建议 (a concrete suggested fix — you already did the root-cause analysis, so state " +
  "where and how to change it in words or a few illustrative lines, never a full rewritten file), plus " +
  "同类问题排查 and 候选影响范围/关联调用 when the conditional scan above ran. " +
  "labels must come from the project's EXISTING label vocabulary — pick one type:: label (type::bug / " +
  "type::feature / type::requirement) plus one module:: label (e.g. module::MES, module::APS, module::质量), " +
  "optionally priority::P0-P4. Never invent new labels: anything outside the project vocabulary is " +
  "dropped automatically (the result will carry a label_note telling you what was rejected).";

/** v1's draft_issue. Returns a JSON-encoded `issue_draft` (or `{error}`)
 * payload — execute() must return a string, but the shape underneath is
 * the same dict the frontend's confirmation card already parses (v1's
 * `result["labels"]` was already a JSON array in its OWN output despite
 * the tool's LLM-facing INPUT parameter being a comma-string; the array
 * schema here only changes what the model supplies, not the frontend
 * contract). */
async function draftIssueExecute(
  input: Static<typeof DraftIssueParams>,
  ctx: ToolContext,
): Promise<string> {
  let labelList = input.labels ?? ["bug"];

  // No unambiguous target repo (user has several repos visible and picked
  // no workspace this turn) → refuse rather than emit an unstamped draft
  // whose submission target would silently become "whatever the sidebar
  // happens to be at click time", which can differ from where the
  // analysis actually found the code.
  const activeRepo = getActiveRepo(ctx);
  if (!activeRepo) {
    return JSON.stringify({
      error:
        "无法确定 issue 的目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，然后重新描述问题或让你重新生成草稿。",
    });
  }

  // Validate labels against the tracker's own vocabulary at DRAFT time, so
  // the confirmation card the user reviews already shows the canonical
  // labels and the model gets immediate feedback on anything it invented —
  // rather than the submit endpoint silently filing a degraded issue
  // later. Best-effort: any failure (including the repo read itself, or
  // ctx.db being absent) degrades to "labels as given, no label_note",
  // never a hard error.
  let labelNote: string | undefined;
  if (ctx.db) {
    try {
      const repo = await ctx.db.getRepoAdmin(activeRepo.id);
      const available = repo ? await getRepoLabels(repo) : null;
      if (available !== null) {
        const { accepted, rejected } = normalizeLabels(labelList, available);
        labelList = accepted;
        if (rejected.length > 0) {
          labelNote = `以下标签不在项目标签词表中，已忽略: ${rejected.join(", ")}。如需分类请从项目现有标签中选（type::*/module::*/priority::* 等）。`;
        }
      }
    } catch {
      // vocabulary unavailable — file with the labels as given
    }
  }

  const result: Record<string, unknown> = {
    type: "issue_draft",
    title: input.title,
    expected_behavior: input.expected_behavior,
    body: input.body,
    labels: labelList,
    repo_id: activeRepo.id,
    repo_name: activeRepo.name,
  };
  if (labelNote) result.label_note = labelNote;
  return JSON.stringify(result);
}

export const draftIssueTool: ToolDef<typeof DraftIssueParams> = {
  name: "draft_issue",
  description: DRAFT_ISSUE_DESCRIPTION,
  schema: DraftIssueParams,
  execute: draftIssueExecute,
};

const ManageIssueParams = Type.Object({
  issue_number: Type.Integer(),
  // Deliberately Type.String(), not a literal union of ("comment"|"close"|
  // "reopen") — an out-of-enum value must reach this tool's OWN error text
  // below, not get rejected upstream by pi's own schema validation before
  // the call ever happens (that would surface as a generic schema-mismatch
  // failure instead of the tool's specific, actionable message).
  action: Type.String(),
  comment: Type.String(),
});

const MANAGE_ISSUE_DESCRIPTION =
  "Preview an action on an ALREADY-FILED issue — add a comment, close it, or reopen it. Use this when a " +
  "previously-submitted issue turns out to need correction (the underlying bug/requirement understanding " +
  "was wrong, not just something the LLM misread) or turns out invalid/already-resolved — NOT for " +
  "reporting a new problem, that's draft_issue. Creates a preview card for the user to confirm before " +
  "anything is actually posted to the tracker. issue_number is the tracker's issue number (the user " +
  "usually has it — if not, try search_repo_issues by title first before asking them). action is 'comment' (add a note, issue stays " +
  "open — for a clarification/correction that doesn't change the outcome), 'close' (add the comment then " +
  "close — for invalid/wontfix/already-fixed-elsewhere), or 'reopen' (for a previously-closed issue that " +
  "needs revisiting). comment is REQUIRED for all three: always state plainly why — what was previously " +
  "misunderstood and what's actually true — since whoever reads the tracker later needs that context as " +
  "much as the user confirming now.";

/** v1's manage_issue — a sync function there (no I/O, no tool_context
 * await needed); this port has no real await inside either, but must
 * still be `async` because ToolDef.execute's contract returns
 * Promise<string> (same reason calculator.ts's execute is `async` despite
 * doing no actual asynchronous work). Check order (action enum, then
 * comment non-empty, then active-repo resolution) is copied from v1 as-is. */
async function manageIssueExecute(
  input: Static<typeof ManageIssueParams>,
  ctx: ToolContext,
): Promise<string> {
  if (input.action !== "comment" && input.action !== "close" && input.action !== "reopen") {
    return JSON.stringify({
      error: `Invalid action '${input.action}' — must be one of: comment, close, reopen`,
    });
  }
  if (!input.comment.trim()) {
    return JSON.stringify({
      error: "comment is required — explain why this issue is being commented on/closed/reopened",
    });
  }

  // Same guard as draft_issue: acting on issue N is only meaningful within
  // one specific repo's tracker — an unstamped action card could fire at a
  // same-numbered issue in a different project.
  const activeRepo = getActiveRepo(ctx);
  if (!activeRepo) {
    return JSON.stringify({
      error:
        "无法确定目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，再执行该操作。",
    });
  }

  return JSON.stringify({
    type: "issue_action_draft",
    issue_number: input.issue_number,
    action: input.action,
    comment: input.comment,
    repo_id: activeRepo.id,
    repo_name: activeRepo.name,
  });
}

export const manageIssueTool: ToolDef<typeof ManageIssueParams> = {
  name: "manage_issue",
  description: MANAGE_ISSUE_DESCRIPTION,
  schema: ManageIssueParams,
  execute: manageIssueExecute,
};

// 2026-07-15: searchRepoIssues (issue-tracker-client.ts) already existed —
// title/keyword search against the tracker's own search API — but only the
// frontend's pre-submit duplicate-check UI could call it (POST
// /api/issues/check-duplicates), purely for a human to eyeball. The agent
// itself had no way to check for a related/conflicting issue before
// drafting a new one (see draft_issue's own doc comment on the scenario
// this closes: issue A removes a method, issue B — drafted after, with no
// visibility into A — assumes it still exists). Exposing the same search
// as a real tool lets the agent do that check itself when it judges it's
// worth one extra call, rather than only ever happening after the fact in
// a UI panel the agent never sees the result of.
const SearchIssuesParams = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Integer({ default: 10 })),
});

const SEARCH_ISSUES_DESCRIPTION =
  "Search the active repo's issue tracker by title keywords — use before draft_issue when the target " +
  "method/file plausibly has related history (recently changed, or the request sounds like a follow-on to " +
  "other work), to check for an issue that already touched the same area and might make your current " +
  "premise stale (e.g. a method your draft assumes exists was removed by another issue). Also useful for " +
  "manage_issue when the user doesn't have the issue number handy. Title/keyword matching only, not " +
  "semantic — search short, distinctive terms (a method/file name, not a full sentence). Not required for " +
  "routine issues with no such signal; skip it rather than searching reflexively on every draft.";

async function searchIssuesExecute(
  input: Static<typeof SearchIssuesParams>,
  ctx: ToolContext,
): Promise<string> {
  const activeRepo = getActiveRepo(ctx);
  if (!activeRepo) {
    return "Error: 无法确定目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库。";
  }
  if (!ctx.db) {
    return "Error: 当前上下文没有可用的数据库连接，无法查询仓库凭证。";
  }
  const repo = await ctx.db.getRepoAdmin(activeRepo.id);
  if (!repo) {
    return "Error: 找不到仓库配置。";
  }

  const limit = input.limit ?? 10;
  const hits = await searchRepoIssues(repo, input.query, limit);
  if (hits.length === 0) {
    return `没有找到与"${input.query}"相关的 issue。`;
  }
  return hits.map((h) => `#${h.number} [${h.state}] ${h.title}\n${h.url}`).join("\n\n");
}

export const searchIssuesTool: ToolDef<typeof SearchIssuesParams> = {
  name: "search_repo_issues",
  description: SEARCH_ISSUES_DESCRIPTION,
  schema: SearchIssuesParams,
  execute: searchIssuesExecute,
};

registerTool(draftIssueTool);
registerTool(manageIssueTool);
registerTool(searchIssuesTool);
