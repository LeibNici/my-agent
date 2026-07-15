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
import { embeddingKeyOrFallback, embedAndSaveIndex, __internal } from "../src/tools/embedding-client.js";

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
// embedAndSaveIndex — onProgress (2026-07-15: repo-sync.ts publishes this as
// repositories.embed_index_done/total so semantic_search can report real
// progress instead of one static "not ready yet" string regardless of how
// far a build has actually gotten)
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — onProgress", () => {
  it("reports (0, total) before the first wave, then cumulative done after each wave, ending at (total, total)", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    // 45 new chunks, EMBED_BATCH=10 -> 5 batches (10×4 + 5), CONCURRENCY=4 ->
    // wave 1 is batches 1-4 (40 chunks), wave 2 is batch 5 (5 chunks) — two
    // waves is the minimum needed to distinguish "cumulative" from
    // "per-wave" reporting.
    const chunks = Array.from({ length: 45 }, (_, i) => makeChunk(`f${i}.ts`, `fn${i}`, `function fn${i}() {}`));

    const calls: Array<[number, number]> = [];
    const ok = await embedAndSaveIndex(repo, chunks, settings, undefined, (done, total) =>
      calls.push([done, total]),
    );
    expect(ok).toBe(true);

    expect(calls).toEqual([
      [0, 45],
      [40, 45],
      [45, 45],
    ]);
  });

  it("counts hash-reused chunks toward done from the very first call — a mostly-cached rebuild doesn't read as starting from 0", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });

    const cached = makeChunk("a.ts", "foo", "function foo() { return 1; }");
    writeEmbeddingIndex(repo, {
      dims,
      vectors: [new Float32Array([0.5, 0.5, 0.5, 0.5])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(cached) }],
    });
    __internal.writeModelFingerprint(repo, __internal.currentModelFingerprint(settings));

    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const freshChunk = makeChunk("b.ts", "bar", "function bar() { return 2; }");
    const calls: Array<[number, number]> = [];
    const ok = await embedAndSaveIndex(repo, [cached, freshChunk], settings, undefined, (done, total) =>
      calls.push([done, total]),
    );
    expect(ok).toBe(true);

    // First call reports the 1 reused chunk as already done, not 0 — then
    // climbs to 2/2 once the 1 genuinely new chunk is embedded.
    expect(calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("never calls onProgress when there's nothing to embed (no key / empty chunks)", async () => {
    const settings = makeSettings({ ANTHROPIC_API_KEY: "", APP_EMBEDDING_API_KEY: "" });
    const calls: Array<[number, number]> = [];
    const ok = await embedAndSaveIndex(repo, [makeChunk("a.ts", "foo", "x")], settings, undefined, (done, total) =>
      calls.push([done, total]),
    );
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
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
    // the CURRENT dims (so the unchanged chunk's hash is reusable) — plus a
    // matching model fingerprint, or the reuse gate below treats it as
    // possibly-different-model and forces a full re-embed regardless of hash.
    writeEmbeddingIndex(repo, {
      dims,
      vectors: [new Float32Array([0.5, 0.5, 0.5, 0.5]), new Float32Array([0.1, 0.2, 0.3, 0.4])],
      meta: [
        { path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(unchangedChunk) },
        { path: "b.ts", start: 1, end: 1, name: "bar", hash: chunkHash(changedOldChunk) },
      ],
    });
    __internal.writeModelFingerprint(repo, __internal.currentModelFingerprint(settings));

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

  it("模型指纹不匹配（换了 embedding 模型）-> 即使哈希+维度都命中也强制重新 embed，不混用不同模型的向量空间", async () => {
    const dims = 4;
    const oldSettings = makeSettings({ APP_EMBEDDING_MODEL: "text-embedding-v3", APP_EMBEDDING_DIMENSIONS: String(dims) });
    const newSettings = makeSettings({ APP_EMBEDDING_MODEL: "text-embedding-v4", APP_EMBEDDING_DIMENSIONS: String(dims) });
    const chunk = makeChunk("a.ts", "foo", "function foo() { return 1; }");

    // Old index at the SAME dims, hash would hit — only the model differs.
    writeEmbeddingIndex(repo, {
      dims,
      vectors: [new Float32Array([0.5, 0.5, 0.5, 0.5])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(chunk) }],
    });
    __internal.writeModelFingerprint(repo, __internal.currentModelFingerprint(oldSettings));

    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await embedAndSaveIndex(repo, [chunk], newSettings);
    expect(ok).toBe(true);

    // Must have gone through the API despite the hash+dims match, because
    // the old index was built with a different embedding model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("旧索引没有指纹侧车文件（这次修复之前建的）-> 视为不匹配，强制重新 embed 而不是默认信任", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const chunk = makeChunk("a.ts", "foo", "function foo() { return 1; }");

    // No __internal.writeModelFingerprint call — simulates an index
    // written before this fingerprint check existed.
    writeEmbeddingIndex(repo, {
      dims,
      vectors: [new Float32Array([0.5, 0.5, 0.5, 0.5])],
      meta: [{ path: "a.ts", start: 1, end: 1, name: "foo", hash: chunkHash(chunk) }],
    });

    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await embedAndSaveIndex(repo, [chunk], settings);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// embedAndSaveIndex — isStillLatest staleness guard (Codex full-repo review,
// 2026-07-14, Warning: two overlapping rebuilds for the same repo can race
// to publish, and the one that merely finishes LAST used to win regardless
// of which one started most recently)
// ---------------------------------------------------------------------------

describe("embedAndSaveIndex — isStillLatest staleness guard", () => {
  it("isStillLatest 从一开始就为 false -> 不发任何请求，不写入索引", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "function foo() {}")];
    const ok = await embedAndSaveIndex(repo, chunks, settings, () => false);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readEmbeddingIndex(repo)).toBeNull();
  });

  it("isStillLatest 在 embed 请求进行期间（写入之前）变为 false（模拟一次更新的重建在此期间开始了）-> 已经花的 API 调用结果被丢弃，不覆盖已有索引", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });

    // Seed an existing index first, so we can prove it's untouched by the
    // stale build below (not just "nothing was ever written").
    const seedFetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", seedFetchMock);
    const priorChunk = makeChunk("prior.ts", "prior", "existing prior content");
    const seedOk = await embedAndSaveIndex(repo, [priorChunk], settings);
    expect(seedOk).toBe(true);
    const before = readEmbeddingIndex(repo)!;

    // A newer rebuild "starts" (flips the flag) as a side effect of THIS
    // build's own embed call actually going out over the network — proving
    // the guard right before publish (not just the cheap early-exit one)
    // is what catches this, since isStillLatest() was still true when the
    // expensive work began.
    let stillLatest = true;
    const staleFetchMock = makeFetchMock({ dims });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const result = await staleFetchMock(url, init);
        stillLatest = false; // a newer build began while this fetch was in flight
        return result;
      })
    );

    const chunks = [makeChunk("a.ts", "foo", "function foo() { return 1; }")];
    const ok = await embedAndSaveIndex(repo, chunks, settings, () => stillLatest);
    expect(ok).toBe(false);

    const after = readEmbeddingIndex(repo)!;
    expect(after.meta.map((m) => m.path)).toEqual(before.meta.map((m) => m.path));
  });

  it("isStillLatest 未传入（省略）-> 默认行为不变，照常写入（不破坏现有 14 处调用方）", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "function foo() {}")];
    const ok = await embedAndSaveIndex(repo, chunks, settings);

    expect(ok).toBe(true);
    expect(readEmbeddingIndex(repo)).not.toBeNull();
  });

  it("isStillLatest 全程为 true -> 正常写入（回归保护：新增守卫不误伤正常单次构建）", async () => {
    const dims = 4;
    const settings = makeSettings({ APP_EMBEDDING_DIMENSIONS: String(dims) });
    const fetchMock = makeFetchMock({ dims });
    vi.stubGlobal("fetch", fetchMock);

    const chunks = [makeChunk("a.ts", "foo", "function foo() {}")];
    const ok = await embedAndSaveIndex(repo, chunks, settings, () => true);

    expect(ok).toBe(true);
    expect(readEmbeddingIndex(repo)).not.toBeNull();
  });
});
