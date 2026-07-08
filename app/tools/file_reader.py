"""File reader tool — read local files with per-user permission checks."""

import os
from app.tools.registry import tool, tool_context
from app.config import app_settings

# Default workspace (project root)
WORKSPACE_DIR = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _get_allowed_paths() -> list[str]:
    """Get the current user's allowed repo paths from tool context ONLY.
    No fallback, no global enumeration — deny-by-default."""
    ctx = tool_context.get()
    paths = ctx.get("allowed_repo_paths", [])
    return [os.path.realpath(p) for p in paths if p]


def _is_path_allowed(path: str) -> tuple[bool, str]:
    """Check if a path is within allowed directories."""
    real_path = os.path.realpath(path)

    # Block all dotfiles/dotdirs by default
    parts = real_path.split(os.sep)
    for part in parts:
        if part.startswith(".") and part not in (".", ".."):
            return False, f"Access denied: dotfiles/directories are not readable ('{part}')"

    # Get user's allowed paths from context
    allowed_paths = _get_allowed_paths()

    # No permissions = no access (deny-by-default, no fallback)
    if not allowed_paths:
        return False, "Access denied: you have no repository permissions assigned"

    # Check if path is under any allowed directory
    for allowed in allowed_paths:
        if real_path.startswith(allowed + os.sep) or real_path == allowed:
            return True, ""

    return False, f"Access denied: path is outside your assigned repositories"


@tool("Read the contents of a file at the given path. Supports text files. Only files within your assigned repositories are accessible.")
def file_reader(path: str, max_lines: int = 200) -> str:
    """Read a file and return its contents."""
    path = os.path.expanduser(path)

    # Security: validate path
    allowed, reason = _is_path_allowed(path)
    if not allowed:
        return f"Error: {reason}"

    if not os.path.exists(path):
        return f"Error: File not found: {path}"

    if not os.path.isfile(path):
        return f"Error: Not a file: {path}"

    size = os.path.getsize(path)
    if size > 5 * 1024 * 1024:  # 5MB limit
        return f"Error: File too large ({size / 1024 / 1024:.1f}MB). Max 5MB."

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = []
            for i, line in enumerate(f):
                if i >= max_lines:
                    lines.append(f"\n... (truncated at {max_lines} lines, file has more)")
                    break
                lines.append(line)
            return "".join(lines)
    except Exception as e:
        return f"Error reading file: {e}"
