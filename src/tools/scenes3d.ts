/**
 * 3D scene tools: the asset catalog, and reading/writing the objects placed on a
 * scene.
 *
 * The placement model is a continuous grid — there is no story/level field. A
 * multi-story building is just objects at different `pos.z`. The invariants that
 * bite hardest (floor thickness, wall seating, prop facing) are repeated in the
 * tool descriptions AND in the `3d-scene-authoring` guide, because getting them
 * wrong produces a scene that looks plausible in JSON and broken in the renderer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** Objects per create request. The service takes an array; this keeps each POST sane. */
const CHUNK = 250;

export interface CatalogRow extends Json {
  assetId: string;
  name?: string;
  kind?: string;
  role?: string;
  category?: string;
  baseScale?: number;
  depth?: number;
  family?: string;
  familyMaterial?: string;
  familyThickness?: string;
  shape?: string;
  widthCells?: number;
  tags?: string[];
  light?: Json | null;
  stair?: Json | null;
  walkable?: boolean | null;
  modelPath?: string;
}

/** The catalog fields worth showing; the raw docs carry texture maps we never need. */
export function compactAsset(a: CatalogRow): Json {
  const out: Json = { assetId: a.assetId, name: a.name, kind: a.kind };
  for (const k of [
    "role",
    "category",
    "baseScale",
    "depth",
    "family",
    "familyMaterial",
    "familyThickness",
    "shape",
    "widthCells",
    "tags",
    "walkable",
  ] as const) {
    if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  }
  // Presence matters more than the blob: a lit prop must copy `light` onto its placement.
  if (a.light) out.light = a.light;
  if (a.stair) out.stair = a.stair;
  if (!a.modelPath) out.noModel = true;
  return out;
}

/** A Realm-provided 3D mini from the `tokens-3d` catalog. */
export interface CatalogToken extends Json {
  assetId: string;
  name: string;
  category?: string;
  modelPath: string;
  previewPath?: string;
  baseScale?: number;
  usePedestal?: boolean;
  frontFaceDeg?: number;
  offsetX?: number;
  offsetZ?: number;
  offsetY?: number;
}

/**
 * Catalog token → the `token.model3D` a record stores.
 *
 * Mirrors the app's picker: the catalog's own scale / pedestal / front-face
 * defaults ride along, so the mini renders as its author intended rather than at
 * some arbitrary size. `url` is normalised to a LEADING SLASH — the catalog stores
 * `modelPath` without one and the renderer expects it.
 */
export function toModel3D(t: CatalogToken): Json {
  return {
    url: t.modelPath.startsWith("/") ? t.modelPath : `/${t.modelPath}`,
    catalogId: t.assetId,
    ...(t.baseScale != null ? { baseScale: t.baseScale } : {}),
    ...(t.usePedestal != null ? { usePedestal: t.usePedestal } : {}),
    ...(t.frontFaceDeg != null ? { frontFaceDeg: t.frontFaceDeg } : {}),
    ...(t.offsetX != null ? { offsetX: t.offsetX } : {}),
    ...(t.offsetZ != null ? { offsetZ: t.offsetZ } : {}),
    ...(t.offsetY != null ? { offsetY: t.offsetY } : {}),
  };
}

const placementSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "One placed object: { kind: 'tile'|'prop'|'light', assetId, pos: {x,y,z}, rot: 0-23, " +
      "and optionally scale, pitch, roll, blocksVision, portal, light, roof }.",
  );

async function resolveScene(client: RealmClient, sceneId: string, campaignId: string): Promise<Json> {
  const scene = await client.get<Json>("/scenes", sceneId);
  if (scene.campaignId && String(scene.campaignId) !== campaignId) {
    throw new Error(
      `Scene ${sceneId} belongs to a different campaign than the one selected. ` +
        `Pass the right \`campaign\`, or re-run \`realm_use_campaign\`.`,
    );
  }
  return scene;
}

export function registerScene3dTools(server: McpServer): void {
  server.registerTool(
    "realm_list_scenes",
    {
      title: "List scenes in the campaign",
      description:
        "List the campaign's scenes. `renderer` is `3d` for scenes built with the 3D builder, " +
        "`standard`/`canvas` for 2D maps — the 3D tools only apply to `3d` scenes.",
      inputSchema: {
        only3d: z.boolean().optional().describe("Only return scenes whose renderer is `3d`."),
        search: z.string().optional().describe("Filter by name."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Record<string, string | number> = { campaignId, $limit: 50 };
        if (args.search) query.$search = args.search;
        const res = await client.find<Json>("/scenes", query);
        const rows = res.data
          .map((s) => ({
            id: s._id,
            name: s.name,
            renderer: s.renderer ?? "standard",
            active: s.active,
            category: s.category,
          }))
          .filter((s) => !args.only3d || s.renderer === "3d");
        return json({ total: res.total, returned: rows.length, scenes: rows });
      });
    }),
  );

  server.registerTool(
    "realm_search_3d_assets",
    {
      title: "Search the 3D asset catalog",
      description:
        "Search the shared 3D asset catalog (floors, walls, doors, windows, props, lights, roofs). " +
        "Every placed object references an `assetId` from here, so look assets up before placing. " +
        "Filter by kind (tile/prop/light), role (floor/wall/door/window/prop/roof/light), category " +
        "(folder-like, e.g. `fantasy/dungeon`), family (a wall + its matched doors/windows), tag, " +
        "or a name/id regex.",
      inputSchema: {
        kind: z.enum(["tile", "prop", "light"]).optional(),
        role: z.enum(["floor", "wall", "door", "window", "prop", "roof", "light"]).optional(),
        category: z.string().optional().describe("Category regex, e.g. `fantasy/(dungeon|general)`."),
        family: z.string().optional().describe("Exact wall-family id."),
        tag: z.string().optional().describe("Require this tag."),
        search: z.string().optional().describe("Regex matched against assetId and name."),
        limit: z.number().int().min(1).max(300).optional().describe("Max rows (default 60)."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        // The catalog is small enough to page fully, and filtering here supports
        // regexes the service's query language doesn't.
        const all = await client.assets3d<CatalogRow>();
        const rx = (p?: string) => (p ? new RegExp(p, "i") : null);
        const cat = rx(args.category);
        const needle = rx(args.search);

        const matches = all.filter(
          (a) =>
            (!args.kind || a.kind === args.kind) &&
            (!args.role || a.role === args.role) &&
            (!args.family || a.family === args.family) &&
            (!cat || cat.test(a.category ?? "")) &&
            (!args.tag || (a.tags ?? []).includes(args.tag)) &&
            (!needle || needle.test(a.assetId) || needle.test(a.name ?? "")),
        );

        const limit = args.limit ?? 60;
        return json({
          catalogSize: all.length,
          matched: matches.length,
          returned: Math.min(matches.length, limit),
          assets: matches.slice(0, limit).map(compactAsset),
          ...(matches.length > limit ? { note: "Narrow the filters to see the rest." } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_search_3d_tokens",
    {
      title: "Search the 3D token (mini) catalog",
      description:
        "Search Realm's curated 3D TOKEN catalog — the minis that represent creatures on a 3D " +
        "scene. This is a separate catalog from `realm_search_3d_assets` (which holds scenery: " +
        "floors, walls, props). Use it to find a mini for an NPC or character, then apply it with " +
        "`realm_set_3d_token`.",
      inputSchema: {
        search: z.string().optional().describe("Free-text search across token names."),
        category: z.string().optional().describe("Exact category to filter by."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const query: Record<string, string | number> = {};
        if (args.search) query.$search = args.search;
        if (args.category) query.category = args.category;

        const all = await client.findAll<CatalogToken>("/tokens-3d", query);
        const limit = args.limit ?? 50;
        return json({
          matched: all.length,
          returned: Math.min(all.length, limit),
          tokens: all.slice(0, limit).map((t) => ({
            assetId: t.assetId,
            name: t.name,
            category: t.category,
            baseScale: t.baseScale,
          })),
          ...(all.length > limit ? { note: "Narrow the search to see the rest." } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_set_3d_token",
    {
      title: "Give a record a 3D token (mini)",
      description:
        "Set the 3D model an NPC or character uses on 3D scenes, from the token catalog. Pass the " +
        "`assetId` from `realm_search_3d_tokens`; the catalog's scale, pedestal and facing " +
        "defaults are carried over automatically.\n\n" +
        "This is the record's 3D representation and is separate from its 2D token image — both " +
        "can be set, and the right one is used per scene type. Pass `clear: true` to remove the " +
        "3D model and fall back to the flat token.",
      inputSchema: {
        recordId: z.string().describe("The NPC's or character's id."),
        type: z
          .enum(["npcs", "characters", "records"])
          .optional()
          .describe("Which endpoint the record lives on. Default `npcs`."),
        assetId: z.string().optional().describe("Catalog token assetId to apply."),
        clear: z.boolean().optional().describe("Remove the 3D model instead of setting one."),
      },
    },
    safe(async (args) => {
      const type = args.type ?? "npcs";
      if (!args.assetId && !args.clear) {
        return text("Pass an `assetId` to set a token, or `clear: true` to remove one.");
      }

      const client = session.client();
      return withAuthRecovery(async () => {
        const { path } = client.recordEndpoint(type);
        const record = await client.get<Json>(path, args.recordId);
        // The 2D token settings live alongside model3D and must survive the patch.
        const token = { ...((record.token as Json) ?? {}) };

        if (args.clear) {
          delete token.model3D;
          await client.patch(path, args.recordId, { token });
          return text(`Removed the 3D token from ${record.name ?? args.recordId}.`);
        }

        const matches = await client.findAll<CatalogToken>("/tokens-3d", { assetId: args.assetId! });
        const catalogToken = matches[0];
        if (!catalogToken) {
          return text(
            `No 3D token with assetId "${args.assetId}". Search for one with \`realm_search_3d_tokens\`.`,
          );
        }

        token.model3D = toModel3D(catalogToken);
        await client.patch(path, args.recordId, { token });
        return json({
          record: { id: args.recordId, name: record.name },
          model3D: token.model3D,
        });
      });
    }),
  );

  server.registerTool(
    "realm_get_scene_objects",
    {
      title: "Read the objects placed on a 3D scene",
      description:
        "Inspect a 3D scene's contents. Returns a SUMMARY (counts by kind and asset, plus the z " +
        "levels in use) by default, because a built scene can hold thousands of objects. Use " +
        "`saveTo` to dump the full array to a file for analysis.",
      inputSchema: {
        sceneId: z.string(),
        saveTo: z.string().optional().describe("Write the full object array to this path."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const objects = await client.sceneObjects3d<Json>(args.sceneId, campaignId);

        const byKind: Record<string, number> = {};
        const byAsset: Record<string, number> = {};
        const zLevels = new Set<number>();
        for (const o of objects) {
          const kind = String(o.kind ?? "?");
          byKind[kind] = (byKind[kind] ?? 0) + 1;
          const asset = String(o.assetId ?? "(none)");
          byAsset[asset] = (byAsset[asset] ?? 0) + 1;
          const pos = o.pos as { z?: number } | undefined;
          if (typeof pos?.z === "number") zLevels.add(pos.z);
        }

        let savedTo: string | undefined;
        if (args.saveTo) {
          const target = isAbsolute(args.saveTo) ? args.saveTo : resolve(process.cwd(), args.saveTo);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, JSON.stringify(objects, null, 2), "utf8");
          savedTo = target;
        }

        return json({
          sceneId: args.sceneId,
          total: objects.length,
          byKind,
          topAssets: Object.fromEntries(
            Object.entries(byAsset)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 30),
          ),
          zLevels: [...zLevels].sort((a, b) => a - b),
          ...(savedTo ? { savedTo } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_place_objects",
    {
      title: "Place objects on a 3D scene",
      description:
        "Bulk-create placed objects on a 3D scene. campaignId/sceneId/layerIndex are filled in, so " +
        "each object only carries geometry.\n\n" +
        "GEOMETRY RULES (violating these produces a scene that looks wrong in the renderer):\n" +
        "• A floor slab is 0.45 thick; a tile at pos.z has its walking surface at z+0.45.\n" +
        "• Ground story: floor z=0, walls z=0.45. Walls sit ON TOP of the slab or the floor pokes " +
        "up through doorways.\n" +
        "• Walls are one piece per cell EDGE. Edge rot: 0=north(+y), 6=east(+x), 12=south(-y), 18=west(-x).\n" +
        "• Props are baked front=-Z, so a rot byte points the front: 0→-y, 6→-x, 12→+y, 18→+x. " +
        "A prop against the north wall faces the room at rot 0.\n" +
        "• An integer prop pos is the CELL CENTRE. Props are base-anchored, so rest one on a " +
        "surface by setting pos.z to that surface's z.\n" +
        "• A light-emitting prop must carry the catalog asset's `light` blob on the PLACEMENT — " +
        "the renderer reads the placed object's light, not the asset's.\n" +
        "Call `realm_guide` with topic `3d-scene-authoring` before building anything substantial.",
      inputSchema: {
        sceneId: z.string(),
        objects: z.array(placementSchema).min(1).describe("The objects to place."),
        layer: z.number().int().optional().describe("Layer index (default 0)."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        await resolveScene(client, args.sceneId, campaignId);

        const objects = args.objects.map((o) => ({
          campaignId,
          sceneId: args.sceneId,
          layerIndex: args.layer ?? 0,
          ...(o as Json),
        }));

        let created = 0;
        for (let i = 0; i < objects.length; i += CHUNK) {
          const batch = objects.slice(i, i + CHUNK);
          const res = await client.createSceneObjects3d<Json[]>(batch);
          created += Array.isArray(res) ? res.length : batch.length;
        }
        return text(`Placed ${created} object${created === 1 ? "" : "s"} on scene ${args.sceneId}.`);
      });
    }),
  );

  server.registerTool(
    "realm_update_object",
    {
      title: "Update one placed 3D object",
      description:
        "Patch a single placed object (move it, rotate it, toggle a door, change its light). " +
        "Pass `portal: null` or `light: null` to CLEAR those sub-objects.",
      inputSchema: {
        id: z.string().describe("The placed object's _id."),
        changes: z.record(z.string(), z.unknown()).describe("Fields to change."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () =>
        json({ updated: await client.patch<Json>("/scene-objects-3d", args.id, args.changes) }),
      );
    }),
  );

  server.registerTool(
    "realm_delete_objects",
    {
      title: "Delete placed 3D objects",
      description: "Delete specific placed objects by id. Requires confirm: true.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Placed object ids to remove."),
        ...confirmArg,
      },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `delete ${args.ids.length} placed object(s)`);
      const client = session.client();
      return withAuthRecovery(async () => {
        for (const id of args.ids) await client.remove("/scene-objects-3d", id);
        return text(`Deleted ${args.ids.length} object(s).`);
      });
    }),
  );

  server.registerTool(
    "realm_clear_scene",
    {
      title: "Remove every object from a 3D scene",
      description:
        "Delete ALL placed objects on a 3D scene. This cannot be undone from here. " +
        "Requires confirm: true — check the object count with `realm_get_scene_objects` first.",
      inputSchema: { sceneId: z.string(), ...confirmArg, ...campaignArg },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `clear every object from scene ${args.sceneId}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        await client.clearSceneObjects3d(args.sceneId, campaignId);
        return text(`Cleared scene ${args.sceneId}.`);
      });
    }),
  );
}
