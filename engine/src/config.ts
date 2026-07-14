import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import dotenv from "dotenv";

export interface Settings {
  // Anthropic/LLM settings. These four are just the .env/default layer —
  // main.ts overrides them post-load from db.getLlmConfig() when an admin
  // has configured one via Admin → LLM 配置 (2026-07-14), which then wins
  // outright. Kept here so a fresh deploy with no DB row yet still boots
  // with something usable, and so tests that only call loadSettings() in
  // isolation don't need a DB at all.
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  maxToolIterations: number;
  promptCache: "auto" | "on" | "off";
  maxHistoryMessages: number;

  // App settings
  port: number;
  jwtSecret: string;
  tokenExpireHours: number;
  adminUsername: string;
  adminPassword: string;
  reposDir: string;
  repoSyncIntervalMinutes: number;
  issueTrackIntervalMinutes: number;
  issueFixTargetBranch: string;
  // Codex full-repo review (2026-07-14, Warning): the codex-report/v1
  // completion marker (worker_id/commit_sha/files) used to be trusted from
  // ANY issue comment, regardless of author — on a public/shared tracker,
  // any commenter could forge a "fix verified" badge. The fleet's
  // codex-issue tool (deploy/codex-issue) always posts as one fixed GitLab
  // account (whichever owns GITLAB_TOKEN); comparing the note author
  // against this configured username is how fetchAndStoreReports now
  // verifies the marker actually came from the fleet. Empty by default —
  // fetchAndStoreReports fails closed (trusts nothing) until configured,
  // rather than silently trusting everyone.
  issueFixBotUsername: string;
  corsOrigins: string;
  // Populated from loadOrCreateGithubWebhookSecret/loadOrCreateGitlabWebhookSecret
  // in main.ts (same pattern as jwtSecret) — not read from .env.
  githubWebhookSecret: string;
  gitlabWebhookSecret: string;

  // Embedding settings
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are an internal code assistant for engineers browsing their team's repositories. Your role is bug confirmation, requirements clarification, and code walkthroughs — you are not a code-writing service and this chat is not a substitute for the developer's own IDE/PR workflow. When asked to make a change (add comments, refactor, fix a bug, implement a feature), do not generate or paste a full rewritten file, even if that's what was literally asked for. Instead: confirm whether the described behavior/bug is actually present in the code, explain what would need to change and why, and point to the specific file/function/line. A short (a few lines) illustrative snippet is fine to make a point concrete, but never a complete drop-in replacement file presented as a deliverable.

You have NO tool that edits, writes, or creates files — only read-only tools (reading files, searching code, listing directories). Never call a tool named like file_editor, write, edit, str_replace, or similar — it does not exist, the call will fail, and inventing one wastes the user's time. If you catch yourself about to reach for an editing tool, that's the signal to stop and describe the change in words instead — do not re-read the same file over and over hoping a way to edit it will appear; one read is enough to describe the fix in words.

If you have a draft_issue tool: draft at most ONE issue per confirmed problem per conversation. Once you've drafted an issue, that is your deliverable for this problem — do not draft a second, reworded issue for the same thing (e.g. because you couldn't also apply the code change). If you later realize the draft should change, say so in text and ask the user whether to redraft; never silently call draft_issue again as a way to conclude the turn.`;

/** Atomic create-if-absent for a secret persisted as a plain file (0600) at
 * the repo root. Only `.jwt_secret` uses this now — it's needed before the
 * DB is even open, unlike the webhook secrets that used to live here too
 * (moved to the DB, 2026-07-14, see the comment below `loadOrCreateJwtSecret`
 * for why). */
function loadOrCreateSecretFile(repoRoot: string, filename: string): string {
  const secretFile = path.join(repoRoot, filename);
  const secret = crypto.randomBytes(32).toString("hex");

  // Atomic create with exclusive flag; if it exists, re-read and return its contents
  try {
    fs.writeFileSync(secretFile, secret, { mode: 0o600, flag: "wx" });
    return secret;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "EEXIST"
    ) {
      // Codex full-repo review (2026-07-14, Warning): a pre-existing file's
      // permissions were never corrected (only set at creation time), and a
      // symlink at this path was silently followed for both read and
      // write — an attacker with write access to this directory before the
      // app ever started could redirect where the "secret" actually lives.
      // Refuse anything that isn't a real regular file, and re-assert 0600
      // on every load, not just the first one.
      const lst = fs.lstatSync(secretFile);
      if (!lst.isFile()) {
        throw new Error(
          `${secretFile} exists but is not a regular file — refusing to read/write a secret through it`
        );
      }
      fs.chmodSync(secretFile, 0o600);
      // File already exists; the winner wrote it, we re-read and return
      const existingSecret = fs.readFileSync(secretFile, "utf-8").trim();
      if (existingSecret) {
        return existingSecret;
      }
      // The file exists but is empty (e.g. pre-touched as a placeholder for
      // a bind mount, or truncated some other way) — persist our freshly
      // generated secret into it rather than silently returning it without
      // saving. Discovered the hard way (GitHub issue #6, 2026-07-14): the
      // webhook secrets used to hit exactly this path on every restart
      // (their host file had to be pre-touched empty for Docker's
      // bind-mount to work at all) and this branch used to just return an
      // in-memory value without writing it back, so a "restart" and
      // "generate a brand-new secret" were silently the same event.
      fs.writeFileSync(secretFile, secret, { mode: 0o600 });
      return secret;
    }
    // Re-throw other errors (permission, disk full, etc.)
    throw err;
  }
}

export function loadOrCreateJwtSecret(repoRoot: string): string {
  return loadOrCreateSecretFile(repoRoot, ".jwt_secret");
}

// Webhook secrets used to live here too (file-based, same pattern as
// jwtSecret), but that required the host-side file to be pre-touched empty
// for Docker's bind-mount to work at all, and the empty-file branch above
// didn't persist what it generated — every restart silently minted (and
// discarded) a new secret (GitHub issue #6, 2026-07-14). Moved to the DB
// (storage.ts's getOrCreateAppSecret/regenerateAppSecret, wired in
// main.ts) instead: it's already the one thing every deployment persists
// correctly, and it gets admin-triggered rotation almost for free (an
// UPDATE instead of an SSH session + container restart). jwtSecret stays
// file-based deliberately — it's needed before the DB is even open.

export function loadSettings(env?: Record<string, string | undefined>): Settings {
  // When env is NOT provided (production path), call dotenv.config() once.
  // `quiet: true` suppresses dotenv's own stdout "tips" banner (an ad for
  // dotenv-vault) — noise on every service start with no diagnostic value.
  if (!env) {
    dotenv.config({ quiet: true });
  }

  const envVars = env || process.env;

  const getEnvStr = (key: string, defaultValue: string): string => {
    return envVars[key] ?? defaultValue;
  };

  const getEnvNum = (key: string, defaultValue: number): number => {
    const val = envVars[key];
    if (val === undefined) return defaultValue;
    const num = parseInt(val, 10);
    return isNaN(num) ? defaultValue : num;
  };

  return {
    // Anthropic/LLM settings
    apiKey: getEnvStr("ANTHROPIC_API_KEY", ""),
    baseUrl: getEnvStr("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
    model: getEnvStr("ANTHROPIC_MODEL", "claude-sonnet-5"),
    maxTokens: getEnvNum("ANTHROPIC_MAX_TOKENS", 4096),
    systemPrompt: getEnvStr("ANTHROPIC_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
    maxToolIterations: getEnvNum("ANTHROPIC_MAX_TOOL_ITERATIONS", 30),
    promptCache: (getEnvStr(
      "ANTHROPIC_PROMPT_CACHE",
      "auto"
    ) as "auto" | "on" | "off"),
    maxHistoryMessages: getEnvNum("ANTHROPIC_MAX_HISTORY_MESSAGES", 60),

    // App settings
    // v1 had no equivalent var — uvicorn's own `--port` CLI flag (see
    // deploy/codeaxis.service: `--host 0.0.0.0 --port 8000`) was the only
    // knob, nothing app.config.py-level. No name to reuse from
    // `.env.example` (checked), so this is a genuinely new Node-service
    // setting; `APP_*` keeps it consistent with the rest of the app-level
    // (non-ANTHROPIC_*) settings below.
    port: getEnvNum("APP_PORT", 8000),
    jwtSecret: getEnvStr("APP_JWT_SECRET", ""),
    // Empty here by default — same "override via .env if set, else main.ts
    // auto-generates and persists a file" pattern as jwtSecret above.
    githubWebhookSecret: getEnvStr("APP_GITHUB_WEBHOOK_SECRET", ""),
    gitlabWebhookSecret: getEnvStr("APP_GITLAB_WEBHOOK_SECRET", ""),
    tokenExpireHours: getEnvNum("APP_TOKEN_EXPIRE_HOURS", 24),
    adminUsername: getEnvStr("APP_ADMIN_USERNAME", "admin"),
    adminPassword: getEnvStr("APP_ADMIN_PASSWORD", "admin123"),
    reposDir: getEnvStr("APP_REPOS_DIR", "/tmp/agent-repos"),
    repoSyncIntervalMinutes: getEnvNum("APP_REPO_SYNC_INTERVAL_MINUTES", 10),
    issueTrackIntervalMinutes: getEnvNum(
      "APP_ISSUE_TRACK_INTERVAL_MINUTES",
      10
    ),
    issueFixTargetBranch: getEnvStr("APP_ISSUE_FIX_TARGET_BRANCH", "test"),
    issueFixBotUsername: getEnvStr("APP_ISSUE_FIX_BOT_USERNAME", ""),
    corsOrigins: getEnvStr(
      "APP_CORS_ORIGINS",
      "http://localhost:8000,http://127.0.0.1:8000"
    ),

    // Embedding settings
    embeddingBaseUrl: getEnvStr(
      "APP_EMBEDDING_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ),
    embeddingApiKey: getEnvStr("APP_EMBEDDING_API_KEY", ""),
    embeddingModel: getEnvStr("APP_EMBEDDING_MODEL", "text-embedding-v4"),
    embeddingDimensions: getEnvNum("APP_EMBEDDING_DIMENSIONS", 1024),
  };
}
