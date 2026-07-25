import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, EXPIRY_GRACE_SECONDS, decodeExpiry } from "./store.js";

const NOW = 1_800_000_000;

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

let dir: string;
let path: string;
let store: AuthStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "realmvtt-mcp-test-"));
  path = join(dir, "nested", "auth.json");
  store = new AuthStore(path);
  delete process.env.REALMVTT_JWT;
});

afterEach(() => {
  delete process.env.REALMVTT_JWT;
});

describe("decodeExpiry", () => {
  it("reads the exp claim without verifying the signature", () => {
    expect(decodeExpiry(jwt({ exp: 1234, sub: "u" }))).toBe(1234);
  });

  it("returns undefined for a token with no exp, or one that isn't a JWT at all", () => {
    expect(decodeExpiry(jwt({ sub: "u" }))).toBeUndefined();
    expect(decodeExpiry("not-a-jwt")).toBeUndefined();
    expect(decodeExpiry("")).toBeUndefined();
    expect(decodeExpiry("a.!!!not-base64!!!.c")).toBeUndefined();
  });
});

describe("save / read", () => {
  it("creates the directory, stores the token, and derives expiresAt from the claim", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    expect(store.read()?.expiresAt).toBe(NOW + 100);
  });

  it("writes the file 0600 — it holds a live credential", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("re-tightens permissions on an existing loose file (writeFileSync's mode only applies on create)", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    chmodSync(path, 0o644);
    store.save({ accessToken: jwt({ exp: NOW + 200 }), baseUrl: "https://x.test" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as no credential rather than throwing", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    writeFileSync(path, "{ this is not json");
    expect(store.read()).toBeNull();
    expect(store.current(NOW).reason).toBe("missing");
  });

  it("treats a file with an empty token as no credential", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    writeFileSync(path, JSON.stringify({ accessToken: "", baseUrl: "https://x.test" }));
    expect(store.read()).toBeNull();
  });

  it("clear removes the credential", () => {
    store.save({ accessToken: jwt({ exp: NOW + 100 }), baseUrl: "https://x.test" });
    store.clear();
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it("round-trips the user record so whoami works without a network call", () => {
    store.save({
      accessToken: jwt({ exp: NOW + 100 }),
      baseUrl: "https://x.test",
      user: { _id: "u1", email: "gm@example.test" },
    });
    expect(store.read()?.user?.email).toBe("gm@example.test");
    expect(JSON.parse(readFileSync(path, "utf8")).user._id).toBe("u1");
  });
});

describe("current()", () => {
  it("reports missing when nothing is stored", () => {
    expect(store.current(NOW)).toEqual({ token: null, reason: "missing" });
  });

  it("returns a healthy token with no reason", () => {
    const token = jwt({ exp: NOW + 30 * 24 * 3600 });
    store.save({ accessToken: token, baseUrl: "https://x.test" });
    const state = store.current(NOW);
    expect(state.token).toBe(token);
    expect(state.reason).toBeUndefined();
  });

  it("refuses an expired token", () => {
    store.save({ accessToken: jwt({ exp: NOW - 1 }), baseUrl: "https://x.test" });
    const state = store.current(NOW);
    expect(state.token).toBeNull();
    expect(state.reason).toBe("expired");
  });

  it("still returns a token inside the grace window, flagged as expiring", () => {
    const token = jwt({ exp: NOW + EXPIRY_GRACE_SECONDS - 60 });
    store.save({ accessToken: token, baseUrl: "https://x.test" });
    const state = store.current(NOW);
    expect(state.token).toBe(token);
    expect(state.reason).toBe("expiring");
  });

  it("treats the grace boundary itself as expiring, and one second past it as healthy", () => {
    store.save({ accessToken: jwt({ exp: NOW + EXPIRY_GRACE_SECONDS }), baseUrl: "https://x.test" });
    expect(store.current(NOW).reason).toBe("expiring");

    store.save({ accessToken: jwt({ exp: NOW + EXPIRY_GRACE_SECONDS + 1 }), baseUrl: "https://x.test" });
    expect(store.current(NOW).reason).toBeUndefined();
  });

  it("accepts a token with no exp claim rather than guessing it's dead", () => {
    const token = jwt({ sub: "u" });
    store.save({ accessToken: token, baseUrl: "https://x.test" });
    const state = store.current(NOW);
    expect(state.token).toBe(token);
    expect(state.reason).toBeUndefined();
  });

  it("lets REALMVTT_JWT override the stored credential, even an expired one", () => {
    store.save({ accessToken: jwt({ exp: NOW - 1 }), baseUrl: "https://x.test" });
    process.env.REALMVTT_JWT = "  env-token  ";
    const state = store.current(NOW);
    expect(state.token).toBe("env-token");
    expect(state.fromEnv).toBe(true);
  });

  it("ignores a blank REALMVTT_JWT so an empty env var doesn't shadow a real login", () => {
    const token = jwt({ exp: NOW + 100 });
    store.save({ accessToken: token, baseUrl: "https://x.test" });
    process.env.REALMVTT_JWT = "   ";
    expect(store.current(NOW).token).toBe(token);
  });
});
