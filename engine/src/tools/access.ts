// Permission-boundary pure functions for tools that browse permissioned repos.
//
// Ported from v1-python-final:app/tools/access.py with the key difference:
// v1 used AsyncLocalStorage ContextVar (thread-local ambient context); v2
// receives ToolContext explicitly as a parameter, so the caller (turn.ts,
// Task 8) can wire real repo permissions per turn without needing ambient
// state at all.
//
// Both file_reader.py and code_search.py (v1) needed to know which repo
// paths the current user is allowed to touch, and how to explain it when
// they aren't — this used to be copy-pasted and had already drifted. Now
// the central functions here are the single source of truth.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext } from "./registry.js";

/**
 * Get the current turn's allowed repo paths, normalized via realpath
 * (symlink-resolved, matching Python's os.path.realpath — NOT a lexical
 * path.resolve(), which would leave symlink components unresolved and let
 * isWithinAllowedPaths wrongly deny access to a tool-supplied path that
 * fs.realpathSync (used elsewhere on the tool-supplied side) has already
 * resolved through the same symlink).
 *
 * Python's os.path.realpath never throws on a nonexistent target — it just
 * lexically normalizes what it can. Node's fs.realpathSync THROWS ENOENT
 * for a missing path. Repo paths here should always exist (already-synced
 * repos), but to match Python's non-throwing behavior for the edge case,
 * fall back to path.resolve(p) on ENOENT.
 */
export function getAllowedPaths(ctx: ToolContext): string[] {
  return ctx.allowedRepoPaths
    .filter((p) => p)
    .map((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    });
}

/**
 * Current turn's user id from context — for tools that log their own
 * per-user activity (e.g. semantic_search's recall-quality log).
 */
export function getToolUserId(ctx: ToolContext): number | null {
  return ctx.userId;
}

/**
 * The actual repo-boundary test: realPath is allowed if it IS one of
 * the allowed roots, or is nested under one as a proper subdirectory.
 * This exact check is security-critical and is centralized here to prevent
 * drift between call sites.
 *
 * Real path must already be normalized (likely from realpath(2) or path.resolve).
 * Allowed paths are expected to be normalized by getAllowedPaths.
 */
export function isWithinAllowedPaths(
  realPath: string,
  allowedPaths: string[],
): boolean {
  return allowedPaths.some(
    (allowed) =>
      realPath === allowed || realPath.startsWith(allowed + path.sep),
  );
}

/**
 * v1's "active_repo" resolution (app/tools/access.py) — a chat turn's
 * draft_issue/manage_issue tools need to know WHICH repo an issue targets
 * when the user hasn't said so explicitly in the message. The narrowing
 * itself already happened in resolveToolContext (a request-level repo_id
 * collapses `granted` to that one repo before ToolContext is even built) —
 * this just reads the result: exactly one visible repo is unambiguous,
 * zero or multiple are not (the tool must ask the user, not guess).
 */
export function getActiveRepo(
  ctx: ToolContext,
): { id: number; name: string; localPath: string | null } | null {
  return ctx.grantedRepos?.length === 1 ? ctx.grantedRepos[0] : null;
}

/**
 * Distinguish "no permission granted" from "granted but repo never synced".
 * This is returned to the user to explain why they can't access a repo.
 */
export function noAccessReason(
  ctx: ToolContext,
  prefix: string = "Access denied",
): string {
  const unsynced = ctx.unsyncedRepoNames;
  if (unsynced.length > 0) {
    return (
      `${prefix}: you have permission to ` +
      unsynced.join(", ") +
      " but it hasn't synced successfully yet (ask an admin to check the repo's clone status)"
    );
  }
  return `${prefix}: you have no repository permissions assigned`;
}
