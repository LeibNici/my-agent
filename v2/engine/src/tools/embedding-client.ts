// Task 3 (Phase 4b): embedding-client.ts — HTTP batch embedding client +
// incremental hash-diff index build orchestration. Ported from
// v1-python-final:app/tools/semantic_index.py's embedding_key_or_fallback /
// _embed_batch / embed_and_save_index / _embed_and_save, verbatim in
// behavior — see that file's module docstring for the design rationale
// (host-matched credential reuse, incremental hash diff, keep-what-you-got-
// fail-the-build on any API hiccup).
//
// Uses Node's global `fetch` (built-in since Node 18) — no new dependency,
// same choice v1 made with httpx for the equivalent client.
import type { Settings } from "../config.js";
import type { Chunk } from "./chunking.js";
import { chunkHash } from "./chunking.js";
import { readEmbeddingIndex, writeEmbeddingIndex, type EmbeddingChunkMeta } from "./embed-store.js";

const EMBED_BATCH = 10; // DashScope text-embedding-v4 batch limit
const CONCURRENCY = 4; // in-flight batch requests per build
const BUILD_TIMEOUT_MS = 1800 * 1000;
const BATCH_TIMEOUT_MS = 60 * 1000; // v1's per-request httpx timeout=60

// ---------------------------------------------------------------------------
// embeddingKeyOrFallback port
// ---------------------------------------------------------------------------

/**
 * Python's urlparse() never throws on a malformed URL — it just returns an
 * empty hostname. JS's `new URL()` DOES throw on invalid input, so this
 * wraps it to match urlparse's permissive behavior: unparseable -> "".
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

/**
 * Dedicated key if configured. Otherwise reuse the LLM's ANTHROPIC_API_KEY
 * ONLY when it's genuinely the same account — i.e. embeddingBaseUrl and the
 * LLM's baseUrl resolve to the same host. Blindly reusing the key regardless
 * of host would send the Anthropic credential (and every embedded code
 * chunk) to whatever third-party embeddingBaseUrl names — a real credential
 * leak for any deployment on the official Anthropic API or a different
 * provider. Without a host match, semantic search just stays disabled until
 * APP_EMBEDDING_API_KEY is set explicitly.
 */
export function embeddingKeyOrFallback(settings: Settings): string {
  if (settings.embeddingApiKey) return settings.embeddingApiKey;
  const llmHost = safeHostname(settings.baseUrl);
  const embedHost = safeHostname(settings.embeddingBaseUrl);
  if (llmHost && llmHost === embedHost) return settings.apiKey;
  return "";
}

// ---------------------------------------------------------------------------
// embed_input port
// ---------------------------------------------------------------------------

/** Path + symbol name give the embedding the naming context the raw body
 * may lack ("MobileDispositionReview.vue" itself carries meaning). */
function embedInput(chunk: Chunk): string {
  return `${chunk.path} ${chunk.name}\n${chunk.text}`;
}

// ---------------------------------------------------------------------------
// _embed_batch port
// ---------------------------------------------------------------------------

type EmbedDataEntry = { index: number; embedding: number[] };

/**
 * Combines the whole-build AbortSignal with a fresh per-batch 60s bound,
 * mirroring v1's per-request `httpx` `timeout=60` alongside this port's
 * whole-build 1800s AbortController: whichever fires first wins. Built by
 * hand with `setTimeout` + `AbortController` (rather than
 * `AbortSignal.timeout()`, whose internal timer isn't driven by fake-timer
 * mocking in tests) so it composes uniformly through `AbortSignal.any` and
 * stays deterministically testable. Caller must invoke the returned `clear`
 * once the request settles, so a fast batch doesn't leave a 60s timer
 * dangling for the rest of the build.
 */
function withBatchTimeout(buildSignal: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const perBatch = new AbortController();
  const timer = setTimeout(() => perBatch.abort(), BATCH_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: AbortSignal.any([buildSignal, perBatch.signal]),
    clear: () => clearTimeout(timer),
  };
}

/**
 * POSTs one batch (<=EMBED_BATCH texts) to the embedding endpoint. Returns
 * the embeddings in REQUEST order (sorted by the response's `index` field,
 * matching v1's `sorted(data, key=lambda d: d["index"])`), or null on any
 * failure (non-200 status, malformed JSON, response length mismatch, thrown
 * network/abort error) — the caller treats null as "this batch failed,
 * fail the whole build" (v1's "keep what we got, fail the build").
 */
async function embedBatch(
  texts: string[],
  settings: Settings,
  key: string,
  signal: AbortSignal,
): Promise<Float32Array[] | null> {
  const { signal: requestSignal, clear } = withBatchTimeout(signal);
  let resp: Response;
  try {
    resp = await fetch(`${settings.embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.embeddingModel,
        input: texts,
        dimensions: settings.embeddingDimensions,
        encoding_format: "float",
      }),
      signal: requestSignal,
    });
  } catch {
    // Network error, whole-build timeout/abort, or this batch's own 60s
    // timeout — either way this batch didn't complete.
    return null;
  } finally {
    clear();
  }
  if (resp.status !== 200) return null;

  let payload: { data?: EmbedDataEntry[] };
  try {
    payload = (await resp.json()) as { data?: EmbedDataEntry[] };
  } catch {
    return null;
  }
  const data = Array.isArray(payload.data) ? payload.data : [];
  if (data.length !== texts.length) return null;

  const sorted = [...data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => Float32Array.from(d.embedding));
}

// ---------------------------------------------------------------------------
// L2 normalization — write-time port of v1's
// `norms[norms == 0] = 1.0; vectors = vectors / norms`
//
// Exported (Phase 4b Task 4): semantic-search.ts's query-time normalization
// needs the identical zero-vector-safe division — v1 spells the query-time
// version slightly differently (`qn = norm(q); if qn > 0: q = q / qn`,
// leaving a zero vector unchanged rather than dividing by a safe 1.0
// denominator), but the two are numerically identical for every input
// (dividing the zero vector by 1.0 IS the zero vector), so semantic-search.ts
// reuses this rather than carrying a second copy of the same normalization
// loop.
// ---------------------------------------------------------------------------

export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  const divisor = norm === 0 ? 1.0 : norm; // zero-vector division guard
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / divisor;
  return out;
}

// ---------------------------------------------------------------------------
// _embed_and_save port
// ---------------------------------------------------------------------------

async function doEmbedAndSave(
  repoPath: string,
  chunks: Chunk[],
  settings: Settings,
  key: string,
  signal: AbortSignal,
): Promise<boolean> {
  const hashes = chunks.map((c) => chunkHash(c));
  const dims = settings.embeddingDimensions;

  // A hash reused from the old index is only valid if its cached vector
  // actually has the CURRENT dimensionality — otherwise (e.g. after an
  // APP_EMBEDDING_DIMENSIONS or embedding_model change) it must be
  // re-embedded like any other new chunk, not left as a stale-shape vector
  // that silently passes the hash check on every future rebuild too.
  const oldIndex = readEmbeddingIndex(repoPath);
  const reusable = new Map<string, Float32Array>();
  if (oldIndex !== null) {
    for (let i = 0; i < oldIndex.meta.length; i++) {
      const vec = oldIndex.vectors[i];
      if (vec.length === dims) {
        reusable.set(oldIndex.meta[i].hash, vec);
      }
    }
  }

  const vectors: Float32Array[] = new Array(chunks.length);
  const todo: number[] = []; // indices into chunks/hashes/vectors needing embed
  for (let i = 0; i < chunks.length; i++) {
    const cached = reusable.get(hashes[i]);
    if (cached !== undefined) {
      vectors[i] = cached;
    } else {
      todo.push(i);
    }
  }

  if (todo.length > 0) {
    const batches: number[][] = [];
    for (let s = 0; s < todo.length; s += EMBED_BATCH) {
      batches.push(todo.slice(s, s + EMBED_BATCH));
    }
    // Modest concurrency (CONCURRENCY in-flight batches) — cuts a cold
    // build of a large repo from minutes to a fraction of that without
    // hammering the provider's rate limits. Waves run sequentially; within
    // a wave, up to CONCURRENCY batches fire together via Promise.all.
    for (let waveStart = 0; waveStart < batches.length; waveStart += CONCURRENCY) {
      const wave = batches.slice(waveStart, waveStart + CONCURRENCY);
      const results = await Promise.all(
        wave.map((batchIndices) =>
          embedBatch(
            batchIndices.map((i) => embedInput(chunks[i])),
            settings,
            key,
            signal,
          ),
        ),
      );
      for (let w = 0; w < wave.length; w++) {
        const embs = results[w];
        if (embs === null) return false; // API hiccup — fail the whole build
        const batchIndices = wave[w];
        for (let k = 0; k < batchIndices.length; k++) {
          vectors[batchIndices[k]] = embs[k];
        }
      }
    }
  }

  const normalized = vectors.map((v) => l2Normalize(v));
  const meta: EmbeddingChunkMeta[] = chunks.map((c, i) => ({
    path: c.path,
    start: c.start,
    end: c.end,
    name: c.name,
    hash: hashes[i],
  }));

  writeEmbeddingIndex(repoPath, { dims, vectors: normalized, meta });
  return true;
}

// ---------------------------------------------------------------------------
// embed_and_save_index port
// ---------------------------------------------------------------------------

/**
 * Phase 2 (slow, does NOT need the repo lock): diff against the saved index
 * by chunk hash, embed only what's new, write the sidecar. Bounded by
 * BUILD_TIMEOUT_MS (1800s) via a real AbortController — the timer aborts
 * the shared AbortSignal, which propagates into every in-flight `fetch`
 * call and rejects it immediately (not just an independent timer racing an
 * unaborted request that keeps running in the background). Best-effort:
 * returns false on any failure/timeout, never throws.
 */
export async function embedAndSaveIndex(
  repoPath: string,
  chunks: Chunk[],
  settings: Settings,
): Promise<boolean> {
  const key = embeddingKeyOrFallback(settings);
  if (!key || chunks.length === 0) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await doEmbedAndSave(repoPath, chunks, settings, key, controller.signal);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
