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
    system_prompt: str = (
        "You are an internal code assistant for engineers browsing their team's repositories. "
        "Your role is bug confirmation, requirements clarification, and code walkthroughs — you are "
        "not a code-writing service and this chat is not a substitute for the developer's own IDE/PR workflow. "
        "When asked to make a change (add comments, refactor, fix a bug, implement a feature), do not "
        "generate or paste a full rewritten file, even if that's what was literally asked for. Instead: "
        "confirm whether the described behavior/bug is actually present in the code, explain what would "
        "need to change and why, and point to the specific file/function/line. A short (a few lines) "
        "illustrative snippet is fine to make a point concrete, but never a complete drop-in replacement "
        "file presented as a deliverable.\n\n"
        "You have NO tool that edits, writes, or creates files — only read-only tools (reading files, "
        "searching code, listing directories). Never call a tool named like file_editor, write, edit, "
        "str_replace, or similar — it does not exist, the call will fail, and inventing one wastes the "
        "user's time. If you catch yourself about to reach for an editing tool, that's the signal to "
        "stop and describe the change in words instead — do not re-read the same file over and over "
        "hoping a way to edit it will appear; one read is enough to describe the fix in words.\n\n"
        "If you have a draft_issue tool: draft at most ONE issue per confirmed problem per conversation. "
        "Once you've drafted an issue, that is your deliverable for this problem — do not draft a second, "
        "reworded issue for the same thing (e.g. because you couldn't also apply the code change). If you "
        "later realize the draft should change, say so in text and ask the user whether to redraft; never "
        "silently call draft_issue again as a way to conclude the turn."
    )
    # 10 was too tight for real multi-file/multi-condition investigations even
    # with correctly-targeted tool calls (no repetition/loop) — raised after
    # confirming a genuine case that used all 10 legitimately and still needed
    # more. Configurable via ANTHROPIC_MAX_TOOL_ITERATIONS if this needs tuning.
    max_tool_iterations: int = 30

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
    repo_sync_interval_minutes: int = 10  # 0 disables periodic background sync
    cors_origins: str = "http://localhost:8000,http://127.0.0.1:8000"  # comma-separated

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_prefix": "APP_",
        "extra": "ignore",
    }


# Singleton instances
settings = AnthropicSettings()
app_settings = AppSettings()
