// Task 3 (Phase 4b): embedding-client.ts — HTTP batch embedding client +
// incremental hash-diff index build orchestration. Ported from
// v1-python-final:app/tools/semantic_index.py's embedding_key_or_fallback /
// _embed_batch / embed_and_save_index / _embed_and_save, verbatim in
// behavior (constants: _EMBED_BATCH=10, _CONCURRENCY=4,
// _BUILD_TIMEOUT_SECONDS=1800).
//
// fetch is mocked via vi.stubGlobal (no real HTTP server) — the established
// pattern for this codebase's offline test suite (see brief). Real file I/O
// (embed-store's readEmbeddingIndex/writeEmbeddingIndex) runs against real
// mkdtemp'd temp directories, same convention as embed-store.test.ts and
// repo-sync.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, type Settings } from "../src/config.js";
import { writeEmbeddingIndex, readEmbeddingIndex } from "../src/tools/embed-store.js";
import type { Chunk } from "../src/tools/chunking.js";
import { chunkHash } from "../src/tools/chunking.js";
import { embeddingKeyOrFallback, embedAndSaveIndex } from "../src/tools/embedding-client.js";

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
    APP_EMBEDDING_DIMENSIONS: "4",
    ...overrides,
  });
}

function makeChunk(path: string, name: string, text: string): Chunk {
  return { path, start: 1, end: 1, name, text };
}

function magnitude(vec: Float32Array): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

/** A fixed-length "embedding" derived from the input text, so different
 * texts produce distinguishable (but deterministic) vectors in assertions. */
function fakeEmbedding(seed: string, dims: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    out.push(((seed.charCodeAt(i % seed.length) + i * 7) % 23) - 11); // small nonzero-ish spread
  }
  return out;
}

/** Builds a fetch mock that returns 200 + one embedding per requested input,
 * unless `failOnBatchContaining` substring-matches one of the batch's input
 * strings (used to make a specific batch fail with non-200). Records
 * concurrency (calls in flight) via `concurrency.current`/`concurrency.max`. */
function makeFetchMock(opts: {
  dims: number;
  failOnBatchContaining?: string;
  concurrency?: { current: number; max: number };
}) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    if (opts.concurrency) {
      opts.concurrency.current++;
      opts.concurrency.max = Math.max(opts.concurrency.max, opts.concurrency.current);
    }
    try {
      // Simulate network latency so concurrent calls actually overlap.
      await new Promise((r) => setTimeout(r, 5));
      const body = JSON.parse(init.body) as { input: string[] };
      if (
        opts.failOnBatchContaining &&
        body.input.some((s) => s.includes(opts.failOnBatchContaining as string))
      ) {
        return {
          status: 500,
          json: async () => ({}),
        } as unknown as Response;
      }
      const data = body.input.map((text, index) => ({
        index,
        embedding: fakeEmbedding(text, opts.dims),
      }));
      return {
        status: 200,
        json: async () => ({ data }),
      } as unknown as Response;
    } finally {
      if (opts.concurrency) opts.concurrency.current--;
    }
  });
}

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "embedding-client-"));
  repo = join(root, "repo");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// embeddingKeyOrFallback
// ---------------------------------------------------------------------------

describe("embeddingKeyOrFallback", () => {
  it("显式配置了 APP_EMBEDDING_API_KEY -> 优先返回它，即使 host 不同", () => {
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "dedicated-embed-key",
      APP_EMBEDDING_BASE_URL: "https://other-provider.example.com/v1",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
    expect(embeddingKeyOrFallback(settings)).toBe("dedicated-embed-key");
  });

  it("无专用 key，embedding host 与 LLM host 相同 -> 复用 LLM 的 apiKey", () => {
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_API_KEY: "llm-shared-key",
    });
    expect(embeddingKeyOrFallback(settings)).toBe("llm-shared-key");
  });

  it("无专用 key，host 不同 -> 返回空串（不做跨 provider 的凭证复用）", () => {
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_API_KEY: "llm-shared-key",
    });
    expect(embeddingKeyOrFallback(settings)).toBe("");
  });

  it("baseUrl 是畸形 URL（new URL() 会抛）-> 不抛异常，按空 hostname 处理返回空串", () => {
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "not a valid url at all",
      APP_EMBEDDING_BASE_URL: "also not valid ::::",
      ANTHROPIC_API_KEY: "llm-shared-key",
    });
    expect(() => embeddingKeyOrFallback(settings)).not.toThrow();
    expect(embeddingKeyOrFallback(settings)).toBe("");
  });

  it("embeddingApiKey 为空白字符串时视为未配置（falsy）——仍走 host-match 逻辑", () => {
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ANTHROPIC_API_KEY: "llm-shared-key",
    });
    expect(embeddingKeyOrFallback(settings)).toBe("llm-shared-key");
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — no-op fast paths (no HTTP call)
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — no-op fast paths", () => {
  it("无可用 key -> 直接返回 false，不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = makeSettings({
      APP_EMBEDDING_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com", // host mismatch -> no key
      APP_EMBEDDING_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const chunks = [makeChunk("a.ts", "foo", "function foo() {}")];
    const result = await embedAndSaveIndex(repo, chunks, settings);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空 chunks 数组 -> 直接返回 false，不发任何请求（即使 key 有效）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const settings = makeSettings();
    const result = await embedAndSaveIndex(repo, [], settings);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — fresh build (no prior index)
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — fresh build", () => {
  it("全新 chunk 全部 embed 并写入；请求体/头符合 v1 契约；写入向量归一化为单位长度", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [
      makeChunk("a.ts", "foo", "function foo() { return 1; }"),
      makeChunk("b.ts", "bar", "function bar() { return 2; }"),
    ];

    const ok = await embedAndSaveIndex(repo, chunks, settings);
    expect(ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1); // 2 chunks fit in one batch of 10
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${settings.embeddingBaseUrl}/embeddings`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${settings.apiKey}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe(settings.embeddingModel);
    expect(body.dimensions).toBe(dims);
    expect(body.encoding_format).toBe("float");
    expect(body.input).toEqual([
      "a.ts foo\nfunction foo() { return 1; }",
      "b.ts bar\nfunction bar() { return 2; }",
    ]);

    const loaded = readEmbeddingIndex(repo)!;
    expect(loaded.dims).toBe(dims);
    expect(loaded.meta.map((m) => m.path)).toEqual(["a.ts", "b.ts"]);
    expect(loaded.meta.map((m) => m.hash)).toEqual(chunks.map((c) => chunkHash(c)));
    for (const vec of loaded.vectors) {
      expect(magnitude(vec)).toBeCloseTo(1, 5);
    }
  });

  it("全零向量（embedding API 返回全 0）归一化除数保护为 1.0，写入后仍是全零向量而不是 NaN", async () => {
    const dims = 3;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: [0, 0, 0] }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("z.ts", "zero", "zero vector chunk")];
    const ok = await embedAndSaveIndex(repo, chunks, settings);
    expect(ok).toBe(true);

    const loaded = readEmbeddingIndex(repo)!;
    expect(Array.from(loaded.vectors[0])).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — incremental hash-diff reuse
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — incremental reuse", () => {
  it("部分 chunk 命中旧索引哈希 -> 不重复请求，只 embed 新增/变化的部分", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });

    const unchangedChunk = makeChunk("a.ts", "foo", "function foo() { return 1; }");
    const changedOldChunk = makeChunk("b.ts", "bar", "function bar() { return 2; }");
    const changedNewChunk = makeChunk("b.ts", "bar", "function bar() { return 999; }"); // text changed -> new hash

    // Seed an old index as if a previous build already ran, with vectors at
    // the CURRENT dims (so the unchanged chunk's hash is reusable).
    writeEmbeddingIndex(repo, {
      dims,
      vectors: [new Float32Array([0.5, 0.5, 0.5, 0.5]), new Float32Array([0.1, 0.2, 0.3, 0.4])],
      meta: [
        { path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(unchangedChunk) },
        { path: "b.ts", start: 1, end: 1, name: "bar", hash: chunkHash(changedOldChunk) },
      ],
    });

    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const newChunks = [unchangedChunk, changedNewChunk];
    const ok = await embedAndSaveIndex(repo, newChunks, settings);
    expect(ok).toBe(true);

    // Only the changed chunk's text should ever appear in a request body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input).toEqual(["b.ts bar\nfunction bar() { return 999; }"]);

    const loaded = readEmbeddingIndex(repo)!;
    // Reused vector for the unchanged chunk must be byte-identical to what
    // was in the old index (not re-derived/re-normalized from scratch —
    // the old index was already unit-length in this test's fixture... but
    // note: it was NOT unit length here (0.5,0.5,0.5,0.5) — the write path
    // re-normalizes on every save, so check magnitude instead of raw bytes).
    expect(magnitude(loaded.vectors[0])).toBeCloseTo(1, 5);
    expect(loaded.meta[0].hash).toBe(chunkHash(unchangedChunk));
    expect(loaded.meta[1].hash).toBe(chunkHash(changedNewChunk));
  });

  it("旧索引里的向量维度和当前 embeddingDimensions 不一致 -> 即使哈希命中也强制重新 embed", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const chunk = makeChunk("a.ts", "foo", "function foo() { return 1; }");

    // Old index has a STALE dimensionality (2, not the current 4).
    writeEmbeddingIndex(repo, {
      dims: 2,
      vectors: [new Float32Array([0.5, 0.5])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(chunk) }],
    });

    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await embedAndSaveIndex(repo, [chunk], settings);
    expect(ok).toBe(true);

    // Must have gone through the API despite the hash match, because the
    // cached vector's dimensionality doesn't match current settings.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const loaded = readEmbeddingIndex(repo)!;
    expect(loaded.dims).toBe(dims);
    expect(loaded.vectors[0].length).toBe(dims);
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — failure semantics
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — failure semantics", () => {
  it("某一批 API 返回非 200 -> 整个构建失败返回 false（keep-what-you-got-fail-the-build）", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    // 15 unique chunks -> 2 batches of 10/5; make the second batch fail.
    const chunks: Chunk[] = Array.from({ length: 15 }, (_, i) =>
      makeChunk(`f${i}.ts`, `sym${i}`, `body content number ${i}`),
    );
    const fetchMock = makeFetchMock({ dims, failOnBatchContaining: "number 12" });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await embedAndSaveIndex(repo, chunks, settings);
    expect(ok).toBe(false);

    // Build failed -> no sidecar written (nothing existed before).
    expect(readEmbeddingIndex(repo)).toBeNull();
  });

  it("response.data.length 与请求条数不一致 -> 该批失败，整个构建返回 false", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), // only 1, but 2 requested
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "aaa"), makeChunk("b.ts", "bar", "bbb")];
    const ok = await embedAndSaveIndex(repo, chunks, settings);
    expect(ok).toBe(false);
  });

  it("fetch 本身抛异常（网络错误）-> 捕获后返回 false，不向上抛出", async () => {
    const settings = makeSettings();
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "aaa")];
    await expect(embedAndSaveIndex(repo, chunks, settings)).resolves.toBe(false);
  });

  it("API 返回的 embedding 向量长度与 settings.embeddingDimensions 不符（provider 配置漂移）-> writeEmbeddingIndex 内部抛出的错误被捕获，返回 false 而不是向上抛出", async () => {
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: "4" });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      // Count matches (1 == 1 requested) so the length check passes, but the
      // embedding itself is the wrong dimensionality (2, not 4) — a
      // provider/model misconfiguration embed-store's write-time validation
      // exists to catch.
      json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "aaa")];
    await expect(embedAndSaveIndex(repo, chunks, settings)).resolves.toBe(false);
    // Never throws out of embedAndSaveIndex even though writeEmbeddingIndex
    // itself would throw on this malformed input.
    expect(readEmbeddingIndex(repo)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — concurrency
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — concurrency", () => {
  it("批次并发数不超过 4（CONCURRENCY），且确实发挥了并发（不是退化成串行）", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    // 45 unique chunks -> ceil(45/10) = 5 batches -> waves of [4, 1].
    const chunks: Chunk[] = Array.from({ length: 45 }, (_, i) =>
      makeChunk(`f${i}.ts`, `sym${i}`, `distinct body ${i}`),
    );
    const concurrency = { current: 0, max: 0 };
    const fetchMock = makeFetchMock({ dims, concurrency });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await embedAndSaveIndex(repo, chunks, settings);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(concurrency.max).toBeGreaterThan(1); // actually overlapped
    expect(concurrency.max).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — 1800s build timeout actually aborts in-flight work
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — build timeout", () => {
  it("超时后返回 false，且传给 fetch 的 AbortSignal 被真正 abort（不是仅仅让外层 promise 竞速而放任请求继续跑）", async () => {
    vi.useFakeTimers();
    const settings = makeSettings();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      // A fetch that NEVER resolves on its own — the only way this promise
      // ever settles is if the abort signal fires and something reacts to
      // it (proving real cancellation, not an independent timer race).
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "aaa")];
    const resultPromise = embedAndSaveIndex(repo, chunks, settings);

    expect(capturedSignal?.aborted).not.toBe(true); // not aborted yet before timeout elapses

    await vi.advanceTimersByTimeAsync(1_800_000);

    await expect(resultPromise).resolves.toBe(false);
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// embedAndSaveIndex — per-batch 60s timeout (v1's httpx timeout=60, ported
// alongside the whole-build 1800s AbortController)
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — per-batch 60s timeout", () => {
  it("单个 batch 挂起且从不响应，whole-build 信号从未触发 -> 该 batch 独立在 60s 处超时，不必等到 1800s；整体 build 远早于 1800s 就返回 false", async () => {
    vi.useFakeTimers();
    const settings = makeSettings();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      // Never resolves on its own — the whole-build AbortController's 1800s
      // timer is never advanced far enough to fire in this test, so the
      // ONLY way this promise settles is the batch's own 60s timeout.
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "aaa")];
    const resultPromise = embedAndSaveIndex(repo, chunks, settings);

    expect(capturedSignal?.aborted).not.toBe(true); // not aborted yet before the batch timeout elapses

    await vi.advanceTimersByTimeAsync(59_999);
    expect(capturedSignal?.aborted).not.toBe(true); // still short of the 60s per-batch bound

    await vi.advanceTimersByTimeAsync(1);
    expect(capturedSignal?.aborted).toBe(true); // fired at the 60s mark, NOT the 1800s whole-build mark

    // Resolves to false having only simulated 60s total — nowhere near the
    // 1800s whole-build bound (which was never advanced to and never fired).
    await expect(resultPromise).resolves.toBe(false);
  });
});
