// File reader tool — read local files with per-user permission checks.
//
// Ported from v1-python-final:app/tools/file_reader.py's `_resolve_path`,
// `_is_path_allowed`, and the `file_reader` tool function, verbatim in
// behavior (see the docstrings below for the exact rules being mirrored).
// `resolvePath` is exported (not just an internal helper) because Task 6's
// `list_file_symbols` reuses the exact same relative-path resolution — v1
// did this by importing `_resolve_path` straight out of file_reader.py.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { registerTool, type ToolDef } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { getAllowedPaths, isWithinAllowedPaths, noAccessReason } from "./access.js";

const FileReaderParams = Type.Object({
  path: Type.String(),
  max_lines: Type.Optional(Type.Integer()),
  start_line: Type.Optional(Type.Integer()),
});

const DEFAULT_MAX_LINES = 200;
const DEFAULT_START_LINE = 1;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// Python's os.path.expanduser(path) only handles a bare "~" or a leading
// "~/..." here — v1's callers never pass "~user"-style paths, so that form
// (which Python does support) is deliberately not ported.
function expandUser(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

// Python's os.path.realpath never throws on a nonexistent target — it just
// lexically normalizes what it can, resolving whatever symlink components
// do exist. Node's fs.realpathSync THROWS ENOENT for a missing path, so
// this falls back to a lexical path.resolve() to match — same pattern as
// access.ts's getAllowedPaths (see its comment for the same rationale).
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve a path to an absolute one. Relative paths (as returned by
 * code_search, which strips the repo prefix) are resolved against each
 * allowed repo root in turn, matching how they were produced: try each
 * root, first EXISTING candidate wins; if none exist, fall through to
 * realpath(path) as-is (relative to cwd, same as Python's fallback).
 */
export function resolvePath(inputPath: string, allowedPaths: string[]): string {
  if (path.isAbsolute(inputPath)) {
    return realpathOrResolve(inputPath);
  }
  for (const root of allowedPaths) {
    const candidate = realpathOrResolve(path.join(root, inputPath));
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return realpathOrResolve(inputPath);
}

/**
 * Check if an already-resolved path is within allowed directories.
 * Dotfile/dotdir check runs on EVERY path segment (not just the last),
 * before the allowed-roots check, and before the deny-by-default check —
 * matching v1's check order exactly.
 */
function isPathAllowed(
  realPath: string,
  allowedPaths: string[],
  ctx: ToolContext,
): [boolean, string] {
  // Block all dotfiles/dotdirs by default.
  const parts = realPath.split(path.sep);
  for (const part of parts) {
    if (part.startsWith(".") && part !== "." && part !== "..") {
      return [false, `Access denied: dotfiles/directories are not readable ('${part}')`];
    }
  }

  // No permissions = no access (deny-by-default, no fallback).
  if (allowedPaths.length === 0) {
    return [false, noAccessReason(ctx)];
  }

  if (isWithinAllowedPaths(realPath, allowedPaths)) {
    return [true, ""];
  }
  return [false, "Access denied: path is outside your assigned repositories"];
}

// Splits file content into lines that KEEP their trailing "\n" (matching
// Python's `for i, line in enumerate(f)` readline semantics, so that
// "".join(lines) round-trips byte-for-byte), with zero lines for an empty
// file (String.prototype.split's lookbehind form would otherwise yield one
// spurious empty-string "line" for "").
//
// Known divergence (documented, not chased — matches this task's brief):
// Python's default text-mode open() does universal-newline translation
// (\r\n / \r -> \n) on read; this does not, so a CRLF source file will keep
// its \r here where Python would have stripped it. Repo files synced by
// repo-sync.ts are git-cloned on Linux and expected to be LF, so this is
// not expected to matter in practice.
function splitKeepingNewlines(content: string): string[] {
  if (content === "") {
    return [];
  }
  return content.split(/(?<=\n)/);
}

async function execute(
  input: Static<typeof FileReaderParams>,
  ctx: ToolContext,
): Promise<string> {
  const maxLines = input.max_lines ?? DEFAULT_MAX_LINES;
  const startLine = input.start_line ?? DEFAULT_START_LINE;

  const allowedPaths = getAllowedPaths(ctx);
  const resolved = resolvePath(expandUser(input.path), allowedPaths);

  const [allowed, reason] = isPathAllowed(resolved, allowedPaths, ctx);
  if (!allowed) {
    return `Error: ${reason}`;
  }

  if (!fs.existsSync(resolved)) {
    return `Error: File not found: ${resolved}`;
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return `Error: Not a file: ${resolved}`;
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    // Python: f"Error: File too large ({size / 1024 / 1024:.1f}MB). Max 5MB."
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    return `Error: File too large (${sizeMb}MB). Max 5MB.`;
  }

  const startIndex = Math.max(startLine, 1) - 1;
  try {
    // errors="replace" equivalent: Node's toString("utf8") already replaces
    // invalid byte sequences with U+FFFD on decode, matching Python's
    // behavior closely enough (exact replacement-run granularity may
    // differ for pathological byte sequences — not chased, files this tool
    // reads are expected to be valid UTF-8 source).
    const content = fs.readFileSync(resolved).toString("utf8");
    const allLines = splitKeepingNewlines(content);
    const lines: string[] = [];
    for (let i = 0; i < allLines.length; i++) {
      if (i < startIndex) {
        continue;
      }
      if (i >= startIndex + maxLines) {
        lines.push(`\n... (truncated at ${maxLines} lines from line ${startLine}, file has more)`);
        break;
      }
      lines.push(allLines[i]);
    }
    if (lines.length === 0) {
      return `Error: start_line (${startLine}) is beyond the end of the file.`;
    }
    return lines.join("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error reading file: ${message}`;
  }
}

export const fileReaderTool: ToolDef<typeof FileReaderParams> = {
  name: "file_reader",
  description:
    "Read the contents of a file at the given path. Supports text files. Only files within your assigned repositories are accessible. Paths may be absolute or relative to a repository root (as returned by code_search). Use start_line together with max_lines to jump to a specific section of a large file (e.g. a line number found via code_search) instead of always reading from the top.",
  schema: FileReaderParams,
  execute,
};

registerTool(fileReaderTool);
