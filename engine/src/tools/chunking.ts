// Task 2 (Phase 4b): chunking.ts — symbol-span chunking (reusing the ctags
// sidecar) + MyBatis XML window chunking. The input feed for semantic-search
// embeddings.
//
// Ported from v1-python-final:app/tools/semantic_index.py's
// _chunk_file_by_symbols, _chunk_xml_windows, _collect_chunks, _chunk_hash,
// verbatim in behavior — see that file's module docstring for the design
// rationale: a chunk spans from one ctags-chunkable symbol to the next,
// capped at MAX_CHUNK_LINES and split (not truncated) when a span runs
// long; MyBatis mapper XML, which ctags can't parse but holds the SQL the
// backend behavior hinges on, gets fixed 80-line windows instead.
//
// Reuses symbol-index.ts's loadTags/Tag, promoted from test-only __internal
// to real exports by this task — semantic indexing is a genuine production
// consumer, mirroring v1's
// `from app.tools.symbol_index import _index_path as _tags_path, _load_tags`.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { loadTags, type Tag } from "./symbol-index.js";
import { realpathOrResolve } from "./file-reader.js";

export type Chunk = { path: string; start: number; end: number; name: string; text: string };

const CHUNK_KINDS = new Set(["function", "method", "class", "interface", "enum"]);
const MAX_CHUNK_LINES = 120;
const MIN_CHUNK_LINES = 3;
const MAX_CHUNK_CHARS = 6000; // keep well under the embedding model's input cap
const XML_WINDOW_LINES = 80;

// ---------------------------------------------------------------------------
// Shared file-reading helper. Python's default text-mode open() does
// universal-newline translation on read ("\r\n"/lone "\r" -> "\n") before
// readlines() ever splits on them, and errors="replace" swaps invalid byte
// sequences for U+FFFD rather than raising; Node's toString("utf8") already
// does the latter, so only the newline normalization needs replicating here
// (same pattern as file-reader.ts's normalizeNewlines/splitKeepingNewlines,
// duplicated locally rather than imported — this codebase's precedent for a
// small helper with few call sites, per symbol-index.ts's detectCtagsBin
// comment).
// ---------------------------------------------------------------------------
function readLines(absPath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(absPath).toString("utf8");
  } catch {
    return [];
  }
  content = content.replace(/\r\n|\r/g, "\n");
  if (content === "") return [];
  return content.split(/(?<=\n)/);
}

// Python's `text[:_MAX_CHUNK_CHARS]` slices a `str` by Unicode CODE POINT —
// it can never split a character in two. JS's `String.prototype.slice`
// counts UTF-16 CODE UNITS instead: cutting exactly inside an astral-plane
// character's surrogate pair (an emoji, or some CJK Extension B+ characters
// plausible in this product's Chinese-business-content code/comments)
// leaves a lone surrogate, which is then silently replaced with U+FFFD the
// next time the string is encoded to UTF-8 (chunkHash below, and later the
// embedding-API request body) — a byte-level divergence from what the
// Python original would have produced for identical input. Confirmed with
// a live repro before writing this: `("a".repeat(5999) + "\u{1F600}" +
// "b".repeat(10)).slice(0, 6000)` ends in code unit 0xd83d (a lone high
// surrogate); Python's `("a"*5999 + chr(0x1F600) + "b"*10)[:6000]` keeps
// the emoji intact. Every UTF-16 code unit is at least one code point, so
// `text.length <= maxChars` already guarantees no truncation is needed
// (fast path, avoids the Array.from allocation on the common case).
export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join("");
}

// ---------------------------------------------------------------------------
// _chunk_file_by_symbols port
// ---------------------------------------------------------------------------

/**
 * Chunks = spans between consecutive chunkable symbols, from the ctags data
 * we already have. A span longer than MAX_CHUNK_LINES is split into
 * multiple consecutive chunks rather than truncated — a >120-line function
 * body, or a long file preamble (license header/import block), must still
 * end up somewhere in the index instead of having its tail silently
 * excluded from semantic search with no indication of the gap.
 */
function chunkFileBySymbols(repoPath: string, relPath: string, fileTags: Tag[]): Chunk[] {
  const absPath = path.join(repoPath, relPath);
  // ctags follows symlinks during its `-R .` scan (no `--links=no` in
  // CTAGS_ARGS), so a symlink committed into the repo can make relPath
  // resolve outside repoPath — reject exactly like scanMapperXml already
  // does for MyBatis XML, instead of trusting Tag.path and reading through
  // the link (see that function's leak.xml -> /etc/passwd comment).
  const realAbsPath = realpathOrResolve(absPath);
  const realRepoPath = realpathOrResolve(repoPath);
  if (realAbsPath !== realRepoPath && !realAbsPath.startsWith(realRepoPath + path.sep)) {
    return [];
  }
  const lines = readLines(realAbsPath);
  if (lines.length === 0) return [];

  // Dedup by line, keeping the LAST tag's name for a given line (matches
  // Python's `{t["line"]: t["name"] for t in tags if ...}` dict-comprehension
  // overwrite semantics), then sort ascending by line.
  const byLine = new Map<number, string>();
  for (const t of fileTags) {
    if (t.kind !== undefined && CHUNK_KINDS.has(t.kind) && typeof t.line === "number") {
      byLine.set(t.line, t.name);
    }
  }
  const anchors = Array.from(byLine.entries()).sort((a, b) => a[0] - b[0]);
  if (anchors.length === 0) return [];

  const chunks: Chunk[] = [];

  function addSpan(start: number, end: number, name: string): void {
    let pos = start;
    while (pos <= end) {
      const chunkEnd = Math.min(pos + MAX_CHUNK_LINES - 1, end);
      if (chunkEnd - pos + 1 >= MIN_CHUNK_LINES) {
        const text = truncateChars(lines.slice(pos - 1, chunkEnd).join(""), MAX_CHUNK_CHARS);
        if (text.trim()) {
          chunks.push({ path: relPath, start: pos, end: chunkEnd, name, text });
        }
      }
      pos = chunkEnd + 1;
    }
  }

  const firstLine = anchors[0][0];
  if (firstLine > 1) {
    // File preamble (imports, file-level config) — its own span now,
    // covered regardless of length, instead of only riding along with the
    // first symbol's chunk when short enough to fit alongside it.
    addSpan(1, firstLine - 1, "");
  }

  for (let i = 0; i < anchors.length; i++) {
    const [line, name] = anchors[i];
    const nextStart = i + 1 < anchors.length ? anchors[i + 1][0] : lines.length + 1;
    addSpan(line, nextStart - 1, name);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// _chunk_xml_windows port
// ---------------------------------------------------------------------------

function chunkXmlWindows(repoPath: string, relPath: string): Chunk[] {
  const absPath = path.join(repoPath, relPath);
  const lines = readLines(absPath);
  const chunks: Chunk[] = [];
  for (let start = 1; start <= lines.length; start += XML_WINDOW_LINES) {
    const end = Math.min(start + XML_WINDOW_LINES - 1, lines.length);
    const text = truncateChars(lines.slice(start - 1, end).join(""), MAX_CHUNK_CHARS);
    if (text.trim()) {
      chunks.push({ path: relPath, start, end, name: "", text });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// MyBatis mapper XML directory scan — os.walk(followlinks=False) port.
//
// Node has no fs.walk equivalent, so this recurses fs.readdirSync(dir,
// {withFileTypes:true}) by hand, checking isSymbolicLink() on EVERY entry
// (both directories and files): a symlinked directory is pruned from
// recursion (never descended into, just like a real dir named "." or
// "node_modules"), while a symlinked FILE still shows up in this level's
// file candidates — mirroring v1's comment exactly: without the explicit
// symlink reject right before opening, a repo (synced from an
// admin-supplied URL, not otherwise sandboxed) could smuggle e.g.
// resources/mapper/leak.xml -> /etc/passwd and have that file's real
// contents read, chunked, and sent to the embedding provider. The
// invariant is "never open a symlink's target", not "never see it in a
// directory listing".
// ---------------------------------------------------------------------------

const XML_SKIP_DIRS = new Set(["node_modules"]);

function scanMapperXml(repoPath: string, dir: string, out: Chunk[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirs: string[] = [];
  const fileNames: string[] = [];
  for (const d of entries) {
    if (!d.isSymbolicLink() && d.isDirectory()) {
      if (!d.name.startsWith(".") && !XML_SKIP_DIRS.has(d.name)) {
        subdirs.push(d.name);
      }
      continue;
    }
    // Anything else — regular files AND every symlink (whether it points at
    // a file or a directory) — is a file candidate: never recursed into,
    // and rejected again by an explicit lstat right before it would ever
    // be opened.
    fileNames.push(d.name);
  }

  for (const fn of fileNames) {
    // Exact port of v1's boolean logic: `"resources" in root and "mapper"
    // in (root + fn).lower()` — a plain substring test against the RAW
    // directory path, and an unseparated root+fn concatenation, not a
    // path-segment-aware check. Preserved as-is rather than paraphrased.
    if (fn.endsWith(".xml") && dir.includes("resources") && (dir + fn).toLowerCase().includes("mapper")) {
      const absFn = path.join(dir, fn);
      let isLink: boolean;
      try {
        isLink = fs.lstatSync(absFn).isSymbolicLink();
      } catch {
        continue;
      }
      if (isLink) continue;
      const rel = path.relative(repoPath, absFn);
      out.push(...chunkXmlWindows(repoPath, rel));
    }
  }

  for (const d of subdirs) {
    scanMapperXml(repoPath, path.join(dir, d), out);
  }
}

// ---------------------------------------------------------------------------
// _collect_chunks port
// ---------------------------------------------------------------------------

export function collectChunks(repoPath: string): Chunk[] {
  const tags = loadTags(repoPath);
  if (tags === null) return [];

  // `tags` (and every Tag object in it) is symbol-index.ts's TAGS_CACHE
  // entry, returned by reference and reused across calls until the sidecar
  // file's mtime changes (find_symbol/list_file_symbols read the SAME
  // objects). chunkFileBySymbols below only reads from these Tag objects —
  // never mutate them or the arrays built from them here, or a future
  // find_symbol/list_file_symbols call against the same repo would see the
  // corruption too.
  const byFile = new Map<string, Tag[]>();
  for (const t of tags) {
    const p = t.path ?? "";
    const list = byFile.get(p);
    if (list) {
      list.push(t);
    } else {
      byFile.set(p, [t]);
    }
  }

  const chunks: Chunk[] = [];
  for (const [relPath, fileTags] of byFile) {
    if (relPath) {
      chunks.push(...chunkFileBySymbols(repoPath, relPath, fileTags));
    }
  }

  scanMapperXml(repoPath, repoPath, chunks);
  return chunks;
}

// ---------------------------------------------------------------------------
// _chunk_hash port
// ---------------------------------------------------------------------------

export function chunkHash(chunk: Chunk): string {
  const key = `${chunk.path}|${chunk.name}|${chunk.text}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24);
}
