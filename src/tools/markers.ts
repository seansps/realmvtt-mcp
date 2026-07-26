/**
 * Scene markers: camera pins, teleporters, and floating text blocks.
 *
 * All three live on the scene LAYER, not in their own services — `layer.pins`,
 * `layer.teleporters`, `layer.textBlocks`, each an array of objects with a
 * frontend-generated `id`. So writing one is a read-modify-write of the layer,
 * done by patching the scene (see writeLayer for why not the scene-layers service).
 *
 * PINS matter more than they look. A newly built scene opens the camera at its
 * default framing, which for a scene built out at, say, (40, 25) means the GM
 * arrives looking at empty ground with no idea where the map went. The pin named
 * by `layer.defaultPinId` is where the camera frames on entry, so a scene built
 * anywhere other than the origin wants one.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

export interface Marker extends Json {
  id: string;
  name?: string;
  position: { x: number; y: number; z?: number };
}

/** The layer arrays this module manages. */
export type MarkerKind = "pins" | "teleporters" | "textBlocks";

/** Read a layer's marker array, tolerating a layer that has none yet. */
export function markersOn(layer: Json | undefined, kind: MarkerKind): Marker[] {
  const raw = layer?.[kind];
  return Array.isArray(raw) ? (raw as Marker[]) : [];
}

/**
 * The centre of a set of placed objects — where a "Main Location" pin belongs.
 *
 * Uses the mid-point of the bounding box rather than the mean, so a scene with a
 * dense cluster at one end still frames the whole build instead of being dragged
 * toward the crowded part.
 */
export function centerOfObjects(
  objects: Array<{ pos?: { x?: number; y?: number; z?: number } }>,
): { x: number; y: number; z: number } | null {
  const points = objects
    .map((o) => o.pos)
    .filter((p): p is { x: number; y: number; z?: number } =>
      typeof p?.x === "number" && typeof p?.y === "number",
    );
  if (points.length === 0) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const zs = points.map((p) => p.z ?? 0);
  return {
    x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2),
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
    // Frame the LOWEST level: a pin on the ground floor reads the whole building,
    // where one at mid-height sits inside a wall.
    z: Math.min(...zs),
  };
}

/** Fetch a scene and its active layer. */
async function getLayer(
  client: RealmClient,
  sceneId: string,
): Promise<{ scene: Json; layer: Json; layerIndex: number }> {
  const scene = await client.get<Json>("/scenes", sceneId);
  const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
  const layerIndex = typeof scene.activeLayer === "number" ? scene.activeLayer : 0;
  const layer = layers[layerIndex] ?? layers[0] ?? {};
  return { scene, layer, layerIndex };
}

/**
 * Merge a partial layer back onto a scene.
 *
 * Goes through `PATCH /scenes/:id` rather than the `scene-layers` service. That
 * service's `update` is declared `(data, params)` — Feathers' id argument lands in
 * `data` — so the app calls it with a null id, which over REST means a PUT with no
 * id segment. That route doesn't exist: it answers `404 Path /scene-layers not
 * found`, which is exactly what surfaced as "the pin was created but the call
 * failed" (the pin was NOT created; the readback found an earlier one).
 *
 * `layers` is part of the scene's patch schema, so writing the array back is a
 * supported, plainly-routed operation. It is a whole-array write, so the caller
 * passes the scene it already read and we merge into that — keeping the
 * read-modify-write window as short as possible.
 */
async function writeLayer(
  client: RealmClient,
  sceneId: string,
  scene: Json,
  layerIndex: number,
  patch: Json,
): Promise<void> {
  const layers = Array.isArray(scene.layers) ? [...(scene.layers as Json[])] : [];
  layers[layerIndex] = { ...(layers[layerIndex] ?? {}), ...patch };
  await client.patch("/scenes", sceneId, { layers });
}

export function registerMarkerTools(server: McpServer): void {
  server.registerTool(
    "realm_list_markers",
    {
      title: "List a scene's pins, teleporters and text",
      description:
        "List the markers on a scene: camera PINS (GM location bookmarks), TELEPORTERS (linked " +
        "pads that move tokens), and TEXT BLOCKS (floating labels). Also reports which pin the " +
        "camera opens on.",
      inputSchema: { sceneId: z.string(), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { layer } = await getLayer(client, args.sceneId);
        return json({
          sceneId: args.sceneId,
          defaultPinId: layer.defaultPinId ?? null,
          pins: markersOn(layer, "pins"),
          teleporters: markersOn(layer, "teleporters"),
          textBlocks: markersOn(layer, "textBlocks"),
        });
      });
    }),
  );

  server.registerTool(
    "realm_add_pin",
    {
      title: "Add a camera pin to a scene",
      description:
        "Add a camera PIN — a GM-only location bookmark the camera can jump to. Players never " +
        "see pins.\n\n" +
        "ADD ONE TO EVERY NEW 3D SCENE YOU BUILD. A scene opens at its default framing, so a map " +
        "built away from the origin leaves the GM staring at empty ground, unsure where it went. " +
        "Set `makeDefault: true` on a pin at the middle of what you built (call it something like " +
        "'Main Location') and the camera opens there instead.\n\n" +
        "Pass `center: true` to put the pin at the centre of everything already placed on the " +
        "scene, which is usually exactly what you want after a build.\n\n" +
        "Beyond that, only add pins when asked — a scene peppered with unrequested bookmarks is " +
        "clutter.",
      inputSchema: {
        sceneId: z.string(),
        name: z.string().describe("Pin name, e.g. `Main Location`, `Entrance`, `Boss Chamber`."),
        x: z.number().optional().describe("Grid x. Omit with `center: true`."),
        y: z.number().optional().describe("Grid y. Omit with `center: true`."),
        z: z.number().optional().describe("Elevation in cubes, so the pin sits on a floor."),
        center: z
          .boolean()
          .optional()
          .describe("Place it at the centre of everything already on the scene."),
        makeDefault: z
          .boolean()
          .optional()
          .describe("Open the camera here when someone enters the scene."),
        alwaysShow: z
          .boolean()
          .optional()
          .describe("Keep the marker visible to the GM even when the pin tool is off."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);

        let x = args.x;
        let y = args.y;
        let z = args.z;

        if (args.center) {
          const objects = await client.sceneObjects3d<{ pos?: { x: number; y: number; z: number } }>(
            args.sceneId,
            campaignId,
          );
          const centre = centerOfObjects(objects);
          if (!centre) {
            return text(
              "Nothing is placed on this scene yet, so there's no centre to pin. " +
                "Build the scene first, or pass explicit x/y.",
            );
          }
          x = centre.x;
          y = centre.y;
          z = z ?? centre.z;
        }

        if (x === undefined || y === undefined) {
          return text("Pass `x` and `y`, or `center: true` to pin the middle of the build.");
        }

        const pin: Marker = {
          id: randomUUID(),
          name: args.name,
          position: { x, y, ...(z !== undefined ? { z } : {}) },
          ...(args.alwaysShow ? { alwaysShow: true } : {}),
        };

        const pins = [...markersOn(layer, "pins"), pin];
        const patch: Json = { pins };
        if (args.makeDefault) patch.defaultPinId = pin.id;

        await writeLayer(client, args.sceneId, scene, layerIndex, patch);
        return json({
          added: pin,
          isDefault: Boolean(args.makeDefault),
          totalPins: pins.length,
        });
      });
    }),
  );

  server.registerTool(
    "realm_add_teleporter",
    {
      title: "Add a teleporter to a scene",
      description:
        "Add a TELEPORTER — a pad that moves a token elsewhere when stepped on. Teleporters work " +
        "in pairs: create both, then link one to the other with `linkTo` (the destination " +
        "teleporter's id), which you can find with `realm_list_markers`. A teleporter with no " +
        "destination does nothing.\n\n" +
        "Only add these when asked. They change how a map plays, so they aren't something to " +
        "include in a build unprompted.",
      inputSchema: {
        sceneId: z.string(),
        name: z.string().describe("Teleporter name."),
        x: z.number(),
        y: z.number(),
        z: z.number().optional().describe("Elevation in cubes."),
        linkTo: z.string().optional().describe("Destination teleporter's id."),
        linkToLayer: z.number().int().optional().describe("Destination's layer index. Default same layer."),
        disabled: z.boolean().optional(),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);

        const teleporter: Marker = {
          id: randomUUID(),
          name: args.name,
          position: { x: args.x, y: args.y, ...(args.z !== undefined ? { z: args.z } : {}) },
          ...(args.linkTo
            ? {
                destination: {
                  layerIndex: args.linkToLayer ?? layerIndex,
                  teleporterId: args.linkTo,
                },
              }
            : {}),
          ...(args.disabled ? { disabled: true } : {}),
        };

        const teleporters = [...markersOn(layer, "teleporters"), teleporter];
        await writeLayer(client, args.sceneId, scene, layerIndex, { teleporters });
        return json({
          added: teleporter,
          ...(args.linkTo ? {} : { note: "No destination set — link it to another teleporter's id to make it work." }),
        });
      });
    }),
  );

  server.registerTool(
    "realm_add_text",
    {
      title: "Add a floating text label to a scene",
      description:
        "Add a TEXT BLOCK — a label floating on the map (a room name, a warning, a signpost). " +
        "Max 256 characters.\n\n" +
        "Only add text when explicitly asked. A built scene should read through its geometry and " +
        "props, not through labels stuck over it; unrequested captions make a map look like a " +
        "diagram.",
      inputSchema: {
        sceneId: z.string(),
        text: z.string().max(256).describe("The label. 256 characters max."),
        x: z.number(),
        y: z.number(),
        z: z.number().optional().describe("Elevation in cubes, so it sits on a floor."),
        color: z.string().optional().describe("Hex colour. Default white."),
        fontSize: z.number().optional().describe("Base font size in px. Default 24."),
        gmOnly: z.boolean().optional().describe("Only the GM can see it."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);

        const block: Json = {
          id: randomUUID(),
          text: args.text,
          position: { x: args.x, y: args.y, ...(args.z !== undefined ? { z: args.z } : {}) },
          color: args.color ?? "#ffffff",
          ...(args.fontSize !== undefined ? { fontSize: args.fontSize } : {}),
          ...(args.gmOnly ? { gmOnly: true } : {}),
        };

        const textBlocks = [...markersOn(layer, "textBlocks"), block as Marker];
        await writeLayer(client, args.sceneId, scene, layerIndex, { textBlocks });
        return json({ added: block });
      });
    }),
  );

  server.registerTool(
    "realm_delete_marker",
    {
      title: "Remove a pin, teleporter or text block",
      description:
        "Remove a marker from a scene by its id (from `realm_list_markers`). Requires confirm: true.",
      inputSchema: {
        sceneId: z.string(),
        kind: z.enum(["pins", "teleporters", "textBlocks"]).describe("Which kind of marker."),
        id: z.string().describe("The marker's id."),
        ...confirmArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `remove ${args.kind} marker ${args.id}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const before = markersOn(layer, args.kind);
        const after = before.filter((m) => m.id !== args.id);

        if (after.length === before.length) {
          return text(`No ${args.kind} marker with id ${args.id} on this scene.`);
        }

        const patch: Json = { [args.kind]: after };
        // A dangling defaultPinId leaves the camera with nowhere to open.
        if (args.kind === "pins" && layer.defaultPinId === args.id) patch.defaultPinId = null;

        await writeLayer(client, args.sceneId, scene, layerIndex, patch);
        return text(`Removed ${args.kind} marker ${args.id}.`);
      });
    }),
  );
}
