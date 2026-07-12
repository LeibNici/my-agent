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
// GitLab-vocabulary lookups, no GitHub token or LLM settings involved) —
// unlike semantic-search.ts, there's no module-level SETTINGS singleton
// here.
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef, type ToolContext } from "./registry.js";
import { getActiveRepo } from "./access.js";
import { getRepoLabels, normalizeLabels } from "./issue-tracker-client.js";

const DraftIssueParams = Type.Object({
  title: Type.String(),
  expected_behavior: Type.String(),
  body: Type.String(),
  labels: Type.Optional(Type.Array(Type.String(), { default: ["bug"] })),
});

const DRAFT_ISSUE_DESCRIPTION =
  "Generate an issue draft with title, expected_behavior, body (markdown), and labels. This creates " +
  "a preview for the user to confirm before submission. expected_behavior is a separate REQUIRED field, " +
  "not a section inside body — the confirmation card renders it as its own highlighted block above the " +
  "rest so the user can catch a wrong assumption before submitting, instead of it being buried inside a " +
  "long technical body. State plainly what the correct/expected behavior should be; if you're inferring " +
  "it rather than restating something the user said explicitly, say so (e.g. '推测：...，请确认') so the " +
  "user knows to double-check it rather than rubber-stamp it. Structure body (markdown) for the " +
  "development team with these sections: 问题描述 (what is wrong and how it manifests — the actual/current " +
  "behavior), 复现步骤 (preconditions/data state + steps + any具体单号 the user mentioned — include them " +
  "verbatim), 代码位置 (the specific file/function/line, from your investigation), 影响 (who/what is " +
  "affected), and 修复建议 (a concrete suggested fix — you already did the root-cause analysis, so state " +
  "where and how to change it in words or a few illustrative lines, never a full rewritten file). " +
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
  "usually has it — ask them for it if not, there is no issue-search tool available). action is 'comment' (add a note, issue stays " +
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

registerTool(draftIssueTool);
registerTool(manageIssueTool);
