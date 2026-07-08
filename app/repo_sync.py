"""Repository sync service — clone and pull git repos to local storage."""

import asyncio
import base64
import ipaddress
import os
import re
import shutil
import socket
from urllib.parse import urlparse

from app.config import app_settings

GIT_TIMEOUT_SECONDS = 120

# Matches the userinfo component of a URL (the "user:pass@" or "token@" part),
# so it can be stripped out of anything git echoes back to us — git error
# messages routinely include the URL they were trying to reach.
_CREDENTIALS_RE = re.compile(r"://[^/@\s]+@")


def _redact_credentials(text: str) -> str:
    return _CREDENTIALS_RE.sub("://***@", text)


def mask_url_credentials(url: str) -> str:
    """Strip any embedded userinfo (user:token@) from a URL before exposing
    it to any client — shared by both the non-admin and admin repo views, so
    a credential someone pastes directly into the url field (instead of the
    dedicated cred_username/cred_token fields) never gets echoed back either."""
    return _CREDENTIALS_RE.sub("://", url or "")


def _credential_header_args(cred_username: str | None, cred_token: str | None) -> list[str]:
    """Build `-c http.extraheader=...` git args carrying the credential as an
    HTTP Basic Authorization header, for this git invocation only.

    Deliberately NOT embedded in the remote URL: git persists whatever URL
    it's given verbatim into the checkout's `.git/config`, so a credential
    embedded in the URL would sit in plaintext on disk indefinitely across
    every later pull. Passing it as a one-off `-c` config value means the
    on-disk remote stays credential-free — pull_repo re-supplies the header
    fresh on every call instead of relying on anything persisted at clone time.

    If only a token is set (no username), it's used bare as the Basic auth
    username — the convention most hosts (GitHub, GitLab PATs) accept."""
    if not cred_username and not cred_token:
        return []
    userpass = f"{cred_username}:{cred_token}" if cred_username else cred_token
    encoded = base64.b64encode(userpass.encode()).decode()
    return ["-c", f"http.extraheader=Authorization: Basic {encoded}"]

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


async def clone_repo(url: str, repo_id: int, branch: str | None = None, cred_username: str | None = None, cred_token: str | None = None) -> tuple[bool, str]:
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

    git_args = _credential_header_args(cred_username, cred_token)
    git_args += ["clone", "--depth", "1"]
    if branch:
        git_args += ["--branch", branch]
    git_args += [url, tmp_path]  # clean url — never carries embedded credentials

    returncode, stdout, stderr = await _run_git(git_args)

    if returncode != 0:
        shutil.rmtree(tmp_path, ignore_errors=True)
        return False, f"Clone failed: {_redact_credentials(stderr.strip())}"

    # Clone succeeded — atomically replace the old checkout (if any) with the new one
    if os.path.exists(local_path):
        shutil.rmtree(local_path)
    os.rename(tmp_path, local_path)

    return True, f"Cloned to {local_path}" + (f" (branch: {branch})" if branch else "")


async def pull_repo(repo_id: int, cred_username: str | None = None, cred_token: str | None = None) -> tuple[bool, str]:
    """Pull latest changes for a cloned repository. Returns (success, message).
    The checkout's remote URL is always credential-free (clone_repo never
    persists auth into it), so the credential is re-supplied fresh here via
    the same `-c http.extraheader` mechanism as clone, not read from disk."""
    local_path = get_repo_local_path(repo_id)

    if not os.path.isdir(local_path):
        return False, f"Repository not found at {local_path}"

    git_args = _credential_header_args(cred_username, cred_token) + ["pull", "--ff-only"]
    returncode, stdout, stderr = await _run_git(git_args, cwd=local_path)

    if returncode != 0:
        return False, f"Pull failed: {_redact_credentials(stderr.strip())}"

    return True, _redact_credentials(stdout.strip()) or "Already up to date"


async def sync_repo(
    url: str, repo_id: int, branch: str | None = None, force_reclone: bool = False,
    cred_username: str | None = None, cred_token: str | None = None,
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
            success, msg = await pull_repo(repo_id, cred_username, cred_token)
            if not success:
                success, msg = await clone_repo(url, repo_id, branch, cred_username, cred_token)
        else:
            success, msg = await clone_repo(url, repo_id, branch, cred_username, cred_token)

        return success, msg, local_path


async def sync_and_persist(
    repo_id: int, url: str, branch: str | None = None, force_reclone: bool = False,
    cred_username: str | None = None, cred_token: str | None = None,
) -> tuple[bool, str]:
    """Sync a repo and persist its local_path on success. The single place
    that implements "sync then save the result" — startup, the periodic
    loop, and every admin-triggered sync all call this instead of each
    hand-rolling the sync-then-maybe-persist sequence."""
    from app.database import update_repo
    success, msg, local_path = await sync_repo(url, repo_id, branch, force_reclone, cred_username, cred_token)
    if success:
        await update_repo(repo_id, local_path=local_path)
    return success, msg


async def sync_all_repos(repos: list[dict]):
    """Sync all repositories. Called at startup and by the periodic sync loop."""
    for repo in repos:
        if not repo.get("url"):
            continue
        success, msg = await sync_and_persist(
            repo["id"], repo["url"], repo.get("branch"),
            cred_username=repo.get("cred_username"), cred_token=repo.get("cred_token"),
        )
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
