"""Code search tools — search and browse repository code with permission checks."""

import asyncio
import os
import shutil

from app.tools.registry import tool
from app.tools.access import get_allowed_paths, no_access_reason, is_within_allowed_paths

# ripgrep is an order of magnitude faster than grep on large Java/Vue repos
# and skips .gitignore'd + hidden files by default. Resolved once at import;
# falls back to grep where rg isn't installed.
_RG_BIN = shutil.which("rg")


def _validate_repo_path(path: str, allowed_paths: list[str]) -> tuple[bool, str, str]:
    """Validate path is within allowed repos."""
    real_path = os.path.realpath(os.path.expanduser(path))
    if is_within_allowed_paths(real_path, allowed_paths):
        return True, real_path, ""
    return False, real_path, "Access denied: path is outside your assigned repositories"


def _search_argv(keyword: str, file_pattern: str, repo_path: str) -> list[str]:
    """Build the search command. The keyword is always treated as a FIXED
    string (-F): users search for identifiers like `deduct(` or `a[0]`, and
    treating those as regex (the old grep -P) made them hard errors."""
    if _RG_BIN:
        argv = [_RG_BIN, "--line-number", "--no-heading", "--fixed-strings",
                "--max-columns", "300", "--max-columns-preview"]
        if file_pattern and file_pattern != "*":
            argv += ["--glob", file_pattern]
        argv += ["--", keyword, repo_path]
        return argv
    return ["grep", "-rn", "-F", "--include", file_pattern,
            "--exclude-dir=.*", "--exclude=.*",  # never search into dotfiles/dotdirs (.env, .git, .ssh, ...)
            "--", keyword, repo_path]


async def _search_one_repo(repo_path: str, keyword: str, file_pattern: str) -> list[str]:
    if not os.path.isdir(repo_path):
        return []
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *_search_argv(keyword, file_pattern, repo_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        if not stdout:
            return []
        return [line.replace(repo_path + "/", "", 1) for line in stdout.decode(errors="replace").strip().split("\n")]
    except asyncio.TimeoutError:
        if proc is not None:
            proc.kill()
            await proc.wait()
        return [f"(search timed out for {os.path.basename(repo_path)})"]
    except asyncio.CancelledError:
        # The chat request itself was cancelled (e.g. user hit stop) — kill
        # the search child instead of leaving it running as an orphan.
        if proc is not None:
            proc.kill()
            await proc.wait()
        raise
    except Exception as e:
        return [f"(search error: {e})"]


@tool("Search for a literal keyword or substring in repository code (fixed-string match, NOT regex — "
      "characters like .*, (), [] are matched literally and will not act as wildcards). Returns matching "
      "file paths, line numbers, and content lines. Use exact identifiers, field names, or short literal "
      "phrases copied from the code/UI text. If a search returns no matches, try a different literal "
      "substring (e.g. a shorter fragment or a related term) rather than a regex-style pattern.")
async def code_search(keyword: str, file_pattern: str = "*", max_results: int = 20) -> str:
    """Search repository code for a keyword using grep."""
    allowed_paths = get_allowed_paths()
    if not allowed_paths:
        return no_access_reason(prefix="Error")

    # Search every accessible repo concurrently — a user with several granted
    # repos previously paid the SUM of each repo's grep time (run one at a
    # time); this bounds it to the slowest single repo instead. Results are
    # still assembled in repo order and capped at max_results: tasks all start
    # immediately, but once the cap is hit we stop waiting and cancel the rest
    # instead of blocking on every repo's grep.
    tasks = [
        asyncio.create_task(_search_one_repo(repo_path, keyword, file_pattern))
        for repo_path in allowed_paths
    ]
    results = []
    for i, task in enumerate(tasks):
        results.extend(await task)
        if len(results) >= max_results:
            remaining = tasks[i + 1:]
            for t in remaining:
                t.cancel()
            if remaining:
                await asyncio.gather(*remaining, return_exceptions=True)
            break

    if not results:
        return f"No matches found for '{keyword}' in your repositories."

    return f"Found {len(results)} matches:\n" + "\n".join(results[:max_results])


@tool("List the directory structure of a repository or path. Shows files and folders up to the specified depth. Use '.' to list all accessible repositories.")
def list_directory(path: str = ".", max_depth: int = 3) -> str:
    """List directory structure within allowed repositories."""
    allowed_paths = get_allowed_paths()
    if not allowed_paths:
        return no_access_reason(prefix="Error")

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

    # Skip dotfiles and symlinks — symlinks are never followed, since a committed
    # symlink pointing outside the repo (e.g. to /etc) would otherwise let this
    # walk escape the sandboxed allowed_paths boundary.
    entries = [
        e for e in entries
        if not e.startswith(".") and not os.path.islink(os.path.join(current, e))
    ]
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
