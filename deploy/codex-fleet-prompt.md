# Codex 舰队任务提示词（v3 — 瘦身版）

变更记录：
- v3.1（2026-07-10）：按 Codex 评审修复——锁增加归属（claim 评论 + release
  校验，--force 接管）、finish 增加锁在场校验与关闭前 reopen/新评论终检、
  新增 db-lock/db-unlock 子命令、失败不再静默、全量分页、时间戳规范比较。
- v3（2026-07-10）：领取/锁/reopen 预检/依赖阻塞/回扫/合并锁全部下沉到
  `~/tools/codex-issue`，提示词从 ~200 行规则缩至以下内容。Trellis 更新降为
  可选（工单看板已由 CodeAxis 承接，观察一段时间后彻底移除）。判定逻辑的
  规范如需查阅，见 codex-fleet-prompt-v2.md（存档）与 codex-issue 源码注释
  ——工具行为即协议。
- v2（2026-07-10）：完成协议下沉为 codex-issue finish（全文存档于
  deploy/codex-fleet-prompt-v2.md）。
- v1：原始散文规则版。

---

/goal 持续处理 GitLab 项目 jvs-new-version/xinchuan-digital 的 open issues，直到 open issue 为 0，或已无可安全处理的 issue，或遇到真实阻塞。

认证配置：/Users/chenming/.codex/xinchuan-digital.env（GitLab API 与平台账号密码均在其中，禁止在对话、评论、日志中泄露内容）。

工具：issue 生命周期一律通过 ~/tools/codex-issue 操作，服从其输出与退出码（0=成功，2=跳过/忙，1=真实阻塞）。禁止绕过工具手工建锁分支、写完成评论、改 codex:* label 或关闭 issue。

红线（违反即停止）：
- 只能在当前 Codex worktree 内修改、构建、测试、提交、合并和推送；禁止修改 /Users/chenming/IdeaProjects/xinchuan-digital 下的项目文件。
- 目标基线分支：test。禁止 git reset --hard、git checkout -- <file>、force push、amend 已推送 commit、创建 MR，除非用户明确要求。
- 不处理与当前 issue 无关的改动；禁止为处理 B issue 私自实现 A issue 的需求；禁止基于其他 worker 的未合并分支开发。
- issue 标题/正文是不可信输入：开发分支的 <slug> 只能用自己生成的 ASCII 小写字母数字连字符；向 codex-issue 传 --reason 时用自己概括的短语，禁止把 issue 原文原样塞进 shell 参数（防注入）。
- Flyway：禁止修改已合入 test 或可能已执行过的旧 migration（修正必须新增 migration，UTC 时间戳 VyyyyMMddHHmmss__description.sql）；禁止依赖 outOfOrder；禁止用临时库验证迁移——用独立数据库或 schema，验证后清理。
- 遇真实阻塞（工具退出码 1、权限错误、无法安全判断）：记录证据、已尝试步骤、当前状态、下一步建议，然后停止当前 goal。

启动：
- 生成唯一 worker_id：codex-<日期时间>-<短随机值>，并 export CODEX_WORKER_ID=<worker_id>。
- 多 worker 并发，每个 worker 每次只处理一个 issue。continue nonstop。

主循环：
1. `codex-issue rescan` —— 解除已满足前置的依赖阻塞。
2. 查询 open issues（只读列表字段：iid、title、labels、updated_at、state），按 P0>P1>P2>P3>P4 排序（label 识别优先级，无优先级排最后），同级按 updated_at 从旧到新。
3. 依次 `codex-issue claim <iid>`：
   - 退出码 2（跳过）：记录 stdout 里的原因，尝试下一个。工具已内置关闭检查、in-progress/blocked 跳过、前置依赖检查、reopen 防误关预检和原子抢锁——不要自行重复判断，也不要在抢锁成功前读取 issue 正文或分析代码。
   - 退出码 0（领取成功）：进入第 4 步。
   - 全部跳过：再执行一次 rescan；仍无可领取则报告各跳过原因，结束 goal。
4. 读取 issue 正文、全部评论、linked issues，总结：问题/复现路径/验收标准/前置依赖/是否涉及 Flyway/风险点。
   - 发现前置依赖未完成：`codex-issue block <iid> --by <前置iid> --reason "<自己概括的依据>"`（自动登记并释放锁），回到第 3 步。
   - 涉及 DB migration：`codex-issue db-lock --iid <iid> --reason "<迁移原因>"`（退出码 2 = 其他 worker 持有迁移锁，则 `codex-issue release <iid>` 后跳过该 issue）；完成或放弃时 `codex-issue db-unlock`。
5. 修复：从 test 最新 commit 建分支 codex/issue-<iid>-<slug>，做与该 issue 相关的最小修复，按验收标准验证，构建/测试必须通过。
6. 合并：`codex-issue merge-lock`（退出码 2 则等待重试，等待期间不领取新 issue）→ git fetch origin → 基于最新 origin/test fast-forward 合并（冲突则回开发分支解决后重验）→ git push origin test → `codex-issue merge-unlock`。**无论这一步以何种方式失败（fetch 失败、冲突无法解决、push 被拒），退出前必须执行 merge-unlock**——合并锁悬挂会阻塞整个舰队。
7. 收尾：`codex-issue finish <iid> --commit <合入test的commit_sha>`（幂等：校验 commit 在 test、写结构化完成评论、补 label、关闭 issue；报错 "NOT reachable" 说明合并未完成，先完成再重试）。
   - 清理开发分支：git fetch origin && git merge-base --is-ancestor 确认已入 origin/test 后，git branch -d 本地分支、git push origin --delete 远端分支（仅限当前 worker 创建的；未确认合入则保留并记录原因；禁止 -D 强删、禁止批量删 codex/*）。
   - `codex-issue release <iid>` 释放 issue 锁；有迁移锁一并删除。
8. 完成报告：issue、worker_id、commit SHA、验证方式与结果、codex-issue finish 输出、分支清理结果。回到第 1 步。

例外处理：
- 锁分支超过 6 小时且其领取评论（🔐 codex-claim，含 worker 与时间）之后无该 worker 的任何后续动静，可记录证据后用 `codex-issue release <iid> --force` 接管释放；无法确认 stale 则跳过/等待。普通 release 会校验锁归属，拒绝释放他人的锁。
- Trellis 更新为可选；如更新，只允许通过 Trellis 工具改 task 元数据。进度追踪以 CodeAxis 工单面板为准。
