/**
 * Uploading images, and the four things people actually do with them: keep them in
 * the campaign's image library, turn one into a 2D scene, embed one in a journal
 * page, and set one as a portrait or token.
 *
 * ── Asset accounting ──────────────────────────────────────────────────────────
 * Every upload goes through `POST /upload`, and the BACKEND does the tracking as
 * part of that request: it checks the account's storage quota and per-file limit
 * BEFORE accepting the file, then increments the user's usage and creates the
 * `user-assets` record. So an upload made here is accounted for exactly like one
 * made in the app — there is no second call to make, and no way to skip it by
 * uploading differently. That is also why nothing in this module deletes assets:
 * freeing storage correctly means removing the file from the CDN first, which only
 * the backend's own `deleteFileAsset` does.
 */
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, json, safe, text } from "./registry.js";

/** Where uploaded assets are served from. Stored paths are relative to this. */
export const ASSET_CDN = "https://assets.realmvtt.com";

export function cdnUrl(storedPath: string): string {
  const path = storedPath.startsWith("/") ? storedPath : `/${storedPath}`;
  return `${ASSET_CDN}${path}`;
}

/**
 * The `<img>` markup a journal page uses, matching what the Fantasy Grounds
 * importer produces. `id` carries the image RECORD id so the app can trace the
 * embed back to the library entry; `data-display`/`data-float` drive layout.
 */
export function journalImgTag(
  url: string,
  opts: { alt?: string; float?: "left" | "right" | "block"; imageId?: string } = {},
): string {
  const alt = (opts.alt ?? "").replace(/"/g, "&quot;");
  const idAttr = opts.imageId ? ` id="${opts.imageId}"` : "";
  const floated = opts.float === "left" || opts.float === "right";
  const width = floated ? 300 : 800;
  const display = floated ? "inline" : "block";
  const float = floated ? opts.float : "left";
  return (
    `<img height="auto" src="${url}" alt="${alt}" width="${width}" ` +
    `style="aspect-ratio: auto"${idAttr} data-display="${display}" data-float="${float}">`
  );
}

/** Upload a local file and register it in the campaign's image library. */
async function uploadAndRegister(
  client: RealmClient,
  campaignId: string,
  filePath: string,
  opts: { name?: string; category?: string; shared?: boolean },
): Promise<{ path: string; record: Json }> {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(process.cwd(), filePath);
  const data = await readFile(abs);
  const fileName = basename(abs);

  const stored = (await client.upload(fileName, new Uint8Array(data))).trim();
  const name = opts.name ?? basename(fileName, extname(fileName)).replace(/[_-]+/g, " ");

  // Mirrors the app's "Create new Image": identified with a placeholder
  // unidentified name, so a GM can hide it from players by un-identifying it.
  const record = await client.create<Json>("/images", {
    name,
    unidentifiedName: "Unidentified Image",
    identified: true,
    locked: true,
    url: stored,
    campaignId,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.shared ? { shared: true } : {}),
  });

  return { path: stored, record };
}

/** Resolve an existing image by record id or stored path, for tools that accept either. */
async function resolveExistingImage(
  client: RealmClient,
  campaignId: string,
  ref: string,
): Promise<{ path: string; record?: Json }> {
  if (/^[a-f0-9]{24}$/i.test(ref)) {
    const record = await client.get<Json>("/images", ref);
    return { path: String(record.url), record };
  }
  // Already a stored path.
  if (ref.includes("/")) return { path: ref };

  const found = await client.find<Json>("/images", { campaignId, $search: ref, $limit: 1 });
  const record = found.data[0];
  if (!record) {
    throw new Error(
      `No image matching "${ref}" in this campaign. Upload one, or find it with \`realm_find_image\`.`,
    );
  }
  return { path: String(record.url), record };
}

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "realm_upload_image",
    {
      title: "Upload an image into the campaign",
      description:
        "Upload a local image file and add it to the campaign's image library, exactly as the " +
        "app's 'Create new Image' does. Storage quota and asset tracking are handled by the " +
        "server as part of the upload.\n\n" +
        "Returns the stored path, the image record id, the CDN url, and ready-to-paste journal " +
        "`<img>` HTML — so the result can be used directly as a portrait, a token, a scene " +
        "background, or inside a journal page.",
      inputSchema: {
        path: z.string().describe("Absolute path to the image file on this machine."),
        name: z.string().optional().describe("Name for the image record (defaults to the filename)."),
        category: z.string().optional().describe("Grouping category in the image library."),
        shared: z.boolean().optional().describe("Make it visible to players immediately."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const { path, record } = await uploadAndRegister(client, campaignId, args.path, args);
        const url = cdnUrl(path);
        return json({
          storedPath: path,
          imageId: record._id,
          name: record.name,
          cdnUrl: url,
          journalHtml: journalImgTag(url, {
            alt: String(record.name ?? ""),
            imageId: String(record._id),
          }),
        });
      });
    }),
  );

  server.registerTool(
    "realm_find_image",
    {
      title: "Find a campaign image",
      description: "Search the campaign's image library by name.",
      inputSchema: { search: z.string().describe("Name to search for."), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const res = await client.find<Json>("/images", {
          campaignId,
          $search: args.search,
          $limit: 25,
        });
        return json({
          total: res.total,
          images: res.data.map((i) => ({
            id: i._id,
            name: i.name,
            storedPath: i.url,
            cdnUrl: cdnUrl(String(i.url)),
            category: i.category,
            shared: i.shared,
          })),
        });
      });
    }),
  );

  server.registerTool(
    "realm_create_scene",
    {
      title: "Create a scene",
      description:
        "Create a scene in the campaign.\n\n" +
        "• With `imagePath` (a local file) or `image` (an existing image id/path) you get a " +
        "standard 2D map scene using that image as its background — the same thing the app's " +
        "'Create new Scene' produces from an upload.\n" +
        "• With `type: 'canvas'` you get a blank drawing canvas sized in grid squares.\n" +
        "• With `type: '3d'` you get an empty 3D scene, ready for `realm_place_objects`.\n\n" +
        "Grid defaults to 5 ft squares; override with `unitsPerSquare` and `units`.",
      inputSchema: {
        name: z.string().describe("Scene name."),
        imagePath: z.string().optional().describe("Local image file to upload and use as the map."),
        image: z
          .string()
          .optional()
          .describe("An existing image: record id, stored path, or name to search for."),
        type: z
          .enum(["standard", "canvas", "3d"])
          .optional()
          .describe("Scene type. Defaults to `standard` when an image is given."),
        unitsPerSquare: z.number().optional().describe("Game units per grid square (default 5)."),
        units: z.string().optional().describe("Unit name (default `ft`)."),
        gridType: z.enum(["square", "hex"]).optional().describe("Grid type (default square)."),
        vision: z.boolean().optional().describe("Enable line of sight on the scene."),
        width: z.number().optional().describe("Canvas width in grid squares (canvas scenes)."),
        height: z.number().optional().describe("Canvas height in grid squares (canvas scenes)."),
        canvasColor: z.string().optional().describe("Canvas background colour, e.g. `#f5f5dc`."),
        category: z.string().optional().describe("Grouping category."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      const unitsPerSquare = args.unitsPerSquare ?? 5;
      const units = args.units ?? "ft";
      const type = args.type ?? (args.imagePath || args.image ? "standard" : "canvas");

      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);

        let layer: Json;
        let uploaded: { path: string; record: Json } | undefined;

        if (type === "3d") {
          // A 3D layer carries no background image; its contents live in
          // scene-objects-3d. cubeUnits.size is world units per cube edge.
          layer = {
            sceneType: "3d",
            cubeUnits: { size: 5 },
            unitsPerSquare,
            units,
            gridType: "square",
            vision: args.vision ?? true,
            uvtt: {
              line_of_sight: [],
              objects_line_of_sight: [],
              portals: [],
              environment: { baked_lighting: false, ambient_light: "#ffffff" },
              lights: [],
            },
          };
        } else if (type === "canvas") {
          layer = {
            isCanvasMode: true,
            canvasDimensions: { width: args.width ?? 30, height: args.height ?? 30 },
            ...(args.canvasColor ? { canvasColor: args.canvasColor } : {}),
            unitsPerSquare,
            units,
            gridType: args.gridType ?? "square",
            vision: args.vision ?? true,
          };
        } else {
          if (!args.imagePath && !args.image) {
            return text("A standard scene needs a map image — pass `imagePath` or `image`.");
          }
          const resolved = args.imagePath
            ? (uploaded = await uploadAndRegister(client, campaignId, args.imagePath, {
                name: args.name,
                ...(args.category ? { category: args.category } : {}),
              }))
            : await resolveExistingImage(client, campaignId, args.image!);

          layer = {
            url: resolved.path,
            unitsPerSquare,
            units,
            gridPadding: 5, // the app's default for every uploaded map
            ...(args.gridType ? { gridType: args.gridType } : {}),
            ...(args.vision !== undefined ? { vision: args.vision } : {}),
          };
        }

        const scene = await client.create<Json>("/scenes", {
          name: args.name,
          campaignId,
          layers: [layer],
          ...(args.category ? { category: args.category } : {}),
        });

        return json({
          created: { id: scene._id, name: scene.name, type },
          ...(uploaded
            ? { image: { id: uploaded.record._id, storedPath: uploaded.path } }
            : {}),
          next:
            type === "3d"
              ? "Place objects on it with `realm_place_objects` — read `realm_guide` topic `3d-scene-authoring` first."
              : undefined,
        });
      });
    }),
  );

  server.registerTool(
    "realm_set_portrait",
    {
      title: "Set a portrait or token image",
      description:
        "Give a record (NPC, character, item, …) or an effect its portrait, uploading a local " +
        "file if needed. With `asToken: true` it also becomes the record's 2D token image, which " +
        "is what appears on a map.\n\n" +
        "For a 3D mini instead of a flat image, use `realm_set_3d_token`.",
      inputSchema: {
        recordId: z.string().describe("The record's or effect's id."),
        type: z
          .string()
          .optional()
          .describe(
            "Where the record lives: `npcs`, `characters`, `effects`, or a ruleset record type. Default `npcs`.",
          ),
        imagePath: z.string().optional().describe("Local image file to upload and apply."),
        image: z
          .string()
          .optional()
          .describe("An existing image: record id, stored path, or name to search for."),
        asToken: z.boolean().optional().describe("Also use it as the record's 2D token image."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      if (!args.imagePath && !args.image) {
        return text("Pass `imagePath` to upload a new image, or `image` to use an existing one.");
      }

      const client = session.client();
      const type = args.type ?? "npcs";

      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const resolved = args.imagePath
          ? await uploadAndRegister(client, campaignId, args.imagePath, {})
          : await resolveExistingImage(client, campaignId, args.image!);

        // Effects have their own endpoint; everything else routes like a record.
        const path = type === "effects" ? "/effects" : client.recordEndpoint(type).path;

        const patch: Json = { portrait: resolved.path };
        if (args.asToken) {
          const existing = await client.get<Json>(path, args.recordId);
          patch.token = { ...((existing.token as Json) ?? {}), imageUrl: resolved.path };
        }

        const updated = await client.patch<Json>(path, args.recordId, patch);
        return json({
          record: { id: updated._id, name: updated.name },
          portrait: resolved.path,
          cdnUrl: cdnUrl(resolved.path),
          ...(args.asToken ? { tokenImage: resolved.path } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_journal_image_html",
    {
      title: "Build journal HTML for an image",
      description:
        "Produce the `<img>` markup a journal page needs for an image already in the campaign. " +
        "`float: 'left'|'right'` gives a 300px inline image text wraps around; the default is a " +
        "800px block image. Paste the result into a page's `content` via " +
        "`realm_write_journal_page`.\n\n" +
        "`realm_upload_image` already returns this for a freshly uploaded file — use this tool " +
        "for images that are already in the library, or to change the float.",
      inputSchema: {
        image: z.string().describe("Image record id, stored path, or name to search for."),
        alt: z.string().optional().describe("Alt text / caption."),
        float: z
          .enum(["left", "right", "block"])
          .optional()
          .describe("Layout. Default `block` (full width)."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const resolved = await resolveExistingImage(client, campaignId, args.image);
        const html = journalImgTag(cdnUrl(resolved.path), {
          alt: args.alt ?? String(resolved.record?.name ?? ""),
          ...(args.float ? { float: args.float } : {}),
          ...(resolved.record?._id ? { imageId: String(resolved.record._id) } : {}),
        });
        return json({ html, cdnUrl: cdnUrl(resolved.path) });
      });
    }),
  );
}
