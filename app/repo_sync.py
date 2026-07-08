"""Repository sync service — clone and pull git repos to local storage."""

import asyncio
import ipaddress
import os
import shutil
import socket
from urllib.parse import urlparse

from app.config import app_settings

GIT_TIMEOUT_SECONDS = 120

# Per-repo locks so periodic sync, manual sync, and create/update-triggered
# sync can never race each other on the same on-disk checkout.
_repo_locks: dict[int, asyncio.Lock] = {}


def _get_repo_lock(repo_id: int) -> asyncio.Lock:
    lock = _repo_locks.get(repo_id)
    if lock is None:
        lock = asyncio.Lock()
        _repo_locks[repo_id] = lock
    return lock


def get_repo_local_path(repo_id: int) -> str:
    """Get the local filesystem path for a cloned repository."""
    return os.path.join(app_settings.repos_dir, str(repo_id))


def _is_disallowed_host(host: str) -> bool:
    """Reject hosts that resolve to loopback/private/link-local addresses,
    to reduce SSRF exposure from admin-supplied clone URLs."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        try:
            addr = ipaddress.ip_address(socket.gethostbyname(host))
        except (socket.gaierror, OSError):
            return False  # can't resolve — let git itself fail on it
    return addr.is_loopback or addr.is_private or addr.is_link_local or addr.is_reserved


def _validate_url(url: str) -> str | None:
    """Return an error message if the URL is unsafe to sync from, else None."""
    if not url.startswith(("https://", "http://", "git://")):
        return "Invalid URL protocol: only https://, http://, and git:// are allowed"
    host = urlparse(url).hostname
    if host and _is_disallowed_host(host):
        return f"Refusing to sync from internal/private host: {host}"
    return None


async def _run_git(args: list[str], cwd: str | None = None) -> tuple[int, str, str]:
    """Run a git command with a timeout and return (returncode, stdout, stderr).
    The child process is killed both on its own timeout and if the caller
    itself is cancelled (e.g. app shutdown mid-sync) — never left orphaned."""
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=GIT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 1, "", f"git command timed out after {GIT_TIMEOUT_SECONDS}s"
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode, stdout.decode(), stderr.decode()


async def clone_repo(url: str, repo_id: int, branch: str | None = None) -> tuple[bool, str]:
    """Clone a repository to local storage. Returns (success, message).
    If branch is falsy, clones the remote's default branch (HEAD).

    Clones into a temporary directory and only swaps it into place once the
    clone succeeds, so a failed clone (bad branch name, network blip, ...)
    never destroys a previously-working checkout.
    """
    err = _validate_url(url)
    if err:
        return False, err

    local_path = get_repo_local_path(repo_id)
    tmp_path = local_path + ".tmp"

    # Clean up any leftover temp dir from a previous failed attempt
    if os.path.exists(tmp_path):
        shutil.rmtree(tmp_path)

    os.makedirs(app_settings.repos_dir, exist_ok=True)

    clone_args = ["clone", "--depth", "1"]
    if branch:
        clone_args += ["--branch", branch]
    clone_args += [url, tmp_path]

    returncode, stdout, stderr = await _run_git(clone_args)

    if returncode != 0:
        shutil.rmtree(tmp_path, ignore_errors=True)
        return False, f"Clone failed: {stderr.strip()}"

    # Clone succeeded — atomically replace the old checkout (if any) with the new one
    if os.path.exists(local_path):
        shutil.rmtree(local_path)
    os.rename(tmp_path, local_path)

    return True, f"Cloned to {local_path}" + (f" (branch: {branch})" if branch else "")


async def pull_repo(repo_id: int) -> tuple[bool, str]:
    """Pull latest changes for a cloned repository. Returns (success, message)."""
    local_path = get_repo_local_path(repo_id)

    if not os.path.isdir(local_path):
        return False, f"Repository not found at {local_path}"

    returncode, stdout, stderr = await _run_git(["pull", "--ff-only"], cwd=local_path)

    if returncode != 0:
        return False, f"Pull failed: {stderr.strip()}"

    return True, stdout.strip() or "Already up to date"


async def sync_repo(
    url: str, repo_id: int, branch: str | None = None, force_reclone: bool = False,
) -> tuple[bool, str, str]:
    """Clone or pull a repository. Returns (success, message, local_path).

    force_reclone should be set by callers that know the desired (url, branch)
    just changed (e.g. an admin edit) — sync_repo itself no longer tries to
    detect drift by querying git, since that was fragile: branch comparison
    broke on detached HEAD (tag/commit "branches"), and clearing a branch
    back to "default" was silently a no-op. The caller comparing old vs new
    config is a more reliable source of truth than re-deriving it from git.

    If a plain pull fails (e.g. a force-push made it non-fast-forward), this
    self-heals by falling back to a fresh clone — safe because these clones
    are read-only (no tool ever writes into them), so there's no local state
    to lose.
    """
    async with _get_repo_lock(repo_id):
        local_path = get_repo_local_path(repo_id)
        already_cloned = os.path.isdir(os.path.join(local_path, ".git"))

        if already_cloned and not force_reclone:
            success, msg = await pull_repo(repo_id)
            if not success:
                success, msg = await clone_repo(url, repo_id, branch)
        else:
            success, msg = await clone_repo(url, repo_id, branch)

        return success, msg, local_path


async def sync_and_persist(
    repo_id: int, url: str, branch: str | None = None, force_reclone: bool = False,
) -> tuple[bool, str]:
    """Sync a repo and persist its local_path on success. The single place
    that implements "sync then save the result" — startup, the periodic
    loop, and every admin-triggered sync all call this instead of each
    hand-rolling the sync-then-maybe-persist sequence."""
    from app.database import update_repo
    success, msg, local_path = await sync_repo(url, repo_id, branch, force_reclone)
    if success:
        await update_repo(repo_id, local_path=local_path)
    return success, msg


async def sync_all_repos(repos: list[dict]):
    """Sync all repositories. Called at startup and by the periodic sync loop."""
    for repo in repos:
        if not repo.get("url"):
            continue
        success, msg = await sync_and_persist(repo["id"], repo["url"], repo.get("branch"))
        status = "✅" if success else "❌"
        print(f"  {status} [{repo['name']}] {msg}")


async def periodic_sync_loop(interval_minutes: int):
    """Background task: re-sync all repos on a fixed interval until cancelled.
    A falsy interval disables periodic sync entirely (startup/manual sync still work)."""
    if not interval_minutes or interval_minutes <= 0:
        return
    from app.database import list_repos
    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            repos = await list_repos()
            if repos:
                await sync_all_repos(repos)
        except Exception as e:
            print(f"  ❌ periodic repo sync failed: {type(e).__name__}: {e}")
