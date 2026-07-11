# v2 Engine — Phase 1：防腐层（Anticorruption Layer）

domain DTO 层 + legacy↔domain codec + domain↔pi codec + history policy +
pi event → domain event 适配器。目标：把遗留 legacy JSON 消息形状和 pi
（`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`）的消息/事件形状
都隔离在各自的编解码边界内，其余代码只认 `src/domain.ts` 里定义的 DTO——见
`docs/superpowers/plans/GATE.md`、`docs/superpowers/plans/2026-07-11-pi-phase1-anticorruption-codec.md`
（Phase 1 计划文档）了解这层为什么存在。

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
| 其余消费方（Phase 2/3） | 只认 `domain.ts` 的 `DomainMessage`/`DomainEvent` | 不得直接 import pi 类型，也不得假设 legacy 字段拼写 |

即：pi 类型只允许出现在 `codec-pi.ts` 和 `event-adapter.ts`（及各自测试文件，`test/mock-anthropic.ts`/`test/agent-harness.ts`/`test/event-adapter.test.ts`/`test/integration.test.ts`）；domain 类型（`toolUseId`/`isError`，camelCase）是其它所有地方唯一认识的形状；legacy JSON 字段拼写（`tool_use_id`/`is_error`，snake_case）只在 `codec-legacy.ts` 内部出现，一旦跨过 `legacyToDomain`/`domainToLegacy` 这条边界就已经是 `DomainMessage`。

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

## 测试

```bash
npm test          # vitest run — 23 tests
npm run typecheck # tsc --noEmit（--strict，仅覆盖 src/；测试文件由 vitest 自身的 esbuild 转译执行）
```

- 端到端集成测试：`test/integration.test.ts` —— legacy JSON → domain →
  history policy 窗口化 → domain→pi codec → 真实 pi Agent（离线 mock）→
  event adapter → domain events → `tool_exchange` 块经 `domainToLegacy`
  复原为可持久化的 legacy 形状，一条路径穿全管道。
- 共享测试装配：`test/agent-harness.ts`（`buildSetup` / `makeCalculatorTool`
  / `runTurnThroughAdapter`）——Task 6 的 `event-adapter.test.ts` 与 Task 7
  的 `integration.test.ts` 共用，避免重复 Agent 接线样板代码。
