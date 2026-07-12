// Task 1: embed-store.ts — versioned custom binary sidecar for embedding
// vectors + metadata, replacing v1's numpy-specific .npz (unreadable from
// Node without a numpy-format parser dependency, which is why this is a
// new format rather than a port — v1-python-final has no equivalent file).
//
// Byte layout (see .superpowers/sdd/task-1-brief.md for the source spec):
//   offset 0   : magic "CAXEMB1\0" (8 bytes ASCII, trailing NUL included)
//   offset 8   : uint32 LE version (current = 1)
//   offset 12  : uint32 LE dims
//   offset 16  : uint32 LE count (chunk count)
//   offset 20  : count * dims * 4 bytes — row-major float32 vectors. Each
//                row is expected to already be normalized by the caller;
//                this layer does no numeric processing.
//   offset 20 + count*dims*4 : uint32 LE metaJsonByteLength
//   immediately after         : metaJsonByteLength bytes of UTF-8 JSON,
//                                an EmbeddingChunkMeta[] in row order.
//
// Versioned so a future format change can add a branch on `version`
// instead of a breaking rewrite; this task only implements v1.
import * as fs from "node:fs";
import { realpathOrResolve } from "./file-reader.js";

export type EmbeddingChunkMeta = {
  path: string;
  start: number;
  end: number;
  name: string;
  hash: string;
};

export type EmbeddingIndex = {
  dims: number;
  vectors: Float32Array[];
  meta: EmbeddingChunkMeta[];
};

// Exported (not just internal consts) so tests can construct/inspect raw
// buffers using the same layout math instead of duplicating magic numbers.
export const MAGIC = Buffer.from("CAXEMB1\0", "ascii"); // 8 bytes, includes trailing NUL
export const VERSION = 1;
export const HEADER_LEN = 12; // version + dims + count, all uint32 LE
export const VECTORS_START = MAGIC.byteLength + HEADER_LEN; // 20

/**
 * Sidecar path for a repo checkout: realpath(repoPath) + ".emb.v1.bin" —
 * deliberately outside repoPath itself (same rationale as symbol-index.ts's
 * indexPath: a repo-sync clone rmtree+rename must never touch it). Uses
 * realpathOrResolve (not a throwing realpath) so callers can compute the
 * same path for a repo that may not exist yet (e.g. to check for a stale
 * sidecar before a fresh clone).
 */
export function embPath(repoPath: string): string {
  return realpathOrResolve(repoPath) + ".emb.v1.bin";
}

/**
 * Serialize an EmbeddingIndex to embPath(repoPath), temp-then-rename so a
 * concurrent reader only ever sees a complete old file or a complete new
 * file, never a half-written one.
 */
export function writeEmbeddingIndex(repoPath: string, index: EmbeddingIndex): void {
  const { dims, vectors, meta } = index;
  const count = vectors.length;

  if (vectors.length !== meta.length) {
    throw new Error(
      `vectors.length (${vectors.length}) must equal meta.length (${meta.length})`,
    );
  }
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== dims) {
      throw new Error(
        `vectors[${i}].length (${vectors[i].length}) must equal dims (${dims})`,
      );
    }
  }

  const headerBuf = Buffer.alloc(HEADER_LEN);
  headerBuf.writeUInt32LE(VERSION, 0);
  headerBuf.writeUInt32LE(dims, 4);
  headerBuf.writeUInt32LE(count, 8);

  const vectorBuf = Buffer.alloc(count * dims * 4);
  for (let i = 0; i < count; i++) {
    const vec = vectors[i];
    for (let j = 0; j < dims; j++) {
      vectorBuf.writeFloatLE(vec[j], (i * dims + j) * 4);
    }
  }

  const metaBuf = Buffer.from(JSON.stringify(meta), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(metaBuf.byteLength, 0);

  const out = Buffer.concat([MAGIC, headerBuf, vectorBuf, lenBuf, metaBuf]);

  const finalPath = embPath(repoPath);
  const tmpPath = finalPath + ".tmp";
  fs.writeFileSync(tmpPath, out);
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Read an EmbeddingIndex previously written by writeEmbeddingIndex. Missing
 * file, magic/version mismatch, or any other corruption -> null. Never
 * throws — callers treat null as "no index yet, (re)build it".
 */
export function readEmbeddingIndex(repoPath: string): EmbeddingIndex | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(embPath(repoPath));
  } catch {
    return null;
  }

  try {
    if (buf.byteLength < VECTORS_START) return null;
    if (!buf.subarray(0, MAGIC.byteLength).equals(MAGIC)) return null;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = view.getUint32(8, true);
    if (version !== VERSION) return null;

    const dims = view.getUint32(12, true);
    const count = view.getUint32(16, true);

    const vectorBytes = count * dims * 4;
    const lenOffset = VECTORS_START + vectorBytes;
    if (buf.byteLength < lenOffset + 4) return null;

    const metaLen = view.getUint32(lenOffset, true);
    const metaStart = lenOffset + 4;
    if (buf.byteLength < metaStart + metaLen) return null;

    const vectors: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      const vec = new Float32Array(dims);
      for (let j = 0; j < dims; j++) {
        vec[j] = view.getFloat32(VECTORS_START + (i * dims + j) * 4, true);
      }
      vectors.push(vec);
    }

    const parsed: unknown = JSON.parse(
      buf.subarray(metaStart, metaStart + metaLen).toString("utf8"),
    );
    if (!Array.isArray(parsed) || parsed.length !== count) {
      throw new Error("meta JSON is not an array of length count");
    }
    for (const entry of parsed) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>).path !== "string" ||
        typeof (entry as Record<string, unknown>).start !== "number" ||
        typeof (entry as Record<string, unknown>).end !== "number" ||
        typeof (entry as Record<string, unknown>).name !== "string" ||
        typeof (entry as Record<string, unknown>).hash !== "string"
      ) {
        throw new Error("meta entry missing required EmbeddingChunkMeta fields");
      }
    }
    const meta = parsed as EmbeddingChunkMeta[];

    return { dims, vectors, meta };
  } catch {
    return null;
  }
}
