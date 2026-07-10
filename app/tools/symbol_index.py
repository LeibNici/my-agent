"""Symbol index — ctags-backed "where is X defined" lookup for repo code.

code_search.py is grep: it answers "does this literal substring appear
anywhere". It has no notion of a definition vs. a reference, and it cannot
answer "what does this file contain" without reading the whole thing. In
practice this pushes the model toward regex-shaped guesses at symbol names
(which code_search treats as literal text and silently fails to match) and
toward paging through files a few dozen lines at a time to find a function.

This module answers the "where is X defined" / "what's in this file"
questions directly from a ctags index instead, so the model can jump straight
to a definition instead of guessing keywords. The index is a side file next
to each repo checkout (never inside the git working tree, so it can't
conflict with `git pull` and survives independently of repo_sync's
clone/rename dance) and is rebuilt after every successful sync
(app.repo_sync.sync_and_persist calls build_index()).

ctags is an optional OS-level dependency (`apt install universal-ctags`).
Everything here degrades gracefully when it's missing or an index hasn't
been built yet: build_index() no-ops, and the tools return a plain message
instead of raising, so a repo without ctags installed just falls back to
code_search/file_reader.
"""

import asyncio
import json
import os
import shutil

from app.tools.access import get_allowed_paths, is_within_allowed_paths, no_access_reason
from app.tools.file_reader import _resolve_path
from app.tools.registry import tool

# Resolved once at import, like code_search's _RG_BIN.
_CTAGS_BIN = shutil.which("ctags")

# Languages ctags parses natively, plus Vue SFCs mapped onto the TypeScript
# parser: it happily skips over <template>/<style> markup it can't make
# sense of and still pulls out every top-level function/const/interface/type
# declared in the <script> block (verified against this repo's own .vue files).
_CTAGS_ARGS = [
    "-R",
    "--languages=Java,JavaScript,TypeScript",
    "--langmap=TypeScript:+.vue",
    "--fields=+n",
    "--output-format=json",
]

_BUILD_TIMEOUT_SECONDS = 90


def _index_path(repo_path: str) -> str:
    """Sidecar file next to the repo checkout, e.g. /tmp/agent-repos/3.tags.json
    for a checkout at /tmp/agent-repos/3 — deliberately outside repo_path so
    clone_repo's rmtree+rename of repo_path never touches it.

    Always realpath()s its input: build_index() is called with the raw path
    from get_repo_local_path(), while find_symbol/list_file_symbols get theirs
    from access.get_allowed_paths(), which realpaths every entry. Without
    normalizing here too, the writer and the readers compute different sidecar
    paths whenever the repos directory sits behind a symlink (e.g. macOS's
    /tmp -> /private/tmp), and the tools would report "no index" forever even
    though build_index succeeded."""
    return os.path.realpath(repo_path).rstrip(os.sep) + ".tags.json"


async def build_index(repo_path: str) -> bool:
    """(Re)build the symbol index for one repo checkout. Best-effort and
    silent: sync must never fail because indexing failed. Writes to a temp
    file and renames into place so a reader never sees a half-written index.
    Returns True only when a fresh index was actually written — callers use
    this to persist an index_status the admin UI can show."""
    if not _CTAGS_BIN or not os.path.isdir(repo_path):
        return False

    index_path = _index_path(repo_path)
    tmp_path = index_path + ".tmp"
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            _CTAGS_BIN, *_CTAGS_ARGS, "-f", tmp_path, ".",
            cwd=repo_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(proc.communicate(), timeout=_BUILD_TIMEOUT_SECONDS)
        if proc.returncode == 0 and os.path.exists(tmp_path):
            os.replace(tmp_path, index_path)
            return True
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except asyncio.TimeoutError:
        if proc is not None:
            proc.kill()
            await proc.wait()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    return False


# In-process cache keyed by index_path -> (mtime, parsed tags), so a turn
# that calls find_symbol/list_file_symbols several times against the same
# repo (the issue_agent prompt explicitly encourages exactly that) doesn't
# re-read and re-json.loads() a multi-MB file on every call. build_index()
# always replaces the file via os.replace(), which changes its mtime, so a
# rebuilt index is picked up on the next call without any explicit
# invalidation. Module-level and unlocked: worst case under a race is one
# extra redundant parse, never stale/corrupt data (each entry is replaced
# atomically by a plain dict assignment).
_TAGS_CACHE: dict[str, tuple[float, list[dict]]] = {}


def _load_tags(repo_path: str) -> list[dict] | None:
    """None means 'no index available' (ctags missing or never built),
    distinct from an empty list (indexed, genuinely no symbols)."""
    index_path = _index_path(repo_path)
    try:
        mtime = os.path.getmtime(index_path)
    except OSError:
        return None

    cached = _TAGS_CACHE.get(index_path)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    tags = []
    with open(index_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                tag = json.loads(line)
            except json.JSONDecodeError:
                continue
            # ctags --output-format=json also emits ~10 "ptag" pseudo-records
            # per file (JSON_OUTPUT_VERSION, TAG_PROGRAM_AUTHOR, ...) alongside
            # the real "tag" entries — without this filter they masquerade as
            # symbols named e.g. "TAG_PROGRAM_AUTHOR" and can crowd out real
            # substring matches in find_symbol.
            if tag.get("_type") != "tag":
                continue
            tags.append(tag)

    _TAGS_CACHE[index_path] = (mtime, tags)
    return tags


def _format_tag(repo_name: str, tag: dict) -> str:
    scope = f" (in {tag['scope']})" if tag.get("scope") else ""
    return f"{repo_name}/{tag['path']}:{tag.get('line', '?')} [{tag.get('kind', '?')}] {tag['name']}{scope}"


@tool("Find where a symbol (function, class, interface, method, constant...) is DEFINED across your "
      "assigned repositories, using a pre-built ctags index — this is the fast path for 'where is X "
      "defined' instead of guessing at code_search keywords. Matches on the exact symbol name first, "
      "falling back to a substring match if nothing exact is found. Only finds definitions, not call "
      "sites — use code_search to find where a symbol is referenced/called.")
def find_symbol(name: str, max_results: int = 20) -> str:
    allowed_paths = get_allowed_paths()
    if not allowed_paths:
        return no_access_reason(prefix="Error")

    exact_hits: list[str] = []
    substr_hits: list[str] = []
    any_index_found = False
    name_lower = name.lower()

    for repo_path in allowed_paths:
        tags = _load_tags(repo_path)
        if tags is None:
            continue
        any_index_found = True
        repo_name = os.path.basename(repo_path)
        for tag in tags:
            tag_name = tag.get("name", "")
            if tag_name == name:
                exact_hits.append(_format_tag(repo_name, tag))
            elif name_lower in tag_name.lower():
                substr_hits.append(_format_tag(repo_name, tag))

    if not any_index_found:
        return ("No symbol index available for your repositories yet (ctags may not be installed, or "
                "the repo hasn't finished syncing since this feature was added). Fall back to code_search.")

    hits = exact_hits or substr_hits
    if not hits:
        return f"No symbol named '{name}' found in the index. Try code_search for a broader text match."

    label = "exact" if exact_hits else "substring"
    return f"Found {len(hits)} {label} match(es) for '{name}':\n" + "\n".join(hits[:max_results])


@tool("List every top-level symbol (function, class, interface, method, constant...) declared in one "
      "file, with line numbers — use this right after locating a file to see its structure before "
      "deciding which part to read with file_reader, instead of paging through the whole file blind.")
def list_file_symbols(path: str) -> str:
    allowed_paths = get_allowed_paths()
    if not allowed_paths:
        return no_access_reason(prefix="Error")

    # Same relative-path resolution file_reader uses for paths returned by
    # code_search (relative to a repo root, not absolute) — reused rather
    # than re-implemented so the two tools can't silently diverge on it.
    real_path = _resolve_path(path, allowed_paths)
    if not is_within_allowed_paths(real_path, allowed_paths):
        return "Error: Access denied or file not found — path must be within your assigned repositories."
    repo_root = next((r for r in allowed_paths if real_path == r or real_path.startswith(r + os.sep)), None)
    if not repo_root:
        return "Error: Access denied or file not found — path must be within your assigned repositories."

    tags = _load_tags(repo_root)
    if tags is None:
        return ("No symbol index available for this repository yet (ctags may not be installed, or the "
                "repo hasn't finished syncing since this feature was added). Fall back to file_reader.")

    rel_path = os.path.relpath(real_path, repo_root)
    # Drop local `const`/`let` declarations (the TS/Vue parser tags every one
    # of them as kind="constant", whether the enclosing scope is a bare
    # function, a class method, an arrow callback, etc. — checking only
    # scopeKind == "function" missed method-local ones) — they're noise for a
    # structural overview; class fields/methods and interface properties
    # (which carry a different kind) are kept since those are real API
    # surface. A "constant" only ever has no scope at all when it's a
    # genuine top-level declaration.
    matches = [
        t for t in tags
        if t.get("path") == rel_path and not (t.get("kind") == "constant" and t.get("scope"))
    ]
    if not matches:
        return f"No indexed symbols found in {rel_path} (file may not exist, be empty, or be an unindexed language)."

    matches.sort(key=lambda t: t.get("line", 0))
    lines = [f"{t.get('line', '?')}: [{t.get('kind', '?')}] {t['name']}" + (f" (in {t['scope']})" if t.get("scope") else "")
             for t in matches]
    return f"{len(matches)} symbol(s) in {rel_path}:\n" + "\n".join(lines)
