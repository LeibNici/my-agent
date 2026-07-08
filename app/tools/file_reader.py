"""File reader tool — read local files with per-user permission checks."""

import os
from app.tools.registry import tool
from app.tools.access import get_allowed_paths, no_access_reason


def _resolve_path(path: str, allowed_paths: list[str]) -> str:
    """Resolve a path to an absolute one. Relative paths (as returned by
    code_search, which strips the repo prefix) are resolved against each
    allowed repo root in turn, matching how they were produced."""
    if os.path.isabs(path):
        return os.path.realpath(path)
    for root in allowed_paths:
        candidate = os.path.realpath(os.path.join(root, path))
        if os.path.exists(candidate):
            return candidate
    return os.path.realpath(path)


def _is_path_allowed(real_path: str, allowed_paths: list[str]) -> tuple[bool, str]:
    """Check if an already-resolved path is within allowed directories."""
    # Block all dotfiles/dotdirs by default
    parts = real_path.split(os.sep)
    for part in parts:
        if part.startswith(".") and part not in (".", ".."):
            return False, f"Access denied: dotfiles/directories are not readable ('{part}')"

    # No permissions = no access (deny-by-default, no fallback)
    if not allowed_paths:
        return False, no_access_reason()

    # Check if path is under any allowed directory
    for allowed in allowed_paths:
        if real_path.startswith(allowed + os.sep) or real_path == allowed:
            return True, ""

    return False, f"Access denied: path is outside your assigned repositories"


@tool("Read the contents of a file at the given path. Supports text files. Only files within your assigned repositories are accessible. Paths may be absolute or relative to a repository root (as returned by code_search). Use start_line together with max_lines to jump to a specific section of a large file (e.g. a line number found via code_search) instead of always reading from the top.")
def file_reader(path: str, max_lines: int = 200, start_line: int = 1) -> str:
    """Read a file and return its contents, starting at start_line (1-indexed)."""
    allowed_paths = get_allowed_paths()
    path = _resolve_path(os.path.expanduser(path), allowed_paths)

    # Security: validate path
    allowed, reason = _is_path_allowed(path, allowed_paths)
    if not allowed:
        return f"Error: {reason}"

    if not os.path.exists(path):
        return f"Error: File not found: {path}"

    if not os.path.isfile(path):
        return f"Error: Not a file: {path}"

    size = os.path.getsize(path)
    if size > 5 * 1024 * 1024:  # 5MB limit
        return f"Error: File too large ({size / 1024 / 1024:.1f}MB). Max 5MB."

    start_index = max(start_line, 1) - 1
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = []
            for i, line in enumerate(f):
                if i < start_index:
                    continue
                if i >= start_index + max_lines:
                    lines.append(f"\n... (truncated at {max_lines} lines from line {start_line}, file has more)")
                    break
                lines.append(line)
            if not lines:
                return f"Error: start_line ({start_line}) is beyond the end of the file."
            return "".join(lines)
    except Exception as e:
        return f"Error reading file: {e}"
