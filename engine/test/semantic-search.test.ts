// Phase 4b Task 4: semantic-search.ts — cross-repo cosine top-k tool +
// best-effort recall-quality log. Ported from
// v1-python-final:app/tools/semantic_index.py's semantic_search/_log_search.
//
// Real .emb.v1.bin fixtures are written via embed-store.ts's
// writeEmbeddingIndex (Task 1), never hand-crafted bytes — same convention
// as embedding-client.test.ts. The query embedding call is mocked via
// vi.stubGlobal("fetch", ...), also matching embedding-client.test.ts.
//
// __internal.runSemanticSearch takes Settings as an explicit parameter (see
// semantic-search.ts's top-of-file comment on why the module-level SETTINGS
// singleton exists at all) — every behavior test below goes through it
// directly rather than the registered semanticSearchTool.execute, so tests
// never depend on this process's real environment variables.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, type Settings } from "../src/config.js";
import { writeEmbeddingIndex, type EmbeddingIndex } from "../src/tools/embed-store.js";
import { noAccessReason } from "../src/tools/access.js";
import { listTools } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/registry.js";
import type { DbClient } from "../src/db/client.js";
import type { RecordSemanticSearchLogRow } from "../src/db/storage.js";
import { semanticSearchTool, __internal } from "../src/tools/semantic-search.js";
import { __internal as embeddingClientInternal } from "../src/tools/embedding-client.js";

const { runSemanticSearch, repoIdForLog } = __internal;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Record<string, string | undefined> = {}): Settings {
  return loadSettings({
    ANTHROPIC_API_KEY: "llm-key-abc",
    ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    APP_EMBEDDING_API_KEY: "",
    APP_EMBEDDING_MODEL: "text-embedding-v4",
    APP_EMBEDDING_DIMENSIONS: "2",
    ...overrides,
  });
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { allowedRepoPaths: [], unsyncedRepoNames: [], userId: 7, ...overrides };
}

// Codex full-repo review (2026-07-14, Warning): the query path now also
// checks the model-fingerprint sidecar (not just dims) — a raw
// writeEmbeddingIndex call, unlike the real embedAndSaveIndex build path,
// never writes that sidecar on its own, so every fixture in this file must
// seed it too or every "should find a hit" test would silently degrade
// into a false "skipped, no matching model" the moment the guard exists.
// Defaults to the same settings runSemanticSearch is called with in nearly
// every test below (matching APP_EMBEDDING_BASE_URL/MODEL — dims is not
// part of the fingerprint, so the dims-mismatch tests are unaffected by
// using this same default).
function seedIndex(repoPath: string, index: EmbeddingIndex, settings: Settings = makeSettings()): void {
  writeEmbeddingIndex(repoPath, index);
  embeddingClientInternal.writeModelFingerprint(
    repoPath,
    embeddingClientInternal.currentModelFingerprint(settings),
  );
}

function makeQueryFetchMock(embedding: number[], status = 200) {
  return vi.fn(async (_url: string, _init: unknown) => {
    return {
      status,
      json: async () => ({ data: [{ index: 0, embedding }] }),
    } as unknown as Response;
  });
}

let root: string;
let repo1: string;
let repo2: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "semantic-search-"));
  repo1 = join(root, "repo1");
  repo2 = join(root, "repo2");
  mkdirSync(repo1);
  mkdirSync(repo2);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// access denial
// ---------------------------------------------------------------------------

describe("semantic_search — 无仓库权限", () => {
  it("allowedPaths 为空 -> 走 noAccessReason(ctx, 'Error')，不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ allowedRepoPaths: [], unsyncedRepoNames: ["repo-x"] });
    const result = await runSemanticSearch({ query: "不合格评审" }, ctx, makeSettings());
    expect(result).toBe(noAccessReason(ctx, "Error"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// no key configured — v1 degradation message #1, byte-exact
// ---------------------------------------------------------------------------

describe("semantic_search — 未配置 embedding key", () => {
  it("embeddingKeyOrFallback 返回空串 -> v1 原文降级文案，不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com", // host mismatch -> no fallback key
      APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "报工人员姓名显示" }, ctx, settings);
    expect(result).toBe("语义检索未启用（未配置 embedding API key）。请改用 code_search / find_symbol。");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API unavailable — v1 degradation message #... (status-interpolated)
// ---------------------------------------------------------------------------

describe("semantic_search — embedding API 非 200", () => {
  it("query embed 请求返回 500 -> v1 原文降级文案（状态码原样嵌入）", async () => {
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0], 500));
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "任意查询" }, ctx, makeSettings());
    expect(result).toBe("语义检索暂不可用（embedding API 500）。请改用 code_search / find_symbol。");
  });
});

// ---------------------------------------------------------------------------
// no index anywhere — v1 degradation message #2, byte-exact
// ---------------------------------------------------------------------------

describe("semantic_search — 没有任何索引", () => {
  it("有权限、有 key，但没有任何仓库建过索引 -> v1 原文降级文案", async () => {
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const result = await runSemanticSearch({ query: "任意查询" }, ctx, makeSettings());
    expect(result).toBe(
      "语义索引尚未构建（仓库同步后会在后台自动构建，首次需要几分钟）。请先用 code_search / find_symbol。",
    );
  });
});

// ---------------------------------------------------------------------------
// index exists but zero hits — v1 degradation message #3, byte-exact
// ---------------------------------------------------------------------------

describe("semantic_search — 索引存在但零命中", () => {
  it("索引存在但向量数为 0 -> any_index=true 但 hits 为空 -> v1 原文零命中文案", async () => {
    seedIndex(repo1, { dims: 2, vectors: [], meta: [] });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "查无所获" }, ctx, makeSettings());
    expect(result).toBe("没有与「查无所获」语义相近的代码块。换个说法试试，或改用 code_search。");
  });
});

// ---------------------------------------------------------------------------
// dimension mismatch — self-review focus: a repo whose embedding
// model/dims changed since its last build must be SKIPPED, not crash, and
// must not silently poison the merge with wrong-shape vectors.
// ---------------------------------------------------------------------------

describe("semantic_search — 维度不匹配的仓库被跳过", () => {
  it("repo1 索引维度(3)与当前 query 维度(2)不符 -> 被跳过；repo2 维度匹配 -> 仍返回 repo2 的命中", async () => {
    seedIndex(repo1, {
      dims: 3,
      vectors: [new Float32Array([1, 0, 0])],
      meta: [{ path: "stale.ts", start: 1, end: 5, name: "old", hash: "h1" }],
    });
    seedIndex(repo2, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "fresh.ts", start: 1, end: 5, name: "fresh", hash: "h2" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0])); // dims=2 query
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: "2" });
    const result = await runSemanticSearch({ query: "找点东西" }, ctx, settings);
    expect(result).toContain("fresh.ts:1-5");
    expect(result).not.toContain("stale.ts");
  });

  it("两个仓库都维度不匹配 -> any_index 仍为 true（索引文件确实存在）-> 走零命中文案而不是'没有任何索引'", async () => {
    seedIndex(repo1, {
      dims: 5,
      vectors: [new Float32Array([1, 0, 0, 0, 0])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0])); // dims=2
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(result).toBe("没有与「q」语义相近的代码块。换个说法试试，或改用 code_search。");
  });
});

// ---------------------------------------------------------------------------
// model fingerprint mismatch — Codex full-repo review (2026-07-14,
// Warning): dims alone can't catch a same-dimension model swap. A repo
// whose index was built under a DIFFERENT embedding model (but happens to
// emit vectors of the same length) must be skipped, exactly like a
// dims-mismatched one — not scored as if the two vector spaces were
// comparable.
// ---------------------------------------------------------------------------

describe("semantic_search — 模型指纹不匹配的仓库被跳过（同维度、不同模型）", () => {
  it("repo1 的索引由不同的 embedding 模型构建（维度恰好相同）-> 被跳过；repo2 指纹匹配当前配置 -> 仍返回 repo2 的命中", async () => {
    const staleModelSettings = makeSettings({ APP_EMBEDDING_MODEL: "text-embedding-v3" });
    seedIndex(
      repo1,
      {
        dims: 2,
        vectors: [new Float32Array([1, 0])],
        meta: [{ path: "stale-model.ts", start: 1, end: 5, name: "old", hash: "h1" }],
      },
      staleModelSettings, // fingerprint records the OLD model, not the current one
    );
    seedIndex(repo2, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "fresh.ts", start: 1, end: 5, name: "fresh", hash: "h2" }],
    }); // seeded with makeSettings() default — matches what runSemanticSearch is called with below

    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const result = await runSemanticSearch({ query: "找点东西" }, ctx, makeSettings());
    expect(result).toContain("fresh.ts:1-5");
    expect(result).not.toContain("stale-model.ts");
  });

  it("索引存在但从未写过指纹 sidecar（比如手工放进去的旧数据）-> 视为不匹配而不是自动放行，被跳过", async () => {
    // Bypasses the seedIndex helper on purpose — this is exactly the
    // "index file exists, .model sidecar doesn't" case the fail-closed
    // treatment (missing !== current, not an automatic pass) is meant to
    // catch, matching the same convention embedAndSaveIndex's own
    // incremental-reuse decision already uses.
    writeEmbeddingIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "no-fingerprint.ts", start: 1, end: 1, name: "", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(result).toBe("没有与「q」语义相近的代码块。换个说法试试，或改用 code_search。");
  });
});

// ---------------------------------------------------------------------------
// cross-repo cosine top-k: merge, sort by score desc, truncate
// ---------------------------------------------------------------------------

describe("semantic_search — 跨仓库余弦 top-k：合并、按分数降序、截断", () => {
  function seedTwoRepos() {
    // dims=2, all vectors pre-normalized (unit length), matching Task 1/3's
    // write-time invariant. Query raw embedding [3,0] normalizes to [1,0].
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      meta: [
        { path: "a.ts", start: 1, end: 3, name: "fnA", hash: "h1" }, // dot=1.0
        { path: "b.ts", start: 4, end: 6, name: "fnB", hash: "h2" }, // dot=0.0
      ],
    });
    seedIndex(repo2, {
      dims: 2,
      vectors: [new Float32Array([0.8, 0.6]), new Float32Array([-1, 0])],
      meta: [
        { path: "c.ts", start: 7, end: 9, name: "fnC", hash: "h3" }, // dot=0.8
        { path: "d.ts", start: 10, end: 12, name: "", hash: "h4" }, // dot=-1.0, no name
      ],
    });
  }

  it("四个 chunk 跨两仓库按分数降序合并：A(1.000) > C(0.800) > B(0.000) > D(-1.000)，行格式含 (name) 后缀，D 无 name 时无后缀", async () => {
    seedTwoRepos();
    const fetchMock = makeQueryFetchMock([3, 0]);
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const repo1Name = repo1.split("/").pop();
    const repo2Name = repo2.split("/").pop();

    const result = await runSemanticSearch({ query: "定位一下" }, ctx, makeSettings());

    // path stays bare (no repoId/ join — file_reader/code_search expect a
    // plain relative path, see semantic-search.ts's fix comment); the repo
    // tag is bracketed separately, shown here because 2 repos are granted.
    const expectedLines = [
      `1.000  a.ts:1-3 [repo ${repo1Name}] (fnA)`,
      `0.800  c.ts:7-9 [repo ${repo2Name}] (fnC)`,
      `0.000  b.ts:4-6 [repo ${repo1Name}] (fnB)`,
      `-1.000  d.ts:10-12 [repo ${repo2Name}]`,
    ];
    expect(result).toBe(
      "与「定位一下」语义最相近的代码位置（分值越高越相关，建议用 file_reader 查看确认）：\n" +
        expectedLines.join("\n"),
    );
  });

  it("只有一个仓库可见时，行内不出现 [repo ...] 消歧标签（没有歧义可消）", async () => {
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 3, name: "fnA", hash: "h1" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([3, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1] });
    const result = await runSemanticSearch({ query: "定位一下" }, ctx, makeSettings());
    expect(result).toBe(
      "与「定位一下」语义最相近的代码位置（分值越高越相关，建议用 file_reader 查看确认）：\n" +
        "1.000  a.ts:1-3 (fnA)",
    );
  });

  it("max_results 截断到跨仓库合并后的前 N 条", async () => {
    seedTwoRepos();
    vi.stubGlobal("fetch", makeQueryFetchMock([3, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const result = await runSemanticSearch({ query: "定位一下", max_results: 2 }, ctx, makeSettings());
    const lines = result.split("\n").slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a.ts:1-3");
    expect(lines[1]).toContain("c.ts:7-9");
  });

  it("请求体契约：Authorization/model/dimensions/encoding_format 与 embedding-client 一致，input 是单元素数组且截断到 2000 字符", async () => {
    seedTwoRepos();
    const fetchMock = makeQueryFetchMock([3, 0]);
    vi.stubGlobal("fetch", fetchMock);
    const settings = makeSettings({ APP_EMBEDDING_API_KEY: "dedicated-key" });
    const ctx = makeCtx({ allowedRepoPaths: [repo1, repo2] });
    const longQuery = "长查询".repeat(1000); // far over 2000 chars
    await runSemanticSearch({ query: longQuery }, ctx, settings);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe(`${settings.embeddingBaseUrl}/embeddings`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dedicated-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(settings.embeddingModel);
    expect(body.dimensions).toBe(settings.embeddingDimensions);
    expect(body.encoding_format).toBe("float");
    expect(body.input).toHaveLength(1);
    expect(Array.from(body.input[0]).length).toBe(2000);
    expect(body.input[0]).toBe(longQuery.slice(0, 2000));
  });
});

// ---------------------------------------------------------------------------
// recall-quality log — best-effort, ctx.db optional
// ---------------------------------------------------------------------------

describe("semantic_search — 检索日志：ctx.db 缺省", () => {
  it("ctx.db 未提供 -> 工具仍正常返回结果，不尝试记日志", async () => {
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "fn", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const ctx = makeCtx({ allowedRepoPaths: [repo1] }); // no db field at all
    const result = await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(result).toContain("a.ts:1-1");
  });
});

describe("semantic_search — 检索日志：ctx.db 提供时被正确调用", () => {
  function makeDb(record: (row: RecordSemanticSearchLogRow) => void | Promise<void>): DbClient {
    return { recordSemanticSearchLog: vi.fn(record) } as unknown as DbClient;
  }

  it("命中场景：字段齐全，repo_id 落成数字（目录名是纯数字字符串）", async () => {
    // Directory name "42" so repoIdForLog's digit-string quirk resolves to a number.
    const numericRepo = join(root, "42");
    mkdirSync(numericRepo);
    seedIndex(numericRepo, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 2, name: "fn", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const recorded: RecordSemanticSearchLogRow[] = [];
    const db = makeDb((row) => {
      recorded.push(row);
    });
    const ctx = makeCtx({ allowedRepoPaths: [numericRepo], userId: 99, db });
    const result = await runSemanticSearch({ query: "查一下" }, ctx, makeSettings());

    expect(result).toContain("a.ts:1-2");
    expect(db.recordSemanticSearchLog).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      userId: 99,
      repoId: 42,
      query: "查一下",
      resultCount: 1,
      top1Score: 1,
    });
    expect(typeof recorded[0].durationMs).toBe("number");
    const parsed = JSON.parse(recorded[0].resultsJson);
    expect(parsed).toEqual([
      { repo_id: "42", path: "a.ts", start: 1, end: 2, name: "fn", score: 1 },
    ]);
    // Byte-level check (self-review fix): a whole-valued score must render
    // as Python's json.dumps(1.0) would — "1.0", not the JS-number-default
    // "1" — since JSON.parse collapses both back to the same JS number 1,
    // the toEqual above alone can't tell them apart.
    expect(recorded[0].resultsJson).toContain('"score": 1.0');
    expect(recorded[0].resultsJson).not.toContain('"score": 1}');
  });

  it("目录名非纯数字字符串（如 uuid 风格）-> repo_id 记为 null，不强行转换", async () => {
    const nonNumericRepo = join(root, "my-repo-x");
    mkdirSync(nonNumericRepo);
    seedIndex(nonNumericRepo, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 2, name: "fn", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const recorded: RecordSemanticSearchLogRow[] = [];
    const db = makeDb((row) => {
      recorded.push(row);
    });
    const ctx = makeCtx({ allowedRepoPaths: [nonNumericRepo], db });
    await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(recorded[0].repoId).toBeNull();
  });

  it("零命中场景（v1 顺序：log 先于 zero-hits 提前返回）-> 仍记一条 result_count:0/top1Score:null 的日志", async () => {
    seedIndex(repo1, { dims: 2, vectors: [], meta: [] });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const recorded: RecordSemanticSearchLogRow[] = [];
    const db = makeDb((row) => {
      recorded.push(row);
    });
    const ctx = makeCtx({ allowedRepoPaths: [repo1], db });
    const result = await runSemanticSearch({ query: "查无所获" }, ctx, makeSettings());

    expect(result).toBe("没有与「查无所获」语义相近的代码块。换个说法试试，或改用 code_search。");
    expect(db.recordSemanticSearchLog).toHaveBeenCalledTimes(1);
    expect(recorded[0]).toMatchObject({ resultCount: 0, top1Score: null, repoId: null });
  });

  it("query 落库前截断到 500 字符", async () => {
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const recorded: RecordSemanticSearchLogRow[] = [];
    const db = makeDb((row) => {
      recorded.push(row);
    });
    const ctx = makeCtx({ allowedRepoPaths: [repo1], db });
    const longQuery = "x".repeat(600);
    await runSemanticSearch({ query: longQuery }, ctx, makeSettings());
    expect(recorded[0].query).toBe("x".repeat(500));
  });
});

describe("semantic_search — 检索日志写入失败不影响工具返回值", () => {
  it("db.recordSemanticSearchLog 同步抛错 -> 被 catch，工具仍正常返回结果", async () => {
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "fn", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const db = {
      recordSemanticSearchLog: vi.fn(() => {
        throw new Error("sync boom");
      }),
    } as unknown as DbClient;
    const ctx = makeCtx({ allowedRepoPaths: [repo1], db });
    const result = await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(result).toContain("a.ts:1-1");
    expect(db.recordSemanticSearchLog).toHaveBeenCalledTimes(1);
  });

  it("db.recordSemanticSearchLog 异步 reject -> 被 catch，工具仍正常返回结果", async () => {
    seedIndex(repo1, {
      dims: 2,
      vectors: [new Float32Array([1, 0])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "fn", hash: "h" }],
    });
    vi.stubGlobal("fetch", makeQueryFetchMock([1, 0]));
    const db = {
      recordSemanticSearchLog: vi.fn(() => Promise.reject(new Error("async boom"))),
    } as unknown as DbClient;
    const ctx = makeCtx({ allowedRepoPaths: [repo1], db });
    const result = await runSemanticSearch({ query: "q" }, ctx, makeSettings());
    expect(result).toContain("a.ts:1-1");
    expect(db.recordSemanticSearchLog).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// repoIdForLog — digit-string quirk unit tests
// ---------------------------------------------------------------------------

describe("repoIdForLog — v1 的 str.isdigit() 端口", () => {
  it("纯数字字符串 -> 转数字", () => {
    expect(repoIdForLog("42")).toBe(42);
    expect(repoIdForLog("007")).toBe(7);
    expect(repoIdForLog("0")).toBe(0);
  });
  it("非纯数字（含负号/字母/空串）-> null", () => {
    expect(repoIdForLog("-5")).toBeNull();
    expect(repoIdForLog("my-repo")).toBeNull();
    expect(repoIdForLog("")).toBeNull();
    expect(repoIdForLog("4.2")).toBeNull();
    expect(repoIdForLog(" 42")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registration wiring sanity
// ---------------------------------------------------------------------------

describe("semantic_search — 注册", () => {
  it("import 时通过 registerTool 完成自注册（副作用），listTools() 能找到", () => {
    const found = listTools().find((t) => t.name === "semantic_search");
    expect(found).toBeDefined();
    expect(found).toBe(semanticSearchTool);
    expect(typeof found?.execute).toBe("function");
  });
});
