// Phase 4b Task 4: semantic-search.ts — cross-repo cosine top-k over the
// embedding sidecars (embed-store.ts) + a best-effort recall-quality log.
// Ported from v1-python-final:app/tools/semantic_index.py's semantic_search
// and _log_search, verbatim in behavior — see that file's module docstring
// for the retrieval-gap rationale (business-Chinese queries vs.
// English-identifier code). Reuses Task 1-3's pieces: embed-store.ts
// (readEmbeddingIndex) for the per-repo sidecars, embedding-client.ts
// (embeddingKeyOrFallback for the same host-matched credential-reuse rule
// index building uses; l2Normalize for the same zero-vector-safe
// normalization, exported by this task rather than re-implemented locally —
// see that file's l2Normalize doc comment), chunking.ts (truncateChars) for
// the same
// codepoint-safe truncation Task 2's self-review fixed for chunk bodies —
// reused here for the query[:2000]/query[:500] truncations v1 does with
// Python's codepoint-based str slicing (JS's String.slice counts UTF-16
// code units, which can bisect an astral-plane character into a lone
// surrogate; see chunking.ts's truncateChars doc for the confirmed repro).
//
// Settings: this is the first ToolDef in the registry that needs runtime
// config (embeddingBaseUrl/Model/Dimensions, the LLM/embedding keys for
// embeddingKeyOrFallback's host-match) rather than only ctx. Every other
// consumer of Settings in this codebase (auth.ts, embedding-client.ts,
// RunTurnDeps) takes it as an explicit parameter — but a side-effect-
// registered ToolDef's `execute(input, ctx)` signature has no slot for it.
// This mirrors v1's own resolution: `from app.config import settings,
// app_settings` imports module-level singletons, instantiated once when
// the module first loads. Tests never exercise the real singleton for
// behavior assertions: runSemanticSearch takes `settings` as an explicit
// parameter (like embeddingKeyOrFallback/embedAndSaveIndex), so tests
// inject a controlled Settings object directly, the same `__internal`-style
// escape hatch symbol-index.ts's buildIndexWithBin uses to let tests inject
// a fake ctagsBin instead of depending on PATH.
//
// 2026-07-15 production bug: SETTINGS below used to be loaded ONCE at
// import time and never touched again — treated the same as symbol-index.ts's
// CTAGS_BIN/code-search.ts's RG_BIN, which really are static externalities
// that can't change after process start. Settings isn't one of those:
// main.ts merges an admin-configured DB llm_config (Admin → LLM 配置) into
// its own Settings object AFTER this module has already loaded and computed
// its own separate loadSettings() from just .env — a real config change
// (moving ANTHROPIC_* off .env onto that DB config) landed without this
// module getting a way to see it. repo-sync.ts's indexing path has the same
// "Settings assembled after module load" problem and already solved it
// (configureIndexing, called from main.ts once the DB merge is done) — that
// export function ran, so index BUILDING picked up the DB key and worked
// fine. This module had no equivalent hook, so semanticSearchExecute kept
// calling runSemanticSearch with an apiKey-less Settings forever, which
// silently returns the "语义检索未启用" no-key message (see below) — no
// exception, no log line, so "semantic search doesn't work" had nothing an
// operator could grep for. configureSemanticSearch is that missing hook,
// called from main.ts right next to configureIndexing.
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef, type ToolContext } from "./registry.js";
import { getAllowedPaths, getToolUserId, noAccessReason } from "./access.js";
import {
  embeddingKeyOrFallback,
  l2Normalize,
  withTimeout,
  currentModelFingerprint,
  readModelFingerprint,
} from "./embedding-client.js";
import { readEmbeddingIndex } from "./embed-store.js";
import { truncateChars } from "./chunking.js";
import { loadSettings, type Settings } from "../config.js";
import { pythonJsonDumps, PyFloat } from "../db/py-compat.js";

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const SemanticSearchParams = Type.Object({
  query: Type.String(),
  max_results: Type.Optional(Type.Integer()),
});

const DEFAULT_MAX_RESULTS = 8;
const QUERY_TIMEOUT_MS = 30_000; // v1's httpx.post(..., timeout=30)

// ---------------------------------------------------------------------------
// degradation messages — byte-exact ports of v1's three Chinese strings
// ---------------------------------------------------------------------------

const NO_KEY_MESSAGE = "语义检索未启用（未配置 embedding API key）。请改用 code_search / find_symbol。";
const NO_INDEX_ANYWHERE_MESSAGE =
  "语义索引尚未构建（仓库同步后会在后台自动构建，首次需要几分钟）。请先用 code_search / find_symbol。";

function apiUnavailableMessage(status: number): string {
  return `语义检索暂不可用（embedding API ${status}）。请改用 code_search / find_symbol。`;
}

// 2026-07-15: the "no index" degradation used to be one static string
// regardless of whether the build had never started, was 5% through a
// 30-minute cold build, or had already finished and failed — repo-sync.ts's
// embed_index_status/done/total (see schema.ts) now exist specifically so
// this can say something the caller can act on ("try again in a bit" vs.
// "this repo's build failed, an admin should look"). Matches allowedPaths
// back to a repo id via ctx.grantedRepos' localPath, realpath'd the same
// way getAllowedPaths does — this tool only ever sees repos the current
// turn already has permission for, so no extra access check is needed here.
// Degrades to the old static message if ctx.db/grantedRepos are absent
// (existing tests, or a caller that never wired them up) or nothing in the
// DB says otherwise (repo row missing, or a build that finished cleanly but
// still left an empty index — see the caller's own comment on that case).
async function buildNoIndexMessage(ctx: ToolContext, allowedPaths: string[]): Promise<string> {
  if (!ctx.db || !ctx.grantedRepos) return NO_INDEX_ANYWHERE_MESSAGE;

  const repoIdByRealPath = new Map<string, number>();
  for (const g of ctx.grantedRepos) {
    if (!g.localPath) continue;
    let real: string;
    try {
      real = fs.realpathSync(g.localPath);
    } catch {
      real = path.resolve(g.localPath);
    }
    repoIdByRealPath.set(real, g.id);
  }

  let building: { done: number | null; total: number | null } | null = null;
  let anyFailed = false;
  for (const repoPath of allowedPaths) {
    const id = repoIdByRealPath.get(repoPath);
    if (id === undefined) continue;
    const repo = await ctx.db.getRepoAdmin(id);
    if (!repo) continue;
    if (repo.embed_index_status === "building") {
      building = { done: repo.embed_index_done, total: repo.embed_index_total };
      break; // most specific/actionable state — stop looking
    }
    if (repo.embed_index_status === "failed") anyFailed = true;
  }

  if (building) {
    const pct =
      building.done != null && building.total ? Math.round((building.done / building.total) * 100) : null;
    const progress = pct !== null ? `（已处理 ${building.done}/${building.total}，约 ${pct}%）` : "";
    return `语义索引构建中${progress}，请先用 code_search / find_symbol，稍后再试。`;
  }
  if (anyFailed) {
    return "语义索引上次构建失败，会在下次仓库同步时自动重试。请先用 code_search / find_symbol。";
  }
  return NO_INDEX_ANYWHERE_MESSAGE;
}

function zeroHitsMessage(query: string): string {
  return `没有与「${query}」语义相近的代码块。换个说法试试，或改用 code_search。`;
}

// ---------------------------------------------------------------------------
// query embedding — a dedicated, simpler call than embedding-client.ts's
// batch build path: single-element `input`, no incremental hash-diff, no
// multi-batch concurrency, and (matching v1 exactly — semantic_search's own
// httpx.post call has NO surrounding try/except, unlike _embed_and_save's
// build path) a network-level throw here is NOT swallowed — it propagates
// out of runSemanticSearch to the registry's own catch-all backstop
// (toPiTools, matching v1 registry.execute_tool's outer try/except), same
// as v1. Only a non-200 response gets the dedicated Chinese degradation
// message; embed-store's own malformed-response indexing (data[0].embedding)
// is left unguarded too, matching v1's unguarded resp.json()["data"][0].
// ---------------------------------------------------------------------------

// Codex full-repo review (2026-07-14, Warning): the timer used to be
// cleared as soon as fetch() itself resolved (response headers arrived),
// leaving the caller's subsequent .json() call on the returned
// response completely unbounded. Deliberately not clearing it here — the
// same AbortSignal that guards fetch() also aborts an in-flight
// body-reading call on the result (WHATWG fetch spec) — so it stays armed
// through whatever the caller does with the body next. See
// issue-tracker-client.ts's fetchWithTimeout for why leaving it un-cleared
// through a fast call is harmless (the underlying timer is already
// unref()'d).
async function fetchQueryEmbedding(query: string, settings: Settings, key: string): Promise<{ status: number; json: () => Promise<unknown> }> {
  const { signal } = withTimeout(QUERY_TIMEOUT_MS);
  return fetch(`${settings.embeddingBaseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      input: [truncateChars(query, 2000)],
      dimensions: settings.embeddingDimensions,
      encoding_format: "float",
    }),
    signal,
  });
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

// ---------------------------------------------------------------------------
// hits
// ---------------------------------------------------------------------------

type Hit = { score: number; repoId: string; path: string; start: number; end: number; name: string };

/** v1: `repo_id = int(top1["repo_id"]) if top1 and str(top1["repo_id"]).isdigit() else None`
 * — repoId here is `path.basename(repoPath)` (the checkout DIRECTORY NAME,
 * a string), NOT a real `repositories.id`. Ported as-is ("not quite right
 * but that's the existing behavior" — see the task brief): only stored as
 * a number in the log's repo_id column when it's a valid non-negative
 * integer string, else null. Not "fixed" into something cleaner. */
function repoIdForLog(repoIdStr: string): number | null {
  return /^[0-9]+$/.test(repoIdStr) ? Number(repoIdStr) : null;
}

/** v1's _log_search — best-effort, NEVER lets a logging failure affect the
 * tool's actual return value (a synchronously-throwing OR asynchronously-
 * rejecting ctx.db.recordSemanticSearchLog are both caught here). No-ops
 * entirely when ctx.db is absent (Task 8 hasn't wired a real DbClient into
 * every ToolContext yet; also matches v1's own "logging is best-effort,
 * never load-bearing" design even once it is). */
async function logSearchBestEffort(
  ctx: ToolContext,
  query: string,
  topHits: Hit[],
  durationMs: number,
): Promise<void> {
  if (!ctx.db) return;
  try {
    const top1 = topHits.length > 0 ? topHits[0] : null;
    const resultsJson = pythonJsonDumps(
      topHits.map((h) => ({
        repo_id: h.repoId,
        path: h.path,
        start: h.start,
        end: h.end,
        name: h.name,
        // v1: round(h["score"], 4) — a Python float, so json.dumps renders
        // a whole-valued score (e.g. two axis-aligned unit vectors -> a
        // perfect 1.0 cosine similarity) as "1.0", not "1". PyFloat carries
        // that distinction through pythonJsonDumps, which otherwise has no
        // way to tell this apart from a genuinely-int field like start/end.
        score: new PyFloat(Math.round(h.score * 10000) / 10000),
      })),
    );
    await ctx.db.recordSemanticSearchLog({
      userId: getToolUserId(ctx),
      repoId: top1 ? repoIdForLog(top1.repoId) : null,
      query: truncateChars(query, 500),
      resultCount: topHits.length,
      top1Score: top1 ? top1.score : null,
      resultsJson,
      durationMs,
    });
  } catch {
    // Best-effort only — a logging failure must never surface to the caller.
  }
}

// ---------------------------------------------------------------------------
// semantic_search — the query tool itself
// ---------------------------------------------------------------------------

async function runSemanticSearch(
  input: Static<typeof SemanticSearchParams>,
  ctx: ToolContext,
  settings: Settings,
): Promise<string> {
  const allowedPaths = getAllowedPaths(ctx);
  if (allowedPaths.length === 0) {
    return noAccessReason(ctx, "Error");
  }

  const key = embeddingKeyOrFallback(settings);
  if (!key) {
    return NO_KEY_MESSAGE;
  }

  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

  // v1: `started = time.perf_counter()` immediately precedes the httpx.post
  // call — duration_ms covers the query-embed round trip AND the local
  // per-repo vector search loop below, up to the _log_search call site.
  const started = Date.now();

  const resp = await fetchQueryEmbedding(input.query, settings, key);
  if (resp.status !== 200) {
    return apiUnavailableMessage(resp.status);
  }
  // v1 indexes resp.json()["data"][0]["embedding"] with no defensive
  // checks — a malformed response throws (KeyError/IndexError there,
  // TypeError here), propagating to the registry's outer catch-all exactly
  // like a network failure would. Ported as unguarded on purpose.
  const payload = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  let q = Float32Array.from(payload.data[0].embedding);
  q = l2Normalize(q);

  // Codex full-repo review (2026-07-14, Warning): dims alone doesn't prove
  // an index was built by the CURRENT embedding model — a same-dimension
  // model swap (e.g. APP_EMBEDDING_MODEL changed to a different model that
  // happens to also emit the same-length vectors) would otherwise pass the
  // dims check below and get scored anyway, silently mixing two unrelated
  // vector spaces in one cosine comparison. embedAndSaveIndex already
  // writes this fingerprint sidecar on every successful build (used there
  // to decide full-rebuild-vs-incremental-reuse) — reused here as the same
  // identity check, applied at query time.
  const expectedFingerprint = currentModelFingerprint(settings);

  const hits: Hit[] = [];
  let anyIndex = false;
  for (const repoPath of allowedPaths) {
    const idx = readEmbeddingIndex(repoPath);
    if (idx === null) continue;
    anyIndex = true; // an index file exists, even if empty/dims-mismatched/stale-model
    if (idx.vectors.length === 0 || idx.dims !== q.length) continue;
    if (readModelFingerprint(repoPath) !== expectedFingerprint) continue;

    const repoName = path.basename(repoPath);
    const scored = idx.vectors.map((vec, i) => ({ score: dot(vec, q), i }));
    scored.sort((a, b) => b.score - a.score);
    for (const { score, i } of scored.slice(0, maxResults)) {
      const m = idx.meta[i];
      hits.push({ score, repoId: repoName, path: m.path, start: m.start, end: m.end, name: m.name || "" });
    }
  }

  if (!anyIndex) {
    return await buildNoIndexMessage(ctx, allowedPaths);
  }

  hits.sort((a, b) => b.score - a.score);
  const topHits = hits.slice(0, maxResults);
  const durationMs = Date.now() - started;

  // v1 order preserved exactly: the log write happens BEFORE the zero-hits
  // check, so a zero-hit search (any_index true, no matches) still logs a
  // result_count:0/top1_score:null row for the admin recall-quality
  // dashboard, not just a successful search.
  await logSearchBestEffort(ctx, input.query, topHits, durationMs);

  if (hits.length === 0) {
    return zeroHitsMessage(input.query);
  }

  // QA-reported (2026-07-13): joining repoId onto path with "/" reads as a
  // single reconstructable path — `file_reader`/`code_search` both expect
  // a bare relative path (resolvePath's own comment: "as returned by
  // code_search, which strips the repo prefix"), so the model was passing
  // this whole "repoId/path" string straight to file_reader and getting a
  // not-found. Confirmed as a v1-inherited format (semantic_index.py:405
  // did the exact same join), not a v2 regression — fixing it here rather
  // than perpetuating it. The repo tag is disambiguation info for when a
  // user has more than one granted repo; keep it, but bracket it OUTSIDE
  // the path instead of concatenating, and only show it when it's actually
  // needed (a single granted repo has no ambiguity to disambiguate).
  const lines = topHits.map((h) => {
    const loc = `${h.path}:${h.start}-${h.end}`;
    const repoTag = allowedPaths.length > 1 ? ` [repo ${h.repoId}]` : "";
    const base = `${h.score.toFixed(3)}  ${loc}${repoTag}`;
    return h.name ? `${base} (${h.name})` : base;
  });
  return (
    `与「${input.query}」语义最相近的代码位置（分值越高越相关，建议用 file_reader 查看确认）：\n` +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

// Defaults to a bare loadSettings() so an import that never goes through
// main.ts (existing tests, anything else that only touches the tool
// registry) still gets a value — main.ts overwrites this via
// configureSemanticSearch once its own Settings has the DB llm_config
// merged in. See the top-of-file 2026-07-15 comment for why this needs to
// be mutable rather than the `const` it used to be.
let SETTINGS: Settings = loadSettings();

export function configureSemanticSearch(settings: Settings): void {
  SETTINGS = settings;
}

async function semanticSearchExecute(
  input: Static<typeof SemanticSearchParams>,
  ctx: ToolContext,
): Promise<string> {
  return runSemanticSearch(input, ctx, SETTINGS);
}

export const semanticSearchTool: ToolDef<typeof SemanticSearchParams> = {
  name: "semantic_search",
  description:
    "Semantic code search — find code by MEANING, not by literal text. Give it a natural-language " +
    "description (Chinese business terms work well: e.g. '不合格评审列表合并', '报工人员姓名显示') and it " +
    "returns the code chunks whose behavior best matches, even when the code itself only uses English " +
    "identifiers. Use this FIRST when you only have a business-level description and don't yet know any " +
    "identifier or UI string to grep for; then verify with file_reader. code_search remains better for " +
    "exact strings/identifiers you already know, find_symbol for jumping to a known symbol's definition.",
  schema: SemanticSearchParams,
  execute: semanticSearchExecute,
};

registerTool(semanticSearchTool);

// Test-only surface — mirrors code-search.ts/symbol-index.ts's __internal
// escape hatch. runSemanticSearch takes Settings explicitly so tests never
// depend on (or need to mock) the real process-env-derived SETTINGS
// singleton above.
export const __internal = { runSemanticSearch, repoIdForLog, SETTINGS };
