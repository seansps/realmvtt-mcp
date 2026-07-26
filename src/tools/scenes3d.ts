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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, Query, RealmClient } from "../api/client.js";
import { authStore } from "../auth/store.js";
import { session, withAuthRecovery } from "../context.js";
import {
  cavePathAssetsFrom,
  cavePathStartPort,
  effectiveShape,
  fitCavePath,
  offsetRoute,
} from "../build/cavePath.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/**
 * Objects per create request.
 *
 * `scene-objects-3d` declares `multi: ['create','remove']` precisely so a mass
 * placement is ONE request rather than one per cell, and the server accepts a 50 MB
 * JSON body. A placement is ~200 bytes, so 5,000 of them is under 1 MB — meaning
 * essentially every real scene (a whole town is ~3,300 objects) goes in a single
 * call. This only splits payloads big enough to be worth splitting.
 */
export const CHUNK = 5000;

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

/**
 * The three kinds of scene:
 *   `standard` — a 2D map built on an uploaded image. May have SEVERAL layers.
 *   `canvas`   — 2D, but drawn rather than uploaded: no image, sized in grid squares.
 *   `3d`       — the R3F renderer. Always exactly ONE layer; its contents are
 *                `scene-objects-3d` rows, not layer data.
 */
export type SceneType = "standard" | "canvas" | "3d";

/**
 * What kind of scene this is.
 *
 * There is NO `renderer` field on a scene — the type lives on the active LAYER as
 * `sceneType`. Legacy layers predate that field and fall back to `isCanvasMode`:
 * true means a drawing canvas, absent/false means a standard 2D map.
 *
 * Reading a non-existent `scene.renderer` silently reports every scene as
 * "standard", including 3D ones, which is how a perfectly good 3D scene gets
 * refused by the 3D tools.
 */
export function sceneTypeOf(scene: Json): SceneType {
  const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
  const index = typeof scene.activeLayer === "number" ? scene.activeLayer : 0;
  const layer = layers[index] ?? layers[0];
  if (!layer) return "standard";

  const declared = layer.sceneType;
  if (declared === "3d" || declared === "canvas" || declared === "standard") return declared;
  return layer.isCanvasMode === true ? "canvas" : "standard";
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

export const ROT_NORTH = 0;
export const ROT_EAST = 6;
export const ROT_SOUTH = 12;
export const ROT_WEST = 18;

/**
 * The rot byte whose baked front points along (dx, dy).
 *
 * Props are baked FRONT = −Z, so the mapping is 0→−Y, 6→−X, 12→+Y, 18→+X. The
 * ROT_* names are the wall EDGE a piece hugs, NOT the direction it looks, which is
 * exactly why deriving this by hand inverts so reliably — it's called out in the
 * client as "the recurring 180° footgun". Ported verbatim from roomGen/props.ts so
 * there is one definition, never re-derived.
 */
export function rotFacing(dx: number, dy: number): number {
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? ROT_NORTH : ROT_SOUTH;
  return dx < 0 ? ROT_EAST : ROT_WEST;
}

/** Standard wall through-thickness, in cubes. */
export const WALL_DEPTH = 0.65;
export const WALL_HEIGHT = 2.0;
/** Extra inset into the room past the wall's inner face, so decor isn't buried. */
export const WALL_BACK_INSET = 0.12;
/** Clearance kept between mounted decor's top and the wall's top. */
export const DECOR_TOP_MARGIN = 0.25;

/** The direction a wall edge faces OUTWARD, away from the room it encloses. */
export function exteriorDir(rot: number): { x: number; y: number } {
  switch (((rot % 24) + 24) % 24) {
    case ROT_NORTH:
      return { x: 0, y: 1 };
    case ROT_SOUTH:
      return { x: 0, y: -1 };
    case ROT_EAST:
      return { x: 1, y: 0 };
    default:
      return { x: -1, y: 0 };
  }
}

/**
 * Mount z for wall decor of known height: centred at `heightFrac` up the wall, then
 * clamped so it neither pokes through the wall top nor sinks below its base.
 *
 * Props are BASE-anchored, so this is where the piece STARTS, not where it centres —
 * without the height correction a 1-cube painting mounted at half of a 2-cube wall
 * runs its top into the floor slab above.
 */
export function mountZ(
  wallBaseZ: number,
  wallHeight: number,
  heightFrac: number,
  propHeight = 0,
): number {
  const anchored = wallBaseZ + wallHeight * heightFrac;
  if (propHeight <= 0) return anchored;
  const centered = anchored - propHeight / 2;
  const top = Math.max(wallBaseZ, wallBaseZ + wallHeight - propHeight - DECOR_TOP_MARGIN);
  return Math.min(Math.max(centered, wallBaseZ), top);
}

/**
 * Place WALL-MOUNTED decor — a torch, sconce, painting, banner — flush on a wall's
 * interior face.
 *
 * Two things make this fiddly enough that hand-placement leaves torches floating:
 *
 *  - The wall's inner face is NOT the cell boundary. A wall is inset by its own
 *    depth, so the face sits `0.5 − depth` from the cell centre; mounting at the
 *    cell centre leaves the piece hanging in mid-air, out in the room.
 *  - Wall decor GLBs are baked with their flat BACK on +Z, so the rot byte is the
 *    wall's OWN edge rot — NOT the opposite. Flipping it (the intuitive move) mounts
 *    the piece facing into the wall.
 *
 * Ported from roomGen/wallLightMount.ts so both agree.
 */
export function mountOnWall(
  wall: { x: number; y: number; rot: number },
  opts: {
    wallBaseZ?: number;
    wallHeight?: number;
    wallDepth?: number;
    heightFrac?: number;
    propHeight?: number;
  } = {},
): { pos: { x: number; y: number; z: number }; rot: number; mountCullZ: number } {
  const wallBaseZ = opts.wallBaseZ ?? 0.45;
  const wallHeight = opts.wallHeight ?? WALL_HEIGHT;
  const wallDepth = opts.wallDepth ?? WALL_DEPTH;
  const ext = exteriorDir(wall.rot);
  // Cell centre → outer boundary is +0.5 outward; the inner face is at (0.5 − depth);
  // go a touch further into the room so the back sits flush rather than buried.
  const offset = 0.5 - wallDepth - WALL_BACK_INSET;

  return {
    pos: {
      x: wall.x + ext.x * offset,
      y: wall.y + ext.y * offset,
      z: mountZ(wallBaseZ, wallHeight, opts.heightFrac ?? 0.6, opts.propHeight ?? 0),
    },
    rot: ((wall.rot % 24) + 24) % 24,
    // Decor must inherit its WALL's base for cutaway, or a high-mounted torch
    // vanishes off a wall that's still fully visible.
    mountCullZ: wallBaseZ,
  };
}

/**
 * Place a FLOOR-STANDING prop with its back to a wall — a bookcase, wardrobe,
 * hearth, altar, workbench.
 *
 * These do NOT go on the wall's own cell: that buries them in the masonry, which is
 * what puts a fireplace half inside the wall. They stand on the floor cell NEXT to
 * the wall, nudged back so the gap closes, facing into the room.
 */
export function backedOntoWall(
  wall: { x: number; y: number; rot: number },
  opts: { surfaceZ?: number; wallDepth?: number; propDepth?: number } = {},
): { pos: { x: number; y: number; z: number }; rot: number } {
  const ext = exteriorDir(wall.rot);
  const wallDepth = opts.wallDepth ?? WALL_DEPTH;
  // The wall's inner FACE sits (wallDepth − 0.5) into the room from its cell centre.
  // For the prop's BACK to meet that face, its centre goes half its own depth further
  // in. Placing it at the next cell's centre instead leaves the visible gap.
  const halfProp = (opts.propDepth ?? 0.7) / 2;
  const inward = wallDepth - 0.5 + halfProp;

  return {
    pos: {
      x: wall.x - ext.x * inward,
      y: wall.y - ext.y * inward,
      z: opts.surfaceZ ?? 0.45,
    },
    // Front points away from the wall, into the room — the opposite of the edge rot.
    rot: rotFacing(-ext.x, -ext.y),
  };
}

/**
 * Resolve a placement's rotation, turning a `facing` point into a rot byte.
 *
 * `facing` is a point the prop's FRONT should look at — a chair's table, a statue's
 * doorway. Deriving the delta and the byte here means a caller never has to, which
 * is the difference between chairs facing their table and chairs facing the wall.
 */
export function resolveRot(object: Json): Json {
  // `onWall` / `againstWall` name a wall cell and derive pos + rot + mountCullZ,
  // which is what stops torches floating and hearths sinking into the masonry.
  const wallRef = (object.onWall ?? object.againstWall) as
    | { x?: number; y?: number; rot?: number; heightFrac?: number; propHeight?: number; propDepth?: number }
    | undefined;

  if (wallRef) {
    if (typeof wallRef.x !== "number" || typeof wallRef.y !== "number" || typeof wallRef.rot !== "number") {
      throw new Error(
        "`onWall`/`againstWall` needs the host wall's { x, y, rot } — its cell and the edge it hugs.",
      );
    }
    const wall = { x: wallRef.x, y: wallRef.y, rot: wallRef.rot };
    const pos = object.pos as { z?: number } | undefined;
    const { onWall: _a, againstWall: _b, ...rest } = object;

    if (object.onWall) {
      const mounted = mountOnWall(wall, {
        ...(typeof pos?.z === "number" ? { wallBaseZ: pos.z } : {}),
        ...(wallRef.heightFrac !== undefined ? { heightFrac: wallRef.heightFrac } : {}),
        ...(wallRef.propHeight !== undefined ? { propHeight: wallRef.propHeight } : {}),
      });
      return { ...rest, pos: mounted.pos, rot: mounted.rot, mountCullZ: mounted.mountCullZ };
    }

    const backed = backedOntoWall(wall, {
      ...(typeof pos?.z === "number" ? { surfaceZ: pos.z } : {}),
      ...(wallRef.propDepth !== undefined ? { propDepth: wallRef.propDepth } : {}),
    });
    return { ...rest, pos: backed.pos, rot: backed.rot };
  }

  const facing = object.facing as { x?: number; y?: number } | undefined;
  if (!facing || typeof facing.x !== "number" || typeof facing.y !== "number") {
    const { facing: _drop, ...rest } = object;
    return rest;
  }

  const pos = object.pos as { x?: number; y?: number } | undefined;
  if (typeof pos?.x !== "number" || typeof pos?.y !== "number") {
    throw new Error("An object with `facing` also needs a `pos` to face from.");
  }

  const dx = facing.x - pos.x;
  const dy = facing.y - pos.y;
  if (dx === 0 && dy === 0) {
    throw new Error(
      `An object at (${pos.x}, ${pos.y}) can't face its own position — give \`facing\` a different point.`,
    );
  }

  const { facing: _drop, ...rest } = object;
  return { ...rest, rot: rotFacing(dx, dy) };
}

const placementSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "One placed object: { kind: 'tile'|'prop'|'light', assetId, pos: {x,y,z}, rot: 0-23, " +
      "and optionally scale, pitch, roll, blocksVision, portal, light, roof }. " +
      "Instead of `rot` a PROP may carry `facing: {x, y}` — a point its front should look at — " +
      "and the correct rot byte is worked out for you.",
  );

async function resolveScene(client: RealmClient, sceneId: string, campaignId: string): Promise<Json> {
  const scene = await client.get<Json>("/scenes", sceneId);
  if (scene.campaignId && String(scene.campaignId) !== campaignId) {
    throw new Error(
      `Scene ${sceneId} belongs to a different campaign than the one selected. ` +
        `Pass the right \`campaign\`, or re-run \`realm_use_campaign\`.`,
    );
  }

  const type = sceneTypeOf(scene);
  if (type !== "3d") {
    throw new Error(
      `"${scene.name ?? sceneId}" is a ${type} scene, so 3D objects can't be placed on it. ` +
        `Create one with \`realm_create_scene\` using type: "3d", or pick an existing 3D scene ` +
        `with \`realm_list_scenes\` (only3d: true).`,
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
        "List the campaign's scenes. `type` is `3d` for scenes built with the 3D builder, or " +
        "`standard`/`canvas` for 2D maps — the 3D tools only apply to `3d` scenes.",
      inputSchema: {
        only3d: z.boolean().optional().describe("Only return 3D scenes."),
        search: z.string().optional().describe("Filter by name."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Query = { campaignId };
        if (args.search) query.$search = args.search;
        const scenes = await client.findAll<Json>("/scenes", query);
        const rows = scenes
          .map((s) => ({
            id: s._id,
            name: s.name,
            type: sceneTypeOf(s),
            active: s.active,
            category: s.category,
          }))
          .filter((s) => !args.only3d || s.type === "3d");
        return json({ total: scenes.length, returned: rows.length, scenes: rows });
      });
    }),
  );

  server.registerTool(
    "realm_get_scene",
    {
      title: "Get one scene",
      description:
        "Fetch a scene's settings: its type, grid, units, vision, and layer configuration. " +
        "Use `realm_get_scene_objects` for what's placed ON a 3D scene.",
      inputSchema: { sceneId: z.string(), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const scene = await client.get<Json>("/scenes", args.sceneId);
        const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
        const activeLayer = typeof scene.activeLayer === "number" ? scene.activeLayer : 0;
        const layer = layers[activeLayer] ?? layers[0] ?? {};

        return json({
          id: scene._id,
          name: scene.name,
          type: sceneTypeOf(scene),
          active: scene.active,
          category: scene.category,
          campaignId: scene.campaignId,
          activeLayer,
          layerCount: layers.length,
          grid: {
            unitsPerSquare: layer.unitsPerSquare,
            units: layer.units,
            gridType: layer.gridType,
            gridPadding: layer.gridPadding,
            ...(layer.cubeUnits ? { cubeUnits: layer.cubeUnits } : {}),
          },
          vision: layer.vision ?? false,
          ...(layer.url ? { mapImage: layer.url } : {}),
          ...(layer.canvasDimensions ? { canvasDimensions: layer.canvasDimensions } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_get_room_kit",
    {
      title: "Get a room kit (coherent 3D asset set)",
      description:
        "Resolve a room STYLE into a matched set of 3D assets: a floor, wall families with " +
        "thickness-matched doors and windows, a wall light, a stair, and themed prop pools. " +
        "Call with no `style` to list the available styles.\n\n" +
        "This is a convenient source of assets that belong together — it is NOT a layout. " +
        "You design the room yourself (see `realm_guide` topic `3d-rooms`), and you can freely " +
        "mix kit assets with anything from `realm_search_3d_assets`.",
      inputSchema: {
        style: z.string().optional().describe("Style id. Omit to list the available styles."),
        variant: z.string().optional().describe("Subtype within the style (room type or season)."),
        seed: z.number().optional().describe("Seed varying which assets are picked per slot."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const payload: Json = {};
        if (args.style) payload.style = args.style;
        if (args.variant) payload.variant = args.variant;
        if (args.seed !== undefined) payload.seed = args.seed;

        const kit = await client.roomKit<Json>(payload);

        // Style listing — return it as-is, it's small.
        if (!args.style) return json(kit);

        // A resolved kit carries full catalog docs for every prop slot, which is far
        // more than the caller needs to choose assets.
        const asset = (a: unknown) =>
          a && typeof a === "object" ? compactAsset(a as CatalogRow) : undefined;
        const slots = Array.isArray(kit.propSlots) ? (kit.propSlots as Json[]) : [];

        return json({
          styleId: kit.styleId,
          label: kit.label,
          setting: kit.setting,
          variantId: kit.variantId,
          variants: kit.variants,
          exterior: kit.exterior,
          floor: asset(kit.floor),
          floorOptions: (Array.isArray(kit.floorOptions) ? kit.floorOptions : []).map(asset),
          wallOptions: (Array.isArray(kit.wallOptions) ? kit.wallOptions : []).map((w) => {
            const opt = w as Json;
            return {
              base: opt.base,
              wall: asset(opt.wall),
              door: asset(opt.door),
              window: asset(opt.window),
            };
          }),
          wallLight: kit.wallLight
            ? {
                asset: asset((kit.wallLight as Json).asset),
                spacingCells: (kit.wallLight as Json).spacingCells,
              }
            : null,
          stair: asset(kit.stair),
          propSlots: slots.map((s) => ({
            slot: s.slot,
            arrange: s.arrange,
            countPer25Cells: s.countPer25Cells,
            assets: (Array.isArray(s.assets) ? s.assets : []).map((a) =>
              (a as CatalogRow)?.assetId,
            ),
          })),
        });
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
    "realm_upload_3d_model",
    {
      title: "Upload a custom 3D model as a placeable asset",
      description:
        "Upload your own GLB and register it as a placeable asset, returning an `assetId` that " +
        "`realm_place_objects` accepts exactly like a catalog one. Use this for bespoke scenery " +
        "the shared catalog doesn't have.\n\n" +
        "The asset is OWNER-SCOPED — yours to place, and it still renders for others in a scene " +
        "you share. Storage quota and asset tracking are handled by the server as part of the " +
        "upload.\n\n" +
        "SCALE MATTERS: 1 GLB unit should be 1 grid cube (5 ft). If the model was authored in " +
        "METRES, pass baseScale 0.66 (= 1/1.524); a millimetre export needs ~0.00066. Get this " +
        "wrong and the model arrives microscopic or enormous. `realm_guide` topic `3d-assets` " +
        "covers the scale, orientation and pivot conventions — models should face −Z with their " +
        "base at y=0.",
      inputSchema: {
        path: z.string().describe("Absolute path to the .glb file on this machine."),
        name: z.string().describe("Display name for the asset."),
        role: z
          .enum(["prop", "wall", "door", "window"])
          .optional()
          .describe(
            "What it behaves as. `prop` (default) is free-placed decor; `wall`/`door`/`window` " +
              "get the same edge-snapping and portal behaviour as built-in structure pieces.",
          ),
        placementType: z
          .enum(["free", "wall"])
          .optional()
          .describe("`wall` makes it wall-mounted decor that snaps to a wall face. Default `free`."),
        baseScale: z
          .number()
          .optional()
          .describe("Natural size multiplier. 1 = authored in grid cubes; 0.66 = authored in metres."),
        modelRotation: z
          .object({ x: z.number(), y: z.number(), z: z.number() })
          .optional()
          .describe("Baked orientation correction in DEGREES, for a model authored facing wrong."),
        hingeSide: z.enum(["left", "right"]).optional().describe("Door leaf pivot edge."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      if (!/\.glb$/i.test(args.path)) {
        return text("Only .glb files can be uploaded as 3D models. Export your model to GLB first.");
      }

      const data = await readFile(args.path);
      return withAuthRecovery(async () => {
        // X-Asset-Kind routes the file to the public `3d/user/` prefix, so a scene
        // using it renders for other people without a rehydrate step.
        const stored = await client.upload(basename(args.path), new Uint8Array(data), "model-3d");
        const modelPath = stored.replace(/^\//, "");

        const asset = await client.create<Json>("/custom-assets-3d", {
          name: args.name,
          kind: "prop", // the stored kind is always prop; `role` drives behaviour
          role: args.role ?? "prop",
          placementType: args.placementType ?? "free",
          modelPath,
          ...(args.baseScale !== undefined ? { baseScale: args.baseScale } : {}),
          ...(args.modelRotation ? { modelRotation: args.modelRotation } : {}),
          ...(args.hingeSide ? { hingeSide: args.hingeSide } : {}),
        });

        return json({
          assetId: asset.assetId,
          name: asset.name,
          modelPath,
          sizeBytes: data.length,
          usage:
            `Place it with realm_place_objects using assetId "${asset.assetId}" — same as any ` +
            `catalog asset. Check the scale in-app; adjust by re-uploading with a different ` +
            `baseScale, or per-placement with \`scale\`.`,
        });
      });
    }),
  );

  server.registerTool(
    "realm_list_3d_models",
    {
      title: "List your custom 3D models",
      description:
        "List the custom 3D assets you've uploaded, with the assetIds `realm_place_objects` " +
        "accepts. These are separate from the shared catalog that `realm_search_3d_assets` covers.",
      inputSchema: { search: z.string().optional().describe("Filter by name.") },
    },
    safe(async (args) => {
      const client = session.client();
      const me = authStore.read()?.user?._id;
      return withAuthRecovery(async () => {
        const rows = await client.findAll<Json>(
          "/custom-assets-3d",
          me ? { ownerId: me } : {},
        );
        const needle = args.search?.toLowerCase();
        const models = rows
          .filter((r) => !needle || String(r.name ?? "").toLowerCase().includes(needle))
          .map((r) => ({
            assetId: r.assetId,
            name: r.name,
            role: r.role,
            placementType: r.placementType,
            baseScale: r.baseScale,
          }));
        return json({ total: models.length, models });
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
        "PASS EVERY OBJECT IN ONE CALL. This endpoint is built for mass placement — an entire " +
        "building or town goes in a single request. Do NOT loop, calling it once per wall, per " +
        "room or per floor; batch the whole build into one `objects` array.\n\n" +
        "GEOMETRY RULES (violating these produces a scene that looks wrong in the renderer):\n" +
        "• A floor slab is 0.45 thick; a tile at pos.z has its walking surface at z+0.45.\n" +
        "• Ground story: floor z=0, walls z=0.45. Walls sit ON TOP of the slab or the floor pokes " +
        "up through doorways.\n" +
        "• Walls are one piece per cell EDGE. Edge rot: 0=north(+y), 6=east(+x), 12=south(-y), 18=west(-x).\n" +
        "• FACING: rather than computing `rot` for a prop, give it `facing: {x, y}` — the point " +
        "its front should look at — and the right byte is derived for you. A chair gets the " +
        "table's position, a statue the doorway it watches. Deriving facing by hand inverts " +
        "constantly (chairs end up facing the wall), so prefer `facing` for anything that looks " +
        "at something.\n" +
        "  If you do set `rot` yourself: props are baked front=-Z, so 0→-y, 6→-x, 12→+y, 18→+x, " +
        "and a prop against the north wall faces the room at rot 0.\n" +
        "• An integer prop pos is the CELL CENTRE. Props are base-anchored, so rest one on a " +
        "surface by setting pos.z to that surface's z.\n" +
        "• A light-emitting prop must carry the catalog asset's `light` blob on the PLACEMENT — " +
        "the renderer reads the placed object's light, not the asset's.\n" +
        "• ANYTHING THAT TOUCHES A WALL should name the wall instead of being positioned by hand:\n" +
        "  - `onWall: {x, y, rot, heightFrac?}` for MOUNTED decor (torch, sconce, painting, " +
        "banner). A wall's inner face is inset by its own depth, so mounting at the cell centre " +
        "leaves the piece floating out in the room; this also sets `mountCullZ` so it cuts away " +
        "with its wall.\n" +
        "  - `againstWall: {x, y, rot}` for FLOOR-STANDING back-to-wall furniture (bookcase, " +
        "wardrobe, hearth, altar, workbench). These go on the floor cell NEXT to the wall, not on " +
        "the wall's own cell — putting them on the wall cell sinks them into the masonry.\n" +
        "  Both take the host wall's cell and edge rot, and derive position and facing.\n" +
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
          ...resolveRot(o as Json),
        }));

        let created = 0;
        let requests = 0;
        for (let i = 0; i < objects.length; i += CHUNK) {
          const batch = objects.slice(i, i + CHUNK);
          const res = await client.createSceneObjects3d<Json[]>(batch);
          created += Array.isArray(res) ? res.length : batch.length;
          requests += 1;
        }
        return text(
          `Placed ${created} object${created === 1 ? "" : "s"} on scene ${args.sceneId} ` +
            `in ${requests} request${requests === 1 ? "" : "s"}.`,
        );
      });
    }),
  );

  server.registerTool(
    "realm_build_cave_path",
    {
      title: "Chain cave wall pieces along a route",
      description:
        "Turn a drawn ROUTE into a correctly-connected run of cave wall pieces, then optionally " +
        "place them. This is the same chainer the in-app Cave Draw tool uses.\n\n" +
        "USE THIS FOR CAVES — do not place cave walls by hand. A cave wall family is a 9-piece " +
        "connecting set (straight, waves, rounded corner, diagonal, and FOUR 45° bends), and each " +
        "piece only joins where its port lands exactly. Placing straight pieces on cell edges " +
        "instead gives you a blocky, stair-stepped cave rather than a winding one.\n\n" +
        "You design the route — where the passage goes, how it winds, where it opens into " +
        "chambers. Include DIAGONAL steps: a route that only moves along x and y can only " +
        "produce axis-aligned walls. The route is the passage's WALL LINE, so trace one side of " +
        "the passage, not its centre.\n\n" +
        "Ordinary room/dungeon wall families have no bends and are rejected — use plain " +
        "per-edge walls for those (see `realm_guide` topic `3d-rooms`).",
      inputSchema: {
        sceneId: z.string(),
        family: z
          .string()
          .describe(
            "The cave wall family id (from `realm_search_3d_assets` — every piece of a set " +
              "shares one `family`).",
          ),
        route: z
          .array(z.object({ x: z.number().int(), y: z.number().int() }))
          .min(2)
          .describe(
            "Cells the run follows, in order. Gaps are filled 8-way, so waypoints at the corners " +
              "of a winding passage are enough. By default this is the WALL line; with `width` " +
              "it's the passage CENTRELINE instead.",
          ),
        width: z
          .number()
          .min(2)
          .max(20)
          .optional()
          .describe(
            "Treat `route` as the passage CENTRELINE and build BOTH walls this many cells apart. " +
              "Strongly preferred — it keeps the two walls a constant distance apart and saves " +
              "tracing two polylines that drift together. Use 3+ for a walkable passage, 8–15 " +
              "for a chamber. Note the inside wall cuts corners slightly, so a passage pinches " +
              "by up to ~1 cell on a turn — ask for one more than your true minimum.",
          ),
        z: z.number().optional().describe("Elevation for the run. Default 0.45 (ground story)."),
        startEdge: z
          .enum(["north", "east", "south", "west"])
          .optional()
          .describe("Which cell edge the run starts on. Default `south`."),
        waveEvery: z
          .number()
          .int()
          .optional()
          .describe("Insert a wave piece every N straight pieces so runs aren't ruler-straight. Default 3, 0 disables."),
        apply: z.boolean().optional().describe("Place the pieces. Without this it only previews."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);

        const family = await client.assets3d<CatalogRow>({ family: args.family });
        if (family.length === 0) {
          return text(
            `No assets in family "${args.family}". Find a cave family with ` +
              `\`realm_search_3d_assets\` (role: "wall") — every piece of a set shares one \`family\`.`,
          );
        }

        const pieces = family.map((a) => ({
          id: a.assetId,
          ...(a.shape ? { shape: a.shape } : {}),
          ...(a.depth !== undefined ? { depth: a.depth } : {}),
        }));
        const set = cavePathAssetsFrom(pieces);
        if (!set) {
          return text(
            `"${args.family}" has no 45° bend pieces, so it's an ordinary wall family rather ` +
              `than a cave set. Build with it using plain per-edge walls instead — one piece per ` +
              `cell edge, rot 0=N/6=E/12=S/18=W. Cave families ship straight + waves + rounded ` +
              `corner + diagonal + four bends.`,
          );
        }

        const edges = { north: 0, east: 6, south: 12, west: 18 };
        const depth = pieces.find((p) => p.depth !== undefined)?.depth ?? 0.65;
        const waveEvery = args.waveEvery ?? 3;

        // With a width, `route` is the passage centreline and BOTH walls are built
        // from it — which is the only way to guarantee the passage stays that wide.
        const wallRoutes = args.width
          ? [offsetRoute(args.route, args.width, 1), offsetRoute(args.route, args.width, -1)]
          : [args.route];

        const chained = wallRoutes.flatMap((wallRoute) => {
          const first = wallRoute[0]!;
          const start = cavePathStartPort(first, edges[args.startEdge ?? "south"], 1, depth);
          return fitCavePath(wallRoute, set, start, waveEvery);
        });

        if (chained.length === 0) {
          return text(
            "Couldn't chain any pieces from that route. Check the route starts where you expect " +
              "and moves cell-by-cell; try a different `startEdge`.",
          );
        }

        // How close each wall got to its final waypoint. A run that stops well short
        // means the fitter ran out of connecting pieces, and the wall has an open
        // end — the usual cause of a cave that looks like it doesn't join up.
        const shortfalls = wallRoutes.map((wallRoute, i) => {
          const target = wallRoute[wallRoute.length - 1]!;
          const runs = args.width
            ? chained.filter((_, idx) =>
                i === 0 ? idx < chained.length / 2 : idx >= chained.length / 2,
              )
            : chained;
          const last = runs[runs.length - 1];
          if (!last) return Infinity;
          return Math.hypot(last.cell.x - target.x, last.cell.y - target.y);
        });
        const worstShortfall = Math.max(...shortfalls);

        const zPos = args.z ?? 0.45;
        const objects = chained.map((p) => ({
          campaignId,
          sceneId: args.sceneId,
          layerIndex: 0,
          kind: "tile" as const,
          assetId: p.assetId,
          pos: { x: p.cell.x, y: p.cell.y, z: zPos },
          rot: p.rot,
          blocksVision: true,
        }));

        // Which piece types actually got used — the quickest way to see whether a
        // route produced curves or just straights.
        const byShape: Record<string, number> = {};
        for (const p of chained) {
          const shape = effectiveShape({ id: p.assetId }) ?? "straight";
          byShape[shape] = (byShape[shape] ?? 0) + 1;
        }

        const warnings: string[] = [];
        if (worstShortfall > 2) {
          warnings.push(
            `A wall run stopped ~${Math.round(worstShortfall)} cells short of its last waypoint, ` +
              `so it has an open end. That usually means the route turns too sharply for the ` +
              `piece set — try gentler waypoints, or split the sharp corner into two 45° steps.`,
          );
        }
        const straightOnly = Object.keys(byShape).every((s) => s === "straight");
        if (straightOnly) {
          warnings.push(
            "Every piece came out straight, so this will look stair-stepped. The route has no " +
              "diagonals or turns — add waypoints that move diagonally.",
          );
        }
        if (!args.width) {
          warnings.push(
            "Built as a single WALL line. For a passage, pass `width` with the CENTRELINE " +
              "instead and both walls are built at a guaranteed constant separation — separate " +
              "calls per wall are what leaves runs that don't meet up.",
          );
        }

        if (!args.apply) {
          return json({
            preview: true,
            pieces: chained.length,
            walls: wallRoutes.length,
            byShape,
            sample: objects.slice(0, 5),
            ...(warnings.length ? { warnings } : {}),
            next: "Re-run with apply: true to place these.",
          });
        }

        await resolveScene(client, args.sceneId, campaignId);
        for (let i = 0; i < objects.length; i += CHUNK) {
          await client.createSceneObjects3d(objects.slice(i, i + CHUNK));
        }
        return json({
          placed: objects.length,
          walls: wallRoutes.length,
          byShape,
          ...(warnings.length ? { warnings } : {}),
        });
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
