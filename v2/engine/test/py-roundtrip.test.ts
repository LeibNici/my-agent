// 跨语言回放验收门：证明 Python 写的行和 Node 写的行互相可读、且字节相同。
// 这是 Phase 2 整个计划存在的理由——见 .superpowers/sdd/task-4-brief.md。
//
// Python 侧统一走一个内联脚本模板（execFileSync(PYTHON_BIN, ["-c", script, dbPath, jsonArg])），
// 用 argv 传参而不是走 stdin：sys.argv[1] 是 dbPath（打补丁到 app.database.DB_PATH），
// sys.argv[2] 是一段 JSON，{"op": "init"|"add"|"dump"|"raw", ...}。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStorage, type Storage, type StoredMessageRow } from "../src/db/storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/ -> engine/ -> v2/ -> 仓库根（app/database.py 所在目录），子进程以此为 cwd
// 才能 `import app.database`。
const REPO_ROOT = resolve(__dirname, "../../..");
const PYTHON_BIN = process.env.PYTHON_BIN ?? "/home/my-agent/.venv/bin/python3";

// 单脚本、多操作（op 由 argv[2] 的 JSON 决定）——比每个操作一个独立 -c 脚本更省样板，
// 效果等价：每次 execFileSync 调用仍然只做一件事。
const PY_DRIVER = `
import asyncio, json, sys
import app.database as d

d.DB_PATH = sys.argv[1]
args = json.loads(sys.argv[2])
op = args["op"]


async def main():
    if op == "init":
        await d.init_db()
        import aiosqlite
        async with aiosqlite.connect(d.DB_PATH) as db:
            await db.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, 'seed', 'x', 'x')",
                (args["session_id"],),
            )
            await db.commit()
    elif op == "add":
        mid = await d.add_message(args["session_id"], args["role"], args["content"])
        print(json.dumps({"id": mid}))
    elif op == "dump":
        msgs = await d.get_messages(args["session_id"])
        print(json.dumps(msgs, ensure_ascii=False))
    elif op == "raw":
        import aiosqlite
        async with aiosqlite.connect(d.DB_PATH) as db:
            cur = await db.execute("SELECT content FROM messages WHERE id = ?", (args["id"],))
            row = await cur.fetchone()
            print(json.dumps({"content": row[0]}))
    else:
        raise ValueError(f"unknown op: {op}")


asyncio.run(main())
`;

function pyRun(dbPath: string, args: Record<string, unknown>): string {
  return execFileSync(PYTHON_BIN, ["-c", PY_DRIVER, dbPath, JSON.stringify(args)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function pyInit(dbPath: string, sessionId: string): void {
  pyRun(dbPath, { op: "init", session_id: sessionId });
}

function pyAdd(dbPath: string, sessionId: string, role: string, content: unknown): number {
  const out = pyRun(dbPath, { op: "add", session_id: sessionId, role, content });
  return (JSON.parse(out) as { id: number }).id;
}

function pyDump(dbPath: string, sessionId: string): StoredMessageRow[] {
  const out = pyRun(dbPath, { op: "dump", session_id: sessionId });
  return JSON.parse(out) as StoredMessageRow[];
}

function pyRaw(dbPath: string, id: number): string {
  const out = pyRun(dbPath, { op: "raw", id });
  return (JSON.parse(out) as { content: string }).content;
}

// 固定测试数据：三条覆盖 test_message_codec.py 三个 golden 场景的 payload。
const PLAIN = "普通回答";
const BLOCKS = [
  { type: "tool_use", id: "tu_1", name: "code_search", input: { keyword: "不合格评审" } },
];
const FAKE_JSON = "[系统] 这不是JSON";
const BLOCKS_RAW =
  '[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]';

beforeAll(() => {
  // python 不可用（缺失/坏掉）⇒ 这个验收门本身失败，不是 skip。
  try {
    execFileSync(PYTHON_BIN, ["-c", "import app.database"], { cwd: REPO_ROOT });
  } catch (err) {
    throw new Error(
      `PYTHON_BIN (${PYTHON_BIN}) 不可用或无法 import app.database —— 跨语言回放验收门无法运行：${err}`
    );
  }
});

let dir: string, dbPath: string, storage: Storage;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "py-roundtrip-"));
  dbPath = join(dir, "t.db");
  // 用 python 自己的 init_db() 建库（不是 db-fixture.ts 的手抄 DDL）——这条测试要验证的
  // 正是"两边对着同一份真实 schema 读写"，用真实 schema 建库才有意义。
  pyInit(dbPath, "s1");
  storage = openStorage(dbPath);
});
afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("跨语言回放验收门", () => {
  it("① python 写 → node 读：三种 content deep-equal python get_messages 的 dump", () => {
    pyAdd(dbPath, "s1", "assistant", PLAIN);
    pyAdd(dbPath, "s1", "assistant", BLOCKS);
    pyAdd(dbPath, "s1", "user", FAKE_JSON);

    const pyRows = pyDump(dbPath, "s1");
    const nodeRows = storage.getMessages("s1");

    expect(nodeRows).toEqual(pyRows);
    expect(nodeRows.map((r) => r.content)).toEqual([PLAIN, BLOCKS, FAKE_JSON]);
  });

  it("② node 写 → python 读：三种 content deep-equal python get_messages 的 dump", () => {
    storage.addMessage("s1", "assistant", PLAIN);
    storage.addMessage("s1", "assistant", BLOCKS);
    storage.addMessage("s1", "user", FAKE_JSON);

    const nodeRows = storage.getMessages("s1");
    const pyRows = pyDump(dbPath, "s1");

    expect(pyRows).toEqual(nodeRows);
    expect(pyRows.map((r) => r.content)).toEqual([PLAIN, BLOCKS, FAKE_JSON]);
  });

  it("③ 字节一致：同一块数组，python 行与 node 行的 SELECT content 原始字符串全等", () => {
    const pyId = pyAdd(dbPath, "s1", "assistant", BLOCKS);
    const nodeId = storage.addMessage("s1", "assistant", BLOCKS);

    const pyRawContent = pyRaw(dbPath, pyId);
    const nodeRawContent = pyRaw(dbPath, nodeId);

    expect(pyRawContent).toBe(BLOCKS_RAW);
    expect(nodeRawContent).toBe(BLOCKS_RAW);
    expect(nodeRawContent).toBe(pyRawContent);
  });

  it("④ node 时间戳格式 + 与 python 行排序兼容", async () => {
    pyAdd(dbPath, "s1", "assistant", PLAIN);
    const pyTimestamp = pyDump(dbPath, "s1")[0].timestamp;

    // 保证两次写入之间有真实的挂钟时间间隔，字符串排序断言才不会因为落在同一毫秒/
    // 微秒而偶发不稳定（execFileSync 本身启动一个 python 解释器，通常已经有几十毫秒
    // 间隔，这里再加一点显式余量）。
    await new Promise((r) => setTimeout(r, 5));

    const nodeId = storage.addMessage("s1", "user", "node 写的消息");
    const nodeRow = storage.getMessages("s1").find((r) => r.id === nodeId)!;

    expect(nodeRow.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
    expect(nodeRow.timestamp > pyTimestamp).toBe(true);
  });
});
