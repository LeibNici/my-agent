import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import jwt from "jsonwebtoken";
import {
  hashPassword,
  verifyPassword,
  createToken,
  decodeToken,
  ensureAdminUser,
  AuthError,
  type UserStore,
} from "../src/auth.js";
import type { Settings } from "../src/config.js";
import { loadSettings } from "../src/config.js";
import { openStorage, type Storage } from "../src/db/storage.js";
import { createDbClient, type DbClient } from "../src/db/client.js";
import { makeSeededDb } from "./db-fixture.js";

// Takes env-var-shaped overrides (loadSettings' own input shape), not
// Settings' camelCase fields — keeps this a thin wrapper around the real
// config loader rather than a second, parallel settings-construction path.
function settingsWith(envOverrides: Record<string, string> = {}): Settings {
  return loadSettings({
    APP_JWT_SECRET: "test-secret-do-not-use-in-prod",
    APP_TOKEN_EXPIRE_HOURS: "24",
    APP_ADMIN_USERNAME: "admin",
    APP_ADMIN_PASSWORD: "admin123",
    ...envOverrides,
  });
}

describe("hashPassword / verifyPassword", () => {
  it("round-trips: verify(password, hash(password)) === true", async () => {
    const hashed = await hashPassword("correct horse battery staple");
    expect(hashed).not.toBe("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hashed)).resolves.toBe(true);
  });

  it("wrong password verifies false", async () => {
    const hashed = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", hashed)).resolves.toBe(false);
  });

  it("two hashes of the same password differ (random salt per call)", async () => {
    const h1 = await hashPassword("same-password");
    const h2 = await hashPassword("same-password");
    expect(h1).not.toBe(h2);
  });
});

describe("createToken / decodeToken", () => {
  const settings = settingsWith();
  const user = { id: 7, username: "engineer1", role: "user" };

  it("round-trip carries user_id/username/role", () => {
    const token = createToken(user, settings);
    const decoded = decodeToken(token, settings);
    expect(decoded.user_id).toBe(7);
    expect(decoded.username).toBe("engineer1");
    expect(decoded.role).toBe("user");
    expect(typeof decoded.exp).toBe("number");
    expect(typeof decoded.iat).toBe("number");
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it("signs with HS256 and a `sub` claim holding the stringified user id (v1 wire-shape parity)", () => {
    const token = createToken(user, settings);
    const header = jwt.decode(token, { complete: true })?.header;
    expect(header?.alg).toBe("HS256");
    const raw = jwt.decode(token) as jwt.JwtPayload;
    expect(raw.sub).toBe("7");
  });

  it("exp reflects settings.tokenExpireHours", () => {
    const shortSettings = settingsWith({ APP_TOKEN_EXPIRE_HOURS: "1" });
    const token = createToken(user, shortSettings);
    const decoded = decodeToken(token, shortSettings);
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it("expired token -> AuthError('Token expired') with statusCode 401", () => {
    const expiredToken = jwt.sign(
      { sub: "7", username: "engineer1", role: "user" },
      settings.jwtSecret,
      { algorithm: "HS256", expiresIn: -10 } // already-expired the instant it's signed
    );
    let caught: unknown;
    try {
      decodeToken(expiredToken, settings);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as AuthError).message).toBe("Token expired");
    expect((caught as AuthError).statusCode).toBe(401);
  });

  it("malformed token -> AuthError('Invalid token')", () => {
    expect(() => decodeToken("not-a-jwt-at-all", settings)).toThrow(AuthError);
    expect(() => decodeToken("not-a-jwt-at-all", settings)).toThrow("Invalid token");
  });

  it("wrong-secret token -> AuthError('Invalid token')", () => {
    const tokenFromElsewhere = jwt.sign(
      { sub: "7", username: "engineer1", role: "user" },
      "a-different-secret",
      { algorithm: "HS256", expiresIn: "1h" }
    );
    expect(() => decodeToken(tokenFromElsewhere, settings)).toThrow(AuthError);
    expect(() => decodeToken(tokenFromElsewhere, settings)).toThrow("Invalid token");
  });

  it("bare-string payload token -> AuthError('Invalid token')", () => {
    const stringPayloadToken = jwt.sign("just-a-string", settings.jwtSecret, {
      algorithm: "HS256",
    });
    expect(() => decodeToken(stringPayloadToken, settings)).toThrow("Invalid token");
  });
});

describe("ensureAdminUser — fake UserStore (sync, proves structural interface accepts sync returns)", () => {
  function makeFakeSyncStore(seed: Record<string, unknown> = {}) {
    const users = new Map<string, unknown>(Object.entries(seed));
    let nextId = Object.keys(seed).length + 1;
    const createUser = vi.fn(
      (username: string, passwordHash: string, role = "user", mustChangePassword = false) => {
        const row = { id: nextId++, username, password_hash: passwordHash, role, mustChangePassword };
        users.set(username, row);
        return row.id;
      }
    );
    const store: UserStore = {
      getUserByUsername: (username: string) => users.get(username) ?? null,
      createUser,
    };
    return { store, users, createUser };
  }

  it("creates the admin user when absent", async () => {
    const { store, users } = makeFakeSyncStore();
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(store, settings);
    expect(users.has("admin")).toBe(true);
  });

  it("is idempotent: second call does not create again", async () => {
    const { store, createUser } = makeFakeSyncStore();
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(store, settings);
    await ensureAdminUser(store, settings);
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("no-ops silently when the admin user already exists", async () => {
    const { store, createUser } = makeFakeSyncStore({
      admin: { id: 1, username: "admin", password_hash: "x", role: "admin" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const settings = settingsWith();
    await ensureAdminUser(store, settings);
    expect(createUser).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("prints the loud verbatim warning when the default password is in use", async () => {
    const { store } = makeFakeSyncStore();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "admin123" });
    await ensureAdminUser(store, settings);
    const lines = logSpy.mock.calls.map((c) => c[0]);
    expect(lines).toContain("=".repeat(60));
    expect(lines).toContain("⚠️  WARNING: Using default admin password 'admin123'!");
    expect(lines).toContain("   Set APP_ADMIN_PASSWORD in .env for production use.");
    expect(lines).toContain("Admin user 'admin' created");
    logSpy.mockRestore();
  });

  it("stays silent (no warning block) when a custom password is set", async () => {
    const { store } = makeFakeSyncStore();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "a-real-production-password" });
    await ensureAdminUser(store, settings);
    const lines = logSpy.mock.calls.map((c) => c[0]);
    expect(lines.some((l) => String(l).includes("WARNING"))).toBe(false);
    expect(lines).toContain("Admin user 'admin' created");
    logSpy.mockRestore();
  });

  it("stores a bcrypt hash the admin's real password verifies against, not the plaintext", async () => {
    const { store, users } = makeFakeSyncStore();
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(store, settings);
    const row = users.get("admin") as { password_hash: string };
    expect(row.password_hash).not.toBe("custom-strong-pw");
    await expect(verifyPassword("custom-strong-pw", row.password_hash)).resolves.toBe(true);
  });

  it("BUG-003: bootstrapping with the well-known default password passes mustChangePassword=true to createUser", async () => {
    const { store, createUser } = makeFakeSyncStore();
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "admin123" });
    await ensureAdminUser(store, settings);
    expect(createUser).toHaveBeenCalledWith("admin", expect.any(String), "admin", true);
  });

  it("BUG-003: bootstrapping with an operator-supplied password passes mustChangePassword=false", async () => {
    const { store, createUser } = makeFakeSyncStore();
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "a-real-production-password" });
    await ensureAdminUser(store, settings);
    expect(createUser).toHaveBeenCalledWith("admin", expect.any(String), "admin", false);
  });
});

describe("ensureAdminUser — real Storage (sync/better-sqlite3)", () => {
  let dir: string, storage: Storage;
  beforeEach(() => {
    const f = makeSeededDb();
    dir = f.dir;
    storage = openStorage(f.dbPath);
  });
  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an admin row queryable back via getUserByUsername", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(storage, settings);
    const row = storage.getUserByUsername("admin");
    expect(row).not.toBeNull();
    expect(row!.role).toBe("admin");
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("idempotent against the real DB: second call does not throw UNIQUE constraint", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(storage, settings);
    await expect(ensureAdminUser(storage, settings)).resolves.toBeUndefined();
  });

  it("BUG-003: bootstrap with the default password persists must_change_password=1 on the real row", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "admin123" });
    await ensureAdminUser(storage, settings);
    expect(storage.getUserByUsername("admin")!.must_change_password).toBe(1);
  });

  it("BUG-003: bootstrap with a custom password persists must_change_password=0", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(storage, settings);
    expect(storage.getUserByUsername("admin")!.must_change_password).toBe(0);
  });
});

describe("ensureAdminUser — real DbClient (async/worker-backed)", () => {
  let dir: string, client: DbClient;
  beforeEach(() => {
    const f = makeSeededDb();
    dir = f.dir;
    client = createDbClient(f.dbPath);
  });
  afterEach(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an admin row queryable back via getUserByUsername through the worker", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(client, settings);
    const row = await client.getUserByUsername("admin");
    expect(row).not.toBeNull();
    expect(row!.role).toBe("admin");
  });

  it("idempotent through the worker: second call does not throw", async () => {
    const settings = settingsWith({ APP_ADMIN_PASSWORD: "custom-strong-pw" });
    await ensureAdminUser(client, settings);
    await expect(ensureAdminUser(client, settings)).resolves.toBeUndefined();
    const row = await client.getUserByUsername("admin");
    expect(row).not.toBeNull();
  });
});
