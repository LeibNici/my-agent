"""Semantic code search — embedding-based retrieval over repo code.

The retrieval gap this fills: users describe problems in business Chinese
(「不合格评审」「报工人员显示姓名」), but the relevant code often carries only
English identifiers (QcDispositionReview, toReportEmployee). code_search is a
fixed-string grep and find_symbol needs an identifier the model already
knows — when neither literal bridge exists, recall collapses into keyword
guessing. Embeddings bridge the vocabulary gap: chunks of code (with their
file path and symbol names as context) and the user's business-language query
land near each other in vector space even with zero literal overlap.

Design, mirroring the ctags symbol index this builds on:
- Chunking REUSES the ctags sidecar (symbol_index._load_tags): a chunk spans
  from one chunkable symbol (function/method/class/interface) to the next,
  capped at _MAX_CHUNK_LINES. MyBatis mapper XML (which ctags can't parse but
  holds the SQL the backend behavior hinges on) gets fixed-window chunks.
- Embeddings come from an OpenAI-compatible /embeddings endpoint (DashScope
  in production — the same account/key as the LLM; see app/config.py).
- The index is a sidecar next to the checkout (<local_path>.emb.npz — float32
  vectors + JSON metadata), outside the git tree, path realpath-normalized
  for the same writer/reader-agreement reason as the ctags sidecar.
- Incremental: chunks are keyed by content hash; a rebuild only embeds chunks
  whose hash is new, so the 10-minute sync loop costs ~nothing when the repo
  didn't change.
- Everything degrades gracefully: no key / no index / API failure → the tool
  says so and points at code_search/find_symbol instead of raising.
"""

import asyncio
import hashlib
import io
import json
import os
import sqlite3
import time
from datetime import datetime
from urllib.parse import urlparse

import httpx
import numpy as np

from app.config import settings, app_settings
from app.database import DB_PATH
from app.tools.access import get_allowed_paths, get_tool_user_id, no_access_reason
from app.tools.registry import tool
from app.tools.symbol_index import _index_path as _tags_path, _load_tags

_CHUNK_KINDS = {"function", "method", "class", "interface", "enum"}
_MAX_CHUNK_LINES = 120
_MIN_CHUNK_LINES = 3
_MAX_CHUNK_CHARS = 6000  # keep well under the embedding model's input cap
_XML_WINDOW_LINES = 80
_EMBED_BATCH = 10        # DashScope text-embedding-v4 batch limit
_BUILD_TIMEOUT_SECONDS = 1800


def embedding_key_or_fallback() -> str:
    """Dedicated key if configured. Otherwise reuse the LLM's ANTHROPIC_API_KEY
    ONLY when it's genuinely the same account — i.e. embedding_base_url and
    the LLM's base_url resolve to the same host (true for this deployment,
    where both point at DashScope). Blindly reusing the key regardless of
    host would send the Anthropic credential (and every embedded code chunk)
    to whatever third party embedding_base_url names — a real credential
    leak for any deployment on the official Anthropic API or a different
    provider. Without a host match, semantic search just stays disabled
    until APP_EMBEDDING_API_KEY is set explicitly."""
    if app_settings.embedding_api_key:
        return app_settings.embedding_api_key
    llm_host = urlparse(settings.base_url).hostname or ""
    embed_host = urlparse(app_settings.embedding_base_url).hostname or ""
    if llm_host and llm_host == embed_host:
        return settings.api_key
    return ""


def _emb_path(repo_path: str) -> str:
    return os.path.realpath(repo_path).rstrip(os.sep) + ".emb.npz"


# ==================== Chunking ====================

def _chunk_file_by_symbols(repo_path: str, rel_path: str, tags: list[dict]) -> list[dict]:
    """Chunks = spans between consecutive chunkable symbols, from the ctags
    data we already have. A span longer than _MAX_CHUNK_LINES is split into
    multiple consecutive chunks rather than truncated — a >120-line function
    body, or a long file preamble (license header/import block), must still
    end up somewhere in the index instead of having its tail silently
    excluded from semantic search with no indication of the gap.
    Returns [{path, start, end, name, text}]."""
    abs_path = os.path.join(repo_path, rel_path)
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    if not lines:
        return []

    anchors = sorted(
        {t["line"]: t["name"] for t in tags
         if t.get("kind") in _CHUNK_KINDS and isinstance(t.get("line"), int)}.items()
    )
    if not anchors:
        return []

    chunks = []

    def add_span(start: int, end: int, name: str):
        pos = start
        while pos <= end:
            chunk_end = min(pos + _MAX_CHUNK_LINES - 1, end)
            if chunk_end - pos + 1 >= _MIN_CHUNK_LINES:
                text = "".join(lines[pos - 1:chunk_end])[:_MAX_CHUNK_CHARS]
                if text.strip():
                    chunks.append({"path": rel_path, "start": pos, "end": chunk_end, "name": name, "text": text})
            pos = chunk_end + 1

    first_line = anchors[0][0]
    if first_line > 1:
        # File preamble (imports, file-level config) — its own span now,
        # covered regardless of length, instead of only riding along with
        # the first symbol's chunk when short enough to fit alongside it.
        add_span(1, first_line - 1, "")

    for i, (line, name) in enumerate(anchors):
        next_start = anchors[i + 1][0] if i + 1 < len(anchors) else len(lines) + 1
        add_span(line, next_start - 1, name)
    return chunks


def _chunk_xml_windows(repo_path: str, rel_path: str) -> list[dict]:
    abs_path = os.path.join(repo_path, rel_path)
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return []
    chunks = []
    for start in range(1, len(lines) + 1, _XML_WINDOW_LINES):
        end = min(start + _XML_WINDOW_LINES - 1, len(lines))
        text = "".join(lines[start - 1:end])[:_MAX_CHUNK_CHARS]
        if text.strip():
            chunks.append({"path": rel_path, "start": start, "end": end, "name": "", "text": text})
    return chunks


def _collect_chunks(repo_path: str) -> list[dict]:
    tags = _load_tags(repo_path)
    if tags is None:
        return []
    by_file: dict[str, list[dict]] = {}
    for t in tags:
        by_file.setdefault(t.get("path", ""), []).append(t)

    chunks = []
    for rel_path, file_tags in by_file.items():
        if rel_path:
            chunks.extend(_chunk_file_by_symbols(repo_path, rel_path, file_tags))

    # MyBatis mapper XML — the SQL layer ctags can't see. followlinks=False
    # (the default, kept explicit) stops os.walk from recursing into a
    # symlinked subdirectory, but it still lists a symlinked FILE inside an
    # otherwise-real directory — os.path.islink() below rejects those before
    # they're ever opened. Without it, a repo (synced from an admin-supplied
    # URL, not otherwise sandboxed) could smuggle e.g.
    # resources/mapper/leak.xml -> /etc/passwd and have that file's real
    # contents read, chunked, and sent to the embedding provider.
    for root, dirs, files in os.walk(repo_path, followlinks=False):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"
                   and not os.path.islink(os.path.join(root, d))]
        for fn in files:
            if fn.endswith(".xml") and "resources" in root and "mapper" in (root + fn).lower():
                abs_fn = os.path.join(root, fn)
                if os.path.islink(abs_fn):
                    continue
                rel = os.path.relpath(abs_fn, repo_path)
                chunks.extend(_chunk_xml_windows(repo_path, rel))
    return chunks


def _chunk_hash(chunk: dict) -> str:
    key = f"{chunk['path']}|{chunk['name']}|{chunk['text']}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]


def _embed_input(chunk: dict) -> str:
    # Path + symbol name give the embedding the naming context the raw body
    # may lack ("MobileDispositionReview.vue" itself carries meaning).
    return f"{chunk['path']} {chunk['name']}\n{chunk['text']}"


# ==================== Embedding client ====================

async def _embed_batch(client: httpx.AsyncClient, texts: list[str]) -> list[list[float]] | None:
    resp = await client.post(
        f"{app_settings.embedding_base_url}/embeddings",
        headers={"Authorization": f"Bearer {embedding_key_or_fallback()}"},
        json={"model": app_settings.embedding_model, "input": texts,
              "dimensions": app_settings.embedding_dimensions, "encoding_format": "float"},
        timeout=60,
    )
    if resp.status_code != 200:
        return None
    data = resp.json().get("data", [])
    if len(data) != len(texts):
        return None
    return [d["embedding"] for d in sorted(data, key=lambda d: d["index"])]


# ==================== Index build ====================
#
# Split into two phases with different concurrency-safety needs, so a caller
# (repo_sync._background_build_index) can hold the per-repo sync lock for
# only the fast one:
#   1. collect_index_chunks() — reads files out of the checkout (via the
#      ctags sidecar + raw file reads). Fast (seconds), but unsafe to run
#      concurrently with a reclone that might rmtree the checkout mid-read —
#      needs the repo lock.
#   2. embed_and_save_index() — takes already-extracted chunk TEXT, never
#      touches repo_path again. Slow (minutes, dominated by embedding API
#      round trips), but doesn't need the lock at all: it can't be corrupted
#      by a concurrent git operation because it isn't reading the checkout.
# Holding the lock across both (the original design) meant a slow embedding
# build blocked every subsequent sync attempt for that repo for its entire
# duration — this split removes that block.


def collect_index_chunks(repo_path: str) -> list[dict]:
    """Phase 1 (fast, needs the repo lock): chunk the checkout via the ctags
    sidecar + MyBatis XML windows. Pure file I/O, no network calls."""
    return _collect_chunks(repo_path)


async def embed_and_save_index(repo_path: str, chunks: list[dict]) -> bool:
    """Phase 2 (slow, does NOT need the repo lock): diff against the saved
    index by chunk hash, embed only what's new, write the sidecar. Bounded by
    _BUILD_TIMEOUT_SECONDS so a degraded embedding endpoint can't hang
    forever. Best-effort: returns False on any failure/timeout, never raises."""
    if not embedding_key_or_fallback() or not chunks:
        return False
    try:
        return await asyncio.wait_for(_embed_and_save(repo_path, chunks), timeout=_BUILD_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, Exception):
        return False


async def _embed_and_save(repo_path: str, chunks: list[dict]) -> bool:
    hashes = [_chunk_hash(c) for c in chunks]

    old_vectors: dict[str, np.ndarray] = {}
    emb_path = _emb_path(repo_path)
    if os.path.exists(emb_path):
        try:
            with np.load(emb_path, allow_pickle=False) as z:
                old_meta = json.loads(str(z["meta_json"]))
                old_arr = z["vectors"]
            for i, m in enumerate(old_meta):
                old_vectors[m["hash"]] = old_arr[i]
        except Exception:
            old_vectors = {}

    dims = app_settings.embedding_dimensions
    # A hash reused from the old index is only valid if its cached vector
    # actually has the CURRENT dimensionality — otherwise (e.g. after an
    # APP_EMBEDDING_DIMENSIONS or embedding_model change) it must be
    # re-embedded like any other new chunk, not left as a zero vector that
    # silently passes the shape check on every future rebuild too.
    reusable = {h: v for h, v in old_vectors.items() if v.shape[0] == dims}
    todo = [(i, h) for i, h in enumerate(hashes) if h not in reusable]
    vectors = np.zeros((len(chunks), dims), dtype=np.float32)
    for i, h in enumerate(hashes):
        if h in reusable:
            vectors[i] = reusable[h]

    if todo:
        # Modest concurrency (4 in-flight batches) — cuts a cold build of
        # a 25k-chunk repo from ~10min to ~3min without hammering the
        # provider's rate limits.
        _CONCURRENCY = 4
        async with httpx.AsyncClient() as client:
            batches = [todo[s:s + _EMBED_BATCH] for s in range(0, len(todo), _EMBED_BATCH)]
            for wave_start in range(0, len(batches), _CONCURRENCY):
                wave = batches[wave_start:wave_start + _CONCURRENCY]
                results = await asyncio.gather(*(
                    _embed_batch(client, [_embed_input(chunks[i]) for i, _ in b]) for b in wave
                ))
                for b, embs in zip(wave, results):
                    if embs is None:  # API hiccup — keep what we got, fail the build
                        return False
                    for (i, _), e in zip(b, embs):
                        vectors[i] = np.asarray(e, dtype=np.float32)

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors = vectors / norms

    meta = [{"path": c["path"], "start": c["start"], "end": c["end"],
             "name": c["name"], "hash": h} for c, h in zip(chunks, hashes)]
    buf = io.BytesIO()
    np.savez_compressed(buf, vectors=vectors, meta_json=json.dumps(meta, ensure_ascii=False))
    tmp = emb_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(buf.getvalue())
    os.replace(tmp, emb_path)
    return True


async def build_semantic_index(repo_path: str) -> bool:
    """Convenience wrapper running both phases back to back — for direct/
    manual/test callers that don't care about lock semantics. The sync flow
    (repo_sync._background_build_index) calls collect_index_chunks() and
    embed_and_save_index() separately instead, so it only holds the repo
    lock for the fast phase."""
    chunks = collect_index_chunks(repo_path)
    if not chunks:
        return False
    return await embed_and_save_index(repo_path, chunks)


# ==================== Query ====================

# mtime-keyed in-process cache, same pattern as symbol_index._TAGS_CACHE.
_EMB_CACHE: dict[str, tuple[float, np.ndarray, list[dict]]] = {}


def _load_emb(repo_path: str) -> tuple[np.ndarray, list[dict]] | None:
    emb_path = _emb_path(repo_path)
    try:
        mtime = os.path.getmtime(emb_path)
    except OSError:
        return None
    cached = _EMB_CACHE.get(emb_path)
    if cached is not None and cached[0] == mtime:
        return cached[1], cached[2]
    try:
        with np.load(emb_path, allow_pickle=False) as z:
            vectors = z["vectors"]
            meta = json.loads(str(z["meta_json"]))
    except Exception:
        return None
    _EMB_CACHE[emb_path] = (mtime, vectors, meta)
    return vectors, meta


@tool("Semantic code search — find code by MEANING, not by literal text. Give it a natural-language "
      "description (Chinese business terms work well: e.g. '不合格评审列表合并', '报工人员姓名显示') and it "
      "returns the code chunks whose behavior best matches, even when the code itself only uses English "
      "identifiers. Use this FIRST when you only have a business-level description and don't yet know any "
      "identifier or UI string to grep for; then verify with file_reader. code_search remains better for "
      "exact strings/identifiers you already know, find_symbol for jumping to a known symbol's definition.")
def semantic_search(query: str, max_results: int = 8) -> str:
    allowed_paths = get_allowed_paths()
    if not allowed_paths:
        return no_access_reason(prefix="Error")
    if not embedding_key_or_fallback():
        return "语义检索未启用（未配置 embedding API key）。请改用 code_search / find_symbol。"

    started = time.perf_counter()
    # Sync tool (registry offloads to a thread) — use a blocking client here.
    resp = httpx.post(
        f"{app_settings.embedding_base_url}/embeddings",
        headers={"Authorization": f"Bearer {embedding_key_or_fallback()}"},
        json={"model": app_settings.embedding_model, "input": [query[:2000]],
              "dimensions": app_settings.embedding_dimensions, "encoding_format": "float"},
        timeout=30,
    )
    if resp.status_code != 200:
        return f"语义检索暂不可用（embedding API {resp.status_code}）。请改用 code_search / find_symbol。"
    q = np.asarray(resp.json()["data"][0]["embedding"], dtype=np.float32)
    qn = np.linalg.norm(q)
    if qn > 0:
        q = q / qn

    hits = []
    any_index = False
    for repo_path in allowed_paths:
        loaded = _load_emb(repo_path)
        if loaded is None:
            continue
        any_index = True
        vectors, meta = loaded
        if vectors.shape[0] == 0 or vectors.shape[1] != q.shape[0]:
            continue
        scores = vectors @ q
        top = np.argsort(-scores)[:max_results]
        repo_name = os.path.basename(repo_path)
        for i in top:
            m = meta[int(i)]
            hits.append({
                "score": float(scores[int(i)]), "repo_id": repo_name,
                "path": m["path"], "start": m["start"], "end": m["end"], "name": m.get("name") or "",
            })

    if not any_index:
        return ("语义索引尚未构建（仓库同步后会在后台自动构建，首次需要几分钟）。"
                "请先用 code_search / find_symbol。")

    hits.sort(key=lambda h: -h["score"])
    top_hits = hits[:max_results]
    _log_search(query, top_hits, int((time.perf_counter() - started) * 1000))

    if not hits:
        return f"没有与「{query}」语义相近的代码块。换个说法试试，或改用 code_search。"

    lines = [f"{h['score']:.3f}  {h['repo_id']}/{h['path']}:{h['start']}-{h['end']}"
             + (f" ({h['name']})" if h["name"] else "") for h in top_hits]
    return (f"与「{query}」语义最相近的代码位置（分值越高越相关，建议用 file_reader 查看确认）：\n"
            + "\n".join(lines))


def _log_search(query: str, top_hits: list[dict], duration_ms: int) -> None:
    """Best-effort recall-quality log for the admin 语义检索 dashboard — never
    lets a logging failure affect the tool's actual return value. Uses a raw
    blocking sqlite3 connection rather than database.py's aiosqlite helpers:
    this function runs inside the worker thread the registry offloads sync
    tools to (asyncio.to_thread), with no event loop here to await against.
    WAL mode + busy_timeout (set the same way database.py's _connect does)
    make this safe alongside the app's normal async connections."""
    try:
        top1 = top_hits[0] if top_hits else None
        repo_id = int(top1["repo_id"]) if top1 and str(top1["repo_id"]).isdigit() else None
        results_json = json.dumps(
            [{"repo_id": h["repo_id"], "path": h["path"], "start": h["start"],
              "end": h["end"], "name": h["name"], "score": round(h["score"], 4)} for h in top_hits],
            ensure_ascii=False,
        )
        conn = sqlite3.connect(DB_PATH, timeout=5)
        try:
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute(
                "INSERT INTO semantic_search_log "
                "(user_id, repo_id, query, result_count, top1_score, results_json, duration_ms, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (get_tool_user_id(), repo_id, query[:500], len(top_hits),
                 top1["score"] if top1 else None, results_json, duration_ms, datetime.now().isoformat()),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
