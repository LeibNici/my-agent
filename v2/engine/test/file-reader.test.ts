// Task 4: file-reader.ts — read local files with per-user permission checks.
// Ported from v1-python-final:app/tools/file_reader.py's _resolve_path,
// _is_path_allowed, and the file_reader() tool function.
//
// Every allowed root here is a realpath'd temp dir (matching what
// access.ts's getAllowedPaths produces from real per-turn context — see
// access.test.ts's same pattern) so path comparisons aren't tripped up by
// /tmp itself being a symlink on some platforms.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileReaderTool, resolvePath } from "../src/tools/file-reader.js";
import type { ToolContext } from "../src/tools/registry.js";

function makeCtx(allowedRepoPaths: string[], unsyncedRepoNames: string[] = []): ToolContext {
  return { allowedRepoPaths, unsyncedRepoNames, userId: null };
}

let root: string;

beforeEach(() => {
  const tmpBase = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(tmpBase, "file-reader-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolvePath", () => {
  it("resolves an absolute path directly via realpath", () => {
    const file = path.join(root, "abs.txt");
    fs.writeFileSync(file, "hi\n");
    expect(resolvePath(file, [])).toBe(fs.realpathSync(file));
  });

  it("resolves a relative path against the first allowed root where it exists", () => {
    const file = path.join(root, "rel.txt");
    fs.writeFileSync(file, "hi\n");
    expect(resolvePath("rel.txt", [root])).toBe(fs.realpathSync(file));
  });

  it("tries allowed roots in order and picks the first EXISTING candidate", () => {
    const emptyRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "file-reader-empty-"));
    const file = path.join(root, "shared.txt");
    fs.writeFileSync(file, "hi\n");
    try {
      expect(resolvePath("shared.txt", [emptyRoot, root])).toBe(fs.realpathSync(file));
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("falls back to realpath(path) as-is when no allowed root has the relative candidate", () => {
    const nonexistent = "does/not/exist.txt";
    expect(resolvePath(nonexistent, [root])).toBe(path.resolve(nonexistent));
  });
});

describe("file_reader tool", () => {
  it("reads a normal file within an allowed root (absolute path)", async () => {
    const file = path.join(root, "hello.txt");
    fs.writeFileSync(file, "line1\nline2\nline3\n");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("line1\nline2\nline3\n");
  });

  it("resolves a relative path against the allowed root, as returned by code_search", async () => {
    const file = path.join(root, "hello.txt");
    fs.writeFileSync(file, "line1\nline2\n");
    const result = await fileReaderTool.execute({ path: "hello.txt" }, makeCtx([root]));
    expect(result).toBe("line1\nline2\n");
  });

  it("denies a dotfile as the final path segment", async () => {
    const file = path.join(root, ".secret.txt");
    fs.writeFileSync(file, "top secret\n");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe(
      "Error: Access denied: dotfiles/directories are not readable ('.secret.txt')",
    );
  });

  it("denies a dotdir anywhere in the path, not just the final segment", async () => {
    const dotDir = path.join(root, "sub", ".git");
    fs.mkdirSync(dotDir, { recursive: true });
    const file = path.join(dotDir, "config");
    fs.writeFileSync(file, "[core]\n");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe(
      "Error: Access denied: dotfiles/directories are not readable ('.git')",
    );
  });

  it("denies a path outside all allowed roots (traversal)", async () => {
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "file-reader-outside-"));
    try {
      const file = path.join(outside, "secret.txt");
      fs.writeFileSync(file, "nope\n");
      const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
      expect(result).toBe(
        "Error: Access denied: path is outside your assigned repositories",
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a file over the 5MB cap with the exact Python-matching message", async () => {
    const file = path.join(root, "big.txt");
    fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024, "a"));
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("Error: File too large (6.0MB). Max 5MB.");
  });

  it("allows a file exactly at the 5MB boundary (strict > cap, not >=)", async () => {
    const file = path.join(root, "exact.txt");
    fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024, "a"));
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result.startsWith("Error:")).toBe(false);
    expect(result.length).toBe(5 * 1024 * 1024);
  });

  it("formats the too-large size with Python's round-half-to-even (:.1f), not JS's round-half-away-from-zero", async () => {
    // 5505024 / 1024 / 1024 === 5.25 EXACTLY (1024*1024 is a power of two,
    // so this division has zero floating-point error) — a genuine decimal
    // tie. Python's f"{5.25:.1f}" round-half-to-even gives "5.2" (verified
    // via `python3 -c`); JS's Number.prototype.toFixed(1) gives "5.3"
    // (round-half-away-from-zero) — this is the exact byte count the
    // reviewer flagged as divergent.
    const file = path.join(root, "tie.txt");
    fs.writeFileSync(file, Buffer.alloc(5505024, "a"));
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("Error: File too large (5.2MB). Max 5MB.");
  });

  it("paginates with start_line/max_lines and appends the exact truncation message", async () => {
    const file = path.join(root, "numbered.txt");
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(file, lines);
    const result = await fileReaderTool.execute(
      { path: file, start_line: 3, max_lines: 3 },
      makeCtx([root]),
    );
    expect(result).toBe(
      "line3\nline4\nline5\n\n... (truncated at 3 lines from line 3, file has more)",
    );
  });

  it("does not truncate when max_lines covers the rest of the file", async () => {
    const file = path.join(root, "small.txt");
    fs.writeFileSync(file, "a\nb\nc\n");
    const result = await fileReaderTool.execute(
      { path: file, start_line: 2, max_lines: 200 },
      makeCtx([root]),
    );
    expect(result).toBe("b\nc\n");
  });

  it("errors when start_line is beyond the end of the file", async () => {
    const file = path.join(root, "short.txt");
    fs.writeFileSync(file, "a\nb\nc\n");
    const result = await fileReaderTool.execute(
      { path: file, start_line: 10 },
      makeCtx([root]),
    );
    expect(result).toBe("Error: start_line (10) is beyond the end of the file.");
  });

  it("errors on an empty file (no lines to satisfy start_line 1)", async () => {
    const file = path.join(root, "empty.txt");
    fs.writeFileSync(file, "");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("Error: start_line (1) is beyond the end of the file.");
  });

  it("returns noAccessReason's exact text when allowedPaths is empty (deny-by-default)", async () => {
    const result = await fileReaderTool.execute({ path: "/etc/hostname" }, makeCtx([]));
    expect(result).toBe(
      "Error: Access denied: you have no repository permissions assigned",
    );
  });

  it("reports file not found for a missing file under an allowed root", async () => {
    const missing = path.join(root, "nope.txt");
    const result = await fileReaderTool.execute({ path: missing }, makeCtx([root]));
    expect(result).toBe(`Error: File not found: ${missing}`);
  });

  it("reports not-a-file for a directory path", async () => {
    const dir = path.join(root, "adir");
    fs.mkdirSync(dir);
    const result = await fileReaderTool.execute({ path: dir }, makeCtx([root]));
    expect(result).toBe(`Error: Not a file: ${dir}`);
  });

  it("normalizes CRLF (and lone CR) line endings to LF, matching Python's universal-newline text-mode open()", async () => {
    const file = path.join(root, "crlf.txt");
    fs.writeFileSync(file, "line1\r\nline2\r\nline3\r\n");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("line1\nline2\nline3\n");
    expect(result).not.toContain("\r");
  });

  it("round-trips byte-exactly when the last line has no trailing newline", async () => {
    // Python's `for i, line in enumerate(f)` + `"".join(lines)` keeps the
    // final line exactly as-is when the file doesn't end in "\n" — no
    // newline is invented for it. Every other fixture in this file ends
    // with a trailing "\n"; this one deliberately doesn't.
    const file = path.join(root, "no-trailing-newline.txt");
    fs.writeFileSync(file, "line1\nline2\nline3");
    const result = await fileReaderTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe("line1\nline2\nline3");
    expect(result.endsWith("\n")).toBe(false);
  });
});
