"""FastAPI application — routes, auth, SSE streaming, static file serving."""

from __future__ import annotations

import asyncio
import json
import re
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
from app.config import app_settings
from app.database import (
    init_db,
    create_session,
    list_sessions,
    get_session,
    delete_session,
    add_message,
    get_messages,
    update_session_title,
    get_user_by_username,
    create_user,
    get_user_repos,
)
from app.models import (
    ChatRequest, SessionInfo, SkillInfo,
    LoginRequest, LoginResponse, UserInfo,
)
from pydantic import BaseModel
from app.skills.base import list_skills
from app.admin import router as admin_router
from app.tools.github_issue import submit_github_issue

# Import skills to trigger registration
import app.skills.coder  # noqa: F401
import app.skills.researcher  # noqa: F401
import app.skills.issue_agent  # noqa: F401

# Import tools to trigger registration
import app.tools.calculator  # noqa: F401
import app.tools.web_search  # noqa: F401
import app.tools.file_reader  # noqa: F401
import app.tools.code_search  # noqa: F401
import app.tools.github_issue  # noqa: F401

MAX_MESSAGE_LENGTH = 10000


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
    from app.database import list_repos
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
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
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


# ==================== User Repos ====================

def _mask_url_credentials(url: str) -> str:
    """Strip any embedded userinfo (user:token@) from a URL before exposing it to clients."""
    return re.sub(r"://[^/@]+@", "://", url or "")


def _public_repo(r: dict) -> dict:
    """Client-safe repo view — omits server filesystem path, masks credentials in the URL."""
    return {
        "id": r["id"],
        "name": r["name"],
        "url": _mask_url_credentials(r.get("url", "")),
        "description": r.get("description", ""),
        "branch": r.get("branch"),
        "access_level": r.get("access_level"),
    }


@app.get("/api/repos")
async def api_user_repos(user: dict = Depends(get_current_user)):
    if user["role"] == "admin":
        from app.database import list_repos
        repos = await list_repos()
    else:
        repos = await get_user_repos(user["id"])
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


async def chat_event_stream(req: ChatRequest, current_user: dict):
    """Generate SSE events for a chat message."""
    if len(req.message) > MAX_MESSAGE_LENGTH:
        yield {"event": "error", "data": json.dumps({
            "message": f"Message too long ({len(req.message)} chars). Max {MAX_MESSAGE_LENGTH}."
        })}
        yield {"event": "done", "data": json.dumps({"session_id": None, "text": ""})}
        yield {"event": "end", "data": ""}
        return

    session_id = req.session_id
    if not session_id:
        session_id = await create_session(title="New Chat", owner_id=current_user["id"])

    session = await get_session(session_id)
    if not session:
        session_id = await create_session(title="New Chat", owner_id=current_user["id"])
    elif not _user_owns_session(session, current_user):
        yield {"event": "error", "data": json.dumps({"message": "Access denied"})}
        yield {"event": "done", "data": json.dumps({"session_id": None, "text": ""})}
        yield {"event": "end", "data": ""}
        return

    full_text = ""
    async with _get_session_lock(session_id):
        history = await get_messages(session_id)
        messages = [{"role": m["role"], "content": m["content"]} for m in history]
        messages.append({"role": "user", "content": req.message})
        await add_message(session_id, "user", req.message)

        # Build allowed repo paths — filter by repo_id if specified
        if current_user["role"] == "admin":
            from app.database import list_repos
            all_repos = await list_repos()
        else:
            all_repos = await get_user_repos(current_user["id"])

        if req.repo_id:
            granted_repos = [r for r in all_repos if r["id"] == req.repo_id]
        else:
            granted_repos = all_repos
        allowed_repo_paths = [r["local_path"] for r in granted_repos if r.get("local_path")]
        # Repos the user is granted but that have never synced successfully —
        # distinct from "no permission" so tools can report the real cause.
        unsynced_repo_names = [r["name"] for r in granted_repos if not r.get("local_path")]

        try:
            async for event in agent.run(
                messages,
                active_skills=req.active_skills,
                allowed_repo_paths=allowed_repo_paths,
                unsynced_repo_names=unsynced_repo_names,
            ):
                if event.type == "text_delta":
                    full_text += event.data["text"]
                    yield {"event": "text", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "tool_use":
                    yield {"event": "tool_use", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "tool_result":
                    yield {"event": "tool_result", "data": json.dumps(event.data, ensure_ascii=False)}
                elif event.type == "done":
                    # Persist any tool exchanges that actually ran, even if the
                    # turn ultimately failed (LLM error / max-iterations) — the
                    # side effects already happened and shouldn't vanish from history.
                    for exchange in event.data.get("tool_exchanges", []):
                        await add_message(session_id, "assistant", exchange["assistant"])
                        await add_message(session_id, "user", exchange["results"])
                    if event.data.get("success", True):
                        final_text = event.data.get("text", "")
                        if final_text:
                            await add_message(session_id, "assistant", final_text)
                        s = await get_session(session_id)
                        if s and s["title"] == "New Chat":
                            await update_session_title(session_id, req.message[:50])
                    yield {"event": "done", "data": json.dumps({
                        "session_id": session_id, "text": full_text,
                    }, ensure_ascii=False)}
                elif event.type == "error":
                    yield {"event": "error", "data": json.dumps(event.data, ensure_ascii=False)}
        except Exception as e:
            traceback.print_exc()
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
async def api_get_session(session_id: str, session: dict = Depends(get_owned_session)):
    messages = await get_messages(session_id)
    return {"session": session, "messages": messages}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, session: dict = Depends(get_owned_session)):
    await delete_session(session_id)
    return {"ok": True}


# ==================== Skills ====================

@app.get("/api/skills")
async def api_list_skills(user: dict = Depends(get_current_user)) -> list[SkillInfo]:
    skills = list_skills()
    return [
        SkillInfo(name=s.name, description=s.description, tools=s.tool_names, active=False)
        for s in skills.values()
    ]


# ==================== Issues ====================

class IssueSubmitRequest(BaseModel):
    repo_id: int
    title: str
    body: str
    labels: list[str] = []


@app.post("/api/issues/submit")
async def submit_issue(req: IssueSubmitRequest, user: dict = Depends(get_current_user)):
    """Submit a confirmed issue to GitHub."""
    from app.database import get_repo

    if not app_settings.github_token:
        raise HTTPException(status_code=500, detail="GitHub token not configured (set APP_GITHUB_TOKEN)")

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

    # Submits against the stored repo URL (not client-supplied) via the shared tool implementation
    result = await submit_github_issue(repo["url"], req.title, req.body, req.labels)
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])

    return {
        "ok": True,
        "issue_number": result["number"],
        "issue_url": result["url"],
    }


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
