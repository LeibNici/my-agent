"""Configuration management — loads from .env or environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    api_key: str = ""
    base_url: str = "https://api.anthropic.com"
    model: str = "claude-sonnet-4-20250514"
    max_tokens: int = 4096
    system_prompt: str = "You are a helpful AI assistant with access to various tools."
    max_tool_iterations: int = 10  # prevent infinite tool-use loops

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_prefix": "ANTHROPIC_",   # ANTHROPIC_API_KEY → api_key
        "extra": "ignore",
    }


settings = Settings()
