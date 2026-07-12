// code_search + list_directory — search and browse repository code with
// permission checks. Ported from v1-python-final:app/tools/code_search.py
// (_validate_repo_path, _search_argv, _search_one_repo, code_search,
// list_directory, _build_tree), verbatim in behavior except where Node's
// concurrency/process primitives differ from asyncio (noted inline below).
//
// rg vs grep: v1 resolves `shutil.which("rg")` once at import and falls
// back to grep where rg isn't installed — same shape here via
// `execFileSync("which", ["rg"])` (Node has no built-in `which`; repo-sync.ts
// doesn't need one since it always shells out to a fixed "git", so this is
// a new, small, local helper rather than a shared module for one function).
// In THIS environment rg is not installed (verified: `which rg` -> nothing,
// only ctags present), so `code_search`'s production path here is grep —
// see test/code-search.test.ts's top comment for how the rg codepath is
// still exercised, via an injected stub binary.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { getAllowedPaths, isWithinAllowedPaths, noAccessReason } from "./access.js";
import { expandUser, realpathOrResolve } from "./file-reader.js";

// ---------------------------------------------------------------------------
// rg detection
// ---------------------------------------------------------------------------

function detectRgBin(): string | null {
  try {
    const out = execFileSync("which", ["rg"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// Resolved once at module load, matching v1's `_RG_BIN = shutil.which("rg")`
// at import time (not re-probed per search).
const RG_BIN = detectRgBin();

const SEARCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// _validate_repo_path port (list_directory's explicit-path validation)
// ---------------------------------------------------------------------------

/** Returns [ok, realPath, err] — matching v1's `_validate_repo_path` tuple
 * return shape exactly (including returning realPath even when !ok, which
 * v1's callers never use, but is kept for fidelity/testability). */
function validateRepoPath(inputPath: string, allowedPaths: string[]): [boolean, string, string] {
  const realPath = realpathOrResolve(expandUser(inputPath));
  if (isWithinAllowedPaths(realPath, allowedPaths)) {
    return [true, realPath, ""];
  }
  return [false, realPath, "Access denied: path is outside your assigned repositories"];
}

// ---------------------------------------------------------------------------
// _search_argv port
// ---------------------------------------------------------------------------

/** Builds the search command argv. The keyword is always treated as a FIXED
 * string (-F / --fixed-strings): users search for identifiers like
 * `deduct(` or `a[0]`, and treating those as regex made them hard errors
 * in the pre-fixed-string version this replaced. Exported (not test-only)
 * since it's a pure function useful to pin against the spec directly. */
export function buildSearchArgv(
  keyword: string,
  filePattern: string,
  repoPath: string,
  rgBin: string | null,
): string[] {
  if (rgBin) {
    const argv = [
      rgBin,
      "--line-number",
      "--no-heading",
      "--fixed-strings",
      "--max-columns",
      "300",
      "--max-columns-preview",
    ];
    if (filePattern && filePattern !== "*") {
      argv.push("--glob", filePattern);
    }
    argv.push("--", keyword, repoPath);
    return argv;
  }
  return [
    "grep",
    "-rn",
    "-F",
    "--include",
    filePattern,
    "--exclude-dir=.*", // never search into dotfiles/dotdirs (.env, .git, .ssh, ...)
    "--exclude=.*",
    "--",
    keyword,
    repoPath,
  ];
}

// ---------------------------------------------------------------------------
// _search_one_repo port
// ---------------------------------------------------------------------------

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Replicates Python's `line.replace(needle, "", 1)`: removes only the
 * FIRST occurrence of `needle` anywhere in the string (not just a prefix
 * match) — in practice this is always the path prefix at the start of a
 * grep/rg output line, since repoPath is what was searched, but ported
 * exactly rather than assumed-equivalent to startsWith+slice. */
function stripFirstOccurrence(line: string, needle: string): string {
  const idx = line.indexOf(needle);
  if (idx === -1) return line;
  return line.slice(0, idx) + line.slice(idx + needle.length);
}

function parseSearchOutput(stdout: string, repoPath: string): string[] {
  const prefix = repoPath + "/";
  // Python: stdout.decode(errors="replace").strip().split("\n")
  return stdout
    .trim()
    .split("\n")
    .map((line) => stripFirstOccurrence(line, prefix));
}

type SearchOneRepoOptions = {
  rgBin: string | null;
  timeoutMs: number;
  signal: AbortSignal;
};

/** Ports v1's `_search_one_repo`: spawns the search command, 15s (or
 * test-injected) timeout with kill-on-timeout, and — new in Node, since
 * asyncio.CancelledError has no direct Node equivalent — an AbortSignal
 * that `code_search` fires once max_results is reached, tearing down the
 * child process the same way a real cap-triggered cancellation should
 * (matching v1's `task.cancel()` -> `except asyncio.CancelledError: kill
 * + wait` branch). */
function searchOneRepo(
  repoPath: string,
  keyword: string,
  filePattern: string,
  opts: SearchOneRepoOptions,
): Promise<string[]> {
  if (!isDirSafe(repoPath)) {
    return Promise.resolve([]);
  }
  const [cmd, ...args] = buildSearchArgv(keyword, filePattern, repoPath, opts.rgBin);
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 50 * 1024 * 1024, signal: opts.signal },
      (err, stdoutBuf) => {
        // Cancelled by the cap-reached path — v1 discards the cancelled
        // task's result entirely (never appended to `results`), so an
        // empty array here is fine regardless of what (if anything) the
        // child managed to print before being killed.
        if (opts.signal.aborted) {
          resolve([]);
          return;
        }
        const stdout = stdoutBuf ? stdoutBuf.toString() : "";
        if (stdout) {
          resolve(parseSearchOutput(stdout, repoPath));
          return;
        }
        if (err) {
          if (err.killed) {
            resolve([`(search timed out for ${path.basename(repoPath)})`]);
            return;
          }
          // A numeric `code` means the process ran and exited non-zero
          // (e.g. grep/rg's "no matches" exit 1) — v1 doesn't special-case
          // this either, it just falls through to "no stdout -> []"
          // (asyncio.wait_for(proc.communicate()) never inspects the
          // return code). A non-numeric code (e.g. Node's "ENOENT" for a
          // missing binary) is a real spawn-level failure, matching v1's
          // generic `except Exception as e` branch.
          if (typeof err.code !== "number") {
            resolve([`(search error: ${err.message})`]);
            return;
          }
        }
        resolve([]);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// code_search tool
// ---------------------------------------------------------------------------

const CodeSearchParams = Type.Object({
  keyword: Type.String(),
  file_pattern: Type.Optional(Type.String()),
  max_results: Type.Optional(Type.Integer()),
});

const DEFAULT_FILE_PATTERN = "*";
const DEFAULT_MAX_RESULTS = 20;

type SearchRuntime = { rgBin: string | null; timeoutMs: number };

/** Core implementation, parameterized over rgBin/timeoutMs so tests can
 * inject a stub binary and a short timeout (see test/code-search.test.ts)
 * instead of depending on a real rg/grep install and a real 15s wait —
 * same test-only-injection shape as Task 3's repo-sync.ts `__internal`
 * escape hatch. `codeSearchTool.execute` below calls this with the real
 * detected rg binary and the real 15s timeout. */
async function runCodeSearch(
  input: Static<typeof CodeSearchParams>,
  ctx: ToolContext,
  runtime: SearchRuntime,
): Promise<string> {
  const keyword = input.keyword;
  const filePattern = input.file_pattern ?? DEFAULT_FILE_PATTERN;
  const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;

  const allowedPaths = getAllowedPaths(ctx);
  if (allowedPaths.length === 0) {
    return noAccessReason(ctx, "Error");
  }

  // Search every accessible repo concurrently (all tasks start immediately,
  // matching v1's asyncio.create_task fan-out) — a user with several
  // granted repos pays the cost of the SLOWEST single repo instead of the
  // SUM of all of them. Results are still assembled in repo (allowedPaths)
  // order and capped at max_results: once the cap is hit, remaining
  // in-flight searches are aborted (killing their child process) instead
  // of being waited out.
  const controllers = allowedPaths.map(() => new AbortController());
  const tasks = allowedPaths.map((repoPath, i) =>
    searchOneRepo(repoPath, keyword, filePattern, {
      rgBin: runtime.rgBin,
      timeoutMs: runtime.timeoutMs,
      signal: controllers[i].signal,
    }),
  );

  const results: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    results.push(...(await tasks[i]));
    if (results.length >= maxResults) {
      for (let j = i + 1; j < controllers.length; j++) {
        controllers[j].abort();
      }
      await Promise.allSettled(tasks.slice(i + 1));
      break;
    }
  }

  if (results.length === 0) {
    return `No matches found for '${keyword}' in your repositories.`;
  }

  // Header count is the RAW accumulated total (may exceed max_results,
  // since a whole repo's result set is appended before the cap check runs)
  // — matches v1's `f"Found {len(results)} matches:"` using the uncapped
  // `len(results)`, while the body below is sliced to max_results. This is
  // a v1 quirk, preserved deliberately rather than "fixed".
  return `Found ${results.length} matches:\n` + results.slice(0, maxResults).join("\n");
}

async function codeSearchExecute(
  input: Static<typeof CodeSearchParams>,
  ctx: ToolContext,
): Promise<string> {
  return runCodeSearch(input, ctx, { rgBin: RG_BIN, timeoutMs: SEARCH_TIMEOUT_MS });
}

export const codeSearchTool: ToolDef<typeof CodeSearchParams> = {
  name: "code_search",
  description:
    "Search for a literal keyword or substring in repository code (fixed-string match, NOT regex — " +
    "characters like .*, (), [] are matched literally and will not act as wildcards). Returns matching " +
    "file paths, line numbers, and content lines. Use exact identifiers, field names, or short literal " +
    "phrases copied from the code/UI text. If a search returns no matches, try a different literal " +
    "substring (e.g. a shorter fragment or a related term) rather than a regex-style pattern.",
  schema: CodeSearchParams,
  execute: codeSearchExecute,
};

registerTool(codeSearchTool);

// ---------------------------------------------------------------------------
// list_directory tool + _build_tree port
// ---------------------------------------------------------------------------

const ListDirectoryParams = Type.Object({
  path: Type.Optional(Type.String()),
  max_depth: Type.Optional(Type.Integer()),
});

const DEFAULT_PATH = ".";
const DEFAULT_MAX_DEPTH = 3;
const MAX_DIRS_PER_LEVEL = 15;
const MAX_FILES_PER_LEVEL = 25;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Ports v1's `_build_tree`: dotfile/symlink skip (symlinks are never
 * followed — a committed symlink pointing outside the repo, e.g. to /etc,
 * would otherwise let this walk escape the sandboxed allowed_paths
 * boundary), SKIP_DIRS exclusion, and per-level 15-dir/25-file caps with a
 * combined "... and N more" overflow message. */
function buildTree(current: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) {
    return "";
  }

  const indent = "  ".repeat(depth);
  let entries: string[];
  try {
    entries = fs.readdirSync(current).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      return `${indent}(permission denied)`;
    }
    throw err;
  }

  // Skip dotfiles and symlinks — never follow a symlink, since a committed
  // symlink pointing outside the repo would otherwise let this walk escape
  // the sandboxed allowed_paths boundary.
  entries = entries.filter((e) => {
    if (e.startsWith(".")) return false;
    try {
      return !fs.lstatSync(path.join(current, e)).isSymbolicLink();
    } catch {
      return false;
    }
  });

  const dirs = entries.filter((e) => !SKIP_DIRS.has(e) && isDirSafe(path.join(current, e)));
  const files = entries.filter((e) => !SKIP_DIRS.has(e) && isFileSafe(path.join(current, e)));

  const lines: string[] = [];
  for (const d of dirs.slice(0, MAX_DIRS_PER_LEVEL)) {
    lines.push(`${indent}📁 ${d}/`);
    const sub = buildTree(path.join(current, d), depth + 1, maxDepth);
    if (sub) lines.push(sub);
  }
  for (const f of files.slice(0, MAX_FILES_PER_LEVEL)) {
    lines.push(`${indent}📄 ${f}`);
  }

  const hiddenDirs = dirs.length - Math.min(dirs.length, MAX_DIRS_PER_LEVEL);
  const hiddenFiles = files.length - Math.min(files.length, MAX_FILES_PER_LEVEL);
  const hidden = hiddenDirs + hiddenFiles;
  if (hidden > 0) {
    lines.push(`${indent}... and ${hidden} more`);
  }

  return lines.join("\n");
}

async function listDirectoryExecute(
  input: Static<typeof ListDirectoryParams>,
  ctx: ToolContext,
): Promise<string> {
  const inputPath = input.path ?? DEFAULT_PATH;
  const maxDepth = input.max_depth ?? DEFAULT_MAX_DEPTH;

  const allowedPaths = getAllowedPaths(ctx);
  if (allowedPaths.length === 0) {
    return noAccessReason(ctx, "Error");
  }

  if (inputPath === ".") {
    const parts: string[] = [];
    for (const repoPath of allowedPaths) {
      if (isDirSafe(repoPath)) {
        const name = path.basename(repoPath);
        const tree = buildTree(repoPath, 0, maxDepth);
        parts.push(`📁 ${name}/\n${tree}`);
      }
    }
    return parts.length ? parts.join("\n\n") : "No repositories found.";
  }

  const [ok, realPath, err] = validateRepoPath(inputPath, allowedPaths);
  if (!ok) {
    return `Error: ${err}`;
  }
  if (!isDirSafe(realPath)) {
    return `Error: not a directory: ${inputPath}`;
  }
  return buildTree(realPath, 0, maxDepth);
}

export const listDirectoryTool: ToolDef<typeof ListDirectoryParams> = {
  name: "list_directory",
  description:
    "List the directory structure of a repository or path. Shows files and folders up to the specified " +
    "depth. Use '.' to list all accessible repositories.",
  schema: ListDirectoryParams,
  execute: listDirectoryExecute,
};

registerTool(listDirectoryTool);

// Test-only surface — mirrors Task 3's repo-sync.ts __internal escape
// hatch. Not part of the two ToolDef exports other tasks should depend on.
export const __internal = {
  buildSearchArgv,
  searchOneRepo,
  runCodeSearch,
  buildTree,
  validateRepoPath,
  detectRgBin,
};
