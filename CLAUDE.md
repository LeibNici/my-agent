# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An internal AI coding-assistant chat tool for engineers at 信川机械工业 (Xinchuan
Machinery) — lets them browse/search their own repos, confirm bugs, walk
through code, and draft GitHub/GitLab issues from a chat UI. Chinese-primary
UI copy, English technical identifiers. See `.impeccable.md` for the product's
design language — read it before touching `web/style.css` or making other
visual/UI decisions.

The assistant is deliberately **read-only over the tracked repos**: no tool
edits or writes files. It confirms bugs, explains code, and drafts an issue
for a human to act on — never hands back a full rewritten file. Keep this
constraint in mind before adding any tool with write access.

## Current state: v2 rewrite in progress (pure Node)

The original Python/FastAPI implementation has been **removed from the
working tree** — the product is being rebuilt on Node/TypeScript with
`@earendil-works/pi-agent-core` as the agent engine. The product has never
shipped; there are no users and no production data, which is why the rewrite
is a straight line (no strangler coexistence, no shadow traffic).

**The Python implementation remains the behavioral spec.** It is preserved
at the git tag `v1-python-final`:

```bash
git show v1-python-final:app/agent.py          # engine loop semantics
git show v1-python-final:app/database.py       # schema + row encoding
git show v1-python-final:tests/test_agent_budget.py   # frozen behavior goldens
```

When implementing a v2 feature whose semantics are unclear, consult the
tagged Python source and the 22 characterization tests under
`v1-python-final:tests/` — they define budget checkpoints, SSE contract,
history windowing, and message codec behavior. Do not re-derive these from
memory.

## Running

```bash
cd engine
npm install
npm start           # the service: HTTP/SSE edge + real pi engine, port 8000 (APP_PORT)
npm test            # vitest, all offline (mock Anthropic server)
npm run typecheck
```

`npm start` runs `src/server/main.ts`: settings → `.jwt_secret` → schema DDL
→ db worker → admin bootstrap (admin/admin123 unless `APP_ADMIN_PASSWORD`;
loud warning on the default) → Hono app with the real `runTurn` engine.
SQLite lives at the repo root (`agent_data.db`, override `APP_DB_PATH`);
`.env` is read from the process cwd (`engine` under `npm start`). Set
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` for the real
provider (DashScope in production). Required-vars table:
`engine/README.md`'s 运行 section. Tool surface is calculator-only until
Phase 4; the frontend (`web/`, static, no build step) is served by the Node
edge at `/`, `/login`, `/admin`, `/static/*` — admin/issue/feedback pages
404 until their Phase 4/5 routes return.

## Architecture (engine)

Three-layer DTO isolation (a Codex-review global constraint): **pi types may
only appear in `src/codec-pi.ts` and `src/event-adapter.ts`** — everything
else speaks `DomainMessage`/`DomainEvent` (`src/domain.ts`), with raw legacy
JSON shapes confined to the `src/codec-legacy.ts` boundary.

- `src/domain.ts` — typed message/event model, `CodecError`
- `src/codec-legacy.ts` — legacy JSON dict shapes ↔ domain (validating boundary)
- `src/codec-pi.ts` — domain ↔ pi messages (toolName backfill by tool_use_id;
  throws on image/thinking blocks — known Phase-1 limitations, see README)
- `src/event-adapter.ts` — pi AgentEvent stream → domain event sequence
  (text_delta/llm_metrics/tool_use/tool_result/tool_exchange/done/error).
  pi has NO error event: errors surface as message_end with
  stopReason:"error"; the driving harness checks `agent.state.errorMessage`
  after prompt() and calls `fail()` instead of `finish()`.
- `src/history-policy.ts` — port of the history windowing semantics
  (image placeholder, condense-then-window, current-turn-kept-whole)
- `src/db/` — better-sqlite3 storage in a worker thread
  (`createDbClient`), row encoding byte-identical to the Python original
  via `py-compat.ts` (json.dumps separators `", "`/`": "`, local-naive
  6-digit-microsecond timestamps — never `Date.toISOString()`)

Versions are exact-pinned (no `^`/`~`); `@earendil-works/pi-*@0.80.6`.
DashScope's Anthropic-compatible endpoint is the production LLM provider
(qwen3.7-plus) — see `spikes/pi-provider/REPORT*.md` for what was verified
against it (streaming, tools, prompt caching, tool_choice:"none",
consecutive-double-user message shape).

Schema ownership: with Python gone, **Node owns DDL** (Phase 3 adds
`initSchema`; `storage.ts`'s `checkSchema` remains the fail-loud guard).
`agent_data.db` in the repo root is disposable dev data.

## Where decisions live

- `engine/README.md` — layer boundary rules, Phase-1 limitations,
  DB byte-compat facts and known gaps
- `spikes/` — frozen evidence from the 0A/0B validation gates; never
  import from or modify these

## Frontend

See `web/CLAUDE.md` (loads automatically when working with files under
`web/`).
