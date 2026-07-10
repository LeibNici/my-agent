# Codex 舰队任务提示词（v2 存档 — 判定逻辑规范）

> 存档说明：v3 把本文件的散文规则下沉进了 ~/tools/codex-issue。本文件保留
> 作为判定逻辑的**规范**（工具行为与此处语义不一致时以排查工具 bug 为先），
> 不再直接投喂给舰队。完成协议部分（v2 的核心变更）已由 codex-issue finish
> 实现。

---

/goal 持续处理 GitLab 项目 jvs-new-version/xinchuan-digital 的 open issues，直到 open issue 为 0，或已无可安全处理的 issue，或遇到真实阻塞。

认证配置：
/Users/chenming/.codex/xinchuan-digital.env
（GitLab API、平台登录账号密码均在该文件中，禁止在对话、评论、日志中泄露其内容）

优先调用 ~/tools 目录下的工具。

工作限制：
- 只能在当前 Codex worktree 内修改、构建、测试、提交、合并和推送。
- 禁止修改 /Users/chenming/IdeaProjects/xinchuan-digital 下的项目文件。
- 如 Trellis 必须绑定 /Users/chenming/IdeaProjects/xinchuan-digital，只允许通过 Trellis 工具更新 task 元数据，不得直接修改该目录下项目文件。
- 不泄露认证文件内容或 token。
- 目标基线分支：test。
- continue nonstop。
- 支持多 worker 并发，但每个 worker 每次只处理一个 issue。
- 不处理与当前 issue 无关的改动。
- 禁止 git reset --hard、git checkout -- <file>、force push、amend 已推送 commit，除非用户明确要求。
- 禁止创建 MR，除非用户明确要求。
- 如遇真实阻塞，必须记录证据、已尝试步骤、当前状态、下一步建议，然后停止当前 goal。
- 禁止使用临时库进行 flyway 迁移测试。

完成协议（替代旧的"写完成评论/打 label/关闭 issue"手工流程）：
- 修复验证通过、fast-forward 合并到 test 且 git push origin test 成功后，执行：
  ~/tools/codex-issue finish <issue_iid> --commit <合入test的commit_sha>
- 该命令幂等，失败或中断后可安全重跑；它会自动校验 commit 已在 test、
  写结构化完成评论（含 codex-report/v1 机器可读标记）、补 codex:merged-to-test
  label 并关闭 issue。
- 命令报错 "NOT reachable from 'test'" 说明合并/推送未完成，先完成再重试。
- 禁止绕过该命令手工写完成评论或手工关闭 issue。
- 执行前 export CODEX_WORKER_ID=<当前worker_id>，使完成报告可追溯到 worker。

开发分支清理规则：
- 每个 issue 的开发分支 codex/issue-<iid>-<slug> 只用于该 issue 修复。
- 当前 issue 已 fast-forward 合并到 test 且 git push origin test 成功后，必须清理该开发分支。
- 删除前必须确认开发分支 commit 已进入 origin/test：
  git fetch origin
  git merge-base --is-ancestor codex/issue-<iid>-<slug> origin/test
- 确认已合入后：
  - 如果当前还在开发分支，先切换到 test。
  - 删除本地开发分支：
    git branch -d codex/issue-<iid>-<slug>
  - 如果该开发分支曾推送到远端，且由当前 worker 创建，删除远端开发分支：
    git push origin --delete codex/issue-<iid>-<slug>
- 禁止使用 git branch -D 强删开发分支，除非用户明确要求。
- 禁止批量删除远端 codex/* 分支；只能删除当前 worker 自己创建并已确认合入 origin/test 的开发分支。
- 如果确认未合入 origin/test，或 merge-base 检查失败，必须保留开发分支并记录原因。
- 完成报告必须记录开发分支清理结果。

全局并发规则：
1. worker_id
- 启动时生成唯一 worker_id：
  codex-<日期时间>-<短随机值>
- 启动后立即 export CODEX_WORKER_ID=<worker_id>（codex-issue 依赖它）。
- GitLab 评论、Trellis task、锁分支、开发分支中都记录 worker_id。
2. 原子 issue 锁
- 成功领取 issue 前，不得读取完整 issue 正文、全部评论或分析代码。
- 领取前只允许读取列表字段：
  iid、title、labels、updated_at、state。
- 对于 state=open 且带 codex:merged-to-test，或评论等价记录"已合并并推送到 origin/test"的 issue，允许执行最小化 reopen 防误关预检；预检只能读取判定旧完成标记是否失效所需的 issue 事件/label 事件/最近评论元数据，不得读取完整业务正文或分析代码。
- 对候选 issue 必须先创建远端锁分支：
  codex-lock/issue-<iid>
- 必须优先用 GitLab API create branch 创建锁：
  - ref 使用 test 最新 commit SHA。
  - 创建成功才代表领取成功。
  - branch already exists / 409 / 明确提示已存在：视为领取失败，立刻跳过。
  - 401 / 403 / 非"已存在"的 400 / 网络或权限错误：视为真实阻塞，记录响应摘要，不泄露 token。
- 禁止使用以下方式作为锁：
  git push origin origin/test:refs/heads/codex-lock/issue-<iid>
- 如果无法使用 API，只能使用具备 create-only 语义的唯一空 commit 方案；无法保证 create-only 时不得抢锁。
- 抢锁失败后，只允许读取锁相关最小证据，不得做业务分析。
- stale 锁：超过 6 小时无对应 worker 更新评论，可记录证据后接管；无法确认 stale 则跳过。
- 完成、跳过或阻塞时，只能删除当前 worker 自己创建并登记的 issue 锁。
3. test 合并锁
- 修复验证通过后，合并到 test 前必须获取全局 test 合并锁：
  codex-lock/merge-test
- 合并锁必须使用 GitLab API create branch，规则同 issue 锁。
- 获取失败说明其他 worker 正在合并 test，当前 worker 不得领取新 issue；必须等待并重试，或超过合理时间后记录阻塞。
- codex-lock/merge-test 超过 6 小时无对应 worker 更新评论，可记录证据后接管；无法确认 stale 则继续等待或记录阻塞。
- 只允许删除当前 worker 自己创建并登记的合并锁。
4. reopen 防误关规则
- codex:merged-to-test 或含 codex-report/v1 标记的完成评论（或旧格式"已合并并推送到 origin/test"评论）只表示该 issue 曾经合入过 test，不表示一个当前 open issue 可以被直接关闭。
- 禁止仅因为 state=open 且带 codex:merged-to-test，就直接关闭 issue。
- 对 state=open 且带 codex:merged-to-test，或存在等价完成评论的 issue，必须先判断旧完成标记是否因 reopen 或新需求失效。
- 如果存在以下任一情况，旧完成标记视为失效：
  - issue 的 reopen 事件晚于最近一次 codex:merged-to-test label 添加时间。
  - issue 的 reopen 事件晚于最近一次完成评论（codex-report/v1 或旧格式）时间。
  - 最近一次完成评论之后出现新的非当前 worker、非系统、非纯状态同步评论。
  - 最近一次完成评论之后 issue 描述、验收标准、linked issues 或依赖关系发生变化。
  - 无法可靠确认完成标记仍然有效。
- 旧完成标记失效时：
  - 不得直接关闭 issue。
  - 必须移除 codex:merged-to-test；如无法移除，评论记录"旧 codex:merged-to-test 已因 reopen 或新评论失效"。
  - 必须重新进入正常领取、读取、分析、修复、验证、合并流程。
- 只有当前 worker 在本轮处理中完成修复、验证通过、push origin/test 成功后，通过执行 ~/tools/codex-issue finish 完成收尾；关闭动作由该命令执行，不得手工关闭。
- 执行 codex-issue finish 前必须再次检查最新 reopen 事件和最新非 worker 评论；如果它们晚于本轮修复完成时间，禁止执行 finish，必须重新处理或记录阻塞。
- 如果无法读取 reopen/label/comment 事件来证明完成标记仍有效，不得关闭 issue；应领取后完整检查，或跳过并报告无法安全判断。
5. 跳过规则
领取前跳过：
- closed issue。
- blocked / status:blocked：跳过，除非该阻塞是 codex:blocked-by-* 依赖阻塞且前置已合入 origin/test。
- codex:in-progress 且不是当前 worker。
- codex:merged-to-test 且经 reopen 防误关预检确认没有 reopen-after-merge、没有完成后新评论、没有新增需求、且 open 状态只是因为无权限关闭或历史未关闭。
- 评论中已记录完成（含 codex-report/v1 标记的评论视为等价完成记录，与旧格式"已合并并推送到 origin/test"同等对待）但因权限无法关闭，并且经 reopen 防误关预检确认该完成记录未失效的 issue。
- codex:waiting-merge / codex:ready-for-review 仅视为历史遗留或人工介入状态，遇到时跳过并报告。
- 已有有效 codex-lock/issue-<iid>。
- codex:blocked-by-* 且对应前置 issue 尚未合入 origin/test。
- migration issue 且已有有效全局 migration 锁。
无法仅靠列表字段判断依赖关系的 issue，先抢锁；抢锁成功后再读取正文、评论、linked issues 判断。若发现前置依赖未完成，记录依赖阻塞，释放锁并跳过。
对于 state=open 且带 codex:merged-to-test 的 issue，如果 reopen 防误关预检发现旧完成标记失效或无法可靠判断，不得按 merged-to-test 跳过；应按正常候选 issue 尝试获取 issue 锁。
6. 前置依赖与解锁规则
- 成功领取后，必须检查正文、评论、linked issues。
- 如果当前 issue 依赖的前置 issue 仍 open、codex:in-progress、codex:waiting-merge、相关修复分支未合入 test，或相关 commit 未进入 origin/test，必须释放锁并跳过。
- 因前置依赖跳过时，不得只打通用 blocked / codex:blocked。
- 必须添加可回扫标记：
  codex:blocked-by-<前置issue_iid>
- 同时评论记录：
  worker_id、当前 issue、前置 issue、阻塞依据、时间。
- 如 label 不可用，用评论记录等价状态。
- 禁止为了处理 B issue 私自实现 A issue 的需求。
- 禁止基于其他 worker 的未合并分支继续开发，除非用户明确要求。
7. 依赖解锁回扫
- 每轮查询 open issues 后、排序领取前，必须执行一次依赖解锁回扫。
- 每个 issue 成功合并并推送到 origin/test 后，也必须执行一次依赖解锁回扫。
- 回扫范围：
  - 带 codex:blocked-by-* label 的 open issues。
  - 评论中存在 codex:blocked-by-* 等价状态的 open issues。
  - linked issues 中被当前已完成 issue blocking 的 open issues。
- 对每个依赖阻塞 issue：
  - 检查所有 codex:blocked-by-<iid> 对应前置 issue。
  - 如果前置 issue 已关闭，或有仍有效的 codex:merged-to-test，或评论记录仍有效的完成记录（含 codex-report/v1），或对应 commit 已进入 origin/test，则视为该前置已满足。
  - 如果所有前置依赖都已满足，移除 codex:blocked-by-* 标记或追加等价解除评论。
  - 评论记录：前置依赖已合入 origin/test，当前 issue 已解除依赖阻塞，可重新领取。
  - 不得移除人工添加的 blocked / status:blocked，除非明确证据表明它是当前流程因依赖添加的状态。
- 如果只剩 blocked issue，不能直接结束；必须先执行依赖解锁回扫。
- 回扫后有 issue 被解除依赖阻塞，必须重新进入排序领取流程。
8. Flyway 规则
- 任何新增、修改、删除 Flyway migration，或涉及表、字段、索引、DDL、初始化数据、数据修复脚本的 issue，视为 db-migration issue。
- 处理 db-migration issue 前必须获取全局迁移锁：
  codex-lock/db-migration
- 迁移锁必须使用 GitLab API create branch，规则同 issue 锁。
- 获取迁移锁成功后，必须在当前 issue 评论记录 worker_id、迁移锁分支、领取时间、迁移原因和 test commit SHA。
- 获取失败则释放 issue 锁并跳过该 issue。
- codex:db-migration-lock label 只作展示，不作为真实锁。
- codex-lock/db-migration 超过 6 小时无对应 worker 更新评论，可记录证据后接管；无法确认 stale 则跳过 migration issue。
- 禁止修改已合入 test 或可能已执行过的旧 migration。
- 修正已执行 migration 必须新增 migration。
- 新 migration 使用 UTC 时间戳：
  VyyyyMMddHHmmss__description.sql
- 禁止依赖 Flyway outOfOrder 作为默认方案。
- 每个 worker 必须使用独立数据库或 schema 验证 Flyway，验证后清理。
9. label 兜底
- 如果指定 GitLab label 不存在且无权限创建，必须用 issue 评论记录等价状态。
- 后续跳过判断必须同时识别 label 和等价评论（含 codex-report/v1 标记）。
- 完成相关的 label 与评论统一由 codex-issue finish 写入，不再手工兜底；其余状态（blocked-by 等）仍按本条执行。
- 如果无法移除已失效的 codex:merged-to-test，必须追加等价失效评论；后续 worker 必须识别该失效评论，不得再把旧完成标记当作有效完成标记。

处理流程：
1. 检查 open issues
- 使用认证配置访问 GitLab。
- 查询 open issues，只读取列表字段：iid、title、labels、updated_at、state。
- 如果 open issue 数量为 0，只报告当前 open issue 为 0，并结束 goal。
- 如果存在 open issue，继续执行。
- 如果 open issue 带 codex:merged-to-test 或等价完成评论，先按 reopen 防误关规则执行最小化预检；预检结果必须记录在跳过原因或领取后的 issue 评论中。
2. 依赖解锁回扫
- 对 open issues 执行依赖解锁回扫。
- 回扫时遇到作为前置的 issue 带 codex:merged-to-test，必须确认该完成标记仍有效；如果前置 issue 已 reopen 且旧完成标记失效，不得把该前置视为已满足。
- 如果有 issue 被解除 codex:blocked-by-*，重新读取 open issue 列表，再进入排序。
- 如果没有可解除依赖，继续排序。
3. issue 排序与领取
- 按优先级 P0 / P1 / P2 / P3 / P4 排序。
- 优先级从 issue label 中识别。
- 无明确优先级的 issue 排在 P4 之后。
- 同优先级内按 updated_at 从旧到新排序。
- 对 state=open 且带 codex:merged-to-test 的候选 issue，先执行 reopen 防误关预检：
  - 若确认完成标记仍有效且只是历史未关闭，跳过并记录原因，不关闭。
  - 若确认完成标记已失效或无法可靠判断，继续尝试领取。
- 按排序依次尝试创建 codex-lock/issue-<iid>。
- 领取失败立刻跳过，不读取正文、不分析代码。
- 如果所有 issue 都不可领取，先再次执行依赖解锁回扫。
- 回扫后仍无可领取 issue，报告跳过原因并结束当前 goal。
- 领取成功后进入下一步。
4. 处理前读取上下文
- 读取当前 issue 正文。
- 读取当前 issue 全部评论。
- 读取 linked issues、评论中提到的前置 issue。
- 如果当前 issue 是 reopen 后残留 codex:merged-to-test，必须先判断旧完成标记是否失效：
  - 失效则移除 codex:merged-to-test；如无法移除，评论记录旧标记已失效。
  - 未失效且确认只是历史未关闭，则释放 issue 锁，跳过并报告，不关闭。
- 总结：
  - 问题
  - 复现路径
  - 验收标准
  - 前置依赖
  - 是否涉及 Flyway
  - 风险点
- 如果发现前置依赖未完成：
  - 添加 codex:blocked-by-<前置issue_iid> 或等价评论。
  - 记录阻塞依据。
  - 释放当前 issue 锁。
5. 修复与验证
- 从 test 最新 commit 创建开发分支 codex/issue-<iid>-<slug>。
- 只做与当前 issue 相关的最小修复。
- 按 issue 的验收标准验证；能构建/测试的必须构建/测试通过。
- 涉及 Flyway 的按 Flyway 规则执行。
6. 合并与推送
- 获取全局 test 合并锁 codex-lock/merge-test。
- git fetch origin && 基于最新 origin/test 确认可 fast-forward 合并；有冲突则在开发分支解决后重验。
- fast-forward 合并到 test，git push origin test。
- 推送成功后立即释放合并锁。
7. 完成收尾
- 按完成协议执行：
  ~/tools/codex-issue finish <issue_iid> --commit <合入test的commit_sha>
- 按开发分支清理规则清理分支，删除当前 worker 的 issue 锁。
- 执行一次依赖解锁回扫。
8. 完成报告
- 记录：issue、worker_id、commit SHA、验证方式与结果、codex-issue finish 输出、分支清理结果、回扫结果。
- 返回步骤 1 继续处理下一个 issue。
