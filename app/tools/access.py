"""Shared permission-context helpers for tools that browse permissioned repos.

Both file_reader.py and code_search.py need to know which repo paths the
current user is allowed to touch, and how to explain it when they aren't —
this used to be copy-pasted between the two files and had already drifted.
"""

import os

from app.tools.registry import tool_context


def get_allowed_paths() -> list[str]:
    """Get the current user's allowed repo paths from tool context ONLY.
    No fallback, no global enumeration — deny-by-default."""
    ctx = tool_context.get() or {}
    paths = ctx.get("allowed_repo_paths", [])
    return [os.path.realpath(p) for p in paths if p]


def is_within_allowed_paths(real_path: str, allowed_paths: list[str]) -> bool:
    """The actual repo-boundary test: real_path is allowed if it IS one of
    the allowed roots, or is nested under one. Centralized here — this exact
    check is security-critical and had already drifted once between
    file_reader.py and code_search.py before being pulled out to this module."""
    return any(real_path.startswith(allowed + os.sep) or real_path == allowed for allowed in allowed_paths)


def no_access_reason(prefix: str = "Access denied") -> str:
    """Distinguish 'no permission granted' from 'granted but repo never synced'."""
    ctx = tool_context.get() or {}
    unsynced = ctx.get("unsynced_repo_names", [])
    if unsynced:
        return (
            f"{prefix}: you have permission to " + ", ".join(unsynced) +
            " but it hasn't synced successfully yet (ask an admin to check the repo's clone status)"
        )
    return f"{prefix}: you have no repository permissions assigned"
