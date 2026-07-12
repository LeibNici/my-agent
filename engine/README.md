# Engine — Phase 1：防腐层（Anticorruption Layer）

domain DTO 层 + legacy↔domain codec + domain↔pi codec + history policy +
pi event → domain event 适配器。目标：把遗留 legacy JSON 消息形状和 pi
（`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`）的消息/事件形状
都隔离在各自的编解码边界内，其余代码只认 `src/domain.ts` 里定义的 DTO。

## 层边界（谁能 import 什么）

```
legacy JSON (DB / 旧前端原始 dict，snake_case，tool_use_id/is_error)
        │  仅 codec-legacy.ts 可见
        ▼
   src/domain.ts  ←──────────────── 除下面两个文件外，所有代码只认这一层
        │  history-policy.ts 只操作 domain 层
        ▼
   src/codec-pi.ts / src/event-adapter.ts   ← pi 类型唯一允许出现的两个文件
        │  （Message/AgentEvent/AssistantMessage/... 来自 pi-ai、pi-agent-core）
        ▼
  真实 pi Agent（@earendil-works/pi-agent-core + @earendil-works/pi-ai）
```

| 文件 | 允许 import 的类型 | 不允许 |
|---|---|---|
| `codec-legacy.ts` | legacy raw JSON（untyped）+ `domain.ts` | pi 类型 |
| `domain.ts` | 无外部依赖，是唯一真相源 DTO | legacy JSON 字段拼写、pi 类型 |
| `history-policy.ts` | `domain.ts` | legacy JSON、pi 类型 |
| `codec-pi.ts` | `domain.ts` + pi 类型（`@earendil-works/pi-ai`） | legacy JSON 字段拼写 |
| `event-adapter.ts` | `domain.ts` + pi 类型（`@earendil-works/pi-agent-core`/`pi-ai`） | legacy JSON 字段拼写 |
| `engine/pi-tools.ts`（Task 3 新增） | `tools/registry.ts` 的 `ToolDef`/`ToolContext` + pi 类型（`@earendil-works/pi-agent-core`） | legacy JSON 字段拼写 |
| 其余消费方（Phase 2/3） | 只认 `domain.ts` 的 `DomainMessage`/`DomainEvent`；`tools/registry.ts`/`tools/calculator.ts` 只认 `ToolDef`（typebox + domain 术语） | 不得直接 import pi 类型，也不得假设 legacy 字段拼写 |

即：pi 类型只允许出现在 `codec-pi.ts`、`event-adapter.ts` 和 `engine/pi-tools.ts`（及各自测试文件，`test/mock-anthropic.ts`/`test/agent-harness.ts`/`test/event-adapter.test.ts`/`test/integration.test.ts`/`test/tools.test.ts`）；domain 类型（`toolUseId`/`isError`，camelCase）是其它所有地方唯一认识的形状；legacy JSON 字段拼写（`tool_use_id`/`is_error`，snake_case）只在 `codec-legacy.ts` 内部出现，一旦跨过 `legacyToDomain`/`domainToLegacy` 这条边界就已经是 `DomainMessage`。`tools/registry.ts` 的 `ToolDef` 只认 typebox（`@sinclair/typebox`）+ 纯字符串/Promise，不认 pi 类型——`engine/pi-tools.ts` 的 `toPiTools()` 是唯一的转换点（`ToolDef[] -> AgentTool[]`），typebox schema 直接喂给 pi 的 `parameters` 字段，无需转换（两个 typebox 包— 本仓库固定依赖的 `@sinclair/typebox@0.34.13` 和 pi 自己依赖的、不同的 unscoped `typebox@1.1.38` — 经 Task 3 验证类型和运行时均兼容，细节见 Task 3 report）。

## 本包导出什么

- `legacyToDomain` / `legacyListToDomain` / `domainToLegacy` — `src/codec-legacy.ts`
- `prepareModelMessages` / `HISTORY_IMAGE_PLACEHOLDER` — `src/history-policy.ts`
- `domainToPi` / `piAssistantToDomain` — `src/codec-pi.ts`
- `createEventAdapter` — `src/event-adapter.ts`
- `DomainMessage` / `DomainBlock` / `DomainEvent` / `CodecError` / `isToolRelay` — `src/domain.ts`

## Phase 2 消费点（不在本 Phase 交付范围内）

Phase 2 是"legacy JSON ↔ 数据库原始字节"这一层，本 Phase 完全不碰：

- `codec-legacy.ts` 只管**块形状**（`legacyToDomain`/`domainToLegacy` 之间的
  结构转换），不管这些 JSON 在 SQLite 里到底怎么序列化/反序列化。
- 数据库原始字节编码——list → JSON string 存字段、读回时按 `"["` 前缀猜测
  "这是不是一个块数组"再 decode——是 **Phase 2 自己的交付物**（对应
  `tests/test_message_codec.py` 的原始字节编码 golden），本 Phase 的 codec
  测试只覆盖块结构本身，不覆盖字节层读写。
- Phase 2 会把 `legacyListToDomain`/`domainToLegacy` 当作 DB 读写路径中间的
  转换步骤来复用，但字节层面的读写本身不在这个包里。

## Phase 3 消费点

Phase 3（真实 SSE 边缘、真实 pi Agent 接线）会消费：

- `event-adapter.ts` 的 `createEventAdapter`
- `history-policy.ts` 的 `prepareModelMessages`
- `codec-pi.ts` 的 `domainToPi` / `piAssistantToDomain`
- **每 turn 临时（ephemeral）Agent 装配范式**：不维护常驻 Agent 状态，
  SQLite 是唯一真相源；每个 turn 都是"读历史 → codec 转换 →
  装配一个全新的 `Agent` 实例（`initialState.messages` 注入历史）→
  `agent.prompt()` → 消费事件 → 落库"。范式参照
  `spikes/pi-agent-core/src/scenarios.ts` 的 B1（Model 对象 + 绑定 `this`
  的 streamFn + `toolExecution:"sequential"` + subscribe），也是
  `test/agent-harness.ts` 里 `runTurnThroughAdapter` 的写法；外部历史注入
  走 `initialState.messages` 而不是逐条 replay 参照同文件的 B6。

### 错误路径的分工（Phase 3 集成时必须遵守）

pi **没有独立的 "error" AgentEvent**。LLM/传输层失败会表现为一次
`message_end`（assistant 角色）且 `stopReason` 为 `"error"`/`"aborted"`——
这是 pi 的 `StreamFn` 契约要求 provider 把网络/API 失败吞进这个形状而不是
throw。

- `event-adapter.ts` 对这种 `message_end` **直接 no-op**（不产生任何 domain
  事件）——适配器本身不负责判定"这一轮是不是失败了"。
- 判定失败的责任在**驱动方**（Phase 3 的 SSE 边缘代码）：`await
  agent.prompt(...)` 结束后必须检查 `agent.state.errorMessage`，非空则调用
  `adapter.fail(agent.state.errorMessage)`，否则调用 `adapter.finish()`。
- 这个分工已经在 `test/agent-harness.ts` 的 `runTurnThroughAdapter` 里实现
  （`if (agent.state.errorMessage) { adapter.fail(...) } else { adapter.finish() }`），
  Phase 3 的真实 SSE handler 应该照抄这个 if/else，而不是假设适配器会自己
  吐出一个 `error` 事件。

## Phase-1 已知限制（设计内的 CodecError，不是 bug）

以下场景故意 `throw CodecError`，而不是尝试静默降级——这些是 Phase 1 范围
之外的功能缺口，留给后续 Phase：

| 场景 | 位置 | 抛出条件 | 归属 |
|---|---|---|---|
| domain → pi 的 image 块 | `codec-pi.ts` `domainToPi` | assistant 或 user 消息里出现 `type:"image"` 的 domain 块 | **当前 turn 的图片是 Phase 3 的工作**——历史消息里的图片已经在 `history-policy.ts` 换成了纯文本占位符（`HISTORY_IMAGE_PLACEHOLDER`），所以理论上只有"当前 turn 夹带的新截图"才会撞上这个 CodecError；Phase 3 需要给 pi 的图片内容块补一条编码路径 |
| pi → domain 的 ThinkingContent | `codec-pi.ts` `piAssistantToDomain` | pi 的 assistant 消息内容块里出现 `type:"thinking"` | domain 层目前没有 thinking 的对应类型；是否需要、何时暴露推理过程给 legacy 侧留给后续决定 |

**关键注意**：`piAssistantToDomain` 对 thinking 块的 CodecError 是在 event-adapter
的 subscribe 路径内（message_end/turn_end 事件回调中）抛出的，这意味着 **adapter
可能在流中断地抛错**，尽管它对错误事件声称无抛出。Phase 3 集成启用推理模型前必须
自行决策：要么关闭推理，要么先将 thinking 类型补充到 domain 层。

两处都是 fail-loud 而非静默丢弃——遇到这些块类型时会抛错而不是悄悄吃掉数据，
这样任何漏配的调用方会在测试/联调阶段就发现，而不是在生产里丢数据。

## Wrap-up 机制（Phase 3 待选，两条路径均已验证可行）

legacy 用 `tool_choice:"none"`（含端点拒绝后的回退重试）强制某一轮不调用
工具。Task 1 的 spike（`spikes/pi-provider/REPORT-phase1.md`，对 DashScope
`qwen3.7-plus` 真实端点两轮独立验证）确认了两条路径在生产端点上都成立：

- **(a) tools 整体省略**（`tools:[]`）——0A 阶段已验证 `PASS`，强制纯文本；
- **(b) `toolChoice:"none"`**——Phase-1 新验证 `PASS`，保留 `tools` 字段，用
  `toolChoice` 显式压制调用；DashScope 两轮独立调用均未产生 `toolcall_end`
  事件，语义生效。

两条路径本 Phase 都判定可行，**具体选哪条留给 Phase 3**：(a) 改动面更小、
与 0A 已有实现一致；(b) 与 legacy 语义更贴近，迁移 legacy 预算 golden
（`test_agent_budget.py`）时断言改动可能更少。

## Phase 2：DB 兼容层（better-sqlite3 + worker thread + 跨语言回放）

目标：给 engine 一个能与生产 `agent_data.db` 直接共存的存储层——绞杀者阶段
Python（FastAPI，仍在写库）和 Node（这个包）**两个进程共享同一份 SQLite
文件**，读写都要和 `app/database.py` 字节对齐，不能自成一套编码。

### Schema 归属：Python 独家

Node 侧**永不建表、永不迁移**（不执行任何 DDL，含 `CREATE INDEX`）。schema
的唯一所有者是 Python `app/database.py` 的 `init_db()`——两进程共库期间谁都
建表/改表是典型的双写迁移事故源。`src/db/storage.ts` 的 `openStorage(dbPath)`
只做两件事：

1. 对每个新连接施加与 `app/database.py:_connect()` 相同的 PRAGMA
   （`journal_mode=WAL` / `busy_timeout=5000` / `foreign_keys=ON`）；
2. 用 `PRAGMA table_info` 校验 `messages`/`sessions`/`llm_call_metrics`
   所需的表和列存在——**缺失就 `throw SchemaError`**（fail-loud，列出缺什么），
   绝不静默降级或补建。

这意味着 Node 天然容忍 Python 单侧演进 schema（新增列、新表都不影响已校验的
子集），但反过来要求 Python 的库先跑过 `init_db()` 才能被 Node 打开——测试里
永远是"python 建库，node 只读写"，`test/db-fixture.ts` 里那份手抄 DDL 只是
`db-storage.test.ts`/`db-worker.test.ts` 的最小 fixture，不代表 Node 有资格
建表。

### `createDbClient` 用法

`storage.ts` 是同步层（better-sqlite3 本身是同步 API）；`client.ts` 把它包进
`worker_threads`，主线程只拿 Promise，事件循环不被磁盘 IO 卡住：

```ts
import { createDbClient } from "./src/db/client.js";

const db = createDbClient("/path/to/agent_data.db");
try {
  const history = await db.getMessages(sessionId);
  const newId = await db.addMessage(sessionId, "assistant", replyBlocks);
  await db.recordLlmCallMetrics([{ session_id: sessionId, user_id, model, iteration, input_tokens, output_tokens, ttft_ms, total_ms }]);
} finally {
  await db.close(); // 幂等；close() 之后再调用会立刻 reject(/closed/)
}
```

`close()` 之外的调用在 worker 线程异常退出后会全部 reject（不会挂死等一个
永远不会来的响应）；并发调用靠 client 内部的 pending-map 正确关联请求/响应，
互不串号（见 `test/db-worker.test.ts`）。

### 字节事实（`py-compat.ts` 钉死，跨语言回放实测校验）

| 事实 | Python | Node（`py-compat.ts`） |
|---|---|---|
| list content 分隔符 | `json.dumps(v, ensure_ascii=False)` → `", "` / `": "`（**带空格**） | `pythonJsonDumps` 自实现，禁止直接用 `JSON.stringify`（不带空格） |
| 非 ASCII | `ensure_ascii=False`，原样落库 | JS 默认行为，原样落库，两边一致可直接委托 `JSON.stringify` 转义字符串字面量 |
| 时间戳 | `datetime.now().isoformat()`：本地时间、无时区后缀、6 位微秒 | `pyLocalIsoNow()`：同格式，毫秒补零到 6 位（`328` → `328000`）；**禁止 `Date.toISOString()`**（UTC + `Z`，排序语义整个不对） |
| 存储编码规则 | list → JSON 字符串；string 原样；读取时仅 `content.startswith("[")` 才尝试 `json.loads`，失败保留原字符串 | 同一套规则复刻在 `storage.ts` 的 `addMessage`/`getMessages` 里 |

Golden（两边都要产出这个精确字符串，`test/py-roundtrip.test.ts` 断言③直接
比对原始 `SELECT content`）：

```
[{"type": "tool_use", "id": "tu_1", "name": "code_search", "input": {"keyword": "不合格评审"}}]
```

### 已知缝隙（记录，不解决——Node/Python 各自的类型系统边界，不是 bug）

| 缝隙 | 场景 | 后果 |
|---|---|---|
| `1.0` → `1` | Python 写入的 list content 里有浮点数 `1.0` | JS 没有独立的 float 类型，`JSON.parse` 读回是数字 `1`；这行如果被 Node 原样转发/落库会丢失 `.0`。Node 自己写的行不会产生这个形态（JS 数字字面量没有这个区分） |
| 数字字符串键被重排 | Python dict 的键是纯数字字符串（如 `{"2": "a", "1": "b"}`），Python dict/`json.dumps` 保留插入顺序 | JS 对象的数字型字符串键会被引擎按数值升序自动重排（ECMA-262 property enumeration order 规则），`Object.entries` 拿到的顺序已经不是原始插入顺序——`pythonJsonDumps` 重新序列化这类 dict 时键序会和 Python 原始输出不同，即使值本身没丢 |
| `> 2^53` 的整数精度 | Python 任意精度整数（如超大 tool 调用 id、极端 token 计数） | JS `number` 是 IEEE754 双精度浮点，`Number.MAX_SAFE_INTEGER` 之外的整数经 `JSON.parse` 可能被舍入；Node 侧目前没有 BigInt 兜底，这类值走一趟 parse→stringify 就可能悄悄失真 |

三条都不在本 Phase 范围内解决（YAGNI——当前的 engine turn 消费面没有产生这些
形态的输入），跨语言回放测试的三条固定 payload（纯字符串 / tool_use 块数组 /
`[` 开头非 JSON 字符串）不触发它们，属于已知的未覆盖角落，留给真的撞见时再处理。

### DB 层的 Phase 3 消费点

真实 SSE 边缘接线时，一个 engine turn 对 DB 的调用面就是三个：

1. **读历史**——turn 开始时 `db.getMessages(sessionId)`，喂给
   `history-policy.ts` 的 `prepareModelMessages` 做窗口化；
2. **写消息**——turn 结束后把 assistant 回复（含 tool_exchange 块，经
   `domainToLegacy` 复原成 legacy 形状）落库，`db.addMessage(sessionId, role, content)`；
3. **写 metrics**——`db.recordLlmCallMetrics(rows)`，一个 turn 可能有多次
   LLM 调用（tool-use 循环），攒在内存里一次性批量落库（单事务、同一个
   `created_at`），不是每次 iteration 单开一个连接。

sessions/users/repos 等业务 CRUD 刻意不做（Phase 5 边缘层职责）——这三个是
engine turn 真正需要的全部 DB 面。

## 运行（Phase 3 起：这就是产品本体）

```bash
cd engine
npm install
npm start         # tsx src/server/main.ts —— HTTP/SSE 服务 + 静态前端（web/）
```

启动顺序（`src/server/main.ts` 的 `startServer()`）：`loadSettings`（dotenv +
env）→ `.jwt_secret` 缺失则生成（仓库根）→ `initSchema`（幂等 DDL，Node 拥有
schema）→ `createDbClient`（worker 线程 sqlite）→ `ensureAdminUser`（默认
admin/admin123，默认密码时 stdout 大声警告）→ `buildApp` 注入真实 `runTurn`
engine → 监听。SIGINT/SIGTERM 触发优雅关停（server close + db client close）。

`.env`（dotenv 从进程 cwd 读；`npm start` 的 cwd 是 `engine`）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | LLM API key（生产 = DashScope） |
| `ANTHROPIC_BASE_URL` | 生产必填 | Anthropic 兼容端点；生产指向 DashScope，默认 `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | 生产必填 | 生产 = `qwen3.7-plus`，默认 `claude-sonnet-5` |
| `APP_PORT` | 否 | HTTP 端口，默认 `8000`（v1 uvicorn 用 CLI flag，无对应 env——v2 新增变量） |
| `APP_DB_PATH` | 否 | SQLite 路径，默认仓库根 `agent_data.db`（相对路径按仓库根解析，不按 cwd） |
| `APP_ADMIN_PASSWORD` | 生产必填 | 不设则 admin/admin123 + 启动警告 |
| `APP_JWT_SECRET` | 否 | 不设则用/生成仓库根 `.jwt_secret` 文件 |

其余变量（`ANTHROPIC_MAX_TOKENS`/`APP_CORS_ORIGINS`/…）见 `src/config.ts` 与
仓库根 `.env.example`。

**Phase 4 前工具面只有 `calculator`**——file/code/symbol/semantic/issue 工具
（以及 admin/issue/feedback/code-viewer/repo-sync 页面的后端路由）都是
Phase 4/5 的交付物；前端对应入口在此期间报 404 属预期。

## Phase 4b：语义代码检索（embeddings）

用业务中文描述检索只有英文标识符的代码（`semantic_search` 工具）。四层单向
依赖：`embed-store.ts`（纯二进制读写）← `chunking.ts`（复用 ctags sidecar）
← `embedding-client.ts`（HTTP 批量 + 增量哈希构建）← `semantic-search.ts`
工具（查询 + 跨仓库余弦 top-k + 检索日志）。

**二进制格式**（`.emb.v1.bin`，取代 v1 的 numpy 专有 `.emb.npz`——Node 没有
装 numpy 格式解析器的理由，换成自定义的、版本号在 header 里的格式）：
`magic(8B) + version(u32) + dims(u32) + count(u32) + count*dims*f32 向量
（行主序，已归一化）+ metaJsonByteLength(u32) + UTF-8 JSON meta[]`。sidecar
和 ctags 的 `.tags.json` 一样落在仓库目录**之外**（`embed-store.ts`
`embPath` = `realpath(repoPath) + ".emb.v1.bin"`）。

**凭证复用安全闸门**（`embedding-client.ts` `embeddingKeyOrFallback`）：只有
显式配置了 `APP_EMBEDDING_API_KEY`，或 `APP_EMBEDDING_BASE_URL` 和
`ANTHROPIC_BASE_URL` 的 host 相同时，才会复用 `ANTHROPIC_API_KEY`；host 不
匹配则返回空字符串——语义检索停用，不会把 LLM 凭证连同代码块一起发给未知
的第三方 embedding endpoint。

**降级行为**（`semantic-search.ts`，三条独立的中文提示，都指向
`code_search`/`find_symbol`，从不抛异常拖垮整个 turn）：未配置 key、一个
仓库的索引都不存在、有索引但零命中——各自文案见该文件的
`NO_KEY_MESSAGE`/`NO_INDEX_ANYWHERE_MESSAGE`/`zeroHitsMessage`。检索日志
（`recordSemanticSearchLog`）是 best-effort：`ctx.db` 未提供时静默跳过，
写库失败也不影响工具的返回值。

**两阶段构建接入 repo-sync**：`repo-sync.ts` 的 `defaultOnSyncSuccess` 在
ctags 建完后，同一次 `withRepoLock` 里紧接着跑 `collectChunks`（快、纯文件
I/O，必须和 ctags 共享同一个锁定的 checkout 快照，中间不能有缝隙让并发的
force-reclone 插进来）；`embedAndSaveIndex`（慢，分钟级 HTTP 调用）特意放在
锁**外**——放进锁里会让一次冷启动的大仓库 embedding 构建堵住这个仓库后续
所有 sync。`repo-sync.ts` 本身不 import `Settings`（clone/pull 不需要），
所以由 `main.ts` 在 `startServer()` 里调一次 `configureIndexing(settings)`
注入；未调用过的路径（例如未接线的测试）等同于没配置 key，两阶段构建的
ctags/分块照常跑，只是永远不会触发 embedding 请求。

**Phase 5 待办**：目前只有写入路径（`recordSemanticSearchLog`）；管理后台
的语义检索仪表盘读接口（`get_semantic_search_stats`/
`get_semantic_search_recent` 的等价物）留给 Phase 5。

## 测试

```bash
npm test          # vitest run — 48 tests
npm run typecheck # tsc --noEmit（--strict，仅覆盖 src/；测试文件由 vitest 自身的 esbuild 转译执行）
```

- 端到端集成测试：`test/integration.test.ts` —— legacy JSON → domain →
  history policy 窗口化 → domain→pi codec → 真实 pi Agent（离线 mock）→
  event adapter → domain events → `tool_exchange` 块经 `domainToLegacy`
  复原为可持久化的 legacy 形状，一条路径穿全管道。
- 共享测试装配：`test/agent-harness.ts`（`buildSetup` / `makeCalculatorTool`
  / `runTurnThroughAdapter`）——Task 6 的 `event-adapter.test.ts` 与 Task 7
  的 `integration.test.ts` 共用，避免重复 Agent 接线样板代码。
- 跨语言回放验收门：`test/py-roundtrip.test.ts` —— 用
  `/home/my-agent/.venv/bin/python3`（env `PYTHON_BIN` 可覆盖）子进程驱动真实
  `app/database.py`（`cwd` 设到仓库根，让 `import app.database` 能解析；
  `DB_PATH` 打补丁指向每个测试自己的临时库），四组断言：① Python 写→Node 读、
  ② Node 写→Python 读，两边分别 deep-equal 对方的 `get_messages`/`getMessages`
  输出；③ 同一块数组 payload，Python 行与 Node 行的原始 `SELECT content`
  字符串逐字节相等；④ Node 写入的 `timestamp` 匹配
  `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$` 且字符串序晚于先写入的
  Python 行（排序兼容，Phase 6 shadow 双跑按时间戳排列两边写的行时不能错序）。
  python 不可用（缺失/坏掉）时这组测试直接 fail（`beforeAll` 里 throw），
  不是 skip——它是这个 Phase 存在的理由，静默跳过等于没有验收门。同时跑一遍
  仓库根的 `pytest tests/ -q`（22 passed）证明这层改动没有扰动 Python 侧的
  `test_message_codec.py` goldens。
