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
import * as fs from "node:fs";
import type { Settings } from "../config.js";
import type { Chunk } from "./chunking.js";
import { chunkHash } from "./chunking.js";
import { readEmbeddingIndex, writeEmbeddingIndex, embPath, type EmbeddingChunkMeta } from "./embed-store.js";

const EMBED_BATCH = 10; // DashScope text-embedding-v4 batch limit
const CONCURRENCY = 4; // in-flight batch requests per build
const BUILD_TIMEOUT_MS = 1800 * 1000;
const BATCH_TIMEOUT_MS = 60 * 1000; // v1's per-request httpx timeout=60

// Which (base URL, model) produced a repo's .emb.v1.bin — embed-store.ts's
// binary format is model-agnostic by design (it just stores vectors +
// content hashes), so this identity lives in its own tiny sidecar rather
// than in that format. Without it, reuse-by-content-hash below would
// happily reuse vectors from a DIFFERENT embedding model after an
// APP_EMBEDDING_MODEL/APP_EMBEDDING_BASE_URL change, as long as the new
// model's output dimensionality happened to match — mixing two unrelated
// vector spaces in the same cosine comparison with no error or warning.
function modelFingerprintPath(repoPath: string): string {
  return embPath(repoPath) + ".model";
}

// Exported (not just used internally by the incremental-reuse decision
// below): semantic-search.ts's query path needs the exact same identity
// check — a same-dimension model swap (e.g. APP_EMBEDDING_MODEL changed to
// a different model that happens to also emit 1536-dim vectors) would
// otherwise pass the dims-only check at query time and silently score a
// fresh query vector against a DIFFERENT, incompatible vector space.
export function currentModelFingerprint(settings: Settings): string {
  return `${settings.embeddingBaseUrl}|${settings.embeddingModel}`;
}

export function readModelFingerprint(repoPath: string): string | null {
  try {
    return fs.readFileSync(modelFingerprintPath(repoPath), "utf8");
  } catch {
    return null;
  }
}

function writeModelFingerprint(repoPath: string, fingerprint: string): void {
  fs.writeFileSync(modelFingerprintPath(repoPath), fingerprint, "utf8");
}

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
 * A fresh `timeoutMs` bound, optionally combined with an outer AbortSignal
 * (whichever fires first wins) — shared by embedding-client.ts's per-batch
 * 60s bound (mirroring v1's per-request `httpx` `timeout=60` alongside this
 * port's whole-build 1800s AbortController) and semantic-search.ts's
 * one-shot query timeout, which has no outer signal to combine with. Built
 * by hand with `setTimeout` + `AbortController` (rather than
 * `AbortSignal.timeout()`, whose internal timer isn't driven by fake-timer
 * mocking in tests) so it composes uniformly through `AbortSignal.any` and
 * stays deterministically testable. Caller must invoke the returned `clear`
 * once the request settles, so a fast call doesn't leave a timer dangling.
 */
export function withTimeout(
  timeoutMs: number,
  outerSignal?: AbortSignal,
): { signal: AbortSignal; clear: () => void } {
  const ownController = new AbortController();
  const timer = setTimeout(() => ownController.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: outerSignal ? AbortSignal.any([outerSignal, ownController.signal]) : ownController.signal,
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
  // Codex full-repo review (2026-07-14, Warning): `clear` used to run in a
  // `finally` right after fetch()'s own promise resolved (response headers
  // arrived), leaving the subsequent resp.json() completely unbounded — a
  // slow/stalled body could hang past BATCH_TIMEOUT_MS indefinitely. Now
  // wraps BOTH fetch() and resp.json() in one outer try/finally so the
  // timer (and the abort it can still fire) stays armed through body
  // consumption too — see fetchWithTimeout's own comment
  // (issue-tracker-client.ts) for why leaving it un-cleared through a fast
  // call is harmless (already unref()'d).
  const { signal: requestSignal, clear } = withTimeout(BATCH_TIMEOUT_MS, signal);
  try {
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
  } finally {
    clear();
  }
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
  isStillLatest: () => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const hashes = chunks.map((c) => chunkHash(c));
  const dims = settings.embeddingDimensions;

  // A hash reused from the old index is only valid if its cached vector
  // actually has the CURRENT dimensionality — otherwise (e.g. after an
  // APP_EMBEDDING_DIMENSIONS or embedding_model change) it must be
  // re-embedded like any other new chunk, not left as a stale-shape vector
  // that silently passes the hash check on every future rebuild too.
  // Same reasoning for the model fingerprint: a same-dimension model swap
  // wouldn't be caught by the dims check above, so gate reuse on it too —
  // an unknown/missing fingerprint (pre-existing index from before this
  // check existed) is treated as a mismatch, not an automatic pass.
  const modelMatches = readModelFingerprint(repoPath) === currentModelFingerprint(settings);
  const oldIndex = modelMatches ? readEmbeddingIndex(repoPath) : null;
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

  // Codex full-repo review (2026-07-14, Warning): a rebuild's expensive
  // embedding calls deliberately run outside the repo lock (see
  // repo-sync.ts's runIndexBuild comment) so a slow cold build doesn't
  // block subsequent syncs — but that means two overlapping rebuilds for
  // the SAME repo (a manual re-sync landing while a periodic sync's build
  // is still in flight) can both reach here, and whichever finishes LAST
  // used to win unconditionally regardless of which one reflects the
  // actual latest checkout. Bail before spending any API calls if a newer
  // rebuild has since started for this repo.
  if (!isStillLatest()) return false;

  // Reported against the FULL chunk count, not just `todo` — a rebuild that
  // reuses most vectors by hash (the common case, see `reusable` above)
  // should read as already near-done, not restart from 0/todo.length; a
  // genuinely cold build (nothing cached) has done===0 here and climbs
  // exactly like todo.length would.
  let done = chunks.length - todo.length;
  onProgress?.(done, chunks.length);

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
        done += batchIndices.length;
      }
      onProgress?.(done, chunks.length);
    }
  }

  // The real correctness guard (the check above is just a cheap early
  // exit): re-checked right before publish, since the whole point is that
  // ANOTHER rebuild could have started (and even finished) during the
  // embed calls above, which just spent real minutes on the network.
  if (!isStillLatest()) return false;

  const normalized = vectors.map((v) => l2Normalize(v));
  const meta: EmbeddingChunkMeta[] = chunks.map((c, i) => ({
    path: c.path,
    start: c.start,
    end: c.end,
    name: c.name,
    hash: hashes[i],
  }));

  writeEmbeddingIndex(repoPath, { dims, vectors: normalized, meta });
  writeModelFingerprint(repoPath, currentModelFingerprint(settings));
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
  // Codex full-repo review (2026-07-14, Warning): optional and
  // defaulting to "always latest" so the many existing callers (tests,
  // and any future one-shot caller that doesn't have overlapping-rebuild
  // concerns) don't need to be touched — only repo-sync.ts's periodic
  // rebuild path passes a real generation check.
  isStillLatest: () => boolean = () => true,
  // 2026-07-15: optional for the same reason as isStillLatest above — most
  // callers (tests, one-shot use) don't care to observe progress, only
  // repo-sync.ts's runIndexBuild passes a real callback to publish
  // embed_index_done/total as the build advances.
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const key = embeddingKeyOrFallback(settings);
  if (!key || chunks.length === 0) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILD_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await doEmbedAndSave(repoPath, chunks, settings, key, controller.signal, isStillLatest, onProgress);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Test-only escape hatch (matches symbol-index.ts's buildIndexWithBin /
// semantic-search.ts's __internal pattern) — lets reuse tests seed a
// fingerprint sidecar matching the settings they pass to embedAndSaveIndex,
// without duplicating the fingerprint string format in the test itself.
export const __internal = { currentModelFingerprint, writeModelFingerprint };
