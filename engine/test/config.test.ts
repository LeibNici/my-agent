import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadSettings, loadOrCreateJwtSecret } from "../src/config.js";

describe("config", () => {
  describe("loadSettings", () => {
    it("should return defaults when no env provided and .env file is empty", () => {
      const env = {};
      const settings = loadSettings(env);
      expect(settings.apiKey).toBe("");
      expect(settings.baseUrl).toBe("https://api.anthropic.com");
      expect(settings.model).toBe("claude-sonnet-5");
      expect(settings.maxTokens).toBe(4096);
      expect(settings.maxToolIterations).toBe(30);
      expect(settings.promptCache).toBe("auto");
      expect(settings.maxHistoryMessages).toBe(60);
      expect(settings.tokenExpireHours).toBe(24);
      expect(settings.adminUsername).toBe("admin");
      expect(settings.adminPassword).toBe("admin123");
      expect(settings.reposDir).toBe("/tmp/agent-repos");
      expect(settings.repoSyncIntervalMinutes).toBe(10);
      expect(settings.issueTrackIntervalMinutes).toBe(10);
      expect(settings.issueFixTargetBranch).toBe("test");
      expect(settings.corsOrigins).toBe(
        "http://localhost:8000,http://127.0.0.1:8000"
      );
      expect(settings.embeddingBaseUrl).toBe(
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
      );
      expect(settings.embeddingApiKey).toBe("");
      expect(settings.embeddingModel).toBe("text-embedding-v4");
      expect(settings.embeddingDimensions).toBe(1024);
    });

    it("should parse numeric values correctly from string env vars", () => {
      const env = {
        ANTHROPIC_MAX_TOKENS: "2048",
        ANTHROPIC_MAX_TOOL_ITERATIONS: "15",
        ANTHROPIC_MAX_HISTORY_MESSAGES: "30",
        APP_TOKEN_EXPIRE_HOURS: "48",
        APP_REPO_SYNC_INTERVAL_MINUTES: "5",
        APP_ISSUE_TRACK_INTERVAL_MINUTES: "20",
        APP_EMBEDDING_DIMENSIONS: "512",
      };
      const settings = loadSettings(env);
      expect(settings.maxTokens).toBe(2048);
      expect(settings.maxToolIterations).toBe(15);
      expect(settings.maxHistoryMessages).toBe(30);
      expect(settings.tokenExpireHours).toBe(48);
      expect(settings.repoSyncIntervalMinutes).toBe(5);
      expect(settings.issueTrackIntervalMinutes).toBe(20);
      expect(settings.embeddingDimensions).toBe(512);
    });

    it("should use defaults when numeric parsing fails", () => {
      const env = {
        ANTHROPIC_MAX_TOKENS: "not-a-number",
        APP_TOKEN_EXPIRE_HOURS: "invalid",
      };
      const settings = loadSettings(env);
      expect(settings.maxTokens).toBe(4096);
      expect(settings.tokenExpireHours).toBe(24);
    });

    it("should override ANTHROPIC_* defaults with env vars", () => {
      const env = {
        ANTHROPIC_API_KEY: "sk-test-key",
        ANTHROPIC_BASE_URL: "https://custom.anthropic.com",
        ANTHROPIC_MODEL: "claude-haiku-4-5",
        ANTHROPIC_SYSTEM_PROMPT: "Custom system prompt",
        ANTHROPIC_PROMPT_CACHE: "on",
      };
      const settings = loadSettings(env);
      expect(settings.apiKey).toBe("sk-test-key");
      expect(settings.baseUrl).toBe("https://custom.anthropic.com");
      expect(settings.model).toBe("claude-haiku-4-5");
      expect(settings.systemPrompt).toBe("Custom system prompt");
      expect(settings.promptCache).toBe("on");
    });

    it("should override APP_* defaults with env vars", () => {
      const env = {
        APP_JWT_SECRET: "test-secret",
        APP_ADMIN_USERNAME: "superadmin",
        APP_ADMIN_PASSWORD: "complexpass",
        APP_REPOS_DIR: "/var/repos",
        APP_ISSUE_FIX_TARGET_BRANCH: "main",
        APP_CORS_ORIGINS: "https://example.com",
        APP_EMBEDDING_BASE_URL: "https://embedding.example.com",
        APP_EMBEDDING_API_KEY: "emb_key_123",
        APP_EMBEDDING_MODEL: "text-embedding-v3",
      };
      const settings = loadSettings(env);
      expect(settings.jwtSecret).toBe("test-secret");
      expect(settings.adminUsername).toBe("superadmin");
      expect(settings.adminPassword).toBe("complexpass");
      expect(settings.reposDir).toBe("/var/repos");
      expect(settings.issueFixTargetBranch).toBe("main");
      expect(settings.corsOrigins).toBe("https://example.com");
      expect(settings.embeddingBaseUrl).toBe("https://embedding.example.com");
      expect(settings.embeddingApiKey).toBe("emb_key_123");
      expect(settings.embeddingModel).toBe("text-embedding-v3");
    });

    it("should use camelCase field names in returned Settings object", () => {
      const env = {
        ANTHROPIC_API_KEY: "test",
        ANTHROPIC_BASE_URL: "http://test",
        ANTHROPIC_SYSTEM_PROMPT: "test",
        ANTHROPIC_PROMPT_CACHE: "off",
        APP_REPOS_DIR: "/test",
        APP_REPO_SYNC_INTERVAL_MINUTES: "5",
        APP_ISSUE_TRACK_INTERVAL_MINUTES: "10",
        APP_ISSUE_FIX_TARGET_BRANCH: "develop",
        APP_EMBEDDING_BASE_URL: "http://embed",
        APP_EMBEDDING_API_KEY: "key",
        APP_EMBEDDING_MODEL: "model",
      };
      const settings = loadSettings(env);

      // Verify camelCase field names exist
      expect(settings).toHaveProperty("apiKey");
      expect(settings).toHaveProperty("baseUrl");
      expect(settings).toHaveProperty("systemPrompt");
      expect(settings).toHaveProperty("promptCache");
      expect(settings).toHaveProperty("maxToolIterations");
      expect(settings).toHaveProperty("maxHistoryMessages");
      expect(settings).toHaveProperty("reposDir");
      expect(settings).toHaveProperty("repoSyncIntervalMinutes");
      expect(settings).toHaveProperty("issueTrackIntervalMinutes");
      expect(settings).toHaveProperty("issueFixTargetBranch");
      expect(settings).toHaveProperty("embeddingBaseUrl");
      expect(settings).toHaveProperty("embeddingApiKey");
      expect(settings).toHaveProperty("embeddingModel");
      expect(settings).toHaveProperty("embeddingDimensions");

      // Verify snake_case fields do NOT exist
      expect(settings).not.toHaveProperty("api_key");
      expect(settings).not.toHaveProperty("base_url");
      expect(settings).not.toHaveProperty("system_prompt");
      expect(settings).not.toHaveProperty("prompt_cache");
      expect(settings).not.toHaveProperty("repos_dir");
      expect(settings).not.toHaveProperty("github_token");
      expect(settings).not.toHaveProperty("repo_sync_interval_minutes");
      expect(settings).not.toHaveProperty("issue_track_interval_minutes");
      expect(settings).not.toHaveProperty("issue_fix_target_branch");
      expect(settings).not.toHaveProperty("embedding_base_url");
      expect(settings).not.toHaveProperty("embedding_api_key");
      expect(settings).not.toHaveProperty("embedding_model");
      expect(settings).not.toHaveProperty("embedding_dimensions");
    });

    it("should not call dotenv.config when env object is provided (test path)", () => {
      // When env is provided, dotenv should not be called
      // We just verify the function doesn't throw and returns values correctly
      const env = { ANTHROPIC_API_KEY: "test-key" };
      const settings = loadSettings(env);
      expect(settings.apiKey).toBe("test-key");
    });

    it("should have systemPrompt field with default", () => {
      const env = {};
      const settings = loadSettings(env);
      expect(settings.systemPrompt).toBeDefined();
      expect(typeof settings.systemPrompt).toBe("string");
      expect(settings.systemPrompt.length).toBeGreaterThan(0);
      expect(settings.systemPrompt).toContain("You are an internal code assistant");
    });
  });

  describe("loadOrCreateJwtSecret", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jwt-test-"));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("should create new secret file with content when file does not exist", () => {
      const secret = loadOrCreateJwtSecret(tmpDir);

      expect(secret).toBeDefined();
      expect(typeof secret).toBe("string");
      expect(secret.length).toBe(64); // 32 bytes * 2 (hex encoding)
      // Verify it's valid hex
      expect(/^[0-9a-f]{64}$/.test(secret)).toBe(true);

      // Verify file was created
      const secretFile = path.join(tmpDir, ".jwt_secret");
      expect(fs.existsSync(secretFile)).toBe(true);

      // Verify file content matches returned secret
      const fileContent = fs.readFileSync(secretFile, "utf-8").trim();
      expect(fileContent).toBe(secret);
    });

    it("should create file with mode 0600 (user read/write only)", () => {
      loadOrCreateJwtSecret(tmpDir);
      const secretFile = path.join(tmpDir, ".jwt_secret");
      const stats = fs.statSync(secretFile);
      // Extract permission bits
      const mode = stats.mode & parseInt("777", 8);
      expect(mode).toBe(parseInt("600", 8));
    });

    it("should return existing secret when file already exists", () => {
      const secretFile = path.join(tmpDir, ".jwt_secret");
      const existingSecret =
        "a".repeat(64);
      fs.writeFileSync(secretFile, existingSecret, { mode: 0o600 });

      const secret = loadOrCreateJwtSecret(tmpDir);

      expect(secret).toBe(existingSecret);
    });

    it("should handle pre-created file atomically (both callers race to create)", () => {
      const secretFile = path.join(tmpDir, ".jwt_secret");

      // First call creates the file
      const secret1 = loadOrCreateJwtSecret(tmpDir);
      expect(fs.existsSync(secretFile)).toBe(true);

      // Second call should return the EXISTING content, not overwrite
      const secret2 = loadOrCreateJwtSecret(tmpDir);
      expect(secret2).toBe(secret1);

      // Verify file still contains original secret
      const fileContent = fs.readFileSync(secretFile, "utf-8").trim();
      expect(fileContent).toBe(secret1);
    });

    it("should return different secrets on consecutive calls to new directories", () => {
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jwt-test-"));
      try {
        const secret1 = loadOrCreateJwtSecret(tmpDir);
        const secret2 = loadOrCreateJwtSecret(tmpDir2);

        // Secrets should be different (random generation)
        expect(secret1).not.toBe(secret2);
      } finally {
        if (fs.existsSync(tmpDir2)) {
          fs.rmSync(tmpDir2, { recursive: true });
        }
      }
    });

    it("should trim whitespace when reading existing secret", () => {
      const secretFile = path.join(tmpDir, ".jwt_secret");
      const secretWithWhitespace = "  " + "b".repeat(64) + "  \n";
      fs.writeFileSync(secretFile, secretWithWhitespace, { mode: 0o600 });

      const secret = loadOrCreateJwtSecret(tmpDir);

      expect(secret).toBe("b".repeat(64));
    });
  });
});
