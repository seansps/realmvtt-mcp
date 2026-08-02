/**
 * Scene markers: camera pins, teleporters, floating text blocks, and journal links.
 *
 * All of them live on the scene LAYER, not in their own services — `layer.pins`,
 * `layer.teleporters`, `layer.textBlocks`, `layer.journals`. So writing one is a
 * read-modify-write of the layer, done by patching the scene (see writeLayer for
 * why not the scene-layers service).
 *
 * The first three carry a frontend-generated `id`. JOURNAL LINKS DO NOT: their
 * `id` is the journal RECORD's id, the same value repeats when a journal is
 * placed twice, and the client addresses them purely by array position. So they
 * are identified here by INDEX, matching the UI, rather than by an id the app
 * would ignore.
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

/**
 * A journal placed on a scene: a GM-only note marker that opens a journal page.
 *
 * `id` is the JOURNAL's id, not the marker's — see the module comment.
 */
export interface JournalLink extends Json {
  id: string;
  name?: string;
  pageNumber?: number;
  position: { x: number; y: number; z?: number };
  alwaysShowName?: boolean;
}

/** The layer arrays this module manages. */
export type MarkerKind = "pins" | "teleporters" | "textBlocks";

/** Read a layer's marker array, tolerating a layer that has none yet. */
export function markersOn(layer: Json | undefined, kind: MarkerKind): Marker[] {
  const raw = layer?.[kind];
  return Array.isArray(raw) ? (raw as Marker[]) : [];
}

/** Read a layer's journal links, tolerating a layer that has none yet. */
export function journalLinksOn(layer: Json | undefined): JournalLink[] {
  const raw = layer?.journals;
  return Array.isArray(raw) ? (raw as JournalLink[]) : [];
}

/** One entry of a journal's page outline, as `realm_journal_pages` returns it. */
export interface PageOutline {
  _id?: string;
  name?: string;
  pageNumber?: number;
}

/** Unwrap the page outline, which arrives either bare or Feathers-paginated. */
export function pageList(result: unknown): PageOutline[] {
  if (Array.isArray(result)) return result as PageOutline[];
  const data = (result as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as PageOutline[]) : [];
}

/**
 * Turn a `page` argument into the 1-based number the scene link stores.
 *
 * The link records a page NUMBER, matched at click time against
 * `journal-pages.pageNumber`. Numbers are renumbered when pages are reordered or
 * deleted, so a caller that knows only "the Rumours page" has no safe number to
 * pass — hence the name lookup, which is the form worth using.
 *
 * Returns null when a name matches nothing, so the caller can list the real page
 * names instead of silently linking page 1.
 */
export function resolvePage(
  pages: PageOutline[],
  page: string | number | undefined,
): { pageNumber: number; pageName?: string } | null {
  if (typeof page === "number") {
    const match = pages.find((p) => p.pageNumber === page);
    return { pageNumber: page, pageName: match?.name };
  }

  if (typeof page === "string" && page.trim() !== "") {
    // A numeric string is a page number the caller typed as text, not a page
    // literally named "3".
    const asNumber = Number(page);
    if (Number.isInteger(asNumber) && asNumber > 0 && !pages.some((p) => p.name === page)) {
      const match = pages.find((p) => p.pageNumber === asNumber);
      return { pageNumber: asNumber, pageName: match?.name };
    }

    const wanted = page.trim().toLowerCase();
    const match =
      pages.find((p) => p.name?.trim().toLowerCase() === wanted) ??
      pages.find((p) => p.name?.trim().toLowerCase().includes(wanted));
    if (!match) return null;
    return { pageNumber: match.pageNumber ?? 1, pageName: match.name };
  }

  // No page asked for: the journal's first page.
  const first = pages.find((p) => p.pageNumber === 1) ?? pages[0];
  return { pageNumber: first?.pageNumber ?? 1, pageName: first?.name };
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
      title: "List a scene's pins, teleporters, text and journal links",
      description:
        "List the markers on a scene: camera PINS (GM location bookmarks), TELEPORTERS (linked " +
        "pads that move tokens), TEXT BLOCKS (floating labels), and JOURNAL LINKS (note markers " +
        "that open a journal page). Also reports which pin the camera opens on.\n\n" +
        "Journal links carry an `index` — their position in the layer's array — which is how " +
        "`realm_update_journal_link` and `realm_delete_marker` address them. Their `id` is the " +
        "journal's id and repeats when the same journal is placed twice, so it identifies " +
        "nothing on its own.",
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
          journals: journalLinksOn(layer).map((j, index) => ({ index, ...j })),
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
    "realm_add_journal_link",
    {
      title: "Place a journal on a scene",
      description:
        "Place a JOURNAL LINK on a scene — a note marker the GM clicks to open a journal at a " +
        "particular page. Players never see them.\n\n" +
        "Pass `page` as a page NAME (recommended) or a 1-based number; the marker's label " +
        "defaults to that page's name, or the journal's name if the page has none. Omit `page` " +
        "and it opens page 1.\n\n" +
        "`z` is the cube elevation, so a link sits on the right floor of a 3D build and hides " +
        "with the cut plane. Omit it on flat 2D maps, which ignore z.\n\n" +
        "Only place these when asked. A map peppered with note markers reads like a diagram " +
        "rather than a place.",
      inputSchema: {
        sceneId: z.string(),
        journalId: z.string().describe("The journal record's id, from `realm_find_journals`."),
        x: z.number().describe("Grid x."),
        y: z.number().describe("Grid y."),
        z: z.number().optional().describe("Elevation in cubes, so the link sits on a floor (3D only)."),
        page: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Page to open: its name (preferred) or 1-based number. Default page 1."),
        name: z
          .string()
          .optional()
          .describe("Marker label. Defaults to the page's name, else the journal's."),
        alwaysShowName: z
          .boolean()
          .optional()
          .describe("Render the label on the map instead of only on hover."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const journal = await client.get<Json>("/journals", args.journalId);
        const pages = pageList(await client.journalPages(args.journalId));
        const resolved = resolvePage(pages, args.page);

        if (!resolved) {
          const names = pages.map((p) => `${p.pageNumber}. ${p.name ?? "(untitled)"}`);
          return text(
            `No page named "${String(args.page)}" in this journal. Its pages are:\n` +
              (names.length ? names.join("\n") : "(none)"),
          );
        }

        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const link: JournalLink = {
          id: args.journalId,
          name: args.name ?? resolved.pageName ?? (journal.name as string | undefined) ?? "Journal",
          pageNumber: resolved.pageNumber,
          position: { x: args.x, y: args.y, ...(args.z !== undefined ? { z: args.z } : {}) },
          ...(args.alwaysShowName ? { alwaysShowName: true } : {}),
        };

        const journals = [...journalLinksOn(layer), link];
        await writeLayer(client, args.sceneId, scene, layerIndex, { journals });
        return json({ added: link, index: journals.length - 1, totalJournalLinks: journals.length });
      });
    }),
  );

  server.registerTool(
    "realm_update_journal_link",
    {
      title: "Edit a journal link on a scene",
      description:
        "Change a placed JOURNAL LINK — its label, the page it opens, where it sits, or whether " +
        "its label always shows. Address it by `index` from `realm_list_markers`; only the " +
        "fields you pass are changed.\n\n" +
        "`page` takes a page name or a 1-based number, resolved against the linked journal.",
      inputSchema: {
        sceneId: z.string(),
        index: z.number().int().describe("The link's position in the layer, from `realm_list_markers`."),
        name: z.string().optional().describe("New label."),
        page: z.union([z.string(), z.number()]).optional().describe("New page: name or 1-based number."),
        x: z.number().optional().describe("New grid x."),
        y: z.number().optional().describe("New grid y."),
        z: z.number().optional().describe("New elevation in cubes (3D only)."),
        alwaysShowName: z.boolean().optional(),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const journals = journalLinksOn(layer);
        const current = journals[args.index];

        if (!current) {
          return text(
            `No journal link at index ${args.index} — this scene has ${journals.length}. ` +
              "Call `realm_list_markers` for the current indices.",
          );
        }

        const patch: Partial<JournalLink> = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.alwaysShowName !== undefined) patch.alwaysShowName = args.alwaysShowName;

        if (args.page !== undefined) {
          const pages = pageList(await client.journalPages(current.id));
          const resolved = resolvePage(pages, args.page);
          if (!resolved) {
            const names = pages.map((p) => `${p.pageNumber}. ${p.name ?? "(untitled)"}`);
            return text(
              `No page named "${String(args.page)}" in the linked journal. Its pages are:\n` +
                (names.length ? names.join("\n") : "(none)"),
            );
          }
          patch.pageNumber = resolved.pageNumber;
        }

        if (args.x !== undefined || args.y !== undefined || args.z !== undefined) {
          // Merge onto the existing position: patching x alone must not drop the z
          // that puts the link on an upper floor.
          const next = {
            x: args.x ?? current.position?.x,
            y: args.y ?? current.position?.y,
            ...(args.z ?? current.position?.z) !== undefined
              ? { z: args.z ?? current.position?.z }
              : {},
          };
          patch.position = next as JournalLink["position"];
        }

        const updated = { ...current, ...patch };
        const next = [...journals];
        next[args.index] = updated;
        await writeLayer(client, args.sceneId, scene, layerIndex, { journals: next });
        return json({ updated, index: args.index });
      });
    }),
  );

  server.registerTool(
    "realm_delete_marker",
    {
      title: "Remove a pin, teleporter, text block or journal link",
      description:
        "Remove a marker from a scene, using the identifiers `realm_list_markers` reports: pins, " +
        "teleporters and text blocks by `id`; journal links by `index`, since they have no id of " +
        "their own. Requires confirm: true.",
      inputSchema: {
        sceneId: z.string(),
        kind: z
          .enum(["pins", "teleporters", "textBlocks", "journals"])
          .describe("Which kind of marker."),
        id: z.string().optional().describe("The marker's id. For pins, teleporters and text blocks."),
        index: z.number().int().optional().describe("The link's array position. For journals."),
        ...confirmArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const what = args.kind === "journals" ? `index ${args.index}` : `id ${args.id}`;
      requireConfirm(args.confirm, `remove ${args.kind} marker ${what}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);

        if (args.kind === "journals") {
          if (args.index === undefined) {
            return text("Journal links are removed by `index` — get it from `realm_list_markers`.");
          }
          const journals = journalLinksOn(layer);
          const doomed = journals[args.index];
          if (!doomed) {
            return text(
              `No journal link at index ${args.index} — this scene has ${journals.length}.`,
            );
          }
          const after = journals.filter((_, i) => i !== args.index);
          await writeLayer(client, args.sceneId, scene, layerIndex, { journals: after });
          return text(
            `Removed journal link ${args.index} (${doomed.name ?? "unnamed"}). ` +
              "Indices after it have shifted down by one.",
          );
        }

        if (!args.id) return text(`Pass the marker's \`id\` to remove a ${args.kind} marker.`);

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
