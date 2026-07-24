import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  classifyFilename,
  isAllowedFilename,
  parseAttachmentBytes,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_FILE_BYTES,
  MAX_FILE_BASE64_CHARS,
  MAX_FILES_PER_MESSAGE,
  __internal,
} from "../src/attachments.js";
import { fileBlockToText, type FileBlock } from "../src/domain.js";

// ---- fixture builders ----------------------------------------------------

async function makeXlsx(rows: (string | number)[][], sheetName = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makeMultiSheetXlsx(sheets: Record<string, (string | number)[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip
    .folder("_rels")!
    .file(
      ".rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip
    .folder("word")!
    .file(
      "document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    );
  return zip.generateAsync({ type: "nodebuffer" });
}

// Patch every ZIP central-directory record's declared uncompressed size to a
// huge value, simulating a classic (honest-central-directory) zip bomb.
function inflateDeclaredSizes(zipBuf: Buffer): Buffer {
  const buf = Buffer.from(zipBuf);
  const CEN_SIG = 0x02014b50;
  for (let p = 0; p + 46 <= buf.length; p++) {
    if (buf.readUInt32LE(p) === CEN_SIG) buf.writeUInt32LE(0x7fffffff, p + 24); // ~2 GB
  }
  return buf;
}

// ---- classification ------------------------------------------------------

describe("classifyFilename / isAllowedFilename", () => {
  it("maps extensions to the right parser kind", () => {
    expect(classifyFilename("report.xlsx")).toBe("excel");
    expect(classifyFilename("bug.docx")).toBe("word");
    expect(classifyFilename("server.log")).toBe("text");
    expect(classifyFilename("data.csv")).toBe("text");
    expect(classifyFilename("Service.java")).toBe("text");
    expect(classifyFilename("config.yaml")).toBe("text");
  });
  it("is case-insensitive on the extension", () => {
    expect(classifyFilename("REPORT.XLSX")).toBe("excel");
    expect(classifyFilename("Notes.MD")).toBe("text");
  });
  it("accepts conventional extensionless text filenames", () => {
    expect(classifyFilename("Dockerfile")).toBe("text");
    expect(classifyFilename("Makefile")).toBe("text");
  });
  it("rejects unsupported / binary types (null)", () => {
    expect(classifyFilename("scan.pdf")).toBeNull();
    expect(classifyFilename("legacy.doc")).toBeNull(); // old binary Word, not docx
    expect(classifyFilename("legacy.xls")).toBeNull(); // old binary Excel, not xlsx
    expect(classifyFilename("app.exe")).toBeNull();
    expect(classifyFilename("photo.png")).toBeNull(); // images go through the image path
    expect(classifyFilename("archive.zip")).toBeNull();
    expect(classifyFilename("noext")).toBeNull();
    expect(isAllowedFilename("scan.pdf")).toBe(false);
    expect(isAllowedFilename("a.csv")).toBe(true);
  });
});

// ---- plain text + encoding ----------------------------------------------

describe("parseAttachmentBytes — plain text", () => {
  it("decodes UTF-8 text", async () => {
    const r = await parseAttachmentBytes("note.txt", Buffer.from("订单导入失败：第 3 行数量为空", "utf8"));
    expect(r.parseError).toBeNull();
    expect(r.kind).toBe("text");
    expect(r.extractedText).toBe("订单导入失败：第 3 行数量为空");
    expect(r.truncated).toBe(false);
  });

  it("strips a UTF-8 BOM", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]);
    const r = await parseAttachmentBytes("a.txt", bytes);
    expect(r.extractedText).toBe("hello");
  });

  it("decodes GBK (non-UTF-8) content via the legacy-encoding fallback", async () => {
    // "数据" in GBK = CA FD BE DD (not valid UTF-8), with an ASCII prefix.
    const bytes = Buffer.concat([Buffer.from("order: ", "ascii"), Buffer.from([0xca, 0xfd, 0xbe, 0xdd])]);
    const r = await parseAttachmentBytes("export.csv", bytes);
    expect(r.parseError).toBeNull();
    expect(r.extractedText).toBe("order: 数据");
  });

  it("treats content with NUL bytes as a (non-blocking) parse failure", async () => {
    const bytes = Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]);
    const r = await parseAttachmentBytes("weird.txt", bytes);
    expect(r.parseError).not.toBeNull();
    expect(r.extractedText).toBe("");
  });

  it("truncates over-long text and flags it", async () => {
    const long = "x".repeat(MAX_EXTRACTED_TEXT_CHARS + 500);
    const r = await parseAttachmentBytes("big.log", Buffer.from(long, "utf8"));
    expect(r.truncated).toBe(true);
    expect(r.extractedText.length).toBe(MAX_EXTRACTED_TEXT_CHARS);
  });

  it("an empty file parses to empty text, not an error", async () => {
    const r = await parseAttachmentBytes("empty.txt", Buffer.alloc(0));
    expect(r.parseError).toBeNull();
    expect(r.extractedText).toBe("");
  });
});

// ---- excel ---------------------------------------------------------------

describe("parseAttachmentBytes — excel (.xlsx)", () => {
  it("extracts cells as CSV-ish rows", async () => {
    const buf = await makeXlsx([
      ["订单号", "数量", "状态"],
      ["A100", 3, "失败"],
    ]);
    const r = await parseAttachmentBytes("orders.xlsx", buf);
    expect(r.parseError).toBeNull();
    expect(r.kind).toBe("excel");
    expect(r.extractedText).toContain("订单号,数量,状态");
    expect(r.extractedText).toContain("A100,3,失败");
  });

  it("labels multiple sheets", async () => {
    const buf = await makeMultiSheetXlsx({ 失败样例: [["a", 1]], 正确样例: [["b", 2]] });
    const r = await parseAttachmentBytes("cmp.xlsx", buf);
    expect(r.extractedText).toContain("# 工作表：失败样例");
    expect(r.extractedText).toContain("# 工作表：正确样例");
  });

  it("a corrupt xlsx degrades to a parse error, not a throw", async () => {
    const r = await parseAttachmentBytes("broken.xlsx", Buffer.from("this is not a real xlsx", "utf8"));
    expect(r.parseError).not.toBeNull();
    expect(r.extractedText).toBe("");
  });

  it("rejects a zip-bomb-shaped xlsx (declared decompressed size over cap)", async () => {
    const good = await makeXlsx([["a", 1]]);
    const bomb = inflateDeclaredSizes(good);
    const r = await parseAttachmentBytes("bomb.xlsx", bomb);
    expect(r.parseError).toContain("体积异常");
    expect(r.extractedText).toBe("");
  });
});

// ---- word ----------------------------------------------------------------

describe("parseAttachmentBytes — word (.docx)", () => {
  it("extracts paragraph text", async () => {
    const buf = await makeDocx(["导入失败：第3行数量为空", "第二段说明"]);
    const r = await parseAttachmentBytes("bug.docx", buf);
    expect(r.parseError).toBeNull();
    expect(r.kind).toBe("word");
    expect(r.extractedText).toContain("导入失败：第3行数量为空");
    expect(r.extractedText).toContain("第二段说明");
  });

  it("a corrupt docx degrades to a parse error", async () => {
    const r = await parseAttachmentBytes("broken.docx", Buffer.from("nope", "utf8"));
    expect(r.parseError).not.toBeNull();
  });
});

// ---- zip scanner unit ----------------------------------------------------

describe("__internal.sumZipDeclaredUncompressedSize", () => {
  it("sums declared sizes for a real zip and returns null for a non-zip", async () => {
    const buf = await makeXlsx([["hello world", 123]]);
    const total = __internal.sumZipDeclaredUncompressedSize(buf);
    expect(total).not.toBeNull();
    expect(total!).toBeGreaterThan(0);
    expect(__internal.sumZipDeclaredUncompressedSize(Buffer.from("not a zip"))).toBeNull();
  });
});

// ---- fileBlockToText (domain helper) -------------------------------------

describe("fileBlockToText", () => {
  const base: FileBlock = {
    type: "file",
    filename: "orders.csv",
    mediaType: "text/csv",
    base64Data: "AAA",
    extractedText: "订单号,数量\nA100,3",
    truncated: false,
  };

  it("renders a filename header + extracted text", () => {
    expect(fileBlockToText(base)).toBe("【附件：orders.csv】\n订单号,数量\nA100,3");
  });
  it("appends a truncation marker", () => {
    expect(fileBlockToText({ ...base, truncated: true })).toContain("…（内容过长，已截断）");
  });
  it("renders a parse failure as a short note, never the bytes", () => {
    const t = fileBlockToText({ ...base, extractedText: "", parseError: "已损坏" });
    expect(t).toBe("【附件：orders.csv】\n（该文件无法解析：已损坏）");
    expect(t).not.toContain("AAA");
  });
  it("handles empty extracted text", () => {
    expect(fileBlockToText({ ...base, extractedText: "   " })).toContain("（文件为空或无可提取文本）");
  });
});

// ---- constants sanity ----------------------------------------------------

describe("attachment limits", () => {
  it("are coherent", () => {
    expect(MAX_FILES_PER_MESSAGE).toBe(3);
    expect(MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
    // base64 cap must be able to carry a full MAX_FILE_BYTES payload
    expect(MAX_FILE_BASE64_CHARS).toBeGreaterThanOrEqual(Math.ceil(MAX_FILE_BYTES / 3) * 4);
    expect(MAX_EXTRACTED_TEXT_CHARS).toBeGreaterThan(0);
  });
});
