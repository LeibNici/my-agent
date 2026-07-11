# Phase 1 判定报告 — GATE.md 遗留风险 1 开放问题（E1/E2）× DashScope qwen3.7-plus

- pi-ai 版本 / Node 版本 / 运行日期：`@earendil-works/pi-ai@0.80.6` / Node `v24.18.0` / 2026-07-11
- 复用 0A 既有 scaffold：`spikes/pi-provider/src/provider.ts` 的 `dashscopeModel`
  （DashScope Anthropic-compatible endpoint，`qwen3.7-plus`）与 `scenarios.ts`
  的 `models.stream` 流式调用方式；消息字面量手工拼装风格照抄
  `spikes/pi-agent-core/src/scenarios.ts` 的 B6 场景（pi-ai 不导出
  `userText`/`assistantToolCall`/`toolResult` 辅助函数，B6 直接内联对象字面
  量——本任务用等价的本地小函数封装同样的字面量形状）。

## E2 静态检查：与 brief 前提不符的发现

brief 的前提是"此前对 `spikes/pi-agent-core` 副本的快速 grep 未命中，E2 大
概率是 `NOT-EXPOSED`，无需联网验证"。**这个前提对 `pi-provider` 自己安装的
副本不成立**——实际 grep 命中，`toolChoice` 确实被暴露。执行的命令与结果：

```
$ cd spikes/pi-provider
$ grep -rn "toolChoice\|tool_choice" node_modules/@earendil-works/pi-ai/dist/ \
    --include="*.js" --include="*.d.ts"
```

关键命中：

```
node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.d.ts:58:
    toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:750-757:
    if (options?.toolChoice) {
        if (typeof options.toolChoice === "string") {
            params.tool_choice = { type: options.toolChoice };
        } else {
            params.tool_choice = options.toolChoice;
        }
    }
```

（其余命中分布在 `bedrock-converse-stream.js`、`google-vertex.js`、
`google-generative-ai.js`、`mistral-conversations.js`、
`openai-completions.js` ——pi-ai 支持的每个 API 后端都有自己的 toolChoice 形
态；`anthropic-messages` 不是例外。首次未加 `--include` 过滤时命中了大量
`.js.map` 源码映射噪声，加过滤后确认命中都在真实 `.js`/`.d.ts` 源文件里，
不是 source map 误报。）

`toolChoice` 是 `AnthropicOptions`（继承 `StreamOptions`）上的字段，作为
`models.stream(model, context, options)` 的第三个位置参数传入——与 S4/S6 用
的 `sessionId`/`cacheRetention`/`signal` 同一个槽位。**因此 E2 需要按 brief
"有命中才补一个真实调用"的分支走，不能停在 `NOT-EXPOSED`。**

## 判定表

| 场景 | 判定 | 证据（两轮独立运行，均为对真实 DashScope 端点的调用）|
|---|---|---|
| E1 双连续user消息（tool_result-user 紧跟独立 text-user） | **PASS** | run1: `done stopReason=toolUse textLen=0`（模型选择继续调工具而非纯文本收敛，但请求本身正常抵达并收到 `done`，非 4xx）/ run2: `done stopReason=stop textLen=172`，正文以"好的。为了能更精准地帮助您，请问您具体遇到了哪方面的登录问题？..."开头——两次独立运行均正常收到 `done`，无 4xx/error |
| E2 `tool_choice:"none"` 端点验证 | **PASS** | run1: `accepted, no 4xx — sawToolCall=false textLen=84` / run2: `accepted, no 4xx — sawToolCall=false textLen=63`——两次独立运行 DashScope 均接受 `tool_choice:{"type":"none"}` 字段（无 4xx），且行为语义也生效：即便 prompt 明确要求"请务必调用 echo 工具"，两次均未产生 `toolcall_end` 事件，模型改为输出纯文本 |

原始命令与输出（两轮，`set -a; source /home/my-agent/.env; set +a` 后运行）：

```
$ npx tsx src/phase1-endpoint.ts
PASS  E1 双连续user消息(tool_result-user 紧跟 text-user)  —  done stopReason=toolUse textLen=0 textPreview=""
PASS  E2 tool_choice:"none" 端点验证(pi-ai 确实暴露该字段, 见文件头 grep 记录)  —  accepted, no 4xx — sawToolCall=false textLen=84

$ npx tsx src/phase1-endpoint.ts
PASS  E1 双连续user消息(tool_result-user 紧跟 text-user)  —  done stopReason=stop textLen=172 textPreview="好的。为了能更精准地帮助您，请问您具体遇到了哪方面的登录问题？例如：\n\n1. **账号/密码问题**（如提示密码错误、账"
PASS  E2 tool_choice:"none" 端点验证(pi-ai 确实暴露该字段, 见文件头 grep 记录)  —  accepted, no 4xx — sawToolCall=false textLen=63
```

`npx tsc --noEmit`（`--strict`，见 `spikes/pi-provider/tsconfig.json`）：无错误、无输出。

## 实现笔记

- **E1 的消息构造**：`assistantToolCall` helper 补全了完整 `AssistantMessage`
  必填字段（`api`/`provider`/`model`/`usage`/`stopReason`/`timestamp`），风
  格与 `scenarios.ts` S3、`pi-agent-core` B6 一致——不是从 `done` 事件里拿真
  实对象回填（E1 就是要测试"手工拼装、未经 pi codec 合并"的原始双 user 形
  状本身能不能被端点接受），所以字段值都是占位常量（`usage` 全 0），端点
  显然不校验这些占位字段的取值合理性，只关心消息序列的角色顺序/结构合法性。
- **E1 的 run1/run2 差异不是 flake**：两轮都干净地拿到 `done` 事件、无
  4xx/error，只是模型这次业务选择不同（一次继续调工具，一次直接用文本收
  敛）——这正是 E1 要验证的"端点接受该消息形状"本身，跟模型选择怎么回应
  是两件事，判定标准只看有没有 4xx/error，不看模型选了哪条业务路径。
- **E2 的行为验证比"接受字段"更强**：不仅两次调用都没有 4xx，`tool_choice:
  "none"` 在业务语义上也确实被 DashScope 尊重——prompt 里明确要求"请务必调
  用 echo 工具"，但两次都没有产生 `toolcall_end` 事件，模型转而输出纯文本
  解释性回复。
- **E2 与 brief 前提的落差**：brief 假定"prior quick grep 对
  `pi-agent-core` 副本无命中"能推广到 `pi-provider`，但两个 spike 目录各自
  独立 `npm install` 的 `node_modules`，理论上版本可能不同步、grep 结果不
  能跨目录复用——本任务对 `pi-provider` 自己的副本重新 grep 后发现命中，纠
  正了这个假设。教训记录：静态检查类的判定必须在实际要跑代码的那个目录上
  验证，不能复用兄弟 spike 目录的旧 grep 结果。

## 结论：D1、D2 取值

- **D1（喂给 Task 4）**：`E1 = PASS` ⇒ DashScope 接受"tool_result-user 后
  紧跟独立 text-user"两条连续 user 消息，无需在 `codec-pi.ts` 里为 reminder
  自写合并逻辑。**`codec-pi.ts` 保持 pi 默认形状（reminder 落成独立的
  text-only user 消息，不用手工合并进前一条 tool_result user 消息）。**
- **D2（喂给 Phase 3，本 Phase 只记录）**：`E2` 静态检查发现 pi-ai 的
  `anthropic-messages` 后端**确实暴露 `toolChoice`**（brief 假设的
  `NOT-EXPOSED` 不成立），且真实端点两轮验证均 `PASS`——`tool_choice:"none"`
  被 DashScope 接受且语义生效。**因此 v2 wrap-up 机制有两个可用选项，而非
  brief 预设的"只能退回 tools-omitted"：**
  - **(a) tools-omitted**（0A S5 已验证 PASS，`tools: []` 强制纯文本）；
  - **(b) `toolChoice: "none"`**（本任务新验证 PASS，保留 tools 字段但用
    `toolChoice` 显式压制调用）。
  两条路径本 Phase 都判定可行；**v2 wrap-up 具体选哪条留给 Phase 3 决定**
  （(a) 更接近 0A 已定的实现且改动面更小，(b) 与 legacy 的
  `tool_choice:"none"` 语义更贴近、迁移 legacy 预算 goldens 时断言改动可能
  更少）——Phase 3 移植预算 goldens 时按选定路径调整断言，且**不再需要
  "pi-ai 不支持 tool_choice，legacy 回退重试路径在 v2 中无对应物、废弃"这条
  假设**，因为 pi-ai 事实上支持该字段。
