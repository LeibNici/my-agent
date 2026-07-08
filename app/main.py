"""FastAPI application — routes, auth, SSE streaming, static file serving."""

from __future__ import annotations

import json
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
    # Sync all repos on startup
    from app.database import list_repos
    from app.repo_sync import sync_all_repos
    repos = await list_repos()
    if repos:
        print("Syncing repositories...")
        await sync_all_repos(repos)
    yield


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

@app.post("/api/auth/login", response_model=LoginResponse)
async def login(req: LoginRequest):
    user = await get_user_by_username(req.username)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="Account disabled")
    token = create_token(user["id"], user["username"], user["role"])
    return LoginResponse(
        token=token,
        user=UserInfo(id=user["id"], username=user["username"], role=user["role"]),
    )


@app.get("/api/auth/me")
async def get_me(user: dict = Depends(get_current_user)):
    return UserInfo(id=user["id"], username=user["username"], role=user["role"])


# ==================== User Repos ====================

@app.get("/api/repos")
async def api_user_repos(user: dict = Depends(get_current_user)):
    if user["role"] == "admin":
        from app.database import list_repos
        return await list_repos()
    return await get_user_repos(user["id"])


# ==================== Chat (SSE streaming) ====================

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
    elif current_user["role"] != "admin" and session.get("owner_id") != current_user["id"]:
        yield {"event": "error", "data": json.dumps({"message": "Access denied"})}
        yield {"event": "done", "data": json.dumps({"session_id": None, "text": ""})}
        yield {"event": "end", "data": ""}
        return

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
        allowed_repo_paths = [
            r["local_path"] for r in all_repos
            if r.get("local_path") and r["id"] == req.repo_id
        ]
    else:
        allowed_repo_paths = [r["local_path"] for r in all_repos if r.get("local_path")]

    full_text = ""
    try:
        async for event in agent.run(
            messages,
            active_skills=req.active_skills,
            allowed_repo_paths=allowed_repo_paths,
        ):
            if event.type == "text_delta":
                full_text += event.data["text"]
                yield {"event": "text", "data": json.dumps(event.data, ensure_ascii=False)}
            elif event.type == "tool_use":
                yield {"event": "tool_use", "data": json.dumps(event.data, ensure_ascii=False)}
            elif event.type == "tool_result":
                yield {"event": "tool_result", "data": json.dumps(event.data, ensure_ascii=False)}
            elif event.type == "done":
                success = event.data.get("success", True)
                if success:
                    for exchange in event.data.get("tool_exchanges", []):
                        await add_message(session_id, "assistant", exchange["assistant"])
                        await add_message(session_id, "user", exchange["results"])
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


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: str, user: dict = Depends(get_current_user)):
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if user["role"] != "admin" and session.get("owner_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
    messages = await get_messages(session_id)
    return {"session": session, "messages": messages}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, user: dict = Depends(get_current_user)):
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if user["role"] != "admin" and session.get("owner_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Access denied")
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
    import httpx
    from app.database import get_repo

    if not app_settings.github_token:
        raise HTTPException(status_code=500, detail="GitHub token not configured (set APP_GITHUB_TOKEN)")

    # Verify repo exists and user has permission
    repo = await get_repo(req.repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    if user["role"] != "admin":
        user_repos = await get_user_repos(user["id"])
        if not any(r["id"] == req.repo_id for r in user_repos):
            raise HTTPException(status_code=403, detail="Access denied to this repository")

    # Parse owner/repo from stored URL (not client-supplied)
    url = repo["url"].rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    parts = url.split("/")
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail="Invalid repo URL in database")
    owner, repo_name = parts[-2], parts[-1]

    api_url = f"https://api.github.com/repos/{owner}/{repo_name}/issues"
    headers = {
        "Authorization": f"token {app_settings.github_token}",
        "Accept": "application/vnd.github.v3+json",
    }
    payload = {
        "title": req.title,
        "body": req.body,
        "labels": req.labels,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(api_url, json=payload, headers=headers, timeout=15)

    if resp.status_code not in (200, 201):
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"GitHub API error: {resp.text[:200]}"
        )

    data = resp.json()
    return {
        "ok": True,
        "issue_number": data["number"],
        "issue_url": data["html_url"],
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
