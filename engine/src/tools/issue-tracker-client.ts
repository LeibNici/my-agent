// Issue-tracker HTTP client — port of v1's app/tools/github_issue.py's
// tracker-facing half (git show v1-python-final:app/tools/github_issue.py).
// The tool-facing half (draft_issue/manage_issue, which read tool_context
// for active_repo) lives in github-issue.ts; issue-routes.ts, github-issue.ts,
// and issue-tracker.ts (the poller) all share this module instead of each
// re-implementing host dispatch/auth.
//
// Every call — GitHub or GitLab — authenticates with the REPO'S OWN
// cred_token (the same credential configured for cloning it in 仓库管理; a
// PAT commonly carries both repo and API scopes). This used to be
// GitLab-only, with GitHub requiring a separate global APP_GITHUB_TOKEN —
// changed so both trackers work identically and a repo's own credential is
// the only thing that needs configuring (2026-07-13). The issue body still
// stamps the actual CodeAxis submitter's username (issue-routes.ts) since
// the tracker itself always attributes the issue to whichever account the
// token belongs to, not the platform user who triggered it.
// Every call site MUST pass a FullRepoRow (db.getRepoAdmin/listReposFull),
// never a RepoRow (db.getRepo/listRepos) — the client-safe view never
// carries cred_token, so a RepoRow would silently authenticate with
// `undefined` forever without ever failing loudly.
//
// Faithful-port note on error handling: v1 does NOT wrap the submit/action
// network calls in try/except at all — an httpx exception (DNS failure,
// connection refused, timeout) propagates uncaught all the way to FastAPI's
// default 500 handler. Only get_repo_labels and search_repo_issues have
// their own try/except (labels degrades to the stale cache or null; search
// degrades to []). This file mirrors that split exactly: submitRepoIssue/
// applyRepoIssueAction/uploadGitlabAttachment let a thrown fetch error
// propagate to their caller, while getRepoLabels/searchRepoIssues catch and
// degrade internally.
import { createHash } from "node:crypto";
import type { FullRepoRow } from "../db/storage.js";
import type { DbClient } from "../db/client.js";
import { validateUrl } from "../repo-sync.js";
import { withTimeout } from "./embedding-client.js";

const GITHUB_MUTATE_TIMEOUT_MS = 30_000; // v1's timeout=30 (issue create/comment/patch)
const GITHUB_SEARCH_TIMEOUT_MS = 10_000; // v1's timeout=10
const GITLAB_MUTATE_TIMEOUT_MS = 30_000; // v1's timeout=30 (issue create/note/state)
const GITLAB_GET_TIMEOUT_MS = 15_000; // v1's timeout=15 (labels page, single-issue re-fetch)
const GITLAB_SEARCH_TIMEOUT_MS = 10_000; // v1's timeout=10
const GITLAB_UPLOAD_TIMEOUT_MS = 60_000; // v1's timeout=60

/** Bounds one fetch with `withTimeout` — does NOT catch a thrown
 * network/abort error, so callers that must propagate one (submit/action/
 * upload) get it for free, and callers that must degrade instead (labels/
 * search) wrap this in their own try/catch. Exported for issue-tracker.ts's
 * poller, which hits the same GitHub/GitLab APIs on the same
 * timeout-bounded-fetch shape.
 *
 * Codex full-repo review (2026-07-14, Warning): this used to clear the
 * timer in a `finally` right after fetch()'s own promise resolved — i.e.
 * the moment response HEADERS arrive — leaving body consumption
 * (resp.json()/resp.text(), which every single caller does immediately
 * after this returns) completely unbounded. A slow/stalled body (a
 * misbehaving or malicious tracker endpoint sending headers promptly then
 * stalling mid-body) could hang forever past the intended timeout. The
 * SAME AbortSignal that guards fetch() also aborts any of the returned
 * Response's body-reading methods still in flight when it fires (WHATWG
 * fetch spec), so deliberately leaving it armed — not clearing it here at
 * all — closes that gap for free, covering whatever the caller does with
 * the body next. The underlying timer is already unref()'d
 * (embedding-client.ts's withTimeout), so a request that finishes quickly
 * just leaves a bounded (at most timeoutMs), harmless, already-unref'd
 * timer to fire later as a no-op abort() on a controller nothing is
 * listening to anymore — not a real leak. */
// Codex full-repo review (2026-07-14, Warning): fetch's default
// redirect:"follow" meant a validated GitHub/GitLab host (repo-sync.ts's
// validateUrl only ever runs when the repo URL/tracker API base is first
// computed) could 302 the request to a disallowed internal/private address
// at request time, with nothing here re-checking the redirect target's
// host before the request headers (including auth) go out to it — the
// exact request-side counterpart of NO_REDIRECT_ARGS's protection on the
// git clone/pull side of repo-sync.ts. Follows manually, re-validating
// each hop's Location against the same SSRF gate before continuing;
// rejects outright on the first hop that doesn't pass or a chain that
// doesn't terminate within a small bound (a real API redirecting more than
// a couple of times is not a case this codebase's trackers need to
// support).
const MAX_REDIRECTS = 3;

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    const { signal } = withTimeout(timeoutMs);
    const resp = await fetch(currentUrl, { ...init, signal, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400) {
      return resp;
    }
    const location = resp.headers.get("location");
    if (!location) {
      return resp; // a 3xx with no Location isn't a redirect fetch can follow — hand it back as-is
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects fetching ${url} (stopped at ${currentUrl})`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    const validationError = await validateUrl(nextUrl);
    if (validationError) {
      throw new Error(`redirect from ${currentUrl} to ${nextUrl} refused: ${validationError}`);
    }
    currentUrl = nextUrl;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "";
  } catch {
    return "";
  }
}

export function isGithubHosted(repo: Pick<FullRepoRow, "url">): boolean {
  const host = safeHostname(repo.url).toLowerCase();
  return host === "github.com" || host === "www.github.com";
}

export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  let url = repoUrl.replace(/\/+$/, "");
  if (url.endsWith(".git")) url = url.slice(0, -4);
  const parts = url.split("/");
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

/** Shared by every GitHub REST call in this module — issue create, issue
 * action (comment/close/reopen), and search all use the same auth scheme. */
export function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" };
}

/** v1's `_gitlab_project_api_base` — returns the bare
 * `{scheme}://{host}/api/v4/projects/{id}` URL with no trailing path;
 * callers append `/issues`, `/issues/{n}`, `/issues/{n}/notes`, etc.
 * Centralizes "check credentials, SSRF-validate the URL, strip .git,
 * URL-encode the project path" so it isn't copy-pasted at every call site. */
export async function gitlabProjectApiBaseFromRepoUrl(
  repoUrl: string,
  credToken: string | null,
): Promise<{ error: string | null; base: string | null }> {
  if (!credToken) {
    return {
      error:
        "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitLab API, not just to clone)",
      base: null,
    };
  }
  // Same SSRF guard clone/pull already apply — a repo URL pointing at an
  // internal/loopback/link-local host shouldn't get an authenticated
  // request fired at it just because it's stored on a repo record.
  const urlError = await validateUrl(repoUrl);
  if (urlError) return { error: urlError, base: null };

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return { error: `Cannot parse project path from URL: ${repoUrl}`, base: null };
  }
  let path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (!path) return { error: `Cannot parse project path from URL: ${repoUrl}`, base: null };

  const projectId = encodeURIComponent(path);
  return { error: null, base: `${parsed.protocol}//${parsed.host}/api/v4/projects/${projectId}` };
}

// ==================== Label vocabulary (per-repo, tracker-sourced) ====================

type LabelsCacheEntry = { fetchedAt: number; labels: string[] };
const LABELS_CACHE = new Map<number, LabelsCacheEntry>();
const LABELS_TTL_MS = 600_000; // v1's _LABELS_TTL_SECONDS = 600

/** Project's current label names, cached. null = vocabulary unavailable
 * (GitHub-hosted, fetch failed with no cache, or the fetch came back with
 * ZERO labels) — callers should then skip validation rather than reject
 * everything. A genuinely empty result is deliberately NOT cached: a real
 * GitLab project having zero labels is almost always transient (labels not
 * configured yet, a scope/permission hiccup on the token) rather than the
 * intended steady state, and caching it for the full TTL would silently
 * reject every label on every draft/submit for 10 minutes even after the
 * underlying cause is fixed. */
export async function getRepoLabels(repo: FullRepoRow): Promise<string[] | null> {
  if (isGithubHosted(repo)) return null;
  const cached = LABELS_CACHE.get(repo.id);
  if (cached && Date.now() - cached.fetchedAt < LABELS_TTL_MS) return cached.labels;

  const { error, base } = await gitlabProjectApiBaseFromRepoUrl(repo.url, repo.cred_token);
  if (error || !base) return cached ? cached.labels : null;

  const names: string[] = [];
  try {
    let page = 1;
    for (;;) {
      const resp = await fetchWithTimeout(
        `${base}/labels?per_page=100&page=${page}`,
        { headers: { "PRIVATE-TOKEN": repo.cred_token ?? "" } },
        GITLAB_GET_TIMEOUT_MS,
      );
      if (resp.status !== 200) return cached ? cached.labels : null;
      const batch = (await resp.json()) as Array<{ name: string }>;
      names.push(...batch.map((l) => l.name));
      if (batch.length < 100) break;
      page++;
    }
  } catch {
    return cached ? cached.labels : null;
  }

  if (names.length === 0) return cached ? cached.labels : null;
  LABELS_CACHE.set(repo.id, { fetchedAt: Date.now(), labels: names });
  return names;
}

/** Maps requested labels onto the project's real vocabulary. Case-insensitive
 * exact match first; then a unique scoped-suffix match ('bug' -> 'type::bug',
 * 'MES' -> 'module::MES') so the model's natural shorthand still lands on
 * the canonical name. Anything ambiguous or unknown is rejected, not
 * invented. */
export function normalizeLabels(
  requested: string[],
  available: string[],
): { accepted: string[]; rejected: string[] } {
  const byLower = new Map<string, string>();
  for (const a of available) byLower.set(a.toLowerCase(), a);

  const suffixMap = new Map<string, string[]>();
  for (const a of available) {
    const idx = a.indexOf("::");
    if (idx === -1) continue;
    const suffix = a.slice(idx + 2).trim().toLowerCase();
    const list = suffixMap.get(suffix);
    if (list) list.push(a);
    else suffixMap.set(suffix, [a]);
  }

  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const r of requested) {
    const key = r.trim().toLowerCase();
    if (!key) continue;
    let hit: string | null = byLower.get(key) ?? null;
    if (!hit) {
      const candidates = suffixMap.get(key) ?? [];
      hit = candidates.length === 1 ? candidates[0] : null;
    }
    if (!hit) rejected.push(r);
    else if (!accepted.includes(hit)) accepted.push(hit);
  }
  return { accepted, rejected };
}

// ==================== Submit a new issue ====================

export type TrackerResult =
  | { success: true; number: number; url: string | null; title: string | null }
  | { error: string };

async function submitGithubIssue(
  repoUrl: string,
  credToken: string | null,
  title: string,
  body: string,
  labels: string[],
): Promise<TrackerResult> {
  const token = credToken;
  if (!token) {
    return {
      error:
        "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitHub API, not just to clone)",
    };
  }
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return { error: `Cannot parse GitHub URL: ${repoUrl}` };
  const { owner, repo } = parsed;

  const resp = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
    {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, labels }),
    },
    GITHUB_MUTATE_TIMEOUT_MS,
  );

  if (resp.status === 201) {
    const data = (await resp.json()) as { number: number; html_url: string; title: string };
    return { success: true, number: data.number, url: data.html_url, title: data.title };
  }
  const text = await resp.text();
  return { error: `GitHub API error (${resp.status}): ${text}` };
}

async function submitGitlabIssue(
  repoUrl: string,
  credToken: string | null,
  title: string,
  body: string,
  labels: string[],
): Promise<TrackerResult> {
  const { error, base } = await gitlabProjectApiBaseFromRepoUrl(repoUrl, credToken);
  if (error || !base) return { error: error ?? "unknown GitLab API base error" };

  const resp = await fetchWithTimeout(
    `${base}/issues`,
    {
      method: "POST",
      headers: { "PRIVATE-TOKEN": credToken ?? "", "Content-Type": "application/json" },
      // GitLab wants labels as a comma string, unlike GitHub's array — a
      // real API asymmetry, not an oversight.
      body: JSON.stringify({ title, description: body, labels: labels.join(",") }),
    },
    GITLAB_MUTATE_TIMEOUT_MS,
  );

  if (resp.status === 201) {
    const data = (await resp.json()) as { iid: number; web_url: string; title: string };
    return { success: true, number: data.iid, url: data.web_url, title: data.title };
  }
  const text = await resp.text();
  return { error: `GitLab API error (${resp.status}): ${text}` };
}

/** Dispatches to the right issue tracker API based on the repo's host. */
export async function submitRepoIssue(
  repo: FullRepoRow,
  title: string,
  body: string,
  labels: string[],
): Promise<TrackerResult> {
  if (isGithubHosted(repo)) return submitGithubIssue(repo.url, repo.cred_token, title, body, labels);
  return submitGitlabIssue(repo.url, repo.cred_token, title, body, labels);
}

// ==================== Actions on an already-filed issue ====================
// Distinct from submitRepoIssue (create-only): comment/close/reopen an
// issue filed earlier, for "the submitted issue turns out to be based on a
// wrong premise, not an LLM slip" — correcting it in place instead of
// always spawning an unrelated new issue.

async function applyGithubIssueAction(
  repoUrl: string,
  credToken: string | null,
  issueNumber: number,
  action: string,
  comment: string,
): Promise<TrackerResult> {
  const token = credToken;
  if (!token) {
    return {
      error:
        "This repo has no credentials configured — set them in 仓库管理 → 编辑 (needed to call the GitHub API, not just to clone)",
    };
  }
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return { error: `Cannot parse GitHub URL: ${repoUrl}` };
  const { owner, repo } = parsed;
  const headers = githubHeaders(token);

  if (comment.trim()) {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body: comment }) },
      GITHUB_MUTATE_TIMEOUT_MS,
    );
    if (resp.status !== 201) {
      const text = await resp.text();
      return { error: `GitHub comment API error (${resp.status}): ${text}` };
    }
  }

  if (action === "close" || action === "reopen") {
    const resp = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: action === "close" ? "closed" : "open" }),
      },
      GITHUB_MUTATE_TIMEOUT_MS,
    );
    if (resp.status !== 200) {
      const text = await resp.text();
      return { error: `GitHub update API error (${resp.status}): ${text}` };
    }
    const data = (await resp.json()) as { number: number; html_url: string; title: string };
    return { success: true, number: data.number, url: data.html_url, title: data.title };
  }

  // comment-only: synthesize the URL, no extra call needed.
  return {
    success: true,
    number: issueNumber,
    url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    title: null,
  };
}

async function applyGitlabIssueAction(
  repoUrl: string,
  credToken: string | null,
  issueNumber: number,
  action: string,
  comment: string,
): Promise<TrackerResult> {
  const { error, base: projectBase } = await gitlabProjectApiBaseFromRepoUrl(repoUrl, credToken);
  if (error || !projectBase) return { error: error ?? "unknown GitLab API base error" };
  const baseUrl = `${projectBase}/issues/${issueNumber}`;
  const headers = { "PRIVATE-TOKEN": credToken ?? "" };

  if (comment.trim()) {
    const resp = await fetchWithTimeout(
      `${baseUrl}/notes`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ body: comment }) },
      GITLAB_MUTATE_TIMEOUT_MS,
    );
    if (resp.status !== 201) {
      const text = await resp.text();
      return { error: `GitLab note API error (${resp.status}): ${text}` };
    }
  }

  if (action === "close" || action === "reopen") {
    const resp = await fetchWithTimeout(
      baseUrl,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state_event: action === "close" ? "close" : "reopen" }),
      },
      GITLAB_MUTATE_TIMEOUT_MS,
    );
    if (resp.status !== 200) {
      const text = await resp.text();
      return { error: `GitLab update API error (${resp.status}): ${text}` };
    }
    const data = (await resp.json()) as { iid: number; web_url: string; title: string };
    return { success: true, number: data.iid, url: data.web_url, title: data.title };
  }

  // comment-only: GitLab's note response carries no issue-level url/title,
  // so re-fetch fresh state (unlike GitHub's synthesized-URL shortcut
  // above). A failed re-fetch still reports success — the note was already
  // posted — just without url/title.
  const getResp = await fetchWithTimeout(baseUrl, { headers }, GITLAB_GET_TIMEOUT_MS);
  if (getResp.status === 200) {
    const data = (await getResp.json()) as { iid: number; web_url: string; title: string };
    return { success: true, number: data.iid, url: data.web_url, title: data.title };
  }
  return { success: true, number: issueNumber, url: null, title: null };
}

/** Dispatches a comment/close/reopen against an already-filed issue to the
 * right tracker API based on the repo's host. */
export async function applyRepoIssueAction(
  repo: FullRepoRow,
  issueNumber: number,
  action: string,
  comment: string,
): Promise<TrackerResult> {
  if (isGithubHosted(repo)) return applyGithubIssueAction(repo.url, repo.cred_token, issueNumber, action, comment);
  return applyGitlabIssueAction(repo.url, repo.cred_token, issueNumber, action, comment);
}

// ==================== Duplicate lookup (before submitting) ====================

export type IssueHit = { number: number; title: string; url: string; state: string };

async function searchGithubIssues(
  repoUrl: string,
  credToken: string | null,
  query: string,
  limit: number,
): Promise<IssueHit[]> {
  const token = credToken;
  if (!token) return [];
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return [];
  const { owner, repo } = parsed;

  const params = new URLSearchParams({ q: `repo:${owner}/${repo} is:issue ${query}`, per_page: String(limit) });
  const resp = await fetchWithTimeout(
    `https://api.github.com/search/issues?${params}`,
    { headers: githubHeaders(token) },
    GITHUB_SEARCH_TIMEOUT_MS,
  );
  if (resp.status !== 200) return [];
  const data = (await resp.json()) as {
    items?: Array<{ number: number; title: string; html_url: string; state: string }>;
  };
  return (data.items ?? []).map((i) => ({ number: i.number, title: i.title, url: i.html_url, state: i.state }));
}

async function searchGitlabIssues(
  repoUrl: string,
  credToken: string | null,
  query: string,
  limit: number,
): Promise<IssueHit[]> {
  const { error, base } = await gitlabProjectApiBaseFromRepoUrl(repoUrl, credToken);
  if (error || !base) return [];

  const params = new URLSearchParams({
    search: query,
    in: "title",
    per_page: String(limit),
    order_by: "updated_at",
  });
  const resp = await fetchWithTimeout(
    `${base}/issues?${params}`,
    { headers: { "PRIVATE-TOKEN": credToken ?? "" } },
    GITLAB_SEARCH_TIMEOUT_MS,
  );
  if (resp.status !== 200) return [];
  const data = (await resp.json()) as Array<{ iid: number; title: string; web_url: string; state: string }>;
  return data.map((i) => ({ number: i.iid, title: i.title, url: i.web_url, state: i.state }));
}

/** Searches the repo's tracker for issues matching `query` (title text) —
 * used to warn about likely duplicates before a draft is submitted.
 * Best-effort: any tracker/API failure (including a thrown network error)
 * returns [] rather than blocking the draft flow. */
export async function searchRepoIssues(
  repo: FullRepoRow,
  query: string,
  limit: number,
): Promise<IssueHit[]> {
  try {
    if (isGithubHosted(repo)) return await searchGithubIssues(repo.url, repo.cred_token, query, limit);
    return await searchGitlabIssues(repo.url, repo.cred_token, query, limit);
  } catch {
    return [];
  }
}

// ==================== Attachments (GitLab only) ====================

export type UploadResult = { markdown: string | null } | { error: string };

/** Uploads a file to the repo's GitLab project (POST /projects/:id/uploads)
 * and returns markdown ready to embed in an issue body. GitLab-only —
 * GitHub has no equivalent anonymous-upload API, so callers should skip
 * attachment for github.com repos rather than call this. */
export async function uploadGitlabAttachment(
  repo: FullRepoRow,
  filename: string,
  content: Buffer,
): Promise<UploadResult> {
  const { error, base } = await gitlabProjectApiBaseFromRepoUrl(repo.url, repo.cred_token);
  if (error || !base) return { error: error ?? "unknown GitLab API base error" };

  const form = new FormData();
  form.append("file", new Blob([content]), filename);

  const resp = await fetchWithTimeout(
    `${base}/uploads`,
    { method: "POST", headers: { "PRIVATE-TOKEN": repo.cred_token ?? "" }, body: form },
    GITLAB_UPLOAD_TIMEOUT_MS,
  );

  if (resp.status === 201) {
    const data = (await resp.json()) as { markdown?: string };
    return { markdown: data.markdown ?? null };
  }
  const text = await resp.text();
  return { error: `GitLab upload API error (${resp.status}): ${text.slice(0, 200)}` };
}

// ==================== Screenshot attachments (from chat history) ====================

const ATTACHMENT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_ISSUE_ATTACHMENTS = 5;

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/** v1's `_upload_session_screenshots` — uploads the screenshots the user
 * pasted into this chat session to the repo's GitLab project and returns a
 * markdown section embedding them ("" if none). The DB copy of messages
 * keeps full image data (only the copy sent to the model gets placeholder-
 * pruned), so this recovers the original evidence the analysis was based
 * on. Best-effort: any failure degrades to fewer/no attachments, never a
 * failed submission — the issue text stands on its own. GitHub-hosted
 * repos are skipped (no equivalent upload API).
 *
 * Reads the raw legacy content shape directly (duck-typed, matching v1's
 * own dict access) rather than going through codec-legacy.ts's
 * legacyToDomain — that parser throws on the first malformed block in a
 * message, which would lose a perfectly good screenshot just because some
 * unrelated block in the same message doesn't validate. This scanner's job
 * is "best-effort excavate images from possibly-messy legacy JSON", not
 * round-tripping known-clean data. */
export async function uploadSessionScreenshots(
  repo: FullRepoRow,
  sessionId: string | null,
  db: DbClient,
): Promise<string> {
  if (!sessionId || isGithubHosted(repo)) return "";
  try {
    const messages = await db.getMessages(sessionId);
    const seen = new Set<string>();
    const markdowns: string[] = [];

    // v1's cap check only breaks the INNER (per-message) loop, so the outer
    // loop keeps scanning later messages after the cap is hit — but since
    // every subsequent image block re-hits the same cap check immediately,
    // the observable result (at most MAX_ISSUE_ATTACHMENTS markdown
    // entries, same order) is identical to breaking out of both loops here.
    outer: for (const msg of messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!isPlainObject(block) || block.type !== "image") continue;
        const source = block.source;
        if (!isPlainObject(source)) continue;
        const data = source.data;
        if (typeof data !== "string" || !data) continue;

        const digest = createHash("sha256").update(data).digest("hex");
        if (seen.has(digest)) continue; // same screenshot pasted twice
        seen.add(digest);
        if (markdowns.length >= MAX_ISSUE_ATTACHMENTS) break outer;

        const mediaType = source.media_type;
        const ext = (typeof mediaType === "string" && ATTACHMENT_EXT[mediaType]) || "png";
        const content = Buffer.from(data, "base64");
        const result = await uploadGitlabAttachment(repo, `screenshot-${markdowns.length + 1}.${ext}`, content);
        if ("markdown" in result && result.markdown) markdowns.push(result.markdown);
      }
    }

    if (markdowns.length === 0) return "";
    return "\n\n## 相关截图\n\n" + markdowns.join("\n\n");
  } catch {
    return "";
  }
}

// Test-only escape hatch (matches embedding-client.ts's __internal
// pattern) — lets label-cache tests start from a clean slate instead of
// leaking state across test cases via the module-level Map.
export const __internal = { clearLabelsCache: (): void => LABELS_CACHE.clear() };
