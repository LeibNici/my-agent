# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal AI coding-assistant chat tool for engineers at 信川机械工业 (Xinchuan
Machinery) — lets them browse/search their own repos, confirm bugs, walk
through code, and draft GitHub/GitLab issues from a chat UI. Chinese-primary
UI copy, English technical identifiers. See `.impeccable.md` for the product's
design language (color vocabulary, typography, dark-only theme) — read it
before touching `web/style.css` or making other visual/UI decisions.

The assistant is deliberately **read-only over the tracked repos**: no tool
edits or writes files. The system prompt (`app/config.py`) and every skill's
prompt (`app/skills/*.py`) reinforce this — it confirms bugs, explains code,
and drafts an issue for a human to act on, never hands back a full rewritten
file. Keep this constraint in mind before adding any tool with write access.

## Running

No build step — backend is plain FastAPI/Python, frontend is static
HTML/JS/CSS served directly via `StaticFiles` (no bundler, no package.json).

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload   # serves API + frontend at :8000
```

Config is via `.env` (see `.env.example` for every var and what it does —
`ANTHROPIC_*` for the LLM provider, `APP_*` for app-level settings like CORS
origins, repo sync interval, admin bootstrap credentials). On first boot the
app creates an admin user (`APP_ADMIN_USERNAME`/`APP_ADMIN_PASSWORD`, default
`admin`/`admin123` — always warns loudly on stdout if left at default) and a
`.jwt_secret` file is generated next to the repo root if not already present.

There is no test suite or linter configured in this repo.

## Architecture

**Request flow**: `app/main.py` (FastAPI routes, JWT auth via `app/auth.py`,
SSE streaming for chat) → `app/agent.py` (`Agent.run`, the Anthropic tool-use
loop) → `app/llm.py` (thin Anthropic SDK wrapper) and `app/tools/registry.py`
(tool dispatch). Every chat turn streams as SSE events (`text`, `tool_use`,
`tool_result`, `session`, `done`, `error`) that `web/app.js` renders live.

**Skills vs. tools** (`app/skills/`, `app/tools/`): a *tool* is a single
`@tool`-decorated function auto-registered into a global schema
(`app/tools/registry.py` — reflects the function signature into an Anthropic
JSON schema). A *skill* (`app/skills/base.py`) bundles a subset of tools with
an additional system-prompt fragment; `coder` and `issue_agent`
(`app/skills/*.py`) are the two registered skills, imported for
side-effecting registration in `app/main.py` (a `researcher` skill and
`web_search` tool existed once and were deliberately removed — the audience
is product/QA staff doing code walkthroughs, not web research). When a chat
request selects `active_skills`, the agent restricts both the tool list and
the system prompt to just those skills instead of exposing everything.

**Cost controls**: history sent to the model is shaped by
`_prepare_model_messages` in `main.py` — past-turn images are replaced with
text placeholders and history is windowed (`ANTHROPIC_MAX_HISTORY_MESSAGES`)
with cuts that never split a tool_use/tool_result pair; the DB copy is never
truncated. Prompt caching (`cache_control` breakpoints, applied in
`agent.py`) is governed by `ANTHROPIC_PROMPT_CACHE` = auto|on|off — "auto"
enables it only against the official Anthropic API, since third-party
Anthropic-compatible endpoints may reject the field. `code_search` uses
ripgrep when installed, falling back to `grep -F`.

**Permission model**: repos are admin-managed (`app/admin.py`) and users are
granted per-repo `read`/`write`/`admin` access (`permissions` table in
`app/database.py`). A chat turn resolves the caller's visible repos
(`_get_visible_repos` in `main.py`) into local filesystem paths and stashes
them in a `ContextVar` (`tool_context` in `app/tools/registry.py`) for the
duration of that turn — `app/tools/access.py` is the shared boundary check
(`get_allowed_paths`/`is_within_allowed_paths`) that `file_reader.py` and
`code_search.py` both call before touching disk. This is deny-by-default: no
context set means no access, not "everything."

**Repo sync** (`app/repo_sync.py`): repos are shallow-cloned into
`APP_REPOS_DIR` (default `/tmp/agent-repos`) on creation, on a periodic
background loop, and on manual admin trigger — never written to by any tool.
Clone/pull both run through `_run_git` with a hard timeout; credentials are
passed per-invocation via a git `-c http.extraheader` config value (never
persisted into the on-disk remote URL or exposed back to clients — see
`mask_url_credentials`). `_validate_url`/`_is_disallowed_host` block
loopback/private/link-local hosts as an SSRF guard, reused by both git sync
and the GitLab issue-submission API call in `app/tools/github_issue.py`.

**Issue submission** (`app/tools/github_issue.py`, wired into
`POST /api/issues/submit` in `main.py`): the `draft_issue` tool only returns
a preview card for the user to confirm client-side; the actual network call
happens server-side in `submit_repo_issue`, which dispatches to the GitHub
REST API (using the global `APP_GITHUB_TOKEN`) if the repo host is
`github.com`, otherwise to a self-hosted GitLab-compatible API (using that
specific repo's own stored `cred_token`). Drafts are stamped with the repo
the turn was scoped to (`active_repo` in the tool context) so submission
targets that repo even if the sidebar selection changes afterwards, and
`POST /api/issues/check-duplicates` (→ `search_repo_issues`) warns about
similar existing issues on the card. Submitting resolves/closes the chat
session (`resolved_at`) — the next message against that `session_id`
transparently starts a fresh session rather than tacking onto a closed one.

**Answer feedback & code viewing**: `POST /api/feedback` records 👍/👎 per
assistant answer (`message_feedback` table; the `done` SSE event carries the
answer's `message_id`), surfaced in the admin usage tab via
`GET /api/admin/feedback/summary`. `GET /api/code/file` powers the in-chat
read-only code viewer (clickable `path/file.java:12-34` references in
answers) — it resolves repo-relative paths against the user's granted repos
with the same containment/dotfile rules as the `file_reader` tool.

**Persistence** (`app/database.py`): single SQLite file (`agent_data.db`,
WAL mode), no migration framework — schema evolves via
`_add_column_if_missing` checks run at every startup inside `init_db()`.
`llm_call_metrics` records per-LLM-call timing/token usage (one row per
tool-use loop iteration) for the admin usage dashboard
(`/api/admin/usage/*`); `issue_submissions` is the durable record of what was
actually filed on a tracker, independent of chat message rendering.

**Frontend** (`web/`): no framework, no build — `app.js` (main chat UI),
`admin.js` (admin console), `shared.js` (small cross-page helpers), each
paired with its own HTML entry point (`index.html`, `admin.html`,
`login.html`) and a single shared `style.css`.
