import { hash, compare } from "bcryptjs";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Settings } from "./config.js";

// bcryptjs's async hash()/compare() cooperatively yield the event loop
// during the round computation (unlike hashSync/compareSync, which block
// solid for the whole call) — this is a real Node HTTP service (Phase 3),
// so async is the right default even though v1's Python bcrypt.hashpw was
// effectively synchronous either way.
const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hashed: string): Promise<boolean> {
  return compare(password, hashed);
}

// ==================== JWT ====================

export class AuthError extends Error {
  statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TokenUser {
  id: number;
  username: string;
  role: string;
}

export interface DecodedToken {
  user_id: number;
  username: string;
  role: string;
  exp: number;
  iat: number;
}

/**
 * Payload shape mirrors v1's create_token (app/auth.py) exactly: `sub`
 * carries the user id AS A STRING — the JWT registered-claim convention
 * (StringOrURI) that both PyJWT and jsonwebtoken expect — not a bespoke
 * "user_id" key on the wire. `iat`/`exp` are left to the library (jwt.sign's
 * expiresIn) rather than hand-computed, same numeric-seconds-since-epoch
 * representation PyJWT produces under the hood.
 */
export function createToken(user: TokenUser, settings: Settings): string {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    settings.jwtSecret,
    {
      algorithm: "HS256",
      // Seconds, not a "24h"-style string — sidesteps jsonwebtoken's
      // StringValue template-literal type entirely and is unambiguous.
      expiresIn: settings.tokenExpireHours * 3600,
    }
  );
}

/**
 * Decodes+verifies a token, normalizing `sub` back to a numeric `user_id`
 * (mirrors what v1's get_current_user does with `int(payload["sub"])`).
 * Two error branches, matching v1's decode_token exactly:
 *   - expired signature -> AuthError("Token expired")
 *   - anything else invalid (bad signature, malformed, wrong algorithm,
 *     not-yet-valid) -> AuthError("Invalid token")
 * jsonwebtoken's TokenExpiredError extends JsonWebTokenError, so — same as
 * PyJWT's ExpiredSignatureError extending InvalidTokenError — the expired
 * check must come first or it'd never be reached.
 */
export function decodeToken(token: string, settings: Settings): DecodedToken {
  let payload: JwtPayload | string;
  try {
    payload = jwt.verify(token, settings.jwtSecret, { algorithms: ["HS256"] });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AuthError("Token expired");
    }
    throw new AuthError("Invalid token");
  }
  if (typeof payload === "string") {
    // We only ever sign object payloads; a bare-string payload means the
    // token wasn't one of ours.
    throw new AuthError("Invalid token");
  }
  return {
    user_id: Number(payload.sub),
    username: payload.username,
    role: payload.role,
    exp: payload.exp as number,
    iat: payload.iat as number,
  };
}

// ==================== Admin bootstrap ====================

/**
 * Narrow structural interface satisfied by BOTH `Storage` (src/db/storage.ts,
 * sync/better-sqlite3) and `DbClient` (src/db/client.ts, worker-backed
 * promises) — ensureAdminUser doesn't care which one it's handed. `await`ing
 * a value that isn't a thenable just resolves to it on the next microtask
 * (no behavior change), so a single async function works unmodified against
 * either concrete implementation.
 */
export interface UserStore {
  getUserByUsername(username: string): unknown;
  createUser(username: string, passwordHash: string, role?: string): unknown;
}

/**
 * Create the initial admin user if it doesn't exist yet. Idempotent: a
 * second call finds the existing user and no-ops (no warning, no re-create,
 * no UNIQUE constraint error). Warning copy is verbatim v1's
 * app/main.py:ensure_admin_user startup print.
 */
export async function ensureAdminUser(store: UserStore, settings: Settings): Promise<void> {
  const existing = await store.getUserByUsername(settings.adminUsername);
  if (existing) {
    return;
  }
  if (settings.adminPassword === "admin123") {
    console.log("=".repeat(60));
    console.log("⚠️  WARNING: Using default admin password 'admin123'!");
    console.log("   Set APP_ADMIN_PASSWORD in .env for production use.");
    console.log("=".repeat(60));
  }
  const passwordHash = await hashPassword(settings.adminPassword);
  await store.createUser(settings.adminUsername, passwordHash, "admin");
  console.log(`Admin user '${settings.adminUsername}' created`);
}
