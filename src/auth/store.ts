/**
 * Where the Realm VTT credential lives between MCP sessions.
 *
 * One JSON file under the user's home directory, written 0600. Realm's JWTs last
 * 30 days and there is no refresh token, so "remembering the login" means storing
 * the token and knowing when it dies — we read the `exp` claim rather than waiting
 * for a 401, so a tool can ask for a fresh sign-in before doing half a job.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredAuth {
  accessToken: string;
  baseUrl: string;
  /** Seconds since the epoch, from the token's own `exp` claim. */
  expiresAt?: number;
  user?: { _id?: string; email?: string; displayName?: string };
}

/** Re-prompt this far ahead of the real expiry, so a long task doesn't die halfway. */
export const EXPIRY_GRACE_SECONDS = 24 * 60 * 60;

export function configDir(): string {
  return process.env.REALMVTT_MCP_HOME || join(homedir(), ".realmvtt-mcp");
}

export function authFilePath(): string {
  return join(configDir(), "auth.json");
}

/**
 * Read the `exp` claim out of a JWT without verifying it — we can't verify (the
 * signing secret is the server's), and we don't need to: this only decides when to
 * ask for a new token. A malformed or claim-less token reports "unknown", and an
 * unknown expiry is treated as usable until the API says otherwise.
 */
export function decodeExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

export interface TokenState {
  token: string | null;
  /** Why there's no usable token, for the message handed back to the model. */
  reason?: "missing" | "expired" | "expiring";
  auth?: StoredAuth;
  /** True when the token came from REALMVTT_JWT rather than the store. */
  fromEnv?: boolean;
}

export class AuthStore {
  private readonly path: string;

  constructor(path: string = authFilePath()) {
    this.path = path;
  }

  read(): StoredAuth | null {
    try {
      if (!existsSync(this.path)) return null;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as StoredAuth;
      return raw && typeof raw.accessToken === "string" && raw.accessToken ? raw : null;
    } catch {
      // A truncated or hand-mangled file is the same situation as no file at all.
      return null;
    }
  }

  save(auth: StoredAuth): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: StoredAuth = {
      ...auth,
      expiresAt: auth.expiresAt ?? decodeExpiry(auth.accessToken),
    };
    writeFileSync(this.path, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    // writeFileSync's mode only applies when it CREATES the file; an existing file
    // keeps its old permissions, so set them explicitly every time.
    chmodSync(this.path, 0o600);
  }

  clear(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Nothing to do — the next read reports "missing" either way.
    }
  }

  /**
   * The token to use right now, or the reason there isn't one.
   *
   * `REALMVTT_JWT` wins when set: it's the escape hatch for CI and headless runs,
   * where opening a browser isn't an option.
   */
  current(now: number = Math.floor(Date.now() / 1000)): TokenState {
    const envToken = process.env.REALMVTT_JWT?.trim();
    if (envToken) return { token: envToken, fromEnv: true };

    const auth = this.read();
    if (!auth) return { token: null, reason: "missing" };

    if (auth.expiresAt !== undefined) {
      if (auth.expiresAt <= now) return { token: null, reason: "expired", auth };
      if (auth.expiresAt - now <= EXPIRY_GRACE_SECONDS) {
        // Still valid, but not for long — hand it back AND flag it so `whoami`
        // can warn. Refusing here would break a working session for no reason.
        return { token: auth.accessToken, reason: "expiring", auth };
      }
    }
    return { token: auth.accessToken, auth };
  }
}

export const authStore = new AuthStore();
