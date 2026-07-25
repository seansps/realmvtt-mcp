/**
 * Creature tokens on a scene.
 *
 * A token is an INSTANCE of a record (an NPC, a character) placed on a scene —
 * distinct from `scene-objects-3d`, which holds the scenery. Six goblins on a map
 * are six token documents all pointing at one NPC record.
 *
 * Tokens work the same way on 2D and 3D scenes; only `position.z` and `flying`
 * mean anything extra in 3D. Whether a token renders as a flat image or a 3D mini
 * comes from its RECORD (`token.imageUrl` / `token.model3D`), not from the token —
 * see `realm_set_3d_token`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { sceneTypeOf, type SceneType } from "./scenes3d.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** Which record a token can instantiate. */
const TOKEN_RECORD_TYPES = ["npcs", "characters", "records"] as const;

export interface TokenRow extends Json {
  _id: string;
  name?: string;
  recordType?: string;
  recordId?: string;
  position?: { x: number; y: number; z: number };
  rotation?: number;
  visible?: boolean;
  faction?: string;
  flying?: boolean;
}

/** Trim a token to what's worth reading back. */
export function summarizeToken(t: TokenRow): Json {
  return {
    id: t._id,
    name: t.name,
    recordType: t.recordType,
    recordId: t.recordId,
    position: t.position,
    ...(t.rotation ? { rotation: t.rotation } : {}),
    ...(t.faction ? { faction: t.faction } : {}),
    ...(t.flying ? { flying: true } : {}),
    visible: t.visible ?? true,
  };
}

/**
 * Build a token document from the record it instantiates.
 *
 * Mirrors the app's `addTokenToScene`: the token carries its own name and
 * identified state so a GM can rename one goblin of six, and `linked: true` keeps
 * its data in step with the source record.
 */
export function buildToken(opts: {
  campaignId: string;
  sceneId: string;
  layerIndex: number;
  record: Json;
  recordType: string;
  x: number;
  y: number;
  z?: number;
  name?: string;
  rotation?: number;
  visible?: boolean;
  faction?: string;
  flying?: boolean;
  linked?: boolean;
}): Json {
  const record = opts.record;
  return {
    campaignId: opts.campaignId,
    sceneId: opts.sceneId,
    layerIndex: opts.layerIndex,
    position: { x: opts.x, y: opts.y, z: opts.z ?? 0 },
    rotation: opts.rotation ?? 0,
    visible: opts.visible ?? true,
    recordType: opts.recordType,
    recordId: String(record._id),
    name: opts.name ?? (record.name as string | undefined),
    ...(record.unidentifiedName ? { unidentifiedName: record.unidentifiedName } : {}),
    // NPCs can be unidentified; default to identified unless the record says otherwise.
    identified: record.identified === false ? false : true,
    ...(opts.faction ? { faction: opts.faction } : {}),
    ...(opts.flying ? { flying: true } : {}),
    linked: opts.linked ?? true,
    effectIds: [],
    data: {},
  };
}

/**
 * What placing a token on this scene actually means.
 *
 * Tokens are the same documents on every scene type, but two fields only mean
 * something in 3D: `position.z` (elevation in cubes) and `flying`. Sending them to
 * a 2D scene isn't an error — it just silently does nothing — so we drop them and
 * say so, rather than letting a caller believe it stacked tokens on a 2D map.
 */
export function reconcileWithScene(
  type: SceneType,
  wanted: { z?: number; flying?: boolean },
): { z?: number; flying?: boolean; notes: string[] } {
  const notes: string[] = [];
  if (type === "3d") {
    return {
      ...(wanted.z !== undefined ? { z: wanted.z } : {}),
      ...(wanted.flying ? { flying: true } : {}),
      notes,
    };
  }

  if (wanted.z !== undefined && wanted.z !== 0) {
    notes.push(
      `This is a ${type} (2D) scene, so elevation z=${wanted.z} was ignored — 2D tokens sit flat on the grid.`,
    );
  }
  if (wanted.flying) {
    notes.push(`This is a ${type} (2D) scene, so \`flying\` was ignored; it only applies in 3D.`);
  }
  return { notes };
}

/** Does this record have a 3D mini, or will it fall back to its flat token image? */
export function has3dMini(record: Json): boolean {
  const token = record.token as { model3D?: { url?: string } } | undefined;
  return Boolean(token?.model3D?.url);
}

/** Resolve a record by id or name, so callers can say "Goblin" instead of an id. */
async function resolveRecord(
  client: RealmClient,
  campaignId: string,
  type: string,
  ref: string,
): Promise<Json> {
  if (/^[a-f0-9]{24}$/i.test(ref)) {
    const { path } = client.recordEndpoint(type);
    return client.get<Json>(path, ref);
  }

  const found = await client.findRecords<Json>(type, campaignId, { name: ref, $limit: 1 });
  const record = found.data[0];
  if (record) return record;

  // Fall back to a fuzzy search before giving up — exact-name matching is strict.
  const search = await client.findRecords<Json>(type, campaignId, { $search: ref, $limit: 5 });
  if (search.data[0]) return search.data[0];

  throw new Error(
    `No ${type} record named "${ref}" in this campaign. Find it with \`realm_find_records\`.`,
  );
}

export function registerTokenTools(server: McpServer): void {
  server.registerTool(
    "realm_list_tokens",
    {
      title: "List the tokens on a scene",
      description:
        "List the creature tokens placed on a scene, with their positions and the records they " +
        "come from. Works for both 2D and 3D scenes.",
      inputSchema: {
        sceneId: z.string(),
        recordId: z.string().optional().describe("Only tokens instantiating this record."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Record<string, string | number> = { campaignId, sceneId: args.sceneId };
        if (args.recordId) query.recordId = args.recordId;

        const tokens = await client.findAll<TokenRow>("/tokens", query);
        return json({
          sceneId: args.sceneId,
          total: tokens.length,
          tokens: tokens.map(summarizeToken),
        });
      });
    }),
  );

  server.registerTool(
    "realm_place_tokens",
    {
      title: "Place creature tokens on a scene",
      description:
        "Place creature tokens — NPCs, monsters, characters — onto a scene. This is how you drop " +
        "'six goblins around the campfire' onto a map; it is separate from `realm_place_objects`, " +
        "which places SCENERY (tiles, props, lights).\n\n" +
        "`record` names the creature once (by name or id) and `at` lists every square to put one " +
        "on, so a group is a single call. Positions are GRID COORDINATES, the same x/y the 3D " +
        "scenery uses.\n\n" +
        "On a 3D scene, `z` is elevation in cubes — leave it at 0 to stand on the ground floor, " +
        "or set it to a floor's walking surface (e.g. 2.9 for a second storey) to place a token " +
        "upstairs. Set `flying: true` only for a creature genuinely in the air; a grounded token " +
        "settles onto whatever surface is beneath it.\n\n" +
        "Whether a token appears as a flat image or a 3D mini depends on the RECORD, so use " +
        "`realm_set_3d_token` first if a monster has no mini yet.",
      inputSchema: {
        sceneId: z.string(),
        record: z.string().describe("The creature's record name or id (e.g. `Goblin`)."),
        type: z
          .enum(TOKEN_RECORD_TYPES)
          .optional()
          .describe("Which record type it is. Default `npcs`."),
        at: z
          .array(
            z.object({
              x: z.number().describe("Grid x."),
              y: z.number().describe("Grid y."),
              z: z.number().optional().describe("Elevation in cubes (3D scenes). Default 0."),
              name: z.string().optional().describe("Override this one token's name."),
              rotation: z.number().optional().describe("Facing, in degrees."),
            }),
          )
          .min(1)
          .describe("One entry per token to place."),
        faction: z
          .enum(["friend", "enemy", "neutral"])
          .optional()
          .describe("Token faction; colours the ring and drives targeting."),
        visible: z.boolean().optional().describe("Visible to players. Default true."),
        flying: z.boolean().optional().describe("Mark these tokens as airborne (3D)."),
        layer: z.number().int().optional().describe("Layer index. Default 0."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      const type = args.type ?? "npcs";

      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const [record, scene] = await Promise.all([
          resolveRecord(client, campaignId, type, args.record),
          client.get<Json>("/scenes", args.sceneId),
        ]);

        if (scene.campaignId && String(scene.campaignId) !== campaignId) {
          return text(
            `Scene ${args.sceneId} belongs to a different campaign than the one selected.`,
          );
        }

        const sceneType = sceneTypeOf(scene);
        const notes = new Set<string>();

        // The tokens service allows bulk REMOVE but not bulk create, so each token
        // is its own request — unlike scene-objects-3d. Sequential, so a failure
        // part-way is reported with what already landed.
        const created: Json[] = [];
        for (const spot of args.at) {
          const adjusted = reconcileWithScene(sceneType, {
            ...(spot.z !== undefined ? { z: spot.z } : {}),
            ...(args.flying ? { flying: true } : {}),
          });
          for (const note of adjusted.notes) notes.add(note);

          const token = await client.create<TokenRow>(
            "/tokens",
            buildToken({
              campaignId,
              sceneId: args.sceneId,
              layerIndex: args.layer ?? 0,
              record,
              recordType: type,
              x: spot.x,
              y: spot.y,
              ...(adjusted.z !== undefined ? { z: adjusted.z } : {}),
              ...(spot.name ? { name: spot.name } : {}),
              ...(spot.rotation !== undefined ? { rotation: spot.rotation } : {}),
              ...(args.faction ? { faction: args.faction } : {}),
              ...(args.visible !== undefined ? { visible: args.visible } : {}),
              ...(adjusted.flying ? { flying: true } : {}),
            }),
          );
          created.push(summarizeToken(token));
        }

        // On a 3D scene a record with no mini still places fine, but renders from
        // its flat token image rather than as a model — worth saying, since it's
        // fixable in one call.
        if (sceneType === "3d" && !has3dMini(record)) {
          notes.add(
            `"${record.name}" has no 3D mini, so these render from its flat token image. ` +
              `Give it one with \`realm_set_3d_token\` (find one via \`realm_search_3d_tokens\`).`,
          );
        }

        return json({
          placed: created.length,
          scene: { id: args.sceneId, name: scene.name, type: sceneType },
          from: { record: record.name, id: record._id, type },
          tokens: created,
          ...(notes.size ? { notes: [...notes] } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_move_token",
    {
      title: "Move or edit a token on a scene",
      description:
        "Change a placed token: move it (`x`/`y`, plus `z` for elevation on a 3D scene), turn it, " +
        "rename it, hide it, change its faction, or mark it flying. Only the fields you pass are " +
        "changed.\n\n" +
        "Use `sceneId` + `layer` together to move a token to a different scene.",
      inputSchema: {
        tokenId: z.string().describe("The placed token's id."),
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional().describe("Elevation in cubes (3D scenes)."),
        rotation: z.number().optional().describe("Facing, in degrees."),
        name: z.string().optional(),
        visible: z.boolean().optional(),
        faction: z.enum(["friend", "enemy", "neutral"]).optional(),
        flying: z.boolean().optional(),
        sceneId: z.string().optional().describe("Move the token to this scene."),
        layer: z.number().int().optional().describe("Layer index on the target scene."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const patch: Json = {};

        // Position is a whole object, so a partial move has to start from where the
        // token currently is rather than defaulting the missing axes to 0.
        if (args.x !== undefined || args.y !== undefined || args.z !== undefined) {
          const current = await client.get<TokenRow>("/tokens", args.tokenId);
          const pos = current.position ?? { x: 0, y: 0, z: 0 };
          patch.position = {
            x: args.x ?? pos.x,
            y: args.y ?? pos.y,
            z: args.z ?? pos.z,
          };
        }

        for (const key of ["rotation", "name", "visible", "faction", "flying"] as const) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        if (args.sceneId) patch.sceneId = args.sceneId;
        if (args.layer !== undefined) patch.layerIndex = args.layer;

        if (Object.keys(patch).length === 0) {
          return text("Nothing to change — pass at least one field.");
        }

        return json({
          updated: summarizeToken(await client.patch<TokenRow>("/tokens", args.tokenId, patch)),
        });
      });
    }),
  );

  server.registerTool(
    "realm_delete_tokens",
    {
      title: "Remove tokens from a scene",
      description:
        "Remove placed tokens. Pass `tokenIds` for specific ones, or `sceneId` with `record` to " +
        "clear every token of one creature off a scene (e.g. all the goblins). Deleting a token " +
        "removes it from the scene only — the NPC record it came from is untouched. " +
        "Requires confirm: true.",
      inputSchema: {
        tokenIds: z.array(z.string()).optional().describe("Specific token ids to remove."),
        sceneId: z.string().optional().describe("Scene to clear tokens from."),
        record: z
          .string()
          .optional()
          .describe("With `sceneId`: remove only tokens of this record (name or id)."),
        type: z.enum(TOKEN_RECORD_TYPES).optional().describe("Record type for `record`. Default `npcs`."),
        ...confirmArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();

      return withAuthRecovery(async () => {
        let ids = args.tokenIds ?? [];

        if (ids.length === 0) {
          if (!args.sceneId) {
            return text("Pass `tokenIds`, or `sceneId` (optionally with `record`) to clear a scene.");
          }
          const campaignId = await session.resolveCampaignId(client, args.campaign);
          const query: Record<string, string | number> = { campaignId, sceneId: args.sceneId };

          if (args.record) {
            const record = await resolveRecord(client, campaignId, args.type ?? "npcs", args.record);
            query.recordId = String(record._id);
          }
          ids = (await client.findAll<TokenRow>("/tokens", query)).map((t) => String(t._id));
        }

        if (ids.length === 0) return text("No matching tokens found.");
        requireConfirm(args.confirm, `remove ${ids.length} token(s)`);

        for (const id of ids) await client.remove("/tokens", id);
        return text(`Removed ${ids.length} token${ids.length === 1 ? "" : "s"}.`);
      });
    }),
  );
}
