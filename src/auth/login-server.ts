/**
 * The loopback sign-in flow behind `realm_login`.
 *
 * Starts a throwaway HTTP server bound to 127.0.0.1, opens the user's browser at it,
 * and waits for a token to arrive by one of three routes:
 *
 *   1. `/callback?access_token=…` — the browser was sent to Realm VTT's own login
 *      page with `?oauth_redirect=<our callback>`, which bounces straight back when
 *      the user already has a session there. No typing, and it works for Google
 *      accounts because it reuses whatever session the browser holds.
 *   2. `POST /submit` with email + password (+ 2FA code) — exchanged for a JWT here.
 *   3. `POST /submit` with a pasted token.
 *
 * Security posture: loopback-only bind, a one-time nonce on both forms, a hard
 * timeout, and the token is moved out of the URL by a redirect so it doesn't linger
 * in the address bar or browser history. Passwords are forwarded to Realm VTT and
 * never written to disk or logged.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { RealmClient, DEFAULT_BASE_URL } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { failurePage, loginPage, successPage } from "./page.js";
import { authStore, decodeExpiry, type AuthStore, type StoredAuth } from "./store.js";

export const DEFAULT_APP_URL = "https://play.realmvtt.com";
const TIMEOUT_MS = 5 * 60 * 1000;
/** A password + token form can't legitimately be large; cap the body we'll buffer. */
const MAX_BODY_BYTES = 16 * 1024;

export interface LoginOptions {
  baseUrl?: string;
  appUrl?: string;
  store?: AuthStore;
  /** Injected in tests; defaults to launching the real browser. */
  openBrowser?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}

export interface LoginResult {
  ok: boolean;
  message: string;
  user?: StoredAuth["user"];
  /** How the token arrived, for the message we hand back to the model. */
  via?: "session" | "password" | "token";
}

/** Constant-time compare that tolerates length mismatch without throwing. */
export function nonceMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * The message a failed sign-in should show. Realm VTT rejects password login for
 * Google-created accounts with a specific, actionable message — we surface it as-is
 * and flag it so the page can point at the button that does work.
 */
export function describeAuthFailure(err: unknown): { message: string; googleHint: boolean } {
  if (err instanceof ApiError) {
    const google = /google/i.test(err.message);
    if (err.status === 401) {
      // Strip our own "API 401: … [POST url]" framing; the user wants the reason.
      const inner = err.message.replace(/^API \d+:\s*/, "").replace(/\s*\[[^\]]*\]$/, "");
      return { message: inner || "Invalid login.", googleHint: google };
    }
    return { message: err.message.replace(/\s*\[[^\]]*\]$/, ""), googleHint: google };
  }
  return {
    message: err instanceof Error ? err.message : "Sign-in failed.",
    googleHint: false,
  };
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // The page posts only to itself. Inlander is inlined as a data: URI, so the only
    // network dependencies left are the logo image and Google Fonts, both optional to
    // the flow. No script source is allowed at all — the page has no JavaScript.
    "Content-Security-Policy":
      "default-src 'none'; img-src https://play.realmvtt.com; " +
      "style-src 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src data: https://fonts.gstatic.com; " +
      "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

export async function runLogin(options: LoginOptions = {}): Promise<LoginResult> {
  const baseUrl = options.baseUrl || process.env.REALMVTT_API_URL || DEFAULT_BASE_URL;
  const appUrl = options.appUrl || process.env.REALMVTT_APP_URL || DEFAULT_APP_URL;
  const store = options.store || authStore;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const nonce = randomUUID();
  const client = new RealmClient(baseUrl);

  return new Promise<LoginResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let server: Server;

    const finish = (result: LoginResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Let the browser render the final page before the socket dies.
      setTimeout(() => server.close(), 250);
      resolve(result);
    };

    /** Persist a token and end the flow. Verifies it by asking the API who it belongs to. */
    const acceptToken = async (
      token: string,
      via: LoginResult["via"],
      user?: StoredAuth["user"],
    ): Promise<{ ok: true; who?: string } | { ok: false; message: string }> => {
      let trimmed = token.trim();
      if (!trimmed) return { ok: false, message: "No token was provided." };

      let resolvedUser = user;
      if (!resolvedUser) {
        // A pasted or handed-off token is unverified. Ask the API to validate it and
        // say who it belongs to — better than storing a dud and failing on the user's
        // first real request.
        try {
          const me = await client.verifyToken(trimmed);
          resolvedUser = me?.user;
          // Feathers re-issues on a successful jwt exchange. Keep the fresh token —
          // it carries a full 30-day window rather than whatever was left on the old one.
          if (me?.accessToken) trimmed = me.accessToken;
        } catch (err) {
          const detail = err instanceof Error ? err.message.replace(/\s*\[[^\]]*\]$/, "") : "";
          return {
            ok: false,
            message:
              "That token was rejected by Realm VTT. It may be expired or from another site." +
              (detail ? ` (${detail})` : ""),
          };
        }
      }

      store.save({
        accessToken: trimmed,
        baseUrl,
        expiresAt: decodeExpiry(trimmed),
        ...(resolvedUser ? { user: resolvedUser } : {}),
      });
      const who = resolvedUser?.displayName || resolvedUser?.email;
      finish({
        ok: true,
        message: `Connected to Realm VTT${who ? ` as ${who}` : ""}.`,
        ...(resolvedUser ? { user: resolvedUser } : {}),
        ...(via ? { via } : {}),
      });
      return who ? { ok: true, who } : { ok: true };
    };

    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const port = (server.address() as AddressInfo | null)?.port ?? 0;
        const callback = `http://127.0.0.1:${port}/callback`;
        const handoff = `${appUrl}/login?oauth_redirect=${encodeURIComponent(callback)}`;
        const render = (error?: string, googleHint = false) =>
          send(res, error ? 400 : 200, loginPage({ handoffUrl: handoff, nonce, ...(error ? { error } : {}), googleHint }));

        try {
          // Realm VTT bounced back with a token in the query string.
          if (url.pathname === "/callback") {
            const token = url.searchParams.get("access_token") || url.searchParams.get("token");
            if (!token) {
              return render("Realm VTT didn't send a token back. Try signing in below.");
            }
            const outcome = await acceptToken(token, "session");
            if (!outcome.ok) return render(outcome.message);
            // Redirect so the token leaves the address bar (and the history entry).
            res.writeHead(302, { Location: "/done", "Cache-Control": "no-store" });
            return res.end();
          }

          if (url.pathname === "/done") {
            return send(res, 200, successPage(store.read()?.user?.displayName || store.read()?.user?.email));
          }

          if (url.pathname === "/submit" && req.method === "POST") {
            const form = await readBody(req);
            if (!nonceMatches(nonce, form.get("nonce"))) {
              return send(res, 403, failurePage("This form is stale. Reload the page and try again."));
            }

            const pasted = form.get("token")?.trim();
            if (pasted) {
              const outcome = await acceptToken(pasted, "token");
              if (!outcome.ok) return render(outcome.message);
              return send(res, 200, successPage(outcome.who));
            }

            const email = form.get("email")?.trim();
            const password = form.get("password");
            if (!email || !password) {
              return render("Enter both an email and a password.");
            }

            try {
              const code = form.get("code")?.trim();
              const auth = await client.authenticate(email, password, code || undefined);
              if (!auth?.accessToken) throw new Error("Realm VTT returned no token.");
              const outcome = await acceptToken(auth.accessToken, "password", auth.user);
              if (!outcome.ok) return render(outcome.message);
              return send(res, 200, successPage(outcome.who));
            } catch (err) {
              const { message, googleHint } = describeAuthFailure(err);
              return render(message, googleHint);
            }
          }

          if (url.pathname === "/") return render();
          send(res, 404, failurePage("Page not found."));
        } catch (err) {
          send(res, 500, failurePage(err instanceof Error ? err.message : "Something went wrong."));
        }
      })();
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: false, message: `Couldn't start the local sign-in server: ${err.message}` });
    });

    // Port 0 = let the OS pick a free one; 127.0.0.1 = never reachable off this machine.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const localUrl = `http://127.0.0.1:${port}/`;
      const open = options.openBrowser ?? (async (u: string) => (await import("open")).default(u));
      void open(localUrl).catch(() => {
        // Headless or no browser configured — the URL is in the tool result either way.
      });

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.close();
        resolve({ ok: false, message: "Sign-in timed out after 5 minutes. Run `realm_login` again." });
      }, timeoutMs);
      timer.unref?.();
    });
  });
}

/** The loopback URL for a running flow, so the tool result can print it. */
export function loginUrlFor(server: Server): string {
  const addr = server.address() as AddressInfo | null;
  return `http://127.0.0.1:${addr?.port ?? 0}/`;
}
