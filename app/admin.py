"""Admin API routes — user management, repo management, permission management."""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import hash_password, require_admin
from app.database import (
    create_user, list_users, get_user_by_id, get_user_by_username,
    update_user_password, set_user_active, delete_user,
    create_repo, list_repos, get_repo, update_repo, delete_repo,
    grant_permission, revoke_permission, list_permissions, get_user_repos,
)
from app.models import (
    UserCreate, UserUpdate,
    RepoCreate, RepoUpdate,
    PermissionGrant,
)

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])


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
async def api_update_user(user_id: int, req: UserUpdate):
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if req.password is not None:
        await update_user_password(user_id, hash_password(req.password))
    if req.is_active is not None:
        await set_user_active(user_id, req.is_active)
    return {"ok": True}


@router.delete("/users/{user_id}")
async def api_delete_user(user_id: int):
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user["role"] == "admin":
        raise HTTPException(status_code=403, detail="Cannot delete admin user")
    await delete_user(user_id)
    return {"ok": True}


# ==================== Repositories ====================

@router.get("/repos")
async def api_list_repos():
    return await list_repos()


@router.post("/repos")
async def api_create_repo(req: RepoCreate):
    repo_id = await create_repo(req.name, req.url, req.description, branch=req.branch)
    # Clone the repo now (blocking — bounded by repo_sync's git timeout)
    from app.repo_sync import sync_and_persist
    success, msg = await sync_and_persist(repo_id, req.url, req.branch)
    return {"id": repo_id, "name": req.name, "url": req.url, "branch": req.branch, "synced": success, "sync_message": msg}


@router.patch("/repos/{repo_id}")
async def api_update_repo(repo_id: int, req: RepoUpdate):
    repo = await get_repo(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")

    # Cosmetic fields are safe to update immediately regardless of sync outcome.
    await update_repo(repo_id, name=req.name, description=req.description)

    url_changed = req.url is not None and req.url != repo["url"]
    branch_changed = req.branch is not None and req.branch != (repo.get("branch") or "")
    if url_changed or branch_changed:
        from app.repo_sync import sync_and_persist
        sync_url = req.url if req.url is not None else repo["url"]
        sync_branch = req.branch if req.branch is not None else repo.get("branch")
        success, msg = await sync_and_persist(repo_id, sync_url, sync_branch, force_reclone=True)
        if not success:
            raise HTTPException(
                status_code=502,
                detail=f"Repo record kept unchanged — resync with the new url/branch failed: {msg}",
            )
        # Only commit the new url/branch once the resync actually succeeded, so
        # the DB never describes a repo/branch that isn't what's actually on disk.
        await update_repo(repo_id, url=req.url, branch=req.branch)
    return {"ok": True}


@router.delete("/repos/{repo_id}")
async def api_delete_repo(repo_id: int):
    repo = await get_repo(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    await delete_repo(repo_id)
    return {"ok": True}


@router.post("/repos/{repo_id}/sync")
async def api_sync_repo(repo_id: int):
    """Manually trigger an immediate sync for one repo."""
    repo = await get_repo(repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    from app.repo_sync import sync_and_persist
    success, msg = await sync_and_persist(repo_id, repo["url"], repo.get("branch"))
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


@router.get("/users/{user_id}/repos")
async def api_get_user_repos(user_id: int):
    user = await get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return await get_user_repos(user_id)
