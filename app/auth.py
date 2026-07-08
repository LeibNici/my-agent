"""Authentication module — JWT tokens, password hashing, FastAPI dependencies."""

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.config import app_settings

security = HTTPBearer()

# Token expiration: 24 hours
TOKEN_EXPIRE_HOURS = 24


def hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def create_token(user_id: int, username: str, role: str) -> str:
    """Create a JWT token for the given user."""
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=app_settings.token_expire_hours),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, app_settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token."""
    try:
        payload = jwt.decode(token, app_settings.jwt_secret, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """FastAPI dependency: extract JWT and validate user against DB."""
    payload = decode_token(credentials.credentials)
    user_id = int(payload["sub"])

    # Always verify against DB — catches disabled/deleted users and role changes
    from app.database import get_user_by_id
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User no longer exists")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="Account disabled")

    # Use DB role, not JWT role (handles role changes mid-token)
    return {
        "id": user["id"],
        "username": user["username"],
        "role": user["role"],
    }


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """FastAPI dependency: require admin role."""
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
