## 1. 逐条设计点评审

### 1）冻结 SSE 与 SQLite 契约

结论：方向正确，但目前冻结的契约定义过窄。“事件名称不变、schema 不变”不足以保证兼容。

#### 翻车风险：pi 事件与现有 SSE 不是同构关系

现有系统实际上有三层事件：

1. LLM 原始流事件；
2. `AgentEvent` 内部事件；
3. 浏览器 SSE 事件。

内部 `AgentEvent` 包括 `text_delta/tool_use/tool_result/tool_exchange/llm_metrics/done/error`，其中 `tool_exchange` 和 `llm_metrics` 不发给前端，而是驱动持久化与指标记录，见 [app/agent.py](/home/my-agent/app/agent.py:15)。

建议映射如下，但必须由自有适配层完成：

| pi 事件 | 现有语义 | 映射注意点 |
|---|---|---|
| `message_update` | SSE `text` | 只转发文本 delta；必须累计当前文本段 |
| `tool_execution_start` | SSE `tool_use` | 必须输出旧格式 `{id,name,input}`，且只能使用完整、已校验参数 |
| `tool_execution_end` | SSE `tool_result` | 转成 `{id,name,result}`；工具异常也要保持前端可渲染 |
| `message_end/turn_end` | 内部 `tool_exchange` | 需要等待 assistant tool call 和全部 tool results 配对完成后立即落库 |
| `agent_end` | 候选 `done` | 不能直接映射；必须先完成消息、指标、标题等业务持久化 |
| 无对应关系 | SSE `session` | 这是请求进入后、agent 启动前产生的应用事件 |
| 无法由已知事实确认 | SSE `error` | 需要统一处理 provider、tool、取消和内部异常 |

关键语义差异：

- `session` 在 agent 启动前立即发送，确保首轮 issue 草稿出现时前端已经拿到真实 session ID，见 [app/main.py](/home/my-agent/app/main.py:393)。
- 当前 `tool_use` 是工具即将执行时发出，`tool_result` 是执行完成后发出，见 [app/agent.py](/home/my-agent/app/agent.py:277)。
- 每次完整工具交换都会立即把 assistant 的 `tool_use` 和 user 的 `tool_result` 成对落库，避免后续断线丢失，见 [app/main.py](/home/my-agent/app/main.py:459)。
- `done` 不只是结束信号，还包含 `session_id/text/message_id/budget_exhausted`，见 [app/main.py](/home/my-agent/app/main.py:504)。
- 错误拒绝的标准序列是 `error → done → end`，而设计列出的冻结事件甚至漏掉了实际存在的 `end`，见 [app/main.py](/home/my-agent/app/main.py:265)。
- 客户端断开时，已完成工具交换仍保留，尚未落库的文本则追加“连接已中断”，见 [app/main.py](/home/my-agent/app/main.py:514)。

因此不能把 `agent_end` 简单改名为 `done`，也不能把 `message_end` 都写入数据库，否则会改变断线恢复、反馈 message ID 和 issue 草稿对账语义。

#### 翻车风险：SQLite schema 相同，但消息格式不同

`messages.content` 存的是旧 Anthropic 风格内容块：

- assistant：`tool_use`
- user：`tool_result`
- 普通文本直接存字符串
- 列表才 JSON 编码

编码和解码见 [app/database.py](/home/my-agent/app/database.py:610) 与 [app/database.py](/home/my-agent/app/database.py:627)。

pi 的内部消息不能直接写入该列。否则：

- 旧前端无法渲染历史工具调用；
- `_prepare_model_messages()` 无法识别工具 relay；
- issue 草稿的 `draft_tool_use_id` 对账失效；
- `_verify_draft_repo_id()` 无法从历史 `tool_result` 找到盖章仓库。

建议冻结三个独立 DTO：

- `LegacyStoredMessage`：数据库和旧前端格式；
- `PiAgentMessage`：只存在于引擎适配层；
- `LegacySseEvent`：完整冻结事件名、payload、顺序和失败序列。

还要移植现有启动迁移、`WAL/busy_timeout/foreign_keys` PRAGMA，而不是只复制 `CREATE TABLE`，见 [app/database.py](/home/my-agent/app/database.py:13)。

---

### 2）Node + pi-agent-core、每会话一个 Agent

结论：Node/pi 可以成立，但“每会话常驻一个 Agent，并在实例中保存授权”不成立，应改成每个活跃 turn 一个 Agent。

#### 翻车风险：权限和仓库范围不是会话级稳定状态

当前每个请求都会重新：

1. 从数据库读取用户可见仓库；
2. 根据本次 `repo_id` 缩小范围；
3. 计算 `allowed_repo_paths`；
4. 计算同步失败仓库；
5. 决定本轮 `active_repo`；
6. 将这些值放入当前异步上下文。

见 [app/main.py](/home/my-agent/app/main.py:425) 和 [app/agent.py](/home/my-agent/app/agent.py:140)。

因此以下状态都可能在同一个 session 的不同 turn 之间变化：

- 管理员撤销或授予权限；
- 用户切换 workspace；
- 仓库重新克隆后 `local_path` 改变；
- active skills 改变；
- 未来的租户/仓库模型路由改变；
- 管理员访问普通用户的 session。

如果 allowed paths 缓存在 Agent 实例里，权限撤销不会立即生效，这是安全问题而非普通缓存一致性问题。

建议：每次请求都创建 immutable `TurnContext`，工具闭包只捕获本轮上下文。Agent 实例在 SSE turn 结束、取消或超时后销毁。若为了性能缓存 Agent，缓存也必须：

- 有 TTL 和最大容量；
- 每轮覆盖 messages/tools/model/system prompt；
- 每轮重新计算授权；
- 不能作为任何权限真相源；
- 允许随时丢弃并从 SQLite 重建。

#### 翻车风险：会话数量和历史导致内存无界增长

当前连轻量的 `_session_locks` 都只有在删除 session 时才清理，代码明确说明否则会终身增长，见 [app/main.py](/home/my-agent/app/main.py:585)。

Agent 实例比 Lock 重得多，还可能持有：

- 全量消息历史；
- base64 截图；
- 工具定义与闭包；
- event subscribers；
- partial streaming message；
- AbortController/定时器；
- provider/session cache 状态。

“数据库一份历史 + Agent 内存一份历史”会随 session 数和图片数量双重增长。常驻实例必须有明确 dispose、LRU/TTL、断线清理和内存基线压测，否则必然成为泄漏源。

#### 翻车风险：多副本下状态分叉

现有 `_session_locks` 只是进程内 `asyncio.Lock`，见 [app/main.py](/home/my-agent/app/main.py:254)。它已经不能阻止两个 Python worker/副本同时处理同一 session。

每会话 Agent 会进一步引入：

- 请求 A 到副本 1、请求 B 到副本 2，各自持有不同历史；
- 重启或故障转移丢失 Agent 状态；
- sticky session 失效时状态分叉；
- 同一 session 在两个副本并行写入交错 turn。

应采用：

- SQLite 为唯一消息真相源；
- 每轮开始重新加载历史；
- 单副本部署，或引入跨副本 session lease/分布式锁；
- 若明确要水平扩容，SQLite 也应进入迁移到 PostgreSQL 的路线，而不是把数据库文件放到普通共享网络卷上。

---

### 3）防腐层、锁版本、MIT fork 兜底

结论：必要，但“薄接口”应升级为行为防腐层，不能只是换几个类型名。

建议自有接口至少拥有：

- `runTurn(context): AsyncIterable<DomainAgentEvent>`
- `DomainMessage` 与 legacy/pi 双向转换
- `TurnContext`
- `ToolExecutor`
- `ModelRouter`
- `HistoryPolicy`
- `BudgetPolicy`
- `UsageMetrics`
- `AbortReason`

pi 的 `AgentEvent`、`AgentToolResult`、message content 类型不应穿透到 Fastify route、数据库层和业务工具。

版本锁定还应覆盖完整 lockfile和 Node 运行时版本。MIT fork 只解决“法律上可以改”，并不自动解决维护稳定性；一旦 fork，就要自己承担 provider 兼容、安全修复和上游合并成本。

建议把以下契约测试作为升级门：

- SSE golden trace；
- persisted-message golden test；
- 多工具调用顺序；
- 工具异常与 schema 校验失败；
- provider 断流；
- 浏览器主动取消；
- budget exhaustion；
- history windowing；
- 旧数据库回放；
- prompt-cache 命中指标。

---

### 4）工具 1:1 移植为 AgentTool

结论：可做，但清单并非真正的 1:1，且错误、并发和取消语义容易漂移。

#### 工具清单不完整或改变了现有暴露面

设计遗漏了模型实际使用的：

- `calculator`：coder 和 issue_agent 都引用；
- `list_directory`：issue_agent 引用。

见 [app/skills/coder.py](/home/my-agent/app/skills/coder.py:23) 和 [app/skills/issue_agent.py](/home/my-agent/app/skills/issue_agent.py:63)。

相反，`search_repo_issues` 和 `get_repo_labels` 当前并不是注册给模型的 `@tool`；它们是业务 helper/API 后端逻辑。把它们改成 AgentTool 会扩大模型能力，不属于 1:1 移植。

#### 工具失败语义不同

当前 registry 捕获所有异常并返回 JSON 字符串，工具 loop 仍将其作为普通 `tool_result` 交给模型，见 [app/tools/registry.py](/home/my-agent/app/tools/registry.py:83)。

已知 pi 语义是 AgentTool 抛错即该工具调用失败。两者对：

- LLM 看到的内容；
- SSE `tool_result` payload；
- `isError`；
- 重试行为；
- 指标

都可能不同。

建议在适配层明确区分：

- 预期业务错误：返回正常文本/结构化结果，保持旧行为；
- schema/编程错误：抛异常；
- 取消：传播 AbortSignal，不伪装成工具失败。

#### 并发顺序

当前一个 assistant message 中的多个工具调用严格顺序执行，见 [app/agent.py](/home/my-agent/app/agent.py:277)。pi 支持 sequential/parallel，因此所有初始移植工具应明确设为 `executionMode: "sequential"`，先保证事件顺序和副作用一致，再单独评估只读工具并行化。

#### 路径安全不能只移植一个 `startsWith`

当前关键约束包括：

- `realpath` 后做根目录边界判断，见 [app/tools/access.py](/home/my-agent/app/tools/access.py:28)；
- `file_reader` 屏蔽路径中任意 dotfile/dotdir，见 [app/tools/file_reader.py](/home/my-agent/app/tools/file_reader.py:21)；
- 最大文件 5 MB，见 [app/tools/file_reader.py](/home/my-agent/app/tools/file_reader.py:55)；
- `list_directory` 不跟随符号链接；
- ripgrep 固定字符串，grep 使用 `-F`，见 [app/tools/code_search.py](/home/my-agent/app/tools/code_search.py:24)；
- 搜索超时和取消时杀死子进程，见 [app/tools/code_search.py](/home/my-agent/app/tools/code_search.py:40)。

Node 端应通过每轮 capability context 注入，而不是从会话 Agent 的可变全局字段读取。

---

### 5）业务层 1:1 移植、history 与预算 checkpoint

结论：这是整个方案最难、最容易低估的部分。

#### history 外部注入：基本可做，但不能直接加载数据库行

已知 `agent.state.messages` 可直接赋值，因此“外部注入历史”在接口层面成立。

但当前 windowing 不是简单 `slice(-60)`。它会：

- 将历史图片替换成文本占位符；
- 找出最后一个普通 user message；
- 当前 turn 整体保留，即使超过窗口；
- 将过去 turn 的 tool bookkeeping 删除，只保留问题和 assistant 文本；
- 保证开头不是 assistant；
- 避免切断 `tool_use/tool_result`。

完整逻辑见 [app/main.py](/home/my-agent/app/main.py:277)。

因此建议流程必须是：

```text
SQLite legacy rows
→ legacy decoder
→ 当前 _prepare_model_messages 等价实现
→ legacy-to-pi message translator
→ agent.state.messages
```

不能先转换为 pi messages 再按条数裁切，也不能直接把 SQLite rows 交给 Agent。

另外，常驻 Agent 会产生“双真相源”：pi state 已经追加了消息，数据库也在写；如果断线、工具失败或持久化失败，两者会分叉。每 turn 临时 Agent 可以彻底消除这个问题。

#### checkpoint：按现有已知扩展点，无法证明高级 Agent 能原样实现

当前 checkpoint 有三个精确语义：

1. 在某次完整工具结果后，把 midpoint/endgame 提示作为额外 user 文本附在 tool results 后；
2. 这些提示只发送给模型，不持久化；
3. 预算耗尽后追加 wrap-up prompt，强制再做一次无工具流式调用；
4. `tool_choice:none` 不兼容时回退，但仍不执行模型意外产生的工具调用；
5. 最终 `done.budget_exhausted=true`。

见 [app/agent.py](/home/my-agent/app/agent.py:311) 和 [app/agent.py](/home/my-agent/app/agent.py:331)。

给出的高级 Agent 扩展点中：

- `subscribe` 可以观察事件；
- `steer()`/`followUp()` 可以注入消息；
- `state.messages/tools` 可修改；
- `terminate:true` 可以跳过自动后续 LLM 调用。

但尚未核实以下关键保证：

- `turn_end` subscriber 是否在下一轮 LLM 请求前形成同步 barrier；
- subscriber 中修改 `state.messages` 的顺序是否稳定；
- 能否插入“紧随本批 toolResult、但不持久化”的模型专用消息；
- 能否在第 N 个 turn 后阻止 loop 自动进入下一轮；
- 能否对最后一次调用临时强制 `tools=[]` 或 `tool_choice:none`；
- `steer/followUp` 是否会形成额外独立 turn，而不是当前要求的 tool-result 尾部文本。

因此，基于目前已知事实：

- 高级 `Agent`：不能认定可以 1:1 实现。
- 低级 `agentLoop()`：它只是观察性 async generator，也不能仅凭“低级”二字认定可以在每个 turn 间可靠拦截。
- `terminate:true`：可以帮助在预算终点跳过自动后续调用，但解决不了中点提醒的精确插入；多工具批次还需要所有工具一致终止。
- 若 pi 没有已验证的 `beforeNextTurn/prepareNextTurn/shouldContinue` 一类扩展点：要么 fork/patch loop，要么继续用 pi-ai 实现自有 loop。

最实际的无 fork 近似方案是：

1. 工具包装层统计 turn；
2. 中点提示加入最后一个 tool result 的模型内容；
3. 达到预算时让所有工具返回 `terminate:true`；
4. Agent 结束后单独调用 pi-ai，tools 为空，执行 wrap-up。

但这不是严格 1:1：提示会混入工具结果语义，持久化过滤也更复杂。因此是否接受该近似必须由产品决定。

#### 其他业务风险

- JWT 验证每次都重新查数据库，以处理禁用用户和角色变更，见 [app/auth.py](/home/my-agent/app/auth.py:51)。
- issue 草稿将 active repo 盖章进 tool result，见 [app/tools/github_issue.py](/home/my-agent/app/tools/github_issue.py:121)。
- 提交时又从历史按 `draft_tool_use_id` 验证 repo，不能只信浏览器。
- SQLite 时间均为 Python `datetime.now().isoformat()` 字符串；Node 必须保持排序兼容格式。
- bcrypt hash 与 JWT HS256 claim 需要旧数据兼容测试。

---

### 6）Phase 0 go/no-go

结论：必要但不充分，应拆成 Phase 0A 和 0B。

Phase 0A：你列出的 pi-ai/provider 验证：

- streaming；
- 多工具和并行工具调用；
- prompt cache 是否真的产生 cache read，而不是仅接受参数；
- `tool_choice:none`；
- 长会话；
- provider 断流、超时、取消；
- usage/TTFT 数据完整性。

Phase 0B：必须在移植业务前验证 pi-agent-core 控制能力：

- 能否精确实现工具预算终止；
- 能否在 tool results 后插入非持久化 reminder；
- 能否执行独立无工具 wrap-up；
- 能否保持旧 SSE 顺序；
- 能否在每个 tool exchange 后形成持久化 barrier；
- Agent 取消后是否仍有后台工具或回调；
- 外部历史注入和 legacy/pi 双向转换。

如果 0A 通过、0B 不通过，不应立即“整案作废”；还有两个选择：

- pi-ai + 保留自研 loop；
- fork pi-agent-core，添加正式的 turn-boundary hooks。

---

## 2. 迁移排序建议

### Phase -1：行为冻结，关键路径

先为现有 Python 实现建立 characterization tests：

- SSE 事件序列和 payload golden files；
- 错误、断线、取消、预算耗尽；
- 数据库写入顺序；
- history windowing；
- issue 草稿/提交对账；
- 工具输出及路径安全。

这是所有后续阶段的验收基线。

### Phase 0A：provider spike，关键路径

执行现有 go/no-go provider 测试。不要接 Fastify、SQLite 或真实业务工具。

### Phase 0B：agent-core 控制面 spike，关键路径

用 fake tools 和固定响应专门验证：

- 事件适配；
- turn barrier；
- checkpoint；
- wrap-up；
- 取消；
- messages 注入。

预算机制应在这里解决，不能留到工具全部移植之后。

### Phase 1：建立防腐层和 legacy codec，关键路径

实现：

- legacy DB message ↔ domain message ↔ pi message；
- pi event → domain event → legacy SSE；
- history policy；
- fake provider 合约测试。

先不要使用生产数据库写入。

### Phase 2：数据库兼容层，关键路径

- better-sqlite3 读取现有数据库；
- 所有旧行回放测试；
- 写入临时数据库后由旧 Python 代码读取验证；
- PRAGMA、事务和迁移兼容；
- DB worker thread 延迟压测。

### Phase 3：Python 边缘层 + Node engine 的绞杀者阶段

建议先保留：

- FastAPI 路由/SSE；
- auth/admin/issue；
- SQLite 写入；
- Python 工具。

只把 LLM/agent engine 放入 Node 服务，通过内部协议返回 domain events。这样能先验证 pi 的真实收益，同时保留现有契约和业务稳定性。

### Phase 4：工具迁移，可并行

可分别推进：

- file/code search；
- ctags reader/builder；
- semantic index；
- issue draft工具；
- skill/system prompt。

每组都用 Python 输出作为 golden oracle。

### Phase 5：业务 API 与 Node edge

最后迁移 auth、admin、issue 提交、截图上传、repo scheduler 和完整 SSE route。此时才决定 Fastify/Hono；以当前 API 规模和稳定性目标，我更倾向 Fastify。

### Phase 6：shadow/canary/cutover

- 同一输入 Python/Node 双跑但仅一边产生副作用；
- 比较 SSE、工具选择、最终文本和数据库意图；
- 小流量 canary；
- 保留快速回切；
- 稳定后再停 Python。

---

## 3. 被忽略的风险与替代结构

### better-sqlite3 会阻塞事件循环

当前 `aiosqlite` 操作通过异步接口执行，并且同步工具统一用 `asyncio.to_thread()` 隔离，见 [app/tools/registry.py](/home/my-agent/app/tools/registry.py:99)。数据库连接还设置了 5 秒 busy timeout。

better-sqlite3 的每次查询、commit 以及等待 SQLite 锁都会阻塞 Node 主线程。正常单行查询可能很快，但以下情况会冻结所有 SSE：

- 等待写锁；
- admin 聚合查询；
- 大 session 历史解码；
- schema migration；
- checkpoint/backup；
- 磁盘抖动。

连接池不是根本解法：SQLite 仍然是单 writer，多连接反而可能增加锁争用。

建议：

- 通过一个 dedicated DB worker thread 暴露异步 RPC；
- 主线程不直接调用 better-sqlite3；
- prepared statements 和写事务集中管理；
- 大型 admin 查询放独立读 worker；
- 若明确要求多副本，长期改 PostgreSQL。

### 多副本不仅影响 Agent，也影响后台任务和侧车文件

当前这些锁和缓存全部是进程内的：

- session locks；
- repo sync locks；
- ctags cache；
- embedding cache；
- label cache。

周期同步与 issue tracking 也由应用 lifespan 启动。多副本会重复 clone/pull、建索引和轮询 issue。固定 `.tmp` 文件名还会发生跨副本写冲突。

需要 leader election/job queue，或将 scheduler 拆为单独 worker 服务。

### SSRF guard 不应机械 1:1 移植

当前实现只用 `socket.gethostbyname()` 检查一个 IPv4，并且 DNS 解析失败时放行，见 [app/repo_sync.py](/home/my-agent/app/repo_sync.py:71)。验证和真正 git 连接之间还存在 DNS rebinding 窗口。

v2 应增强为：

- 获取全部 A/AAAA 地址；
- 任一地址属于私网/保留范围即拒绝；
- DNS 失败默认拒绝；
- 限制重定向；
- 容器层 egress policy；
- 对 issue API 请求应用相同规则。

### “全量重写”本身与稳定性目标冲突

我的表态是：不建议直接全量重写。

pi 带来的主要价值是 provider 统一、标准 agent loop 和 TypeScript 生态；但当前系统真正复杂的部分是：

- SSE/断线持久化；
- legacy message format；
- permissions；
- issue workflow；
- history condensation；
- checkpoint；
- repo/index lifecycle。

这些恰好不是换 pi 就会自动消失的复杂度。全量重写会同时更换语言、框架、数据库驱动、loop、工具、后台任务和部署模型，稳定性风险叠加。

更好的结构是绞杀者模式：

```text
旧 Web
  → Python API/SSE/业务/DB（暂保留）
      → Node pi engine
      → Python tool service
```

等 pi engine 在真实流量下稳定，再逐层把工具和 HTTP edge 迁到 Node。若最终发现 pi-agent-core 无法承载 checkpoint，也可保留 Node/pi-ai + 自研 loop，而不推翻其他迁移成果。

---

## 4. semantic_search / ctags 侧车迁移的具体坑

### semantic `.npz`

当前文件不是普通 JSON，而是 `np.savez_compressed` 生成的 ZIP/NPY 容器：

- `vectors`：二维 `float32`；
- `meta_json`：NumPy Unicode scalar/array；
- 写入临时文件后 `os.replace`；
- 查询时按 mtime 缓存整个矩阵。

见 [app/tools/semantic_index.py](/home/my-agent/app/tools/semantic_index.py:293) 和 [app/tools/semantic_index.py](/home/my-agent/app/tools/semantic_index.py:326)。

Node 侧具体风险：

- npm NPY 库可能只支持数字数组，不支持 `meta_json` 的 NumPy Unicode dtype；
- 需要处理 ZIP deflate、NPY header、shape、endianness、C/Fortran order；
- JS `Number` 是 float64，而现实现是 float32 归一化与矩阵乘法，临界 top-k 排名可能变化；
- 纯 JS 余弦循环在大索引上会阻塞事件循环；
- 每个 Node 副本缓存完整矩阵会成倍占用内存；
- 固定 `.tmp` 文件名在多进程构建时会冲突；
- embedding 维度或模型变化必须使旧向量整体失效；
- 当前实现按 chunk hash 复用旧向量，不能退化成每次全量重建。

建议优先级：

1. 迁移早期保留 Python semantic sidecar 服务；
2. 若彻底 Node 化，改成版本化格式：`manifest.json + metadata.json + vectors.f32`；
3. manifest 包含格式版本、维度、embedding model、dtype、行数和校验和；
4. 余弦计算放 worker thread 或原生向量库；
5. 用固定语料比较 Python/Node top-k，允许分数微小误差，但要求排名阈值；
6. 升级期间支持同时读取旧 `.npz` 与新格式，再异步重建。

### ctags JSON

当前 `.tags.json` 实际是 JSON Lines，不是一个 JSON 数组；读取时逐行解析，并过滤 `_type != "tag"` 的伪记录，见 [app/tools/symbol_index.py](/home/my-agent/app/tools/symbol_index.py:116)。

还必须保留：

- Universal Ctags 参数；
- Java/JavaScript/TypeScript 范围；
- `.vue` 映射到 TypeScript；
- `--fields=+n`；
- 90 秒超时；
- temp + replace；
- `realpath(repo)+".tags.json"` 命名；
- mtime cache；
- exact match 优先、substring fallback。

见 [app/tools/symbol_index.py](/home/my-agent/app/tools/symbol_index.py:35)。

Node 端不要 `readFile + split + JSON.parse` 整个多 MB 文件；应 readline/stream 逐行解析。还需固定 Universal Ctags 版本，否则不同容器版本产生的 `kind/scope/scopeKind/path` 可能漂移，影响 `list_file_symbols` 的过滤结果。

---

## 5. 总体判断

一句话结论：设计“有条件成立”，但必须改为数据库真相源、每 turn 临时 Agent、先做 agent-core 控制面验证，并采用绞杀者迁移；按当前“每会话常驻 Agent + 全量一次重写”方案执行，稳定性目标站不住脚。

最大三个风险，按严重程度排序：

1. pi 的公开扩展点尚不能证明可精确实现 checkpoint、turn barrier 和无工具 wrap-up，可能最终仍要自研 loop 或 fork。
2. 每会话 Agent 持有授权和历史会造成权限陈旧、内存无界、多副本状态分叉。
3. legacy SSE/消息持久化语义远比事件名和 SQLite schema 复杂，直接映射极易破坏断线恢复、历史 windowing 和 issue 草稿对账。

Codex session ID: 019f5090-42c8-7930-94d9-793dd0a22d05
Resume in Codex: codex resume 019f5090-42c8-7930-94d9-793dd0a22d05
