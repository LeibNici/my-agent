// draft_issue/manage_issue — the tool-facing half of v1's
// app/tools/github_issue.py (git show v1-python-final:app/tools/github_issue.py),
// ported at src/tools/github-issue.ts. The tracker-facing half
// (getRepoLabels/normalizeLabels's own HTTP/cache mechanics, submitRepoIssue,
// applyRepoIssueAction, ...) lives in issue-tracker-client.ts and is tested
// elsewhere — here we mock getRepoLabels entirely (as a module mock) so these
// tests exercise ONLY draft_issue/manage_issue's own branching: active-repo
// resolution, label-vocabulary degrade paths, and the manage_issue check
// order (action enum -> comment non-empty -> active repo).
//
// normalizeLabels is deliberately kept REAL (not mocked) via importOriginal —
// its accept/reject logic against a controlled vocabulary is exactly what
// draft_issue's label_note behavior depends on, and using the real
// implementation proves the integration rather than asserting against a
// hand-rolled stub of it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { draftIssueTool, manageIssueTool, searchIssuesTool } from "../src/tools/github-issue.js";
import type { ToolContext } from "../src/tools/registry.js";
import type { DbClient } from "../src/db/client.js";
import * as issueTrackerClient from "../src/tools/issue-tracker-client.js";

vi.mock("../src/tools/issue-tracker-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/issue-tracker-client.js")>();
  return { ...actual, getRepoLabels: vi.fn(), searchRepoIssues: vi.fn() };
});
const mockedGetRepoLabels = vi.mocked(issueTrackerClient.getRepoLabels);
const mockedSearchRepoIssues = vi.mocked(issueTrackerClient.searchRepoIssues);

beforeEach(() => {
  // vitest doesn't auto-reset mocks between tests (no clearMocks/mockReset in
  // vitest.config.ts) — each test sets its own resolved/rejected value, so a
  // stale implementation from a previous test must not leak forward.
  mockedGetRepoLabels.mockReset();
  mockedSearchRepoIssues.mockReset();
});

const repoA = { id: 1, name: "repo-a", localPath: "/repos/repo-a" };
const repoB = { id: 2, name: "repo-b", localPath: "/repos/repo-b" };

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    allowedRepoPaths: [],
    unsyncedRepoNames: [],
    userId: null,
    ...overrides,
  };
}

/** draftIssueExecute's only call on ctx.db is getRepoAdmin(id) — confirmed by
 * reading the source — so a minimal fake standing in for the whole DbClient
 * is enough; the resolved repo's shape doesn't matter since getRepoLabels
 * (the only thing that would inspect it) is itself mocked below. */
function makeDb(): DbClient {
  return { getRepoAdmin: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as DbClient;
}

describe("draftIssueTool (name draft_issue)", () => {
  const baseInput = {
    title: "MES 提交按钮点击无响应",
    expected_behavior: "点击提交后应保存工单并跳转到列表页",
    body: "## 问题描述\n点击提交按钮没有任何反应，控制台报 500。",
  };

  it("is registered under the name draft_issue", () => {
    expect(draftIssueTool.name).toBe("draft_issue");
  });

  describe("no unambiguous active repo", () => {
    it("0 granted repos -> {error} JSON mentioning Workspace selection, not an issue_draft shape", async () => {
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["bug"] },
        makeCtx({ grantedRepos: [] }),
      );
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({
        error:
          "无法确定 issue 的目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，然后重新描述问题或让你重新生成草稿。",
      });
    });

    it("2+ granted repos (ambiguous) -> the same {error} JSON, not an issue_draft shape", async () => {
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["bug"] },
        makeCtx({ grantedRepos: [repoA, repoB] }),
      );
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({
        error:
          "无法确定 issue 的目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，然后重新描述问题或让你重新生成草稿。",
      });
    });

    it("resolves (never throws) even with no ctx.db and no active repo", async () => {
      await expect(
        draftIssueTool.execute(baseInput, makeCtx({ grantedRepos: [] })),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe("exactly one active repo, ctx.db present, vocabulary available", () => {
    const vocabulary = ["type::bug", "type::feature", "module::MES"];

    it("echoes title/expected_behavior/body verbatim, stamps repo_id/repo_name, applies accepted labels, and OMITS label_note when nothing was rejected", async () => {
      mockedGetRepoLabels.mockResolvedValue(vocabulary);
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["type::bug", "module::MES"] },
        makeCtx({ grantedRepos: [repoA], db: makeDb() }),
      );
      const parsed = JSON.parse(result);
      // Full-shape equality: also proves label_note is genuinely ABSENT (no
      // key at all), not present-as-null/empty — toEqual would fail on an
      // unexpected extra key.
      expect(parsed).toEqual({
        type: "issue_draft",
        title: baseInput.title,
        expected_behavior: baseInput.expected_behavior,
        body: baseInput.body,
        labels: ["type::bug", "module::MES"],
        repo_id: repoA.id,
        repo_name: repoA.name,
      });
    });

    it("rejects an unknown label and reports it by name in label_note (real normalizeLabels accept/reject logic)", async () => {
      mockedGetRepoLabels.mockResolvedValue(vocabulary);
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["bug", "module::MES", "urgent"] },
        makeCtx({ grantedRepos: [repoA], db: makeDb() }),
      );
      const parsed = JSON.parse(result);
      // Verified by hand against normalizeLabels' own logic (case-insensitive
      // exact match, then unique scoped-suffix match):
      //  - "bug" has no exact full-name match in the vocabulary, but uniquely
      //    suffix-matches "type::bug" (the only available label whose "::"
      //    suffix is "bug") -> accepted as "type::bug".
      //  - "module::MES" matches its own lowercased key exactly -> accepted
      //    as "module::MES".
      //  - "urgent" matches neither an exact name nor any suffix -> rejected.
      expect(parsed.labels).toEqual(["type::bug", "module::MES"]);
      expect(parsed.label_note).toEqual(expect.stringContaining("urgent"));
    });
  });

  describe("vocabulary unavailable (getRepoLabels -> null, e.g. a real fetch failure/API outage — both GitHub and GitLab can genuinely fetch a vocabulary as of the 2026-07-14 production QA fix, so this is no longer GitHub-specific)", () => {
    it("passes labels through UNCHANGED from the input and omits label_note", async () => {
      mockedGetRepoLabels.mockResolvedValue(null);
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["made-up-label", "another"] },
        makeCtx({ grantedRepos: [repoA], db: makeDb() }),
      );
      const parsed = JSON.parse(result);
      expect(parsed.labels).toEqual(["made-up-label", "another"]);
      expect(parsed).not.toHaveProperty("label_note");
    });

    it("defaults to ['bug'] when no labels were given at all, and omits label_note", async () => {
      mockedGetRepoLabels.mockResolvedValue(null);
      const result = await draftIssueTool.execute(
        baseInput, // no `labels` key at all
        makeCtx({ grantedRepos: [repoA], db: makeDb() }),
      );
      const parsed = JSON.parse(result);
      expect(parsed.labels).toEqual(["bug"]);
      expect(parsed).not.toHaveProperty("label_note");
    });
  });

  describe("getRepoLabels throws", () => {
    it("degrades silently to labels-as-given / no label_note", async () => {
      mockedGetRepoLabels.mockRejectedValue(new Error("network boom"));
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["foo", "bar"] },
        makeCtx({ grantedRepos: [repoA], db: makeDb() }),
      );
      const parsed = JSON.parse(result);
      expect(parsed.labels).toEqual(["foo", "bar"]);
      expect(parsed).not.toHaveProperty("label_note");
    });

    it("never propagates the exception out of execute() — always resolves to a string", async () => {
      mockedGetRepoLabels.mockRejectedValue(new Error("boom"));
      await expect(
        draftIssueTool.execute(
          { ...baseInput, labels: ["foo"] },
          makeCtx({ grantedRepos: [repoA], db: makeDb() }),
        ),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe("ctx.db absent entirely", () => {
    it("never calls getRepoLabels, and degrades to labels-as-given / no label_note", async () => {
      const result = await draftIssueTool.execute(
        { ...baseInput, labels: ["foo", "bar"] },
        makeCtx({ grantedRepos: [repoA] }), // no `db` key at all
      );
      const parsed = JSON.parse(result);
      expect(parsed.labels).toEqual(["foo", "bar"]);
      expect(parsed).not.toHaveProperty("label_note");
      expect(mockedGetRepoLabels).not.toHaveBeenCalled();
    });
  });
});

describe("manageIssueTool (name manage_issue)", () => {
  const activeCtx = makeCtx({ grantedRepos: [repoA] });
  const noRepoCtx = makeCtx({ grantedRepos: [] });
  const ambiguousRepoCtx = makeCtx({ grantedRepos: [repoA, repoB] });

  it("is registered under the name manage_issue", () => {
    expect(manageIssueTool.name).toBe("manage_issue");
  });

  it("an out-of-enum action is rejected BEFORE the comment/active-repo checks (empty comment + no active repo still yields THIS error)", async () => {
    const result = await manageIssueTool.execute(
      { issue_number: 42, action: "delete", comment: "" },
      noRepoCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      error: "Invalid action 'delete' — must be one of: comment, close, reopen",
    });
  });

  it("an empty/whitespace-only comment is rejected BEFORE the active-repo check (valid action + no active repo still yields THIS error)", async () => {
    const result = await manageIssueTool.execute(
      { issue_number: 42, action: "comment", comment: "   " },
      noRepoCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      error: "comment is required — explain why this issue is being commented on/closed/reopened",
    });
  });

  it("valid action + non-empty comment + 0 granted repos -> {error} about not being able to determine the target repo", async () => {
    const result = await manageIssueTool.execute(
      { issue_number: 42, action: "comment", comment: "之前理解有误，实际上是配置问题" },
      noRepoCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      error:
        "无法确定目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，再执行该操作。",
    });
  });

  it("valid action + non-empty comment + 2+ granted repos (ambiguous) -> the same target-repo {error}", async () => {
    const result = await manageIssueTool.execute(
      { issue_number: 42, action: "comment", comment: "之前理解有误，实际上是配置问题" },
      ambiguousRepoCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      error:
        "无法确定目标仓库：当前可见多个仓库且本轮未选择工作空间。请提醒用户先在左侧 Workspace 中选择目标仓库，再执行该操作。",
    });
  });

  it.each(["comment", "close", "reopen"] as const)(
    "action='%s': exactly one active repo -> issue_action_draft matching input + active repo exactly",
    async (action) => {
      const result = await manageIssueTool.execute(
        { issue_number: 777, action, comment: "之前理解有误，实际上是配置问题" },
        activeCtx,
      );
      const parsed = JSON.parse(result);
      expect(parsed).toEqual({
        type: "issue_action_draft",
        issue_number: 777,
        action,
        comment: "之前理解有误，实际上是配置问题",
        repo_id: repoA.id,
        repo_name: repoA.name,
      });
    },
  );
});

// 2026-07-15: search_repo_issues — makes the same title/keyword search the
// frontend's pre-submit duplicate-check UI already called (POST
// /api/issues/check-duplicates) available to the agent itself, so it can
// check for a related/conflicting issue before drafting instead of that
// only ever surfacing to a human after the fact.
describe("searchIssuesTool (name search_repo_issues)", () => {
  const activeCtx = makeCtx({ grantedRepos: [repoA], db: makeDb() });
  const noRepoCtx = makeCtx({ grantedRepos: [] });
  const ambiguousRepoCtx = makeCtx({ grantedRepos: [repoA, repoB] });

  it("is registered under the name search_repo_issues", () => {
    expect(searchIssuesTool.name).toBe("search_repo_issues");
  });

  it("0 granted repos -> workspace-selection error, never calls searchRepoIssues", async () => {
    const result = await searchIssuesTool.execute({ query: "collectChunks" }, noRepoCtx);
    expect(result).toContain("无法确定目标仓库");
    expect(mockedSearchRepoIssues).not.toHaveBeenCalled();
  });

  it("2+ granted repos (ambiguous) -> the same workspace-selection error", async () => {
    const result = await searchIssuesTool.execute({ query: "collectChunks" }, ambiguousRepoCtx);
    expect(result).toContain("无法确定目标仓库");
    expect(mockedSearchRepoIssues).not.toHaveBeenCalled();
  });

  it("ctx.db absent entirely -> its own error, never calls searchRepoIssues", async () => {
    const result = await searchIssuesTool.execute(
      { query: "collectChunks" },
      makeCtx({ grantedRepos: [repoA] }), // no db field
    );
    expect(result).toContain("没有可用的数据库连接");
    expect(mockedSearchRepoIssues).not.toHaveBeenCalled();
  });

  it("ctx.db.getRepoAdmin resolves null (repo row missing) -> its own error", async () => {
    const db = { getRepoAdmin: vi.fn().mockResolvedValue(null) } as unknown as DbClient;
    const result = await searchIssuesTool.execute({ query: "collectChunks" }, makeCtx({ grantedRepos: [repoA], db }));
    expect(result).toContain("找不到仓库配置");
    expect(mockedSearchRepoIssues).not.toHaveBeenCalled();
  });

  it("no hits -> a plain 'not found' message mentioning the query, not an empty string", async () => {
    mockedSearchRepoIssues.mockResolvedValue([]);
    const result = await searchIssuesTool.execute({ query: "不存在的东西" }, activeCtx);
    expect(result).toBe('没有找到与"不存在的东西"相关的 issue。');
  });

  it("hits -> each formatted as '#number [state] title' + url, in the order returned", async () => {
    mockedSearchRepoIssues.mockResolvedValue([
      { number: 12, title: "删除 collectChunks 里的旧截断逻辑", url: "https://example.com/issues/12", state: "closed" },
      { number: 34, title: "collectChunks 支持按类型配额", url: "https://example.com/issues/34", state: "open" },
    ]);
    const result = await searchIssuesTool.execute({ query: "collectChunks" }, activeCtx);
    expect(result).toBe(
      "#12 [closed] 删除 collectChunks 里的旧截断逻辑\nhttps://example.com/issues/12\n\n" +
        "#34 [open] collectChunks 支持按类型配额\nhttps://example.com/issues/34",
    );
  });

  it("passes query/limit through to searchRepoIssues, defaulting limit to 10 when omitted", async () => {
    mockedSearchRepoIssues.mockResolvedValue([]);
    await searchIssuesTool.execute({ query: "collectChunks" }, activeCtx);
    expect(mockedSearchRepoIssues).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "collectChunks", 10);

    mockedSearchRepoIssues.mockClear();
    await searchIssuesTool.execute({ query: "collectChunks", limit: 3 }, activeCtx);
    expect(mockedSearchRepoIssues).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "collectChunks", 3);
  });
});
