# CodeAxis v2 Phase 3 — 纯 Node 服务实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v2/engine 从"库"变成"能跑的产品"：Node 单进程服务，登录 → 会话 → SSE 聊天 → 工具调用（最小工具面）→ 持久化，主链路端到端可用，前端 `web/` 原样接上。

**Architecture:** 单包 `v2/engine` 内新增 `src/config.ts`、`src/db/schema.ts`（**DDL 所有权正式移交 Node**——Python 已删除）、`src/auth.ts`、`src/tools/`（registry + calculator）、`src/engine/turn.ts`（每 turn 临时 pi Agent 的组装器：history-policy → codec → Agent → event-adapter → 持久化钩子）、`src/server/`（Hono 路由 + SSE + 静态前端）。行为规格 = git tag `v1-python-final` 的 Python 源码与 22 个 characterization 测试——**实现语义一律 `git show v1-python-final:<path>` 查阅移植，禁止凭记忆再造**。

**Tech Stack:** Hono + @hono/node-server（HTTP/SSE/静态，`--save-exact`）、jsonwebtoken（HS256）、bcryptjs（纯 JS，免原生构建）、dotenv。既有：pi-agent-core 0.80.6、better-sqlite3 12.11.1、vitest。测试全离线（复用 `test/mock-anthropic.ts`）。

## Global Constraints

（承 Phase 1/2 全部有效约束：三层 DTO 隔离——pi 类型仅限 codec-pi/event-adapter/**engine/turn.ts**（新增豁免，Agent 组装处）；精确版本锁定；时间戳一律 `pyLocalIsoNow`；DB 行编码经 storage.ts。新增：）

- **Python 已从工作区删除**；语义规格 = tag `v1-python-final`。移植类任务的 brief 必须给出精确 tag 路径。
- **Node 拥有 DDL**：`schema.ts` 的 `initSchema` 为全部 11 张表 + 6 个索引建表（DDL 逐字移植自 `v1-python-final:app/database.py::init_db`，含历史迁移列的最终形态——无存量库，不需要迁移重放）；幂等（CREATE TABLE IF NOT EXISTS）；`storage.ts::checkSchema` 保留为启动兜底。
- **SSE 契约冻结**（oracle = `v1-python-final:tests/test_sse_contract.py`）：事件全集 `session/text/tool_use/tool_result/done/error/end`；`session` 永远第一个（`{session_id, reason: "new"|"existing"|...}`）；拒绝序列固定 `error→done→end` 且 done.session_id 为 null；`done` 携带 `{session_id, text, message_id, budget_exhausted}`；`end` 永远最后；断连时已完成 tool_exchange 已落库、未完成文本追加 `_（回复未完成：连接已中断）_`。
- **预算语义**（oracle = `v1-python-final:tests/test_agent_budget.py` + `app/agent.py::_budget_reminder/_WRAPUP_PROMPT`）：reminder 文本、midpoint/endgame 触发条件（`max>=6 && next==max//2`；endgame remaining 1..3）、wrap-up 单独一次无工具调用、`budget_exhausted:true`——全部逐字/逐条件移植。wrap-up 的"无工具"机制采用 **tools 整体省略**（0A S5 + Phase-1 E2 双验证；legacy 的 tool_choice 回退重试路径随 Python 退役，不移植）。
- **每 turn 临时 Agent**：turn 结束即弃，任何模块不得跨 turn 缓存 Agent/授权状态；SQLite 是唯一真相源。
- 环境变量名沿用 v1（`ANTHROPIC_API_KEY/BASE_URL/MODEL/MAX_TOKENS`、`APP_*`——完整清单见 `v1-python-final:app/config.py` 与 `.env.example`）；`.jwt_secret` 文件机制照旧（缺失则生成）；默认 admin/admin123 启动时 stdout 大声警告。
- 工具面本 Phase 只做 `calculator`（结构验证 registry 可扩展性）；file/code/symbol/semantic/issue 工具是 Phase 4。

## File Structure

```
v2/engine/src/
  config.ts              # dotenv + 类型化 settings（v1 config.py 移植，同名环境变量）
  auth.ts                # bcryptjs + jsonwebtoken HS256 + .jwt_secret 加载/生成
  db/schema.ts           # initSchema(dbPath)——11 表 + 6 索引，幂等
  tools/registry.ts      # ToolDef {name, description, schema(typebox), execute} → pi AgentTool 映射
  tools/calculator.ts    # v1-python-final:app/tools/calculator.py 语义移植
  engine/turn.ts         # runTurn(deps, req): AsyncGenerator<DomainEvent> —— Agent 组装 + budget + wrap-up
  server/app.ts          # buildApp(deps): Hono —— 全部路由，可注入测试替身
  server/main.ts         # 进程入口：config → initSchema → admin bootstrap → serve
  server/sse.ts          # chat_event_stream 移植（domain events → SSE 帧 + 持久化编排）
v2/engine/test/
  schema.test.ts  auth.test.ts  tools.test.ts  turn-engine.test.ts  sse-route.test.ts  e2e-smoke.test.ts
```

---

### Task 1: config + schema —— 配置层与 DDL 所有权移交

**Files:** Create `src/config.ts`、`src/db/schema.ts`；Test `test/schema.test.ts`（config 的断言并入）
**Interfaces:**
- Produces: `loadSettings(env?): Settings`（字段名/默认值逐项对照 `v1-python-final:app/config.py` 的 `Settings`，含 `maxToolIterations=30`、`maxHistoryMessages=60`、`maxTokens=4096`、`systemPrompt` 默认原文、`adminUsername/adminPassword`、`jwtSecret`（`loadOrCreateJwtSecret(repoRoot)`）、`tokenExpireHours=24`、`corsOrigins`）；`initSchema(dbPath): void`。
- 步骤：failing test（fresh tmp db → `initSchema` → `openStorage` 的 `checkSchema` 不抛 + `PRAGMA table_info` 抽查 `issue_submissions.track_status`/`users.my_issues_seen_at` 等迁移列已在基础 DDL；重复 `initSchema` 幂等；`loadSettings` 环境变量覆盖默认值、`ANTHROPIC_MAX_TOKENS="8192"` 转 number）→ 实现 → 绿 → commit `feat(v2): config layer + schema DDL ownership — node owns the database now`。

### Task 2: auth —— 登录/JWT/admin bootstrap

**Files:** Create `src/auth.ts`；Test `test/auth.test.ts`
**Interfaces:**
- Produces: `hashPassword/verifyPassword`（bcryptjs）、`createToken(user, settings): string`（HS256，payload `{user_id, username, role, exp}` 对照 `v1-python-final:app/auth.py`）、`decodeToken(token, settings)`（过期/非法 → 抛类型化 `AuthError(401)`）、`ensureAdminUser(storage-ish, settings)`（不存在则建，默认密码时 console 大声警告——文案对照 v1 main.py startup）。
- 依赖安装：`npm i --save-exact hono @hono/node-server jsonwebtoken bcryptjs dotenv` + `-D --save-exact @types/jsonwebtoken @types/bcryptjs`（版本记录进 report）。DB 侧需要最小 users 读写——直接用 better-sqlite3 于 `auth.ts` 内？**不**：加到 `src/db/storage.ts` 新方法 `getUserByUsername/createUser`（与 v1 database.py 同语义，时间戳 `pyLocalIsoNow`），worker/client 同步补方法（三处签名一致）。
- 步骤：TDD（round-trip hash/verify、token 过期 fake timer、bootstrap 幂等 + 警告断言）→ 实现 → 绿 → commit `feat(v2): auth — bcryptjs/HS256/jwt-secret file, admin bootstrap with loud default-creds warning`。

### Task 3: tools registry + calculator

**Files:** Create `src/tools/registry.ts`、`src/tools/calculator.ts`；Test `test/tools.test.ts`
**Interfaces:**
- Produces: `type ToolDef = { name; description; schema: TSchema; execute(input, ctx): Promise<string> }`；`registerTool(def)` / `listTools(): ToolDef[]` / `toPiTools(defs, ctx): AgentTool[]`（typebox schema 直接喂 pi——0A S2 已验证 pi 用 typebox 校验入参；执行结果统一字符串，异常 → 返回错误文本而非抛出，对照 v1 registry 的容错语义 `v1-python-final:app/tools/registry.py`）。calculator 语义对照 `v1-python-final:app/tools/calculator.py`（安全求值：仅数字/运算符白名单，**不得**用 eval/Function——用递归下降或 expr 解析白名单实现，brief 给完整实现）。
- 步骤：TDD（注册/枚举/pi 映射形状；calculator：`1+1=2`、`2*(3+4)=14`、除零与非法字符返回错误文本不抛）→ 实现 → 绿 → commit `feat(v2): tool registry + calculator — typebox schemas straight into pi, errors as text not throws`。

### Task 4: turn engine —— runTurn 组装器（本 Phase 的心脏）

**Files:** Create `src/engine/turn.ts`；Test `test/turn-engine.test.ts`
**Interfaces:**
- Consumes: 全部前置层 + `test/agent-harness.ts` 的组装模式（wrapped streamFn、convertToLlm、sequential——把 harness 的组装逻辑**提升为生产代码**于 turn.ts，harness 改薄）。
- Produces: `runTurn(deps: { db: DbClient; settings: Settings; tools: ToolDef[] }, req: { sessionId: string; history: LegacyMsg[]; userText: string }): AsyncGenerator<DomainEvent>`。
- 语义清单（每条 = 一个测试，mock-anthropic 离线驱动）：
  1. 纯文本回合：`text_delta* → llm_metrics → done{success:true}`（Phase-1 golden 复用）。
  2. 工具回合：`… tool_use → tool_result → tool_exchange → … done`；`tool_exchange` 事件产出时**即刻**可供上层持久化（顺序断言）。
  3. **budget midpoint**：`maxToolIterations=8` 时第 5 次 LLM 调用的请求体含 reminder 原文（`git show v1-python-final:app/agent.py` 提取 `_budget_reminder` 逐字；transformContext 注入，`mock.requests[i].body` 断言存在、且 agent state 干净——不持久化）。
  4. **budget 耗尽 + wrap-up**：达 8 次后 `afterToolCall` terminate；随后单独 `models.streamSimple` 发 wrap-up（`_WRAPUP_PROMPT` 逐字，请求体**无 tools 字段**）；`done.budget_exhausted === true`，wrap-up 文本经 `text_delta` 流出。
  5. LLM 错误：`error → done{success:false}`（errorMessage 检查模式照 harness）。
  6. 每 turn 新 Agent：连续两次 runTurn，第二次的 `initialState.messages` 仅来自入参 history（mock 请求体断言无第一 turn 残留）。
- 步骤：TDD 逐条 → 实现（~200 行）→ 绿 + typecheck → commit `feat(v2): turn engine — per-turn ephemeral agent, budget checkpoints faithful to v1 semantics`。

### Task 5: SSE 路由 + 会话 API + 静态前端

**Files:** Create `src/server/sse.ts`、`src/server/app.ts`；Test `test/sse-route.test.ts`
**Interfaces:**
- Produces: `buildApp(deps: { db; settings; engine: RunTurnFn }): Hono`——路由：`POST /api/auth/login`、`GET /api/auth/me`、`GET /api/config`、`GET /api/skills`（本 Phase 返回空数组占位——v1 的 coder/issue_agent 随 Phase 4 工具面回归）、`GET /api/repos`（granted repos，空库返回 `[]`）、`GET|DELETE /api/sessions*`、`POST /api/chat`（SSE）、静态 `web/`（`/` 与 `/login`）。engine 以依赖注入进来——SSE 测试用 stub engine，不碰网络。
- SSE 编排移植（oracle 四场景 = `v1-python-final:tests/test_sse_contract.py`，全部移植为 Node 测试）：
  1. 超长消息拒绝：`error→done→end`，done.session_id null（`MAX_MESSAGE_LENGTH` 取 v1 main.py 原值）。
  2. 正常回合：`session(reason:"new") → text → done → end`；done 带 message_id/budget_exhausted；落库 user+assistant 两行。
  3. tool_exchange 即刻持久化：engine 中途抛错，已产出的 exchange 两行仍在库中（`session→error→done→end`）。
  4. 断连：client abort 后部分文本落库并追加 `_（回复未完成：连接已中断）_`。
  另：resolved 会话来消息 → 透明新建（`reason` 字段照 v1）；`llm_metrics` 事件批量收集、turn 末 `recordLlmCallMetrics` 一次写入。
- 步骤：TDD 四场景 + 会话 CRUD + login 路由集成（真 auth）→ 实现 → 绿 → commit `feat(v2): SSE chat route + session api — v1 browser contract reproduced on hono`。

### Task 6: 进程入口 + 端到端冒烟 + 文档

**Files:** Create `src/server/main.ts`；Test `test/e2e-smoke.test.ts`；Modify `README.md`、根 `CLAUDE.md`（Running 段）、`package.json`（`"start": "tsx src/server/main.ts"`）
- e2e：vitest 内真启动（ephemeral port，`ANTHROPIC_BASE_URL` 指向 mock-anthropic，tmp db）→ `POST /api/auth/login`（admin bootstrap 生效）→ 建会话发消息 → 手工解析 SSE 流断言 `session→text→…→done→end` → `GET /api/sessions/{id}` 回放含两行 → 关停干净（db client close + server close，无悬挂句柄）。
- README/CLAUDE.md：Running 段改为真实启动命令（`npm start`）、`.env` 必填项、"Phase 4 前工具面只有 calculator"限制声明。
- commit `feat(v2): service entrypoint + e2e smoke — the product runs on node`。

---

## Self-Review 记录

- **Spec 覆盖**：主链路（auth→session→SSE→tool→持久化）Task 2/4/5 覆盖；DDL 移交 = Task 1；预算/wrap-up/SSE 契约/每-turn-临时-Agent 四大冻结语义分别钉在 Task 4/5 的逐条测试；静态前端 = Task 5；可运行性 = Task 6。admin/issue/feedback/code-viewer/repo-sync/语义索引 → Phase 4/5（YAGNI，前端对应页面在此期间报 404 属预期，e2e 不覆盖）。
- **占位符检查**：reminder/_WRAPUP_PROMPT/MAX_MESSAGE_LENGTH/警告文案等以 tag 精确路径指定提取（可寻址真源，非 TBD）；calculator 白名单实现、SSE 四场景断言、e2e 流程均有可判定标准。
- **类型一致性**：`Settings` Task 1 定义、2/4/5/6 消费；`ToolDef/toPiTools` Task 3 定义、4 消费；`runTurn` 签名 Task 4 定义、5 以 `RunTurnFn` 注入、6 以真实现装配；storage 新增 `getUserByUsername/createUser` 同步补到 worker/client 三处（Task 2 内完成，Task 5 login 路由消费 client 版）。
