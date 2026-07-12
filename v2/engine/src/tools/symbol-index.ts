// Symbol index — ctags-backed "where is X defined" lookup for repo code.
//
// Ported from v1-python-final:app/tools/symbol_index.py (_index_path,
// build_index, _TAGS_CACHE/_load_tags, find_symbol, list_file_symbols),
// verbatim in behavior — see that file's module docstring for the full
// rationale (code_search.ts is grep: no notion of definition vs. reference;
// this answers "where is X defined" / "what's in this file" directly from
// a ctags index instead). The only intentional divergence from v1 is the
// async subprocess mechanics: Node's child_process instead of asyncio.
//
// ctags is an optional OS-level dependency. Everything here degrades
// gracefully when it's missing or an index hasn't been built yet:
// buildIndex() no-ops (returns false, never throws), and the tools return
// a plain fallback message instead of raising.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { getAllowedPaths, isWithinAllowedPaths, noAccessReason } from "./access.js";
import { resolvePath, realpathOrResolve } from "./file-reader.js";

// ---------------------------------------------------------------------------
// ctags detection — mirrors code-search.ts's _RG_BIN `which`-detection
// pattern (detectRgBin/RG_BIN). Kept as a small local duplicate rather than
// factored into a shared module: per Task 5's own precedent (code-search.ts
// top comment), this one function isn't worth sharing for two call sites.
// ---------------------------------------------------------------------------

function detectCtagsBin(): string | null {
  try {
    const out = execFileSync("which", ["ctags"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// Resolved once at module load, matching v1's `_CTAGS_BIN = shutil.which("ctags")`
// at import time (not re-probed per build).
const CTAGS_BIN = detectCtagsBin();

// Languages ctags parses natively, plus Vue SFCs mapped onto the TypeScript
// parser: it happily skips over <template>/<style> markup it can't make
// sense of and still pulls out every top-level function/const/interface/type
// declared in the <script> block (verified against this repo's own .vue
// files, same as v1's comment records).
const CTAGS_ARGS = [
  "-R",
  "--languages=Java,JavaScript,TypeScript",
  "--langmap=TypeScript:+.vue",
  "--fields=+n",
  "--output-format=json",
];

const BUILD_TIMEOUT_MS = 90_000;

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// _index_path port
// ---------------------------------------------------------------------------

/** Strips ALL trailing path separators, matching Python's `str.rstrip(os.sep)`
 * (which removes every trailing occurrence of the character, not just one —
 * distinct from a single conditional slice). */
function stripTrailingSep(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === path.sep) end--;
  return p.slice(0, end);
}

/**
 * Sidecar file next to the repo checkout, e.g. /tmp/agent-repos/3.tags.json
 * for a checkout at /tmp/agent-repos/3 — deliberately OUTSIDE repoPath so
 * repo-sync's clone rmtree+rename of repoPath never touches it.
 *
 * Always realpath()s its input (via file-reader.ts's realpathOrResolve, the
 * same non-throwing realpath-or-lexical-resolve helper access.ts's
 * getAllowedPaths uses): buildIndex() is called with the raw path from
 * repo-sync's getRepoLocalPath(), while findSymbol/listFileSymbols get
 * theirs from access.ts's getAllowedPaths(), which realpaths every entry.
 * Without normalizing here too, the writer and the readers would compute
 * different sidecar paths whenever the repos directory sits behind a
 * symlink, and the tools would report "no index" forever even though
 * buildIndex succeeded.
 */
function indexPath(repoPath: string): string {
  return stripTrailingSep(realpathOrResolve(repoPath)) + ".tags.json";
}

// ---------------------------------------------------------------------------
// build_index port
// ---------------------------------------------------------------------------

/**
 * (Re)build the symbol index for one repo checkout. Best-effort and silent:
 * sync must never fail because indexing failed. Writes to a temp file and
 * renames into place so a reader never sees a half-written index. Returns
 * true only when a fresh index was actually written.
 *
 * Parameterized over ctagsBin/timeoutMs (like code-search.ts's runCodeSearch
 * over rgBin/timeoutMs) so tests can inject a missing/bogus binary and a
 * short timeout instead of depending on PATH manipulation — see
 * __internal.buildIndexWithBin.
 */
function buildIndexWithBin(
  repoPath: string,
  ctagsBin: string | null,
  timeoutMs: number,
): Promise<boolean> {
  if (!ctagsBin || !isDirSafe(repoPath)) {
    return Promise.resolve(false);
  }

  const idxPath = indexPath(repoPath);
  const tmpPath = idxPath + ".tmp";

  return new Promise((resolve) => {
    execFile(
      ctagsBin,
      [...CTAGS_ARGS, "-f", tmpPath, "."],
      { cwd: repoPath, timeout: timeoutMs, maxBuffer: 200 * 1024 * 1024 },
      (err) => {
        let ok = false;
        if (!err && fs.existsSync(tmpPath)) {
          try {
            fs.renameSync(tmpPath, idxPath);
            ok = true;
          } catch {
            ok = false;
          }
        }
        if (!ok && fs.existsSync(tmpPath)) {
          try {
            fs.rmSync(tmpPath, { force: true });
          } catch {
            // Best-effort cleanup only — never let a cleanup failure surface.
          }
        }
        resolve(ok);
      },
    );
  });
}

export async function buildIndex(repoPath: string): Promise<boolean> {
  return buildIndexWithBin(repoPath, CTAGS_BIN, BUILD_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// _TAGS_CACHE / _load_tags port
// ---------------------------------------------------------------------------

type Tag = {
  _type?: string;
  name: string;
  path: string;
  line?: number;
  kind?: string;
  scope?: string;
  scopeKind?: string;
};

// In-process cache keyed by index_path -> (mtime, parsed tags), so a turn
// that calls find_symbol/list_file_symbols several times against the same
// repo doesn't re-read and re-parse a multi-MB file on every call.
// buildIndex() always replaces the file via fs.renameSync (matching
// Python's os.replace), which changes its mtime, so a rebuilt index is
// picked up on the next call without any explicit invalidation.
// Module-level and unlocked: worst case under a race is one extra
// redundant parse, never stale/corrupt data.
const TAGS_CACHE = new Map<string, { mtimeMs: number; tags: Tag[] }>();

/** null means "no index available" (ctags missing or never built),
 * distinct from an empty array (indexed, genuinely no symbols). */
function loadTags(repoPath: string): Tag[] | null {
  const idxPath = indexPath(repoPath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(idxPath).mtimeMs;
  } catch {
    return null;
  }

  const cached = TAGS_CACHE.get(idxPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.tags;
  }

  const tags: Tag[] = [];
  const content = fs.readFileSync(idxPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let tag: Tag;
    try {
      tag = JSON.parse(line) as Tag;
    } catch {
      continue;
    }
    // ctags --output-format=json also emits ~10 "ptag" pseudo-records
    // (JSON_OUTPUT_VERSION, TAG_PROGRAM_AUTHOR, ...) alongside the real
    // "tag" entries — without this filter they masquerade as symbols and
    // can crowd out real substring matches in find_symbol.
    if (tag._type !== "tag") continue;
    tags.push(tag);
  }

  TAGS_CACHE.set(idxPath, { mtimeMs, tags });
  return tags;
}

function formatTag(repoName: string, tag: Tag): string {
  const scope = tag.scope ? ` (in ${tag.scope})` : "";
  return `${repoName}/${tag.path}:${tag.line ?? "?"} [${tag.kind ?? "?"}] ${tag.name}${scope}`;
}

// ---------------------------------------------------------------------------
// find_symbol tool
// ---------------------------------------------------------------------------

const FindSymbolParams = Type.Object({
  name: Type.String(),
  max_results: Type.Optional(Type.Integer()),
});

const DEFAULT_MAX_RESULTS = 20;

async function findSymbolExecute(
  input: Static<typeof FindSymbolParams>,
  ctx: ToolContext,
): Promise<string> {
  const allowedPaths = getAllowedPaths(ctx);
  if (allowedPaths.length === 0) {
    return noAccessReason(ctx, "Error");
  }

  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
  const exactHits: string[] = [];
  const substrHits: string[] = [];
  let anyIndexFound = false;
  const nameLower = input.name.toLowerCase();

  for (const repoPath of allowedPaths) {
    const tags = loadTags(repoPath);
    if (tags === null) continue;
    anyIndexFound = true;
    const repoName = path.basename(repoPath);
    for (const tag of tags) {
      const tagName = tag.name ?? "";
      if (tagName === input.name) {
        exactHits.push(formatTag(repoName, tag));
      } else if (tagName.toLowerCase().includes(nameLower)) {
        substrHits.push(formatTag(repoName, tag));
      }
    }
  }

  if (!anyIndexFound) {
    return (
      "No symbol index available for your repositories yet (ctags may not be installed, or " +
      "the repo hasn't finished syncing since this feature was added). Fall back to code_search."
    );
  }

  const hits = exactHits.length > 0 ? exactHits : substrHits;
  if (hits.length === 0) {
    return `No symbol named '${input.name}' found in the index. Try code_search for a broader text match.`;
  }

  const label = exactHits.length > 0 ? "exact" : "substring";
  return `Found ${hits.length} ${label} match(es) for '${input.name}':\n` + hits.slice(0, maxResults).join("\n");
}

export const findSymbolTool: ToolDef<typeof FindSymbolParams> = {
  name: "find_symbol",
  description:
    "Find where a symbol (function, class, interface, method, constant...) is DEFINED across your " +
    "assigned repositories, using a pre-built ctags index — this is the fast path for 'where is X " +
    "defined' instead of guessing at code_search keywords. Matches on the exact symbol name first, " +
    "falling back to a substring match if nothing exact is found. Only finds definitions, not call " +
    "sites — use code_search to find where a symbol is referenced/called.",
  schema: FindSymbolParams,
  execute: findSymbolExecute,
};

registerTool(findSymbolTool);

// ---------------------------------------------------------------------------
// list_file_symbols tool
// ---------------------------------------------------------------------------

const ListFileSymbolsParams = Type.Object({
  path: Type.String(),
});

async function listFileSymbolsExecute(
  input: Static<typeof ListFileSymbolsParams>,
  ctx: ToolContext,
): Promise<string> {
  const allowedPaths = getAllowedPaths(ctx);
  if (allowedPaths.length === 0) {
    return noAccessReason(ctx, "Error");
  }

  // Same relative-path resolution file_reader uses for paths returned by
  // code_search (relative to a repo root, not absolute) — reused rather
  // than re-implemented so the two tools can't silently diverge on it.
  const realPath = resolvePath(input.path, allowedPaths);
  if (!isWithinAllowedPaths(realPath, allowedPaths)) {
    return "Error: Access denied or file not found — path must be within your assigned repositories.";
  }
  const repoRoot = allowedPaths.find((r) => realPath === r || realPath.startsWith(r + path.sep));
  if (!repoRoot) {
    return "Error: Access denied or file not found — path must be within your assigned repositories.";
  }

  const tags = loadTags(repoRoot);
  if (tags === null) {
    return (
      "No symbol index available for this repository yet (ctags may not be installed, or the " +
      "repo hasn't finished syncing since this feature was added). Fall back to file_reader."
    );
  }

  const relPath = path.relative(repoRoot, realPath);
  // Drop local `const`/`let` declarations (the TS/Vue parser tags every one
  // of them as kind="constant", whether the enclosing scope is a bare
  // function, a class method, an arrow callback, etc.) — noise for a
  // structural overview; class fields/methods and interface properties
  // (which carry a different kind) are kept since those are real API
  // surface. A "constant" only ever has no scope at all when it's a
  // genuine top-level declaration.
  const matches = tags.filter((t) => t.path === relPath && !(t.kind === "constant" && t.scope));
  if (matches.length === 0) {
    return `No indexed symbols found in ${relPath} (file may not exist, be empty, or be an unindexed language).`;
  }

  matches.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const lines = matches.map(
    (t) => `${t.line ?? "?"}: [${t.kind ?? "?"}] ${t.name}` + (t.scope ? ` (in ${t.scope})` : ""),
  );
  return `${matches.length} symbol(s) in ${relPath}:\n` + lines.join("\n");
}

export const listFileSymbolsTool: ToolDef<typeof ListFileSymbolsParams> = {
  name: "list_file_symbols",
  description:
    "List every top-level symbol (function, class, interface, method, constant...) declared in one " +
    "file, with line numbers — use this right after locating a file to see its structure before " +
    "deciding which part to read with file_reader, instead of paging through the whole file blind.",
  schema: ListFileSymbolsParams,
  execute: listFileSymbolsExecute,
};

registerTool(listFileSymbolsTool);

// Test-only surface — mirrors code-search.ts's __internal escape hatch. Not
// part of the three exports (buildIndex/findSymbolTool/listFileSymbolsTool)
// other tasks should depend on.
export const __internal = {
  buildIndexWithBin,
  detectCtagsBin,
  indexPath,
  loadTags,
  CTAGS_BIN,
  CTAGS_ARGS,
};
