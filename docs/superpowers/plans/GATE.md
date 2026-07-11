# v2 引擎决策记录（GATE）

日期：2026-07-11　　决策人：____（待签）

> 本文档由 gate 流程产出、经独立复核（22 goldens 重跑 + 0B 离线场景重跑均绿）后
> 给出**建议**决策；正式生效以决策人签字为准。

## 输入

- **Phase -1**：`tests/` 基线 **22** 个用例全绿（本机复跑 `pytest tests/ -q` →
  `22 passed in 1.70s`，commit `d12ff06`；golden 构建于 `9476ae7..ce201f2`，
  中途从过期的 origin/main 基座 rebase 到本地 main `9eed522`，全部 golden
  钉的是 rebase 后代码）
- **Phase 0A**：`spikes/pi-provider/REPORT.md` ⇒ **PASS**
  （`@earendil-works/pi-ai@0.80.6` × DashScope qwen3.7-plus，S1–S7 两次独立
  运行全绿，含两个非硬门：S4 prompt caching 真实命中 cacheRead=4005、
  S5 空 tools 强制纯文本成立）
- **Phase 0B**：`spikes/pi-agent-core/REPORT.md` ⇒ **PASS（Agent 类）**
  （`@earendil-works/pi-agent-core@0.80.6`，B1–B6 六项全部在 Agent 类层通过，
  B2/B3/B4 在 agentLoop 层也通过；离线 mock，复核时重跑一致）

## 决策树

- 0A FAIL ⇒ 停止：~~pi 全家不可用于 DashScope 生产~~ —— 未命中
- **0A PASS + 0B PASS ⇒ GO** ✅ —— **命中此分支**
- 0A PASS + 0B FAIL ⇒ GO(变体)：~~pi-ai + 自研 loop / fork 加 hooks~~ —— 未命中

## 结论

engine 形态：**`@earendil-works/pi-agent-core` 的高级 `Agent` 类**，作为
per-turn ephemeral agent 基座。

- B1（事件→legacy SSE 适配器）、B2（订阅者 await 即 turn 屏障，实测 206–207ms
  硬阻塞）、B3（`transformContext` 返回新数组实现非持久化 reminder）、
  B5（`abort()` 干净取消）、B6（`initialState.messages` 注入外部历史）——
  全部用 Agent 类一等 API 直接落地，无需下沉。
- **B4 预算终止的姿态**：Agent 类优先——`afterToolCall`+`terminate` 在
  legacy 的单工具/sequential 回合形状下成立；**若未来需要 parallel/多工具
  回合，B4 这一步下沉到 `agentLoop` 的 `shouldStopAfterTurn`（无条件停，
  legacy 语义的忠实原语），或向上游提 PR 把 `shouldStopAfterTurn` 暴露到
  `AgentOptions`**。wrap-up 调用与 loop 无关（独立
  `models.streamSimple(tools:[])`），两条路都成立。
- 不走备选方案（pi-ai + 自研 TypeScript loop，或 fork pi-agent-core）。

## 遗留风险（Codex 评审三大风险逐条对照现状）

1. **checkpoint / turn barrier / wrap-up 的实现层**：已由 0B 回答——
   B2（屏障）/B3（reminder 注入）/B4（预算停+wrap-up）在 Agent 类与
   agentLoop 两层均实测可行（对照规范：Task 5 的 `test_agent_budget.py`
   goldens）。**曾经开放的两点，已在 Phase-1 早期联调验证中关闭**（见
   `spikes/pi-provider/REPORT-phase1.md`，commit `2bb6425`）：
   - B3 的 reminder 在 pi 里落成独立尾随 user 消息（tool_result-user 后
     连续第二条 user 消息，pi codec 不合并）——DashScope 等真实
     Anthropic 兼容端点是否接受此消息形状，未验证；
     ⇒ **E1 = PASS**：两轮独立调用均正常收到 `done`、无 4xx/error，
     DashScope 接受该双 user 消息形状；`codec-pi.ts` 保持 pi 默认形状，
     无需手工合并 reminder 进前一条 tool_result user 消息。
   - legacy wrap-up 靠 `tool_choice:"none"`（含端点拒绝后的回退重试路径），
     spike 用的是整体省略 `tools` 字段——`tool_choice:"none"` 在 pi-ai 上
     从未实际发出过，等价性未在线上验证。
     ⇒ **E2 = PASS，且推翻了"NOT-EXPOSED"的前提**：`toolChoice` 确实被
     `@earendil-works/pi-ai` 的 `anthropic-messages` 后端暴露
     （`AnthropicOptions.toolChoice`），两轮真实 DashScope 调用均无 4xx 且
     语义生效（prompt 明确要求调用工具，两次均未产生 `toolcall_end`）。
     v2 wrap-up 因此有两条都已验证可行的路径——tools 整体省略、或
     `toolChoice:"none"`——具体选哪条留给 Phase 3（细节见
     `v2/engine/README.md`）。
2. **每 turn 临时 Agent + SQLite 真相源**：0B 全部六个场景均以"每场景
   FRESH Agent + `initialState.messages` 注入"的模式跑通，即目标运行模型
   已被 spike 全程采用并验证。落实为强制约束（禁止常驻 Agent 状态、
   SQLite 为唯一真相源）属 Phase-1 设计交付物。
3. **legacy SSE / 持久化语义的覆盖度**：22 个 Python golden 已冻结核心
   语义（Agent.run 事件序列、LLM call kwargs、预算 checkpoint、SSE 浏览器
   契约含断连/拒绝、历史窗口化、消息编解码）。**尚未钉住、须作为 Node 侧
   测试债在 Phase 1–3 补齐的**：
   - error 路径下 `done` 事件的 payload 形状；
   - 持久化行的 role 取值全集；
   - `switch_reason` 的 `not_found`/`resolved` 分支；
   - session 锁语义；
   - `llm_call_metrics` 行的写入时机与字段。
   另有 B6 注③的 **legacy→pi codec（含 `toolName` 靠 `tool_use_id` 回查
   补field）目前只是设计草案**，代码从未执行过——codec 本体 + 其测试是
   Phase-1 的第一交付物。

## 下一步

**决策人签字确认本 GO 结论后**，才开始编写 Phase 1 计划文档
（防腐层 + legacy codec：先把注③的编解码规范变成可测试的实现，并在真实
DashScope 端点上验证上面两个开放的消息形状问题）。
