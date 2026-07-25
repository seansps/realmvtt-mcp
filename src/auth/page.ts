/**
 * The sign-in page served on loopback during `realm_login`.
 *
 * Styled with the Realm VTT occult palette (realm15-web `src/index.css` `:root`):
 * deep near-black backgrounds, `#8b6fc9` purple actions, `#ffb347` gold for headings
 * and glow, `#a599c5` secondary text. Headings use Cinzel like the marketing site,
 * falling back to serif when the webfont can't load — the page stays legible offline.
 *
 * All CSS is inlined; the only external requests are the logo and the font, both
 * from realmvtt.com and both optional to the flow.
 */

export interface PageOptions {
  /** Where the browser is sent to reuse an existing Realm VTT session. */
  handoffUrl: string;
  /** Posted with each form so a stray request from another page can't drive the flow. */
  nonce: string;
  /** Shown above the form when a previous attempt failed. */
  error?: string;
  /** Set when the failure was specifically "this account uses Google Sign-In". */
  googleHint?: boolean;
}

export function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]!);
}

import { INLANDER_WOFF2_BASE64 } from "./assets/inlander-font.js";

const APP_ORIGIN = "https://play.realmvtt.com";
const LOGO_URL = `${APP_ORIGIN}/logo.jpg`;

/**
 * The client's login mark (`realm15-client/src/components/AuthLogo.tsx`): the die
 * photo feathered into a circle by an SVG blur mask, with "Realm VTT" set in
 * Inlander over it, both under the gold candle-flicker glow.
 */
const LOGO_MARKUP = `
  <div class="auth-logo">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <filter id="blur-edge"><feGaussianBlur in="SourceGraphic" stdDeviation="3" /></filter>
        <mask id="blurred-circle-mask">
          <circle cx="50" cy="50" r="45" fill="white" filter="url(#blur-edge)" />
        </mask>
      </defs>
      <image href="${LOGO_URL}" x="0" y="0" width="100" height="100"
             preserveAspectRatio="xMidYMid slice" mask="url(#blurred-circle-mask)"
             opacity="0.8" class="logo-with-glow" />
    </svg>
    <div class="realm-vtt-text">Realm<br>VTT</div>
  </div>`;

/**
 * The brand's three faces, matching the apps:
 *   Inlander — the logo wordmark (self-hosted by the client at play.realmvtt.com)
 *   Cinzel   — headings (realm15-web `.realm-header-font`)
 *   Roboto   — body copy (the client's base font)
 */
const SHELL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600&family=Roboto:wght@400;500;700&display=swap');
  @font-face {
    font-family: 'inlanderregular';
    src: url(data:font/woff2;base64,${INLANDER_WOFF2_BASE64}) format('woff2');
    font-weight: normal; font-style: normal; font-display: block;
  }
  :root {
    --purple: #8b6fc9; --purple-dark: #6b4f9e;
    --gold: #ffb347;
    --text: #e8e4f3; --text-dim: #a599c5;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body, input, button, select, textarea {
    font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  /* The client's occult login shell (Home.module.css .container). */
  body {
    background: linear-gradient(180deg, #020408 0%, #050a15 50%, #0a0e27 100%);
    background-attachment: fixed;
    color: var(--text-dim); margin: 0; padding: 40px 20px; min-height: 100dvh;
    display: flex; align-items: flex-start; justify-content: center;
  }
  .wrap { width: 100%; max-width: 400px; }

  /* Login mark — mirrors AuthLogo.tsx (size "small"), sitting inside the card
     exactly as the client's <AuthLogo> sits inside its <Paper>. */
  .logo { text-align: center; margin: -10px 0 0; }
  .auth-logo { position: relative; display: inline-block; width: 200px; height: 200px; }
  .auth-logo svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .realm-vtt-text {
    position: absolute; left: 51%; top: 50%; transform: translateX(-50%);
    font-family: 'inlanderregular', 'Cinzel', serif; color: #fff; font-weight: bold;
    font-size: 3rem; letter-spacing: .08em; line-height: .95; text-align: center;
    animation: candleFlicker 3s ease-in-out infinite; pointer-events: none; z-index: 10;
  }
  .logo-with-glow { animation: dieGlow 3s ease-in-out infinite; }
  @keyframes candleFlicker {
    0%, 100% { filter: drop-shadow(0 0 8px rgba(255,179,71,.7)) drop-shadow(0 0 20px rgba(255,159,28,.5))
               drop-shadow(0 0 35px rgba(255,139,0,.3)) drop-shadow(4px 4px 8px rgba(0,0,0,.8)); }
    25% { filter: drop-shadow(0 0 10px rgba(255,179,71,.75)) drop-shadow(0 0 22px rgba(255,159,28,.55))
          drop-shadow(0 0 38px rgba(255,139,0,.35)) drop-shadow(4px 4px 8px rgba(0,0,0,.8)); }
    50% { filter: drop-shadow(0 0 6px rgba(255,179,71,.65)) drop-shadow(0 0 18px rgba(255,159,28,.45))
          drop-shadow(0 0 32px rgba(255,139,0,.25)) drop-shadow(4px 4px 8px rgba(0,0,0,.8)); }
    75% { filter: drop-shadow(0 0 12px rgba(255,179,71,.8)) drop-shadow(0 0 24px rgba(255,159,28,.6))
          drop-shadow(0 0 40px rgba(255,139,0,.4)) drop-shadow(4px 4px 8px rgba(0,0,0,.8)); }
  }
  @keyframes dieGlow {
    0%, 100% { filter: brightness(1.2) contrast(1.15) drop-shadow(0 0 25px rgba(255,179,71,.6))
               drop-shadow(0 0 50px rgba(255,159,28,.4)) drop-shadow(0 0 75px rgba(255,139,0,.2)); }
    25% { filter: brightness(1.25) contrast(1.2) drop-shadow(0 0 28px rgba(255,179,71,.65))
          drop-shadow(0 0 55px rgba(255,159,28,.45)) drop-shadow(0 0 80px rgba(255,139,0,.25)); }
    50% { filter: brightness(1.15) contrast(1.1) drop-shadow(0 0 22px rgba(255,179,71,.55))
          drop-shadow(0 0 45px rgba(255,159,28,.35)) drop-shadow(0 0 70px rgba(255,139,0,.15)); }
    75% { filter: brightness(1.3) contrast(1.25) drop-shadow(0 0 30px rgba(255,179,71,.7))
          drop-shadow(0 0 60px rgba(255,159,28,.5)) drop-shadow(0 0 85px rgba(255,139,0,.3)); }
  }
  @media (max-width: 768px) {
    .auth-logo { width: 160px; height: 160px; }
    .realm-vtt-text { font-size: 2.5rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .realm-vtt-text, .logo-with-glow { animation: none; }
  }
  /* The client's occult Paper: translucent, blurred, with a faint gold rim. */
  .card {
    background: rgba(5, 10, 21, 0.85);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 179, 71, 0.2); border-radius: 2px;
    padding: 24px 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5),
                0 0 40px rgba(255, 179, 71, 0.1),
                inset 0 1px 0 rgba(255, 179, 71, 0.1);
  }
  h1 {
    font-family: 'Cinzel', serif; font-weight: 600; letter-spacing: .5px;
    color: var(--gold); font-size: 21px; margin: 0 0 5px; text-align: center;
  }
  .sub { color: var(--text-dim); text-align: center; font-size: 14px; margin: 0 0 22px; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%;
    padding: 11px 16px; border: none; border-radius: 2px; font-size: 15px; font-weight: 500;
    color: #fff; cursor: pointer; text-decoration: none;
    background: linear-gradient(135deg, var(--purple-dark) 0%, var(--purple) 100%);
    box-shadow: 0 2px 8px rgba(107, 79, 158, 0.4);
    transition: all 300ms ease;
  }
  .btn:hover {
    background: linear-gradient(135deg, #7b5fb9 0%, #9b7fd9 100%);
    box-shadow: 0 0 20px rgba(255, 179, 71, 0.3), 0 4px 12px rgba(107, 79, 158, 0.5);
    transform: translateY(-1px);
  }
  .btn.ghost {
    background: none; box-shadow: none;
    border: 1px solid rgba(139, 111, 201, 0.3); color: var(--text-dim);
  }
  .btn.ghost:hover {
    background: rgba(255, 179, 71, 0.1); color: var(--gold);
    border-color: rgba(255, 179, 71, 0.5); box-shadow: none; transform: none;
  }
  .hint { text-align: center; font-size: 13px; color: var(--text-dim); margin-top: 14px; line-height: 1.55; }
  .divider {
    display: flex; align-items: center; margin: 22px 0; color: var(--text-dim);
    font-size: 11px; text-transform: uppercase; letter-spacing: .8px;
  }
  .divider::before, .divider::after {
    content: ''; flex: 1; height: 1px; background: rgba(139, 111, 201, 0.3);
  }
  .divider::before { margin-right: 12px; } .divider::after { margin-left: 12px; }
  label { display: block; font-size: 13px; color: var(--text-dim); margin: 0 0 6px; }
  label .opt { color: rgba(165, 153, 197, 0.6); }
  input {
    width: 100%; padding: 10px 12px;
    background: rgba(3, 7, 14, 0.8); border: 1px solid rgba(139, 111, 201, 0.3);
    border-radius: 2px; font-size: 14px; color: var(--text); outline: none; margin-bottom: 14px;
    transition: all 150ms ease;
  }
  input:focus {
    border-color: rgba(255, 179, 71, 0.5); box-shadow: 0 0 0 2px rgba(255, 179, 71, 0.15);
  }
  input::placeholder { color: rgba(165, 153, 197, 0.6); }
  .err {
    background: rgba(255, 100, 100, 0.15); border: 1px solid rgba(255, 100, 100, 0.3);
    color: #ffc9c9; border-radius: 2px; padding: 11px 13px; font-size: 13px;
    margin-bottom: 18px; line-height: 1.5;
  }
  details {
    margin-top: 20px; border-top: 1px solid rgba(139, 111, 201, 0.3); padding-top: 16px;
  }
  summary { cursor: pointer; font-size: 13px; color: var(--text-dim); }
  summary:hover { color: var(--gold); }
  details p { font-size: 13px; line-height: 1.6; color: var(--text-dim); }
  ol { margin: 12px 0; padding-left: 20px; font-size: 13px; line-height: 1.75; }
  code {
    background: rgba(3, 7, 14, 0.8); border: 1px solid rgba(139, 111, 201, 0.3); padding: 1px 6px;
    border-radius: 2px; font-family: 'SF Mono', Monaco, Consolas, monospace;
    font-size: 12px; color: var(--gold);
  }
  a { color: var(--purple); text-decoration: none; }
  a:hover { color: var(--gold); }
  .foot {
    text-align: center; color: rgba(165, 153, 197, 0.5); font-size: 12px;
    margin-top: 18px; line-height: 1.6;
  }
  .icon {
    width: 58px; height: 58px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; margin: 0 auto 18px; font-size: 28px; color: #fff;
  }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} &middot; Realm VTT</title><style>${SHELL_CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

export function loginPage(opts: PageOptions): string {
  const err = opts.error
    ? `<div class="err">${escapeHtml(opts.error)}${
        opts.googleHint
          ? `<br><br>Use <strong>Connect with Realm VTT</strong> above instead &mdash; that works with Google accounts.`
          : ""
      }</div>`
    : "";

  return shell(
    "Connect",
    `<div class="card">
    <div class="logo">${LOGO_MARKUP}</div>
    <h1>Connect Your Agent</h1>
    <p class="sub">Link this MCP server to your Realm VTT account</p>
    ${err}

    <a class="btn" href="${escapeHtml(opts.handoffUrl)}">Connect with Realm VTT</a>
    <p class="hint">
      Opens Realm VTT and comes straight back.<br>
      Already signed in there? Nothing to type.
    </p>

    <div class="divider">or sign in here</div>

    <form method="POST" action="/submit">
      <input type="hidden" name="nonce" value="${escapeHtml(opts.nonce)}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required
             placeholder="you@example.com">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required
             placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;">
      <label for="code">Authenticator code <span class="opt">(only if 2FA is on)</span></label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
             placeholder="123456">
      <button class="btn ghost" type="submit">Sign In</button>
    </form>

    <details>
      <summary>Signed in with Google, or the button didn't come back?</summary>
      <p>
        Sign in at <a href="https://play.realmvtt.com/login" target="_blank" rel="noreferrer">play.realmvtt.com</a>,
        then click <strong>Connect with Realm VTT</strong> above &mdash; it completes instantly.
      </p>
      <p>Or paste a token manually:</p>
      <ol>
        <li>Sign in at play.realmvtt.com</li>
        <li>Open developer tools (<code>F12</code>)</li>
        <li>Go to <code>Application</code> &rarr; <code>Local Storage</code></li>
        <li>Copy the <code>feathers-jwt</code> value</li>
      </ol>
      <form method="POST" action="/submit">
        <input type="hidden" name="nonce" value="${escapeHtml(opts.nonce)}">
        <label for="token">Token</label>
        <input id="token" name="token" type="text" placeholder="eyJhbGciOiJIUzI1NiIs...">
        <button class="btn ghost" type="submit">Save Token</button>
      </form>
    </details>
  </div>
  <p class="foot">Served by your own machine.<br>Your password is sent to Realm VTT and never stored.</p>`,
  );
}

export function successPage(who?: string): string {
  return shell(
    "Connected",
    `<div class="card" style="text-align:center">
      <div class="logo">${LOGO_MARKUP}</div>
      <div class="icon" style="background:linear-gradient(180deg,#2f9e44,#237634)">&#10003;</div>
      <h1>Connected</h1>
      <p class="sub" style="margin-bottom:0">${
        who ? `Signed in as ${escapeHtml(who)}.<br>` : ""
      }You can close this tab and return to your agent.</p>
    </div>`,
  );
}

export function failurePage(message: string): string {
  return shell(
    "Connection failed",
    `<div class="card" style="text-align:center">
      <div class="logo">${LOGO_MARKUP}</div>
      <div class="icon" style="background:linear-gradient(180deg,#e03131,#a82323)">&#10007;</div>
      <h1>Couldn't Connect</h1>
      <p class="sub">${escapeHtml(message)}</p>
      <a class="btn ghost" href="/">Try Again</a>
    </div>`,
  );
}
