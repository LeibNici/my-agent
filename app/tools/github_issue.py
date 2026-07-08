"""GitHub Issue tool — draft and submit issues."""

import httpx

from app.config import app_settings
from app.tools.registry import tool


@tool("Generate a GitHub Issue draft with title, body (markdown), and labels. This creates a preview for the user to confirm before submission. Include technical details in the body for the development team.")
def draft_issue(title: str, body: str, labels: str = "bug") -> dict:
    """Create an Issue draft. Returns a structured draft for the frontend confirmation card."""
    label_list = [l.strip() for l in labels.split(",") if l.strip()]

    return {
        "type": "issue_draft",
        "title": title,
        "body": body,
        "labels": label_list,
    }


async def submit_github_issue(repo_url: str, title: str, body: str, labels: list[str]) -> dict:
    """Submit an issue to GitHub via API. Returns the issue data or error."""
    token = app_settings.github_token
    if not token:
        return {"error": "GITHUB_TOKEN not configured"}

    # Parse owner/repo from URL
    # Support: https://github.com/owner/repo or https://github.com/owner/repo.git
    url = repo_url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    parts = url.split("/")
    if len(parts) < 2:
        return {"error": f"Cannot parse GitHub URL: {repo_url}"}
    owner = parts[-2]
    repo = parts[-1]

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
