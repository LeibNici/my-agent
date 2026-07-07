"""FastAPI application — routes, SSE streaming, static file serving."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from app.agent import Agent
from app.config import settings
from app.database import (
    init_db,
    create_session,
    list_sessions,
    get_session,
    delete_session,
    add_message,
    get_messages,
    update_session_title,
)
from app.models import ChatRequest, SessionInfo, SkillInfo
from app.skills.base import list_skills

# Import skills to trigger registration
import app.skills.coder  # noqa: F401
import app.skills.researcher  # noqa: F401

# Import tools to trigger registration
import app.tools.calculator  # noqa: F401
import app.tools.web_search  # noqa: F401
import app.tools.file_reader  # noqa: F401


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="My Agent", lifespan=lifespan)
agent = Agent()


# --- Chat (SSE streaming) ---

async def chat_event_stream(req: ChatRequest):
    """Generate SSE events for a chat message."""
    # Get or create session
    session_id = req.session_id
    if not session_id:
        session_id = await create_session(title=req.message[:50])

    # Load history
    history = await get_messages(session_id)
    messages = [{"role": m["role"], "content": m["content"]} for m in history]
    messages.append({"role": "user", "content": req.message})

    # Save user message
    await add_message(session_id, "user", req.message)

    # Run agent
    assistant_blocks = []
    full_text = ""

    async for event in agent.run(messages, active_skills=req.active_skills):
        if event.type == "text_delta":
            full_text += event.data["text"]
            yield {"event": "text", "data": json.dumps(event.data, ensure_ascii=False)}

        elif event.type == "tool_use":
            assistant_blocks.append({
                "type": "tool_use",
                "name": event.data["name"],
                "input": event.data["input"],
            })
            yield {"event": "tool_use", "data": json.dumps(event.data, ensure_ascii=False)}

        elif event.type == "tool_result":
            yield {"event": "tool_result", "data": json.dumps(event.data, ensure_ascii=False)}

        elif event.type == "done":
            # Save assistant message
            if assistant_blocks:
                await add_message(session_id, "assistant", assistant_blocks)
            elif full_text:
                await add_message(session_id, "assistant", full_text)

            # Auto-title: use first message if title is still default
            session = await get_session(session_id)
            if session and session["title"] == "New Chat":
                await update_session_title(session_id, req.message[:50])

            yield {"event": "done", "data": json.dumps({
                "session_id": session_id,
                "text": full_text,
            }, ensure_ascii=False)}

        elif event.type == "error":
            yield {"event": "error", "data": json.dumps(event.data, ensure_ascii=False)}

    # Final [DONE] marker
    yield {"event": "end", "data": ""}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    return EventSourceResponse(chat_event_stream(req))


# --- Sessions ---

@app.get("/api/sessions")
async def api_list_sessions() -> list[SessionInfo]:
    rows = await list_sessions()
    return [SessionInfo(**r) for r in rows]


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: str):
    session = await get_session(session_id)
    if not session:
        return {"error": "Session not found"}
    messages = await get_messages(session_id)
    return {"session": session, "messages": messages}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    await delete_session(session_id)
    return {"ok": True}


# --- Skills ---

@app.get("/api/skills")
async def api_list_skills() -> list[SkillInfo]:
    skills = list_skills()
    return [
        SkillInfo(
            name=s.name,
            description=s.description,
            tools=s.tool_names,
            active=False,
        )
        for s in skills.values()
    ]


# --- Serve frontend ---

app.mount("/static", StaticFiles(directory="web"), name="static")


@app.get("/")
async def serve_frontend():
    return FileResponse("web/index.html")
