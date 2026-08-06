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
import { authStore } from "../auth/store.js";
import { session, withAuthRecovery } from "../context.js";
import { ASSET_CDN, cdnUrl } from "./assets.js";
import { resolveIcon } from "./icons.js";
import { campaignArg, json, safe, text } from "./registry.js";
import {
  fetchPage,
  pageArgs,
  pageResult,
  provenanceOf,
  tryLoadFolderIndex,
  withSearch,
  type FolderIndex,
} from "./listing.js";

// Re-exported so existing importers keep finding these here.
export { ASSET_CDN, cdnUrl };

/**
 * The `<img>` markup a journal page uses, matching what the bulk journal
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

/**
 * A canvas scene's pixels-per-grid, matching the app's `calculateGridSize`.
 * Keeps the rendered canvas under ~25 megapixels while staying in a sane range.
 */
export function canvasGridSize(width: number, height: number): number {
  const MAX_MEGAPIXELS = 25_000_000;
  const MAX_GRID_SIZE = 100;
  const MIN_GRID_SIZE = 50;
  const totalSquares = Math.max(1, width * height);
  const gridSize = Math.floor(Math.sqrt(MAX_MEGAPIXELS / totalSquares));
  return Math.max(MIN_GRID_SIZE, Math.min(MAX_GRID_SIZE, gridSize));
}

/** An empty UVTT block — the shape every new layer carries. */
function emptyUvtt(resolution?: Json): Json {
  return {
    ...(resolution ? { resolution } : {}),
    line_of_sight: [],
    objects_line_of_sight: [],
    portals: [],
    environment: { baked_lighting: false, ambient_light: "#ffffff" },
    lights: [],
  };
}

/**
 * A campaign's default grid units come from its RULESET (`otherSettings`), which is
 * why a Cyberpunk campaign measures in metres and a 5e one in feet. Falls back to
 * the app's own defaults when there's no ruleset or it doesn't say.
 */
async function gridDefaults(
  client: RealmClient,
  campaignId: string,
): Promise<{ unitsPerSquare: number; units: string }> {
  const fallback = { unitsPerSquare: 5, units: "feet" };
  try {
    const campaign = await client.get<Json>("/campaigns", campaignId);
    if (!campaign.rulesetId) return fallback;
    const ruleset = await client.get<{
      settings?: { otherSettings?: { defaultUnitsPerSquare?: number; defaultUnits?: string } };
    }>("/rulesets", String(campaign.rulesetId));
    const other = ruleset.settings?.otherSettings;
    return {
      unitsPerSquare:
        typeof other?.defaultUnitsPerSquare === "number"
          ? other.defaultUnitsPerSquare
          : fallback.unitsPerSquare,
      units: typeof other?.defaultUnits === "string" ? other.defaultUnits : fallback.units,
    };
  } catch {
    // A missing or unreadable ruleset shouldn't stop a scene being created.
    return fallback;
  }
}

/**
 * One row of the image library.
 *
 * `cdnUrl` is included alongside `storedPath` because they are used for different
 * things and confusing them is a silent failure: a scene layer and a portrait
 * store the RELATIVE path, while journal `<img>` markup needs the absolute one.
 */
export function imageSummary(i: Json, folders: FolderIndex): Json {
  return {
    id: i._id,
    name: i.name,
    storedPath: i.url,
    cdnUrl: cdnUrl(String(i.url ?? "")),
    ...(i.category ? { category: i.category } : {}),
    ...folders.decorate(i),
    ...provenanceOf(i),
  };
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
    "realm_list_images",
    {
      title: "List the campaign's image library",
      description:
        "The campaign's images, with the same paging, folder and provenance fields every other " +
        "list tool reports. Use it to inventory what a campaign is carrying — before an export, " +
        "a cleanup, or a reorganize.\n\n" +
        "Filters (`search`, `category`, `folderId`) narrow it; with none it lists everything, a " +
        "page at a time.",
      inputSchema: {
        search: z.string().optional().describe("Free-text search. Omit to list every image."),
        category: z.string().optional().describe("Only images in this library category."),
        folderId: z
          .string()
          .optional()
          .describe("Only images filed in this folder. Pass `root` for unfiled images."),
        ...pageArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const folders = await tryLoadFolderIndex(client, campaignId, "images");

        // Every filter here IS a field on the image document, so all of them go
        // into the query and the server does the narrowing — `total` then counts
        // the filtered set rather than the whole library.
        const query = withSearch({ campaignId }, args.search);
        if (args.category) query.category = args.category;
        if (args.folderId === "root") query.folderId = { $exists: false };
        else if (args.folderId) query.folderId = args.folderId;

        const page = await fetchPage<Json>(client, "/images", query, args.limit, args.skip);
        return json(pageResult(page, "images", (i) => imageSummary(i, folders)));
      });
    }),
  );

  server.registerTool(
    "realm_find_image",
    {
      title: "Find a campaign image",
      description:
        "Search the campaign's image library by name. To list the whole library (or filter by " +
        "folder or category), use `realm_list_images`.",
      inputSchema: {
        search: z.string().optional().describe("Name to search for. Omit to list the first page."),
        ...pageArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const folders = await tryLoadFolderIndex(client, campaignId, "images");
        // `$search` is only sent when there IS one: the backend builds a Mongo stage
        // from the value and answers 500 on an empty string, which used to make
        // "just show me the images" impossible to ask for.
        const page = await fetchPage<Json>(
          client,
          "/images",
          withSearch({ campaignId }, args.search),
          args.limit ?? 25,
          args.skip,
        );
        return json(pageResult(page, "images", (i) => imageSummary(i, folders)));
      });
    }),
  );

  server.registerTool(
    "realm_create_scene",
    {
      title: "Create a scene",
      description:
        "Create a scene in the campaign. There are three kinds:\n\n" +
        "• `standard` — a 2D map built on an image. Pass `imagePath` (a local file to upload) " +
        "or `image` (an existing image id/path). This is what the app's 'Create new Scene' " +
        "produces from an upload, and it's the default when you give an image.\n" +
        "• `canvas` — also 2D, but DRAWN rather than uploaded: no image at all, sized in grid " +
        "squares via `width`/`height` and given a background `canvasColor`.\n" +
        "• `3d` — the 3D renderer. No image, exactly one layer; its contents are placed " +
        "separately with `realm_place_objects`.\n\n" +
        "The grid defaults to the campaign RULESET's units (e.g. 5 feet), which you can " +
        "override with `unitsPerSquare` and `units`.",
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
        unitsPerSquare: z
          .number()
          .optional()
          .describe("Game units per grid square. Defaults to the ruleset's setting, else 5."),
        units: z
          .string()
          .optional()
          .describe("Unit name. Defaults to the ruleset's setting, else `feet`."),
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
      const type = args.type ?? (args.imagePath || args.image ? "standard" : "canvas");

      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);

        const defaults = await gridDefaults(client, campaignId);
        const unitsPerSquare = args.unitsPerSquare ?? defaults.unitsPerSquare;
        const units = args.units ?? defaults.units;

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
            uvtt: emptyUvtt(),
          };
        } else if (type === "canvas") {
          const width = args.width ?? 30;
          const height = args.height ?? 30;
          layer = {
            isCanvasMode: true,
            canvasDimensions: { width, height },
            canvasColor: args.canvasColor ?? null,
            unitsPerSquare,
            units,
            gridPadding: 5,
            gridColor: "#00000050", // the app's default grey grid, not transparent
            gridType: args.gridType ?? "square",
            vision: args.vision ?? true,
            walls: [],
            uvtt: emptyUvtt({
              map_origin: { x: 0, y: 0 },
              map_size: { x: width, y: height },
              pixels_per_grid: canvasGridSize(width, height),
            }),
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
        "For stock artwork on a spell, item or feat, pass `icon` instead — a Realm VTT catalog " +
        "path from `realm_find_icons`, which costs no storage. Use `realm_set_record_icons` to " +
        "do that for many records at once.\n\n" +
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
        icon: z
          .string()
          .optional()
          .describe(
            "A Realm VTT catalog icon path from `realm_find_icons`, e.g. " +
              "`/icons/fantasy/magic/fire/fireball.webp`. Stored as a reference — nothing is " +
              "uploaded and no image-library asset is created.",
          ),
        asToken: z.boolean().optional().describe("Also use it as the record's 2D token image."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      if (!args.imagePath && !args.image && !args.icon) {
        return text(
          "Pass `imagePath` to upload a new image, `image` to use one already in the campaign, " +
            "or `icon` for a Realm VTT catalog icon.",
        );
      }

      const client = session.client();
      const type = args.type ?? "npcs";

      return withAuthRecovery(async () => {
        // An icon is a catalog reference, so it needs no campaign scope and no upload —
        // just validation that the path is real.
        if (args.icon) {
          const icon = await resolveIcon(client, args.icon);
          const path = type === "effects" ? "/effects" : client.recordEndpoint(type).path;
          const patch: Json = { portrait: icon };
          if (args.asToken) {
            const record = await client.get<Json>(path, args.recordId);
            const existingToken = (record.token as Json) ?? {};
            patch.token = {
              ...existingToken,
              creatorId: existingToken.creatorId ?? authStore.read()?.user?._id ?? "",
              imageUrl: icon,
            };
          }
          const updated = await client.patch<Json>(path, args.recordId, patch);
          return json({
            record: { id: updated._id, name: updated.name },
            portrait: icon,
            cdnUrl: cdnUrl(icon),
            ...(args.asToken ? { tokenImage: icon } : {}),
          });
        }

        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const resolved = args.imagePath
          ? await uploadAndRegister(client, campaignId, args.imagePath, {})
          : await resolveExistingImage(client, campaignId, args.image!);

        // Effects have their own endpoint; everything else routes like a record.
        const path = type === "effects" ? "/effects" : client.recordEndpoint(type).path;

        const patch: Json = { portrait: resolved.path };
        if (args.asToken) {
          const record = await client.get<Json>(path, args.recordId);
          const existingToken = (record.token as Json) ?? {};
          // `creatorId` is required by the token schema, so a record that has never
          // had a token needs one supplied or the patch fails validation.
          patch.token = {
            ...existingToken,
            creatorId: existingToken.creatorId ?? authStore.read()?.user?._id ?? "",
            imageUrl: resolved.path,
          };
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
