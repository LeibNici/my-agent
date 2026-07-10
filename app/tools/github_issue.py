"""Issue tool — draft an issue, then submit it to whichever tracker actually
hosts the repo (GitHub's REST API for github.com repos; a self-hosted
GitLab-compatible API for everything else, e.g. internal git servers)."""

import time
from urllib.parse import quote, urlparse

import httpx

from app.config import app_settings
from app.repo_sync import _validate_url
from app.tools.registry import tool, tool_context

# ==================== Label vocabulary (per-repo, tracker-sourced) ====================
# The tracker's own label list is the canonical vocabulary — after the
# 2026-07 cleanup it holds a deliberate scoped taxonomy (type::/module::/
# priority::/...), and free-form model-invented labels were what degraded it.
# Cached in-process per repo; on fetch failure the stale cache (if any) is
# served so a tracker blip degrades to slightly-old vocabulary, not to
# "no validation".

_LABELS_CACHE: dict[int, tuple[float, list[str]]] = {}
_LABELS_TTL_SECONDS = 600


async def get_repo_labels(repo: dict) -> list[str] | None:
    """Project's current label names, cached. None = vocabulary unavailable
    (GitHub-hosted, fetch failed with no cache, or the fetch came back with
    ZERO labels) — callers should then skip validation rather than reject
    everything. A genuinely empty result is deliberately NOT cached as "the
    real vocabulary is empty": a real GitLab project having zero labels is
    almost always transient (labels not configured yet, a scope/permission
    hiccup on the token) rather than the intended steady state, and caching
    it for the full TTL would silently reject every label on every draft/
    submit for the next 10 minutes even after the underlying cause is fixed."""
    if is_github_hosted(repo):
        return None
    repo_id = repo.get("id")
    cached = _LABELS_CACHE.get(repo_id)
    if cached and time.time() - cached[0] < _LABELS_TTL_SECONDS:
        return cached[1]

    error, base = _gitlab_project_api_base(repo["url"], repo.get("cred_token"))
    if error:
        return cached[1] if cached else None
    names: list[str] = []
    try:
        async with httpx.AsyncClient() as client:
            page = 1
            while True:
                resp = await client.get(
                    f"{base}/labels",
                    params={"per_page": 100, "page": page},
                    headers={"PRIVATE-TOKEN": repo.get("cred_token")},
                    timeout=15,
                )
                if resp.status_code != 200:
                    return cached[1] if cached else None
                batch = resp.json()
                names.extend(l["name"] for l in batch)
                if len(batch) < 100:
                    break
                page += 1
    except Exception:
        return cached[1] if cached else None
    if not names:
        return cached[1] if cached else None
    _LABELS_CACHE[repo_id] = (time.time(), names)
    return names


def normalize_labels(requested: list[str], available: list[str]) -> tuple[list[str], list[str]]:
    """Map requested labels onto the project's real vocabulary.
    Case-insensitive exact match first; then a unique scoped-suffix match
    ('bug' -> 'type::bug', 'MES' -> 'module::MES') so the model's natural
    shorthand still lands on the canonical name. Anything ambiguous or
    unknown is rejected, not invented. Returns (accepted, rejected)."""
    by_lower = {a.lower(): a for a in available}
    suffix_map: dict[str, list[str]] = {}
    for a in available:
        if "::" in a:
            suffix_map.setdefault(a.split("::", 1)[1].strip().lower(), []).append(a)

    accepted: list[str] = []
    rejected: list[str] = []
    for r in requested:
        key = r.strip().lower()
        if not key:
            continue
        hit = by_lower.get(key)
        if hit is None:
            candidates = suffix_map.get(key, [])
            hit = candidates[0] if len(candidates) == 1 else None
        if hit is None:
            rejected.append(r)
        elif hit not in accepted:
            accepted.append(hit)
    return accepted, rejected


@tool("Generate an issue draft with title, expected_behavior, body (markdown), and labels. This creates "
      "a preview for the user to confirm before submission. expected_behavior is a separate REQUIRED field, "
      "not a section inside body — the confirmation card renders it as its own highlighted block above the "
      "rest so the user can catch a wrong assumption before submitting, instead of it being buried inside a "
      "long technical body. State plainly what the correct/expected behavior should be; if you're inferring "
      "it rather than restating something the user said explicitly, say so (e.g. '推测：...，请确认') so the "
      "user knows to double-check it rather than rubber-stamp it. Structure body (markdown) for the "
      "development team with these sections: 问题描述 (what is wrong and how it manifests — the actual/current "
      "behavior), 复现步骤 (preconditions/data state + steps + any具体单号 the user mentioned — include them "
      "verbatim), 代码位置 (the specific file/function/line, from your investigation), 影响 (who/what is "
      "affected), and 修复建议 (a concrete suggested fix — you already did the root-cause analysis, so state "
      "where and how to change it in words or a few illustrative lines, never a full rewritten file). "
      "labels must come from the project's EXISTING label vocabulary — pick one type:: label (type::bug / "
      "type::feature / type::requirement) plus one module:: label (e.g. module::MES, module::APS, module::质量), "
      "optionally priority::P0-P4. Never invent new labels: anything outside the project vocabulary is "
      "dropped automatically (the result will carry a label_note telling you what was rejected).")
async def draft_issue(title: str, expected_behavior: str, body: str, labels: str = "bug") -> dict:
    """Create an Issue draft. Returns a structured draft for the frontend confirmation card."""
    label_list = [l.strip() for l in labels.split(",") if l.strip()]

    # Stamp the repo this draft was investigated against (set per-request in
    # main.py). The card persists it in the tool_result, so submission targets
    # THIS repo even if the user switches the sidebar selection afterwards.
    ctx = tool_context.get() or {}
    active_repo = ctx.get("active_repo") or {}

    # No unambiguous target repo (user has several repos visible and picked no
    # workspace this turn) → refuse rather than emit an unstamped draft whose
    # submission target would silently become "whatever the sidebar happens to
    # be at click time" — which can differ from where the analysis actually
    # found the code.
    if not active_repo.get("id"):
        return {"error": "无法确定 issue 的目标仓库：当前可见多个仓库且本轮未选择工作空间。"
                         "请提醒用户先在左侧 Workspace 中选择目标仓库，然后重新描述问题或让你重新生成草稿。"}

    # Validate labels against the tracker's own vocabulary at DRAFT time, so
    # the confirmation card the user reviews already shows the canonical
    # labels and the model gets immediate feedback on anything it invented —
    # rather than the submit endpoint silently filing a degraded issue later.
    label_note = None
    try:
        from app.database import get_repo
        repo = await get_repo(active_repo["id"])
        available = await get_repo_labels(repo) if repo else None
        if available is not None:
            accepted, rejected = normalize_labels(label_list, available)
            label_list = accepted
            if rejected:
                label_note = (f"以下标签不在项目标签词表中，已忽略: {', '.join(rejected)}。"
                              "如需分类请从项目现有标签中选（type::*/module::*/priority::* 等）。")
    except Exception:
        pass  # vocabulary unavailable — file with the labels as given

    result = {
        "type": "issue_draft",
        "title": title,
        "expected_behavior": expected_behavior,
        "body": body,
        "labels": label_list,
        "repo_id": active_repo.get("id"),
        "repo_name": active_repo.get("name"),
    }
    if label_note:
        result["label_note"] = label_note
    return result


@tool("Preview an action on an ALREADY-FILED issue — add a comment, close it, or reopen it. Use this when a "
      "previously-submitted issue turns out to need correction (the underlying bug/requirement understanding "
      "was wrong, not just something the LLM misread) or turns out invalid/already-resolved — NOT for "
      "reporting a new problem, that's draft_issue. Creates a preview card for the user to confirm before "
      "anything is actually posted to the tracker. issue_number is the tracker's issue number (the user "
      "usually has it — ask them for it if not, there is no issue-search tool available). action is 'comment' (add a note, issue stays "
      "open — for a clarification/correction that doesn't change the outcome), 'close' (add the comment then "
      "close — for invalid/wontfix/already-fixed-elsewhere), or 'reopen' (for a previously-closed issue that "
      "needs revisiting). comment is REQUIRED for all three: always state plainly why — what was previously "
      "misunderstood and what's actually true — since whoever reads the tracker later needs that context as "
      "much as the user confirming now.")
def manage_issue(issue_number: int, action: str, comment: str) -> dict:
    """Create an issue-action draft (comment/close/reopen an existing issue). Returns a structured draft for the frontend confirmation card."""
    if action not in ("comment", "close", "reopen"):
        return {"error": f"Invalid action '{action}' — must be one of: comment, close, reopen"}
    if not comment.strip():
        return {"error": "comment is required — explain why this issue is being commented on/closed/reopened"}

    ctx = tool_context.get() or {}
    active_repo = ctx.get("active_repo") or {}

    # Same guard as draft_issue: acting on issue N is only meaningful within
    # one specific repo's tracker — an unstamped action card could fire at a
    # same-numbered issue in a different project.
    if not active_repo.get("id"):
        return {"error": "无法确定目标仓库：当前可见多个仓库且本轮未选择工作空间。"
                         "请提醒用户先在左侧 Workspace 中选择目标仓库，再执行该操作。"}

    return {
        "type": "issue_action_draft",
        "issue_number": issue_number,
        "action": action,
        "comment": comment,
        "repo_id": active_repo.get("id"),
        "repo_name": active_repo.get("name"),
    }


def _parse_owner_repo(repo_url: str) -> tuple[str, str] | None:
    url = repo_url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    parts = url.split("/")
    if len(parts) < 2:
        return None
    return parts[-2], parts[-1]


def _github_headers(token: str) -> dict:
    """Shared by every GitHub REST call in this module — issue create, issue
    action (comment/close/reopen), and search all use the same auth scheme."""
    return {"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}


def _gitlab_project_api_base(repo_url: str, cred_token: str | None) -> tuple[str | None, str | None]:
    """Returns (error, base_url) — base_url is the bare
    `{scheme}://{host}/api/v4/projects/{id}` URL with no trailing path;
    callers append `/issues`, `/issues/{n}`, `/issues/{n}/notes`, etc.

    Centralizes what used to be three near-identical copies of "check
    credentials, SSRF-validate the URL, strip .git, URL-encode the project
    path" (submit_gitlab_issue, apply_gitlab_issue_action, _search_gitlab_issues)."""
    if not cred_token:
        return (
            "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitLab API, not just to clone)",
            None,
        )
    # Same SSRF guard clone/pull already apply — a repo URL pointing at an
    # internal/loopback/link-local host shouldn't get an authenticated
    # request fired at it just because it's stored on a repo record.
    url_error = _validate_url(repo_url)
    if url_error:
        return url_error, None

    parsed = urlparse(repo_url)
    path = parsed.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not path:
        return f"Cannot parse project path from URL: {repo_url}", None

    project_id = quote(path, safe="")
    return None, f"{parsed.scheme}://{parsed.netloc}/api/v4/projects/{project_id}"


async def submit_github_issue(repo_url: str, title: str, body: str, labels: list[str]) -> dict:
    """Submit an issue to a repo hosted on github.com, via the GitHub REST API.
    Uses the single global APP_GITHUB_TOKEN — unrelated to any repo's own
    clone credentials, since a GitHub PAT scoped for the Issues API is
    typically a different token than a repo-specific clone credential."""
    token = app_settings.github_token
    if not token:
        return {"error": "GitHub token not configured (set APP_GITHUB_TOKEN)"}

    parsed = _parse_owner_repo(repo_url)
    if not parsed:
        return {"error": f"Cannot parse GitHub URL: {repo_url}"}
    owner, repo = parsed

    api_url = f"https://api.github.com/repos/{owner}/{repo}/issues"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            api_url,
            headers=_github_headers(token),
            json={
                "title": title,
                "body": body,
                "labels": labels,
            },
            timeout=30,
        )

        if resp.status_code == 201:
            data = resp.json()
            return {
                "success": True,
                "number": data["number"],
                "url": data["html_url"],
                "title": data["title"],
            }
        else:
            return {
                "error": f"GitHub API error ({resp.status_code}): {resp.text}",
            }


async def submit_gitlab_issue(repo_url: str, cred_token: str | None, title: str, body: str, labels: list[str]) -> dict:
    """Submit an issue to a self-hosted GitLab (or GitLab-API-compatible)
    instance. Reuses the repo's own stored credential (the same token
    configured for cloning it, in 仓库管理) as the API token — a GitLab
    personal access token commonly carries both repository and API scopes,
    unlike GitHub where clone and Issues-API tokens are usually separate."""
    error, base_url = _gitlab_project_api_base(repo_url, cred_token)
    if error:
        return {"error": error}

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{base_url}/issues",
            headers={"PRIVATE-TOKEN": cred_token},
            json={
                "title": title,
                "description": body,
                "labels": ",".join(labels),
            },
            timeout=30,
        )

        if resp.status_code == 201:
            data = resp.json()
            return {
                "success": True,
                "number": data["iid"],
                "url": data["web_url"],
                "title": data["title"],
            }
        else:
            return {
                "error": f"GitLab API error ({resp.status_code}): {resp.text}",
            }


def is_github_hosted(repo: dict) -> bool:
    host = (urlparse(repo["url"]).hostname or "").lower()
    return host in ("github.com", "www.github.com")


async def submit_repo_issue(repo: dict, title: str, body: str, labels: list[str]) -> dict:
    """Dispatch to the right issue tracker API based on the repo's host."""
    if is_github_hosted(repo):
        return await submit_github_issue(repo["url"], title, body, labels)
    return await submit_gitlab_issue(repo["url"], repo.get("cred_token"), title, body, labels)


async def upload_gitlab_attachment(repo: dict, filename: str, content: bytes) -> dict:
    """Upload a file to the repo's GitLab project (POST /projects/:id/uploads)
    and return {"markdown": "![...](...)"} ready to embed in an issue body.
    GitLab-only — GitHub has no equivalent anonymous-upload API, so callers
    should skip attachment for github.com repos rather than call this."""
    error, base = _gitlab_project_api_base(repo["url"], repo.get("cred_token"))
    if error:
        return {"error": error}
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{base}/uploads",
            headers={"PRIVATE-TOKEN": repo.get("cred_token")},
            files={"file": (filename, content)},
            timeout=60,
        )
        if resp.status_code == 201:
            return {"markdown": resp.json().get("markdown")}
        return {"error": f"GitLab upload API error ({resp.status_code}): {resp.text[:200]}"}


# ==================== Actions on an already-filed issue ====================
# Distinct from submit_repo_issue (create-only): comment/close/reopen an
# issue that was filed earlier, for the "the submitted issue turns out to be
# based on a wrong premise, not an LLM slip" case — correcting it in place
# instead of always spawning an unrelated new issue.

async def apply_github_issue_action(repo_url: str, issue_number: int, action: str, comment: str) -> dict:
    token = app_settings.github_token
    if not token:
        return {"error": "GitHub token not configured (set APP_GITHUB_TOKEN)"}
    parsed = _parse_owner_repo(repo_url)
    if not parsed:
        return {"error": f"Cannot parse GitHub URL: {repo_url}"}
    owner, repo = parsed
    headers = _github_headers(token)

    async with httpx.AsyncClient() as client:
        if comment.strip():
            resp = await client.post(
                f"https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments",
                headers=headers, json={"body": comment}, timeout=30,
            )
            if resp.status_code != 201:
                return {"error": f"GitHub comment API error ({resp.status_code}): {resp.text}"}

        if action in ("close", "reopen"):
            resp = await client.patch(
                f"https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}",
                headers=headers, json={"state": "closed" if action == "close" else "open"}, timeout=30,
            )
            if resp.status_code != 200:
                return {"error": f"GitHub update API error ({resp.status_code}): {resp.text}"}
            data = resp.json()
            return {"success": True, "number": data["number"], "url": data["html_url"], "title": data["title"]}

        return {"success": True, "number": issue_number, "url": f"https://github.com/{owner}/{repo}/issues/{issue_number}", "title": None}


async def apply_gitlab_issue_action(repo_url: str, cred_token: str | None, issue_number: int, action: str, comment: str) -> dict:
    error, project_base = _gitlab_project_api_base(repo_url, cred_token)
    if error:
        return {"error": error}
    base_url = f"{project_base}/issues/{issue_number}"
    headers = {"PRIVATE-TOKEN": cred_token}

    async with httpx.AsyncClient() as client:
        if comment.strip():
            resp = await client.post(f"{base_url}/notes", headers=headers, json={"body": comment}, timeout=30)
            if resp.status_code != 201:
                return {"error": f"GitLab note API error ({resp.status_code}): {resp.text}"}

        if action in ("close", "reopen"):
            resp = await client.put(
                base_url, headers=headers,
                json={"state_event": "close" if action == "close" else "reopen"}, timeout=30,
            )
            if resp.status_code != 200:
                return {"error": f"GitLab update API error ({resp.status_code}): {resp.text}"}
            data = resp.json()
            return {"success": True, "number": data["iid"], "url": data["web_url"], "title": data["title"]}

        resp = await client.get(base_url, headers=headers, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            return {"success": True, "number": data["iid"], "url": data["web_url"], "title": data["title"]}
        return {"success": True, "number": issue_number, "url": None, "title": None}


async def apply_repo_issue_action(repo: dict, issue_number: int, action: str, comment: str) -> dict:
    """Dispatch a comment/close/reopen against an already-filed issue to the
    right tracker API based on the repo's host."""
    host = (urlparse(repo["url"]).hostname or "").lower()
    if host in ("github.com", "www.github.com"):
        return await apply_github_issue_action(repo["url"], issue_number, action, comment)
    return await apply_gitlab_issue_action(repo["url"], repo.get("cred_token"), issue_number, action, comment)


# ==================== Duplicate lookup (before submitting) ====================

def _issue_hit(number: int, title: str, url: str, state: str) -> dict:
    return {"number": number, "title": title, "url": url, "state": state}


async def _search_github_issues(repo_url: str, query: str, limit: int) -> list[dict]:
    token = app_settings.github_token
    if not token:
        return []
    parsed = _parse_owner_repo(repo_url)
    if not parsed:
        return []
    owner, repo = parsed
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.github.com/search/issues",
            params={"q": f"repo:{owner}/{repo} is:issue {query}", "per_page": limit},
            headers=_github_headers(token),
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        return [
            _issue_hit(i["number"], i["title"], i["html_url"], i["state"])
            for i in resp.json().get("items", [])
        ]


async def _search_gitlab_issues(repo_url: str, cred_token: str | None, query: str, limit: int) -> list[dict]:
    error, base_url = _gitlab_project_api_base(repo_url, cred_token)
    if error:
        return []
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{base_url}/issues",
            params={"search": query, "in": "title", "per_page": limit, "order_by": "updated_at"},
            headers={"PRIVATE-TOKEN": cred_token},
            timeout=10,
        )
        if resp.status_code != 200:
            return []
        return [
            _issue_hit(i["iid"], i["title"], i["web_url"], i["state"])
            for i in resp.json()
        ]


async def search_repo_issues(repo: dict, query: str, limit: int = 5) -> list[dict]:
    """Search the repo's tracker for issues matching `query` (title text) —
    used to warn about likely duplicates before a draft is submitted.
    Best-effort: any tracker/API failure returns [] rather than blocking the
    draft flow."""
    try:
        host = (urlparse(repo["url"]).hostname or "").lower()
        if host in ("github.com", "www.github.com"):
            return await _search_github_issues(repo["url"], query, limit)
        return await _search_gitlab_issues(repo["url"], repo.get("cred_token"), query, limit)
    except Exception:
        return []
