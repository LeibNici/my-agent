# CodeAxis v2 Phase 1 — 防腐层 + legacy codec 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个独立、全测试覆盖的 Node/TypeScript 包 `v2/engine`：三层 DTO 双向编解码（Legacy ↔ Domain ↔ pi）、pi 事件 → domain 事件适配器、history policy 移植——并先行在真实 DashScope 端点上关闭 GATE.md 留下的两个开放问题。本 Phase 不接线生产，产出物是 Phase 2（DB 兼容层）与 Phase 3（绞杀者阶段）直接消费的库。

**Architecture:** 按 GATE.md（GO，engine = pi-agent-core `Agent` 类）：`domain.ts` 是强类型中间层（业务域真相），`codec-legacy.ts` 是 DB/旧前端 JSON 形状的验证边界，`codec-pi.ts` 是 pi 类型边界（pi 类型不得穿透到 domain 之外——三层隔离是 Codex 评审的全局约束）。事件方向：pi `AgentEvent` → `DomainEvent`，验收标准 = Phase -1 的 `tests/test_agent_events.py` golden 序列。所有测试离线（复用 0B 的 mock Anthropic 服务器），唯一联网的是 Task 1 的端点验证 spike。

**Tech Stack:** Node v24.18.0、TypeScript strict、`@earendil-works/pi-agent-core@0.80.6` + `@earendil-works/pi-ai@0.80.6` + `@sinclair/typebox@0.34.13`（与 0B spike 完全一致的精确版本，从 `spikes/pi-agent-core/package.json` 逐字复制）、vitest（安装时用 `--save-exact` 锁定）、tsx `4.19.2`。

## Global Constraints

（承自主计划 2026-07-11-pi-engine-migration-gates.md 的 Codex 评审约束，全文对本计划生效）

- **SQLite 是唯一消息真相源**；Agent 实例每 turn 临时创建、turn 结束即销毁。
- **三层 DTO 隔离**：`LegacyMessage`（DB/旧前端 JSON 形状）、`DomainMessage`（业务域）、pi 消息类型三者显式转换；**pi 的类型只允许出现在 `codec-pi.ts` 和 `event-adapter.ts` 里**。
- **golden 基线不可改**：`tests/`（Python，22 个）是 oracle；本计划把其中的编解码/事件/窗口化 goldens 移植为 Node 侧等价测试，移植时断言值必须逐字对应，不得"顺手改进"。
- **版本精确锁定**：package.json 不用 `^`/`~`，提交 lockfile，记录 Node 版本。
- **时间戳**与 Python `datetime.now().isoformat()` 字符串排序兼容（domain 层持 ISO 字符串；仅在 `codec-pi.ts` 边界转 pi 需要的 epoch ms）。
- 除 Task 1 外全部离线可重复运行。
- 中文 UI 文案逐字保留（如 image placeholder 常量），标识符英文。

## File Structure

```
spikes/pi-provider/src/phase1-endpoint.ts   # Task 1（联网，唯一例外）
spikes/pi-provider/REPORT-phase1.md         # Task 1 判定输出

v2/engine/
  package.json  package-lock.json  tsconfig.json  vitest.config.ts
  src/
    domain.ts            # DomainMessage/DomainBlock/DomainEvent 类型 + type guards
    codec-legacy.ts      # legacy JSON ↔ DomainMessage（验证边界，CodecError）
    codec-pi.ts          # DomainMessage[] → pi Message[]（toolName 回填）+ pi AssistantMessage → domain
    history-policy.ts    # prepareModelMessages（_prepare_model_messages 逐语义移植）
    event-adapter.ts     # pi AgentEvent → DomainEvent[]（有状态：iteration/计时/块缓冲）
  test/
    fixtures.ts          # 全部任务共享的 golden fixtures
    mock-anthropic.ts    # 从 spikes/pi-agent-core/src/mock-anthropic.ts 原样复制（spike 目录是冻结证据，不 import）
    codec-legacy.test.ts
    codec-pi.test.ts
    history-policy.test.ts
    event-adapter.test.ts
    integration.test.ts  # Task 7 端到端
  README.md              # 层边界图 + Phase 2/3 消费说明
```

---

### Task 1: 真实端点开放问题验证（E1 双 user 消息形状 / E2 tool_choice）

GATE.md 遗留风险 1 的两个开放问题，离线 mock 验证不了，必须先关——结论直接决定后面 Task 4/6 的两个设计选择：

- **D1（喂给 Task 4）**：B3 的 reminder 落成"tool_result-user 后紧跟独立 text-user"两条连续 user 消息——若 DashScope 接受（E1 PASS），codec 保持 pi 默认形状；若拒绝，`codec-pi.ts` 需要自写合并（reminder text 块并入前一条 tool_result user 消息，即 legacy 原形状）。
- **D2（喂给 Phase 3，本 Phase 只记录）**：wrap-up 的"本轮禁工具"机制。0A S5 已证明"省略 tools 字段"可行；E2 验证 pi-ai 是否根本暴露 `tool_choice`（初步 grep dist 无命中，大概率不支持）。不支持 ⇒ 记录"v2 wrap-up 用 tools-omitted 机制，legacy 的 tool_choice:none 回退重试路径在 v2 中无对应物、废弃"，Phase 3 的预算 goldens 移植时按此调整断言。

**Files:**
- Create: `spikes/pi-provider/src/phase1-endpoint.ts`
- Create: `spikes/pi-provider/REPORT-phase1.md`

**Interfaces:**
- Consumes: `spikes/pi-provider/` 现有 scaffold（`.env` 的 DashScope key、`Model` 定义、`models.stream` 用法——照抄 `scenarios.ts` 的 S1）。
- Produces: `REPORT-phase1.md` 里的 E1/E2 判定（PASS/FAIL + 证据），Task 4 Step 1 开工前必须已存在。

- [ ] **Step 1: 写 E1 场景（双 user 消息）**

在 `phase1-endpoint.ts` 中，按 `scenarios.ts` 既有的 `Model`/env 装配方式，手工构造一段含工具回合的历史，最后是**两条连续 user 消息**（一条只含 `tool_result` 块、一条只含 text 块——即 pi codec 不合并时的线上形状），发起一次真实流式调用：

```typescript
// E1: does DashScope accept user(tool_result) immediately followed by user(text)?
const messages = [
  userText("查一下登录问题", t()),
  assistantToolCall("tu_1", "echo", { v: "login" }, t()),   // 按 scenarios.ts B6 的手工拼装方式
  toolResult("tu_1", "echo", "echo:login", t()),            // pi 序列化为 user/tool_result
  userText("本轮调查已过半，请收敛", t()),                    // 紧跟的独立 text-user
];
const verdict = await streamOnce(messages);  // 收全事件；4xx ⇒ FAIL，正常 done ⇒ PASS
```

判定标准：连续两轮独立运行均正常收到 `done`（非 4xx/error）⇒ E1 PASS。

- [ ] **Step 2: 写 E2 检查（tool_choice API 面）**

先静态判定：`grep -rn "toolChoice\|tool_choice" node_modules/@earendil-works/pi-ai/dist/` ——无命中即 pi-ai 不暴露该参数，E2 记 `NOT-EXPOSED`（无需联网）；有命中才补一个真实调用验证 `tool_choice:"none"` 被 DashScope 接受与否。

- [ ] **Step 3: 跑两轮，写 REPORT-phase1.md**

Run: `cd spikes/pi-provider && npx tsx src/phase1-endpoint.ts && npx tsx src/phase1-endpoint.ts`

REPORT-phase1.md 按 0A REPORT.md 同款表格：场景/判定/证据（两轮原始输出），末尾明确写出 D1、D2 的取值。

- [ ] **Step 4: Commit**

```bash
git add spikes/pi-provider/src/phase1-endpoint.ts spikes/pi-provider/REPORT-phase1.md
git commit -m "spike(phase1): E1 double-user shape + E2 tool_choice endpoint verdicts — closes GATE open questions"
```

---

### Task 2: v2/engine 脚手架 + Domain 类型层

**Files:**
- Create: `v2/engine/package.json`、`tsconfig.json`、`vitest.config.ts`
- Create: `v2/engine/src/domain.ts`
- Create: `v2/engine/test/fixtures.ts`
- Test: `v2/engine/test/codec-legacy.test.ts`（本任务只放 type-guard 部分）

**Interfaces:**
- Produces（后续所有任务消费，签名逐字固定）：

```typescript
// domain.ts —— 除 codec-pi/event-adapter 外，全项目只允许见到这些类型
export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mediaType: string; base64Data: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; toolUseId: string; content: string; isError: boolean };
export type DomainBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
export type DomainMessage = { role: "user" | "assistant"; content: string | DomainBlock[] };

export type DomainEvent =
  | { type: "text_delta"; data: { text: string } }
  | { type: "llm_metrics"; data: { iteration: number; model: string; inputTokens: number;
      outputTokens: number; ttftMs: number | null; totalMs: number } }
  | { type: "tool_use"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { type: "tool_result"; data: { id: string; result: string } }
  | { type: "tool_exchange"; data: { assistant: DomainBlock[]; results: ToolResultBlock[] } }
  | { type: "done"; data: { text: string; success: boolean } }
  | { type: "error"; data: { message: string } };

export class CodecError extends Error {}
export function isToolRelay(m: DomainMessage): boolean;  // content 为块数组且含 tool_result
```

- [ ] **Step 1: 脚手架**

```bash
mkdir -p v2/engine/src v2/engine/test && cd v2/engine
npm init -y   # 然后手工把依赖钉死（逐字复制 spikes/pi-agent-core/package.json 的四个版本）
npm install --save-exact @earendil-works/pi-agent-core@0.80.6 @earendil-works/pi-ai@0.80.6 @sinclair/typebox@0.34.13
npm install --save-dev --save-exact typescript@5.7.3 tsx@4.19.2 @types/node@24.13.3 vitest
```

tsconfig 复制 `spikes/pi-agent-core/tsconfig.json`（strict 已开）；`package.json` 加 `"type": "module"`、`"scripts": {"test": "vitest run", "typecheck": "tsc --noEmit"}`。

- [ ] **Step 2: 写失败测试（type guards + fixtures）**

`test/fixtures.ts` 集中放各任务共用的 golden 形状（值逐字来自 Python goldens）：

```typescript
// legacy JSON 形状（= DB/旧前端原始 dict），来自 tests/test_agent_events.py / test_message_codec.py
export const legacyToolTurn = [
  { role: "user", content: "1+1=?" },
  { role: "assistant", content: [
    { type: "text", text: "算一下" },
    { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } } ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu_1", content: "2" } ] },
];
export const legacyImageMsg = { role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
  { type: "text", text: "看这个截图" } ] };
export const legacyUnicodeBlocks = [
  { type: "tool_use", id: "tu_1", name: "code_search", input: { keyword: "不合格评审" } } ];
```

`codec-legacy.test.ts` 先只放 guard 测试：

```typescript
import { describe, it, expect } from "vitest";
import { isToolRelay } from "../src/domain.js";

describe("domain guards", () => {
  it("isToolRelay: true 仅当块数组中含 tool_result", () => {
    expect(isToolRelay({ role: "user", content: [{ type: "tool_result", toolUseId: "t", content: "x", isError: false }] })).toBe(true);
    expect(isToolRelay({ role: "user", content: "纯文本" })).toBe(false);
    expect(isToolRelay({ role: "user", content: [{ type: "text", text: "x" }] })).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测确认失败**（`npm test` → 模块不存在）
- [ ] **Step 4: 实现 domain.ts**（类型 + `isToolRelay` + `CodecError`，如上 Interfaces 逐字）
- [ ] **Step 5: 跑测通过 + typecheck**（`npm test && npm run typecheck`）
- [ ] **Step 6: Commit**

```bash
git add v2/engine
git commit -m "feat(v2): engine scaffold + domain DTO layer — three-layer isolation per Codex constraint"
```

---

### Task 3: codec-legacy —— legacy JSON ↔ DomainMessage

**Files:**
- Create: `v2/engine/src/codec-legacy.ts`
- Test: `v2/engine/test/codec-legacy.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 domain 类型、fixtures。
- Produces:

```typescript
export function legacyToDomain(raw: unknown): DomainMessage;       // 非法形状 throw CodecError
export function legacyListToDomain(raw: unknown[]): DomainMessage[];
export function domainToLegacy(m: DomainMessage): Record<string, unknown>;  // 逐字回到 legacy dict 形状
```

字段对应（唯一的转换逻辑，双向严格互逆）：`tool_use_id ↔ toolUseId`、`is_error(缺省 false) ↔ isError`、`source:{type:"base64",media_type,data} ↔ {mediaType,base64Data}`；string content 原样；未知 block type / 缺字段 → `CodecError`（fail-loud：SQLite 真相源里不该有脏数据）。

- [ ] **Step 1: 写失败测试**

```typescript
import { legacyToDomain, domainToLegacy, legacyListToDomain } from "../src/codec-legacy.js";
import { legacyToolTurn, legacyImageMsg, legacyUnicodeBlocks } from "./fixtures.js";

describe("codec-legacy", () => {
  it("round-trip 是恒等（工具回合三连）", () => {
    for (const raw of legacyToolTurn)
      expect(domainToLegacy(legacyToDomain(raw))).toEqual(raw);
  });
  it("tool_result 缺省 is_error 补 false，回程省略", () => {
    const d = legacyToDomain(legacyToolTurn[2]);
    expect((d.content as any)[0].isError).toBe(false);
    expect(domainToLegacy(d)).toEqual(legacyToolTurn[2]);  // 回程不多出 is_error 字段
  });
  it("image 块字段换名双向", () => {
    const d = legacyToDomain(legacyImageMsg);
    expect((d.content as any)[0]).toEqual({ type: "image", mediaType: "image/png", base64Data: "AAA" });
    expect(domainToLegacy(d)).toEqual(legacyImageMsg);
  });
  it("unicode 原样（不合格评审）", () => {
    const raw = { role: "assistant", content: legacyUnicodeBlocks };
    expect(domainToLegacy(legacyToDomain(raw))).toEqual(raw);
  });
  it("未知块类型 throw CodecError", () => {
    expect(() => legacyToDomain({ role: "user", content: [{ type: "banana" }] })).toThrow(CodecError);
  });
});
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（~60 行分派函数，逐块 switch，缺字段即 throw）→ **Step 4: 跑测通过** → **Step 5: Commit**

```bash
git commit -m "feat(v2): legacy<->domain codec — validating boundary, CodecError on dirty rows"
```

---

### Task 4: codec-pi —— DomainMessage ↔ pi 消息（注③规则 + toolName 回填）

⚠️ 开工前置：`spikes/pi-provider/REPORT-phase1.md` 必须已存在，D1 取值决定 reminder 形状分支（下面按 D1=PASS 即"保持 pi 默认双 user 形状"写；若 D1=FAIL，Step 3 改为在 `domainToPi` 里把纯 text 的 user 消息合并进前一条 toolResult 序列——实现两行分支，测试断言相应改为单条 user）。

**Files:**
- Create: `v2/engine/src/codec-pi.ts`
- Test: `v2/engine/test/codec-pi.test.ts`

**Interfaces:**
- Consumes: domain 类型；pi 类型（`import type { Message as PiMessage, AssistantMessage } from "@earendil-works/pi-ai"`——pi 类型止步于本文件）。
- Produces:

```typescript
export function domainToPi(msgs: DomainMessage[], opts: { model: string; provider: string }): PiMessage[];
export function piAssistantToDomain(m: AssistantMessage): {
  message: DomainMessage;                       // assistant 回合（text/tool_use 块）
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
};
```

编码规则 = 0B REPORT 注③，逐条（实现时以 `spikes/pi-agent-core/src/scenarios.ts` 的 B6 手工拼装为字段拼写基准）：
1. user string/text 块 → `{ role:"user", content:[{type:"text",text}], timestamp }`（timestamp = epoch ms，单调递增）。
2. assistant：text 块 → `{type:"text",text}`；tool_use 块 → `{type:"toolCall", id, name, arguments:input}`；整条补 `api/provider/model/usage(全 0)/stopReason("toolUse" 若含 toolCall，否则 "stop")/timestamp`。
3. user 内每个 tool_result 块 → 独立 `{ role:"toolResult", toolCallId:toolUseId, toolName, content:[{type:"text",text:content}], isError, timestamp }`；**toolName 不存在于 legacy/domain 形状，必须回查此前 assistant 消息中 id 相同的 tool_use 块补回；查不到 ⇒ throw CodecError**（窗口化保证从不拆散 pair，查不到即真相源损坏，宁可炸）。
4. tool_result 之后跟随的 text 块（budget reminder 形状）→ 按 D1 结论处理（默认：独立尾随 user 消息）。
5. image 块 → 本 Phase 按 CodecError 处理并在 README 记录（history policy 已把过去回合的 image 换成占位文本；当前回合带图属 Phase 3 接线时补,那时才有真实 base64 通路）。

- [ ] **Step 1: 写失败测试**

```typescript
import { domainToPi, piAssistantToDomain } from "../src/codec-pi.js";
import { legacyListToDomain } from "../src/codec-legacy.js";
import { legacyToolTurn } from "./fixtures.js";

const OPTS = { model: "qwen3.7-plus", provider: "dashscope" };

describe("domainToPi（注③）", () => {
  it("B6 三段史：角色序列 user/assistant/toolResult，id 与结构保真", () => {
    const pi = domainToPi(legacyListToDomain(legacyToolTurn), OPTS);
    expect(pi.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
    const asst = pi[1] as any;
    expect(asst.content).toEqual([
      { type: "text", text: "算一下" },
      { type: "toolCall", id: "tu_1", name: "calculator", arguments: { expression: "1+1" } }]);
    expect(asst.stopReason).toBe("toolUse");
    const tr = pi[2] as any;
    expect(tr.toolCallId).toBe("tu_1");
    expect(tr.toolName).toBe("calculator");     // ← 回填自 tu_1 的 tool_use 块
    expect(tr.isError).toBe(false);
  });
  it("toolName 回查不到 ⇒ CodecError", () => {
    const orphan = legacyListToDomain([{ role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_ghost", content: "x" }] }]);
    expect(() => domainToPi(orphan, OPTS)).toThrow(CodecError);
  });
  it("timestamp 单调递增", () => {
    const pi = domainToPi(legacyListToDomain(legacyToolTurn), OPTS) as any[];
    for (let i = 1; i < pi.length; i++) expect(pi[i].timestamp).toBeGreaterThanOrEqual(pi[i-1].timestamp);
  });
  it("tool_result 后的尾随 text 块 → 独立尾随 user 消息（D1 形状）", () => {
    const withReminder = legacyListToDomain([
      legacyToolTurn[1],
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "2" },
        { type: "text", text: "本轮调查已过半" } ] }]);
    const pi = domainToPi(withReminder, OPTS);
    expect(pi.map(m => m.role)).toEqual(["assistant", "toolResult", "user"]);
  });
});

describe("piAssistantToDomain", () => {
  it("text+toolCall → domain assistant 块，usage/stopReason 提取", () => {
    const out = piAssistantToDomain({
      role: "assistant", api: "anthropic-messages", provider: "dashscope", model: "qwen3.7-plus",
      content: [{ type: "text", text: "算一下" },
                { type: "toolCall", id: "tu_1", name: "calculator", arguments: { expression: "1+1" } }],
      usage: { input: 10, output: 5 } as any, stopReason: "toolUse", timestamp: 1,
    } as any);
    expect(out.message).toEqual({ role: "assistant", content: [
      { type: "text", text: "算一下" },
      { type: "tool_use", id: "tu_1", name: "calculator", input: { expression: "1+1" } }] });
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
```

（`usage` 字段的真实拼写以 pi 0.80.6 的 `AssistantMessage` 类型为准——0A REPORT 记录的是 `usage.input/output`，实现与测试以 `tsc --strict` 通过为门。）

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（遍历 domain 消息、维护 `id→name` 映射、单调 timestamp 计数器；~100 行）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): domain<->pi codec — note-3 rules, toolName backfill, fail-loud on orphan tool_result"
```

---

### Task 5: history-policy —— `_prepare_model_messages` 移植

**Files:**
- Create: `v2/engine/src/history-policy.ts`
- Test: `v2/engine/test/history-policy.test.ts`

**Interfaces:**
- Consumes: domain 类型、`isToolRelay`。
- Produces:

```typescript
export const HISTORY_IMAGE_PLACEHOLDER = "[历史消息中的截图已省略；如需模型重看，请让用户重新发送图片]";  // 逐字
export function prepareModelMessages(history: DomainMessage[], maxHistoryMessages: number): DomainMessage[];
```

移植源：`app/main.py:277-348`（worktree 内路径）。语义五条，与 Python 注释逐条对应：过去回合 image → 占位 text；当前回合（自最后一条**非 tool-relay** 的 user 消息起）整体保留、即使独自超窗；过去回合"压缩"而非切片（user 的 tool-relay 丢弃、assistant 块数组只留 text 块、纯文本 assistant 保留）；压缩后按 `room = max(limit - len(currentTurn), 0)` 取尾窗；开头 while-pop 至首条是 user。`maxHistoryMessages` 为 0 或长度未超限 ⇒ 原样返回（但 image 占位仍生效于超限分支之前？——**注意**：Python 里 image 替换发生在 limit 检查**之前**、对未超限历史同样生效，移植保持一致）。

- [ ] **Step 1: 写失败测试**（5 个 Python goldens 逐字翻译，含 hand-traced 断言）

```typescript
import { prepareModelMessages, HISTORY_IMAGE_PLACEHOLDER } from "../src/history-policy.js";
import { legacyListToDomain } from "../src/codec-legacy.js";

const msg = (role: "user" | "assistant", content: any) => ({ role, content });
const toolHeavyTurn = (i: number) => [
  msg("user", `问题${i}`),
  msg("assistant", [{ type: "text", text: `我查一下${i}` },
    { type: "tool_use", id: `tu_${i}`, name: "code_search", input: { keyword: "x" } }]),
  msg("user", [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "..." }]),
  msg("assistant", `结论${i}`),
];
const D = (raws: any[]) => legacyListToDomain(raws);

describe("prepareModelMessages（test_history_windowing goldens 移植）", () => {
  it("未超限也替换 image 为占位", () => {
    const out = prepareModelMessages(D([
      msg("user", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
                   { type: "text", text: "看这个截图" }]),
      msg("assistant", "看到了")]), 60);
    expect((out[0].content as any)[0]).toEqual({ type: "text", text: HISTORY_IMAGE_PLACEHOLDER });
    expect((out[0].content as any)[1]).toEqual({ type: "text", text: "看这个截图" });
    expect(out[1]).toEqual({ role: "assistant", content: "看到了" });
  });
  it("过去回合压缩、当前回合整体保留", () => {
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...toolHeavyTurn(2),
      msg("user", "当前问题"),
      msg("assistant", [{ type: "tool_use", id: "tu_c", name: "file_reader", input: { path: "a.py" } }]),
      msg("user", [{ type: "tool_result", tool_use_id: "tu_c", content: "..." }])]), 6);
    expect(out[out.length - 3]).toEqual({ role: "user", content: "当前问题" });
    const flat = JSON.stringify(out.slice(0, -3));
    expect(flat).not.toContain("tu_1"); expect(flat).not.toContain("tu_2");
    expect(out.slice(0, -3)).toContainEqual({ role: "user", content: "问题2" });
    expect(out[0].role).toBe("user");
  });
  it("limit=5 hand-traced：恰剩回合3压缩体+当前问题（区分压缩与朴素切片）", () => {
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...toolHeavyTurn(2), ...toolHeavyTurn(3),
      msg("user", "当前问题")]), 5);
    expect(out).toEqual(D([
      msg("user", "问题3"),
      msg("assistant", [{ type: "text", text: "我查一下3" }]),
      msg("assistant", "结论3"),
      msg("user", "当前问题")]));
  });
  it("当前回合独自超窗仍整体发送", () => {
    const current = [msg("user", "当前问题"),
      msg("assistant", [{ type: "tool_use", id: "tu_c", name: "file_reader", input: { path: "a.py" } }]),
      msg("user", [{ type: "tool_result", tool_use_id: "tu_c", content: "..." }])];
    const out = prepareModelMessages(D([...toolHeavyTurn(1), ...current]), 2);
    expect(out).toEqual(D(current));
    expect(out.length).toBe(3);
  });
  it("limit=0 关闭窗口化", () => {
    const history = Array.from({ length: 40 }, (_, i) => toolHeavyTurn(i)).flat();
    expect(prepareModelMessages(D(history), 0).length).toBe(history.length);
  });
});
```

- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（对照 `app/main.py:277-348` 逐行移植，~50 行）→ **Step 4: 跑测通过** → **Step 5: Commit**

```bash
git commit -m "feat(v2): history policy port — image placeholder, condense-then-window, current-turn-whole"
```

---

### Task 6: event-adapter —— pi AgentEvent → DomainEvent

**Files:**
- Create: `v2/engine/src/event-adapter.ts`
- Create: `v2/engine/test/mock-anthropic.ts`（`cp spikes/pi-agent-core/src/mock-anthropic.ts v2/engine/test/`，头部加一行来源注释）
- Test: `v2/engine/test/event-adapter.test.ts`

**Interfaces:**
- Consumes: pi `AgentEvent`（`@earendil-works/pi-agent-core`——pi 类型止步于本文件）、`piAssistantToDomain`（Task 4）、`domainToLegacy` 不需要——`tool_exchange.assistant` 直接是 DomainBlock[]。
- Produces:

```typescript
export function createEventAdapter(opts: { model: string }): {
  onPiEvent(e: PiAgentEvent): DomainEvent[];   // 每个 pi 事件返回 0..n 个 domain 事件，顺序即发射顺序
  finish(): DomainEvent[];                     // agent 正常结束时调用 → [done]
  fail(message: string): DomainEvent[];        // → [error, done(success:false)]
};
```

映射表（oracle = `tests/test_agent_events.py` 三条 golden 序列）：

| pi 事件 | domain 事件 | 备注 |
|---|---|---|
| `message_update`(text delta) | `text_delta` | 增量文本逐条透传 |
| `message_end`(assistant) | `llm_metrics` | usage 取自 message.usage；iteration 自增计数；ttftMs=首个 text_delta 与本次调用起点的差，无文本则 null；totalMs=message_start→message_end |
| `tool_execution_start` | `tool_use` | `{id, name, input: args}` |
| `tool_execution_end` | `tool_result` | `{id, result}`（result 转字符串，与 Python 一致） |
| `turn_end`(带 toolResults) | `tool_exchange` | `assistant` = 该回合 assistant 消息经 `piAssistantToDomain` 的块；`results` = ToolResultBlock[]（配对靠 toolCallId） |
| （finish） | `done{text, success:true}` | text = 最后一条 assistant 的全文拼接 |
| pi error / fail() | `error` + `done{success:false}` | message 前缀 `"LLM API error: "`（Python 同款） |

- [ ] **Step 1: 写失败测试**（离线：真 pi Agent + mock server，断言 domain 事件序列 == Python golden）

```typescript
import { startMock, textTurn, textThenToolTurn } from "./mock-anthropic.js";
// Agent 装配方式逐字照抄 spikes/pi-agent-core/src/scenarios.ts 的 B1（streamFn 包装、
// convertToLlm、toolExecution:"sequential"、echo tool 换成 calculator 形状的 stub）。

it("纯文本回合：text_delta* → llm_metrics → done（test_text_only_turn_sequence）", async () => {
  const mock = startMock([textTurn("你好")]);
  const events = await runTurnThroughAdapter(mock, "hi");   // 本测试文件内的装配 helper
  expect(events.map(e => e.type)).toEqual(["text_delta", "llm_metrics", "done"]);
  expect(events.at(-1)!.data).toMatchObject({ text: "你好", success: true });
  await mock.close();
});

it("工具回合：…tool_use → tool_result → tool_exchange…（test_tool_round_sequence）", async () => {
  const mock = startMock([
    textThenToolTurn("算一下", "calculator", { expression: "1+1" }, "tu_1"),
    textTurn("答案是2")]);
  const events = await runTurnThroughAdapter(mock, "1+1=?");
  expect(events.map(e => e.type)).toEqual(
    ["text_delta", "llm_metrics", "tool_use", "tool_result", "tool_exchange",
     "text_delta", "llm_metrics", "done"]);
  const ex = events.find(e => e.type === "tool_exchange")!.data as any;
  expect(ex.assistant[0]).toEqual({ type: "text", text: "算一下" });
  expect(ex.assistant[1].id).toBe("tu_1");
  expect(ex.results[0].toolUseId).toBe("tu_1");
  await mock.close();
});

it("LLM 报错：error → done(success:false)（test_llm_error_yields…）", async () => {
  const mock = startMock([]);           // 无脚本 ⇒ mock 返 500
  const events = await runTurnThroughAdapter(mock, "hi");
  expect(events.map(e => e.type)).toEqual(["error", "done"]);
  expect((events[0].data as any).message).toMatch(/^LLM API error: /);
  expect((events[1].data as any).success).toBe(false);
  await mock.close();
});
```

（mock 单块下发文本 ⇒ 纯文本 golden 是 1 个 `text_delta` 而非 Python 的 2 个——序列**类型顺序**是断言目标，delta 个数随流式切块自然变化，Python golden 同理只锁类型序列。）

- [ ] **Step 2: 跑测失败** → **Step 3: 实现 adapter + 测试内装配 helper**（有状态类：iteration 计数、计时、当前回合块缓冲；~120 行）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): pi-event -> domain-event adapter — golden sequences from test_agent_events reproduced"
```

---

### Task 7: 端到端组装测试 + README + 收尾

**Files:**
- Test: `v2/engine/test/integration.test.ts`
- Create: `v2/engine/README.md`
- Modify: `docs/superpowers/plans/GATE.md`（遗留风险 1 的两个开放问题标记已关闭，引用 REPORT-phase1.md）

**Interfaces:**
- Consumes: 全部前置任务的公开函数，不新增接口。

- [ ] **Step 1: 写端到端测试**（唯一一条穿全管道的路径）

```typescript
it("legacy 史 → historyPolicy → codec → pi Agent(mock) → adapter → 可持久化 legacy 交换", async () => {
  const legacyHistory = [...多轮 legacyToolTurn 变体, { role: "user", content: "当前问题" }];
  const domain = legacyListToDomain(legacyHistory);
  const shaped = prepareModelMessages(domain, 6);
  const piMsgs = domainToPi(shaped, { model: "qwen3.7-plus", provider: "dashscope" });
  const mock = startMock([textThenToolTurn("查", "calculator", { expression: "1+1" }, "tu_9"), textTurn("完")]);
  const events = await runTurnThroughAdapter(mock, "当前问题", { initialMessages: piMsgs });
  // ① 事件序列含完整 tool 回合；② tool_exchange 的块经 domainToLegacy 后
  //   与 legacy golden 形状逐字相等（tool_use_id/is_error 拼写复原）；
  // ③ mock.requests[0].body.messages 开头是 user（history policy 的 never-opens-on-assistant 穿透到线上）。
});
```

- [ ] **Step 2: 跑全量**（`npm test && npm run typecheck`，全绿）
- [ ] **Step 3: README.md**——层边界图（哪层允许 import 什么）、Phase 2 消费点（`codec-legacy` + 原始 DB 编码属 Phase 2 自己）、Phase 3 消费点（`event-adapter`/`history-policy`/`codec-pi` + 每 turn 临时 Agent 装配范式即 scenarios.ts B1）、image 块的 CodecError 限制及归属。
- [ ] **Step 4: 更新 GATE.md 开放问题状态 + progress.md，Commit**

```bash
git add v2/engine docs/superpowers/plans/GATE.md
git commit -m "feat(v2): phase-1 anticorruption layer complete — e2e pipeline green, GATE open questions closed"
```

---

## Self-Review 记录

- **Spec 覆盖**：主计划 Phase 1 行的三项交付——"三 DTO 双向转换"= Task 2/3/4；"pi event → legacy SSE 适配"（按主计划 416 行更正为 pi event → **domain** event，SSE 边缘是 Phase 3）= Task 6；"history policy" = Task 5。GATE.md 遗留风险 1 的两个开放问题 = Task 1（E1/E2）；风险 3 中"codec 是设计草案未验证" = Task 4 落地。GATE.md 说的"Phase-1 早期联调验证" ⇒ Task 1 放在最前且 Task 4 显式前置依赖它。
- **占位符检查**：Task 4 的 pi `usage` 字段拼写、Task 6 的装配 helper 明确指向 spike 实物（scenarios.ts B1/B6）为基准而非 TBD——0A/0B 已证明"以 v0.x 实物为准"是必要姿态（brief sketch 曾三次与真实 API 不符）。Task 7 Step 1 的 fixtures 组合是测试内联数据，代码骨架完整。
- **类型一致性**：`toolUseId/isError`（domain）在 Task 3 转换表、Task 4 的 `toolCallId:toolUseId`、Task 6 的 `ex.results[0].toolUseId` 三处拼写一致；`prepareModelMessages(history, maxHistoryMessages)` 在 Task 5 定义与 Task 7 调用一致；`CodecError` 在 Task 2 定义、Task 3/4 抛出。`legacyListToDomain` 在 Task 3 产出、Task 4/5/7 消费。
- **G goldens 对应**：test_message_codec 的**原始字节编码**（list→JSON string、`[` 前缀）刻意不在本 Phase——那是 Phase 2 DB 层的验收标准（主计划 344 行），本 Phase 的 codec-legacy 只管块形状。
