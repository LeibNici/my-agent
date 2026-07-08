"""Issue tool — draft an issue, then submit it to whichever tracker actually
hosts the repo (GitHub's REST API for github.com repos; a self-hosted
GitLab-compatible API for everything else, e.g. internal git servers)."""

from urllib.parse import quote, urlparse

import httpx

from app.config import app_settings
from app.repo_sync import _validate_url
from app.tools.registry import tool


@tool("Generate an issue draft with title, body (markdown), and labels. This creates a preview for the user to confirm before submission. Structure the body for the development team with these sections: 问题描述 (what is wrong and how it manifests), 代码位置 (the specific file/function/line, from your investigation), 影响 (who/what is affected), and 修复建议 (a concrete suggested fix — you already did the root-cause analysis, so state where and how to change it in words or a few illustrative lines, never a full rewritten file).")
def draft_issue(title: str, body: str, labels: str = "bug") -> dict:
    """Create an Issue draft. Returns a structured draft for the frontend confirmation card."""
    label_list = [l.strip() for l in labels.split(",") if l.strip()]

    return {
        "type": "issue_draft",
        "title": title,
        "body": body,
        "labels": label_list,
    }


def _parse_owner_repo(repo_url: str) -> tuple[str, str] | None:
    url = repo_url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    parts = url.split("/")
    if len(parts) < 2:
        return None
    return parts[-2], parts[-1]


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
            headers={
                "Authorization": f"token {token}",
                "Accept": "application/vnd.github.v3+json",
            },
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
    if not cred_token:
        return {"error": "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitLab API, not just to clone)"}

    # Same SSRF guard clone/pull already apply — a repo URL pointing at an
    # internal/loopback/link-local host shouldn't get an authenticated
    # request fired at it just because it's stored on a repo record.
    url_error = _validate_url(repo_url)
    if url_error:
        return {"error": url_error}

    parsed = urlparse(repo_url)
    path = parsed.path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if not path:
        return {"error": f"Cannot parse project path from URL: {repo_url}"}

    project_id = quote(path, safe="")
    api_url = f"{parsed.scheme}://{parsed.netloc}/api/v4/projects/{project_id}/issues"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            api_url,
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


async def submit_repo_issue(repo: dict, title: str, body: str, labels: list[str]) -> dict:
    """Dispatch to the right issue tracker API based on the repo's host."""
    host = (urlparse(repo["url"]).hostname or "").lower()
    if host in ("github.com", "www.github.com"):
        return await submit_github_issue(repo["url"], title, body, labels)
    return await submit_gitlab_issue(repo["url"], repo.get("cred_token"), title, body, labels)
