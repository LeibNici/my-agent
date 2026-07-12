// Task 6: symbol-index.ts — ctags-backed find_symbol/list_file_symbols.
// Ported from v1-python-final:app/tools/symbol_index.py (_index_path,
// build_index, _TAGS_CACHE/_load_tags, find_symbol, list_file_symbols),
// verbatim in behavior.
//
// Environment note (verified before writing this file): `ctags --version`
// reports "Universal Ctags 5.9.0" at /usr/bin/ctags — real Universal Ctags,
// not Exuberant Ctags, so the flags ported from v1 (--output-format=json,
// --fields=+n) are exercised for real here, not stubbed. All `buildIndex`
// tests below spawn the REAL ctags binary against real fixture files
// (.ts/.java/.vue) written to a temp dir — no mocking of the subprocess.
// The manual probe run before writing this file confirmed: JSON output is
// newline-delimited (one JSON object per line, not a JSON array), ~10
// "ptag" pseudo-records precede the real "tag" records, and local
// const/let declarations inside a TS function or class method carry both
// `scope` and `scopeKind` while genuine top-level consts carry neither.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildIndex,
  findSymbolTool,
  listFileSymbolsTool,
  __internal,
} from "../src/tools/symbol-index.js";
import type { ToolContext } from "../src/tools/registry.js";

const { buildIndexWithBin, indexPath, detectCtagsBin, CTAGS_BIN } = __internal;

function makeCtx(allowedRepoPaths: string[], unsyncedRepoNames: string[] = []): ToolContext {
  return { allowedRepoPaths, unsyncedRepoNames, userId: null };
}

let root: string;
let repo: string;

beforeEach(() => {
  const tmpBase = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(tmpBase, "symbol-index-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, "sub"));

  fs.writeFileSync(
    path.join(repo, "a.ts"),
    [
      "export function foo(x: number): number {",
      "  const localConst = x + 1;",
      "  return localConst;",
      "}",
      "",
      "export function fooBarHelper(): void {}",
      "",
      "export const TOP_CONST = 42;",
      "",
      "export interface Bar {",
      "  baz: string;",
      "}",
      "",
      "export class MyClass {",
      "  method1() {",
      "    const innerConst = 1;",
      "    return innerConst;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(repo, "sub", "B.java"),
    [
      "package sub;",
      "public class B {",
      "    public int method() {",
      "        int local = 1;",
      "        return local;",
      "    }",
      "}",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(repo, "c.vue"),
    [
      "<template>",
      "  <div>{{ msg }}</div>",
      "</template>",
      "<script>",
      "export function vueFunc() {",
      "  return 1;",
      "}",
      "export const VUE_CONST = 5;",
      "</script>",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Environment sanity — Universal Ctags is really installed here.
// ---------------------------------------------------------------------------
describe("environment", () => {
  it("real ctags is detected on this machine (Universal Ctags, confirmed by task setup)", () => {
    expect(detectCtagsBin()).toBeTruthy();
    expect(CTAGS_BIN).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// _index_path port — sidecar OUTSIDE the repo checkout, keyed by realpath.
// ---------------------------------------------------------------------------
describe("indexPath (sidecar location)", () => {
  it("is realpath(repoPath) + '.tags.json', a SIBLING of the repo dir, not nested inside it", () => {
    const p = indexPath(repo);
    expect(p).toBe(fs.realpathSync(repo) + ".tags.json");
    expect(p.startsWith(repo + path.sep)).toBe(false);
    expect(path.dirname(p)).toBe(path.dirname(repo));
  });
});

// ---------------------------------------------------------------------------
// build_index port — real ctags subprocess, tmp-then-rename, graceful false.
// ---------------------------------------------------------------------------
describe("buildIndex — real ctags subprocess", () => {
  it("builds an index for a real fixture repo (.ts/.java/.vue) and returns true", async () => {
    const ok = await buildIndex(repo);
    expect(ok).toBe(true);
    expect(fs.existsSync(indexPath(repo))).toBe(true);
  });

  it("leaves no .tmp file behind after a successful build", async () => {
    await buildIndex(repo);
    expect(fs.existsSync(indexPath(repo) + ".tmp")).toBe(false);
  });

  it("writes only newline-delimited JSON records, with ptag pseudo-records present in the raw file (filtering happens at load time, not build time)", async () => {
    await buildIndex(repo);
    const raw = fs.readFileSync(indexPath(repo), "utf8").trim().split("\n");
    expect(raw.length).toBeGreaterThan(10);
    const parsed = raw.map((l) => JSON.parse(l));
    expect(parsed.some((t) => t._type === "ptag")).toBe(true);
    expect(parsed.some((t) => t._type === "tag" && t.name === "foo")).toBe(true);
  });

  it("returns false and does not throw for a nonexistent repo directory", async () => {
    const ok = await buildIndex(path.join(root, "does-not-exist"));
    expect(ok).toBe(false);
  });

  it("(__internal) returns false when ctagsBin is null (ctags not installed)", async () => {
    const ok = await buildIndexWithBin(repo, null, 5000);
    expect(ok).toBe(false);
    expect(fs.existsSync(indexPath(repo))).toBe(false);
  });

  it("(__internal) returns false and does not throw when ctagsBin points at a nonexistent binary", async () => {
    const ok = await buildIndexWithBin(repo, "/definitely/not/a/real/ctags-binary", 5000);
    expect(ok).toBe(false);
    expect(fs.existsSync(indexPath(repo))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// find_symbol
// ---------------------------------------------------------------------------
describe("find_symbol", () => {
  it("returns noAccessReason text when no repos are allowed", async () => {
    const result = await findSymbolTool.execute({ name: "foo" }, makeCtx([]));
    expect(result).toBe("Error: you have no repository permissions assigned");
  });

  it("'no index available' message, byte-matched to v1, when ctags never ran for ANY allowed repo", async () => {
    // No buildIndex() call at all — sidecar doesn't exist.
    const result = await findSymbolTool.execute({ name: "foo" }, makeCtx([repo]));
    expect(result).toBe(
      "No symbol index available for your repositories yet (ctags may not be installed, or the repo hasn't finished syncing since this feature was added). Fall back to code_search.",
    );
  });

  it("prefers an EXACT match over substring matches — 'foo' hits only foo, not fooBarHelper", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "foo" }, makeCtx([repo]));
    expect(result).toContain("Found 1 exact match(es) for 'foo':");
    expect(result).toContain(`repo/a.ts:1 [function] foo`);
    expect(result).not.toContain("fooBarHelper");
  });

  it("falls back to substring match when no exact match exists", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "Helper" }, makeCtx([repo]));
    expect(result).toContain("Found 1 substring match(es) for 'Helper':");
    expect(result).toContain("fooBarHelper");
  });

  it("substring match is case-insensitive and can return multiple hits across kinds", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "const" }, makeCtx([repo]));
    expect(result).toContain("substring match(es)");
    expect(result).toContain("TOP_CONST");
    expect(result).toContain("VUE_CONST");
  });

  it("ptag pseudo-records are filtered out — searching a ptag field name finds nothing real", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "TAG_PROGRAM_AUTHOR" }, makeCtx([repo]));
    expect(result).toBe(
      "No symbol named 'TAG_PROGRAM_AUTHOR' found in the index. Try code_search for a broader text match.",
    );
  });

  it("'no symbol found, try code_search' message, byte-matched to v1, when index exists but has no hit", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "totallyMissingSymbol" }, makeCtx([repo]));
    expect(result).toBe(
      "No symbol named 'totallyMissingSymbol' found in the index. Try code_search for a broader text match.",
    );
  });

  it("searches across ALL allowed repos, not just the first", async () => {
    const repo2 = path.join(root, "repo2");
    fs.mkdirSync(repo2);
    fs.writeFileSync(path.join(repo2, "z.ts"), "export function onlyInRepo2() {}\n");
    await buildIndex(repo);
    await buildIndex(repo2);

    const result = await findSymbolTool.execute({ name: "onlyInRepo2" }, makeCtx([repo, repo2]));
    expect(result).toContain("Found 1 exact match(es)");
    expect(result).toContain("repo2/z.ts:1 [function] onlyInRepo2");
  });

  it("still searches indexed repos when a SIBLING allowed repo has no index yet (not 'no index available')", async () => {
    const repo2 = path.join(root, "repo2");
    fs.mkdirSync(repo2);
    // repo2 never indexed.
    await buildIndex(repo);

    const result = await findSymbolTool.execute({ name: "foo" }, makeCtx([repo, repo2]));
    expect(result).toContain("Found 1 exact match(es) for 'foo':");
  });

  it("respects max_results", async () => {
    await buildIndex(repo);
    const result = await findSymbolTool.execute({ name: "const", max_results: 1 }, makeCtx([repo]));
    const lines = result.split("\n").slice(1); // drop the "Found N ..." header line
    expect(lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mtime cache invalidation
// ---------------------------------------------------------------------------
describe("mtime-keyed cache invalidation", () => {
  it("a rebuilt index is picked up on the next call, not a stale cached value", async () => {
    await buildIndex(repo);
    const before = await findSymbolTool.execute({ name: "brandNewSymbol" }, makeCtx([repo]));
    expect(before).toContain("No symbol named 'brandNewSymbol' found");

    // Add a new symbol and force a distinct mtime, then rebuild.
    fs.writeFileSync(path.join(repo, "new.ts"), "export function brandNewSymbol() {}\n");
    await buildIndex(repo);

    const after = await findSymbolTool.execute({ name: "brandNewSymbol" }, makeCtx([repo]));
    expect(after).toContain("Found 1 exact match(es) for 'brandNewSymbol':");
    expect(after).toContain("repo/new.ts:1 [function] brandNewSymbol");
  });
});

// ---------------------------------------------------------------------------
// list_file_symbols
// ---------------------------------------------------------------------------
describe("list_file_symbols", () => {
  it("returns noAccessReason text when no repos are allowed", async () => {
    const result = await listFileSymbolsTool.execute({ path: "a.ts" }, makeCtx([]));
    expect(result).toBe("Error: you have no repository permissions assigned");
  });

  it("denies a path outside the allowed repositories", async () => {
    const outside = path.join(root, "outside.ts");
    fs.writeFileSync(outside, "export function x() {}\n");
    const result = await listFileSymbolsTool.execute({ path: outside }, makeCtx([repo]));
    expect(result).toBe(
      "Error: Access denied or file not found — path must be within your assigned repositories.",
    );
  });

  it("'no index available' message, byte-matched to v1, when this repo has no index yet", async () => {
    const result = await listFileSymbolsTool.execute({ path: "a.ts" }, makeCtx([repo]));
    expect(result).toBe(
      "No symbol index available for this repository yet (ctags may not be installed, or the repo hasn't finished syncing since this feature was added). Fall back to file_reader.",
    );
  });

  it("lists top-level symbols sorted by line number, filtering out local 'constant'-kind noise", async () => {
    await buildIndex(repo);
    const result = await listFileSymbolsTool.execute({ path: "a.ts" }, makeCtx([repo]));

    // Local consts (scope=foo, scope=MyClass.method1) must be excluded.
    expect(result).not.toContain("localConst");
    expect(result).not.toContain("innerConst");

    // Top-level/API-surface symbols must be present.
    expect(result).toContain("foo");
    expect(result).toContain("fooBarHelper");
    expect(result).toContain("TOP_CONST");
    expect(result).toContain("Bar");
    expect(result).toContain("baz");
    expect(result).toContain("MyClass");
    expect(result).toContain("method1");

    // Sorted by line ascending: foo (line 1) must appear before TOP_CONST (line 8).
    const fooIdx = result.indexOf(": [function] foo");
    const topConstIdx = result.indexOf("TOP_CONST");
    expect(fooIdx).toBeGreaterThan(-1);
    expect(topConstIdx).toBeGreaterThan(fooIdx);
  });

  it("resolves a path relative to the repo root (as returned by code_search)", async () => {
    await buildIndex(repo);
    const result = await listFileSymbolsTool.execute({ path: "sub/B.java" }, makeCtx([repo]));
    expect(result).toContain("symbol(s) in sub/B.java:");
    expect(result).toContain("[class] B");
    expect(result).toContain("[method] method");
  });

  it("resolves an absolute path too", async () => {
    await buildIndex(repo);
    const abs = path.join(repo, "a.ts");
    const result = await listFileSymbolsTool.execute({ path: abs }, makeCtx([repo]));
    expect(result).toContain("symbol(s) in a.ts:");
  });

  it("extracts symbols from a .vue SFC's <script> block", async () => {
    await buildIndex(repo);
    const result = await listFileSymbolsTool.execute({ path: "c.vue" }, makeCtx([repo]));
    expect(result).toContain("[function] vueFunc");
    expect(result).toContain("[constant] VUE_CONST");
  });

  it("'no indexed symbols' message for a file with none (e.g. unindexed language)", async () => {
    await buildIndex(repo);
    fs.writeFileSync(path.join(repo, "plain.txt"), "just text\n");
    const result = await listFileSymbolsTool.execute({ path: "plain.txt" }, makeCtx([repo]));
    expect(result).toBe(
      "No indexed symbols found in plain.txt (file may not exist, be empty, or be an unindexed language).",
    );
  });
});
