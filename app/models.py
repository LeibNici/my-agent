"""Pydantic data models for API requests/responses."""

from pydantic import BaseModel, Field


# --- Auth ---

class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    token: str
    user: "UserInfo"

class UserInfo(BaseModel):
    id: int
    username: str
    role: str


# --- Chat ---

class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str
    active_skills: list[str] = Field(default_factory=list)
    repo_id: int | None = None  # selected repo for this chat

class SessionInfo(BaseModel):
    id: str
    title: str
    owner_id: int | None = None
    created_at: str
    updated_at: str

class SkillInfo(BaseModel):
    name: str
    description: str
    tools: list[str]
    active: bool = False


# --- Admin: Users ---

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "user"

class UserUpdate(BaseModel):
    password: str | None = None
    is_active: bool | None = None


# --- Admin: Repos ---

class RepoCreate(BaseModel):
    name: str
    url: str
    description: str = ""

class RepoUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    description: str | None = None


# --- Admin: Permissions ---

class PermissionGrant(BaseModel):
    user_id: int
    repo_id: int
    access_level: str = "read"
