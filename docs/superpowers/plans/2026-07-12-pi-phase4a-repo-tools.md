# CodeAxis v2 Phase 4a — 仓库权限、同步与本地代码工具

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让产品从"只会算算术"变成"能读你的仓库"：仓库 CRUD + 权限授予（admin API）、git 同步（clone/pull，含 SSRF 防护与凭证处理）、以及三个只读代码工具（file_reader / code_search+list_directory / find_symbol+list_file_symbols via ctags），全部接入聊天回合的按用户权限范围。

**Architecture:** v1 用 Python `ContextVar` 让工具函数从模块级全局状态"伸手拿"权限上下文（因为 `@tool` 装饰的函数不接收额外参数）。v2 的 `ToolDef.execute(input, ctx)` **本来就显式接收 ctx** ——不需要 AsyncLocalStorage 或任何全局状态搬运；`access.ts` 只是操作 `ctx` 参数的纯函数集合，是比 v1 更简单的移植（不是遗漏，是架构差异的自然简化，PR 描述里说明）。repo_sync 是独立的 git 子进程编排模块，不碰 HTTP 层；index 构建（ctags）由 repo_sync 在同步成功后触发，通过依赖注入的回调而非 v1 的运行时 `from ... import`（同样效果，无循环 import）。

**Tech Stack:** 复用已有 better-sqlite3/worker/client 三层、typebox 工具 schema、Hono。新增：`node:child_process` 的 `execFile`（git/ctags 子进程，替代 v1 的 `asyncio.create_subprocess_exec`）。`ripgrep`/`ctags` 仍是可选的 OS 级二进制，`which`（`node:child_process` 的 `execFileSync("which", ...)` 或者手写 PATH 探测，二选一，brief 给实现）探测存在与否，缺失时优雅降级（与 v1 完全一致的降级文案）。

## Global Constraints

（承 Phase 1-3 全部有效约束：pi 类型隔离——本 Phase 新增文件均不触碰 pi 类型；精确版本锁定；timestamps 仅用 pyLocalIsoNow；DDL 仅 schema.ts。新增：）

- **行为规格 = tag `v1-python-final`**：`app/tools/access.py`、`app/tools/file_reader.py`、`app/tools/code_search.py`、`app/tools/symbol_index.py`、`app/repo_sync.py`、`app/admin.py`（仓库/权限/用户 CRUD 部分）、`app/main.py`（`_get_visible_repos`、聊天路由里 allowed_repo_paths/unsynced_repo_names/active_repo 的解析块）。逐条对照，禁止凭记忆重写。
- **deny-by-default**：`getAllowedPaths` 只信任显式传入的 ctx，没有 ctx / 没有权限 = 空数组，工具据此拒绝，不做"没设置就放行"的兜底。
- **路径安全三件套**：`isWithinAllowedPaths`（realpath 前缀匹配，不可用字符串包含）、dotfile/dotdir 一律拒绝、符号链接目录遍历时不跟随（防止仓库内提交的符号链接逃逸沙箱）。
- **SSRF 防护**：clone/pull 的 URL 只接受 `https/http/git` 协议前缀，host 解析后拒绝 loopback/private/link-local/reserved 地址。
- **凭证处理**：clone/pull 通过一次性 `-c http.extraheader` 传递 Basic Auth，**绝不**写入远程 URL 持久化到 `.git/config`；错误信息与 URL 展示前统一走 `maskUrlCredentials`/`redactCredentials`（正则 `://[^/@\s]+@` → `://***@` 或 `://`）。
- **索引 sidecar 隔离**：ctags 索引文件位于仓库目录**之外**（`<local_path>.tags.json`），clone 的 rmtree+rename 舞步永远碰不到它；写入用 temp-file + rename 保证读者不会看到半写文件。
- **每仓库锁**：同一 repo_id 的 clone/pull/index-build 不可并发交叉——用一个 `Map<number, Promise>` 队列化模拟 v1 的 `asyncio.Lock`。
- 工具错误一律返回 `"Error: ..."` 文本（现有 `ToolDef.execute` 约定），不抛出。

## File Structure

```
v2/engine/src/
  tools/access.ts          # ToolContext 扩展 + 纯函数（getAllowedPaths/isWithinAllowedPaths/noAccessReason/getToolUserId）
  tools/file-reader.ts      # file_reader 工具
  tools/code-search.ts      # code_search + list_directory 工具
  tools/symbol-index.ts     # ctags 索引：buildIndex + find_symbol/list_file_symbols 工具
  repo-sync.ts              # clone/pull/sync_and_persist/syncAllRepos/periodicSyncLoop
  server/admin-routes.ts    # /api/admin/{users,repos,permissions} CRUD，admin-only
v2/engine/test/
  access.test.ts  file-reader.test.ts  code-search.test.ts  symbol-index.test.ts
  repo-sync.test.ts  admin-routes.test.ts  chat-tools-integration.test.ts
```

---

### Task 1: DB 层扩展 —— repos/permissions CRUD + users 补全方法

**Files:** Modify `src/db/storage.ts`、`src/db/worker.ts`、`src/db/client.ts`；Test `test/db-storage.test.ts`（追加）

**Interfaces:**
- Consumes: 现有 `Storage`/`DbClient`（`listRepos`/`listReposForUser`/`getUserByUsername`/`createUser` 已存在）。
- Produces（三层同步新增，语义对照 `v1-python-final:app/database.py` 对应函数）：

```typescript
// storage.ts / client.ts（client 版全 Promise）
getUserById(userId: number): UserRow | null;
listUsers(): Omit<UserRow, "password_hash">[];
updateUserPassword(userId: number, passwordHash: string): void;
setUserActive(userId: number, active: boolean): void;
deleteUser(userId: number): void;

getRepo(repoId: number): RepoRow | null;   // 不带 access_level（admin 视角）
createRepo(fields: { name: string; url: string; description?: string; branch?: string | null;
  credUsername?: string | null; credToken?: string | null }): number;
updateRepo(repoId: number, fields: Partial<{ name: string; url: string; description: string;
  localPath: string; branch: string | null; credUsername: string | null; credToken: string | null;
  lastSyncAt: string; lastSyncStatus: string; lastSyncMessage: string; indexStatus: string;
  lastSyncSha: string | null }>): void;   // 只更新传入字段，语义对照 update_repo 的动态 SET
deleteRepo(repoId: number): void;          // 级联删 permissions 再删 repositories（两条 DELETE，对照 v1）

grantPermission(userId: number, repoId: number, accessLevel: string): number;  // UPSERT
revokePermission(userId: number, repoId: number): void;
listPermissions(): Array<{ id: number; user_id: number; username: string; repo_id: number;
  repo_name: string; access_level: string; created_at: string }>;
getUserRepos(userId: number): RepoRow[];   // 与 listReposForUser 同查询，暴露独立命名对照 v1 get_user_repos
```

- [ ] **Step 1: 写失败测试**（每个新方法一条：users 的 create→getById→list→updatePassword→setActive→delete 全链路；repos 的 create→get→update(动态字段)→list 含新字段→delete 级联清 permissions；permissions 的 grant→list(JOIN 出 username/repo_name)→revoke；grant 对不存在的 user/repo 应由调用方（Task 7 路由层）404，DB 层本身允许写入后由 FK 约束报错——测试 FK 约束确实生效）
- [ ] **Step 2: 跑测失败** → **Step 3: 三层实现**（`checkSchema` 已覆盖 repositories/permissions/users 全列，本任务只加查询/写入方法，不碰 schema）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): repo/permission/user CRUD across storage/worker/client — admin API groundwork"
```

---

### Task 2: access.ts —— ToolContext 扩展 + 权限边界纯函数

**Files:** Modify `src/tools/registry.ts`（`ToolContext` 类型）；Create `src/tools/access.ts`；Test `test/access.test.ts`

**Interfaces:**
- Produces：

```typescript
// registry.ts 内 ToolContext 类型替换占位注释为真实形状：
export type ToolContext = {
  allowedRepoPaths: string[];      // 已 realpath 过的仓库根目录列表
  unsyncedRepoNames: string[];     // 有权限但 local_path 为空（从未同步成功）的仓库名
  userId: number | null;
};

// access.ts
export function getAllowedPaths(ctx: ToolContext): string[];   // 对 ctx.allowedRepoPaths 逐个 realpath（防止调用方传入未规范化路径）
export function getToolUserId(ctx: ToolContext): number | null;
export function isWithinAllowedPaths(realPath: string, allowedPaths: string[]): boolean;
export function noAccessReason(ctx: ToolContext, prefix?: string): string;  // 默认 prefix="Access denied"
```

移植对照 `v1-python-final:app/tools/access.py` 逐函数：`is_within_allowed_paths` 用 `realPath.startsWith(allowed + path.sep) || realPath === allowed`；`no_access_reason` 区分"有未同步仓库"（列出名字 + 提示联系 admin）vs"完全没有权限"两条文案，**逐字节移植中文/英文提示原文**。

- [ ] **Step 1: 写失败测试**（`isWithinAllowedPaths`：嵌套路径 true、同级前缀但非子目录 false（如 `/repos/foo-bar` 不属于 `/repos/foo`）、恰好等于 root true；`noAccessReason`：unsynced 非空时文案含仓库名列表，空时另一条文案，逐字节比对 v1 原文；`getAllowedPaths` 对未 realpath 化的输入做规范化）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（~40 行）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): access boundary helpers — ToolContext replaces v1's ContextVar, explicit param not ambient state"
```

---

### Task 3: repo-sync.ts —— git clone/pull + SSRF 防护 + 凭证处理

**Files:** Create `src/repo-sync.ts`；Test `test/repo-sync.test.ts`
**Interfaces:**
- Consumes: `src/config.ts`（`settings.reposDir`）、`src/db/client.ts`（`updateRepo`——`sync_and_persist` 用它持久化结果）。
- Produces：

```typescript
export function maskUrlCredentials(url: string): string;         // ://user:pass@ -> ://
export function getRepoLocalPath(reposDir: string, repoId: number): string;
export async function cloneRepo(opts: { url: string; repoId: number; reposDir: string;
  branch?: string | null; credUsername?: string | null; credToken?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function pullRepo(opts: { repoId: number; reposDir: string;
  credUsername?: string | null; credToken?: string | null }): Promise<{ ok: boolean; message: string }>;
export async function syncRepo(opts: { url: string; repoId: number; reposDir: string; branch?: string | null;
  forceReclone?: boolean; credUsername?: string | null; credToken?: string | null }): Promise<{ ok: boolean; message: string; localPath: string }>;
export async function syncAndPersist(
  db: DbClient, opts: { repoId: number; url: string; reposDir: string; branch?: string | null;
    forceReclone?: boolean; credUsername?: string | null; credToken?: string | null },
  onSyncSuccess?: (repoId: number, localPath: string) => void,  // 索引构建挂钩，Task 6 传入；不传则跳过（对照 v1 的动态 import，同效果）
): Promise<{ ok: boolean; message: string }>;
```

`onSyncSuccess` 是 fire-and-forget（不 await，对照 v1 `asyncio.create_task`），调用方（Task 6）内部自己排队到仓库锁。

- [ ] **Step 1: 写失败测试**（用真实 `git` 子进程操作本地临时目录当"远程"——`git init --bare` 一个 tmp repo 当 origin，`cloneRepo` 指向它验证真实 clone 成功；`maskUrlCredentials` 三种形态（`user:pass@`/`token@`/无凭证）；`_validate_url` 等价逻辑：`http://127.0.0.1/x`、`http://169.254.169.254/`（云元数据地址）、`http://localhost/x` 全部拒绝且不发起任何网络请求（用一个从不应被调用的 git mock 断言）；`ftp://...` 协议拒绝；正常 `https://` host 校验通过后走真实 clone 路径；`syncRepo` 的 pull-fails-then-reclone 自愈；`syncAndPersist` 成功后 `updateRepo` 被调用且携带 `last_sync_sha`（真实 `git rev-parse` 输出）、失败时 `last_sync_status="error"`；同一 repoId 两个并发 `syncAndPersist` 调用序列化（用一个人为延迟的 clone 验证第二个等待第一个完成，而非并发 rmtree）)
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（`execFile("git", args, {timeout: 120_000})` 包一层 promise；per-repo 锁用 `Map<number, Promise<void>>` 链式排队；SSRF 检查用 `node:dns/promises` 的 `lookup` + `node:net` 的 `isIP`/私有段判断，逻辑对照 `ipaddress.is_loopback/is_private/is_link_local/is_reserved`——Node 无内建等价，brief 给出手写 CIDR 判断表 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8、169.254.0.0/16 + IPv6 的 `::1`/`fc00::/7`/`fe80::/10`）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): repo-sync — git clone/pull, SSRF guard, credential header not persisted"
```

---

### Task 4: file-reader.ts 工具

**Files:** Create `src/tools/file-reader.ts`；Test `test/file-reader.test.ts`
**Interfaces:**
- Consumes: `access.ts`（`getAllowedPaths`/`isWithinAllowedPaths`/`noAccessReason`）。
- Produces: `resolvePath(path: string, allowedPaths: string[]): string`（导出，Task 6 的 `list_file_symbols` 复用同一相对路径解析——对照 v1 `file_reader._resolve_path` 被 `symbol_index.py` 直接 import 复用）；工具本体 `fileReaderTool: ToolDef`（`registerTool` 副作用注册，风格照 `calculator.ts`）。

移植对照 `v1-python-final:app/tools/file_reader.py` 逐条：绝对路径直接 realpath；相对路径尝试每个 allowed root 拼接、取第一个存在的；dotfile/dotdir 任一路径段拒绝；5MB 大小上限；`start_line`/`max_lines` 分页，超出文件末尾返回错误，截断时追加提示行。

- [ ] **Step 1: 写失败测试**（临时目录当 allowed root：正常读取、相对路径解析、dotfile 拒绝、越界路径拒绝、5MB+ 文件拒绝、start_line 超界报错、截断提示行格式、无权限时返回 `noAccessReason` 文案）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现** → **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): file_reader tool — dotfile-deny, 5MB cap, relative-path-against-allowed-roots"
```

---

### Task 5: code-search.ts —— code_search + list_directory 工具

**Files:** Create `src/tools/code-search.ts`；Test `test/code-search.test.ts`
**Interfaces:**
- Consumes: `access.ts`。
- Produces: `codeSearchTool`、`listDirectoryTool`（两个 `ToolDef`，同文件注册）。

移植对照 `v1-python-final:app/tools/code_search.py`：`rg`（`--fixed-strings --max-columns 300 --max-columns-preview`）存在则用，否则 fallback `grep -rn -F --exclude-dir=.* --exclude=.*`；15 秒超时子进程；**跨已授权仓库并发搜索**，凑够 `max_results` 后取消剩余任务（Node：`Promise.race`/`AbortController` 组合，用 `child_process` 的 `signal` 选项杀子进程）；`list_directory`：`.` 列出全部授权仓库根、显式路径需在授权范围内；跳过 `_SKIP_DIRS` 集合（`.git/node_modules/__pycache__/.venv/venv/dist/build/.next/.cache/target/.gradle/.idea/.vscode`）、dotfile、symlink（不跟随）；每层最多 15 目录 + 25 文件，超出显示"还有 N 个"。

- [ ] **Step 1: 写失败测试**（fixture 目录树：fixed-string 匹配（含正则特殊字符字面匹配）、file_pattern glob 过滤、max_results 截断、多仓库结果按仓库顺序拼接、超时场景（用一个故意慢的 mock 或 sleep 目标——若用真实 rg/grep 对超大目录不现实，用小的 15s 超时和一个人为阻塞脚本代替 rg/grep 二进制路径注入测试专用命令）；`list_directory`：`.` 列全部根、SKIP_DIRS 生效、symlink 不跟随、深度截断、条目数截断提示）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（rg 探测：`execFileSync("which", ["rg"])` 成功则用，`try/catch` 兜底 grep；两个工具共享 `_validateRepoPath`/`_buildTree` 私有辅助）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): code_search + list_directory — rg-or-grep fixed-string, concurrent multi-repo, symlink-safe tree walk"
```

---

### Task 6: symbol-index.ts —— ctags 索引 + find_symbol/list_file_symbols

**Files:** Create `src/tools/symbol-index.ts`；Modify `src/repo-sync.ts`（接入 `onSyncSuccess` 挂钩）；Test `test/symbol-index.test.ts`
**Interfaces:**
- Consumes: `access.ts`、`file-reader.ts` 的 `resolvePath`。
- Produces：

```typescript
export async function buildIndex(repoPath: string): Promise<boolean>;   // ctags 不存在/目录不存在 -> false，不抛
export const findSymbolTool: ToolDef;
export const listFileSymbolsTool: ToolDef;
```

移植对照 `v1-python-final:app/tools/symbol_index.py`：`ctags -R --languages=Java,JavaScript,TypeScript --langmap=TypeScript:+.vue --fields=+n --output-format=json -f <tmp> .`，90 秒超时，成功后 `rename` 到 `<realpath(repoPath)>.tags.json`（sidecar，仓库目录外）；进程内缓存按 `(index_path, mtime)` 失效；`_type !== "tag"` 的 ptag 伪记录过滤掉；`find_symbol` 精确匹配优先、否则子串匹配，跨全部 allowed repos；`list_file_symbols` 用 `resolvePath` 定位文件所属仓库根，过滤"函数内局部 const"噪音（`kind==="constant" && scope` 排除）、按行号排序。

Task 3 的 `repo-sync.ts` 改一行：`syncAndPersist` 的 `onSyncSuccess` 默认参数改为 `buildIndex`（模块级 import，不再是可选——两个模块本就在同一 Node 进程里，不像 v1 要担心 import 时机；仍保留 promise 不阻塞返回的语义，`onSyncSuccess` 内部自己 `void buildIndex(...)`）。

- [ ] **Step 1: 写失败测试**（真实 `ctags` 子进程（环境已装 universal-ctags，若无则测试自行探测跳过并在报告中说明）对一个含 `.ts`/`.java`/`.vue` fixture 的临时目录建索引；`find_symbol` 精确 vs 子串命中排序；`list_file_symbols` 过滤局部 const、按行排序；索引不存在时两个工具都返回"回退到 code_search/file_reader"的降级文案，逐字节对照 v1；mtime 缓存：重建索引后二次调用拿到新内容而非缓存陈旧值）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现** → **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): ctags symbol index — find_symbol/list_file_symbols, sidecar outside checkout, mtime-cached"
```

---

### Task 7: admin-routes.ts —— 用户/仓库/权限 CRUD API

**Files:** Create `src/server/admin-routes.ts`；Modify `src/server/app.ts`（挂载 + admin-only 中间件）；Test `test/admin-routes.test.ts`
**Interfaces:**
- Consumes: Task 1 的 DB 方法、Task 3 的 `syncAndPersist`、`src/auth.ts` 的 `hashPassword`。
- Produces: `mountAdminRoutes(app: Hono, deps: BuildAppDeps): void`（在 `app.ts` 内对 `/api/admin/*` 加一个 `role !== "admin" -> 403 {detail:...}` 中间件，然后挂载）。

路由对照 `v1-python-final:app/admin.py`（本任务范围：users + repos + permissions 三段，usage/feedback/issue-tracking/semantic-search-log 留给 Phase 5 的 admin 仪表盘）：
- `GET/POST /api/admin/users`、`PATCH/DELETE /api/admin/users/:id`（删除 admin 角色返回 403，对照 v1）
- `GET/POST /api/admin/repos`、`GET/PATCH/DELETE /api/admin/repos/:id`、`POST /api/admin/repos/:id/sync`
  - `_admin_repo_view` 逐字段移植：`cred_token` 永不回显（只给 `has_token: boolean`）、`url` 经 `maskUrlCredentials`、`credentials` 遗留列剔除。
  - `POST` 创建后**同步阻塞**触发首次 clone（对照 v1，`sync_and_persist` await）。
  - `PATCH` 仅当 url/branch/凭证任一变化时才触发 `forceReclone` 重同步，**先同步成功才落库新配置**（v1 的顺序：同步失败整个 PATCH 返回 502，DB 不变）；纯 cosmetic 字段（name/description）无条件立即更新。
- `GET/POST /api/admin/permissions`、`DELETE /api/admin/permissions/:userId/:repoId`（grant 对不存在的 user/repo 先 404）

- [ ] **Step 1: 写失败测试**（非 admin 全部 403；users 全 CRUD + 删 admin 403；repos：create 触发真实 sync（用临时 bare repo）、update 仅 cosmetic 字段不触发 sync、update url 触发 forceReclone 且失败时 502 且 DB 未变、`_admin_repo_view` 不回显 `cred_token`/剥离 `credentials`/URL 脱敏；permissions grant/list(JOIN 字段)/revoke，grant 对幽灵 user_id 404）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现** → **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): admin API — user/repo/permission CRUD, sync-then-persist ordering on repo edits"
```

---

### Task 8: 接入聊天回合 —— 真实 /api/repos + 按权限解析 ToolContext + 注册工具

**Files:** Modify `src/server/app.ts`（`GET /api/repos` 已存在但需确认 admin-bypass 语义）、`src/server/sse.ts`（每回合解析 ctx）、`src/engine/turn.ts`（`RunTurnDeps` 传入按回合 ctx 而非 `toPiTools(tools, {})` 硬编码空对象）；Test `test/chat-tools-integration.test.ts`
**Interfaces:**
- Consumes: 全部前置任务的工具 + `access.ts` 的 `ToolContext` 真实形状。
- Produces: `turn.ts` 的 `runTurn` 签名追加 `ctx: ToolContext` 到 `deps`（`RunTurnDeps = { db?: DbClient; settings: Settings; tools: ToolDef[]; ctx: ToolContext }`），内部 `toPiTools(tools, ctx)` 替换硬编码 `{}`。`sse.ts` 在每次 `runTurn` 调用前解析：

```typescript
// 对照 v1 main.py 聊天路由内联块（_get_visible_repos + allowed_repo_paths/unsynced_repo_names 组装）
async function resolveToolContext(db: DbClient, user: CurrentUser, repoId?: number): Promise<ToolContext> {
  const allRepos = user.role === "admin" ? await db.listRepos() : await db.listReposForUser(user.id);
  const granted = repoId ? allRepos.filter(r => r.id === repoId) : allRepos;
  return {
    allowedRepoPaths: granted.filter(r => r.local_path).map(r => r.local_path!),
    unsyncedRepoNames: granted.filter(r => !r.local_path).map(r => r.name),
    userId: user.id,
  };
}
```

- [ ] **Step 1: 写失败测试**（端到端：seed 一个 repo + grant 权限给非 admin 用户 + 该 repo 本地有真实文件 → 走真实 `/api/chat`（mock LLM 脚本一次 `file_reader` 工具调用）→ 断言工具执行时看到的是这个用户的 `allowedRepoPaths`，另一个无权限用户对同一路径的工具调用返回 `noAccessReason`；`repoId` 过滤单仓库场景；admin 不受权限表限制能看到全部仓库路径）
- [ ] **Step 2: 跑测失败** → **Step 3: 实现**（`sse.ts` 里 `resolveToolContext` 调用点插在现有"构建 messages"之后、调用 `runTurn` 之前；`app.ts` 的工具注册列表从"仅 calculator"扩展为 calculator + file_reader + code_search + list_directory + find_symbol + list_file_symbols，`import` 所有工具文件触发副作用注册）→ **Step 4: 跑测通过 + typecheck** → **Step 5: Commit**

```bash
git commit -m "feat(v2): wire per-turn ToolContext into runTurn — file/code/symbol tools live in chat"
```

---

## Self-Review 记录

- **Spec 覆盖**：主计划 Phase 4 行"file/code search、ctags"= Task 4/5/6；"仓库同步"= Task 3；主计划未列出但 Task 8 端到端必需的"权限如何进工具"= Task 2 架构简化 + Task 8 接线；admin 侧仓库/权限管理（工具能用的前提——没有仓库和权限，测试不了任何工具）= Task 1/7，属于本 Phase 隐含前置依赖，纳入范围。semantic_index（embeddings）、github_issue（tracker API）、issue_agent/coder 技能划分 → **Phase 4b**（需要外部 API key 决策，独立成文档）。
- **占位符检查**：SSRF 私网段判断给出具体 CIDR 表而非"仿照 Python"带过；`onSyncSuccess` 挂钩的默认值决策（Task 6 直接 import 而非保持可选）已给出理由，不是留白。ctags/rg 缺失环境下测试的降级说明写清楚（Step 1 注明"若无则跳过并在报告说明"，不是模糊带过）。
- **类型一致性**：`ToolContext` 在 Task 2 定义扩展、Task 4/5/6 的 `execute(input, ctx)` 消费、Task 8 在 `turn.ts`/`sse.ts` 产出并传入 `toPiTools`；`RepoRow`（Task 1 定义）在 Task 7/8 消费一致；`resolvePath` Task 4 导出、Task 6 复用（对照 v1 的 import 复用关系）。
