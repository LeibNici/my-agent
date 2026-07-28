// Tests for src/tools/issue-tracker-client.ts — port of v1's
// app/tools/github_issue.py (tracker-facing half) + app/main.py's
// _upload_session_screenshots. fetch is mocked via vi.stubGlobal, matching
// test/embedding-client.test.ts's established pattern for this codebase's
// offline test suite (see brief): assert on fetchMock.mock.calls[N] (both
// URL and request-body shape), clean up via vi.unstubAllGlobals().
//
// SSRF: gitlabProjectApiBaseFromRepoUrl reuses repo-sync.ts's validateUrl,
// already exhaustively tested in test/repo-sync.test.ts — only 1-2 smoke
// tests here. "gitlab.example.invalid" is used for happy-path GitLab hosts
// (matching repo-sync.test.ts's own convention: the .invalid TLD is RFC
// 2606-reserved, so it can never resolve to a private address regardless of
// the sandbox's DNS reachability, and a literal loopback IP (127.0.0.1) is
// used for the SSRF-rejected smoke test).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { makeSeededDb } from "./db-fixture.js";
import type { FullRepoRow } from "../src/db/storage.js";
import {
  isGithubHosted,
  parseOwnerRepo,
  githubHeaders,
  gitlabProjectApiBaseFromRepoUrl,
  getRepoLabels,
  isPriorityLabel,
  listPriorityLabels,
  normalizeLabels,
  submitRepoIssue,
  applyRepoIssueAction,
  searchRepoIssues,
  listRepoIssues,
  uploadGitlabAttachment,
  uploadSessionScreenshots,
  buildSessionFileEvidence,
  fetchWithTimeout,
  __internal,
} from "../src/tools/issue-tracker-client.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<FullRepoRow> = {}): FullRepoRow {
  return {
    id: 1,
    name: "widget",
    url: "https://github.com/acme/widget.git",
    description: "",
    branch: null,
    access_level: null,
    cred_username: null,
    cred_token: "ghp_test_token",
    local_path: null,
    created_at: "2026-01-01 00:00:00.000000",
    last_sync_at: null,
    last_sync_status: null,
    last_sync_message: null,
    index_status: null,
    last_sync_sha: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __internal.clearLabelsCache();
});

// ---------------------------------------------------------------------------
// isGithubHosted
// ---------------------------------------------------------------------------

describe("isGithubHosted", () => {
  it("github.com -> true", () => {
    expect(isGithubHosted({ url: "https://github.com/acme/widget" })).toBe(true);
  });
  it("www.github.com -> true", () => {
    expect(isGithubHosted({ url: "https://www.github.com/acme/widget" })).toBe(true);
  });
  it("host 大小写不敏感", () => {
    expect(isGithubHosted({ url: "https://GitHub.COM/acme/widget" })).toBe(true);
  });
  it("gitlab 或其他 host -> false", () => {
    expect(isGithubHosted({ url: "https://gitlab.example.invalid/acme/widget" })).toBe(false);
  });
  it("畸形 URL -> false（safeHostname 吞掉异常）", () => {
    expect(isGithubHosted({ url: "not a url at all" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseOwnerRepo
// ---------------------------------------------------------------------------

describe("parseOwnerRepo", () => {
  it("正常 URL", () => {
    expect(parseOwnerRepo("https://github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("去掉结尾的斜杠", () => {
    expect(parseOwnerRepo("https://github.com/acme/widget/")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("去掉多个结尾斜杠", () => {
    expect(parseOwnerRepo("https://github.com/acme/widget///")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("去掉 .git 后缀", () => {
    expect(parseOwnerRepo("https://github.com/acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
  });
  it("段数不足 -> null", () => {
    expect(parseOwnerRepo("justastring")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// githubHeaders
// ---------------------------------------------------------------------------

describe("githubHeaders", () => {
  it("返回 GitHub v3 认证头", () => {
    expect(githubHeaders("ghp_abc")).toEqual({
      Authorization: "token ghp_abc",
      Accept: "application/vnd.github.v3+json",
    });
  });
});

// ---------------------------------------------------------------------------
// gitlabProjectApiBaseFromRepoUrl
// ---------------------------------------------------------------------------

describe("gitlabProjectApiBaseFromRepoUrl", () => {
  it("没有 credToken -> 报错，base 为 null", async () => {
    const { error, base } = await gitlabProjectApiBaseFromRepoUrl(
      "https://gitlab.example.invalid/acme/widget.git",
      null,
    );
    expect(error).toMatch(/没有配置凭证|no credentials configured/);
    expect(base).toBeNull();
  });

  it("SSRF：内网/回环 host 被拒绝，base 为 null（冒烟测试，完整矩阵见 repo-sync.test.ts）", async () => {
    const { error, base } = await gitlabProjectApiBaseFromRepoUrl("http://127.0.0.1/group/proj.git", "tok");
    expect(error).toMatch(/internal\/private host/);
    expect(base).toBeNull();
  });

  it("合法 URL -> 拼出正确的 base（.git 去掉，路径 URL-encode）", async () => {
    const { error, base } = await gitlabProjectApiBaseFromRepoUrl(
      "https://gitlab.example.invalid/acme/widget.git",
      "tok",
    );
    expect(error).toBeNull();
    expect(base).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget");
  });
});

// ---------------------------------------------------------------------------
// normalizeLabels (pure)
// ---------------------------------------------------------------------------

describe("normalizeLabels", () => {
  it("大小写不敏感的精确匹配", () => {
    expect(normalizeLabels(["Bug"], ["bug", "feature"])).toEqual({ accepted: ["bug"], rejected: [] });
  });

  it("唯一的 scoped-suffix 匹配（'bug' -> 仅有的 'type::bug'）", () => {
    expect(normalizeLabels(["bug"], ["type::bug", "module::MES"])).toEqual({
      accepted: ["type::bug"],
      rejected: [],
    });
  });

  it("有歧义的 suffix 匹配被拒绝（两个标签都以 ::bug 结尾）", () => {
    expect(normalizeLabels(["bug"], ["type::bug", "other::bug"])).toEqual({
      accepted: [],
      rejected: ["bug"],
    });
  });

  it("未知标签（既无精确匹配也无 suffix 匹配）被拒绝", () => {
    expect(normalizeLabels(["nonexistent"], ["bug", "feature"])).toEqual({
      accepted: [],
      rejected: ["nonexistent"],
    });
  });

  it("空白/纯空格标签被静默丢弃（既不 accepted 也不 rejected）", () => {
    expect(normalizeLabels(["", "   ", "bug"], ["bug"])).toEqual({ accepted: ["bug"], rejected: [] });
  });

  it("重复请求同一个标签只在 accepted 里出现一次", () => {
    expect(normalizeLabels(["bug", "Bug", "BUG"], ["bug"])).toEqual({ accepted: ["bug"], rejected: [] });
  });
});

// ---------------------------------------------------------------------------
// isPriorityLabel / listPriorityLabels
// ---------------------------------------------------------------------------

// 这个判定同时决定了 set_priority 的互斥范围（命中的旧标签都会被摘掉），
// 所以"不该命中的别命中"和"该命中的要命中"一样重要。
describe("isPriorityLabel", () => {
  it.each(["P0", "p3", "priority::high", "Priority/Low", "优先级::高", "urgent", "CRITICAL", "紧急"])(
    "'%s' 判定为优先级标签",
    (name) => expect(isPriorityLabel(name)).toBe(true),
  );

  it.each([
    "bug",
    "enhancement",
    "reviewed",
    "tested",
    "hotfix", // 分支命名习惯的流程标签，不是优先级
    "P10", // 两位数字不匹配 ^p\d$，避免误伤 'P10'/'PR' 之类
    "",
    "   ",
  ])("'%s' 不判定为优先级标签", (name) => expect(isPriorityLabel(name)).toBe(false));
});

describe("listPriorityLabels", () => {
  it("按词表原顺序挑出优先级标签，其余全部滤掉", () => {
    // xinhao 项目的真实形态：群组继承来的流程标签 + 项目级新建的 P0-P4
    expect(
      listPriorityLabels(["bugfix", "confirmed", "P0", "document", "P1", "P2", "reviewed"]),
    ).toEqual(["P0", "P1", "P2"]);
  });

  it("词表里一个优先级标签都没有 -> []", () => {
    expect(listPriorityLabels(["bug", "enhancement"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRepoLabels
// ---------------------------------------------------------------------------

describe("getRepoLabels", () => {
  // Codex full-repo review (2026-07-14, production QA): label vocabulary
  // fetching used to be GitLab-only by design — getRepoLabels always
  // returned null for a GitHub-hosted repo without ever calling fetch, so
  // an invalid label on a GitHub draft passed through completely
  // unvalidated (confirmed in production: a nonexistent label showed no
  // label_note and was submittable). These tests replace the old
  // "GitHub always short-circuits" expectation with real GitHub Labels
  // API coverage, mirroring the GitLab tests below.
  it("github 托管的仓库真的调用 GitHub Labels API，返回真实标签词表", async () => {
    const repo = makeRepo({ id: 601, url: "https://github.com/acme/widget.git", cred_token: "ghp_test_token" });
    const names = ["bug", "type::bug", "module::MES"];
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => names.map((name) => ({ name })),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRepoLabels(repo);
    expect(result).toEqual(names);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.github.com/repos/acme/widget/labels?per_page=100&page=1");
    expect(init.headers.Authorization).toBe("token ghp_test_token");
  });

  it("github 分页：第一页恰好 100 条时继续拉第二页，并拼接全部标签名", async () => {
    const repo = makeRepo({ id: 6011, url: "https://github.com/acme/widget.git", cred_token: "ghp_test_token" });
    const page1 = Array.from({ length: 100 }, (_, i) => `label-${i}`);
    const page2 = ["extra-0", "extra-1"];
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const names = page === 1 ? page1 : page2;
      return { status: 200, json: async () => names.map((name) => ({ name })) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRepoLabels(repo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([...page1, ...page2]);
  });

  it("github 仓库没有配置 cred_token -> 直接返回 null，不发任何请求", async () => {
    const repo = makeRepo({ id: 6012, url: "https://github.com/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getRepoLabels(repo);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("github Labels API 非 200 -> null（无历史缓存时）", async () => {
    const repo = makeRepo({ id: 6013, url: "https://github.com/acme/widget.git", cred_token: "ghp_test_token" });
    const fetchMock = vi.fn(async () => ({ status: 404, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getRepoLabels(repo);
    expect(result).toBeNull();
  });

  it("分页：第一页恰好 100 条时继续拉第二页，并拼接全部标签名", async () => {
    const repo = makeRepo({ id: 602, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const page1 = Array.from({ length: 100 }, (_, i) => `label-${i}`);
    const page2 = ["extra-0", "extra-1", "extra-2"];
    const fetchMock = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const names = page === 1 ? page1 : page2;
      return { status: 200, json: async () => names.map((name) => ({ name })) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRepoLabels(repo);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual([...page1, ...page2]);
  });

  it("第一页不足 100 条时只请求一次", async () => {
    const repo = makeRepo({ id: 603, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const names = ["bug", "feature", "type::bug"];
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => names.map((name) => ({ name })),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getRepoLabels(repo);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(names);
  });

  it("TTL 窗口内的第二次调用不重新请求；过期后第三次调用重新拉取", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));

    const repo = makeRepo({ id: 604, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      const names = call === 1 ? ["bug", "feature"] : ["bug", "feature", "type::bug"];
      return { status: 200, json: async () => names.map((name) => ({ name })) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRepoLabels(repo);
    expect(first).toEqual(["bug", "feature"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await getRepoLabels(repo); // 还在 TTL 窗口内
    expect(second).toEqual(["bug", "feature"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 没有新请求

    vi.setSystemTime(new Date("2030-01-01T00:10:00.001Z")); // 10 分钟 + 1ms，过期

    const third = await getRepoLabels(repo);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 重新拉取
    expect(third).toEqual(["bug", "feature", "type::bug"]);
  });

  it("无任何历史缓存时请求非 200 -> null", async () => {
    const repo = makeRepo({ id: 605, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getRepoLabels(repo);
    expect(result).toBeNull();
  });

  it("缓存已过期后请求失败 -> 回退到过期前的缓存值，而不是 null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const repo = makeRepo({ id: 606, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });

    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => [{ name: "bug" }, { name: "feature" }],
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRepoLabels(repo);
    expect(first).toEqual(["bug", "feature"]);

    vi.setSystemTime(new Date("2030-01-01T00:10:01.000Z")); // 过期
    fetchMock.mockImplementation(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));

    const second = await getRepoLabels(repo);
    expect(second).toEqual(["bug", "feature"]); // 过期缓存被当作 fallback served，不是 null
  });

  it("成功但返回 0 个标签 -> 不缓存，立即再调用一次仍会重新请求", async () => {
    const repo = makeRepo({ id: 607, url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => [] } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRepoLabels(repo);
    expect(first).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await getRepoLabels(repo);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 没有被跳过，又请求了一次
  });
});

// ---------------------------------------------------------------------------
// submitRepoIssue
// ---------------------------------------------------------------------------

describe("submitRepoIssue", () => {
  it("GitHub: labels 以 JSON 数组形式发送；成功(201) -> success 结果", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ number: 42, html_url: "https://github.com/acme/widget/issues/42", title: "Bug title" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "Bug title", "body text", ["bug", "urgent"]);
    expect(result).toEqual({
      success: true,
      number: 42,
      url: "https://github.com/acme/widget/issues/42",
      title: "Bug title",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/acme/widget/issues");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("token ghp_test_token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.title).toBe("Bug title");
    expect(body.body).toBe("body text");
    expect(Array.isArray(body.labels)).toBe(true); // GitHub: 数组，不是逗号字符串
    expect(body.labels).toEqual(["bug", "urgent"]);
  });

  it("GitHub: 非 201 -> error，带状态码和响应体", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 422,
      json: async () => ({}),
      text: async () => "Validation Failed",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", []);
    expect(result).toEqual({ error: "GitHub API error (422): Validation Failed" });
  });

  it("GitHub: repo 没有 cred_token -> error，且不发请求", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", []);
    expect(result).toEqual({
      error: "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitHub API, not just to clone)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GitLab: labels 以逗号拼接的字符串形式发送（不是数组）；成功(201) -> success 结果", async () => {
    const repo = makeRepo({
      url: "https://gitlab.example.invalid/acme/widget.git",
      cred_token: "glpat_abc",
    });
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ iid: 7, web_url: "https://gitlab.example.invalid/acme/widget/-/issues/7", title: "Bug title" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", ["bug", "urgent"]);
    expect(result).toEqual({
      success: true,
      number: 7,
      url: "https://gitlab.example.invalid/acme/widget/-/issues/7",
      title: "Bug title",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget/issues");
    expect(init.headers["PRIVATE-TOKEN"]).toBe("glpat_abc");
    const body = JSON.parse(init.body as string);
    expect(typeof body.labels).toBe("string"); // GitLab: 逗号拼接的字符串，不是数组
    expect(body.labels).toBe("bug,urgent");
    expect(body.title).toBe("T");
    expect(body.description).toBe("B"); // GitLab 用 description 字段，不是 body
  });

  it("GitLab: 非 201 -> error", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({
      status: 400,
      json: async () => ({}),
      text: async () => "Bad Request",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", []);
    expect(result).toEqual({ error: "GitLab API error (400): Bad Request" });
  });

  it("GitLab: 没有 cred_token -> error，不发请求", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", []);
    expect(result).toEqual({
      error: "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitLab API, not just to clone)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GitLab: SSRF 拒绝的内网 host -> error，不发请求（冒烟测试）", async () => {
    const repo = makeRepo({ url: "http://127.0.0.1/group/proj.git", cred_token: "tok" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitRepoIssue(repo, "T", "B", []);
    expect((result as { error: string }).error).toMatch(/internal\/private host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyRepoIssueAction
// ---------------------------------------------------------------------------

describe("applyRepoIssueAction", () => {
  describe("GitHub", () => {
    it("action=comment：只发一次 comments POST，没有额外的 GET；返回合成的 URL", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn(async () => ({
        status: 201,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response));
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "comment", "clarifying note");

      expect(fetchMock).toHaveBeenCalledTimes(1); // 只有 POST，没有 GET
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.github.com/repos/acme/widget/issues/99/comments");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ body: "clarifying note" });

      expect(result).toEqual({
        success: true,
        number: 99,
        url: "https://github.com/acme/widget/issues/99",
        title: null,
      });
    });

    it("action=comment 但 comment 是空白 -> 跳过 POST，直接返回合成 URL，零请求", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "comment", "   ");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        number: 99,
        url: "https://github.com/acme/widget/issues/99",
        title: null,
      });
    });

    it("comment POST 失败(非 201) -> error，不再往下走", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn(async () => ({
        status: 422,
        json: async () => ({}),
        text: async () => "nope",
      } as unknown as Response));
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "comment", "x");
      expect(result).toEqual({ error: "GitHub comment API error (422): nope" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("action=close：先 POST 评论，再 PATCH state=closed，返回 PATCH 响应里的数据", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({ number: 99, html_url: "https://github.com/acme/widget/issues/99", title: "Fixed already" }),
          text: async () => "",
        } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "close", "resolved, closing");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [patchUrl, patchInit] = fetchMock.mock.calls[1];
      expect(patchUrl).toBe("https://api.github.com/repos/acme/widget/issues/99");
      expect(patchInit.method).toBe("PATCH");
      expect(JSON.parse(patchInit.body as string)).toEqual({ state: "closed" });
      expect(result).toEqual({
        success: true,
        number: 99,
        url: "https://github.com/acme/widget/issues/99",
        title: "Fixed already",
      });
    });

    it("action=reopen：PATCH body 是 state=open", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({ number: 99, html_url: "https://github.com/acme/widget/issues/99", title: "Reopened" }),
          text: async () => "",
        } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      await applyRepoIssueAction(repo, 99, "reopen", "actually still happening");
      const [, patchInit] = fetchMock.mock.calls[1];
      expect(JSON.parse(patchInit.body as string)).toEqual({ state: "open" });
    });

    it("action=close 但 comment 为空 -> 跳过评论 POST，只有一次 PATCH 请求", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn(async () => ({
        status: 200,
        json: async () => ({ number: 99, html_url: "https://github.com/acme/widget/issues/99", title: "Closed" }),
        text: async () => "",
      } as unknown as Response));
      vi.stubGlobal("fetch", fetchMock);

      await applyRepoIssueAction(repo, 99, "close", "");
      expect(fetchMock).toHaveBeenCalledTimes(1); // 只有 PATCH，没有评论 POST
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe("PATCH");
    });

    it("PATCH 失败(非 200) -> error", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 500, json: async () => ({}), text: async () => "server error" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "close", "x");
      expect(result).toEqual({ error: "GitHub update API error (500): server error" });
    });

    // 2026-07-28 set_priority：GitHub 没有 GitLab 的 add_labels/remove_labels
    // 增量参数，只能拆成"POST /labels 加"+"DELETE /labels/{name} 删"两步；
    // 刻意不用 PATCH {labels:[...]} 整体覆盖，那会冲掉并发加上去的别的标签。
    it("action=set_priority：评论 -> GET 现有标签 -> POST 加新的 -> DELETE 摘旧的，不碰无关标签", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({
            number: 99,
            html_url: "https://github.com/acme/widget/issues/99",
            title: "Line down",
            labels: [{ name: "bug" }, { name: "P3" }],
          }),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({ status: 200, json: async () => ([]), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 200, json: async () => ({}), text: async () => "" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "set_priority", "产线停机", "P1");

      expect(fetchMock).toHaveBeenCalledTimes(4);
      const [addUrl, addInit] = fetchMock.mock.calls[2];
      expect(addUrl).toBe("https://api.github.com/repos/acme/widget/issues/99/labels");
      expect(addInit.method).toBe("POST");
      expect(JSON.parse(addInit.body as string)).toEqual({ labels: ["P1"] });
      // 只摘 P3，'bug' 不是优先级标签，必须原样留着
      const [delUrl, delInit] = fetchMock.mock.calls[3];
      expect(delUrl).toBe("https://api.github.com/repos/acme/widget/issues/99/labels/P3");
      expect(delInit.method).toBe("DELETE");

      expect(result).toEqual({
        success: true,
        number: 99,
        url: "https://github.com/acme/widget/issues/99",
        title: "Line down",
      });
    });

    it("set_priority：目标标签已经在 issue 上 -> 跳过 POST，只摘掉别的优先级标签", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({
            number: 99,
            html_url: "https://github.com/acme/widget/issues/99",
            title: "T",
            labels: [{ name: "P1" }, { name: "urgent" }],
          }),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({ status: 200, json: async () => ({}), text: async () => "" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      await applyRepoIssueAction(repo, 99, "set_priority", "x", "P1");
      expect(fetchMock).toHaveBeenCalledTimes(3); // 评论 + GET + 一次 DELETE，没有 POST
      const [delUrl, delInit] = fetchMock.mock.calls[2];
      expect(delInit.method).toBe("DELETE");
      expect(delUrl).toBe("https://api.github.com/repos/acme/widget/issues/99/labels/urgent");
    });

    it("set_priority：DELETE 返回 404（标签已被别人摘掉）视为成功，不当失败处理", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({ number: 99, html_url: "u", title: "T", labels: [{ name: "P3" }] }),
          text: async () => "",
        } as unknown as Response)
        .mockResolvedValueOnce({ status: 200, json: async () => ([]), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 404, json: async () => ({}), text: async () => "Label does not exist" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "set_priority", "x", "P1");
      expect(result).toEqual({ success: true, number: 99, url: "u", title: "T" });
    });

    it("set_priority：读 issue 失败 -> error，标签一个都不动", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 403, json: async () => ({}), text: async () => "forbidden" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "set_priority", "x", "P1");
      expect(result).toEqual({ error: "GitHub issue read API error (403): forbidden" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("repo 没有 cred_token -> error，零请求", async () => {
      const repo = makeRepo({ url: "https://github.com/acme/widget.git", cred_token: null });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 99, "comment", "x");
      expect(result).toEqual({
        error: "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitHub API, not just to clone)",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("GitLab", () => {
    it("action=comment：notes POST 成功后额外发一次 GET 拿最新状态（不同于 GitHub 的合成 URL）", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({ iid: 5, web_url: "https://gitlab.example.invalid/acme/widget/-/issues/5", title: "Real title" }),
          text: async () => "",
        } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "comment", "note text");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [notesUrl, notesInit] = fetchMock.mock.calls[0];
      expect(notesUrl).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget/issues/5/notes");
      expect(notesInit.method).toBe("POST");
      expect(JSON.parse(notesInit.body as string)).toEqual({ body: "note text" });

      const [getUrl] = fetchMock.mock.calls[1];
      expect(getUrl).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget/issues/5");

      expect(result).toEqual({
        success: true,
        number: 5,
        url: "https://gitlab.example.invalid/acme/widget/-/issues/5",
        title: "Real title",
      });
    });

    it("action=comment：notes POST 成功但重新 GET 返回非 200 -> 仍报告 success，用原始 issue_number，url/title 为 null", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 404, json: async () => ({}), text: async () => "not found" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "comment", "note text");
      expect(result).toEqual({ success: true, number: 5, url: null, title: null });
    });

    it("action=comment：notes POST 成功但重新 GET 抛网络异常 -> 异常向上传播（不是 success:true），与非 200 分支不同——faithful port of v1's apply_gitlab_issue_action，重新 GET 那一步没有 try/except 包裹", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockRejectedValueOnce(new Error("ECONNRESET"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(applyRepoIssueAction(repo, 5, "comment", "note text")).rejects.toThrow("ECONNRESET");
    });

    it("notes POST 失败(非 201) -> error，不发 GET", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn(async () => ({
        status: 400,
        json: async () => ({}),
        text: async () => "bad note",
      } as unknown as Response));
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "comment", "x");
      expect(result).toEqual({ error: "GitLab note API error (400): bad note" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("action=close：notes POST + PUT state_event=close，返回 PUT 响应数据", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          json: async () => ({ iid: 5, web_url: "https://gitlab.example.invalid/acme/widget/-/issues/5", title: "Closed title" }),
          text: async () => "",
        } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "close", "resolved");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [putUrl, putInit] = fetchMock.mock.calls[1];
      expect(putUrl).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget/issues/5");
      expect(putInit.method).toBe("PUT");
      expect(JSON.parse(putInit.body as string)).toEqual({ state_event: "close" });
      expect(result).toEqual({
        success: true,
        number: 5,
        url: "https://gitlab.example.invalid/acme/widget/-/issues/5",
        title: "Closed title",
      });
    });

    it("PUT 失败(非 200) -> error", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
      const fetchMock = vi.fn();
      fetchMock
        .mockResolvedValueOnce({ status: 201, json: async () => ({}), text: async () => "" } as unknown as Response)
        .mockResolvedValueOnce({ status: 500, json: async () => ({}), text: async () => "server error" } as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "close", "x");
      expect(result).toEqual({ error: "GitLab update API error (500): server error" });
    });

    it("没有 cred_token -> error，零请求", async () => {
      const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: null });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await applyRepoIssueAction(repo, 5, "comment", "x");
      expect((result as { error: string }).error).toMatch(/no credentials configured/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// searchRepoIssues
// ---------------------------------------------------------------------------

describe("searchRepoIssues", () => {
  it("GitHub: 查询参数是 repo:{owner}/{repo} is:issue {query}", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({
        items: [{ number: 1, title: "Crash on save", html_url: "https://github.com/acme/widget/issues/1", state: "open" }],
      }),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchRepoIssues(repo, "crash", 5);
    expect(result).toEqual([{ number: 1, title: "Crash on save", url: "https://github.com/acme/widget/issues/1", state: "open" }]);

    const [calledUrl] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://api.github.com/search/issues");
    expect(parsed.searchParams.get("q")).toBe("repo:acme/widget is:issue crash");
    expect(parsed.searchParams.get("per_page")).toBe("5");
  });

  it("GitHub: 非 200 -> []", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchRepoIssues(repo, "crash", 5)).toEqual([]);
  });

  it("GitHub: fetch 抛异常 -> 外层 try/catch 兜住，返回 []（不向上传播）", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchRepoIssues(repo, "crash", 5)).resolves.toEqual([]);
  });

  it("GitHub: repo 没有 cred_token -> []，零请求", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchRepoIssues(repo, "crash", 5)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GitLab: 查询参数是 search/in=title/per_page/order_by=updated_at，字段用 iid/web_url 映射", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([
        { iid: 9, title: "Crash on save", web_url: "https://gitlab.example.invalid/acme/widget/-/issues/9", state: "opened" },
      ]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchRepoIssues(repo, "crash", 5);
    expect(result).toEqual([{ number: 9, title: "Crash on save", url: "https://gitlab.example.invalid/acme/widget/-/issues/9", state: "opened" }]);

    const [calledUrl] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.searchParams.get("search")).toBe("crash");
    expect(parsed.searchParams.get("in")).toBe("title");
    expect(parsed.searchParams.get("per_page")).toBe("5");
    expect(parsed.searchParams.get("order_by")).toBe("updated_at");
  });

  it("GitLab: 非 200 -> []", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    expect(await searchRepoIssues(repo, "crash", 5)).toEqual([]);
  });

  it("GitLab: fetch 抛异常 -> []", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchRepoIssues(repo, "crash", 5)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listRepoIssues — issue_embeddings sync job's paginated full-issue-list
// fetch. Unlike searchRepoIssues (title-only, search endpoint), this walks
// /issues directly and needs title+description+state, so the assertions
// below check the request params (state=all, page/per_page) AND the field
// mapping (GitHub body->description, GitLab description passthrough), not
// just the URL shape.
// ---------------------------------------------------------------------------

describe("listRepoIssues", () => {
  it("GitHub: 请求参数是 state=all/page/per_page，字段用 number/body/html_url 映射到 number/description/url", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([
        { number: 5, title: "Crash on save", body: "Steps to repro...", html_url: "https://github.com/acme/widget/issues/5", state: "open" },
      ]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRepoIssues(repo, 2, 50);
    expect(result).toEqual([
      { number: 5, title: "Crash on save", description: "Steps to repro...", url: "https://github.com/acme/widget/issues/5", state: "open" },
    ]);

    const [calledUrl] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://api.github.com/repos/acme/widget/issues");
    expect(parsed.searchParams.get("state")).toBe("all");
    expect(parsed.searchParams.get("page")).toBe("2");
    expect(parsed.searchParams.get("per_page")).toBe("50");
  });

  it("GitHub: body 为 null（issue 没有正文）-> description 是空字符串，不是 'null'", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([{ number: 5, title: "No body", body: null, html_url: "https://github.com/acme/widget/issues/5", state: "open" }]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRepoIssues(repo, 1, 50);
    expect(result[0].description).toBe("");
  });

  it("GitHub: /issues 端点混入的 PR 被过滤掉（pull_request 字段存在即判定）", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([
        { number: 5, title: "Real issue", body: "x", html_url: "https://github.com/acme/widget/issues/5", state: "open" },
        { number: 6, title: "Actually a PR", body: "x", html_url: "https://github.com/acme/widget/pull/6", state: "open", pull_request: { url: "..." } },
      ]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRepoIssues(repo, 1, 50);
    expect(result.map((r) => r.number)).toEqual([5]);
  });

  it("GitHub: 非 200 -> []", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listRepoIssues(repo, 1, 50)).toEqual([]);
  });

  it("GitHub: fetch 抛异常 -> 外层 try/catch 兜住，返回 []", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listRepoIssues(repo, 1, 50)).resolves.toEqual([]);
  });

  it("GitHub: repo 没有 cred_token -> []，零请求", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await listRepoIssues(repo, 1, 50)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GitLab: 请求参数是 state=all/page/per_page/order_by=updated_at，字段用 iid/description/web_url 映射", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([
        { iid: 9, title: "Crash on save", description: "steps...", web_url: "https://gitlab.example.invalid/acme/widget/-/issues/9", state: "opened" },
      ]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRepoIssues(repo, 3, 20);
    expect(result).toEqual([
      { number: 9, title: "Crash on save", description: "steps...", url: "https://gitlab.example.invalid/acme/widget/-/issues/9", state: "opened" },
    ]);

    const [calledUrl] = fetchMock.mock.calls[0];
    const parsed = new URL(calledUrl);
    expect(parsed.searchParams.get("state")).toBe("all");
    expect(parsed.searchParams.get("page")).toBe("3");
    expect(parsed.searchParams.get("per_page")).toBe("20");
    expect(parsed.searchParams.get("order_by")).toBe("updated_at");
  });

  it("GitLab: description 为 null -> 空字符串", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ([{ iid: 9, title: "No description", description: null, web_url: "https://x/9", state: "opened" }]),
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listRepoIssues(repo, 1, 20);
    expect(result[0].description).toBe("");
  });

  it("GitLab: 非 200 -> []", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({ status: 500, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    expect(await listRepoIssues(repo, 1, 20)).toEqual([]);
  });

  it("GitLab: fetch 抛异常 -> []", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listRepoIssues(repo, 1, 20)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// uploadGitlabAttachment
// ---------------------------------------------------------------------------

describe("uploadGitlabAttachment", () => {
  it("成功(201) -> { markdown } 来自响应体的 markdown 字段；请求体是 multipart FormData，带 PRIVATE-TOKEN", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ markdown: "![screenshot-1](https://gitlab.example.invalid/uploads/abc/screenshot-1.png)" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadGitlabAttachment(repo, "screenshot-1.png", Buffer.from("fake png bytes"));
    expect(result).toEqual({ markdown: "![screenshot-1](https://gitlab.example.invalid/uploads/abc/screenshot-1.png)" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gitlab.example.invalid/api/v4/projects/acme%2Fwidget/uploads");
    expect(init.method).toBe("POST");
    expect(init.headers["PRIVATE-TOKEN"]).toBe("tok");
    expect(init.body instanceof FormData).toBe(true);
  });

  it("非 201 -> { error }，包含状态码和截断到 200 字符的响应体", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const longText = "x".repeat(300);
    const fetchMock = vi.fn(async () => ({
      status: 500,
      json: async () => ({}),
      text: async () => longText,
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadGitlabAttachment(repo, "screenshot-1.png", Buffer.from("x"));
    expect(result).toEqual({ error: `GitLab upload API error (500): ${"x".repeat(200)}` });
  });

  it("没有 cred_token -> error，零请求", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadGitlabAttachment(repo, "screenshot-1.png", Buffer.from("x"));
    expect((result as { error: string }).error).toMatch(/no credentials configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// uploadSessionScreenshots — needs a real DbClient (calls db.getMessages)
// ---------------------------------------------------------------------------

describe("uploadSessionScreenshots", () => {
  let dir: string;
  let db: DbClient;

  beforeEach(() => {
    const f = makeSeededDb(); // seeds session "s1"
    dir = f.dir;
    db = createDbClient(f.dbPath);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function imageBlock(base64Data: string, mediaType = "image/png") {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
  }

  it("github 托管的仓库 -> 立即返回空串，零 db 调用、零 fetch 调用", async () => {
    const repo = makeRepo({ url: "https://github.com/acme/widget.git" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const getMessagesSpy = vi.fn(async () => {
      throw new Error("must not be called for a github-hosted repo");
    });
    const fakeDb = { getMessages: getMessagesSpy } as unknown as DbClient;

    const result = await uploadSessionScreenshots(repo, "s1", fakeDb);
    expect(result).toBe("");
    expect(getMessagesSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("会话里没有任何图片 -> 返回空串，不发请求", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    await db.addMessage("s1", "user", [{ type: "text", text: "文字消息，没有截图" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadSessionScreenshots(repo, "s1", db);
    expect(result).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功上传至少一张截图 -> 返回的 markdown 包含 ## 相关截图 标题和上传结果的 markdown", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const img = Buffer.from("screenshot-bytes").toString("base64");
    await db.addMessage("s1", "user", [imageBlock(img)]);
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ markdown: "![screenshot-1](https://gitlab.example.invalid/uploads/abc/screenshot-1.png)" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const md = await uploadSessionScreenshots(repo, "s1", db);
    expect(md).toContain("## 相关截图");
    expect(md).toContain("![screenshot-1](https://gitlab.example.invalid/uploads/abc/screenshot-1.png)");
  });

  it("同一张截图（相同 base64）出现在两条不同消息里 -> 按 sha256 去重，只上传一次", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    const img = Buffer.from("duplicate-screenshot-bytes").toString("base64");
    await db.addMessage("s1", "user", [imageBlock(img)]);
    await db.addMessage("s1", "user", [imageBlock(img)]); // 完全相同的截图再贴一次
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ markdown: "![shot](https://gitlab.example.invalid/uploads/x.png)" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    await uploadSessionScreenshots(repo, "s1", db);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 去重，只上传一次
  });

  it("超过 5 张不同的截图 -> 只上传前 5 张", async () => {
    const repo = makeRepo({ url: "https://gitlab.example.invalid/acme/widget.git", cred_token: "tok" });
    for (let i = 0; i < 7; i++) {
      const img = Buffer.from(`distinct-screenshot-${i}`).toString("base64");
      await db.addMessage("s1", "user", [imageBlock(img)]);
    }
    const fetchMock = vi.fn(async () => ({
      status: 201,
      json: async () => ({ markdown: "![shot](https://gitlab.example.invalid/uploads/x.png)" }),
      text: async () => "",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    await uploadSessionScreenshots(repo, "s1", db);
    expect(fetchMock).toHaveBeenCalledTimes(5); // 封顶在 5 张
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout — redirect SSRF gate (Codex full-repo review, 2026-07-14,
// Warning): fetch's default redirect:"follow" meant a validated GitHub/
// GitLab host could 302 a request to a disallowed internal/private address
// at request time, with nothing re-checking the redirect target's host
// before request headers (including auth) went out to it.
// ---------------------------------------------------------------------------

describe("fetchWithTimeout — redirect 目标重新过 SSRF 校验", () => {
  it("重定向目标是内网地址 -> 拒绝，且从不对重定向目标发起第二次请求", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://gitlab.example.invalid/api") {
        return {
          status: 302,
          headers: { get: (h: string) => (h.toLowerCase() === "location" ? "http://127.0.0.1/internal" : null) },
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url} — redirect target must never be followed`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithTimeout("https://gitlab.example.invalid/api", {}, 5000)
    ).rejects.toThrow(/refused|internal\/private host/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never followed to the internal target
  });

  it("重定向目标是另一个合法公网 host -> 正常跟随并返回最终响应", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://gitlab.example.invalid/api") {
        return {
          status: 301,
          headers: { get: (h: string) => (h.toLowerCase() === "location" ? "https://gitlab.example.invalid/api/v2" : null) },
        } as unknown as Response;
      }
      if (url === "https://gitlab.example.invalid/api/v2") {
        return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithTimeout("https://gitlab.example.invalid/api", {}, 5000);
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非 3xx 响应（如 500）不触发任何重定向校验逻辑，原样返回", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 500,
      headers: { get: () => null },
      text: async () => "boom",
    } as unknown as Response));
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithTimeout("https://gitlab.example.invalid/api", {}, 5000);
    expect(resp.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("重定向链超过上限 -> 拒绝（不会无限跟随）", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return {
        status: 302,
        headers: {
          get: (h: string) =>
            h.toLowerCase() === "location" ? `https://gitlab.example.invalid/hop${calls}` : null,
        },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithTimeout("https://gitlab.example.invalid/api", {}, 5000)).rejects.toThrow(
      /too many redirects/
    );
  });
});

// ---------------------------------------------------------------------------
// buildSessionFileEvidence — embeds the latest file-bearing message's extracted
// text into an issue body (GitHub/GitLab alike, no upload). Needs a real DbClient.
// ---------------------------------------------------------------------------

describe("buildSessionFileEvidence", () => {
  let dir: string;
  let db: DbClient;

  beforeEach(() => {
    const f = makeSeededDb(); // seeds session "s1"
    dir = f.dir;
    db = createDbClient(f.dbPath);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fileBlock(filename: string, extractedText: string, extra: Record<string, unknown> = {}) {
    return {
      type: "file",
      filename,
      source: { type: "base64", media_type: "text/csv", data: "QUFB" },
      extracted_text: extractedText,
      truncated: false,
      ...extra,
    };
  }

  it("no session / no files -> empty string", async () => {
    expect(await buildSessionFileEvidence(null, db)).toBe("");
    await db.addMessage("s1", "user", [{ type: "text", text: "纯文字，无附件" }]);
    expect(await buildSessionFileEvidence("s1", db)).toBe("");
  });

  it("embeds the extracted text under 相关附件内容 in a code fence", async () => {
    await db.addMessage("s1", "user", [fileBlock("orders.csv", "订单号,数量\nA100,3"), { type: "text", text: "看这个" }]);
    const md = await buildSessionFileEvidence("s1", db);
    expect(md).toContain("## 相关附件内容");
    expect(md).toContain("### 附件：orders.csv");
    expect(md).toContain("```\n订单号,数量\nA100,3\n```");
  });

  it("uses ONLY the most recent file-bearing message (relevance decays)", async () => {
    await db.addMessage("s1", "user", [fileBlock("old.csv", "旧数据")]);
    await db.addMessage("s1", "assistant", "分析了旧数据");
    await db.addMessage("s1", "user", [fileBlock("new.csv", "新数据")]);
    const md = await buildSessionFileEvidence("s1", db);
    expect(md).toContain("new.csv");
    expect(md).toContain("新数据");
    expect(md).not.toContain("old.csv");
    expect(md).not.toContain("旧数据");
  });

  it("renders a parse failure as a note, never the raw bytes", async () => {
    await db.addMessage("s1", "user", [fileBlock("broken.xlsx", "", { parse_error: "已损坏", source: { type: "base64", media_type: "x", data: "SECRETBYTES" } })]);
    const md = await buildSessionFileEvidence("s1", db);
    expect(md).toContain("该文件无法解析：已损坏");
    expect(md).not.toContain("SECRETBYTES");
  });

  it("picks a code fence longer than any backtick run in the content (no breakout)", async () => {
    await db.addMessage("s1", "user", [fileBlock("md.txt", "见 ```js\ncode\n``` 示例")]);
    const md = await buildSessionFileEvidence("s1", db);
    expect(md).toContain("````"); // 4-backtick fence wraps content that itself contains ```
    expect(md).toContain("见 ```js\ncode\n``` 示例");
  });
});
