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

class ChatImage(BaseModel):
    media_type: str  # image/jpeg, image/png, image/gif, image/webp
    data: str         # base64-encoded, no "data:...;base64," prefix

class ChatRequest(BaseModel):
    session_id: str | None = None
    message: str
    active_skills: list[str] = Field(default_factory=list)
    repo_id: int | None = None  # selected repo for this chat
    images: list[ChatImage] = Field(default_factory=list)

class SessionInfo(BaseModel):
    id: str
    title: str
    owner_id: int | None = None
    created_at: str
    updated_at: str
    resolved_at: str | None = None

class SkillInfo(BaseModel):
    name: str
    description: str
    tools: list[str]
    active: bool = False


# --- Admin: Users ---

class UserCreate(BaseModel):
    username: str
    password: str = Field(min_length=8)
    role: str = "user"

class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=8)
    is_active: bool | None = None


# --- Admin: Repos ---

class RepoCreate(BaseModel):
    name: str
    url: str
    description: str = ""
    branch: str | None = None  # None/empty = clone the remote's default branch
    cred_username: str | None = None  # for private repos; kept out of the url field
    cred_token: str | None = None     # password / personal-access-token

class RepoUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    description: str | None = None
    branch: str | None = None
    cred_username: str | None = None  # None = leave unchanged; "" = clear
    cred_token: str | None = None     # None = leave unchanged; "" = clear


# --- Admin: Permissions ---

class PermissionGrant(BaseModel):
    user_id: int
    repo_id: int
    access_level: str = "read"
