/** Sign-in, identity and campaign-selection tools. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json } from "../api/client.js";
import { runLogin } from "../auth/login-server.js";
import { authStore } from "../auth/store.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, json, safe, text } from "./registry.js";

interface Campaign extends Json {
  _id: string;
  name?: string;
  inviteCode?: string;
  ownerId?: string;
  rulesetId?: string;
}

function daysLeft(expiresAt?: number): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt - Date.now() / 1000) / 86400);
}

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "realm_login",
    {
      title: "Sign in to Realm VTT",
      description:
        "Open a Realm VTT sign-in page in the user's browser and store the resulting token. " +
        "If they are already signed in at play.realmvtt.com this completes with no typing at all " +
        "(including for Google accounts). Otherwise they can sign in with email + password, or " +
        "paste a token. The token is remembered across sessions; call this again when it expires.",
      inputSchema: {},
    },
    safe(async () => {
      const result = await runLogin();
      if (!result.ok) return text(`Sign-in did not complete: ${result.message}`);
      const who = result.user?.displayName || result.user?.email;
      return text(
        `${result.message}${who ? "" : ""}\n\n` +
          `Next: call \`realm_list_campaigns\` to see ${who ? "their" : "the user's"} campaigns, ` +
          `then \`realm_use_campaign\` to pick the one to work in.`,
      );
    }),
  );

  server.registerTool(
    "realm_whoami",
    {
      title: "Show the current Realm VTT session",
      description:
        "Report who is signed in, which campaign is selected, and how long the stored token is " +
        "still valid for. Use this to check the connection before doing real work.",
      inputSchema: {},
    },
    safe(async () => {
      const stored = authStore.read();
      const { token, reason } = authStore.current();
      if (!token) {
        return text(
          reason === "expired"
            ? "The stored Realm VTT session has expired. Call `realm_login` to sign in again."
            : "Not signed in to Realm VTT. Call `realm_login` to connect.",
        );
      }

      const state = session.state();
      const days = daysLeft(stored?.expiresAt);
      return json({
        signedIn: true,
        user: stored?.user ?? (process.env.REALMVTT_JWT ? "(from REALMVTT_JWT)" : undefined),
        api: session.baseUrl(),
        campaign: state.campaignId
          ? { id: state.campaignId, name: state.campaignName, inviteCode: state.inviteCode }
          : null,
        tokenExpiresInDays: days,
        warning:
          reason === "expiring"
            ? "This token expires within a day — run `realm_login` again soon."
            : undefined,
      });
    }),
  );

  server.registerTool(
    "realm_logout",
    {
      title: "Forget the stored Realm VTT login",
      description: "Delete the stored token and campaign selection from this machine.",
      inputSchema: {},
    },
    safe(async () => {
      authStore.clear();
      session.setState({});
      return text("Signed out. The stored Realm VTT token and campaign selection were deleted.");
    }),
  );

  server.registerTool(
    "realm_list_campaigns",
    {
      title: "List the user's Realm VTT campaigns",
      description:
        "List campaigns the signed-in user owns or plays in, with their ids and invite codes. " +
        "Use the id or invite code with `realm_use_campaign`.",
      inputSchema: {},
    },
    safe(async () => {
      const client = session.client();
      const me = authStore.read()?.user?._id;

      return withAuthRecovery(async () => {
        // Owned and joined are separate queries: the service whitelists `ownerId`
        // and `userIds` individually, and there's no OR across them.
        //
        // `userIds` is an ARRAY field, so it needs `$in` — a bare `userIds=<id>` is
        // rejected as a validation failure, and `userIds[]=<id>` would only match
        // campaigns whose member list is EXACTLY that one user.
        const owned = me ? await client.findAll<Campaign>("/campaigns", { ownerId: me }) : [];
        const joined = me
          ? await client.findAll<Campaign>("/campaigns", { userIds: { $in: [me] } })
          : [];

        const byId = new Map<string, Campaign & { role: string }>();
        for (const c of owned) byId.set(String(c._id), { ...c, role: "gm" });
        for (const c of joined) {
          const id = String(c._id);
          if (!byId.has(id)) byId.set(id, { ...c, role: "player" });
        }

        const rows = [...byId.values()].map((c) => ({
          id: String(c._id),
          name: c.name,
          inviteCode: c.inviteCode,
          role: c.role,
          rulesetId: c.rulesetId,
        }));

        if (rows.length === 0) {
          return text(
            "No campaigns found for this account. Create one in Realm VTT first, or check that " +
              "`realm_whoami` shows the account you expect.",
          );
        }
        return json({ campaigns: rows, selected: session.state().campaignId ?? null });
      });
    }),
  );

  server.registerTool(
    "realm_use_campaign",
    {
      title: "Select the campaign to work in",
      description:
        "Set the default campaign for subsequent tools. Accepts a campaign id or an invite code. " +
        "The choice is remembered across sessions.",
      inputSchema: {
        campaign: z.string().describe("Campaign id or invite code."),
      },
    },
    safe(async ({ campaign }: { campaign: string }) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const id = await session.resolveCampaignId(client, campaign);
        const doc = await client.get<Campaign>("/campaigns", id);
        session.setState({
          campaignId: id,
          ...(doc.name ? { campaignName: doc.name } : {}),
          ...(doc.inviteCode ? { inviteCode: doc.inviteCode } : {}),
        });
        return text(`Now working in "${doc.name ?? id}" (${id}).`);
      });
    }),
  );

  // `campaignArg` is exercised by the content tools; referenced here so the shared
  // shape stays in one module.
  void campaignArg;
}
