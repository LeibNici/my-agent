// Non-image file attachments (2026-07-24) — PMs upload logs / CSVs / code
// files / failing Excel-import samples / Word bug write-ups as context for a
// chat turn. Unlike images (which the vision model reads raw), a file is
// parsed SERVER-SIDE into text here, and only that text ever reaches the
// model or an issue body (the raw bytes are kept solely for replay/download).
//
// This module is a leaf utility — it depends on the parser libraries
// (exceljs / mammoth / chardet) and Node built-ins only, NOT on domain/pi
// types, so it sits cleanly under the three-layer isolation constraint (it
// carries no pi types). sse.ts is the one caller that turns a ParsedAttachment
// into a domain FileBlock; everything downstream speaks FileBlock.
//
// Scope (grilled + agreed 2026-07-24):
//  - Types: plain text / code (decoded as text) + .xlsx (exceljs) + .docx
//    (mammoth). Anything else is rejected up-front by validateFiles (sse.ts)
//    against ALLOWED_FILE_EXTENSIONS — this module only ever sees an allowed
//    kind, but still degrades gracefully (parseError, never throw out) on a
//    corrupt/encrypted/wrong-content file so a bad upload never blocks the
//    whole message (a PM asking "why won't this import" may well be handing
//    us the broken file itself).
//  - Encoding: China-primary product, so a CSV "saved from Excel" is very
//    often GBK, not UTF-8 — see decodeTextBytes for the UTF-8-strict →
//    chardet → GB18030-safety-net ladder.
//  - Safety: .xlsx/.docx are ZIP containers; a 2 MB upload can declare
//    gigabytes of decompressed content (zip bomb). checkZipDecompressedSize
//    sums the central-directory declared sizes BEFORE handing bytes to the
//    parser and refuses to parse an over-cap archive. No macro execution is
//    ever involved (we only read text), so no macro sandbox is needed.
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { detect as detectEncoding } from "chardet";

// ==================== Limits (single source of truth) ====================

/** Per-message file count cap (grilled: 3 — the "failing sample + expected
 * sample + maybe a log" comparison case, kept below images' 5 because each
 * file's extracted text costs far more context budget than one image). */
export const MAX_FILES_PER_MESSAGE = 3;

/** Raw original-file size cap (2 MiB). Deliberately smaller than images'
 * ~4.5 MB: for an image the byte size directly bounds what the model sees,
 * but a file is parsed first and MAX_EXTRACTED_TEXT_CHARS bounds the model
 * cost independently — so this cap's only job is pre-parse resource
 * protection (fast rejection, cheap decode), and a lower ceiling is
 * strictly safer there. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Wire cap on the base64 string sse.ts validates (mirrors images'
 * MAX_IMAGE_BASE64_CHARS). base64 inflates bytes by 4/3, so this is the
 * base64-length equivalent of MAX_FILE_BYTES. */
export const MAX_FILE_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/** Cap on the EXTRACTED text length, independent of raw file size (grilled:
 * a compressed .xlsx/.docx can expand to many times its own size once turned
 * into text, so bounding the raw file alone would not bound the model cost).
 * Over-cap text is truncated with a visible marker. */
export const MAX_EXTRACTED_TEXT_CHARS = 20_000;

/** Zip-bomb guard: a .xlsx/.docx whose central directory declares more than
 * this many decompressed bytes is refused (parseError, not a crash). 50 MiB
 * clears any realistic office document expanded from a ≤2 MB file while still
 * catching the classic honest-central-directory bomb by orders of magnitude. */
export const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

// ==================== Allowed types / classification ====================

// Extensions accepted as plain text (decoded, encoding-detected). Generous
// but bounded: engineers' everyday logs/configs/code/data. Anything NOT here
// (and not xlsx/docx) is rejected at validation time with a clear message,
// rather than accepted-then-garbled — reconciles "allowed set = text + xlsx
// + docx" (up-front reject) with "parse failure never blocks" (graceful
// placeholder only for an allowed type that then fails to parse).
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "xml", "html", "htm", "css", "scss", "less",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
  "java", "kt", "kts", "go", "rs", "c", "h", "cpp", "cc", "cxx", "hpp",
  "cs", "php", "rb", "swift", "m", "mm", "scala", "groovy", "dart", "lua",
  "pl", "pm", "r", "sql", "sh", "bash", "zsh", "ps1", "bat",
  "ini", "conf", "cfg", "toml", "properties", "env", "gradle", "diff", "patch", "tex",
]);

// Extensionless filenames that are conventionally plain text.
const TEXT_BASENAMES = new Set(["dockerfile", "makefile", "gitignore", "gitattributes", "license", "readme"]);

export type AttachmentKind = "text" | "excel" | "word";

function extensionOf(filename: string): string {
  const base = filename.toLowerCase().replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** null == not an accepted attachment type. sse.ts's validateFiles uses this
 * for the up-front allowlist reject; parseAttachmentBytes uses the non-null
 * kind to pick a parser. */
export function classifyFilename(filename: string): AttachmentKind | null {
  const ext = extensionOf(filename);
  if (ext === "xlsx") return "excel";
  if (ext === "docx") return "word";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (!ext && TEXT_BASENAMES.has(filename.toLowerCase().replace(/^.*[\\/]/, ""))) return "text";
  return null;
}

export function isAllowedFilename(filename: string): boolean {
  return classifyFilename(filename) !== null;
}

// ==================== Parse result ====================

export type ParsedAttachment = {
  kind: AttachmentKind;
  /** Parsed text — fed to the model and embedded in issue bodies. "" when
   * parseError is set (the caller renders a placeholder from parseError). */
  extractedText: string;
  /** extractedText was cut at MAX_EXTRACTED_TEXT_CHARS. */
  truncated: boolean;
  /** Human-readable (Chinese) reason the file could not be parsed, or null on
   * success. Non-null does NOT block the message — the file is still stored
   * and downloadable; the model/issue just sees "this file couldn't be read". */
  parseError: string | null;
};

class ParseFailure extends Error {}

/** Parse already-decoded bytes into text. Never throws for a bad file — a
 * parse failure is returned as parseError so the caller can keep the message
 * flowing (grilled decision: a broken file is often the very thing being
 * reported). `filename` is only used to pick the parser (classification was
 * already validated up-front by the caller). */
export async function parseAttachmentBytes(filename: string, bytes: Buffer): Promise<ParsedAttachment> {
  const kind = classifyFilename(filename) ?? "text";
  try {
    let raw: string;
    if (kind === "excel") raw = await extractExcelText(bytes);
    else if (kind === "word") raw = await extractWordText(bytes);
    else raw = extractPlainText(bytes);
    const { text, truncated } = truncate(raw);
    return { kind, extractedText: text, truncated, parseError: null };
  } catch (err) {
    return { kind, extractedText: "", truncated: false, parseError: describeFailure(kind, err) };
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_EXTRACTED_TEXT_CHARS), truncated: true };
}

function describeFailure(kind: AttachmentKind, err: unknown): string {
  if (err instanceof ParseFailure) return err.message;
  if (kind === "excel") return "Excel 文件无法解析（可能已损坏或受密码保护）";
  if (kind === "word") return "Word 文件无法解析（可能已损坏或受密码保护）";
  return "文件无法作为文本读取";
}

// ==================== Plain text (encoding detection) ====================

function extractPlainText(bytes: Buffer): string {
  if (looksBinary(bytes)) throw new ParseFailure("文件内容无法作为文本读取（疑似二进制文件）");
  return decodeTextBytes(bytes);
}

// NUL bytes (and a high ratio of other control characters) mark content that
// is almost certainly binary mislabeled with a text extension — reject it as
// a parse failure rather than emit a wall of replacement characters. Only the
// first 4 KB is sampled; UTF-16 (which is full of NULs) is handled by BOM
// sniffing in decodeTextBytes before this ever runs on decoded output — this
// runs on RAW bytes, so a BOM-less UTF-16 file does read as "binary" here, an
// accepted edge (BOM-less UTF-16 is vanishingly rare for these file types).
function looksBinary(bytes: Buffer): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true; // a NUL byte is a near-certain binary tell
    // Allow tab(9) LF(10) CR(13) and everything >= space(32); count the rest.
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / n > 0.3;
}

// UTF-8-strict → chardet → GB18030 safety net. Ordering matters: valid UTF-8
// is a strong positive signal (legacy CJK byte pairs almost never form a
// fully-valid multi-byte UTF-8 stream across a whole file), so trying it
// first, fatally, avoids mis-detecting real UTF-8 as something else. Only
// when that fails do we consult chardet — and because chardet is unreliable
// on SHORT CJK samples (it routinely calls GBK "Shift_JIS"), the fallback for
// this China-primary product is GB18030 (a superset of GBK/GB2312), not
// chardet's raw guess, unless chardet clearly says Big5/UTF-16.
function decodeTextBytes(bytes: Buffer): string {
  // Authoritative BOMs first.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8 — a legacy encoding.
  }
  const label = resolveLegacyEncoding(bytes);
  return new TextDecoder(label).decode(bytes); // non-fatal: replacement chars beat throwing
}

function resolveLegacyEncoding(bytes: Buffer): string {
  const guess = (detectEncoding(bytes) ?? "").toLowerCase();
  if (guess.includes("big5")) return "big5";
  if (guess.includes("utf-16le")) return "utf-16le";
  if (guess === "utf-16" || guess.includes("utf-16be")) return "utf-16be";
  // GB family, or a Japanese/Korean guess that on Chinese content is almost
  // always a chardet misfire → GB18030 (covers GBK/GB2312 and all of Unicode).
  return "gb18030";
}

// ==================== Excel (.xlsx) ====================

async function extractExcelText(bytes: Buffer): Promise<string> {
  guardZipBomb(bytes);
  const wb = new ExcelJS.Workbook();
  // exceljs's loader wants an ArrayBuffer-ish; a Node Buffer works at runtime.
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);

  const lines: string[] = [];
  let total = 0;
  const sheetCount = wb.worksheets.length;
  outer: for (const ws of wb.worksheets) {
    if (sheetCount > 1) {
      const header = `# 工作表：${ws.name}`;
      lines.push(header);
      total += header.length + 1;
    }
    const colCount = Math.min(ws.actualColumnCount || 0, 100); // cap pathologically wide sheets
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= colCount; c++) cells.push(cellToString(row.getCell(c).value));
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop(); // trim trailing empties
      const line = cells.join(",");
      lines.push(line);
      total += line.length + 1;
    });
    // Stop building once well past the text cap — truncate() will finish the
    // job, but this keeps a huge (yet not zip-bomb) sheet from allocating an
    // enormous intermediate string first.
    if (total > MAX_EXTRACTED_TEXT_CHARS) break outer;
  }
  return lines.join("\n");
}

// exceljs returns rich objects for formulas / hyperlinks / rich text / dates
// / errors — flatten each to the human-visible string, never "[object Object]".
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text; // hyperlink cell
    if (Array.isArray(v.richText)) return v.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    if ("result" in v) return cellToString(v.result); // formula cell → its computed result
    if ("error" in v) return String(v.error); // error cell (#REF!, #DIV/0!, …)
  }
  return "";
}

// ==================== Word (.docx) ====================

async function extractWordText(bytes: Buffer): Promise<string> {
  guardZipBomb(bytes);
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value;
}

// ==================== Zip-bomb guard ====================

function guardZipBomb(bytes: Buffer): void {
  const declared = sumZipDeclaredUncompressedSize(bytes);
  if (declared !== null && declared > MAX_DECOMPRESSED_BYTES) {
    throw new ParseFailure("文件解压后体积异常过大，已跳过解析（疑似异常文件）");
  }
}

// Sum the uncompressed sizes the ZIP central directory declares, WITHOUT
// decompressing anything. The classic zip bomb is a well-formed archive with
// an honest (huge) central directory, so this catches it before a single byte
// is inflated. Returns null when the structure can't be verified cheaply
// (no EOCD found, or ZIP64) — the real parser then runs, backstopped by the
// 2 MB raw-input cap (a lying-central-directory bomb is out of scope for an
// internal, authenticated-upload threat model, per the grilled "轻量版" guard).
function sumZipDeclaredUncompressedSize(buf: Buffer): number | null {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  if (buf.length < 22) return null;
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return null; // ZIP64
  let p = cdOffset;
  const end = Math.min(cdOffset + cdSize, buf.length);
  let total = 0;
  while (p + 46 <= end) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const uncompressed = buf.readUInt32LE(p + 24);
    if (uncompressed === 0xffffffff) return null; // ZIP64 per-entry size
    total += uncompressed;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}

// Test-only escape hatch (matches issue-tracker-client.ts's __internal
// convention) — lets unit tests reach the ZIP scanner directly with crafted
// central-directory bytes without going through a full parse.
export const __internal = { sumZipDeclaredUncompressedSize, looksBinary, resolveLegacyEncoding };
