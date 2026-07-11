# Phase 0B 能力矩阵 — pi-agent-core 控制面

- pi-agent-core 版本 / 运行日期：`@earendil-works/pi-agent-core@0.80.6`（`@earendil-works/pi-ai@0.80.6`）/ 2026-07-11
- 复现：`npx tsx src/scenarios.ts all`（每项可单独跑，如 `... B3`）。全程离线（mock 服务器），每个场景新建 FRESH `Agent`，工具一律 `sequential`。连跑两次结果一致（B2 计时 206–207ms 稳定），非 flaky。
- 证据来源：`mock.requests[N].body.messages`（模型第 N 次调用实际收到什么）+ `mock.requests[N].at`（墙钟时间戳，证明屏障/顺序）。对照 golden：`tests/test_agent_budget.py`、legacy 语义 `app/agent.py`。

| 能力 | Agent 类 | agentLoop | 证据/备注 |
|---|---|---|---|
| B1 事件→legacy SSE 可重组 | ✅ PASS | — (同源) | 仅凭 Agent 事件即可重组 `text_delta → tool_use{id,name,完整input} → tool_result → 屏障 → 下一回合 → done`。工具入参在 `tool_execution_start.args`（已解析对象）和最终 `message_end` 的 `assistant.content` toolCall 块都能拿到。缺口：partial input 走 `message_update(toolcall_delta)`，本 mock 单块下发，增量 JSON 拼装未被压测。 |
| B2 turn 边界同步屏障 | ✅ PASS | ✅ PASS | Agent：`turn_end`（带 toolResults）订阅者内 `await delay(200)`，`request#1` 比 `request#0` 晚 **207ms** 才发出 → 订阅者 await 是硬屏障（`processEvents` 逐个 `await listener`，loop 逐事件 `await emit`）。agentLoop：同样 emit sink await 阻塞，晚 206ms。二者均可在“工具结果就绪”与“下次 LLM 调用”之间跑异步工作。 |
| B3 tool results 后注入非持久化 reminder | ✅ PASS（能力；结构差异+端点接受度见下） | ✅ PASS（同上） | `transformContext`（Agent 与 loop 都暴露）在每次 LLM 调用前对 transcript **按引用**变换（`messages` 一开始就是 `context.messages` 的引用；非持久化靠 hook **返回新数组**重新绑定，不是靠复制——原地 mutate 会真的持久化），结果只喂 `convertToLlm`。`call#1` body 含 `本轮调查已过半`，`call#0` 不含，`agent.state.messages` 全程干净。**⚠️ 结构差异（非 byte-for-byte 等价）**：reminder 在 pi 里落成一条**独立的尾随 user 消息**，不是 legacy 那种塞进**同一条** tool_result user 消息里的尾随 text 块；pi 的 codec 不会把 tool_result-user 和紧随其后的 text-user 合并，所以线上会连续发出**两条 user 消息**。这个消息形状能否被真实 Anthropic 兼容端点（含 DashScope）接受，离线 mock 环境**验证不了**（mock 全盘照单全收）——标记为 PASS(capability)，端点接受度见文末「开放问题」。结构差异细节见注①。 |
| B4 预算终止 + 独立无工具 wrap-up | ✅ PASS | ✅ PASS | Agent：`afterToolCall` 达预算即 `{terminate:true}`，loop 停在第 2 次调用，第 3 个 tool turn 从未请求；随后单独 `models.streamSimple(model, {…, tools:[]})` 发 wrap-up（`req#2` body **无 `tools` 字段**），全程共 3 次请求、agent 未再多发。agentLoop：`shouldStopAfterTurn` 无条件停在第 N 回合（更贴合 legacy“迭代到 N 即停”）。**spike 用“省略 `tools` 字段”达成无工具，legacy oracle 实际用 `tool_choice:"none"`——不是同一机制，见注④。** 见注②、注④。 |
| B5 取消干净（无泄漏请求/回调） | ✅ PASS | — (同源) | 工具执行中 `agent.abort()`：工具 `execute` 收到的 `signal.aborted===true`（tool 阻塞至 abort 才返回）；abort 后 `mock.requests` 不再增长（before=after=1）；60ms settle 窗口内 **0** unhandledRejection；`state.errorMessage="Request was aborted."`。 |
| B6 外部历史注入**保真度**（非 codec 本身） | ✅ PASS | — (同源) | **范围**：本场景只测“pi 能否忠实转发一段已经是 pi 格式的历史”，**不测 legacy→pi 的 codec 转换本身**——三段历史（user → assistant(text+tool_use) → user(tool_result)）是**按注③规则手工预先拼好**的 pi 消息（`toolName` 字段手填），直接塞进 `initialState.messages`，codec 转换代码从未被调用。跑一轮后 `request#0.body.messages` 角色顺序 `user,assistant,user,user`、`tool_use{id,name,input}` 与 `tool_result{tool_use_id}` 的结构与 id 全部保真，新 prompt 追加在末尾——**这部分 PASS**。**未测**：注③里“`toolName` 靠 `tool_use_id` 回查匹配的 `tool_use` 块补回”只是写下来的设计规则，从未被代码实际执行过（本场景是手填的）；`tool_result` 的 `content`/`isError`、assistant 文本块的保真只是打印出来肉眼核对，没有断言。**codec（含 toolName 回填逻辑）是 Phase-1 交付物**，不在本次验证范围内。 |

> B1/B5/B6 的 agentLoop 列标“同源”：Agent 类只是 agentLoop 的有状态封装（`agent.js` 直接调 `runAgentLoop`），事件流/取消/`convertToLlm` 编解码完全共享同一实现，Agent 通过即等价于 loop 通过，无需分层重测。B2/B3/B4 按要求两层分别实测。

## 四条落地注记（喂给 Phase-1）

- **注① B3 结构差异**：pi 的消息模型把 reminder 挤成一条**独立的尾随 user 消息**；legacy 是把 reminder 作为尾随 text 块塞进**同一条** tool_result user 消息。两者模型都在结果之后看到提示，语义等价，但要 byte-for-byte 一致需自写 `convertToLlm`/API 编解码。另：连续两条 user 消息（tool_result-user 紧跟 text-user，pi 的 codec 不合并）能否被真实 Anthropic 兼容端点（含 DashScope）接受——**离线 mock 全盘照单全收，这一点未经真实端点验证**。
- **注② B4 分层差异**：Agent 类**没有** `shouldStopAfterTurn`；`terminate` 路线要求一个 batch 内**每个**工具都置 `terminate`（legacy 单回合单工具、sequential 时没问题，但 parallel/多工具回合会脆）。agentLoop 的 `shouldStopAfterTurn` 是无条件的，才是 legacy“预算用尽即停”的忠实原语。
- **注③ B6 codec 规则（Phase-1 编解码规范草案）**：
  - `user`（string 或 text 块）→ `{role:"user", content:[{type:"text",text}], timestamp}`
  - assistant `text` 块 → `{type:"text",text}`；assistant `tool_use` 块 → `{type:"toolCall", id, name, arguments:input}`，整条包成 `{role:"assistant", api/provider/model/usage, stopReason:"toolUse", timestamp}`
  - user `tool_result` 块 → 独立 `{role:"toolResult", toolCallId:tool_use_id, toolName, content:[{type:"text",text}], isError:false, timestamp}`
  - ⚠️ `toolName` 在 legacy 形状里**不存在**，codec 必须靠 `tool_use_id` 回查匹配的 `tool_use` 块把 name 补回来。
  - pi 会把 `toolResult` 再序列化回 user/`tool_result` 块（连续多个 toolResult 合并进一条 user 消息）。
  - ⚠️ **以上是设计草案，不是已验证的实现**：B6 场景注入的三段历史是**手工按这套规则预先拼好**的 pi 消息（`toolName` 手填），codec 转换代码从未被实际调用/跑过；`toolName` 回查匹配这条规则、以及 `tool_result` 的 `content`/`isError`、assistant 文本块的保真，都还没有代码或断言验证过。Codec（含 toolName 回填）本身是 **Phase-1 交付物**。
- **注④ B4 wrap-up 机制 vs. legacy oracle**：spike 的“工具自由”是靠**完全不发送 `tools` 字段**做到的（`tools:[]` 序列化时整字段消失）。legacy 的真实 oracle（`tests/test_agent_budget.py`）并不检查 `tools` 是否存在——它对 wrap-up **首次尝试**（`fake.calls[8]`）断言 `wrap_call.get("tool_choice") == {"type": "none"}`（`tools` 字段本身仍随 payload 一起发送，`app/agent.py` 两次尝试都传 `tools=tools if tools else None`），只在**重试**调用（`fake.calls[9]`，仅当首次尝试抛异常才会发生）上断言 `"tool_choice" not in fake.calls[9]`。也就是说 legacy 靠 `tool_choice:"none"` 达成“本轮不许调工具”，spike 靠“整体省略 `tools` 字段”达成同一效果——等价或更强的机制，也吻合 brief 里 B4 的草图；但 **pi-ai 是否支持 `tool_choice:"none"`、以及 legacy 那条“端点拒绝 tool_choice 后回退重试”的路径，spike 都没有实际跑过**，是留给 GATE 的开放问题。

## 通过标准
B1/B5/B6 + (B2、B3、B4 至少在某一层全部可行) ⇒ 0B PASS。
- B1 ✅、B5 ✅、B6 ✅（均 Agent 类可行）。
- B2 ✅（两层）、B3 ✅（两层）、B4 ✅（两层）——三项都在两层可行，远超“至少某一层”门槛。

## 结论：0B PASS（Agent 类）

六项全部在 **Agent 类** 通过，无需下沉到 agentLoop 即满足 legacy 全部 checkpoint 语义。给 Task 11 的建议：

- **v2 直接用 `@earendil-works/pi-agent-core` 的高级 `Agent` 类**作为 per-turn ephemeral agent 基座 —— B1（事件→SSE 适配器）、B2（订阅者屏障）、B3（`transformContext` 非持久化 reminder）、B5（`abort()`）、B6（`initialState.messages` 注入）都用一等 API 直接落地。
- **唯一要盯的是 B4 的预算终止**：Agent 类只能走 `afterToolCall`+`terminate`（依赖“batch 内全部工具置 terminate”）。legacy 的“迭代 N 即停”本质是 per-turn 无条件停，`shouldStopAfterTurn` 才是忠实原语，而它**只在 agentLoop 暴露**。Phase-1 两条路：(a) 保持单工具/sequential 回合，让 `terminate` 路线成立；(b) 若需要 parallel/多工具，B4 这一步下沉到 `agentLoop` 或向上游请求把 `shouldStopAfterTurn` 提到 `AgentOptions`。wrap-up 调用本身与 loop 无关（独立 `models.streamSimple(tools:[])`），两条路都成立。
- 不需要走备选（pi-ai + 自研 loop，或 fork 加 hooks）。

## 开放问题（供 GATE 决策）

- **B3 消息形状 + `tool_choice:"none"` 的真实端点接受度**：B3 的 reminder 落成独立尾随 user 消息，紧跟在 tool_result-user 后面（pi 的 codec 不合并两者），线上会连续发出两条 user 消息；B4 wrap-up 依赖端点接受 `tool_choice:"none"`（若 Phase-1 按 legacy 语义实现的话）。这两个消息形状能否被真实 Anthropic 兼容端点（含生产用的 DashScope）接受，离线 mock 全盘照单全收，**验证不了**，需要联网/联调验证。
- **legacy 的 `tool_choice` 拒绝后回退重试路径未测**：`tests/test_agent_budget.py` 的 golden 里，wrap-up 首次尝试带 `tool_choice:{"type":"none"}`，若端点拒绝该字段就重试一次（不带 `tool_choice`）。spike 的 B4 实现路线是完全不发 `tools` 字段，从未实际调用过 `tool_choice:"none"`，因此这条重试路径在 pi-ai 上是否需要、如何触发，都是空白，Phase-1 需要单独验证。
