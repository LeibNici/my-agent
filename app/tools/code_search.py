"""Code search tools — search and browse repository code with permission checks."""

import os

from app.tools.registry import tool, tool_context


def _get_allowed_paths() -> list[str]:
    """Get allowed repo paths from tool context."""
    ctx = tool_context.get()
    paths = ctx.get("allowed_repo_paths", [])
    return [os.path.realpath(p) for p in paths if p]


def _validate_repo_path(path: str, allowed_paths: list[str]) -> tuple[bool, str, str]:
    """Validate path is within allowed repos."""
    real_path = os.path.realpath(os.path.expanduser(path))
    for allowed in allowed_paths:
        if real_path.startswith(allowed + os.sep) or real_path == allowed:
            return True, real_path, ""
    return False, real_path, "Access denied: path is outside your assigned repositories"


@tool("Search for a keyword in repository code. Returns matching file paths, line numbers, and content lines. Use this to find relevant code for the user's question.")
async def code_search(keyword: str, file_pattern: str = "*", max_results: int = 20) -> str:
    """Search repository code for a keyword using grep."""
    import asyncio

    allowed_paths = _get_allowed_paths()
    if not allowed_paths:
        return "Error: you have no repository permissions assigned"

    results = []
    for repo_path in allowed_paths:
        if not os.path.isdir(repo_path):
            continue
        try:
            proc = await asyncio.create_subprocess_exec(
                "grep", "-rn", "-P", "--include", file_pattern,
                "--", keyword, repo_path,  # -- prevents flag injection
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            if stdout:
                for line in stdout.decode(errors="replace").strip().split("\n"):
                    clean = line.replace(repo_path + "/", "", 1)
                    results.append(clean)
                    if len(results) >= max_results:
                        break
        except asyncio.TimeoutError:
            results.append(f"(search timed out for {os.path.basename(repo_path)})")
        except Exception as e:
            results.append(f"(search error: {e})")
        if len(results) >= max_results:
            break

    if not results:
        return f"No matches found for '{keyword}' in your repositories."

    return f"Found {len(results)} matches:\n" + "\n".join(results[:max_results])


@tool("List the directory structure of a repository or path. Shows files and folders up to the specified depth. Use '.' to list all accessible repositories.")
def list_directory(path: str = ".", max_depth: int = 3) -> str:
    """List directory structure within allowed repositories."""
    allowed_paths = _get_allowed_paths()
    if not allowed_paths:
        return "Error: you have no repository permissions assigned"

    if path == ".":
        parts = []
        for repo_path in allowed_paths:
            if os.path.isdir(repo_path):
                name = os.path.basename(repo_path)
                tree = _build_tree(repo_path, 0, max_depth)
                parts.append(f"📁 {name}/\n{tree}")
        return "\n\n".join(parts) if parts else "No repositories found."

    ok, real_path, err = _validate_repo_path(path, allowed_paths)
    if not ok:
        return f"Error: {err}"
    if not os.path.isdir(real_path):
        return f"Error: not a directory: {path}"
    return _build_tree(real_path, 0, max_depth)


_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist",
              "build", ".next", ".cache", "target", ".gradle", ".idea", ".vscode"}


def _build_tree(current: str, depth: int, max_depth: int) -> str:
    """Build a directory tree string."""
    if depth >= max_depth:
        return ""

    indent = "  " * depth
    lines = []
    try:
        entries = sorted(os.listdir(current))
    except PermissionError:
        return f"{indent}(permission denied)"

    entries = [e for e in entries if not e.startswith(".")]
    dirs = [e for e in entries if os.path.isdir(os.path.join(current, e)) and e not in _SKIP_DIRS]
    files = [e for e in entries if os.path.isfile(os.path.join(current, e)) and e not in _SKIP_DIRS]

    for d in dirs[:15]:
        lines.append(f"{indent}📁 {d}/")
        sub = _build_tree(os.path.join(current, d), depth + 1, max_depth)
        if sub:
            lines.append(sub)

    for f in files[:25]:
        lines.append(f"{indent}📄 {f}")

    hidden = len(dirs) - min(len(dirs), 15) + len(files) - min(len(files), 25)
    if hidden > 0:
        lines.append(f"{indent}... and {hidden} more")

    return "\n".join(lines)
