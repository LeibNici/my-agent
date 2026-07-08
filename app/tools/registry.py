"""Tool registry — register tools with @tool decorator, auto-generate Anthropic schemas."""

from __future__ import annotations

import asyncio
import inspect
import json
from contextvars import ContextVar
from typing import Any, Callable, get_type_hints

# Global tool registry
_TOOLS: dict[str, dict[str, Any]] = {}
_HANDLERS: dict[str, Callable] = {}

# Context variable for per-request tool context (e.g., user's allowed repo paths).
# default=None (not a mutable dict) — a dict default would be a single shared object
# returned by every .get() in a context that never called .set().
tool_context: ContextVar[dict | None] = ContextVar("tool_context", default=None)


def _python_type_to_json_schema(py_type: type) -> dict:
    """Convert Python type hints to JSON Schema types."""
    type_map = {
        str: {"type": "string"},
        int: {"type": "integer"},
        float: {"type": "number"},
        bool: {"type": "boolean"},
        list: {"type": "array", "items": {}},
        dict: {"type": "object"},
    }
    return type_map.get(py_type, {"type": "string"})


def tool(description: str | None = None):
    """Decorator to register a function as an agent tool.

    Usage:
        @tool("Calculate a math expression")
        def calculator(expression: str) -> str:
            return str(eval(expression))
    """
    def decorator(func: Callable) -> Callable:
        name = func.__name__
        hints = get_type_hints(func)
        sig = inspect.signature(func)
        doc = description or func.__doc__ or f"Tool: {name}"

        # Build JSON Schema for parameters
        properties = {}
        required = []
        for param_name, param in sig.parameters.items():
            if param_name == "self":
                continue
            py_type = hints.get(param_name, str)
            prop = _python_type_to_json_schema(py_type)
            # Try to extract param description from docstring
            properties[param_name] = prop
            if param.default is inspect.Parameter.empty:
                required.append(param_name)

        schema = {
            "name": name,
            "description": doc,
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        }

        _TOOLS[name] = schema
        _HANDLERS[name] = func
        return func

    return decorator


def get_tools_schema() -> list[dict]:
    """Return all registered tool schemas for the Anthropic API."""
    return list(_TOOLS.values())


async def execute_tool(name: str, input_data: dict, available_tools: list[str] | None = None) -> str:
    """Execute a registered tool by name with the given input.

    available_tools, when given, is the exact tool list offered to the model
    this turn (it may be a skill-restricted subset of every registered tool) —
    echoing it back on an unknown-tool call lets the model self-correct (e.g.
    stop trying to call a file-editing tool that was never offered) instead of
    guessing again or silently giving up.
    """
    if name not in _HANDLERS:
        offered = available_tools if available_tools is not None else list(_HANDLERS.keys())
        return json.dumps({
            "error": f"Unknown tool: {name}. This tool does not exist — it was never offered to you. "
                     f"Tools actually available this turn: {', '.join(sorted(offered))}",
        })

    handler = _HANDLERS[name]
    try:
        if inspect.iscoroutinefunction(handler):
            result = handler(**input_data)
        else:
            # Sync handlers may do blocking I/O (file reads, subprocess calls) —
            # offload to a thread so they don't stall the event loop for other requests.
            result = asyncio.to_thread(handler, **input_data)
        if inspect.isawaitable(result):
            result = await result
        if not isinstance(result, str):
            result = json.dumps(result, ensure_ascii=False, indent=2)
        return result
    except Exception as e:
        return json.dumps({"error": f"{type(e).__name__}: {str(e)}"})


def list_tools() -> list[str]:
    """Return names of all registered tools."""
    return list(_TOOLS.keys())
