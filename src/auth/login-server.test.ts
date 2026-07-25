import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors.js";
import { describeAuthFailure, nonceMatches, runLogin, type LoginResult } from "./login-server.js";
import { escapeHtml, failurePage, loginPage, successPage } from "./page.js";
import { AuthStore } from "./store.js";

/**
 * The genuine `fetch`, captured before any test stubs the global. Requests to the
 * local login server must go over the network for real; only the server's OUTBOUND
 * calls to the Realm API are stubbed.
 */
const realFetch = globalThis.fetch.bind(globalThis);

function jwt(payload: Record<string, unknown> = { exp: 4_000_000_000 }): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

/**
 * Drive a real `runLogin` server: capture the URL it tries to open, run the caller's
 * interaction against it, then hand back the flow's pending outcome.
 *
 * The outcome is returned WRAPPED so awaiting this helper doesn't also await the
 * flow — several tests exercise requests that deliberately leave the flow open, and
 * those settle via the (short) timeout instead.
 */
async function withLoginServer(
  fn: (base: string) => Promise<void>,
  opts: { store: AuthStore; timeoutMs?: number },
): Promise<{ result: Promise<LoginResult> }> {
  let baseUrl = "";
  let ready: (v: void) => void;
  const opened = new Promise<void>((r) => (ready = r));

  const result = runLogin({
    baseUrl: "https://api.test",
    appUrl: "https://app.test",
    store: opts.store,
    timeoutMs: opts.timeoutMs ?? 5000,
    openBrowser: async (url) => {
      baseUrl = url.replace(/\/$/, "");
      ready();
    },
  });

  await opened;
  await fn(baseUrl);
  return { result };
}

/** Pull the anti-replay nonce out of a rendered page. */
async function nonceFrom(base: string): Promise<string> {
  const page = await (await realFetch(`${base}/`)).text();
  const match = /name="nonce" value="([^"]+)"/.exec(page);
  if (!match?.[1]) throw new Error("no nonce on the page");
  return match[1];
}

let store: AuthStore;

beforeEach(() => {
  store = new AuthStore(join(mkdtempSync(join(tmpdir(), "realm-login-")), "auth.json"));
});
afterEach(() => vi.unstubAllGlobals());

describe("nonceMatches", () => {
  const nonce = "a".repeat(36);

  it("accepts the exact nonce and rejects everything else", () => {
    expect(nonceMatches(nonce, nonce)).toBe(true);
    expect(nonceMatches(nonce, "b".repeat(36))).toBe(false);
  });

  it("rejects wrong-length and non-string values without throwing", () => {
    expect(nonceMatches(nonce, "short")).toBe(false);
    expect(nonceMatches(nonce, "")).toBe(false);
    expect(nonceMatches(nonce, undefined)).toBe(false);
    expect(nonceMatches(nonce, null)).toBe(false);
    expect(nonceMatches(nonce, 12345)).toBe(false);
  });
});

describe("describeAuthFailure", () => {
  it("strips our error framing so the user sees Realm's own reason", () => {
    const err = new ApiError(401, "Invalid login", "POST", "https://api.test/authentication");
    expect(describeAuthFailure(err)).toEqual({ message: "Invalid login", googleHint: false });
  });

  it("flags the Google-only account rejection so the page can redirect the user", () => {
    const err = new ApiError(
      401,
      "This account uses Google Sign-In. Please set a password first, or sign in with Google.",
      "POST",
      "https://api.test/authentication",
    );
    const out = describeAuthFailure(err);
    expect(out.googleHint).toBe(true);
    expect(out.message).toContain("Google Sign-In");
  });

  it("handles a non-API error", () => {
    expect(describeAuthFailure(new Error("socket hang up")).message).toBe("socket hang up");
    expect(describeAuthFailure("weird").message).toBe("Sign-in failed.");
  });
});

describe("page rendering", () => {
  const page = loginPage({ handoffUrl: "https://app.test/login?oauth_redirect=x", nonce: "N" });

  it("offers the session handoff first, with the callback encoded into it", () => {
    expect(page).toContain("Connect with Realm VTT");
    expect(page).toContain("https://app.test/login?oauth_redirect=x");
  });

  it("carries the nonce on both forms", () => {
    expect(page.match(/name="nonce" value="N"/g)).toHaveLength(2);
  });

  it("uses the client's login mark and brand fonts", () => {
    expect(page).toContain("play.realmvtt.com/logo.jpg");
    expect(page).toContain("inlanderregular");
    expect(page).toContain("Cinzel");
  });

  it("ships no JavaScript at all", () => {
    expect(page).not.toContain("<script");
    expect(page).not.toContain("onclick");
  });

  it("surfaces an error and points Google users at the button that works", () => {
    const withErr = loginPage({
      handoffUrl: "https://app.test/login",
      nonce: "N",
      error: "This account uses Google Sign-In.",
      googleHint: true,
    });
    expect(withErr).toContain("This account uses Google Sign-In.");
    expect(withErr).toContain("that works with Google accounts");
  });

  it("escapes untrusted text rather than interpolating it raw", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    const evil = loginPage({ handoffUrl: "https://app.test", nonce: "N", error: "<script>bad()</script>" });
    expect(evil).not.toContain("<script>bad()");
    expect(evil).toContain("&lt;script&gt;bad()");
    expect(failurePage("</div><script>x</script>")).not.toContain("<script>x");
    expect(successPage("<b>me</b>")).not.toContain("<b>me</b>");
  });
});

describe("the session handoff (path 1)", () => {
  it("stores a token handed back by Realm VTT and redirects it out of the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ user: { _id: "u1", email: "gm@example.test" } }),
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    const token = jwt();
    let redirect: string | null = null;
    // (this flow stores the handed-off token as-is, since the API returned no fresh one)
    const { result } = await withLoginServer(
      async (base) => {
        const res = await realFetch(`${base}/callback?access_token=${token}`, { redirect: "manual" });
        redirect = res.headers.get("location");
      },
      { store },
    );

    const settled = await result;
    expect(settled.ok).toBe(true);
    expect(settled.via).toBe("session");
    expect(redirect).toBe("/done");
    expect(store.read()?.accessToken).toBe(token);
    expect(store.read()?.user?.email).toBe("gm@example.test");
  });

  it("re-renders the form when Realm VTT comes back without a token", async () => {
    let body = "";
    // Nothing was stored, so the flow stays open for another attempt and ends on the timeout.
    const { result } = await withLoginServer(
      async (base) => {
        body = await (await realFetch(`${base}/callback`)).text();
      },
      { store, timeoutMs: 50 },
    );
    expect(body).toContain("didn&#39;t send a token back");
    expect(store.read()).toBeNull();
    expect((await result).ok).toBe(false);
  });

  it("rejects a token the API won't accept instead of storing a dud", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ message: "jwt expired" }),
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    let body = "";
    const { result } = await withLoginServer(
      async (base) => {
        body = await (await realFetch(`${base}/callback?access_token=${jwt()}`)).text();
      },
      { store, timeoutMs: 50 },
    );
    expect(body).toContain("rejected by Realm VTT");
    expect(store.read()).toBeNull();
    expect((await result).ok).toBe(false);
  });
});

describe("password sign-in (path 2)", () => {
  it("exchanges credentials for a token and stores it", async () => {
    const token = jwt();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), body: init.body ? JSON.parse(init.body as string) : null });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ accessToken: token, user: { _id: "u2", displayName: "GM" } }),
          text: async () => "",
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    let body = "";
    const { result } = await withLoginServer(
      async (base) => {
        const nonce = await nonceFrom(base);
        body = await (
          await realFetch(`${base}/submit`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ nonce, email: "gm@example.test", password: "pw", code: "123456" }),
          })
        ).text();
      },
      { store },
    );

    const settled = await result;
    expect(settled.ok).toBe(true);
    expect(settled.via).toBe("password");
    expect(body).toContain("Connected");
    expect(store.read()?.accessToken).toBe(token);
    // The credential went to Realm VTT, and only the token was persisted.
    expect(calls[0]!.body).toMatchObject({ strategy: "local", email: "gm@example.test", code: "123456" });
    expect(JSON.stringify(store.read())).not.toContain("pw");
  });

  it("refuses a submission carrying the wrong nonce", async () => {
    let status = 0;
    const { result } = await withLoginServer(
      async (base) => {
        const res = await realFetch(`${base}/submit`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ nonce: "not-the-nonce", email: "a@b.test", password: "pw" }),
        });
        status = res.status;
      },
      { store, timeoutMs: 50 },
    );
    expect(status).toBe(403);
    expect(store.read()).toBeNull();
    expect((await result).ok).toBe(false);
  });

  it("shows Realm's own message when the credentials are wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ message: "Invalid login" }),
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    let body = "";
    const { result } = await withLoginServer(
      async (base) => {
        const nonce = await nonceFrom(base);
        body = await (
          await realFetch(`${base}/submit`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ nonce, email: "a@b.test", password: "wrong" }),
          })
        ).text();
      },
      { store, timeoutMs: 50 },
    );
    expect(body).toContain("Invalid login");
    expect(store.read()).toBeNull();
    expect((await result).ok).toBe(false);
  });
});

describe("pasted token (path 3)", () => {
  it("verifies a pasted token against the API before storing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ user: { _id: "u3", email: "paste@example.test" } }),
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    const token = jwt();
    const { result } = await withLoginServer(
      async (base) => {
        const nonce = await nonceFrom(base);
        await realFetch(`${base}/submit`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ nonce, token: `  ${token}  ` }),
        });
      },
      { store },
    );

    const settled = await result;
    expect(settled.ok).toBe(true);
    expect(settled.via).toBe("token");
    expect(store.read()?.user?.email).toBe("paste@example.test");
    // Stored trimmed, with the expiry read off the claim.
    expect(store.read()?.accessToken).toBe(token);
    expect(store.read()?.expiresAt).toBe(4_000_000_000);
  });
});

describe("server hardening", () => {
  it("binds to loopback only", async () => {
    let host = "";
    const { result } = await withLoginServer(
      async (base) => {
        host = new URL(base).hostname;
      },
      { store, timeoutMs: 50 },
    );
    expect(host).toBe("127.0.0.1");
    await result;
  });

  it("sends no-store and a script-free CSP with the page", async () => {
    let headers: Headers | undefined;
    const { result } = await withLoginServer(
      async (base) => {
        headers = (await realFetch(`${base}/`)).headers;
      },
      { store, timeoutMs: 50 },
    );
    expect(headers?.get("cache-control")).toBe("no-store");
    const csp = headers?.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("script-src");
    await result;
  });

  it("gives up after the timeout instead of hanging the tool call forever", async () => {
    const result = await runLogin({
      baseUrl: "https://api.test",
      store,
      timeoutMs: 30,
      openBrowser: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out");
  });
});
