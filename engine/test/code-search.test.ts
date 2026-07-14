// Task 5: code-search.ts — code_search + list_directory tools.
// Ported from v1-python-final:app/tools/code_search.py (_validate_repo_path,
// _search_argv, _search_one_repo, code_search, list_directory, _build_tree).
//
// Environment note (verified before writing this file): `rg` is NOT
// installed here (`which rg` finds nothing, only `ctags` is present), so the
// grep-fallback path is what actually runs end-to-end for the bulk of these
// tests. The rg codepath is exercised via a stub binary injected through
// `__internal.runCodeSearch`'s `rgBin` runtime override (see the "rg
// codepath (stub binary)" describe block below) — it is NOT real ripgrep,
// it's a small Node script that accepts rg-shaped argv and answers in rg's
// output format, proving the plumbing (argv construction, spawn, stdout
// parsing, prefix stripping) without requiring rg to be installed. The
// `buildSearchArgv` unit tests separately pin the exact rg argv shape
// against the ported spec, independent of whether anything can execute it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  codeSearchTool,
  listDirectoryTool,
  __internal,
} from "../src/tools/code-search.js";
import { noAccessReason } from "../src/tools/access.js";
import type { ToolContext } from "../src/tools/registry.js";

const { buildSearchArgv, runCodeSearch, buildTree, validateRepoPath } = __internal;

function makeCtx(allowedRepoPaths: string[], unsyncedRepoNames: string[] = []): ToolContext {
  return { allowedRepoPaths, unsyncedRepoNames, userId: null };
}

let root: string;

beforeEach(() => {
  const tmpBase = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(tmpBase, "code-search-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildSearchArgv — pure function, pins the exact argv shape against
// v1's _search_argv, independently of whether rg/grep can actually run.
// ---------------------------------------------------------------------------
describe("buildSearchArgv", () => {
  it("builds the grep-fallback argv with default file_pattern '*'", () => {
    expect(buildSearchArgv("needle", "*", "/repo", null)).toEqual([
      "grep",
      "-rn",
      "-F",
      "--include",
      "*",
      "--exclude-dir=.*",
      "--exclude=.*",
      "--",
      "needle",
      "/repo",
    ]);
  });

  it("builds the grep-fallback argv with a custom file_pattern", () => {
    expect(buildSearchArgv("needle", "*.ts", "/repo", null)).toEqual([
      "grep",
      "-rn",
      "-F",
      "--include",
      "*.ts",
      "--exclude-dir=.*",
      "--exclude=.*",
      "--",
      "needle",
      "/repo",
    ]);
  });

  it("builds the rg argv WITHOUT --glob when file_pattern is '*'", () => {
    expect(buildSearchArgv("needle", "*", "/repo", "rg")).toEqual([
      "rg",
      "--line-number",
      "--no-heading",
      "--fixed-strings",
      "--max-columns",
      "300",
      "--max-columns-preview",
      "--",
      "needle",
      "/repo",
    ]);
  });

  it("builds the rg argv WITH --glob when a real file_pattern is given", () => {
    expect(buildSearchArgv("needle", "*.ts", "/repo", "rg")).toEqual([
      "rg",
      "--line-number",
      "--no-heading",
      "--fixed-strings",
      "--max-columns",
      "300",
      "--max-columns-preview",
      "--glob",
      "*.ts",
      "--",
      "needle",
      "/repo",
    ]);
  });
});

// ---------------------------------------------------------------------------
// code_search — grep-fallback path (rgBin: null), the path that genuinely
// runs in this sandbox (no rg binary present).
// ---------------------------------------------------------------------------
describe("code_search (grep fallback, real subprocess)", () => {
  const runtime = { rgBin: null, timeoutMs: 15_000 };

  it("finds a fixed-string match and strips the repo path prefix from result lines", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "hello world\nfoo bar\n");
    const result = await runCodeSearch({ keyword: "hello" }, makeCtx([root]), runtime);
    expect(result).toContain("Found 1 matches:");
    expect(result).toContain("a.txt:1:hello world");
    expect(result).not.toContain(root);
  });

  it("treats the keyword as a literal fixed string, not a regex", async () => {
    // "a.b" would match "axb" under regex interpretation (. = any char);
    // fixed-string search must NOT do that.
    fs.writeFileSync(path.join(root, "regex.txt"), "literal a.b here\nregex-tricked axb here\n");
    const result = await runCodeSearch({ keyword: "a.b" }, makeCtx([root]), runtime);
    expect(result).toContain("literal a.b here");
    expect(result).not.toContain("axb");
  });

  it("treats other regex metacharacters (parens, brackets, star) as literal too", async () => {
    fs.writeFileSync(path.join(root, "code.txt"), "call deduct(a[0])\nunrelated line\n");
    const result = await runCodeSearch({ keyword: "deduct(a[0])" }, makeCtx([root]), runtime);
    expect(result).toContain("deduct(a[0])");
    expect(result).toContain("Found 1 matches");
  });

  it("filters by file_pattern glob, excluding non-matching files", async () => {
    fs.writeFileSync(path.join(root, "match.ts"), "findme here\n");
    fs.writeFileSync(path.join(root, "nomatch.txt"), "findme here too\n");
    const result = await runCodeSearch(
      { keyword: "findme", file_pattern: "*.ts" },
      makeCtx([root]),
      runtime,
    );
    expect(result).toContain("match.ts");
    expect(result).not.toContain("nomatch.txt");
  });

  it("returns the exact no-matches message when nothing is found", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "nothing interesting\n");
    const result = await runCodeSearch({ keyword: "zzz_absent" }, makeCtx([root]), runtime);
    expect(result).toBe("No matches found for 'zzz_absent' in your repositories.");
  });

  it("returns noAccessReason('Error') text (not double-wrapped) when no repos are allowed", async () => {
    const result = await runCodeSearch({ keyword: "x" }, makeCtx([]), runtime);
    expect(result).toBe(noAccessReason(makeCtx([]), "Error"));
    expect(result).toBe("Error: you have no repository permissions assigned");
  });

  it("caps results at max_results and still shows the uncapped total in the header (matches v1's results[:max_results] quirk)", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `needle line ${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(root, "many.txt"), lines);
    const result = await runCodeSearch(
      { keyword: "needle", max_results: 2 },
      makeCtx([root]),
      runtime,
    );
    // v1: header uses the RAW accumulated count (5, since one repo's whole
    // result set is extended before the cap check), body is sliced to 2.
    expect(result.startsWith("Found 5 matches:\n")).toBe(true);
    const bodyLines = result.split("\n").slice(1);
    expect(bodyLines.length).toBe(2);
  });

  it("assembles multi-repo results in repo (allowedPaths) order, not completion order", async () => {
    const repoA = fs.mkdtempSync(path.join(root, "repoA-"));
    const repoB = fs.mkdtempSync(path.join(root, "repoB-"));
    fs.writeFileSync(path.join(repoA, "a.txt"), "needle in A\n");
    fs.writeFileSync(path.join(repoB, "b.txt"), "needle in B\n");
    const result = await runCodeSearch(
      { keyword: "needle", max_results: 10 },
      makeCtx([repoA, repoB]),
      runtime,
    );
    const idxA = result.indexOf("needle in A");
    const idxB = result.indexOf("needle in B");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("skips a nonexistent/unsynced repo path without error", async () => {
    const missing = path.join(root, "does-not-exist");
    fs.writeFileSync(path.join(root, "a.txt"), "needle here\n");
    const result = await runCodeSearch({ keyword: "needle" }, makeCtx([missing, root]), runtime);
    expect(result).toContain("needle here");
  });

  it("Codex full-repo review (2026-07-14, Warning): a caller-supplied max_results far above the ceiling is clamped, not honored verbatim — the body never exceeds the ceiling even when the raw match count does", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `needle line ${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(root, "many.txt"), lines);
    const result = await runCodeSearch(
      { keyword: "needle", max_results: 999_999_999 },
      makeCtx([root]),
      runtime,
    );
    expect(result.startsWith("Found 500 matches:\n")).toBe(true);
    const bodyLines = result.split("\n").slice(1);
    expect(bodyLines.length).toBe(200); // MAX_RESULTS_CEILING, not the raw match count
  });
});

// ---------------------------------------------------------------------------
// rg codepath (stub binary) — proves the plumbing (argv wiring, spawn,
// stdout parsing, prefix stripping) works when rgBin is set, using an
// injected Node stub script instead of real ripgrep (not installed here).
// This is intentionally labeled as testing the STUB, not rg's own flag
// semantics — buildSearchArgv's unit tests above are what pin the exact
// rg argv shape against the ported Python spec.
// ---------------------------------------------------------------------------
describe("code_search (rg codepath via stub binary)", () => {
  let stubPath: string;

  beforeEach(() => {
    // A minimal stand-in for `rg --line-number --no-heading --fixed-strings
    // ... --glob <pat> -- <keyword> <repoPath>`: translates the rg-shaped
    // argv it receives into a real `grep` invocation and echoes that
    // output back verbatim, so this test exercises real search semantics
    // (not a hardcoded canned response) while only requiring a "binary"
    // named however rgBin points, not a real rg install.
    stubPath = path.join(root, "fake-rg.mjs");
    fs.writeFileSync(
      stubPath,
      `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
const flags = argv.slice(0, dashIdx);
const [keyword, repoPath] = argv.slice(dashIdx + 1);
const globIdx = flags.indexOf("--glob");
const grepArgs = ["-rn", "-F"];
if (globIdx !== -1) grepArgs.push("--include", flags[globIdx + 1]);
grepArgs.push("--", keyword, repoPath);
const result = spawnSync("grep", grepArgs, { encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.exit(0);
`,
    );
    fs.chmodSync(stubPath, 0o755);
  });

  it("searches via the injected rg-shaped stub and strips the repo prefix", async () => {
    const repoDir = fs.mkdtempSync(path.join(root, "rgrepo-"));
    fs.writeFileSync(path.join(repoDir, "hit.txt"), "special.chars(here)\n");
    const runtime = { rgBin: stubPath, timeoutMs: 15_000 };
    const result = await runCodeSearch(
      { keyword: "special.chars(here)" },
      makeCtx([repoDir]),
      runtime,
    );
    expect(result).toContain("hit.txt:1:special.chars(here)");
    expect(result).not.toContain(repoDir);
  });

  it("respects file_pattern via --glob through the stub", async () => {
    const repoDir = fs.mkdtempSync(path.join(root, "rgrepo2-"));
    fs.writeFileSync(path.join(repoDir, "keep.ts"), "findme\n");
    fs.writeFileSync(path.join(repoDir, "skip.txt"), "findme\n");
    const runtime = { rgBin: stubPath, timeoutMs: 15_000 };
    const result = await runCodeSearch(
      { keyword: "findme", file_pattern: "*.ts" },
      makeCtx([repoDir]),
      runtime,
    );
    expect(result).toContain("keep.ts");
    expect(result).not.toContain("skip.txt");
  });
});

// ---------------------------------------------------------------------------
// Timeout + cap-triggered cancellation — uses injectable rgBin + a very
// short test-only timeoutMs (see __internal.runCodeSearch's `runtime`
// parameter) instead of waiting out a real 15s timeout.
// ---------------------------------------------------------------------------
describe("code_search timeout + cancellation", () => {
  it("kills a hung search after the (short, test-injected) timeout and reports the timeout message", async () => {
    const hangScript = path.join(root, "fake-hang.mjs");
    // A bare unsettled top-level `await new Promise(() => {})` doesn't
    // actually hang the process — Node detects it and exits (code 13,
    // "Detected unsettled top-level await") almost immediately, which
    // would make this test pass for the wrong reason. `setInterval` keeps
    // a real event-loop reference alive, so the process genuinely never
    // exits on its own and can only be reaped by execFile's timeout kill.
    fs.writeFileSync(hangScript, `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`);
    fs.chmodSync(hangScript, 0o755);

    const repoDir = fs.mkdtempSync(path.join(root, "hangrepo-"));
    const runtime = { rgBin: hangScript, timeoutMs: 100 };
    const start = Date.now();
    const result = await runCodeSearch({ keyword: "x" }, makeCtx([repoDir]), runtime);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // proves it didn't wait for a real 15s timeout
    expect(result).toContain(`search timed out for ${path.basename(repoDir)}`);
  });

  it("aborts remaining repo searches once max_results is reached, killing their child process before completion", async () => {
    // A stub whose behavior is keyed off the repo dir's basename: repos
    // named "slow-*" sleep past the point this test checks, then write a
    // marker file if (and only if) they were allowed to run to completion.
    // A repo NOT prefixed "slow-" answers immediately with one match,
    // reaching max_results=1 and triggering cancellation of the others.
    const stubPath = path.join(root, "fake-cancel-rg.mjs");
    fs.writeFileSync(
      stubPath,
      `#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
const [keyword, repoPath] = argv.slice(dashIdx + 1);
const base = path.basename(repoPath);
if (base.startsWith("slow-")) {
  await new Promise((r) => setTimeout(r, 2000));
  fs.writeFileSync(path.join(repoPath, "..", base + ".marker"), "ran-to-completion");
  console.log(repoPath + "/dummy.txt:1:" + keyword + " slow match");
} else {
  console.log(repoPath + "/dummy.txt:1:" + keyword + " fast match");
}
`,
    );
    fs.chmodSync(stubPath, 0o755);

    const fastRepo = fs.mkdtempSync(path.join(root, "fastrepo-"));
    const slowRepo1 = path.join(root, "slow-repoB");
    const slowRepo2 = path.join(root, "slow-repoC");
    fs.mkdirSync(slowRepo1);
    fs.mkdirSync(slowRepo2);

    const runtime = { rgBin: stubPath, timeoutMs: 15_000 };
    const result = await runCodeSearch(
      { keyword: "needle", max_results: 1 },
      makeCtx([fastRepo, slowRepo1, slowRepo2]),
      runtime,
    );
    expect(result).toContain("fast match");
    expect(result).not.toContain("slow match");

    // Give the (correctly killed) slow searches time to have finished IF
    // they had NOT been killed, then assert they left no completion marker
    // — proving the child processes were actually terminated, not merely
    // ignored while continuing to run in the background.
    await new Promise((r) => setTimeout(r, 2400));
    expect(fs.existsSync(path.join(root, "slow-repoB.marker"))).toBe(false);
    expect(fs.existsSync(path.join(root, "slow-repoC.marker"))).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------
describe("validateRepoPath", () => {
  it("allows a path within an allowed root", () => {
    const [ok, realPath, err] = validateRepoPath(root, [root]);
    expect(ok).toBe(true);
    expect(realPath).toBe(fs.realpathSync(root));
    expect(err).toBe("");
  });

  it("denies a path outside all allowed roots", () => {
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "code-search-outside-"));
    try {
      const [ok, , err] = validateRepoPath(outside, [root]);
      expect(ok).toBe(false);
      expect(err).toBe("Access denied: path is outside your assigned repositories");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows a bare relative subdirectory name by joining it against the allowed root (QA-reported: used to only resolve against process cwd)", () => {
    fs.mkdirSync(path.join(root, "deploy"));
    fs.writeFileSync(path.join(root, "deploy", "auto-deploy.sh"), "#!/bin/sh\n");
    const [ok, realPath, err] = validateRepoPath("deploy", [root]);
    expect(ok).toBe(true);
    expect(realPath).toBe(fs.realpathSync(path.join(root, "deploy")));
    expect(err).toBe("");
  });
});

describe("list_directory tool", () => {
  it("lists all allowed repo roots when path is '.'", async () => {
    const repoA = fs.mkdtempSync(path.join(root, "repoA-"));
    const repoB = fs.mkdtempSync(path.join(root, "repoB-"));
    fs.writeFileSync(path.join(repoA, "f.txt"), "x");
    const result = await listDirectoryTool.execute({ path: "." }, makeCtx([repoA, repoB]));
    expect(result).toContain(`📁 ${path.basename(repoA)}/`);
    expect(result).toContain(`📁 ${path.basename(repoB)}/`);
    expect(result).toContain("📄 f.txt");
  });

  it("returns 'No repositories found.' when '.' and no allowed root is an actual directory", async () => {
    const ghost = path.join(root, "ghost-repo");
    const result = await listDirectoryTool.execute({ path: "." }, makeCtx([ghost]));
    expect(result).toBe("No repositories found.");
  });

  it("returns noAccessReason('Error') text when no repos are allowed", async () => {
    const result = await listDirectoryTool.execute({ path: "." }, makeCtx([]));
    expect(result).toBe("Error: you have no repository permissions assigned");
  });

  it("lists an explicit path within an allowed root", async () => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "x.txt"), "hi");
    const result = await listDirectoryTool.execute({ path: sub }, makeCtx([root]));
    expect(result).toContain("📄 x.txt");
  });

  it("lists a bare relative subdirectory name, not just an absolute path (QA-reported: list_directory(\"deploy\") was always denied)", async () => {
    const sub = path.join(root, "deploy");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "auto-deploy.sh"), "#!/bin/sh\n");
    const result = await listDirectoryTool.execute({ path: "deploy" }, makeCtx([root]));
    expect(result).toContain("📄 auto-deploy.sh");
  });

  it("denies an explicit path outside allowed roots", async () => {
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "code-search-outside2-"));
    try {
      const result = await listDirectoryTool.execute({ path: outside }, makeCtx([root]));
      expect(result).toBe("Error: Access denied: path is outside your assigned repositories");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("errors when the explicit path is not a directory", async () => {
    const file = path.join(root, "f.txt");
    fs.writeFileSync(file, "x");
    const result = await listDirectoryTool.execute({ path: file }, makeCtx([root]));
    expect(result).toBe(`Error: not a directory: ${file}`);
  });
});

describe("_build_tree (via buildTree)", () => {
  it("skips every name in _SKIP_DIRS", () => {
    for (const skip of [".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache", "target", ".gradle", ".idea", ".vscode"]) {
      fs.mkdirSync(path.join(root, skip));
      fs.writeFileSync(path.join(root, skip, "inside.txt"), "x");
    }
    fs.mkdirSync(path.join(root, "kept-dir"));
    const tree = buildTree(root, 0, 3);
    expect(tree).toContain("kept-dir");
    expect(tree).not.toContain("inside.txt");
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain(".git");
  });

  it("skips dotfiles and dotdirs", () => {
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "visible.txt"), "x");
    const tree = buildTree(root, 0, 3);
    expect(tree).toContain("visible.txt");
    expect(tree).not.toContain(".env");
    expect(tree).not.toContain(".hidden");
  });

  it("does not follow symlinks (skips the symlinked ENTRY itself, not the real dir reached another way)", () => {
    // real-target is placed OUTSIDE root's own tree (a sibling), reachable
    // from root only via the symlink — proving the walk never descends
    // through the symlink, as opposed to merely deduplicating a
    // real-target that also happens to be listed directly.
    const outsideBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "code-search-symtarget-"));
    try {
      fs.writeFileSync(path.join(outsideBase, "secret.txt"), "x");
      const link = path.join(root, "link-to-real");
      fs.symlinkSync(outsideBase, link, "dir");
      const tree = buildTree(root, 0, 3);
      expect(tree).not.toContain("link-to-real");
      expect(tree).not.toContain("secret.txt");
    } finally {
      fs.rmSync(outsideBase, { recursive: true, force: true });
    }
  });

  it("truncates depth: a dir header appears but its own children do not beyond max_depth", () => {
    const level1 = path.join(root, "level1");
    const level2 = path.join(level1, "level2");
    fs.mkdirSync(level2, { recursive: true });
    fs.writeFileSync(path.join(level2, "deep.txt"), "x");
    const tree = buildTree(root, 0, 1);
    expect(tree).toContain("level1");
    expect(tree).not.toContain("level2");
    expect(tree).not.toContain("deep.txt");
  });

  it("caps directories at 15 per level with an '... and N more' message", () => {
    for (let i = 0; i < 20; i++) {
      fs.mkdirSync(path.join(root, `dir${String(i).padStart(2, "0")}`));
    }
    const tree = buildTree(root, 0, 2);
    const dirLines = tree.split("\n").filter((l) => l.includes("📁"));
    expect(dirLines.length).toBe(15);
    expect(tree).toContain("... and 5 more");
  });

  it("caps files at 25 per level, combining dir+file overflow into one message", () => {
    for (let i = 0; i < 16; i++) {
      fs.mkdirSync(path.join(root, `dd${String(i).padStart(2, "0")}`));
    }
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(root, `ff${String(i).padStart(2, "0")}.txt`), "x");
    }
    const tree = buildTree(root, 0, 2);
    // 16 dirs -> 1 hidden, 30 files -> 5 hidden => "... and 6 more"
    expect(tree).toContain("... and 6 more");
  });
});
