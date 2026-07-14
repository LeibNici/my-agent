// Task 2 (Phase 4b): chunking.ts — symbol-span chunking (reusing the ctags
// sidecar) + MyBatis XML window chunking. Ported from
// v1-python-final:app/tools/semantic_index.py's _chunk_file_by_symbols,
// _chunk_xml_windows, _collect_chunks, _chunk_hash, verbatim in behavior.
//
// node:fs is module-mocked (not vi.spyOn'd — Node's builtin ESM namespace
// properties are non-configurable in this environment, confirmed by a
// throwaway probe before writing this file: `vi.spyOn(fs, "readFileSync")`
// throws "Cannot redefine property") so the symlink-skip test below can
// assert readFileSync was never CALLED with the symlink's path or its
// resolved target — a stronger, unswallowed-by-any-try/catch proof of
// "never opened" than merely asserting on collectChunks' return value.
// Real reads still work everywhere else: the mock wraps the actual
// implementation rather than replacing it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIndex } from "../src/tools/symbol-index.js";
import { collectChunks, chunkHash, truncateChars, type Chunk } from "../src/tools/chunking.js";

let root: string;
let repo: string;

beforeEach(() => {
  const tmpBase = fs.realpathSync(os.tmpdir());
  root = fs.mkdtempSync(path.join(tmpBase, "chunking-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  vi.mocked(fs.readFileSync).mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// collectChunks — no ctags index at all
// ---------------------------------------------------------------------------
describe("collectChunks — no ctags index", () => {
  it("returns [] immediately when loadTags returns null (index never built), even with XML files present", () => {
    // A valid-looking mapper XML exists, but buildIndex() is never called —
    // matches v1's `if tags is None: return []`, which short-circuits
    // BEFORE the XML directory scan, not just the symbol-chunking step.
    const mapperDir = path.join(repo, "resources", "mapper");
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(path.join(mapperDir, "Foo.xml"), "<x/>\n".repeat(10));

    expect(collectChunks(repo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectChunks — symbol-span chunking
// ---------------------------------------------------------------------------
describe("collectChunks — symbol-span chunking", () => {
  it("chunks a preamble + 3 functions into 4 spans with exact line boundaries", async () => {
    fs.writeFileSync(
      path.join(repo, "a.ts"),
      [
        "// License header line 1",
        "// License header line 2",
        'import { helper } from "./helper";',
        "",
        "export function funcA(): number {",
        "  return 1;",
        "}",
        "",
        "export function funcB(): number {",
        "  return 2;",
        "}",
        "",
        "export function funcC(): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
    );
    const ok = await buildIndex(repo);
    expect(ok).toBe(true);

    const chunks = collectChunks(repo);
    const own = chunks.filter((c) => c.path === "a.ts");
    expect(own).toHaveLength(4);

    const preamble = own.find((c) => c.name === "");
    expect(preamble).toMatchObject({ start: 1, end: 4 });
    expect(preamble!.text).toContain("License header line 1");
    expect(preamble!.text).not.toContain("funcA");

    const a = own.find((c) => c.name === "funcA");
    const b = own.find((c) => c.name === "funcB");
    const c = own.find((c) => c.name === "funcC");
    expect(a).toMatchObject({ start: 5, end: 8 });
    expect(b).toMatchObject({ start: 9, end: 12 });
    expect(c).toMatchObject({ start: 13, end: 15 });

    expect(a!.text).toContain("funcA");
    expect(a!.text).not.toContain("funcB");
    expect(c!.text).toContain("funcC");
  });

  it("splits a >120-line function body into contiguous chunks instead of truncating the tail", async () => {
    const bodyLines = Array.from({ length: 150 }, (_, i) => `  console.log(${i});`);
    const content = ["export function bigFunc(): void {", ...bodyLines, "}", ""].join("\n");
    fs.writeFileSync(path.join(repo, "big.ts"), content);
    await buildIndex(repo);

    const chunks = collectChunks(repo).filter((c) => c.path === "big.ts");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ name: "bigFunc", start: 1, end: 120 });
    expect(chunks[1]).toMatchObject({ name: "bigFunc", start: 121, end: 152 });

    // Contiguous (no gap) and the full original span is preserved verbatim
    // across the two chunks — not truncated at chunk 1's boundary.
    expect(chunks[1].start).toBe(chunks[0].end + 1);
    const originalLines = content.replace(/\r\n|\r/g, "\n").split(/(?<=\n)/);
    expect(chunks[0].text + chunks[1].text).toBe(originalLines.slice(0, 152).join(""));
  });
});

// ---------------------------------------------------------------------------
// collectChunks — MyBatis mapper XML window chunking
// ---------------------------------------------------------------------------
describe("collectChunks — MyBatis mapper XML window chunking", () => {
  it("chunks a 200-line resources/mapper XML file into 80-line windows", async () => {
    const mapperDir = path.join(repo, "resources", "mapper");
    fs.mkdirSync(mapperDir, { recursive: true });
    const xmlLines = Array.from({ length: 200 }, (_, i) => `<!-- line ${i + 1} -->`);
    fs.writeFileSync(path.join(mapperDir, "Foo.xml"), xmlLines.join("\n") + "\n");
    await buildIndex(repo);

    const chunks = collectChunks(repo).filter((c) => c.path === "resources/mapper/Foo.xml");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ start: 1, end: 80, name: "" });
    expect(chunks[1]).toMatchObject({ start: 81, end: 160, name: "" });
    expect(chunks[2]).toMatchObject({ start: 161, end: 200, name: "" });
    expect(chunks[0].text).toContain("line 1 -->");
    expect(chunks[0].text).not.toContain("line 81 -->");
    expect(chunks[1].text).toContain("line 81 -->");
    expect(chunks[2].text).toContain("line 200 -->");
  });

  it("does NOT window a same-named XML file outside a resources/mapper-ish path", async () => {
    const otherDir = path.join(repo, "src", "config");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "Foo.xml"), "<x/>\n".repeat(10));
    await buildIndex(repo);

    const chunks = collectChunks(repo).filter((c) => c.path.endsWith("Foo.xml"));
    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// collectChunks — symlinked mapper XML is skipped, target never opened
// ---------------------------------------------------------------------------
describe("collectChunks — symlinked XML is skipped, never opened", () => {
  it("skips a symlinked mapper XML pointing outside the repo; target content never read", async () => {
    const mapperDir = path.join(repo, "resources", "mapper");
    fs.mkdirSync(mapperDir, { recursive: true });

    const outsideSecret = path.join(root, "outside-secret.xml");
    fs.writeFileSync(outsideSecret, "<!-- SENTINEL-SECRET-MARKER-DO-NOT-LEAK -->\n".repeat(5));

    const evilLink = path.join(mapperDir, "evil.xml");
    fs.symlinkSync(outsideSecret, evilLink);

    await buildIndex(repo);
    vi.mocked(fs.readFileSync).mockClear();

    const chunks = collectChunks(repo);

    // No chunk was produced for the symlinked path at all.
    expect(chunks.some((c) => c.path === "resources/mapper/evil.xml")).toBe(false);
    // Its content never leaked into ANY chunk, symlinked-path or otherwise.
    expect(chunks.some((c) => c.text.includes("SENTINEL-SECRET-MARKER"))).toBe(false);

    // Stronger check: readFileSync was never invoked with the symlink's own
    // path OR its resolved target — proving the target was never opened at
    // all, not merely opened-and-silently-swallowed by a try/catch.
    const calls = vi.mocked(fs.readFileSync).mock.calls.map((args) => String(args[0]));
    expect(calls).not.toContain(evilLink);
    expect(calls).not.toContain(fs.realpathSync(outsideSecret));
  });

  it("does not recurse into a symlinked mapper directory (dir-symlink pruned from the walk)", async () => {
    const realMapperElsewhere = path.join(root, "real-mapper-elsewhere");
    fs.mkdirSync(realMapperElsewhere, { recursive: true });
    fs.writeFileSync(
      path.join(realMapperElsewhere, "Secret.xml"),
      "<!-- SENTINEL-DIR-MARKER-DO-NOT-LEAK -->\n".repeat(5),
    );

    const resourcesDir = path.join(repo, "resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.symlinkSync(realMapperElsewhere, path.join(resourcesDir, "mapper"), "dir");

    await buildIndex(repo);
    const chunks = collectChunks(repo);
    expect(chunks.some((c) => c.text.includes("SENTINEL-DIR-MARKER"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectChunks — total-chunk ceiling (Codex full-repo review, 2026-07-14,
// Warning: an unusually large repo could hand embedAndSaveIndex an
// unbounded chunk array, with unbounded downstream embedding-API cost/time)
// ---------------------------------------------------------------------------
describe("collectChunks — total-chunk ceiling", () => {
  it("truncates to the cap when the real scan produces more chunks than the (test-overridden, small) ceiling allows", async () => {
    const mapperDir = path.join(repo, "resources", "mapper");
    fs.mkdirSync(mapperDir, { recursive: true });
    // 5 files x 1 window each (well under the 80-line window size) = 5 chunks.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(mapperDir, `M${i}.xml`), `<!-- file ${i} -->\n`);
    }
    await buildIndex(repo);

    const uncapped = collectChunks(repo);
    expect(uncapped.length).toBe(5);

    const capped = collectChunks(repo, 3);
    expect(capped).toHaveLength(3);
    expect(capped).toEqual(uncapped.slice(0, 3));
  });

  it("does not truncate when chunk count is at or under the cap", async () => {
    const mapperDir = path.join(repo, "resources", "mapper");
    fs.mkdirSync(mapperDir, { recursive: true });
    fs.writeFileSync(path.join(mapperDir, "M.xml"), "<!-- only file -->\n");
    await buildIndex(repo);

    const chunks = collectChunks(repo, 1);
    expect(chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// chunkHash
// ---------------------------------------------------------------------------
describe("chunkHash", () => {
  it("is deterministic for identical chunks and changes whenever path/name/text changes", () => {
    const chunk: Chunk = { path: "a.ts", start: 1, end: 3, name: "foo", text: "function foo() {}\n" };
    const h1 = chunkHash(chunk);
    const h2 = chunkHash({ ...chunk });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(24);
    expect(h1).toMatch(/^[0-9a-f]{24}$/);

    expect(chunkHash({ ...chunk, text: chunk.text + " " })).not.toBe(h1);
    expect(chunkHash({ ...chunk, name: "bar" })).not.toBe(h1);
    expect(chunkHash({ ...chunk, path: "b.ts" })).not.toBe(h1);
  });
});

// ---------------------------------------------------------------------------
// truncateChars — MAX_CHUNK_CHARS truncation must match Python's `str[:n]`
// codepoint-based slicing, not JS's UTF-16-code-unit-based String.slice.
// Regression test for a real bug caught in this task's self-review: a naive
// `.slice(0, 6000)` bisects a surrogate pair straddling the cutoff, leaving
// a lone surrogate that later silently becomes U+FFFD on UTF-8 encoding.
// ---------------------------------------------------------------------------
describe("truncateChars", () => {
  it("returns text unchanged when at or under the cap", () => {
    expect(truncateChars("hello", 10)).toBe("hello");
    expect(truncateChars("hello", 5)).toBe("hello");
  });

  it("truncates plain ASCII text cleanly at the cap", () => {
    expect(truncateChars("abcdefgh", 5)).toBe("abcde");
  });

  it("never splits a surrogate pair — keeps an astral character whole rather than emitting a lone surrogate", () => {
    // An emoji (U+1F600, 2 UTF-16 code units) straddling the cut: naive
    // String.slice(0, 6000) would land exactly between its two halves.
    const text = "a".repeat(5999) + "\u{1F600}" + "b".repeat(10);
    expect(text.length).toBe(6011); // UTF-16 length: 5999 + 2 + 10

    const truncated = truncateChars(text, 6000);

    // The emoji is kept whole (making the UTF-16 result 6001, one code unit
    // over the nominal cap) rather than bisected into a lone high surrogate.
    expect(truncated).toBe("a".repeat(5999) + "\u{1F600}");
    expect(truncated.length).toBe(6001);
    expect(truncated.codePointAt(5999)).toBe(0x1f600);

    // The UTF-8 bytes match Python's `text[:6000]`, verified via a live
    // `python3 -c` repro before writing this test: tail bytes
    // 61 61 61 61 61 61 61 f0 9f 98 80 (7 trailing "a"s then the emoji's
    // 4-byte UTF-8 encoding), never the U+FFFD replacement byte sequence
    // ef bf bd a lone surrogate would produce.
    const tailHex = Buffer.from(truncated, "utf8").subarray(-11).toString("hex");
    expect(tailHex).toBe("61616161616161f09f9880");
  });

  it("codepoint-counts, not code-unit-counts: a string of astral characters truncates at the codepoint boundary", () => {
    // 6001 astral characters (12002 UTF-16 code units) capped at 6000
    // codepoints must keep exactly 6000 whole characters, not 6000 code
    // units (which would again bisect the 6000th character).
    const text = "\u{1F600}".repeat(6001);
    const truncated = truncateChars(text, 6000);
    expect(Array.from(truncated).length).toBe(6000);
    expect(truncated).toBe("\u{1F600}".repeat(6000));
  });
});
