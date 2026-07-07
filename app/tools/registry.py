"""Tool registry — register tools with @tool decorator, auto-generate Anthropic schemas."""

from __future__ import annotations

import inspect
import json
from typing import Any, Callable, get_type_hints

# Global tool registry
_TOOLS: dict[str, dict[str, Any]] = {}
_HANDLERS: dict[str, Callable] = {}


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


async def execute_tool(name: str, input_data: dict) -> str:
    """Execute a registered tool by name with the given input."""
    if name not in _HANDLERS:
        return json.dumps({"error": f"Unknown tool: {name}"})

    handler = _HANDLERS[name]
    try:
        result = handler(**input_data)
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
