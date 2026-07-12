// Task 2: access.ts — permission-boundary pure functions
// Ported from v1-python-final:app/tools/access.py with signature adaptations
// for v2's explicit ToolContext parameter (v1 used AsyncLocalStorage ContextVar)
import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import {
  getAllowedPaths,
  getToolUserId,
  isWithinAllowedPaths,
  noAccessReason,
} from "../src/tools/access.js";
import type { ToolContext } from "../src/tools/registry.js";

describe("isWithinAllowedPaths", () => {
  it("returns true when realPath exactly equals an allowed path", () => {
    const allowed = ["/repos/myrepo"];
    expect(isWithinAllowedPaths("/repos/myrepo", allowed)).toBe(true);
  });

  it("returns true when realPath is nested under an allowed path (subdir)", () => {
    const allowed = ["/repos/myrepo"];
    expect(isWithinAllowedPaths("/repos/myrepo/src/main.ts", allowed)).toBe(
      true,
    );
  });

  it("returns true when realPath is deeply nested under an allowed path", () => {
    const allowed = ["/repos/myrepo"];
    expect(
      isWithinAllowedPaths(
        "/repos/myrepo/a/b/c/d/e/file.txt",
        allowed,
      ),
    ).toBe(true);
  });

  it("returns false when realPath is at the same directory level but a different repo (prefix match but not subdir)", () => {
    const allowed = ["/repos/foo"];
    // /repos/foo-bar shares the prefix but is not a subdir of /repos/foo
    expect(isWithinAllowedPaths("/repos/foo-bar", allowed)).toBe(false);
  });

  it("returns false when realPath is at the same directory level with similar prefix", () => {
    const allowed = ["/repos/myrepo"];
    expect(isWithinAllowedPaths("/repos/myrepo2", allowed)).toBe(false);
  });

  it("returns false when realPath is not under any allowed path", () => {
    const allowed = ["/repos/myrepo"];
    expect(isWithinAllowedPaths("/other/path", allowed)).toBe(false);
  });

  it("returns true for multiple allowed paths when path matches one of them", () => {
    const allowed = ["/repos/foo", "/repos/bar"];
    expect(isWithinAllowedPaths("/repos/bar/file.txt", allowed)).toBe(true);
    expect(isWithinAllowedPaths("/repos/foo/file.txt", allowed)).toBe(true);
  });

  it("returns false when no allowed paths match", () => {
    const allowed = ["/repos/foo", "/repos/bar"];
    expect(isWithinAllowedPaths("/repos/baz/file.txt", allowed)).toBe(false);
  });
});

describe("getToolUserId", () => {
  it("returns userId from context when present", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: 42,
    };
    expect(getToolUserId(ctx)).toBe(42);
  });

  it("returns null when userId is null in context", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    expect(getToolUserId(ctx)).toBe(null);
  });
});

describe("getAllowedPaths", () => {
  it("returns an array of realpaths from context", () => {
    const paths = ["/repos/foo", "/repos/bar"];
    const ctx: ToolContext = {
      allowedRepoPaths: paths,
      unsyncedRepoNames: [],
      userId: null,
    };
    const result = getAllowedPaths(ctx);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    // Each path should be realpathified (it may or may not change on Linux)
    expect(result).toEqual(expect.arrayContaining([
      expect.any(String),
      expect.any(String),
    ]));
  });

  it("handles empty allowedRepoPaths", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    const result = getAllowedPaths(ctx);
    expect(result).toEqual([]);
  });

  it("normalizes paths via realpath (filters empty strings)", () => {
    // Test that empty strings are filtered out
    const ctx: ToolContext = {
      allowedRepoPaths: ["/repos/foo", ""],
      unsyncedRepoNames: [],
      userId: null,
    };
    const result = getAllowedPaths(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^\/repos\/foo/);
  });
});

describe("noAccessReason", () => {
  it("returns message about unsynced repos when unsyncedRepoNames is non-empty", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: ["repo1", "repo2"],
      userId: null,
    };
    const reason = noAccessReason(ctx);
    expect(reason).toContain("Access denied");
    expect(reason).toContain("repo1");
    expect(reason).toContain("repo2");
    expect(reason).toContain("permission to");
    expect(reason).toContain("hasn't synced successfully yet");
    expect(reason).toContain("ask an admin");
  });

  it("returns message about no permissions when unsyncedRepoNames is empty", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    const reason = noAccessReason(ctx);
    expect(reason).toContain("Access denied");
    expect(reason).toContain("no repository permissions assigned");
  });

  it("uses custom prefix when provided", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    const reason = noAccessReason(ctx, "Permission error");
    expect(reason).toContain("Permission error");
  });

  it("uses default prefix when not provided", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    const reason = noAccessReason(ctx);
    expect(reason).toContain("Access denied");
  });

  it("matches v1's exact English text for no-permissions case", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: [],
      userId: null,
    };
    const reason = noAccessReason(ctx, "Access denied");
    // This is the exact text from v1-python-final:app/tools/access.py
    expect(reason).toBe(
      "Access denied: you have no repository permissions assigned",
    );
  });

  it("matches v1's exact English text for unsynced-repos case", () => {
    const ctx: ToolContext = {
      allowedRepoPaths: [],
      unsyncedRepoNames: ["repo1", "repo2"],
      userId: null,
    };
    const reason = noAccessReason(ctx, "Access denied");
    // This is the exact text format from v1-python-final:app/tools/access.py
    const expected =
      "Access denied: you have permission to repo1, repo2 " +
      "but it hasn't synced successfully yet (ask an admin to check the repo's clone status)";
    expect(reason).toBe(expected);
  });
});
