/**
 * Session state shared by every tool: the authenticated API client and the
 * "current campaign" the user selected, so they don't have to name a campaign on
 * every single call.
 *
 * Kept in a small JSON file next to the credential, because an MCP server is
 * restarted whenever the host feels like it and re-picking a campaign each time
 * would be tedious.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RealmClient, DEFAULT_BASE_URL, type Json } from "./api/client.js";
import { ApiError, AuthRequiredError } from "./api/errors.js";
import { authStore, configDir, type AuthStore } from "./auth/store.js";

export interface SessionState {
  campaignId?: string;
  campaignName?: string;
  inviteCode?: string;
  /** Where this user keeps their ruleset-compiler checkout, once we've been told. */
  rulesetCompilerPath?: string;
}

export function statePath(): string {
  return join(configDir(), "state.json");
}

export class Session {
  private readonly path: string;
  private readonly store: AuthStore;
  private cached: SessionState | null = null;

  constructor(path: string = statePath(), store: AuthStore = authStore) {
    this.path = path;
    this.store = store;
  }

  state(): SessionState {
    if (this.cached) return this.cached;
    try {
      this.cached = existsSync(this.path)
        ? (JSON.parse(readFileSync(this.path, "utf8")) as SessionState)
        : {};
    } catch {
      this.cached = {};
    }
    return this.cached;
  }

  setState(next: SessionState): void {
    this.cached = next;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
  }

  baseUrl(): string {
    return process.env.REALMVTT_API_URL || this.store.read()?.baseUrl || DEFAULT_BASE_URL;
  }

  /**
   * An authenticated client, or a thrown AuthRequiredError naming the tool that
   * fixes it. Tools never construct a client themselves, so the "are we logged in"
   * check can't be forgotten in one place and not another.
   */
  client(): RealmClient {
    const { token, reason } = this.store.current();
    if (!token) {
      throw new AuthRequiredError(
        reason === "expired"
          ? "Your Realm VTT session has expired."
          : "Not signed in to Realm VTT.",
      );
    }
    return new RealmClient(this.baseUrl(), token);
  }

  /** Drop the stored credential after the API rejects it, so the next call re-prompts. */
  invalidate(): void {
    this.store.clear();
  }

  /**
   * Resolve which campaign a call targets. `override` may be an id or an invite
   * code; without one we fall back to the campaign the user selected earlier.
   */
  async resolveCampaignId(client: RealmClient, override?: string): Promise<string> {
    if (override) {
      // A Mongo ObjectId is 24 hex chars; anything else is an invite code.
      if (/^[a-f0-9]{24}$/i.test(override)) return override;
      const campaign = await client.campaignByInviteCode(override);
      if (!campaign?._id) {
        throw new Error(
          `No campaign found for invite code "${override}". Use \`realm_list_campaigns\` to see what's available.`,
        );
      }
      return String(campaign._id);
    }

    const current = this.state().campaignId;
    if (current) return current;

    throw new Error(
      "No campaign selected. Call `realm_list_campaigns` to see the user's campaigns, then " +
        "`realm_use_campaign` to pick one — or pass `campaign` (an id or invite code) to this tool.",
    );
  }

  /** The signed-in user, from the stored login. */
  user(): Json | undefined {
    return this.store.read()?.user as Json | undefined;
  }

  tokenExpiry(): number | undefined {
    return this.store.read()?.expiresAt;
  }
}

export const session = new Session();

/**
 * Run an API call, converting a rejected credential into the re-login prompt.
 *
 * A 401 mid-session means the token died (or was revoked) since we last checked
 * its `exp`. Clearing it here means the very next tool call re-prompts rather than
 * failing the same way forever.
 */
export async function withAuthRecovery<T>(fn: () => Promise<T>, s: Session = session): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      s.invalidate();
      throw new AuthRequiredError("Realm VTT rejected the stored session token.");
    }
    throw err;
  }
}
