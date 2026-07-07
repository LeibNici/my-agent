"""File reader tool — read local files."""

import os
from app.tools.registry import tool


@tool("Read the contents of a file at the given path. Supports text files up to 10000 lines.")
def file_reader(path: str, max_lines: int = 200) -> str:
    """Read a file and return its contents."""
    path = os.path.expanduser(path)

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
