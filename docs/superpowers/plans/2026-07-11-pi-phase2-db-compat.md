# CodeAxis v2 Phase 2 — DB 兼容层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 v2/engine 加一个能与生产 `agent_data.db` 直接共存的存储层：better-sqlite3 + DB worker 线程，消息行编解码与 Python 版**字节一致**，并用跨语言回放测试（Python 写 → Node 读、Node 写 → Python 读、原始字节比对）作为验收门。

**Architecture:** Node 侧**永不建表、永不迁移**——schema 归 Python `init_db()` 独家所有（绞杀者阶段两进程共库，双写 DDL 是事故源）；Node 打开现有库、逐连接施加同款 PRAGMA、启动时校验所需表/列存在否则 fail-loud。better-sqlite3 是同步库，全部 DB 操作放进 `worker_threads` 里跑，主事件循环（未来的 SSE 流）永不被磁盘 IO 阻塞。编码层的两个字节级事实（见 Global Constraints）用独立 `py-compat.ts` 承载，Phase 6 shadow 双跑要逐字节 diff 两边写的行，编码不一致会把 diff 变成噪音。

**Tech Stack:** better-sqlite3（`npm install --save-exact` 取当日最新精确版，同时装 `@types/better-sqlite3`，版本记入 task report）、Node `worker_threads`、vitest（已有）。跨语言测试用 `/home/my-agent/.venv/bin/python3`（可用 env `PYTHON_BIN` 覆盖）驱动真实 `app/database.py`。

## Global Constraints

（承 Phase 1 全部约束：精确版本锁定、pi 类型隔离——本层 import 任何 pi 类型都是违规、golden 不可改。以下为本 Phase 新增，字节级事实全部经 Python 3.11 实测钉死：）

- **JSON 编码字节事实**：Python `json.dumps(list, ensure_ascii=False)` 的分隔符是 `", "` 和 `": "`（**带空格**），JS `JSON.stringify` 不带——Node 侧必须自实现 `pythonJsonDumps` 对齐。实测 golden：
  `[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]`
- **时间戳字节事实**：`datetime.now().isoformat()` = 本地时间、无时区后缀、6 位微秒，如 `2026-07-11T23:24:52.328079`。Node 侧 `pyLocalIsoNow()` 必须同格式（毫秒补零到 6 位）；**禁止 `Date.toISOString()`**（UTC+`Z`，排序与 `datetime('now','localtime')` 语义双双破坏）。
- **存储编码规则**（oracle = `tests/test_message_codec.py` + `app/database.py:610-646`）：list content → `pythonJsonDumps` 字符串；string 原样；读取时**仅当** `[` 开头才尝试 `JSON.parse`，解析失败保留原字符串。
- **PRAGMA 每连接**：`journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON`（FK 是真实施加的——`messages.session_id` 缺 sessions 行会报错，测试必须先 seed）。
- **Node 永不执行 DDL**（含 CREATE INDEX）；启动校验缺表/缺列 ⇒ throw `SchemaError` 并列出缺什么。
- 已知不追的编码缝隙（README 记录，不解决）：JS 无法区分 `1.0` 与 `1`（Python 写的 `1.0` Node 读回是 `1`；Node 自己写的行不存在该形态）。

## File Structure

```
v2/engine/src/db/
  py-compat.ts     # pythonJsonDumps / pyLocalIsoNow —— 纯函数，字节 golden 钉死
  storage.ts       # openStorage(dbPath) 同步层：PRAGMA、checkSchema、addMessage/getMessages/recordLlmCallMetrics
  worker.ts        # worker_threads 入口：workerData.dbPath 开库，消息循环分发
  client.ts        # createDbClient(dbPath) —— Promise 门面，pending-map 关联请求/响应
v2/engine/test/
  py-compat.test.ts
  db-storage.test.ts    # 同步层，临时库 + 内嵌 schema fixture（从 database.py 逐字复制的 DDL 子集）
  db-worker.test.ts     # 经 worker 的并发/错误传播
  py-roundtrip.test.ts  # 跨语言回放（Phase 2 验收门，需 venv python）
```

---

### Task 1: py-compat —— 两个字节级纯函数

**Files:**
- Create: `v2/engine/src/db/py-compat.ts`
- Test: `v2/engine/test/py-compat.test.ts`

**Interfaces:**
- Produces:

```typescript
export function pythonJsonDumps(value: unknown): string;  // 模拟 json.dumps(v, ensure_ascii=False)
export function pyLocalIsoNow(now?: Date): string;        // 模拟 datetime.now().isoformat()（毫秒→6位补零）
```

- [ ] **Step 1: 写失败测试**（expected 字符串全部是 Python 3.11 实测输出，逐字节）

```typescript
import { describe, it, expect } from "vitest";
import { pythonJsonDumps, pyLocalIsoNow } from "../src/db/py-compat.js";

describe("pythonJsonDumps（json.dumps ensure_ascii=False 字节对齐）", () => {
  it("分隔符带空格 + unicode 原样", () => {
    expect(pythonJsonDumps([{ type: "tool_use", id: "tu_1", name: "code_search",
      input: { keyword: "不合格评审" } }]))
      .toBe('[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]');
  });
  it("字符串转义与 Python 一致", () => {
    expect(pythonJsonDumps([{ type: "text", text: 'a"b\\c\n中' }]))
      .toBe('[{"type": "text", "text": "a\\"b\\\\c\\n中"}]');
  });
  it("布尔/null/数字", () => {
    expect(pythonJsonDumps([{ n: 1.5, i: 2, z: null, b: true }]))
      .toBe('[{"n": 1.5, "i": 2, "z": null, "b": true}]');
    expect(pythonJsonDumps([{ type: "tool_result", tool_use_id: "tu_1", content: "", is_error: false }]))
      .toBe('[{"type": "tool_result", "tool_use_id": "tu_1", "content": "", "is_error": false}]');
  });
  it("非有限数抛错（Python 会产出非法 JSON 的 NaN/Infinity，禁止进库）", () => {
    expect(() => pythonJsonDumps([{ x: NaN }])).toThrow();
  });
});

describe("pyLocalIsoNow（datetime.now().isoformat() 对齐）", () => {
  it("格式：本地时间、无 Z、6 位微秒", () => {
    expect(pyLocalIsoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
  it("确定性：给定 Date 产出给定字符串（毫秒 328 → 328000）", () => {
    expect(pyLocalIsoNow(new Date(2026, 6, 11, 23, 24, 52, 328)))
      .toBe("2026-07-11T23:24:52.328000");
  });
  it("禁 toISOString 语义：结果不含 Z、不含时区偏移", () => {
    expect(pyLocalIsoNow()).not.toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: 跑测失败**（`npm test` → 模块不存在）
- [ ] **Step 3: 实现**

```typescript
// 字符串转义：JSON.stringify 对控制字符/引号/反斜杠的转义与 Python json 一致，
// 非 ASCII 两边都原样保留（ensure_ascii=False ↔ JS 默认），可直接委托。
function pyStr(s: string): string { return JSON.stringify(s); }

export function pythonJsonDumps(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return pyStr(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be stored");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(pythonJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => pyStr(k) + ": " + pythonJsonDumps(v));
    return "{" + entries.join(", ") + "}";
  }
  throw new Error(`unserializable value of type ${typeof value}`);
}

export function pyLocalIsoNow(now: Date = new Date()): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1, 2)}-${p(now.getDate(), 2)}` +
    `T${p(now.getHours(), 2)}:${p(now.getMinutes(), 2)}:${p(now.getSeconds(), 2)}` +
    `.${p(now.getMilliseconds(), 3)}000`;
}
```

- [ ] **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git add v2/engine/src/db/py-compat.ts v2/engine/test/py-compat.test.ts
git commit -m "feat(v2): py-compat byte-level json/timestamp twins — shadow-diff prerequisite"
```

---

### Task 2: storage —— better-sqlite3 同步层

**Files:**
- Create: `v2/engine/src/db/storage.ts`
- Test: `v2/engine/test/db-storage.test.ts`
- Modify: `v2/engine/package.json`（新依赖，`--save-exact`）

**Interfaces:**
- Consumes: `pythonJsonDumps` / `pyLocalIsoNow`（Task 1）。
- Produces:

```typescript
export class SchemaError extends Error {}
export type StoredMessageRow = { id: number; role: string; content: string | unknown[]; timestamp: string };
export type LlmMetricsRow = { session_id: string; user_id: number | null; model: string | null;
  iteration: number | null; input_tokens: number | null; output_tokens: number | null;
  ttft_ms: number | null; total_ms: number | null };
export type Storage = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): number;
  getMessages(sessionId: string): StoredMessageRow[];
  recordLlmCallMetrics(rows: LlmMetricsRow[]): void;
  close(): void;
};
export function openStorage(dbPath: string): Storage;  // PRAGMA + checkSchema，缺表/列 ⇒ SchemaError
```

行为对齐 `app/database.py`：`addMessage` = 一个事务里 INSERT messages + UPDATE sessions.updated_at（同一个 `now`）；`getMessages` = `ORDER BY id`，`[` 前缀才试 parse、失败保留原文；`recordLlmCallMetrics` = 单事务批量、全批同一 `created_at`、空数组直接返回。checkSchema 校验 `sessions(id,updated_at)`、`messages(id,session_id,role,content,timestamp)`、`llm_call_metrics(session_id,user_id,model,iteration,input_tokens,output_tokens,ttft_ms,total_ms,created_at)` 存在。

- [ ] **Step 1: 装依赖**

```bash
cd v2/engine && npm install --save-exact better-sqlite3 && npm install --save-exact -D @types/better-sqlite3
```

- [ ] **Step 2: 写失败测试**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStorage, SchemaError, type Storage } from "../src/db/storage.js";

// DDL 逐字复制自 app/database.py init_db()（Node 永不执行 DDL，这是测试 fixture 在替 Python 建库）
const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat',
  owner_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
CREATE TABLE llm_call_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  user_id INTEGER, model TEXT, iteration INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  ttft_ms INTEGER, total_ms INTEGER, created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);`;

let dir: string, dbPath: string, storage: Storage;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "v2db-"));
  dbPath = join(dir, "t.db");
  const db = new Database(dbPath); db.exec(SCHEMA);
  db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1','seed','x','x')").run();
  db.close();
  storage = openStorage(dbPath);
});
afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

describe("openStorage", () => {
  it("PRAGMA 生效：WAL / busy_timeout / foreign_keys", () => {
    const db = new Database(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
    // FK 由行为证明：不存在的 session 插消息必须炸
    expect(() => storage.addMessage("ghost", "user", "x")).toThrow(/FOREIGN KEY/i);
  });
  it("缺表 ⇒ SchemaError 点名", () => {
    const p2 = join(dir, "empty.db"); new Database(p2).close();
    expect(() => openStorage(p2)).toThrow(SchemaError);
    expect(() => openStorage(p2)).toThrow(/messages/);
  });
});

describe("addMessage / getMessages（test_message_codec goldens 对齐）", () => {
  it("纯字符串原样存取", () => {
    storage.addMessage("s1", "assistant", "普通回答");
    expect(storage.getMessages("s1")[0].content).toBe("普通回答");
  });
  it("块数组：pythonJsonDumps 落库（带空格分隔符），读回解析", () => {
    const blocks = [{ type: "tool_use", id: "tu_1", name: "code_search", input: { keyword: "不合格评审" } }];
    storage.addMessage("s1", "assistant", blocks);
    const db = new Database(dbPath);
    const raw = db.prepare("SELECT content FROM messages ORDER BY id DESC LIMIT 1").get() as { content: string };
    db.close();
    expect(raw.content).toBe('[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]');
    expect(storage.getMessages("s1")[0].content).toEqual(blocks);
  });
  it("[ 开头的非 JSON 字符串原样保留", () => {
    storage.addMessage("s1", "user", "[系统] 这不是JSON");
    expect(storage.getMessages("s1")[0].content).toBe("[系统] 这不是JSON");
  });
  it("插入顺序 = 读取顺序；session.updated_at 被 addMessage 刷新为同一时间戳", () => {
    const id0 = storage.addMessage("s1", "user", "m0");
    storage.addMessage("s1", "user", "m1");
    expect(storage.getMessages("s1").map(m => m.content)).toEqual(["m0", "m1"]);
    expect(typeof id0).toBe("number");
    const db = new Database(dbPath);
    const sess = db.prepare("SELECT updated_at FROM sessions WHERE id='s1'").get() as { updated_at: string };
    const msg = db.prepare("SELECT timestamp FROM messages WHERE id=?").get(
      storage.getMessages("s1")[1].id) as { timestamp: string };
    db.close();
    expect(sess.updated_at).toBe(msg.timestamp);
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });
});

describe("recordLlmCallMetrics", () => {
  it("批量单事务、全批同一 created_at、空批 no-op", () => {
    storage.recordLlmCallMetrics([]);
    storage.recordLlmCallMetrics([
      { session_id: "s1", user_id: 1, model: "m", iteration: 1, input_tokens: 10, output_tokens: 5, ttft_ms: 100, total_ms: 200 },
      { session_id: "s1", user_id: 1, model: "m", iteration: 2, input_tokens: 20, output_tokens: 6, ttft_ms: 90, total_ms: 150 },
    ]);
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT * FROM llm_call_metrics ORDER BY id").all() as any[];
    db.close();
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBe(rows[1].created_at);
    expect(rows[1].iteration).toBe(2);
  });
});
```

- [ ] **Step 3: 跑测失败** → **Step 4: 实现 storage.ts**（`db.pragma(...)` 三连、checkSchema 用 `PRAGMA table_info`、`db.transaction()` 包 addMessage 与 metrics 批量、`Number(lastInsertRowid)`；~90 行）→ **Step 5: 跑测通过 + typecheck** → **Step 6: Commit**

```bash
git add v2/engine
git commit -m "feat(v2): better-sqlite3 storage layer — python-twin row encoding, schema check not schema owner"
```

---

### Task 3: worker + client —— DB 下沉 worker 线程

**Files:**
- Create: `v2/engine/src/db/worker.ts`、`v2/engine/src/db/client.ts`
- Test: `v2/engine/test/db-worker.test.ts`

**Interfaces:**
- Consumes: `openStorage`（Task 2）。
- Produces:

```typescript
export type DbClient = {
  addMessage(sessionId: string, role: string, content: string | unknown[]): Promise<number>;
  getMessages(sessionId: string): Promise<StoredMessageRow[]>;
  recordLlmCallMetrics(rows: LlmMetricsRow[]): Promise<void>;
  close(): Promise<void>;
};
export function createDbClient(dbPath: string): DbClient;
```

协议：`{id, method, args}` → `{id, ok: true, result}` | `{id, ok: false, error: string}`；worker 内异常必须变成 reject 传回（含 SQLite 错误消息原文），不允许打死 worker。`close()` 让 worker 关库后干净退出（`unref`/terminate 兜底）。worker.ts 用 `workerData.dbPath` 开库；client 里 `new Worker(new URL("./worker.ts", import.meta.url))` 在 tsx/vitest 下可直接跑 —— 若 vitest 环境对 .ts worker 有兼容问题，允许改用 `new URL("./worker.js", ...)` + tsx 注册方案，在报告里记录选型。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// fixture 建库代码与 db-storage.test.ts 相同 —— 提取到 test/db-fixture.ts 共用：
//   export function makeSeededDb(): { dir: string; dbPath: string }  （SCHEMA + s1 seed）
import { makeSeededDb } from "./db-fixture.js";
import { createDbClient, type DbClient } from "../src/db/client.js";

let dir: string, client: DbClient;
beforeEach(() => { const f = makeSeededDb(); dir = f.dir; client = createDbClient(f.dbPath); });
afterEach(async () => { await client.close(); /* rmSync dir */ });

it("经 worker 的写读回环", async () => {
  const id = await client.addMessage("s1", "user", [{ type: "text", text: "你好" }]);
  expect(id).toBeGreaterThan(0);
  expect((await client.getMessages("s1"))[0].content).toEqual([{ type: "text", text: "你好" }]);
});

it("并发调用全部正确关联（pending-map 不串号）", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => client.addMessage("s1", "user", `m${i}`)));
  expect(new Set(results).size).toBe(20);  // 20 个不同 rowid
  const msgs = await client.getMessages("s1");
  expect(msgs.length).toBe(20);
});

it("SQLite 错误变 reject 且 worker 存活", async () => {
  await expect(client.addMessage("ghost", "user", "x")).rejects.toThrow(/FOREIGN KEY/i);
  // worker 没死，后续调用照常
  await expect(client.addMessage("s1", "user", "still alive")).resolves.toBeGreaterThan(0);
});

it("metrics 批量走 worker", async () => {
  await client.recordLlmCallMetrics([{ session_id: "s1", user_id: null, model: "m",
    iteration: 1, input_tokens: 1, output_tokens: 2, ttft_ms: 3, total_ms: 4 }]);
});
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现 worker.ts + client.ts + db-fixture.ts 提取**（同时把 db-storage.test.ts 改用共享 fixture，行为不变）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git add v2/engine
git commit -m "feat(v2): db worker thread + promise client — sync sqlite off the event loop"
```

---

### Task 4: 跨语言回放验收门 + README

**Files:**
- Test: `v2/engine/test/py-roundtrip.test.ts`
- Modify: `v2/engine/README.md`（新增 DB 兼容层章节）

**Interfaces:**
- Consumes: 全部前置；`/home/my-agent/.venv/bin/python3`（env `PYTHON_BIN` 可覆盖）+ 仓库根的 `app/database.py`（以 `cwd=仓库根` 子进程调用，`DB_PATH` 打补丁指向临时库）。python 不可用时**测试失败**（不是 skip——这是验收门）。

Python 侧驱动统一走一个内联脚本模板（`execFileSync(PYTHON_BIN, ["-c", script], { cwd: REPO_ROOT })`）：

```python
import asyncio, json, sys
import app.database as d
d.DB_PATH = sys.argv[1] if len(sys.argv) > 1 else None or d.DB_PATH
# 命令由 stdin JSON 驱动：{"op": "init+seed"} / {"op": "add", ...} / {"op": "dump"}
```

- [ ] **Step 1: 写失败测试**（四个断言组）

```typescript
// ① Python 写 → Node 读：init_db + seed s1 + add_message(纯串/块数组/伪JSON串) 由 python 完成，
//    Node openStorage(getMessages) 读回，deep-equal python get_messages 的 JSON dump。
// ② Node 写 → Python 读：Node addMessage 同三种 content，python get_messages dump 出来 deep-equal。
// ③ 字节一致：同一块数组，python 行与 Node 行的 SELECT content 原始字符串全等。
// ④ Node 时间戳格式：^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$ 且与 python 行排序兼容
//    （node 行 timestamp > 先写的 python 行 timestamp，字符串比较）。
```

测试数据固定用三条：`"普通回答"`、`[{type:"tool_use",id:"tu_1",name:"code_search",input:{keyword:"不合格评审"}}]`、`"[系统] 这不是JSON"`。

- [ ] **Step 2: 跑测失败** → **Step 3: 实现测试内的 python 驱动 helper** → **Step 4: 全绿**（`npm test && npm run typecheck`，同时跑一遍仓库根 `pytest tests/ -q` 证明 Python goldens 未被扰动）
- [ ] **Step 5: README 补 DB 章节**：schema 归属（Python 独家）、worker 用法（`createDbClient`）、字节事实（分隔符/时间戳）、`1.0` 缝隙、Phase 3 消费点（engine turn 的三个调用）。
- [ ] **Step 6: Commit**

```bash
git add v2/engine
git commit -m "test(v2): cross-language replay gate — python<->node row fidelity byte-verified"
```

---

## Self-Review 记录

- **Spec 覆盖**：主计划 Phase 2 行四项——better-sqlite3（Task 2）、DB worker thread（Task 3）、旧行回放（Task 4 ①③）、PRAGMA/迁移兼容（Task 2 PRAGMA + checkSchema；"迁移兼容"落为"Node 永不 DDL、容忍 Python 演进 schema"，比双写迁移安全）。时间戳排序约束（主计划 Global）= Task 1 `pyLocalIsoNow` + Task 4 ④。
- **占位符检查**：Task 4 的 python 驱动脚本给的是模板+操作协议而非成品——刻意的：venv python 与 aiosqlite 的真实行为（如 DB_PATH 打补丁时机）需要实现时现场校准，验收断言（①–④）本身完备可判定。其余任务代码完整。
- **类型一致性**：`StoredMessageRow`/`LlmMetricsRow` Task 2 定义、Task 3 client 签名复用；`makeSeededDb` Task 3 定义并回改 Task 2 测试；`SchemaError` 仅 Task 2。`pythonJsonDumps`/`pyLocalIsoNow` Task 1 定义、Task 2 实现消费。
- **范围核对**：sessions/users/repos 等业务 CRUD 刻意不做（Phase 5 边缘层职责）；只做 engine turn 需要的三个调用（读史、写消息、写 metrics）——YAGNI。
