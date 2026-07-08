"""Repository sync service — clone and pull git repos to local storage."""

import asyncio
import os
import shutil

from app.config import app_settings


def get_repo_local_path(repo_id: int) -> str:
    """Get the local filesystem path for a cloned repository."""
    return os.path.join(app_settings.repos_dir, str(repo_id))


async def _run_git(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


async def clone_repo(url: str, repo_id: int) -> tuple[bool, str]:
    """Clone a repository to local storage. Returns (success, message)."""
    # Validate URL protocol — only allow http(s) and git://
    if not url.startswith(("https://", "http://", "git://")):
        return False, f"Invalid URL protocol: only https://, http://, and git:// are allowed"

    local_path = get_repo_local_path(repo_id)

    # Remove existing directory if present
    if os.path.exists(local_path):
        shutil.rmtree(local_path)

    # Ensure parent directory exists
    os.makedirs(app_settings.repos_dir, exist_ok=True)

    returncode, stdout, stderr = await _run_git(
        ["clone", "--depth", "1", url, local_path]
    )

    if returncode != 0:
        return False, f"Clone failed: {stderr.strip()}"

    return True, f"Cloned to {local_path}"


async def pull_repo(repo_id: int) -> tuple[bool, str]:
    """Pull latest changes for a cloned repository. Returns (success, message)."""
    local_path = get_repo_local_path(repo_id)

    if not os.path.isdir(local_path):
        return False, f"Repository not found at {local_path}"

    returncode, stdout, stderr = await _run_git(["pull", "--ff-only"], cwd=local_path)

    if returncode != 0:
        return False, f"Pull failed: {stderr.strip()}"

    return True, stdout.strip() or "Already up to date"


async def sync_repo(url: str, repo_id: int) -> tuple[bool, str, str]:
    """Clone or pull a repository. Returns (success, message, local_path)."""
    local_path = get_repo_local_path(repo_id)

    if os.path.isdir(os.path.join(local_path, ".git")):
        success, msg = await pull_repo(repo_id)
    else:
        success, msg = await clone_repo(url, repo_id)

    return success, msg, local_path


async def sync_all_repos(repos: list[dict]):
    """Sync all repositories. Called at startup."""
    for repo in repos:
        if not repo.get("url"):
            continue
        repo_id = repo["id"]
        local_path = get_repo_local_path(repo_id)

        # Update local_path in DB if needed
        from app.database import update_repo
        success, msg, path = await sync_repo(repo["url"], repo_id)

        if success and repo.get("local_path") != path:
            await update_repo(repo_id, local_path=path)

        status = "✅" if success else "❌"
        print(f"  {status} [{repo['name']}] {msg}")
