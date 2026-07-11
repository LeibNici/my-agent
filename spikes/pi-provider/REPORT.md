# Phase 0A 判定报告 — pi-ai × DashScope qwen3.7-plus

- pi-ai 版本 / Node 版本 / 运行日期：`@earendil-works/pi-ai@0.80.6` / Node `v24.18.0` / 2026-07-11
- 与 README 文档不符的 API 名（如有）：无新增（Task 7 已记录的差异——`Model`
  需要完整字段、`UserMessage`/`ToolResultMessage` 需要 `timestamp`、事件用量在
  `done`/`error` 事件的 `message.usage` 而非事件本身——本任务未发现更多）。
  本任务新发现一处 **brief 脚本草稿本身与真实 API 不符**（非 pi-ai 文档问题，
  是 Task 8 brief 的 sketch 问题，已在 `scenarios.ts` 头部注释记录并修正）：
  `models.stream(model, context, options)` 是三个独立参数——`Context`
  （`messages`/`tools`/`systemPrompt`）与 `StreamOptions`（`sessionId`/
  `cacheRetention`/`signal` 等）不能合并进同一个对象字面量传给第二个参数，
  否则 `tsc --strict` 直接报错（`'sessionId' does not exist in type
  'Context'`）。brief 的 S4/S6 sketch 都把两者混在一起。

| 场景 | 判定 | 证据 |
|---|---|---|
| S1 流式文本 | PASS | run1: chunks=12 len=95 / run2: chunks=14 len=109 |
| S2 工具调用+schema校验 | PASS | run1/run2 均返回 `{"type":"toolCall","name":"code_search","arguments":{"keyword":"UserService"}}`（参数经 typebox schema 校验通过） |
| S3 长工具会话(10轮无4xx) | PASS | run1: "10 rounds completed, no 4xx" / run2: 同上——两次独立运行各连续10轮 echo 工具调用无 4xx |
| S4 prompt caching 真实产生 cache read | PASS | run1 第二次调用 `usage={"input":6,"output":222,"cacheRead":4005,...}` / run2 `usage={"input":6,...,"cacheRead":4005,...}`——两次独立运行的第二次调用均产生真实 4005 tokens 的 cache read（首次调用建立 cache write，第二次同 sessionId 命中读取），非仅"参数被接受不报错" |
| S5 空tools强制纯文本 | PASS | run1: sawTool=false len=1214 / run2: sawTool=false len=1274 |
| S6 中途取消不悬挂 | PASS | run1: chunks=3 terminal=error(aborted) unhandledRejection=none / run2: 同上——`AbortController.abort()` 后 3 个 text_delta 内流以 pi-ai 的 `{type:"error",reason:"aborted"}` 终止事件收尾（非抛异常，见下方"实现笔记"），且 300ms 观察窗口内无 `unhandledRejection` |
| S7 usage/TTFT 完整 | PASS | run1: ttft=7237ms usage.input=13 usage.output=303 / run2: ttft=5332ms usage.input=13 usage.output=210——两次 TTFT 与完整 input/output usage 均非零 |

## 实现笔记（供 v2 迁移参考，非判定标准本身）

- **S4 的意外结果**：Task 7 复盘曾提示"若 caching 请求 400，需要用保守
  `model.compat` 重试"——实测并未触发这条路径。`cache_control` 在
  pi-ai 的 `anthropic-messages.js` 中对**任意** `anthropic-messages` API 的
  baseUrl 都无条件下发（不判断是否为官方 Anthropic host），DashScope 的
  Anthropic 兼容端点不仅接受了该字段，还**真实执行了 prompt caching**
  （两次独立 run 的 cacheRead 均恰好等于 4005，与构造的 ~4000 字前缀吻合）。
  这比预期乐观：v2 的成本模型可以按现有 Python 版一样假设 prompt cache 有效。
- **S6 的实现差异**：brief 的 sketch 用 `try/catch` 捕获 abort 导致的异常，
  但真实行为是 pi-ai 在内部吞掉 abort 触发的错误，改为发出终止事件
  `{type:"error", reason:"aborted", error: AssistantMessage}`，流正常
  `end()`，从不会让 `for await` 循环抛出。`scenarios.ts` 已按此改写断言
  （检查 `terminal==="error" && terminalReason==="aborted"`），并保留原
  `try/catch` 作为兜底以防某些更底层的 abort 真的同步抛出。
- **S3 的消息回填**：没有照抄 brief 手搭 `{role:"assistant", content:[...]}` 的
  写法（缺 `api`/`provider`/`model`/`usage`/`stopReason`/`timestamp`
  等 `AssistantMessage` 必填字段，`tsc --strict` 会拒绝），而是直接把
  `done` 事件返回的完整 `AssistantMessage` 对象原样推回 `messages`；
  `toolResult` 消息补上了 brief 遗漏的必填 `toolName` 字段。

## 通过标准
S1/S2/S3/S6/S7 全 PASS 为硬门；S4 FAIL 仅影响成本模型（记录，不否决）；
S5 FAIL 则 wrap-up 需改用"提示词+忽略工具调用"实现（同现有 Python 回退路径，记录）。

## 结论：0A PASS

全部 7 个场景（S1–S7）在两次独立运行中均一致 PASS，无 flaky。硬门场景
（S1/S2/S3/S6/S7）全绿；S4（prompt caching）与 S5（空 tools 强制纯文本）
两个非硬门场景也均 PASS，好于"仅需记录不否决"的最低要求——v2 成本模型
可以假设 prompt caching 生效，wrap-up 可以直接用 `tools: []` 而不必退回
提示词+忽略工具调用的兼容路径。**Phase 0A 判定：PASS，无阻塞发现，可推进
下一阶段迁移。**
