"""Pydantic data models for API requests/responses and database records."""

from datetime import datetime
from pydantic import BaseModel, Field


# --- API Models ---

class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str
    active_skills: list[str] = Field(default_factory=list)


class SessionInfo(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class SkillInfo(BaseModel):
    name: str
    description: str
    tools: list[str]
    active: bool = False


# --- Internal Models ---

class Message(BaseModel):
    role: str  # "user" | "assistant"
    content: str | list  # str for user, list of content blocks for assistant
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())


class ToolResult(BaseModel):
    tool_use_id: str
    name: str
    result: str
    error: bool = False
