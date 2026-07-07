"""Anthropic SDK wrapper — supports custom base_url, api_key, model."""

from typing import AsyncIterator

import anthropic

from app.config import settings


class LLMClient:
    """Thin wrapper around the Anthropic async client."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self.api_key = api_key or settings.api_key
        self.base_url = base_url or settings.base_url
        self.model = model or settings.model
        self.client = anthropic.AsyncAnthropic(
            api_key=self.api_key,
            base_url=self.base_url,
        )

    async def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        system: str | None = None,
    ) -> anthropic.types.Message:
        """Send a non-streaming request."""
        kwargs: dict = {
            "model": self.model,
            "max_tokens": settings.max_tokens,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
        if system:
            kwargs["system"] = system
        return await self.client.messages.create(**kwargs)

    async def chat_stream(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        system: str | None = None,
    ) -> AsyncIterator:
        """Send a streaming request, yields SSE events."""
        kwargs: dict = {
            "model": self.model,
            "max_tokens": settings.max_tokens,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
        if system:
            kwargs["system"] = system
        async with self.client.messages.stream(**kwargs) as stream:
            async for event in stream:
                yield event


# Singleton default client
llm = LLMClient()
