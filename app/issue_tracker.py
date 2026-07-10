"""Issue progress tracking — polls the tracker for what happened to issues
filed from CodeAxis.

The gap this fills: issue_submissions records that an issue WAS filed and
then the platform goes blind — no one can tell from the 工单 whether the
autonomous fix fleet (or a human) ever claimed it, merged a fix, closed it,
or reopened it after a regression. This poller reconciles each filed issue
against the tracker on an interval and persists the observation onto the
issue_submissions row (see the tracking columns in database.init_db).

Design decisions (several straight from the design review):
- Reopen detection uses GitLab's resource_state_events API — the
  authoritative event stream — NOT snapshot diffing. A close→reopen cycle
  happening entirely between two polls is invisible to snapshots but
  permanent in the event stream.
- The poll target (host + project path) is parsed from the submission's own
  stored issue_url, not the repo's current URL: an admin retargeting a repo
  record must not silently point historical tracking at the wrong project.
  The repo record only contributes its cred_token — and only after checking
  the issue_url host still matches the repo host, so a stored credential is
  never sent to some other host.
- Closed issues drop to one check per day instead of ever going terminal
  (get_trackable_submissions) — the fleet reopens issues when a merged fix
  regresses, and a permanently-stopped poll would miss it.
- GitHub-hosted issues get state+labels only (no reopen event counting) —
  the production tracker is self-hosted GitLab; GitHub support is minimal
  on purpose.

Status model (track_status), derived per poll:
  submitted → claimed (codex:in-progress) → merged (codex:merged-to-test)
  → closed (tracker state) / reopened (reopen events > 0 while open).
'reopened' outranks 'merged': the fleet's own protocol treats a stale
merged-label on a reopened issue as invalid until re-verified.
"""

import asyncio
import json
from urllib.parse import quote, urlparse

import httpx

from app.config import app_settings
from app.repo_sync import _validate_url

_EVENTS_MAX_PAGES = 5  # 100/page; >500 state events on one issue isn't a real case


def _parse_issue_api_base(issue_url: str) -> tuple[str | None, str | None]:
    """GitLab issue web URL → its project's API base.
    https://host/group/project/-/issues/123 → https://host/api/v4/projects/group%2Fproject
    Returns (error, base_url)."""
    err = _validate_url(issue_url)
    if err:
        return err, None
    parsed = urlparse(issue_url)
    path = parsed.path.strip("/")
    if "/-/issues/" in parsed.path:
        project_path = path.split("/-/issues/")[0]
    elif "/issues/" in parsed.path:  # older GitLab URLs lack the /-/ separator
        project_path = path.split("/issues/")[0]
    else:
        return f"无法从 issue URL 解析项目路径: {issue_url}", None
    if not project_path:
        return f"无法从 issue URL 解析项目路径: {issue_url}", None
    return None, f"{parsed.scheme}://{parsed.netloc}/api/v4/projects/{quote(project_path, safe='')}"


async def _fetch_gitlab_state_events(client: httpx.AsyncClient, api_base: str,
                                     issue_number: int, token: str) -> tuple[int, str | None]:
    """(reopen_count, last_closed_at) from the resource state events stream."""
    reopens = 0
    last_closed_at = None
    for page in range(1, _EVENTS_MAX_PAGES + 1):
        resp = await client.get(
            f"{api_base}/issues/{issue_number}/resource_state_events",
            headers={"PRIVATE-TOKEN": token},
            params={"per_page": 100, "page": page},
            timeout=20,
        )
        if resp.status_code != 200:
            break  # older GitLab without this API → degrade to snapshot-only
        events = resp.json()
        for ev in events:
            if ev.get("state") == "reopened":
                reopens += 1
            elif ev.get("state") == "closed":
                last_closed_at = ev.get("created_at")
        if len(events) < 100:
            break
    return reopens, last_closed_at


def _derive_status(remote_state: str, labels: list[str], reopen_count: int) -> str:
    if remote_state == "closed":
        return "closed"
    if reopen_count > 0:
        return "reopened"
    lowered = [l.lower() for l in labels]
    if any(l == "codex:merged-to-test" for l in lowered):
        return "merged"
    if any(l == "codex:in-progress" for l in lowered):
        return "claimed"
    return "submitted"


async def _poll_one(client: httpx.AsyncClient, sub: dict, repos_by_id: dict[int, dict]) -> None:
    from app.database import update_issue_tracking

    repo = repos_by_id.get(sub["repo_id"])
    if not repo:
        await update_issue_tracking(sub["id"], track_error="关联仓库已被删除，无法追踪")
        return

    issue_url = sub["issue_url"]
    issue_host = (urlparse(issue_url).hostname or "").lower()
    repo_host = (urlparse(repo["url"]).hostname or "").lower()

    if issue_host in ("github.com", "www.github.com"):
        await _poll_github(client, sub)
        return

    if issue_host != repo_host:
        await update_issue_tracking(
            sub["id"],
            track_error=f"issue 所在主机({issue_host})与仓库当前主机({repo_host})不一致，凭证不外发，暂停追踪",
        )
        return
    token = repo.get("cred_token")
    if not token:
        await update_issue_tracking(sub["id"], track_error="仓库未配置凭证，无法调用 GitLab API")
        return

    err, api_base = _parse_issue_api_base(issue_url)
    if err:
        await update_issue_tracking(sub["id"], track_error=err)
        return

    resp = await client.get(
        f"{api_base}/issues/{sub['issue_number']}",
        headers={"PRIVATE-TOKEN": token}, timeout=20,
    )
    if resp.status_code == 404:
        await update_issue_tracking(sub["id"], track_error="issue 在 GitLab 上已不存在（404）")
        return
    if resp.status_code != 200:
        # transient API failure — record it, keep previous status untouched
        await update_issue_tracking(sub["id"], track_error=f"GitLab API {resp.status_code}")
        return
    data = resp.json()
    remote_state = data.get("state") or "opened"
    labels = data.get("labels") or []

    reopen_count, last_closed_at = await _fetch_gitlab_state_events(
        client, api_base, sub["issue_number"], token)
    closed_at = data.get("closed_at") or last_closed_at

    await update_issue_tracking(
        sub["id"],
        track_status=_derive_status(remote_state, labels, reopen_count),
        remote_state=remote_state,
        remote_labels=json.dumps(labels, ensure_ascii=False),
        reopen_count=reopen_count,
        closed_at=closed_at,
        clear_error=True,
    )


async def _poll_github(client: httpx.AsyncClient, sub: dict) -> None:
    """Minimal GitHub tracking: state + labels via REST, no reopen events."""
    from app.database import update_issue_tracking
    token = app_settings.github_token
    if not token:
        await update_issue_tracking(sub["id"], track_error="未配置 APP_GITHUB_TOKEN，无法追踪 GitHub issue")
        return
    path = urlparse(sub["issue_url"]).path.strip("/")  # owner/repo/issues/123
    parts = path.split("/")
    if len(parts) < 4 or parts[2] != "issues":
        await update_issue_tracking(sub["id"], track_error=f"无法解析 GitHub issue URL: {sub['issue_url']}")
        return
    owner, repo_name = parts[0], parts[1]
    resp = await client.get(
        f"https://api.github.com/repos/{owner}/{repo_name}/issues/{sub['issue_number']}",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
        timeout=20,
    )
    if resp.status_code != 200:
        await update_issue_tracking(sub["id"], track_error=f"GitHub API {resp.status_code}")
        return
    data = resp.json()
    remote_state = "closed" if data.get("state") == "closed" else "opened"
    labels = [l["name"] if isinstance(l, dict) else str(l) for l in (data.get("labels") or [])]
    await update_issue_tracking(
        sub["id"],
        track_status=_derive_status(remote_state, labels, 0),
        remote_state=remote_state,
        remote_labels=json.dumps(labels, ensure_ascii=False),
        closed_at=data.get("closed_at"),
        clear_error=True,
    )


async def poll_tracked_issues() -> int:
    """One reconciliation round over every due submission. Returns how many
    were polled. Per-issue failures are recorded on that row (track_error)
    and never abort the round."""
    from app.database import get_trackable_submissions, list_repos
    subs = await get_trackable_submissions()
    if not subs:
        return 0
    repos_by_id = {r["id"]: r for r in await list_repos()}
    async with httpx.AsyncClient() as client:
        for sub in subs:
            try:
                await _poll_one(client, sub, repos_by_id)
            except Exception as e:
                from app.database import update_issue_tracking
                try:
                    await update_issue_tracking(sub["id"], track_error=f"{type(e).__name__}: {e}")
                except Exception:
                    pass
    return len(subs)


async def periodic_tracking_loop(interval_minutes: int):
    """Background task, started in the app lifespan next to the repo sync
    loop. A falsy interval disables tracking entirely."""
    if not interval_minutes or interval_minutes <= 0:
        return
    while True:
        await asyncio.sleep(interval_minutes * 60)
        try:
            await poll_tracked_issues()
        except Exception as e:
            print(f"  ❌ issue tracking poll failed: {type(e).__name__}: {e}")
