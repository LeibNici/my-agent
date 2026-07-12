# CodeAxis v2 Phase 4b — 语义代码检索（embeddings）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植 `semantic_search` 工具——用业务中文描述（「不合格评审列表合并」）检索只有英文标识符的代码。核心是把 v1 的 `.emb.npz`（numpy 专有格式）换成 Node 原生的**版本化二进制格式**（CLAUDE.md 早已点名这个替换），其余分块/增量哈希/余弦检索语义逐字移植。

**Architecture:** 四层单向依赖：`embed-store.ts`（纯二进制读写，零依赖 embedding provider）← `chunking.ts`（复用 Task 4a 的 ctags sidecar，纯文件 I/O）← `embedding-client.ts`（HTTP 批量调用 + 增量哈希 diff + 写 store）← `semantic-search.ts` 工具（查询向量 + 跨仓库余弦 top-k + 检索日志）。v1 因为工具跑在线程池（无 event loop）被迫用裸 `sqlite3` 写日志；v2 的工具本来就是 async 函数，`ToolContext` 直接带一个可选 `db` 字段，日志落库就是普通 `await`，比 v1 简单——架构简化点，PR 描述里说明，不是遗漏。

**Tech Stack:** 复用现有 typebox/registry/access 层。HTTP 走 Node 全局 `fetch`（Node 20+ 内置，无需装 axios/undici 显式依赖）。二进制格式用 `Buffer`/`DataView`，不需要任何 npm 包。

## Global Constraints

（承 Phase 1-4a 全部有效约束：pi 类型隔离本 Phase 不新增触碰点；精确版本锁定；timestamps 仅 pyLocalIsoNow；DDL 仅 schema.ts——`semantic_search_log` 表已在 schema.ts 存在，本 Phase 只加读写方法。新增：）

- **行为规格 = tag `v1-python-final`**：`app/tools/semantic_index.py` 逐函数对照，禁止凭记忆重写。
- **凭证复用安全闸门**：`embeddingKeyOrFallback` 只有当 `embeddingApiKey` 显式配置，或"LLM 的 `baseUrl` host 与 `embeddingBaseUrl` host 相同"时才复用 `ANTHROPIC_API_KEY`——host 不匹配就返回空字符串（语义检索停用，不泄漏凭证给未知第三方）。逐字节移植这条判断，不得简化成"总是复用"。
- **sidecar 隔离**：`.emb.*` 文件在仓库目录**之外**（`realpath(repoPath) + 扩展名`），writer/reader 路径计算与 ctags sidecar 用同一 `realpathOrResolve` 保证一致。
- **两阶段构建**（对照 v1 `collect_index_chunks`/`embed_and_save_index` 拆分理由）：第一阶段（读仓库文件、分块）快、需要仓库锁；第二阶段（调 embedding API）慢（分钟级）、不再碰仓库目录、不需要锁——绝不能把慢阶段塞进锁里，否则一次冷启动索引会堵住这个仓库后续所有同步请求。
- **增量哈希**：chunk 按 `sha256(path|name|text)` 取前 24 位算 key；重建时只 embed 哈希不在旧索引里的 chunk，旧向量维度对不上当前 `embeddingDimensions` 时**必须**当新 chunk 重新 embed（不能留一个维度不匹配的僵尸向量在下一次重建时又通过 shape check）。
- **降级优先**：没配 key / 没建索引 / API 调用失败 → 工具返回中文提示文本指向 `code_search`/`find_symbol`，绝不抛异常拖垮整个 turn。
- **XML chunk 的符号链接防护**：`.xml` 文件按目录名包含 `resources`+`mapper` 扫描时，跳过任何符号链接目录/文件（clone 来的仓库不受信任，符号链接可能指向仓库外文件）。

## File Structure

```
v2/engine/src/tools/
  embed-store.ts        # 版本化二进制格式 read/write（纯格式层）
  chunking.ts            # 符号分块 + XML 窗口分块 + chunk hash
  embedding-client.ts    # /embeddings HTTP 客户端 + 增量构建编排
  semantic-search.ts     # semantic_search 工具 + 检索日志
v2/engine/test/
  embed-store.test.ts  chunking.test.ts  embedding-client.test.ts  semantic-search.test.ts
```

---

### Task 1: embed-store.ts —— 版本化二进制 sidecar（.emb.v1.bin，替代 .npz）

**Files:** Create `src/tools/embed-store.ts`；Test `test/embed-store.test.ts`

**Interfaces:**
- Produces：

```typescript
export type EmbeddingChunkMeta = { path: string; start: number; end: number; name: string; hash: string };
export type EmbeddingIndex = { dims: number; vectors: Float32Array[]; meta: EmbeddingChunkMeta[] };

export function embPath(repoPath: string): string;   // realpath(repoPath) + ".emb.v1.bin"
export function writeEmbeddingIndex(repoPath: string, index: EmbeddingIndex): void;  // temp-then-rename
export function readEmbeddingIndex(repoPath: string): EmbeddingIndex | null;  // 缺失/损坏 -> null，不抛
```

二进制格式（自定义，"版本化"——版本号在 header 里，未来加字段不必推倒重来）：

```
offset 0   : magic "CAXEMB1\0"（8 字节 ASCII，含尾 \0）
offset 8   : uint32 LE version（当前 = 1）
offset 12  : uint32 LE dims
offset 16  : uint32 LE count（chunk 数）
offset 20  : count * dims * 4 字节 —— float32 向量，行主序，每行已归一化（写入前调用方负责归一化，本层不做数值处理）
offset 20+count*dims*4 : uint32 LE metaJsonByteLength
紧接着     : metaJsonByteLength 字节 UTF-8 JSON —— EmbeddingChunkMeta[]，顺序与向量行一一对应
```

读取时校验 magic + version，不匹配 -> 返回 null（未来版本升级需要时可在这加分支读旧格式，本任务只实现 v1）。

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embPath, writeEmbeddingIndex, readEmbeddingIndex } from "../src/tools/embed-store.js";

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
    expect(Array.from(loaded.vectors[0])).toEqual([0.6, 0.8]);
    expect(Array.from(loaded.vectors[1])).toEqual([1, 0]);
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
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(dir + ".emb.v1.bin.tmp")).toBe(false);
    expect(existsSync(dir + ".emb.v1.bin")).toBe(true);
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });

  it("magic/version 不匹配 -> null", () => {
    const dir = mkdtempSync(join(tmpdir(), "emb-"));
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(embPath(dir), Buffer.from("garbage not a valid index"));
    expect(readEmbeddingIndex(dir)).toBeNull();
    rmSync(dir + ".emb.v1.bin");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（Buffer 拼接：`Buffer.concat([magicBuf, headerBuf, vectorBuf, lenBuf, metaBuf])`；读取用 `readFileSync` + `DataView`；~80 行）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): embed-store — versioned binary sidecar replacing v1's .npz"
```

---

### Task 2: chunking.ts —— 符号分块 + XML 窗口分块

**Files:** Create `src/tools/chunking.ts`；Modify `src/tools/symbol-index.ts`（把 `loadTags`/`indexPath`/`Tag` 类型从内部函数升级为正式 export——语义索引是真实生产消费者，不是测试专用，对照 v1 `semantic_index.py` 直接 `from app.tools.symbol_index import _index_path as _tags_path, _load_tags`）；Test `test/chunking.test.ts`

**Interfaces:**
- Consumes: `symbol-index.ts` 新导出的 `loadTags(repoPath): Tag[] | null`、`Tag` 类型（含 `path/name/line/kind/scope`）。
- Produces：

```typescript
export type Chunk = { path: string; start: number; end: number; name: string; text: string };
export function chunkHash(chunk: Chunk): string;         // sha256(path|name|text) 前24位hex
export function collectChunks(repoPath: string): Chunk[]; // 符号分块 + XML 窗口分块，全部 Phase 1（快，需锁）
```

移植对照 `v1-python-final:app/tools/semantic_index.py`：`_CHUNK_KINDS = {function, method, class, interface, enum}`；`_MAX_CHUNK_LINES=120`/`_MIN_CHUNK_LINES=3`/`_MAX_CHUNK_CHARS=6000`/`_XML_WINDOW_LINES=80`；符号分块按 anchor（chunkable kind 的行号，去重取 name）切 span，span 超长切多段（不截断丢尾）；文件序言（第一个 anchor 之前的内容）单独成 span；XML 分块：目录路径含 `resources` 且（目录+文件名小写）含 `mapper`，逐 80 行开窗；symlink 目录/文件一律跳过（`os.walk(followlinks=False)` 对照——Node 用 `fs.readdirSync(withFileTypes:true)` 递归时对每个 entry 检查 `isSymbolicLink()`）。

- [ ] **Step 1: 写失败测试**（fixture repo：一个 `.ts` 文件含 3 个函数 + 文件头 import 块 → 断言 chunk 数/边界/序言单独成块；一个超过 120 行的函数体 → 断言切成多个连续 chunk 而不是截断；一个 `resources/mapper/Foo.xml` 200 行文件 → 断言按 80 行开窗；一个符号链接指向仓库外的 `resources/mapper/evil.xml` → 断言被跳过、内容从未被读取（用一个只在被打开时才会失败的哨兵文件验证）；`chunkHash` 确定性 + 内容变化则 hash 变化）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（~100 行）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): chunking — symbol-span + mybatis-xml-window chunkers reusing the ctags sidecar"
```

---

### Task 3: embedding-client.ts —— HTTP 批量客户端 + 增量构建编排

**Files:** Create `src/tools/embedding-client.ts`；Test `test/embedding-client.test.ts`
**Interfaces:**
- Consumes: `embed-store.ts`（`readEmbeddingIndex`/`writeEmbeddingIndex`）、`chunking.ts`（`Chunk`/`chunkHash`）、`src/config.ts`（`Settings.embeddingBaseUrl/embeddingApiKey/embeddingModel/embeddingDimensions/apiKey/baseUrl`）。
- Produces：

```typescript
export function embeddingKeyOrFallback(settings: Settings): string;  // host-match 安全闸门，逐字节对照 v1
export async function embedAndSaveIndex(repoPath: string, chunks: Chunk[], settings: Settings): Promise<boolean>;
  // Phase 2（慢，无锁）：增量哈希 diff、批量调 embedding API、写 embed-store，30分钟超时，失败/超时返回 false 不抛
```

移植对照：`_EMBED_BATCH=10`（DashScope 单批上限）、`_CONCURRENCY=4`（同时飞 4 个批）、`_BUILD_TIMEOUT_SECONDS=1800`；旧向量维度不等于当前 `embeddingDimensions` 一律当新 chunk 重新 embed；写入前逐行归一化（L2 norm，全零向量除数保护）。HTTP body：`POST {embeddingBaseUrl}/embeddings`，`Authorization: Bearer <key>`，`{model, input: string[], dimensions, encoding_format: "float"}`；响应 `data[]` 按 `index` 排序取 `embedding`；状态码非 200 或返回条数不等于请求条数 → 该批失败，整个构建返回 false（对照 v1 "keep what we got, fail the build"）。

- [ ] **Step 1: 写失败测试**（`embeddingKeyOrFallback`：显式 key 优先；host 相同复用 LLM key；host 不同返回空串——三个 host 组合场景；`embedAndSaveIndex` 用 `vi.stubGlobal("fetch", ...)` mock：全新 chunk 全部 embed 并写入、部分 chunk 复用旧向量（hash 命中）不重复请求、旧向量维度不匹配强制重新 embed、API 非 200 整体失败返回 false、无 key 直接返回 false 不发请求、空 chunks 数组返回 false、并发批次数校验（mock 记录同时在飞请求数 ≤4）；写入后用 Task 1 的 `readEmbeddingIndex` 验证归一化向量的模长≈1）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（`Promise.all` 分波次控制并发，模式同 Task 3a 的 repo-sync 并发限制）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): embedding-client — incremental hash-diff batch embedding, host-matched credential reuse"
```

---

### Task 4: semantic-search.ts —— 工具 + 检索日志

**Files:** Modify `src/tools/registry.ts`（`ToolContext` 加可选 `db?: DbClient`——语义检索日志需要，其余工具不受影响，字段可选不破坏现有签名）；Create `src/tools/semantic-search.ts`；Modify `src/db/storage.ts`/`worker.ts`/`client.ts`（新增 `recordSemanticSearchLog`）；Test `test/semantic-search.test.ts`

**Interfaces:**
- Consumes: `embed-store.ts`（`readEmbeddingIndex`）、`embedding-client.ts`（`embeddingKeyOrFallback`）、`access.ts`（`getAllowedPaths`/`noAccessReason`/`getToolUserId`）。
- Produces：

```typescript
// storage.ts / client.ts
recordSemanticSearchLog(row: { userId: number | null; repoId: number | null; query: string;
  resultCount: number; top1Score: number | null; resultsJson: string; durationMs: number }): void;

// semantic-search.ts
export const semanticSearchTool: ToolDef;   // registerTool 副作用注册
```

移植对照：查询先截断到 2000 字符再 embed；跨全部 `allowedPaths` 读各自 `.emb.v1.bin`，维度不匹配的仓库跳过；`vectors @ q`（余弦，向量已归一化所以是点积）取每仓库 top `max_results`，全部仓库结果合并后按分数降序、再截断到 `max_results`；三种降级文案逐字节对照（未配 key / 一个索引都没有 / 有索引但零命中）；结果行格式 `"{score:.3f}  {repo}/{path}:{start}-{end} ({name})"`（Python `.3f` → JS `toFixed(3)`，本任务数值精度要求不高不需要 Task 4a file_reader 那种银行家舍入，`.3f` 是分数展示不是文件大小，直接 `toFixed` 可接受，除非测试发现 tie 案例——若发现则同 file_reader 处理）；检索日志 best-effort（`try { await ctx.db?.recordSemanticSearchLog(...) } catch {}`，从不影响工具返回值）；`repo_id` 存的是 `path.basename(repoPath)`（v1 用仓库目录名当 repo_id 存进日志，字符串形态，不是真实数据库 id——照抄这个"不太对但是现状"的行为，不擅自"修正"）。

- [ ] **Step 1: 写失败测试**（mock fetch 返回查询向量；两个仓库各有 `.emb.v1.bin`，断言结果按分数降序跨仓库合并、截断到 max_results；未配 key 场景；没有任何索引场景；索引存在但零命中场景；三条降级文案字节比对 v1；无权限（allowedPaths 为空）走 `noAccessReason`；`ctx.db` 未提供时工具仍正常返回结果只是不记日志；`ctx.db` 提供时 `recordSemanticSearchLog` 被调用且参数正确、db 写入抛错不影响工具返回值（try/catch 生效））
- [ ] **Step 2: 跑测失败** → **Step 3: 实现** → **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): semantic_search tool — cross-repo cosine top-k, best-effort recall log via ctx.db"
```

---

### Task 5: 接入 repo-sync 两阶段构建 + README

**Files:** Modify `src/repo-sync.ts`（`onSyncSuccess` 默认回调扩展：ctags build 之后追加 chunk 收集 + embed，且 embed 阶段**不持有**仓库锁——对照 v1 `_background_build_index` 的两段式）；Modify `v2/engine/README.md`（新增语义检索章节：格式说明、凭证复用规则、降级行为、Phase 5 待办——admin 语义检索仪表盘读接口）；Test `test/repo-sync.test.ts`（追加）

**Interfaces:**
- Consumes: 全部前置任务。`repo-sync.ts` 现有 `withRepoLock`（Phase 4a Task 3+终审修复）。

```typescript
// repo-sync.ts 内 defaultOnSyncSuccess 扩展为：
async function defaultOnSyncSuccess(repoId: number, localPath: string): Promise<void> {
  const ok = await withRepoLock(repoId, () => buildIndex(localPath));       // ctags，锁内（Task 4a 既有）
  const chunks = ok ? withRepoLock(repoId, () => collectChunks(localPath)) : [];  // 分块，锁内，快
  if (chunks.length > 0) {
    await embedAndSaveIndex(localPath, chunks, settings);  // 慢，锁外——settings 需要从模块级注入，见下
  }
}
```

`settings` 怎么进 `repo-sync.ts`：目前 `repo-sync.ts` 的函数都不接收 `Settings`（clone/pull 不需要）。本任务给 `defaultOnSyncSuccess` 的构造加一个可选的模块级 `configureIndexing(settings: Settings)` 初始化函数，`main.ts` 启动时调用一次（类似现有 `syncAllRepos`/`periodicSyncLoop` 的注入模式，避免 `repo-sync.ts` 直接 `import` config 单例）。未调用 `configureIndexing` 时（例如既有测试）`embedAndSaveIndex` 直接跳过（等同没配 key），不报错。

- [x] **Step 1: 写失败测试**（`configureIndexing` 未调用时，`defaultOnSyncSuccess` 只建 ctags 索引、不尝试 embed、不报错；调用后，一次真实 `syncAndPersist` 成功后能读到 `.emb.v1.bin`（mock fetch 提供 embedding 响应）；验证 embed 阶段确实在锁释放之后跑——用一个耗时的 mock fetch + 并发的第二次 sync 请求，断言第二次 sync 的 git 操作不必等 embed 完成，对照 Task 4a 已有的"clone/pull 与 index 构建不互相饿死"测试模式）
- [x] **Step 2: 跑测失败** → **Step 3: 实现** → **Step 4: 跑测通过 + typecheck**（405 现有 + 本 Phase 全部新增）→ **Step 5: README 补章节** → **Step 6: Commit**

```bash
git add v2/engine docs
git commit -m "feat(v2): wire semantic index into repo-sync two-phase build — embed phase never blocks sync"
```

---

## Self-Review 记录

- **Spec 覆盖**：CLAUDE.md 明确点名的"semantic index（版本化格式替代 .npz）"= Task 1 的核心交付；分块/增量/降级/凭证安全闸门逐条落在 Task 2-4；两阶段构建的锁语义（Codex 评审三大风险之一"每 turn 临时状态+并发安全"的同类问题）= Task 5。admin 语义检索仪表盘读接口（`get_semantic_search_stats`/`get_semantic_search_recent`）明确推到 Phase 5，本 Phase 只做写入（`recordSemanticSearchLog`）。
- **占位符检查**：二进制格式给了精确 byte layout 而非"仿照 npz"带过；HTTP body/响应形状逐字段列出；降级文案要求"字节比对 v1"而非模糊要求。
- **类型一致性**：`Chunk`/`chunkHash` Task 2 定义、Task 3/4 消费；`EmbeddingIndex`/`readEmbeddingIndex`/`writeEmbeddingIndex` Task 1 定义、Task 3/4 消费；`ToolContext.db` Task 4 新增可选字段，不破坏 Task 4a 全部工具的既有签名（`db` 可选，现有工具不传照常工作）。
