# Review: uncommitted working-tree diff

Findings captured for the user-requested JSON review.

## Findings

1. Critical/security: `app/admin.py:84` updates repo URL/branch before a successful resync and leaves old `local_path` intact on sync failure, so tools can keep serving stale/wrong checkout contents after an admin changes repo configuration.
2. Warning/correctness: `app/repo_sync.py:69` has no per-repo sync lock around delete/clone/pull operations, so manual, periodic, startup, and update-triggered syncs can race on the same checkout.
3. Warning/correctness: `app/repo_sync.py:116` treats only truthy branch names as branch selection, so clearing a pinned branch back to remote default can leave the checkout on the old branch while DB/UI report default.
4. Warning/correctness: `app/repo_sync.py:47` does not kill/wait the child git process when `_run_git` is cancelled.
5. Warning/security: `app/repo_sync.py:124` can pull an existing checkout without reapplying the new host/protocol guard.
6. Warning/frontend: `web/admin.js:144` leaves the manual sync button disabled if fetch or JSON parsing throws.

## Checks

- `git diff --check` passed.
- `python3 -m compileall app` passed.
- External Codex review completed.
- Claude direct fallback completed after the wrapper failed under root.
