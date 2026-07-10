# CodeAxis 部署与迁移手册

## 当前部署形态（2026-07 盘点）

无容器、无构建步骤：一个 Python 虚拟环境里的 uvicorn 进程直接对外提供
API + 静态前端（`:8000`），前面**没有**反向代理。进程目前是手动
`nohup uvicorn ...` 拉起的（PPID=1 的孤儿进程）——**机器重启后不会自动恢复**，
建议尽快换成下面的 systemd 单元。

```
┌─ /home/my-agent ──────────────────────────────┐
│  app/  web/          ← 代码（git 管理）        │
│  .venv/              ← Python 3.11 虚拟环境    │
│  .env                ← 密钥/配置（不入 git）    │
│  .jwt_secret         ← JWT 签名密钥（不入 git） │
│  agent_data.db       ← SQLite：所有业务数据    │
└───────────────────────────────────────────────┘
┌─ /tmp/agent-repos（APP_REPOS_DIR 默认值）──────┐
│  <id>/               ← 各仓库浅克隆             │
│  <id>.tags.json      ← ctags 符号索引侧车       │
│  <id>.emb.npz        ← 语义检索 embedding 侧车  │
└───────────────────────────────────────────────┘
```

## 状态盘点：迁移时什么必须带走

| 内容 | 位置 | 迁移 |
|---|---|---|
| 代码 | git 仓库 | `git clone`，不用拷 |
| **业务数据库** | `agent_data.db` | **必须拷**。含用户/密码哈希、仓库配置（**含 GitLab token**）、权限、全部会话、issue 提报记录、用量指标 |
| **运行密钥** | `.env` | **必须拷**（DashScope key、admin 引导账号等） |
| **JWT 密钥** | `.jwt_secret` | **必须拷**——不拷也能跑（自动重新生成），但所有用户登录态失效，需重新登录 |
| 仓库检出 + ctags 索引 | `/tmp/agent-repos/<id>/`、`<id>.tags.json` | **不用拷**。启动时自动重新克隆，ctags 索引免费秒级重建 |
| embedding 索引 | `/tmp/agent-repos/<id>.emb.npz` | **建议拷**（可选）。不拷会自动全量重建（约 3~8 分钟 + ~2.6 元 API 费/仓库）；拷过去则按内容哈希全部复用，零费用。日常增量同步本来就近乎零费用，这笔钱只在索引文件丢失时发生 |

## 迁移到新机器（约 15 分钟）

```bash
# 1. 系统依赖（Debian/Ubuntu）
apt install -y python3.11 python3.11-venv git universal-ctags ripgrep
#    universal-ctags: 符号索引（缺失则该功能自动降级）
#    ripgrep:         code_search 加速（缺失则回退 grep -F，功能不变）

# 2. 代码 + 虚拟环境
git clone <repo-url> /home/my-agent && cd /home/my-agent
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 3. 从旧机器带状态过来（先停旧服务，保证 SQLite 一致性）
#    旧机器上: sqlite3 agent_data.db ".backup /tmp/agent_data.backup.db"
scp old:/tmp/agent_data.backup.db  /home/my-agent/agent_data.db
scp old:/home/my-agent/.env        /home/my-agent/.env
scp old:/home/my-agent/.jwt_secret /home/my-agent/.jwt_secret

# 4. 按新环境改 .env（至少检查 APP_CORS_ORIGINS 指向新地址）

# 5. 建专用账号（不要用 root 跑服务——见下面隐患第 3 条），再启动
useradd --system --home /home/my-agent --shell /usr/sbin/nologin codeaxis
chown -R codeaxis:codeaxis /home/my-agent /tmp/agent-repos
cp deploy/codeaxis.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now codeaxis
```

首次启动会自动：跑数据库结构迁移（`init_db` 内置，无需手动）、克隆所有
仓库、后台重建 ctags 和 embedding 索引。管理页仓库列表能看到同步/索引状态。

## 已知隐患与建议（按优先级）

1. **无进程守护**：现在是裸 nohup，重启即死。→ 用 `deploy/codeaxis.service`。
2. **仓库目录在 /tmp**：机器重启即被清空。能自愈（自动重克隆+重建索引），
   但 embedding 全量重建有 API 费用。→ `.env` 里设
   `APP_REPOS_DIR=/var/lib/codeaxis/repos`。
3. **不要用 root 跑服务**：`deploy/codeaxis.service` 已经配了 `User=codeaxis`
   ——按上面第 5 步建好专用账号再启用，不要直接把 `WorkingDirectory` 指到
   root 的 home 下用 root 跑。这台机器上目前是手动 nohup+root 跑的，仅限于
   开发调试；正式迁移务必换成专用账号，否则仓库解析里的任何一个漏洞都会
   直接变成主机 root 沦陷。
4. **明文 HTTP 直接对外**：登录密码、JWT、GitLab token 都走明文。
   → 前置 nginx/caddy 加 TLS，`APP_CORS_ORIGINS` 同步改 https。
5. **未装 ripgrep**：当前机器 code_search 走的是 grep 回退路径，大仓库
   搜索偏慢。→ `apt install ripgrep`。
6. **备份**：`agent_data.db` 是唯一不可再生的数据，建议 cron 定时
   `sqlite3 agent_data.db ".backup ..."` 到异机。
