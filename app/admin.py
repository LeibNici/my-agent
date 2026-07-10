"""Admin API routes — user management, repo management, permission management."""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import hash_password, require_admin
from app.database import (
    create_user, list_users, get_user_by_id, get_user_by_username,
    update_user_password, set_user_active, delete_user,
    create_repo, list_repos, get_repo, update_repo, delete_repo,
    grant_permission, revoke_permission, list_permissions, get_user_repos,
    get_usage_summary, get_usage_by_user, get_recent_llm_calls,
    get_feedback_summary, get_recent_negative_feedback,
    get_semantic_search_stats, get_semantic_search_recent,
    get_issue_tracking_overview,
)
from app.repo_sync import mask_url_credentials
from app.models import (
    UserCreate, UserUpdate,
    RepoCreate, RepoUpdate,
    PermissionGrant,
)

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


async def get_existing_user(user_id: int) -> dict:
    """Dependency: fetch a user, 404ing if it doesn't exist — shared by every
    admin route that operates on a specific user."""
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def get_existing_repo(repo_id: int) -> dict:
    """Dependency: fetch a repo, 404ing if it doesn't exist — shared by every
    admin route that operates on a specific repo."""
    repo = await get_repo(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    return repo


# ==================== Users ====================

@router.get("/users")
async def api_list_users():
    return await list_users()


@router.post("/users")
async def api_create_user(req: UserCreate):
    existing = await get_user_by_username(req.username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")
    user_id = await create_user(req.username, hash_password(req.password), req.role)
    return {"id": user_id, "username": req.username, "role": req.role}


@router.patch("/users/{user_id}")
async def api_update_user(user_id: int, req: UserUpdate, user: dict = Depends(get_existing_user)):
    if req.password is not None:
        await update_user_password(user_id, hash_password(req.password))
    if req.is_active is not None:
        await set_user_active(user_id, req.is_active)
    return {"ok": True}


@router.delete("/users/{user_id}")
async def api_delete_user(user_id: int, user: dict = Depends(get_existing_user)):
    if user["role"] == "admin":
        raise HTTPException(status_code=403, detail="Cannot delete admin user")
    await delete_user(user_id)
    return {"ok": True}


# ==================== Repositories ====================

def _admin_repo_view(repo: dict) -> dict:
    """cred_username isn't secret (it's just who we authenticate as) so it's
    shown as-is; cred_token is never echoed back — only whether one is set,
    so the table/edit form can show status without displaying the secret.
    Also strips the retired combined 'credentials' column, if a row still has
    one lying around from before the startup migration ran.

    The url field itself is masked too — an admin can paste a credential
    directly into the URL (e.g. https://user:token@host/repo.git) instead of
    using the dedicated fields, and that shouldn't round-trip back out to the
    client any more than cred_token does."""
    r = dict(repo)
    r["has_token"] = bool(r.pop("cred_token", None))
    r.pop("credentials", None)
    r["url"] = mask_url_credentials(r.get("url", ""))
    return r


@router.get("/repos")
async def api_list_repos():
    return [_admin_repo_view(r) for r in await list_repos()]


@router.get("/repos/{repo_id}")
async def api_get_repo(repo: dict = Depends(get_existing_repo)):
    return _admin_repo_view(repo)


@router.post("/repos")
async def api_create_repo(req: RepoCreate):
    repo_id = await create_repo(
        req.name, req.url, req.description, branch=req.branch,
        cred_username=req.cred_username, cred_token=req.cred_token,
    )
    # Clone the repo now (blocking — bounded by repo_sync's git timeout)
    from app.repo_sync import sync_and_persist
    success, msg = await sync_and_persist(
        repo_id, req.url, req.branch, cred_username=req.cred_username, cred_token=req.cred_token,
    )
    return {"id": repo_id, "name": req.name, "url": req.url, "branch": req.branch, "synced": success, "sync_message": msg}


@router.patch("/repos/{repo_id}")
async def api_update_repo(repo_id: int, req: RepoUpdate, repo: dict = Depends(get_existing_repo)):
    # Cosmetic fields are safe to update immediately regardless of sync outcome.
    await update_repo(repo_id, name=req.name, description=req.description)

    url_changed = req.url is not None and req.url != repo["url"]
    branch_changed = req.branch is not None and req.branch != (repo.get("branch") or "")
    username_changed = req.cred_username is not None and req.cred_username != (repo.get("cred_username") or "")
    token_changed = req.cred_token is not None and req.cred_token != (repo.get("cred_token") or "")
    if url_changed or branch_changed or username_changed or token_changed:
        from app.repo_sync import sync_and_persist
        sync_url = req.url if req.url is not None else repo["url"]
        sync_branch = req.branch if req.branch is not None else repo.get("branch")
        sync_username = req.cred_username if req.cred_username is not None else repo.get("cred_username")
        sync_token = req.cred_token if req.cred_token is not None else repo.get("cred_token")
        success, msg = await sync_and_persist(
            repo_id, sync_url, sync_branch, force_reclone=True,
            cred_username=sync_username, cred_token=sync_token,
        )
        if not success:
            raise HTTPException(
                status_code=502,
                detail=f"Repo record kept unchanged — resync with the new url/branch/credentials failed: {msg}",
            )
        # Only commit the new url/branch/credentials once the resync actually succeeded,
        # so the DB never describes a repo that isn't what's actually on disk.
        await update_repo(repo_id, url=req.url, branch=req.branch, cred_username=req.cred_username, cred_token=req.cred_token)
    return {"ok": True}


@router.delete("/repos/{repo_id}")
async def api_delete_repo(repo_id: int, repo: dict = Depends(get_existing_repo)):
    await delete_repo(repo_id)
    return {"ok": True}


@router.post("/repos/{repo_id}/sync")
async def api_sync_repo(repo_id: int, repo: dict = Depends(get_existing_repo)):
    """Manually trigger an immediate sync for one repo."""
    from app.repo_sync import sync_and_persist
    success, msg = await sync_and_persist(
        repo_id, repo["url"], repo.get("branch"),
        cred_username=repo.get("cred_username"), cred_token=repo.get("cred_token"),
    )
    return {"ok": success, "message": msg}


# ==================== Permissions ====================

@router.get("/permissions")
async def api_list_permissions():
    return await list_permissions()


@router.post("/permissions")
async def api_grant_permission(req: PermissionGrant):
    user = await get_user_by_id(req.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    repo = await get_repo(req.repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    perm_id = await grant_permission(req.user_id, req.repo_id, req.access_level)
    return {"id": perm_id, "user_id": req.user_id, "repo_id": req.repo_id, "access_level": req.access_level}


@router.delete("/permissions/{user_id}/{repo_id}")
async def api_revoke_permission(user_id: int, repo_id: int):
    await revoke_permission(user_id, repo_id)
    return {"ok": True}


# ==================== Usage metrics ====================

@router.get("/usage/summary")
async def api_usage_summary():
    return await get_usage_summary()


@router.get("/usage/by-user")
async def api_usage_by_user():
    return await get_usage_by_user()


@router.get("/usage/recent")
async def api_usage_recent(limit: int = 50):
    return await get_recent_llm_calls(limit)


@router.get("/feedback/summary")
async def api_feedback_summary():
    summary = await get_feedback_summary()
    summary["recent_negative"] = await get_recent_negative_feedback(20)
    return summary


# ==================== Issue progress tracking ====================

@router.get("/issues/tracking")
async def api_issue_tracking(limit: int = 100):
    return await get_issue_tracking_overview(limit)


@router.post("/issues/tracking/poll")
async def api_issue_tracking_poll():
    """Manual refresh — same reconciliation the background loop runs."""
    from app.issue_tracker import poll_tracked_issues
    polled = await poll_tracked_issues()
    return {"ok": True, "polled": polled}


# ==================== Semantic search recall log ====================

@router.get("/semantic-search/summary")
async def api_semantic_search_summary():
    return await get_semantic_search_stats()


@router.get("/semantic-search/recent")
async def api_semantic_search_recent(limit: int = 50, low_score_only: bool = False):
    return await get_semantic_search_recent(limit, low_score_only)


@router.get("/users/{user_id}/repos")
async def api_get_user_repos(user_id: int, user: dict = Depends(get_existing_user)):
    return await get_user_repos(user_id)
