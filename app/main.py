"""FastAPI application — routes, auth, SSE streaming, static file serving."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import time
import traceback
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from app.agent import Agent
from app.auth import (
    create_token, hash_password, verify_password, get_current_user,
)
from app.config import settings, app_settings
from app.database import (
    init_db,
    create_session,
    list_sessions,
    list_repos,
    get_session,
    delete_session,
    add_message,
    get_messages,
    update_session_title,
    get_user_by_username,
    create_user,
    get_user_repos,
    mark_session_resolved,
    record_issue_submission,
    get_issue_submissions_for_session,
    record_llm_call_metrics,
    get_message_session_id,
    set_message_feedback,
    get_feedback_for_session,
)
from app.models import (
    ChatRequest, SessionInfo, SkillInfo,
    LoginRequest, LoginResponse, UserInfo,
)
from pydantic import BaseModel
from app.skills.base import list_skills
from app.admin import router as admin_router
from app.repo_sync import mask_url_credentials
from app.tools.access import is_within_allowed_paths
from app.tools.github_issue import submit_repo_issue, search_repo_issues

# Import skills to trigger registration
import app.skills.coder  # noqa: F401
import app.skills.issue_agent  # noqa: F401

# Import tools to trigger registration
import app.tools.calculator  # noqa: F401
import app.tools.file_reader  # noqa: F401
import app.tools.code_search  # noqa: F401
import app.tools.github_issue  # noqa: F401

MAX_MESSAGE_LENGTH = 10000

# Images: kept well under Anthropic's own 10MB (base64) / 20-image-per-request
# limits — this app persists every message (with images) into SQLite on every
# turn, so a conservative cap keeps history rows and DB growth reasonable.
MAX_IMAGES_PER_MESSAGE = 5
MAX_IMAGE_BASE64_CHARS = 6_000_000
MAX_IMAGE_DECODED_MB = round(MAX_IMAGE_BASE64_CHARS * 3 / 4 / 1_000_000, 1)  # base64 -> raw bytes
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _validate_images(images: list) -> str | None:
    """Return an error message if the image attachments are invalid, else None."""
    if len(images) > MAX_IMAGES_PER_MESSAGE:
        return f"Too many images ({len(images)}). Max {MAX_IMAGES_PER_MESSAGE} per message."
    for img in images:
        if img.media_type not in ALLOWED_IMAGE_TYPES:
            return f"Unsupported image type: {img.media_type}. Allowed: {', '.join(sorted(ALLOWED_IMAGE_TYPES))}"
        if len(img.data) > MAX_IMAGE_BASE64_CHARS:
            return f"Image too large (max ~{MAX_IMAGE_DECODED_MB}MB decoded)."
        # Reject anything that isn't well-formed base64 at the boundary — this
        # data later gets interpolated into an `<img src="data:...">` string
        # on the frontend, so malformed input here is a stored-XSS vector,
        # not just a broken image.
        try:
            base64.b64decode(img.data, validate=True)
        except (binascii.Error, ValueError):
            return "Image data is not valid base64."
    return None


async def ensure_admin_user():
    """Create the initial admin user if it doesn't exist."""
    existing = await get_user_by_username(app_settings.admin_username)
    if not existing:
        if app_settings.admin_password == "admin123":
            print("=" * 60)
            print("⚠️  WARNING: Using default admin password 'admin123'!")
            print("   Set APP_ADMIN_PASSWORD in .env for production use.")
            print("=" * 60)
        await create_user(
            app_settings.admin_username,
            hash_password(app_settings.admin_password),
            role="admin",
        )
        print(f"Admin user '{app_settings.admin_username}' created")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await ensure_admin_user()
    # Sync all repos on startup — one repo's failure (bad path, filesystem
    # error, ...) must not prevent the app itself from starting.
    from app.repo_sync import sync_all_repos, periodic_sync_loop
    try:
        repos = await list_repos()
        if repos:
            print("Syncing repositories...")
            await sync_all_repos(repos)
    except Exception as e:
        print(f"  ❌ Startup repo sync failed: {type(e).__name__}: {e}")

    sync_task = asyncio.create_task(periodic_sync_loop(app_settings.repo_sync_interval_minutes))
    yield
    sync_task.cancel()
    try:
        await sync_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="My Agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in app_settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
agent = Agent()
app.include_router(admin_router)


# ==================== Auth ====================

# In-memory login throttle: bounds brute-force attempts per username.
# Per-process only (won't coordinate across multiple workers/replicas), but
# meaningfully raises the cost of a scripted attack against a known username.
_login_attempts: dict[str, list[float]] = {}
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 300


def _check_login_rate_limit(username: str) -> None:
    now = time.time()
    attempts = [t for t in _login_attempts.get(username, []) if now - t < LOGIN_WINDOW_SECONDS]
    if len(attempts) >= LOGIN_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    attempts.append(now)
    _login_attempts[username] = attempts


@app.post("/api/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    _check_login_rate_limit(req.username)
    user = await get_user_by_username(req.username)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="Account disabled")
    _login_attempts.pop(req.username, None)
    token = create_token(user["id"], user["username"], user["role"])
    return LoginResponse(
        token=token,
        user=UserInfo(id=user["id"], username=user["username"], role=user["role"]),
    )


@app.get("/api/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    return UserInfo(id=user["id"], username=user["username"], role=user["role"])


@app.get("/api/config")
async def get_config(user: dict = Depends(get_current_user)):
    """Static client-side limits, kept separate from user identity (auth/me)
    — the frontend reads these instead of hardcoding its own copy that can
    silently drift from the server's actual enforcement."""
    return {
        "max_images_per_message": MAX_IMAGES_PER_MESSAGE,
        "max_image_bytes": int(MAX_IMAGE_BASE64_CHARS * 3 / 4),
    }


# ==================== User Repos ====================

def _public_repo(r: dict) -> dict:
    """Client-safe repo view — omits server filesystem path, masks credentials in the URL."""
    return {
        "id": r["id"],
        "name": r["name"],
        "url": mask_url_credentials(r.get("url", "")),
        "description": r.get("description", ""),
        "branch": r.get("branch"),
        "access_level": r.get("access_level"),
    }


async def _get_visible_repos(user: dict) -> list[dict]:
    """Repos a user can see — every repo for admins, only granted ones
    otherwise. Shared by every route that needs this same admin bypass so
    the rule lives in one place instead of being re-branched per call site."""
    if user["role"] == "admin":
        return await list_repos()
    return await get_user_repos(user["id"])


@app.get("/api/repos")
async def api_user_repos(user: dict = Depends(get_current_user)):
    repos = await _get_visible_repos(user)
    return [_public_repo(r) for r in repos]


# ==================== Chat (SSE streaming) ====================

def _user_owns_session(session: dict, user: dict) -> bool:
    return user["role"] == "admin" or session.get("owner_id") == user["id"]


# Per-session locks so two concurrent requests for the same session_id (double
# submit, two open tabs) can't read the same history and write interleaved turns.
_session_locks: dict[str, asyncio.Lock] = {}


def _get_session_lock(session_id: str) -> asyncio.Lock:
    lock = _session_locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _session_locks[session_id] = lock
    return lock


async def _sse_reject(message: str):
    """The standard 'reject this request' SSE sequence — factored out so
    every early-exit validation in chat_event_stream yields the same
    error/done/end shape instead of each one hand-rolling its own copy."""
    yield {"event": "error", "data": json.dumps({"message": message})}
    yield {"event": "done", "data": json.dumps({"session_id": None, "text": ""})}
    yield {"event": "end", "data": ""}


_HISTORY_IMAGE_PLACEHOLDER = "[历史消息中的截图已省略；如需模型重看，请让用户重新发送图片]"


def _prepare_model_messages(history: list[dict]) -> list[dict]:
    """Shape persisted history into what gets SENT to the model this turn.
    The DB copy is never modified.

    - Image blocks from past turns are replaced with a text placeholder:
      every base64 screenshot would otherwise be re-uploaded on every LLM
      call of every later turn, dominating input cost for image-heavy
      sessions long after the image stopped mattering.
    - History is windowed to the most recent max_history_messages, cutting
      only at safe points: the first kept message must be a plain user turn,
      never an orphaned tool_result relay (the API rejects a tool_result
      whose tool_use was trimmed away) or an assistant message.
    """
    msgs = []
    for m in history:
        content = m["content"]
        if isinstance(content, list):
            content = [
                {"type": "text", "text": _HISTORY_IMAGE_PLACEHOLDER}
                if isinstance(b, dict) and b.get("type") == "image" else b
                for b in content
            ]
        msgs.append({"role": m["role"], "content": content})

    limit = settings.max_history_messages
    if limit and len(msgs) > limit:
        msgs = msgs[-limit:]
        def _is_tool_relay(m: dict) -> bool:
            return isinstance(m["content"], list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in m["content"]
            )
        while msgs and (msgs[0]["role"] != "user" or _is_tool_relay(msgs[0])):
            msgs.pop(0)
    return msgs


async def chat_event_stream(req: ChatRequest, current_user: dict):
    """Generate SSE events for a chat message."""
    if len(req.message) > MAX_MESSAGE_LENGTH:
        async for e in _sse_reject(f"Message too long ({len(req.message)} chars). Max {MAX_MESSAGE_LENGTH}."):
            yield e
        return

    image_error = _validate_images(req.images)
    if image_error:
        async for e in _sse_reject(image_error):
            yield e
        return

    session_id = req.session_id
    if not session_id:
        session_id = await create_session(title="New Chat", owner_id=current_user["id"])

    session = await get_session(session_id)
    if not session:
        session_id = await create_session(title="New Chat", owner_id=current_user["id"])
    elif not _user_owns_session(session, current_user):
        async for e in _sse_reject("Access denied"):
            yield e
        return
    elif session.get("resolved_at"):
        # This thread's task (e.g. an issue submission) is already done —
        # transparently start a fresh session instead of tacking onto a
        # closed one. The client picks up the new id below, the same as
        # when it sends with session_id=None.
        session_id = await create_session(title="New Chat", owner_id=current_user["id"])

    # Tell the client the real session_id right away — not just in the final
    # "done" event. A turn can render an issue-draft card (from a tool_result
    # event) and the user can click "confirm submit" well before "done" ever
    # fires, especially on the first message of a brand-new chat; without
    # this, the client would still have session_id=null at that point and
    # the submission would go out untracked (see submitIssue()/appendIssueCard
    # in web/app.js).
    yield {"event": "session", "data": json.dumps({"session_id": session_id})}

    full_text = ""
    # Text streamed since the last fully-persisted tool exchange — used to save
    # a partial answer if the connection drops before a normal "done" event.
    current_text_buffer = ""
    # Accumulated in memory and flushed in one batch (see record_llm_call_metrics)
    # rather than opening a fresh DB connection per iteration — a turn can now
    # run up to max_tool_iterations (30) LLM calls.
    pending_llm_metrics = []
    async with _get_session_lock(session_id):
        history = await get_messages(session_id)
        messages = _prepare_model_messages(history)
        if req.images:
            user_content = [
                {"type": "image", "source": {"type": "base64", "media_type": img.media_type, "data": img.data}}
                for img in req.images
            ]
            if req.message:
                user_content.append({"type": "text", "text": req.message})
        else:
            user_content = req.message
        messages.append({"role": "user", "content": user_content})
        await add_message(session_id, "user", user_content)

        # Build allowed repo paths — filter by repo_id if specified
        all_repos = await _get_visible_repos(current_user)

        if req.repo_id:
            granted_repos = [r for r in all_repos if r["id"] == req.repo_id]
        else:
            granted_repos = all_repos
        allowed_repo_paths = [r["local_path"] for r in granted_repos if r.get("local_path")]
        # Repos the user is granted but that have never synced successfully —
        # distinct from "no permission" so tools can report the real cause.
        unsynced_repo_names = [r["name"] for r in granted_repos if not r.get("local_path")]
        # The repo this turn is unambiguously about — stamped into issue
        # drafts. Explicit selection wins; a single granted repo also counts.
        active_repo = None
        if len(granted_repos) == 1:
            active_repo = {"id": granted_repos[0]["id"], "name": granted_repos[0]["name"]}

        try:
            async for event in agent.run(
                messages,
                active_skills=req.active_skills,
                allowed_repo_paths=allowed_repo_paths,
                unsynced_repo_names=unsynced_repo_names,
                active_repo=active_repo,
            ):
                if event.type == "text_delta":
                    full_text += event.data["text"]
                    current_text_buffer += event.data["text"]
                    yield {"event": "text", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "tool_use":
                    yield {"event": "tool_use", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "tool_result":
                    yield {"event": "tool_result", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "tool_exchange":
                    # Persist each completed exchange as soon as it happens (not
                    # batched until the final "done") so it survives a later
                    # cancellation or error in this same turn.
                    await add_message(session_id, "assistant", event.data["assistant"])
                    await add_message(session_id, "user", event.data["results"])
                    current_text_buffer = ""
                elif event.type == "llm_metrics":
                    pending_llm_metrics.append({
                        "session_id": session_id, "user_id": current_user["id"],
                        "model": event.data["model"], "iteration": event.data["iteration"],
                        "input_tokens": event.data["input_tokens"], "output_tokens": event.data["output_tokens"],
                        "ttft_ms": event.data["ttft_ms"], "total_ms": event.data["total_ms"],
                    })
                elif event.type == "done":
                    final_message_id = None
                    if event.data.get("success", True):
                        final_text = event.data.get("text", "")
                        if final_text:
                            final_message_id = await add_message(session_id, "assistant", final_text)
                        s = await get_session(session_id)
                        if s and s["title"] == "New Chat":
                            title = req.message[:50] or (
                                f"{len(req.images)} image(s)" if req.images else "New Chat"
                            )
                            await update_session_title(session_id, title)
                    else:
                        # LLM error / max-iterations: save whatever text had
                        # already streamed for this turn instead of losing it.
                        partial_text = event.data.get("text", "")
                        if partial_text:
                            await add_message(session_id, "assistant",
                                               partial_text + "\n\n_（回复未完成：发生错误）_")
                    await record_llm_call_metrics(pending_llm_metrics)
                    pending_llm_metrics = []
                    # message_id lets the client attach 👍/👎 to this answer
                    yield {"event": "done", "data": json.dumps({
                        "session_id": session_id, "text": full_text,
                        "message_id": final_message_id,
                    }, ensure_ascii=False)}
                elif event.type == "error":
                    yield {"event": "error", "data": json.dumps(event.data, ensure_ascii=False)}
        except asyncio.CancelledError:
            # Client disconnected (closed tab, hit Stop, network drop) mid-turn.
            # Completed tool exchanges were already persisted above as they
            # happened; save whatever text had streamed for the turn in
            # progress too, so the session doesn't just silently end with nothing.
            if current_text_buffer:
                await add_message(session_id, "assistant",
                                   current_text_buffer + "\n\n_（回复未完成：连接已中断）_")
            await record_llm_call_metrics(pending_llm_metrics)
            raise
        except Exception as e:
            traceback.print_exc()
            if current_text_buffer:
                await add_message(session_id, "assistant",
                                   current_text_buffer + "\n\n_（回复未完成：发生错误）_")
            await record_llm_call_metrics(pending_llm_metrics)
            yield {"event": "error", "data": json.dumps({
                "message": f"Internal error: {type(e).__name__}: {str(e)}"
            }, ensure_ascii=False)}
            yield {"event": "done", "data": json.dumps({
                "session_id": session_id, "text": full_text,
            }, ensure_ascii=False)}
    yield {"event": "end", "data": ""}


@app.post("/api/chat")
async def chat(req: ChatRequest, user: dict = Depends(get_current_user)):
    return EventSourceResponse(chat_event_stream(req, user))


# ==================== Sessions ====================

@app.get("/api/sessions")
async def api_list_sessions(user: dict = Depends(get_current_user)) -> list[SessionInfo]:
    owner_id = None if user["role"] == "admin" else user["id"]
    rows = await list_sessions(owner_id=owner_id)
    return [SessionInfo(**r) for r in rows]


async def get_owned_session(session_id: str, user: dict = Depends(get_current_user)) -> dict:
    """Dependency: fetch a session, 404/403ing if it doesn't exist or isn't owned by this user."""
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not _user_owns_session(session, user):
        raise HTTPException(status_code=403, detail="Access denied")
    return session


@app.get("/api/sessions/{session_id}")
async def api_get_session(
    session_id: str,
    session: dict = Depends(get_owned_session),
    user: dict = Depends(get_current_user),
):
    # Independent reads (each opens its own DB connection) — run concurrently
    # instead of paying sequential round-trips.
    messages, issue_submissions, feedback = await asyncio.gather(
        get_messages(session_id),
        get_issue_submissions_for_session(session_id),
        get_feedback_for_session(session_id, user["id"]),
    )
    return {
        "session": session, "messages": messages,
        "issue_submissions": issue_submissions,
        "feedback": feedback,  # {message_id: rating} for the current user
    }


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, session: dict = Depends(get_owned_session)):
    await delete_session(session_id)
    # _session_locks otherwise grows for the life of the process — one entry
    # per session ever created, never removed. Deletion is the one point
    # where we know for certain the lock will never be needed again.
    _session_locks.pop(session_id, None)
    return {"ok": True}


# ==================== Skills ====================

@app.get("/api/skills")
async def api_list_skills(user: dict = Depends(get_current_user)) -> list[SkillInfo]:
    skills = list_skills()
    return [
        SkillInfo(name=s.name, description=s.description, tools=s.tool_names, active=False)
        for s in skills.values()
    ]


# ==================== Message feedback ====================

class FeedbackRequest(BaseModel):
    session_id: str
    message_id: int
    rating: int  # 1 = 👍, -1 = 👎


@app.post("/api/feedback")
async def api_set_feedback(req: FeedbackRequest, user: dict = Depends(get_current_user)):
    if req.rating not in (1, -1):
        raise HTTPException(status_code=400, detail="rating must be 1 or -1")
    session = await get_session(req.session_id)
    if not session or not _user_owns_session(session, user):
        raise HTTPException(status_code=403, detail="Access denied")
    # The message must actually belong to the claimed session — otherwise a
    # crafted request could rate arbitrary messages across sessions.
    if await get_message_session_id(req.message_id) != req.session_id:
        raise HTTPException(status_code=404, detail="Message not found in this session")
    await set_message_feedback(req.message_id, req.session_id, user["id"], req.rating)
    return {"ok": True}


# ==================== Code viewing ====================

CODE_VIEW_MAX_BYTES = 2 * 1024 * 1024
CODE_VIEW_MAX_LINES = 3000


@app.get("/api/code/file")
async def api_view_code(path: str, user: dict = Depends(get_current_user)):
    """Read a file for the in-chat code viewer. The path is repo-relative
    (as the agent cites it, e.g. `wms/scan/ScanService.java`); it is resolved
    against each repo the user is granted, with the same containment and
    dotfile rules as the file_reader tool."""
    if not path or len(path) > 500:
        raise HTTPException(status_code=400, detail="Invalid path")
    for part in path.split("/"):
        if part.startswith(".") and part not in (".", ".."):
            raise HTTPException(status_code=403, detail="Dotfiles are not viewable")

    repos = await _get_visible_repos(user)
    for repo in repos:
        root = repo.get("local_path")
        if not root:
            continue
        root = os.path.realpath(root)
        candidate = os.path.realpath(os.path.join(root, path))
        if not is_within_allowed_paths(candidate, [root]):
            continue
        if not os.path.isfile(candidate):
            continue
        if os.path.getsize(candidate) > CODE_VIEW_MAX_BYTES:
            raise HTTPException(status_code=413, detail="File too large to view")
        with open(candidate, "r", encoding="utf-8", errors="replace") as f:
            lines = []
            truncated = False
            for i, line in enumerate(f):
                if i >= CODE_VIEW_MAX_LINES:
                    truncated = True
                    break
                lines.append(line)
        return {
            "repo": repo["name"],
            "path": path,
            "content": "".join(lines),
            "truncated": truncated,
        }
    raise HTTPException(status_code=404, detail="File not found in your repositories")


# ==================== Issues ====================

class IssueSubmitRequest(BaseModel):
    repo_id: int
    title: str
    body: str
    labels: list[str] = []
    session_id: str | None = None
    draft_tool_use_id: str | None = None


@app.post("/api/issues/submit")
async def submit_issue(req: IssueSubmitRequest, user: dict = Depends(get_current_user)):
    """Submit a confirmed issue — to GitHub if the repo is on github.com, or to
    the repo's own self-hosted GitLab-compatible instance otherwise (see
    app.tools.github_issue.submit_repo_issue for the host-based dispatch)."""
    from app.database import get_repo

    # Verify repo exists and user has at least write access
    repo = await get_repo(req.repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    if user["role"] != "admin":
        user_repos = await get_user_repos(user["id"])
        perm = next((r for r in user_repos if r["id"] == req.repo_id), None)
        if not perm:
            raise HTTPException(status_code=403, detail="Access denied to this repository")
        if perm.get("access_level") not in ("write", "admin"):
            raise HTTPException(status_code=403, detail="Write access required to submit issues")

    if req.session_id:
        session = await get_session(req.session_id)
        if not session or not _user_owns_session(session, user):
            raise HTTPException(status_code=403, detail="Access denied to this session")
        if session.get("resolved_at"):
            raise HTTPException(status_code=409, detail="This session has already been resolved — an issue was already filed from it. Start a new session to submit another.")

    # The tracker records the issue author as the owner of the stored API
    # token, not the platform user who confirmed submission — so stamp the
    # actual reporter into the body where the dev team can see it.
    body = f"{req.body}\n\n---\n\n**提报人**: {user['username']}（经内部代码助手确认后提交）"

    # Submits against the stored repo URL/credentials (not client-supplied)
    # via the shared tool implementation
    result = await submit_repo_issue(repo, req.title, body, req.labels)
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])

    if req.session_id:
        # This is the only place the real submission outcome (issue number,
        # URL, who filed it) is durably recorded — chat history only ever
        # showed the draft card live, and never remembered whether it was
        # actually filed. Persist the SAME `body` that was actually posted
        # (with the reporter stamp), not the unstamped draft, so this record
        # can't drift from what's really on the tracker. Also close out the
        # session: its task is done, so the next message on it should start
        # fresh rather than pile on.
        await record_issue_submission(
            req.session_id, req.repo_id, user["id"],
            req.title, body, req.labels,
            result["number"], result["url"],
            req.draft_tool_use_id,
        )
        await mark_session_resolved(req.session_id)

    return {
        "ok": True,
        "issue_number": result["number"],
        "issue_url": result["url"],
    }


class IssueDupCheckRequest(BaseModel):
    repo_id: int
    title: str


@app.post("/api/issues/check-duplicates")
async def check_duplicate_issues(req: IssueDupCheckRequest, user: dict = Depends(get_current_user)):
    """Search the repo's tracker for issues with a similar title, so the
    draft card can warn before a duplicate gets filed. Best-effort: tracker
    errors surface as an empty list, never as a failed request."""
    repos = await _get_visible_repos(user)
    repo = next((r for r in repos if r["id"] == req.repo_id), None)
    if not repo:
        raise HTTPException(status_code=403, detail="Access denied to this repository")
    query = req.title.strip()[:100]
    if not query:
        return {"issues": []}
    return {"issues": await search_repo_issues(repo, query)}


# ==================== Serve frontend ====================

app.mount("/static", StaticFiles(directory="web"), name="static")


@app.get("/")
async def serve_frontend():
    return FileResponse("web/index.html")


@app.get("/login")
async def serve_login():
    return FileResponse("web/login.html")


@app.get("/admin")
async def serve_admin():
    return FileResponse("web/admin.html")
