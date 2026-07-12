// Task 1: embed-store.ts — versioned binary sidecar (.emb.v1.bin) replacing
// v1's numpy-specific .npz. See .superpowers/sdd/task-1-brief.md for the
// exact byte layout this format follows.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embPath,
  writeEmbeddingIndex,
  readEmbeddingIndex,
  MAGIC,
  VERSION,
  HEADER_LEN,
  VECTORS_START,
} from "../src/tools/embed-store.js";

/**
 * Build a raw .emb.v1.bin buffer directly from the documented layout
 * (see embed-store.ts's header comment), bypassing writeEmbeddingIndex's
 * own validation so tests can construct headers that are structurally
 * valid but carry a semantically-corrupt meta section.
 */
function buildRawIndexBuffer(opts: {
  dims: number;
  count: number;
  vectors: number[][];
  metaJson: string;
}): Buffer {
  const { dims, count, vectors, metaJson } = opts;
  if (MAGIC.byteLength + HEADER_LEN !== VECTORS_START) {
    throw new Error("layout constants inconsistent — embed-store.ts changed?");
  }
  const headerBuf = Buffer.alloc(HEADER_LEN);
  headerBuf.writeUInt32LE(VERSION, 0);
  headerBuf.writeUInt32LE(dims, 4);
  headerBuf.writeUInt32LE(count, 8);

  const vectorBuf = Buffer.alloc(count * dims * 4);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < dims; j++) {
      vectorBuf.writeFloatLE(vectors[i][j], (i * dims + j) * 4);
    }
  }

  const metaBuf = Buffer.from(metaJson, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(metaBuf.byteLength, 0);

  return Buffer.concat([MAGIC, headerBuf, vectorBuf, lenBuf, metaBuf]);
}

describe("embed-store", () => {
  it("embPath = realpath(repoPath) + .emb.v1.bin，sidecar 在仓库目录外", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const p = embPath(dir);
    expect(p).toBe(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("write 后 read 出的向量/元数据字节级往返一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const vectors = [new Float32Array([0.6, 0.8]), new Float32Array([1, 0])];
    const meta = [
      { path: "a.ts", start: 1, end: 10, name: "foo", hash: "abc123" },
      { path: "b.ts", start: 5, end: 20, name: "", hash: "def456" },
    ];
    writeEmbeddingIndex(dir, { dims: 2, vectors, meta });
    const loaded = readEmbeddingIndex(dir)!;
    expect(loaded.dims).toBe(2);
    // Compare against the original Float32Array values (not decimal
    // literals): 0.6/0.8 aren't exactly representable in IEEE-754 binary32,
    // so `new Float32Array([0.6, 0.8])[0]` is already 0.6000000238418579
    // before any write/read happens. The byte-level round-trip guarantee
    // this test checks is vectors[i] -> write -> read -> identical
    // Float32Array bits, not "survives a decimal literal unscathed".
    expect(Array.from(loaded.vectors[0])).toEqual(Array.from(vectors[0]));
    expect(Array.from(loaded.vectors[1])).toEqual(Array.from(vectors[1]));
    expect(loaded.meta).toEqual(meta);
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("不存在/损坏文件 -> null，不抛", () => {
    expect(readEmbeddingIndex("/tmp/definitely-does-not-exist-xyz")).toBeNull();
  });

  it("write 是 temp-then-rename：写入过程中读者只能看到旧文件或新文件，不会看到半写内容", () => {
    // 断言实现细节：writeEmbeddingIndex 内部必须写 .tmp 再 rename，检查 rename 后目录里不残留 .tmp
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    writeEmbeddingIndex(dir, { dims: 1, vectors: [new Float32Array([1])], meta: [{ path: "x", start: 1, end: 1, name: "", hash: "h" }] });
    expect(existsSync(dir + ".emb.v1.bin.tmp")).toBe(false);
    expect(existsSync(dir + ".emb.v1.bin")).toBe(true);
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("magic/version 不匹配 -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    writeFileSync(embPath(dir), Buffer.from("garbage not a valid index"));
    expect(readEmbeddingIndex(dir)).toBeNull();
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  // --- self-review findings: write-time invariants, read-time meta validation ---

  it("vectors.length !== meta.length -> writeEmbeddingIndex 抛错（vectors 比 meta 多）", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const vectors = [new Float32Array([1, 2]), new Float32Array([3, 4])];
    const meta = [{ path: "a.ts", start: 1, end: 2, name: "foo", hash: "h1" }];
    expect(() => writeEmbeddingIndex(dir, { dims: 2, vectors, meta })).toThrow(
      /vectors\.length \(2\) must equal meta\.length \(1\)/,
    );
    expect(existsSync(dir + ".emb.v1.bin")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("vectors.length !== meta.length -> writeEmbeddingIndex 抛错（meta 比 vectors 多）", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const vectors = [new Float32Array([1, 2])];
    const meta = [
      { path: "a.ts", start: 1, end: 2, name: "foo", hash: "h1" },
      { path: "b.ts", start: 3, end: 4, name: "bar", hash: "h2" },
    ];
    expect(() => writeEmbeddingIndex(dir, { dims: 2, vectors, meta })).toThrow(
      /vectors\.length \(1\) must equal meta\.length \(2\)/,
    );
    expect(existsSync(dir + ".emb.v1.bin")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("某个向量长度 !== dims（过短）-> writeEmbeddingIndex 抛错，错误信息指出具体是哪个下标", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const vectors = [new Float32Array([1, 2, 3]), new Float32Array([1, 2])]; // index 1 too short for dims=3
    const meta = [
      { path: "a.ts", start: 1, end: 2, name: "foo", hash: "h1" },
      { path: "b.ts", start: 3, end: 4, name: "bar", hash: "h2" },
    ];
    expect(() => writeEmbeddingIndex(dir, { dims: 3, vectors, meta })).toThrow(
      /vectors\[1\]\.length \(2\) must equal dims \(3\)/,
    );
    expect(existsSync(dir + ".emb.v1.bin")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("某个向量长度 !== dims（过长）-> writeEmbeddingIndex 抛错，错误信息指出具体是哪个下标", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const vectors = [new Float32Array([1, 2]), new Float32Array([1, 2, 3, 4])]; // index 1 too long for dims=2
    const meta = [
      { path: "a.ts", start: 1, end: 2, name: "foo", hash: "h1" },
      { path: "b.ts", start: 3, end: 4, name: "bar", hash: "h2" },
    ];
    expect(() => writeEmbeddingIndex(dir, { dims: 2, vectors, meta })).toThrow(
      /vectors\[1\]\.length \(4\) must equal dims \(2\)/,
    );
    expect(existsSync(dir + ".emb.v1.bin")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("header 正确但 meta JSON 元素缺少必需字段 -> readEmbeddingIndex 返回 null（不抛）", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const buf = buildRawIndexBuffer({
      dims: 2,
      count: 1,
      vectors: [[1, 2]],
      // missing "hash" field entirely
      metaJson: JSON.stringify([{ path: "a.ts", start: 1, end: 2, name: "foo" }]),
    });
    writeFileSync(embPath(dir), buf);
    expect(readEmbeddingIndex(dir)).toBeNull();
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("header 正确、count 匹配，但 meta 不是数组（如 {}）-> readEmbeddingIndex 返回 null（不抛）", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const buf = buildRawIndexBuffer({
      dims: 2,
      count: 1,
      vectors: [[1, 2]],
      metaJson: JSON.stringify({}),
    });
    writeFileSync(embPath(dir), buf);
    expect(readEmbeddingIndex(dir)).toBeNull();
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });
});
