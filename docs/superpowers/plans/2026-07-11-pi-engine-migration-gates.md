# CodeAxis v2 pi 基座迁移 — 决策门阶段实施计划（Phase -1 / 0A / 0B）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 "以 earendil-works/pi 重写 agent 引擎" 这一决策建立三道可验证的门：现有行为冻结（characterization 测试基线）、pi-ai 对 DashScope/qwen 的协议验证（0A）、pi-agent-core 控制面能力验证（0B），产出一份有证据支撑的 go/no-go 决策文档。

**Architecture:** 本计划不改动任何生产代码路径——Phase -1 在现有 Python 仓库内新增离线测试（FakeLLM 注入，零网络），把 SSE 事件序列、消息编解码、history windowing、工具预算 checkpoint 的现有行为固化为 golden 基线；Phase 0A/0B 在 `spikes/` 目录内做隔离验证（0A 是唯一联网阶段，0B 用本地 mock Anthropic 服务器全离线）。三个 Phase 全部通过后，才编写后续迁移计划（见"总体路线图"）。

**Tech Stack:** Python 3.11 + pytest/pytest-asyncio（Phase -1）；Node 24 + TypeScript + `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core`（Phase 0A/0B，版本精确锁定）。

## Global Constraints

以下约束来自 Codex 架构评审（2026-07-11，session `019f5090-42c8-7930-94d9-793dd0a22d05`），对本计划及所有后续迁移计划全局生效：

- **SQLite 是唯一消息真相源**；v2 中 Agent 实例每 turn 临时创建、turn 结束即销毁，禁止跨 turn 常驻、禁止在 Agent 实例里缓存授权路径。
- **三层 DTO 隔离**：`LegacyStoredMessage`（DB/旧前端格式）、`DomainMessage`（业务域）、pi 消息类型三者显式转换，pi 的类型不得穿透到路由层、DB 层、业务工具。
- **SSE 契约冻结的完整定义**：事件全集 `session/text/tool_use/tool_result/done/error/end`（注意 `end` 也在契约内）；失败序列固定为 `error → done → end`；`done` payload 携带 `session_id/text/message_id/budget_exhausted`；断线时已完成的 tool exchange 已落库、未落库文本追加 `_（回复未完成：连接已中断）_`。
- **工具面冻结**：模型可见工具 = `file_reader、code_search、list_directory、calculator、find_symbol、list_file_symbols、semantic_search、draft_issue、manage_issue`；`search_repo_issues`/`get_repo_labels` 是业务 API 后端逻辑，**不得**暴露为模型工具；v2 所有工具初始 `executionMode: "sequential"`。
- **pi 版本精确锁定**：package.json 不用 `^`/`~`，提交 lockfile，记录 Node 版本；升级必须通过契约测试门。
- **时间戳**必须与 Python `datetime.now().isoformat()` 的字符串排序兼容。
- **golden 基线不可随意改**：Phase -1 产出的 characterization 测试是后续所有阶段的验收基线，任何修改 golden 的提交必须在 commit message 里说明行为差异及其理由。
- Phase -1 与 0B 全离线可重复运行；0A 是唯一允许联网（DashScope）的阶段。

---

## 总体路线图（本计划只覆盖前三个 Phase）

| Phase | 内容 | 关键路径 | 计划文档 |
|---|---|---|---|
| **-1 行为冻结** | 现有 Python 实现的 characterization 测试基线 | ✅ | **本文档 Task 1–6** |
| **0A provider 门** | pi-ai 打通 DashScope + qwen3.7-plus，实测流式/工具/缓存/长会话 | ✅ | **本文档 Task 7–8** |
| **0B 控制面门** | pi-agent-core 能否承载 checkpoint/turn barrier/wrap-up/历史注入 | ✅ | **本文档 Task 9–11** |
| 1 防腐层 + legacy codec | 三 DTO 双向转换、pi event → legacy SSE 适配、history policy | ✅ | 门后另立（依赖 0B 结论选 Agent 类 / agentLoop / pi-ai+自研 loop） |
| 2 数据库兼容层 | better-sqlite3 + DB worker thread、旧行回放、PRAGMA/迁移兼容 | ✅ | 门后另立 |
| 3 绞杀者阶段 | 保留 FastAPI 边缘层，仅 LLM/agent 引擎入 Node，内部协议回传 domain events | ✅ | 门后另立 |
| 4 工具迁移 | file/code search、ctags、semantic index（版本化格式替代 .npz）、issue 工具 | 可并行 | 门后另立 |
| 5 业务 API 与 Node edge | auth/admin/issue 提交/截图上传/repo scheduler/完整 SSE route | | 门后另立 |
| 6 shadow/canary/cutover | 双跑比对、小流量灰度、快速回切、停 Python | | 门后另立 |

**0B 不通过 ≠ 整案作废**：备选路径为 (a) pi-ai + 保留自研 loop（仍获得 provider 统一层收益），或 (b) fork pi-agent-core 增加 turn-boundary hooks。决策在 Task 11 的 GATE.md 里落地。

---

## File Structure

```
（现有仓库根 /home/my-agent）
requirements-dev.txt                      # 新增：pytest, pytest-asyncio
tests/
  __init__.py
  conftest.py                             # 临时 DB fixture、cache-off fixture
  fakes.py                                # FakeLLM + 事件脚本构造器（Anthropic 流事件替身）
  test_history_windowing.py               # _prepare_model_messages goldens
  test_message_codec.py                   # add_message/get_messages 编解码 goldens
  test_agent_events.py                    # Agent.run 事件序列 goldens（纯文本/工具回合/错误）
  test_agent_budget.py                    # 预算 checkpoint goldens（midpoint/endgame/wrap-up）
  test_sse_contract.py                    # chat_event_stream SSE 契约 goldens（含断线/拒绝序列）
spikes/
  pi-provider/                            # Phase 0A（唯一联网 spike）
    package.json  tsconfig.json
    src/provider.ts                       # DashScope createProvider 定义
    src/scenarios.ts                      # S1–S7 场景
    REPORT.md                             # 实测结果 + 通过判定
  pi-agent-core/                          # Phase 0B（全离线）
    package.json  tsconfig.json
    src/mock-anthropic.ts                 # 本地 Anthropic 兼容 mock 服务器（脚本化 SSE + 请求记录）
    src/scenarios.ts                      # B1–B6 控制面场景
    REPORT.md                             # 能力矩阵
docs/superpowers/plans/
  2026-07-11-pi-engine-migration-gates.md # 本文档
  GATE.md                                 # Task 11 产出：go/no-go 决策记录
```

执行分支：`git checkout -b pi-migration-gates`（所有 task 提交到该分支）。

---

### Task 1: 测试基建 —— pytest + FakeLLM

**Files:**
- Create: `requirements-dev.txt`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/fakes.py`

**Interfaces:**
- Produces: `tests.fakes.FakeLLM(turns)` —— `LLMClient` 替身，`.calls: list[dict]` 记录每次请求 kwargs，`.model = "fake-model"`；`tests.fakes.text_turn(chunks, input_tokens=10, output_tokens=5) -> list`、`tests.fakes.tool_turn(name, input_obj, tool_id, text="") -> list` 事件脚本构造器；conftest 提供 `tmp_db`（临时 SQLite + init_db）与 `no_cache`（强制 prompt_cache=off）fixtures。

- [ ] **Step 1: 写依赖文件并安装**

`requirements-dev.txt`:

```
pytest>=8.0
pytest-asyncio>=0.24
```

Run: `.venv/bin/pip install -r requirements-dev.txt`
Expected: 安装成功。

- [ ] **Step 2: 写 conftest.py**

```python
"""Shared fixtures. Tests never touch the real agent_data.db or the network."""
import asyncio

import pytest

import app.database as database
from app.config import settings


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    """Point the whole app at a throwaway SQLite file and initialize schema."""
    db_file = tmp_path / "test.db"
    monkeypatch.setattr(database, "DB_PATH", str(db_file))
    asyncio.get_event_loop_policy()  # ensure a policy exists under pytest-asyncio
    asyncio.run(database.init_db())
    return db_file


@pytest.fixture(autouse=True)
def no_cache(monkeypatch):
    """Force prompt caching off so event goldens don't depend on .env contents."""
    monkeypatch.setattr(settings, "prompt_cache", "off")
```

并在仓库根加 `pytest.ini` 内容（追加到 Create 列表同一提交）：

```ini
[pytest]
asyncio_mode = auto
testpaths = tests
```

- [ ] **Step 3: 写 tests/fakes.py**

```python
"""FakeLLM: drop-in replacement for app.llm.LLMClient that replays scripted
Anthropic stream events and records every request the agent sends.
Event attribute shapes mirror exactly what app/agent.py reads."""
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace


def text_turn(chunks, input_tokens=10, output_tokens=5):
    """One LLM call that streams plain text (chunks: list[str])."""
    return [
        SimpleNamespace(type="message_start",
                        message=SimpleNamespace(usage=SimpleNamespace(input_tokens=input_tokens))),
        SimpleNamespace(type="content_block_start",
                        content_block=SimpleNamespace(type="text")),
        *[SimpleNamespace(type="content_block_delta",
                          delta=SimpleNamespace(type="text_delta", text=c))
          for c in chunks],
        SimpleNamespace(type="content_block_stop"),
        SimpleNamespace(type="message_delta",
                        usage=SimpleNamespace(output_tokens=output_tokens)),
    ]


def tool_turn(name, input_obj, tool_id, text="", input_tokens=10, output_tokens=5):
    """One LLM call that (optionally streams text then) emits one tool_use."""
    events = [
        SimpleNamespace(type="message_start",
                        message=SimpleNamespace(usage=SimpleNamespace(input_tokens=input_tokens))),
    ]
    if text:
        events += [
            SimpleNamespace(type="content_block_start",
                            content_block=SimpleNamespace(type="text")),
            SimpleNamespace(type="content_block_delta",
                            delta=SimpleNamespace(type="text_delta", text=text)),
            SimpleNamespace(type="content_block_stop"),
        ]
    payload = json.dumps(input_obj)
    half = len(payload) // 2
    events += [
        SimpleNamespace(type="content_block_start",
                        content_block=SimpleNamespace(type="tool_use", id=tool_id, name=name)),
        # input arrives as partial_json deltas, split in two to exercise reassembly
        SimpleNamespace(type="content_block_delta",
                        delta=SimpleNamespace(type="input_json_delta", partial_json=payload[:half])),
        SimpleNamespace(type="content_block_delta",
                        delta=SimpleNamespace(type="input_json_delta", partial_json=payload[half:])),
        SimpleNamespace(type="content_block_stop"),
        SimpleNamespace(type="message_delta",
                        usage=SimpleNamespace(output_tokens=output_tokens)),
    ]
    return events


class FakeLLM:
    """turns: list where each entry is a list of events (one LLM call),
    or an Exception instance to raise when that call is attempted."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = []
        self.model = "fake-model"
        self.client = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        scripted = self.turns.pop(0)

        @asynccontextmanager
        async def ctx():
            if isinstance(scripted, Exception):
                raise scripted

            async def gen():
                for e in scripted:
                    yield e
            yield gen()
        return ctx()
```

- [ ] **Step 4: 冒烟验证基建可用**

Run: `.venv/bin/python -c "from tests.fakes import FakeLLM, text_turn; f = FakeLLM([text_turn(['hi'])]); print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add requirements-dev.txt pytest.ini tests/__init__.py tests/conftest.py tests/fakes.py
git commit -m "test: characterization test infra — FakeLLM replays scripted Anthropic streams

Phase -1 of the pi-migration gates plan: freeze current behavior as golden
baselines before any engine work. FakeLLM mirrors the exact event attribute
shapes app/agent.py reads, so agent-loop behavior can be pinned offline."
```

---

### Task 2: history windowing goldens

**Files:**
- Create: `tests/test_history_windowing.py`

**Interfaces:**
- Consumes: `app.main._prepare_model_messages`、`app.main._HISTORY_IMAGE_PLACEHOLDER`、`app.config.settings.max_history_messages`（monkeypatch）。

- [ ] **Step 1: 写测试**

```python
"""Goldens for _prepare_model_messages — the exact condensation semantics
Codex flagged as un-replaceable: image placeholders, current-turn-kept-whole,
past tool bookkeeping dropped, never opening on an assistant message."""
import pytest

from app.config import settings
from app.main import _HISTORY_IMAGE_PLACEHOLDER, _prepare_model_messages


def _msg(role, content):
    return {"role": role, "content": content}


def test_under_limit_passes_through_with_image_placeholder(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 60)
    history = [
        _msg("user", [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}},
                      {"type": "text", "text": "看这个截图"}]),
        _msg("assistant", "看到了"),
    ]
    out = _prepare_model_messages(history)
    assert out[0]["content"][0] == {"type": "text", "text": _HISTORY_IMAGE_PLACEHOLDER}
    assert out[0]["content"][1] == {"type": "text", "text": "看这个截图"}
    assert out[1] == {"role": "assistant", "content": "看到了"}


def _tool_heavy_turn(i):
    """One past turn: question + assistant(text+tool_use) + tool_result relay + answer."""
    return [
        _msg("user", f"问题{i}"),
        _msg("assistant", [{"type": "text", "text": f"我查一下{i}"},
                           {"type": "tool_use", "id": f"tu_{i}", "name": "code_search",
                            "input": {"keyword": "x"}}]),
        _msg("user", [{"type": "tool_result", "tool_use_id": f"tu_{i}", "content": "..."}]),
        _msg("assistant", f"结论{i}"),
    ]


def test_past_turns_condensed_current_turn_kept_whole(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 6)
    history = _tool_heavy_turn(1) + _tool_heavy_turn(2) + [
        _msg("user", "当前问题"),
        _msg("assistant", [{"type": "tool_use", "id": "tu_c", "name": "file_reader",
                            "input": {"path": "a.py"}}]),
        _msg("user", [{"type": "tool_result", "tool_use_id": "tu_c", "content": "..."}]),
    ]
    out = _prepare_model_messages(history)
    # current turn (from last plain user message) survives whole
    assert out[-3] == _msg("user", "当前问题")
    assert out[-2]["content"][0]["type"] == "tool_use"
    assert out[-1]["content"][0]["type"] == "tool_result"
    # past turns: tool_use/tool_result bookkeeping gone, questions/answers remain
    flat = str(out[:-3])
    assert "tu_1" not in flat and "tu_2" not in flat
    assert out[0]["role"] == "user"  # never opens on assistant


def test_condensed_past_windowed_and_never_opens_on_assistant(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 3)
    history = (_tool_heavy_turn(1) + _tool_heavy_turn(2) + _tool_heavy_turn(3)
               + [_msg("user", "当前问题"), ])
    out = _prepare_model_messages(history)
    assert len(out) <= 3 + 1  # window + current turn tolerance: current turn is 1 msg
    assert out[0]["role"] == "user"
    assert out[-1] == _msg("user", "当前问题")


def test_windowing_disabled_when_zero(monkeypatch):
    monkeypatch.setattr(settings, "max_history_messages", 0)
    history = _tool_heavy_turn(1) * 40
    assert len(_prepare_model_messages(history)) == len(history)
```

- [ ] **Step 2: 运行确认全绿（characterization：测试描述现状，失败即写错了断言）**

Run: `.venv/bin/pytest tests/test_history_windowing.py -v`
Expected: 4 passed。若有失败，对照 `app/main.py:277` 修正**断言**（不是修代码）——这一阶段代码就是规范。

- [ ] **Step 3: Commit**

```bash
git add tests/test_history_windowing.py
git commit -m "test: golden-pin history windowing (condense-not-slice, image placeholders)"
```

---

### Task 3: 消息编解码 goldens

**Files:**
- Create: `tests/test_message_codec.py`

**Interfaces:**
- Consumes: `app.database.add_message / get_messages`、conftest 的 `tmp_db`。
- Produces: 该文件的编码事实（list→JSON 字符串、str 原样、读取时 `[` 前缀才解 JSON）是 Phase 2 Node 端 `LegacyStoredMessage` codec 的验收标准。

- [ ] **Step 1: 写测试**

```python
"""Goldens for the legacy message storage format — the exact bytes Phase 2's
Node codec must reproduce. list content is JSON-encoded (ensure_ascii=False),
plain strings stored raw, decode only kicks in for a leading '['."""
import aiosqlite
import pytest

from app.database import add_message, get_messages


async def _raw_content(db_file, msg_id):
    async with aiosqlite.connect(db_file) as db:
        cur = await db.execute("SELECT content FROM messages WHERE id = ?", (msg_id,))
        return (await cur.fetchone())[0]


async def test_plain_string_stored_raw(tmp_db):
    mid = await add_message("s1", "assistant", "普通回答")
    assert await _raw_content(tmp_db, mid) == "普通回答"
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == "普通回答"


async def test_block_list_roundtrips_and_keeps_unicode(tmp_db):
    blocks = [{"type": "tool_use", "id": "tu_1", "name": "code_search",
               "input": {"keyword": "不合格评审"}}]
    mid = await add_message("s1", "assistant", blocks)
    raw = await _raw_content(tmp_db, mid)
    assert raw.startswith("[") and "不合格评审" in raw  # ensure_ascii=False
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == blocks


async def test_string_starting_with_bracket_but_not_json_left_alone(tmp_db):
    text = "[系统] 这不是JSON"
    await add_message("s1", "user", text)
    msgs = await get_messages("s1")
    assert msgs[0]["content"] == text


async def test_message_order_is_insertion_order(tmp_db):
    for i in range(3):
        await add_message("s1", "user", f"m{i}")
    msgs = await get_messages("s1")
    assert [m["content"] for m in msgs] == ["m0", "m1", "m2"]
```

- [ ] **Step 2: 运行确认全绿**

Run: `.venv/bin/pytest tests/test_message_codec.py -v`
Expected: 4 passed。

- [ ] **Step 3: Commit**

```bash
git add tests/test_message_codec.py
git commit -m "test: golden-pin legacy message storage format (Phase-2 codec oracle)"
```

---

### Task 4: Agent.run 事件序列 goldens（纯文本 / 工具回合 / 错误）

**Files:**
- Create: `tests/test_agent_events.py`

**Interfaces:**
- Consumes: `app.agent.Agent`、`tests.fakes.FakeLLM/text_turn/tool_turn`；真实注册工具 `calculator`（import `app.tools.calculator` 触发注册）。
- Produces: 事件序列断言是 Phase 1 `pi event → domain event` 适配层的验收标准。

- [ ] **Step 1: 写测试**

```python
"""Goldens for the Agent.run event stream — the exact sequence Phase 1's
pi-event adapter must reproduce."""
import pytest

import app.tools.calculator  # noqa: F401 — side-effect: registers the tool
from app.agent import Agent
from tests.fakes import FakeLLM, text_turn, tool_turn


async def _collect(agent, messages, **kw):
    return [e async for e in agent.run(messages, **kw)]


async def test_text_only_turn_sequence():
    fake = FakeLLM([text_turn(["你", "好"])])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "hi"}])
    assert [e.type for e in events] == ["text_delta", "text_delta", "llm_metrics", "done"]
    assert events[-1].data == {"text": "你好", "success": True}
    assert events[2].data["input_tokens"] == 10 and events[2].data["output_tokens"] == 5


async def test_tool_round_sequence_and_exchange_pairing():
    fake = FakeLLM([
        tool_turn("calculator", {"expression": "1+1"}, "tu_1", text="算一下"),
        text_turn(["答案是2"]),
    ])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "1+1=?"}])
    types = [e.type for e in events]
    assert types == ["text_delta", "llm_metrics", "tool_use", "tool_result",
                     "tool_exchange", "text_delta", "llm_metrics", "done"]
    tu = next(e for e in events if e.type == "tool_use")
    assert tu.data == {"id": "tu_1", "name": "calculator",
                       "input": {"expression": "1+1"}}
    tr = next(e for e in events if e.type == "tool_result")
    assert tr.data["id"] == "tu_1" and "2" in tr.data["result"]
    ex = next(e for e in events if e.type == "tool_exchange")
    # assistant blocks: leading text + the tool_use; results pair by tool_use_id
    assert ex.data["assistant"][0] == {"type": "text", "text": "算一下"}
    assert ex.data["assistant"][1]["id"] == "tu_1"
    assert ex.data["results"][0]["tool_use_id"] == "tu_1"
    # second LLM call saw the tool_result relayed back
    relay = fake.calls[1]["messages"][-1]
    assert relay["role"] == "user"
    assert relay["content"][0]["type"] == "tool_result"


async def test_llm_error_yields_error_then_unsuccessful_done():
    fake = FakeLLM([RuntimeError("boom")])
    events = await _collect(Agent(llm=fake), [{"role": "user", "content": "hi"}])
    assert [e.type for e in events] == ["error", "done"]
    assert events[0].data["message"].startswith("LLM API error: RuntimeError")
    assert events[1].data["success"] is False
```

- [ ] **Step 2: 运行确认全绿**

Run: `.venv/bin/pytest tests/test_agent_events.py -v`
Expected: 3 passed。若 `tool_result` 断言失败，先打印实际 result 核对 calculator 的返回格式，再修断言。

- [ ] **Step 3: Commit**

```bash
git add tests/test_agent_events.py
git commit -m "test: golden-pin Agent.run event sequences (text/tool/error paths)"
```

---

### Task 5: 工具预算 checkpoint goldens

**Files:**
- Create: `tests/test_agent_budget.py`

**Interfaces:**
- Consumes: `app.agent` 的 `_MIDPOINT_CHECK/_ENDGAME_CHECK/_WRAPUP_PROMPT` 文案、`settings.max_tool_iterations`（monkeypatch=8）。
- Produces: checkpoint 语义五要素（见测试名）是 Phase 0B 场景 B2–B4 的对照规范。

- [ ] **Step 1: 写测试**

```python
"""Goldens for the tool-budget checkpoint — the behavior Codex identified as
the hardest thing to reproduce on pi-agent-core. Five pinned semantics:
1. midpoint/endgame reminders ride on the NEXT call's tool-result message;
2. reminders are model-only — never in persisted tool_exchange blocks;
3. budget exhaustion triggers one final tool-free wrap-up call;
4. the wrap-up call requests tool_choice=none first;
5. done carries budget_exhausted=True."""
import json

import pytest

import app.tools.calculator  # noqa: F401
from app.agent import Agent
from app.config import settings
from tests.fakes import FakeLLM, text_turn, tool_turn


@pytest.fixture
def budget8(monkeypatch):
    monkeypatch.setattr(settings, "max_tool_iterations", 8)


async def _run_to_exhaustion(fake):
    return [e async for e in Agent(llm=fake).run([{"role": "user", "content": "查"}])]


def _exhausting_turns():
    """8 tool turns (burn the whole budget) + 1 wrap-up text turn."""
    turns = [tool_turn("calculator", {"expression": f"{i}+1"}, f"tu_{i}") for i in range(8)]
    turns.append(text_turn(["阶段性汇报"]))
    return turns


async def test_midpoint_and_endgame_reminders_reach_the_model(budget8):
    fake = FakeLLM(_exhausting_turns())
    await _run_to_exhaustion(fake)
    assert len(fake.calls) == 9  # 8 loop iterations + 1 wrap-up
    # midpoint fires before iteration 4 (next_iteration == 8//2)
    call4 = json.dumps(fake.calls[4]["messages"], ensure_ascii=False)
    assert "本轮调查已过半" in call4
    # endgame fires when 1..3 rounds remain (calls 6 and 7)
    call6 = json.dumps(fake.calls[6]["messages"], ensure_ascii=False)
    assert "仅剩" in call6


async def test_reminders_never_appear_in_persisted_exchanges(budget8):
    fake = FakeLLM(_exhausting_turns())
    events = await _run_to_exhaustion(fake)
    for e in events:
        if e.type == "tool_exchange":
            persisted = json.dumps(e.data, ensure_ascii=False)
            assert "本轮调查已过半" not in persisted
            assert "仅剩" not in persisted


async def test_wrapup_call_is_tool_free_and_done_flags_budget(budget8):
    fake = FakeLLM(_exhausting_turns())
    events = await _run_to_exhaustion(fake)
    wrap_call = fake.calls[8]
    assert wrap_call.get("tool_choice") == {"type": "none"}  # first attempt enforces
    assert "预算已用尽" in json.dumps(wrap_call["messages"], ensure_ascii=False)
    done = events[-1]
    assert done.type == "done"
    assert done.data["budget_exhausted"] is True
    assert done.data["text"] == "阶段性汇报"


async def test_wrapup_retries_without_tool_choice_when_rejected(budget8):
    turns = _exhausting_turns()
    # first wrap-up attempt (with tool_choice) blows up, retry without succeeds
    turns[8:] = [RuntimeError("tool_choice unsupported"), text_turn(["汇报"])]
    fake = FakeLLM(turns)
    events = await _run_to_exhaustion(fake)
    assert len(fake.calls) == 10
    assert fake.calls[8].get("tool_choice") == {"type": "none"}
    assert "tool_choice" not in fake.calls[9]
    assert events[-1].data["budget_exhausted"] is True
```

- [ ] **Step 2: 运行确认全绿**

Run: `.venv/bin/pytest tests/test_agent_budget.py -v`
Expected: 4 passed。

- [ ] **Step 3: Commit**

```bash
git add tests/test_agent_budget.py
git commit -m "test: golden-pin tool-budget checkpoint semantics (0B 对照规范)

Five pinned semantics the pi-agent-core spike must prove reproducible;
these tests double as the acceptance oracle for whichever loop wins."
```

---

### Task 6: chat_event_stream SSE 契约 goldens

**Files:**
- Create: `tests/test_sse_contract.py`

**Interfaces:**
- Consumes: `app.main.chat_event_stream / ChatRequest`、conftest `tmp_db`；monkeypatch `app.main.agent` 为脚本化 stub。
- Produces: SSE 序列（含 `session` 先行、`error→done→end` 拒绝序列、断线持久化）是 Phase 3 Node edge 的逐字节验收标准。

- [ ] **Step 1: 写测试**

```python
"""Goldens for the browser-facing SSE contract produced by chat_event_stream.
Pins exactly what Codex called out as wider than 'event names': the early
session event, the error→done→end reject sequence, immediate tool_exchange
persistence, and disconnect partial-save semantics."""
import asyncio
import json

import pytest

import app.main as main
from app.agent import AgentEvent
from app.database import get_messages
from app.main import ChatRequest, chat_event_stream

ADMIN = {"id": 1, "username": "admin", "role": "admin"}


class StubAgent:
    def __init__(self, events):
        self._events = events

    async def run(self, messages, **kw):
        for e in self._events:
            if isinstance(e, Exception):
                raise e
            yield e


async def _collect_sse(req, user):
    return [e async for e in chat_event_stream(req, user)]


async def test_reject_sequence_is_error_done_end(tmp_db):
    req = ChatRequest(message="x" * (main.MAX_MESSAGE_LENGTH + 1))
    events = await _collect_sse(req, ADMIN)
    assert [e["event"] for e in events] == ["error", "done", "end"]
    assert json.loads(events[1]["data"])["session_id"] is None


async def test_normal_turn_session_first_done_carries_ids(tmp_db, monkeypatch):
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="text_delta", data={"text": "答案"}),
        AgentEvent(type="done", data={"text": "答案", "success": True}),
    ]))
    events = await _collect_sse(ChatRequest(message="问题"), ADMIN)
    assert [e["event"] for e in events] == ["session", "text", "done", "end"]
    session_data = json.loads(events[0]["data"])
    assert session_data["reason"] == "new" and session_data["session_id"]
    done = json.loads(events[2]["data"])
    assert done["session_id"] == session_data["session_id"]
    assert done["message_id"] is not None
    assert done["budget_exhausted"] is False
    # persisted: user question + assistant answer
    msgs = await get_messages(session_data["session_id"])
    assert [m["role"] for m in msgs] == ["user", "assistant"]


async def test_tool_exchange_persisted_even_when_turn_errors_later(tmp_db, monkeypatch):
    assistant_blocks = [{"type": "tool_use", "id": "tu_1", "name": "code_search",
                         "input": {"keyword": "x"}}]
    result_blocks = [{"type": "tool_result", "tool_use_id": "tu_1", "content": "hit"}]
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="tool_exchange",
                   data={"assistant": assistant_blocks, "results": result_blocks}),
        RuntimeError("boom"),
    ]))
    events = await _collect_sse(ChatRequest(message="查"), ADMIN)
    assert [e["event"] for e in events] == ["session", "error", "done", "end"]
    sid = json.loads(events[0]["data"])["session_id"]
    msgs = await get_messages(sid)
    # user question + persisted exchange pair survive the crash
    assert msgs[1]["content"] == assistant_blocks
    assert msgs[2]["content"] == result_blocks


async def test_disconnect_saves_partial_text_and_reraises(tmp_db, monkeypatch):
    monkeypatch.setattr(main, "agent", StubAgent([
        AgentEvent(type="text_delta", data={"text": "写到一半"}),
        asyncio.CancelledError(),
    ]))
    gen = chat_event_stream(ChatRequest(message="问"), ADMIN)
    events = []
    with pytest.raises(asyncio.CancelledError):
        async for e in gen:
            events.append(e)
    sid = json.loads(events[0]["data"])["session_id"]
    msgs = await get_messages(sid)
    assert msgs[-1]["role"] == "assistant"
    assert msgs[-1]["content"].startswith("写到一半")
    assert "连接已中断" in msgs[-1]["content"]
```

- [ ] **Step 2: 运行确认全绿（并跑全量基线）**

Run: `.venv/bin/pytest tests/ -v`
Expected: 全部 passed（约 19 个）。若 `ChatRequest` 校验或 `_get_visible_repos` 与假设不符，读 `app/main.py` 对应行修断言。

- [ ] **Step 3: Commit**

```bash
git add tests/test_sse_contract.py
git commit -m "test: golden-pin browser SSE contract incl. disconnect/reject semantics

Phase -1 complete: SSE sequences, message codec, windowing, budget
checkpoint all frozen as the acceptance baseline for every later phase."
```

---

### Task 7: Phase 0A 脚手架 —— pi-ai + DashScope provider

**Files:**
- Create: `spikes/pi-provider/package.json`
- Create: `spikes/pi-provider/tsconfig.json`
- Create: `spikes/pi-provider/src/provider.ts`

**Interfaces:**
- Produces: `src/provider.ts` 导出 `dashscopeModel`（qwen3.7-plus 的 pi-ai model 引用）与 `models`（registry），供 Task 8 场景使用。

- [ ] **Step 1: 初始化并精确锁定版本**

```bash
mkdir -p spikes/pi-provider/src && cd spikes/pi-provider
npm view @earendil-works/pi-ai version   # 记下当前版本，下面以 0.80.6 为例
npm init -y
npm install --save-exact @earendil-works/pi-ai@0.80.6
npm install --save-dev --save-exact typescript@5.7.3 tsx@4.19.2 @sinclair/typebox@0.34.13
node --version > .node-version
```

Expected: package.json 中依赖无 `^`/`~` 前缀；package-lock.json 生成。

- [ ] **Step 2: 确认包的真实导出名（pi 是 v0.x，API 名以实物为准）**

```bash
node -e "console.log(Object.keys(require('@earendil-works/pi-ai')))"
ls node_modules/@earendil-works/pi-ai/dist/api/ | head
```

Expected: 能看到 `createProvider`、`envApiKeyAuth`、`createModels` 等导出，以及 `anthropic-messages` 相关的 api 模块文件名。**若与下一步代码中的名字不符，以实物为准修改代码，并把差异记进 REPORT.md。**

- [ ] **Step 3: 写 provider 定义**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "outDir": "dist", "rootDir": "src"
  }
}
```

`src/provider.ts`:

```typescript
// DashScope Anthropic-compatible endpoint + qwen3.7-plus, mirroring the
// values production reads from /home/my-agent/.env (ANTHROPIC_BASE_URL/MODEL).
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
// 按 Step 2 的实际文件名调整这一行：
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export const models = createModels();

const dashscope = createProvider({
  id: "dashscope",
  auth: { apiKey: envApiKeyAuth("DashScope", ["ANTHROPIC_API_KEY"]) },
  api: anthropicMessagesApi(),
  models: [
    {
      id: "qwen3.7-plus",
      name: "Qwen 3.7 Plus (DashScope anthropic-compat)",
      api: "anthropic-messages",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    },
  ],
});

models.setProvider(dashscope);
export const dashscopeModel = models.getModel("dashscope", "qwen3.7-plus");
```

- [ ] **Step 4: 冒烟——发一条最小流式请求**

```bash
cd spikes/pi-provider
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' ../../.env | cut -d= -f2-) \
  npx tsx --eval '
import { models, dashscopeModel } from "./src/provider.ts";
const s = models.stream(dashscopeModel, { messages: [{ role: "user", content: "回复一个字：好" }] });
for await (const e of s) if (e.type === "text_delta") process.stdout.write(e.delta ?? "");
console.log("\nOK");'
```

Expected: 流式打出文本并以 `OK` 结束。事件类型名若与 pi-ai 实际不符（v0.x），按 `models.stream` 的返回类型修正并记录。

- [ ] **Step 5: Commit**

```bash
git add spikes/pi-provider
git commit -m "spike(0A): pi-ai provider scaffold for DashScope qwen3.7-plus, versions pinned exact"
```

---

### Task 8: Phase 0A 场景与判定报告

**Files:**
- Create: `spikes/pi-provider/src/scenarios.ts`
- Create: `spikes/pi-provider/REPORT.md`

**Interfaces:**
- Consumes: Task 7 的 `models/dashscopeModel`。
- Produces: `REPORT.md` 的 S1–S7 判定表；S4/S7 的结论直接决定 v2 成本模型与 wrap-up 实现方式。

- [ ] **Step 1: 写场景脚本**

```typescript
// src/scenarios.ts — S1..S7, each prints PASS/FAIL + evidence lines for REPORT.md.
// Run: ANTHROPIC_API_KEY=... npx tsx src/scenarios.ts [s1|s2|...|all]
import { Type } from "@sinclair/typebox";
import { models, dashscopeModel } from "./provider.ts";

type Result = { name: string; pass: boolean; evidence: string };
const results: Result[] = [];

async function s1_streaming(): Promise<Result> {
  let chunks = 0, text = "";
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "用两句话介绍SQLite" }],
  });
  for await (const e of s) if (e.type === "text_delta") { chunks++; text += e.delta ?? ""; }
  return { name: "S1 流式文本", pass: chunks > 3 && text.length > 10,
           evidence: `chunks=${chunks} len=${text.length}` };
}

async function s2_toolcall(): Promise<Result> {
  const tools = [{
    name: "code_search",
    description: "在代码库中做固定字符串搜索",
    parameters: Type.Object({ keyword: Type.String() }),
  }];
  let call: unknown = null;
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "请用 code_search 工具搜索 UserService" }],
    tools,
  });
  for await (const e of s) if (e.type === "toolcall_end") call = (e as any).toolCall;
  return { name: "S2 工具调用+schema校验", pass: !!call,
           evidence: JSON.stringify(call).slice(0, 120) };
}

async function s3_multiturn_tools(): Promise<Result> {
  // 10 轮工具往返：每轮把上一轮 toolResult 塞回 messages，观察是否出现 400
  const tools = [{ name: "echo", description: "原样返回", parameters: Type.Object({ v: Type.String() }) }];
  const messages: any[] = [{ role: "user", content: "连续调用 echo 工具10次，每次v递增" }];
  for (let i = 0; i < 10; i++) {
    let toolCall: any = null; let text = "";
    const s = models.stream(dashscopeModel, { messages, tools });
    for await (const e of s) {
      if (e.type === "toolcall_end") toolCall = (e as any).toolCall;
      if (e.type === "text_delta") text += (e as any).delta ?? "";
    }
    if (!toolCall) return { name: "S3 长工具会话", pass: i >= 5,
                            evidence: `stopped calling tools at round ${i}` };
    messages.push({ role: "assistant", content: [{ type: "toolCall", ...toolCall }] });
    messages.push({ role: "toolResult", toolCallId: toolCall.id,
                    content: [{ type: "text", text: `echo:${i}` }] });
  }
  return { name: "S3 长工具会话", pass: true, evidence: "10 rounds no 4xx" };
}

async function s4_prompt_cache(): Promise<Result> {
  // 同一 sessionId 两次调用，第二次应出现 cache read tokens
  const big = "系统背景：".padEnd(4000, "码");  // 超过缓存最小前缀
  const opts = { sessionId: "spike-cache-1", cacheRetention: "short" as const };
  const call = async () => {
    let usage: any = null;
    const s = models.stream(dashscopeModel, {
      messages: [{ role: "user", content: big + "\n回复:1" }], ...opts,
    });
    for await (const e of s) if ((e as any).usage) usage = (e as any).usage;
    return usage;
  };
  await call();
  const second = await call();
  const read = second?.cacheReadTokens ?? second?.cache_read_input_tokens ?? 0;
  return { name: "S4 prompt caching 真实生效", pass: read > 0,
           evidence: `second-call usage=${JSON.stringify(second)}` };
}

async function s5_no_tools_forced(): Promise<Result> {
  // wrap-up 场景：tools 传空数组，模型不得再产生 toolcall
  let sawTool = false, text = "";
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "总结：SQLite是嵌入式数据库" }], tools: [],
  });
  for await (const e of s) {
    if (e.type.startsWith("toolcall")) sawTool = true;
    if (e.type === "text_delta") text += (e as any).delta ?? "";
  }
  return { name: "S5 空tools强制纯文本(wrap-up替代tool_choice:none)", pass: !sawTool && text.length > 0,
           evidence: `sawTool=${sawTool} len=${text.length}` };
}

async function s6_abort(): Promise<Result> {
  const ac = new AbortController();
  let chunks = 0, threw = "none";
  try {
    const s = models.stream(dashscopeModel, {
      messages: [{ role: "user", content: "写一篇500字的散文" }], signal: ac.signal,
    });
    for await (const e of s) {
      if (e.type === "text_delta" && ++chunks === 3) ac.abort();
    }
  } catch (err: any) { threw = err?.name ?? String(err); }
  return { name: "S6 中途取消", pass: chunks <= 6,
           evidence: `chunks=${chunks} threw=${threw}` };
}

async function s7_usage_ttft(): Promise<Result> {
  const t0 = Date.now(); let tFirst = 0; let usage: any = null;
  const s = models.stream(dashscopeModel, {
    messages: [{ role: "user", content: "回复:好" }],
  });
  for await (const e of s) {
    if (!tFirst && e.type === "text_delta") tFirst = Date.now();
    if ((e as any).usage) usage = (e as any).usage;
  }
  const ok = !!usage && usage.inputTokens > 0 && usage.outputTokens > 0;
  return { name: "S7 usage/TTFT数据完整(llm_call_metrics可移植)", pass: ok,
           evidence: `ttft=${tFirst - t0}ms usage=${JSON.stringify(usage)}` };
}

const all = { s1: s1_streaming, s2: s2_toolcall, s3: s3_multiturn_tools,
              s4: s4_prompt_cache, s5: s5_no_tools_forced, s6: s6_abort, s7: s7_usage_ttft };
const pick = process.argv[2] ?? "all";
for (const [k, fn] of Object.entries(all)) {
  if (pick !== "all" && pick !== k) continue;
  try { results.push(await fn()); }
  catch (err: any) { results.push({ name: k, pass: false, evidence: `THREW ${err?.message}` }); }
}
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  —  ${r.evidence}`);
```

注意：`toolCall`/`toolResult`/`usage` 的具体字段名以 pi-ai 实际类型为准（Step 2 of Task 7），跑不通先修字段名再判定。

- [ ] **Step 2: 逐场景运行并填 REPORT.md**

```bash
cd spikes/pi-provider
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' ../../.env | cut -d= -f2-) npx tsx src/scenarios.ts all
```

`REPORT.md` 模板（用真实输出填每一行）：

```markdown
# Phase 0A 判定报告 — pi-ai × DashScope qwen3.7-plus

- pi-ai 版本 / Node 版本 / 运行日期：
- 与 README 文档不符的 API 名（如有）：

| 场景 | 判定 | 证据 |
|---|---|---|
| S1 流式文本 | | |
| S2 工具调用+schema校验 | | |
| S3 长工具会话(10轮无4xx) | | |
| S4 prompt caching 真实产生 cache read | | |
| S5 空tools强制纯文本 | | |
| S6 中途取消不悬挂 | | |
| S7 usage/TTFT 完整 | | |

## 通过标准
S1/S2/S3/S6/S7 全 PASS 为硬门；S4 FAIL 仅影响成本模型（记录，不否决）；
S5 FAIL 则 wrap-up 需改用"提示词+忽略工具调用"实现（同现有 Python 回退路径，记录）。

## 结论：0A PASS / FAIL
```

Expected: 表格填满，结论明确。

- [ ] **Step 3: Commit**

```bash
git add spikes/pi-provider/src/scenarios.ts spikes/pi-provider/REPORT.md
git commit -m "spike(0A): DashScope/qwen provider verdict — <PASS|FAIL>, see REPORT.md"
```

---

### Task 9: Phase 0B 脚手架 —— 本地 mock Anthropic 服务器

**Files:**
- Create: `spikes/pi-agent-core/package.json`（同 Task 7 方式初始化，额外 `npm install --save-exact @earendil-works/pi-agent-core@<npm view 所示版本>`）
- Create: `spikes/pi-agent-core/tsconfig.json`（内容同 Task 7）
- Create: `spikes/pi-agent-core/src/mock-anthropic.ts`

**Interfaces:**
- Produces: `startMock(turns) -> { url, requests, close }` —— 本地 Anthropic 兼容 SSE 服务器；`textTurn(text)`、`toolTurn(name, input, id)` 脚本构造器。`requests: object[]` 记录每次请求体，是 B2/B3/B6 断言"模型到底收到了什么"的依据。

- [ ] **Step 1: 写 mock 服务器**

```typescript
// src/mock-anthropic.ts — a scripted Anthropic-messages-compatible SSE server.
// Lets 0B run fully offline AND assert on the exact request bodies pi sends —
// the only reliable way to answer "can we inject a reminder before call N+1".
import http from "node:http";
import type { AddressInfo } from "node:net";

type SseEvent = { type: string; [k: string]: unknown };

export function textTurn(text: string): SseEvent[] {
  return [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant",
      content: [], model: "mock", usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

export function toolTurn(name: string, input: object, id: string): SseEvent[] {
  return [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant",
      content: [], model: "mock", usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

export function startMock(turns: SseEvent[][]) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ at: Date.now(), body: JSON.parse(body || "{}") });
      const turn = turns[requests.length - 1] ?? textTurn("(script exhausted)");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const ev of turn) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.end();
    });
  });
  server.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => server.close() };
}
```

- [ ] **Step 2: 冒烟——pi-ai provider 指向 mock，收到一条文本**

在 `spikes/pi-agent-core/src/` 复制 Task 7 的 provider.ts，把 `baseUrl` 换成 `startMock` 返回的 url、模型 id 换成 `"mock"`，用 `npx tsx` 跑一条消息确认 pi 的解析器能消化 mock 的 SSE 格式（格式不符时对照 pi-ai 源码里 anthropic-messages 解析器修 mock，直到通）。

Run: `npx tsx src/smoke.ts`
Expected: 打印出 mock 的文本，无异常。

- [ ] **Step 3: Commit**

```bash
git add spikes/pi-agent-core
git commit -m "spike(0B): offline mock Anthropic server — request-body capture for control-plane assertions"
```

---

### Task 10: Phase 0B 控制面场景 B1–B6

**Files:**
- Create: `spikes/pi-agent-core/src/scenarios.ts`
- Create: `spikes/pi-agent-core/REPORT.md`

**Interfaces:**
- Consumes: Task 9 的 `startMock/textTurn/toolTurn`；`@earendil-works/pi-agent-core` 的 `Agent` 类与（若 Agent 类不满足）低级 `agentLoop`。
- Produces: `REPORT.md` 能力矩阵——每项标 `Agent类可行 / agentLoop可行 / 都不行`，直接喂给 Task 11 决策。

- [ ] **Step 1: 写六个场景（结构如下，每个场景 = 一个 async 函数打印 PASS/FAIL/PARTIAL + 证据）**

```typescript
// src/scenarios.ts — B1..B6. 每项对照 Phase -1 的 golden 语义
// （tests/test_agent_budget.py 与 tests/test_sse_contract.py 是对照规范）。
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { startMock, textTurn, toolTurn } from "./mock-anthropic.ts";

// fake 只读工具：echo，记录调用次数
function makeEchoTool(log: string[]): AgentTool {
  return {
    name: "echo", label: "Echo", description: "returns v",
    parameters: Type.Object({ v: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, params) => {
      log.push((params as any).v);
      return { content: [{ type: "text", text: `echo:${(params as any).v}` }] };
    },
  };
}

// B1 事件映射完整性：一次工具回合，收集全部 Agent 事件，验证能重组出
//    legacy 序列 text→tool_use→tool_result→(exchange barrier)→text→done，
//    且 tool_use 事件里能拿到 {id,name,完整input}。
// B2 turn barrier：在 turn_end/message_end subscriber 里 await 一个 200ms 延迟，
//    对比 mock.requests 相邻两次请求的时间差 —— 若第二次请求早于 subscriber
//    完成（时间差 < 200ms），说明事件是纯观察性、无同步屏障 ⇒ Agent 类 FAIL，
//    改试低级 agentLoop 的迭代边界。
// B3 注入非持久化 reminder：在第 N 次 toolResult 后（subscriber 或 steer()），
//    尝试让下一次 LLM 请求的 messages 末尾出现 "[系统提示]...已过半"，断言
//    mock.requests[N+1].body.messages 包含它，且 agent.state.messages 里
//    对应位置可（或不可）剥离 —— 记录哪种机制做到了、副作用是什么。
// B4 预算终止 + wrap-up：脚本 4 个 toolTurn；第 3 轮起让工具返回
//    { content: [...], terminate: true }（字段名以实际类型为准），断言 loop 停止、
//    不再发第 5 次请求；然后单独用 pi-ai 对 mock 发一次 tools=[] 的 wrap-up
//    请求，断言 mock 收到的请求不含 tools。
// B5 取消：AbortController 在工具执行中触发，断言 mock.requests 数量不再增长、
//    execute 收到的 signal 已 aborted、无未处理 rejection。
// B6 外部历史注入：构造 legacy 风格历史（含 tool_use/tool_result 对），转换为
//    pi 消息后 agent.state.messages = [...]，跑一轮，断言 mock 收到的
//    messages 与注入的一致（顺序、role、工具块结构不丢失）。
```

每个场景都要完整实现（上面注释是规格，代码逐条写出），跑不通的 API 名对照 `node_modules/@earendil-works/pi-agent-core/dist/` 的类型定义修正。**每项如果 Agent 类做不到，必须再用低级 `agentLoop()` 试一次并分开记录**——这是 0B 的核心问题（能力在哪一层）。

- [ ] **Step 2: 运行并填能力矩阵**

Run: `npx tsx src/scenarios.ts all`

`REPORT.md` 模板：

```markdown
# Phase 0B 能力矩阵 — pi-agent-core 控制面

- pi-agent-core 版本 / 运行日期：

| 能力 | Agent 类 | agentLoop | 证据/备注 |
|---|---|---|---|
| B1 事件→legacy SSE 可重组 | | | |
| B2 turn 边界同步屏障 | | | |
| B3 tool results 后注入非持久化 reminder | | | |
| B4 预算终止 + 独立无工具 wrap-up | | | |
| B5 取消干净（无泄漏请求/回调） | | | |
| B6 外部历史注入保真 | | | |

## 通过标准
B1/B5/B6 + (B2、B3、B4 至少在某一层全部可行) ⇒ 0B PASS（并注明用哪一层）。
B2/B3/B4 任一在两层都不可行 ⇒ 0B FAIL ⇒ 走备选：pi-ai + 自研 loop，或 fork 加 hooks。

## 结论：0B PASS（Agent类 / agentLoop） / FAIL（备选路径：…）
```

- [ ] **Step 3: Commit**

```bash
git add spikes/pi-agent-core/src/scenarios.ts spikes/pi-agent-core/REPORT.md
git commit -m "spike(0B): pi-agent-core control-plane capability matrix — <verdict>"
```

---

### Task 11: GATE.md —— go/no-go 决策落地

**Files:**
- Create: `docs/superpowers/plans/GATE.md`

**Interfaces:**
- Consumes: 两份 REPORT.md + Phase -1 测试基线。
- Produces: 后续 Phase 1 计划的输入（engine 形态三选一）。

- [ ] **Step 1: 按决策树写结论**

```markdown
# v2 引擎决策记录（GATE）

日期：      决策人：

## 输入
- Phase -1：tests/ 基线 <N> 个用例全绿（commit <sha>）
- Phase 0A：spikes/pi-provider/REPORT.md ⇒ PASS/FAIL
- Phase 0B：spikes/pi-agent-core/REPORT.md ⇒ PASS(层)/FAIL

## 决策树
- 0A FAIL ⇒ **停止**：pi 全家不可用于 DashScope 生产，维持现架构，仅回收
  改进项（Pydantic schema、contextvar reset、DashScope caching 实测开启）。
- 0A PASS + 0B PASS ⇒ **GO**：engine = pi-agent-core（Agent 类或 agentLoop，
  按矩阵注明），编写 Phase 1（防腐层+codec）计划。
- 0A PASS + 0B FAIL ⇒ **GO(变体)**：engine = pi-ai + 自研 TypeScript loop
  （移植 app/agent.py 语义），或 fork pi-agent-core 加 turn hooks —— 二选一，
  在此记录选择与理由。

## 结论
engine 形态：
遗留风险（从 Codex 评审三大风险逐条对照现状）：
1. checkpoint/turn barrier/wrap-up 的实现层：
2. 每 turn 临时 Agent + SQLite 真相源的落实方式：
3. legacy SSE/持久化语义的覆盖度（哪些 golden 还没有对应的 Node 侧测试）：
```

- [ ] **Step 2: 汇报决策**

把 GATE.md 结论 + 两份 REPORT.md 摘要发给决策人确认后，才开始编写 Phase 1 计划文档。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/GATE.md
git commit -m "docs: pi-migration gate decision — <GO|GO-variant|STOP>"
```

---

## Self-Review 记录

- **Spec 覆盖**：Codex 评审的三大风险 → 风险1（checkpoint 可实现性）由 Task 5 定规范 + Task 10 B2–B4 验证 + Task 11 决策兜底；风险2（常驻 Agent）写入 Global Constraints 并由 0B 场景全部采用"每场景新建 Agent"体现；风险3（SSE/持久化语义复杂度）由 Task 4/6 冻结、Task 10 B1/B6 对照。0A/0B 双门、绞杀者排序、工具面修正（calculator/list_directory 纳入、search_repo_issues 排除）均已落入约束或路线图。
- **占位符检查**：Task 10 的 B1–B6 以"规格注释 + 实现要求"给出而非成品代码——这是 spike 的本质（API 名以 v0.x 实物为准），已给出可判定的 PASS/FAIL 标准与对照规范，不属于 TBD。其余任务代码完整。
- **类型一致性**：`FakeLLM.calls`/`text_turn`/`tool_turn` 在 Task 4/5 的用法与 Task 1 定义一致；`startMock` 返回 `{url, requests, close}` 与 Task 10 用法一致；`settings.max_tool_iterations=8` 与 midpoint 触发条件（`max>=6 && next==max//2`，endgame 覆盖 remaining 1..3）经人工推演：midpoint 在 call index 4、endgame 在 calls 6/7 —— 与 Task 5 断言一致。
