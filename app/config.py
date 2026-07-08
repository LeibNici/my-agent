"""Configuration management — loads from .env or environment variables."""

import os
import secrets
from pydantic_settings import BaseSettings

_SECRET_FILE = os.path.join(os.path.dirname(__file__), "..", ".jwt_secret")


def _load_or_create_jwt_secret() -> str:
    """Load JWT secret from file, or generate and persist a new one.

    Uses an exclusive create (O_EXCL) so that if multiple worker processes
    race on first boot, only one wins the write — the losers re-read the
    winner's file instead of each keeping their own different in-memory secret.
    """
    try:
        with open(_SECRET_FILE, "r") as f:
            secret = f.read().strip()
            if secret:
                return secret
    except FileNotFoundError:
        pass
    secret = secrets.token_urlsafe(32)
    try:
        fd = os.open(_SECRET_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secret)
    except FileExistsError:
        # Another process won the race — use what it wrote.
        try:
            with open(_SECRET_FILE, "r") as f:
                secret = f.read().strip() or secret
        except OSError:
            pass
    except OSError:
        pass  # fallback to ephemeral if we can't write
    return secret


class AnthropicSettings(BaseSettings):
    """Anthropic/LLM provider settings."""
    api_key: str = ""
    base_url: str = "https://api.anthropic.com"
    model: str = "claude-sonnet-4-20250514"
    max_tokens: int = 4096
    system_prompt: str = "You are a helpful AI assistant with access to various tools."
    max_tool_iterations: int = 10

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_prefix": "ANTHROPIC_",
        "extra": "ignore",
    }


class AppSettings(BaseSettings):
    """Application-level settings."""
    jwt_secret: str = _load_or_create_jwt_secret()
    token_expire_hours: int = 24
    admin_username: str = "admin"
    admin_password: str = "admin123"  # change after first login!
    repos_dir: str = "/tmp/agent-repos"
    github_token: str = ""  # GitHub API token for issue submission

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_prefix": "APP_",
        "extra": "ignore",
    }


# Singleton instances
settings = AnthropicSettings()
app_settings = AppSettings()
