/**
 * The campaign's sound library: uploading an audio file, and reading back what's
 * already there.
 *
 * ── Why this mirrors images.ts so closely ─────────────────────────────────────
 * A sound is uploaded through the same `POST /upload` endpoint an image is, and
 * the BACKEND does the storage accounting as part of that request — quota check,
 * per-file limit, `user-assets` row. The sounds service then claims that row in
 * its own after-create hook, matching on `{url, userId}`. That claim is why the
 * upload and the record creation belong together in one tool: an upload with no
 * `sounds` record leaves an orphaned asset counting against the user's storage,
 * and a record pointing at a URL nobody uploaded is unplayable.
 *
 * Nothing here deletes a sound. Removing one has to free the R2 object, and only
 * the backend's own `onDeleteSound` hook knows whether some OTHER record still
 * references the same URL.
 */
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { ASSET_CDN } from "./images.js";
import { getLayer, writeLayer } from "./markers.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";
import {
  fetchPage,
  pageArgs,
  pageResult,
  provenanceOf,
  tryLoadFolderIndex,
  withSearch,
  type FolderIndex,
} from "./listing.js";

/**
 * What the app's "New Sound" dropzone accepts. The client checks the extension a
 * second time after the mime filter, so an `.aac` renamed to `.mp3` is the only
 * way past it — we check the same list for the same reason: a file the backend
 * stores but no browser can decode is worse than a refusal here.
 */
export const SOUND_EXTENSIONS = [".mp3", ".m4a", ".ogg", ".wav"] as const;

/**
 * A playable url for a stored sound path.
 *
 * Sounds are stored WITHOUT a leading slash — `sounds/<uuid>_Name.mp3` — where
 * images are stored with one, so a shared builder would produce
 * `https://assets.realmvtt.comsounds/…`. This normalises the separator instead of
 * assuming either shape.
 *
 * A path that is already absolute is returned untouched, matching the app's own
 * `getSoundUrl`: module-installed sounds can carry a full url, and prefixing one
 * would give `https://assets.realmvtt.com/https://…`.
 */
export function soundUrl(storedPath: string): string {
  const path = storedPath.trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${ASSET_CDN}/${path.replace(/^\/+/, "")}`;
}

export function isSupportedSoundFile(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return (SOUND_EXTENSIONS as readonly string[]).includes(ext);
}

/** Filename → a human name, matching how the image library titles an upload. */
export function soundNameFromFile(fileName: string): string {
  return basename(fileName, extname(fileName)).replace(/[_-]+/g, " ").trim();
}

/**
 * One row of the sound library.
 *
 * `storedPath` and `cdnUrl` are both here for the same reason they are on an
 * image: a scene's audio and a `sounds` record store the RELATIVE path, while
 * anything that plays or previews the file needs the absolute one.
 *
 * The playlist flags are included because they are the difference between a
 * track that sits in the library and one the app plays on its own — a sound with
 * `combatMusic` starts when combat does, whether or not anyone asked.
 */
export function soundSummary(s: Json, folders: FolderIndex): Json {
  return {
    id: s._id,
    name: s.name,
    storedPath: s.url,
    cdnUrl: soundUrl(String(s.url ?? "")),
    ...(s.category ? { category: s.category } : {}),
    ...(s.combatMusic ? { combatMusic: true } : {}),
    ...(s.pauseMusic ? { pauseMusic: true } : {}),
    ...(s.hiddenFromControls ? { hiddenFromControls: true } : {}),
    ...folders.decorate(s),
    ...provenanceOf(s),
  };
}

/** Upload a local audio file and register it in the campaign's sound library. */
async function uploadAndRegisterSound(
  client: RealmClient,
  campaignId: string,
  filePath: string,
  opts: { name?: string; category?: string; folderId?: string; shared?: boolean },
): Promise<{ path: string; record: Json }> {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(process.cwd(), filePath);
  const fileName = basename(abs);

  if (!isSupportedSoundFile(fileName)) {
    throw new Error(
      `"${fileName}" isn't a supported audio file. Realm plays ${SOUND_EXTENSIONS.join(", ")} — ` +
        `convert it first (e.g. \`ffmpeg -i "${fileName}" out.mp3\`).`,
    );
  }

  const data = await readFile(abs);
  const stored = (await client.upload(fileName, new Uint8Array(data))).trim();

  // Mirrors the app's "Create new Sound" exactly, placeholder unidentified name
  // included, so a GM can hide a track from players by un-identifying it.
  const record = await client.create<Json>("/sounds", {
    name: opts.name ?? soundNameFromFile(fileName),
    unidentifiedName: "Unidentified Sound",
    identified: true,
    locked: true,
    url: stored,
    campaignId,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
    ...(opts.shared ? { shared: true } : {}),
  });

  return { path: stored, record };
}

/** Resolve a sound by record id, stored path, or name — for tools that take any. */
async function resolveSound(
  client: RealmClient,
  campaignId: string,
  ref: string,
): Promise<Json> {
  if (/^[a-f0-9]{24}$/i.test(ref)) return client.get<Json>("/sounds", ref);

  // A stored path is exact, so match on it rather than fuzzily on the name.
  if (ref.includes("/")) {
    const byPath = await client.find<Json>("/sounds", { campaignId, url: ref, $limit: 1 });
    if (byPath.data[0]) return byPath.data[0];
  }

  const found = await client.find<Json>("/sounds", { campaignId, $search: ref, $limit: 1 });
  const record = found.data[0];
  if (!record) {
    throw new Error(
      `No sound matching "${ref}" in this campaign. Upload one with \`realm_upload_sound\`, ` +
        `or list what's there with \`realm_list_sounds\`.`,
    );
  }
  return record;
}

/**
 * ── Sounds placed ON a scene ──────────────────────────────────────────────────
 *
 * A placed sound is NOT a `sounds` record and not its own service: it is an entry
 * in `layer.sounds`, alongside the pins and teleporters markers.ts manages, and
 * it stores the library record's `url` — never its id. So a placed sound survives
 * the library record being deleted (it keeps playing off the same file), and
 * renaming the library entry does NOT rename the emitter.
 *
 * Entries carry no id of their own, exactly like journal links, so they are
 * addressed by INDEX — which is how the app addresses them too.
 *
 * 2D and 3D share the array but not the defaults: the 2D drop handler places at
 * `volume 0.5, radius 1`, the 3D one at `volume 1.0, radius 5, ambient false`
 * plus a `z`. Radius is in GRID SQUARES (cubes in 3D) in both, never pixels.
 */
export interface PlacedSound extends Json {
  name: string;
  url: string;
  volume: number;
  radius: number;
  position: { x: number; y: number; z?: number };
  ambient?: boolean;
  muted?: boolean;
}

/** Read a layer's placed sounds, tolerating a layer that has none yet. */
export function placedSoundsOn(layer: Json | undefined): PlacedSound[] {
  const raw = layer?.sounds;
  return Array.isArray(raw) ? (raw as PlacedSound[]) : [];
}

export function isScene3dLayer(layer: Json | undefined): boolean {
  return layer?.sceneType === "3d";
}

/**
 * Build the layer entry, matching whichever drop handler the app would have used.
 *
 * The 3D handler spreads the whole dragged record, so a persisted 3D sound also
 * carries `_id`, `campaignId` and friends. Those fields are read by nothing —
 * `SoundManager3D` uses name/url/position/volume/radius/ambient/muted only — so
 * we write the minimal document in both cases rather than copying dead weight
 * into every scene.
 */
export function placedSoundFor(
  record: { name?: unknown; url?: unknown },
  position: { x: number; y: number; z?: number },
  opts: { radius?: number; volume?: number; ambient?: boolean; muted?: boolean },
  is3d: boolean,
): PlacedSound {
  return {
    name: String(record.name ?? ""),
    url: String(record.url ?? ""),
    volume: opts.volume ?? (is3d ? 1 : 0.5),
    radius: opts.radius ?? (is3d ? 5 : 1),
    position:
      is3d && position.z !== undefined
        ? { x: position.x, y: position.y, z: position.z }
        : { x: position.x, y: position.y },
    ...(opts.ambient !== undefined ? { ambient: opts.ambient } : is3d ? { ambient: false } : {}),
    ...(opts.muted ? { muted: true } : {}),
  };
}

export function registerSoundTools(server: McpServer): void {
  server.registerTool(
    "realm_upload_sound",
    {
      title: "Upload a sound into the campaign",
      description:
        "Upload a local audio file and add it to the campaign's sound library, exactly as the " +
        "app's 'New Sound' does. Accepts mp3, m4a, ogg and wav. Storage quota and asset " +
        "tracking are handled by the server as part of the upload.\n\n" +
        "Returns the sound record id, its stored path and its CDN url — the id is what files it " +
        "into a folder with `realm_move_to_folder`, and the stored path is what scene audio " +
        "references.\n\n" +
        "Only the campaign OWNER can create sounds; a Co-GM's upload is refused by the server.",
      inputSchema: {
        path: z.string().describe("Absolute path to the audio file on this machine."),
        name: z.string().optional().describe("Name for the sound record (defaults to the filename)."),
        category: z.string().optional().describe("Grouping category in the sound library."),
        folderId: z
          .string()
          .optional()
          .describe("File it straight into this folder. Omit to leave it unfiled."),
        shared: z.boolean().optional().describe("Make it visible to players immediately."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const { path, record } = await uploadAndRegisterSound(client, campaignId, args.path, args);
        return json({
          soundId: record._id,
          name: record.name,
          storedPath: path,
          cdnUrl: soundUrl(path),
          ...(record.category ? { category: record.category } : {}),
          ...(record.folderId ? { folderId: record.folderId } : {}),
        });
      });
    }),
  );

  server.registerTool(
    "realm_list_sounds",
    {
      title: "List the campaign's sound library",
      description:
        "The campaign's sounds, with the same paging, folder and provenance fields every other " +
        "list tool reports. Use it to inventory a soundscape — after a bulk upload, before a " +
        "cleanup, or to check what a folder ended up holding.\n\n" +
        "Filters (`search`, `category`, `folderId`) narrow it; with none it lists everything, a " +
        "page at a time.",
      inputSchema: {
        search: z.string().optional().describe("Free-text search. Omit to list every sound."),
        category: z.string().optional().describe("Only sounds in this library category."),
        folderId: z
          .string()
          .optional()
          .describe("Only sounds filed in this folder. Pass `root` for unfiled sounds."),
        ...pageArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const folders = await tryLoadFolderIndex(client, campaignId, "sounds");

        // Every filter here IS a field on the sound document, so the server does
        // the narrowing and `total` counts the filtered set, not the whole library.
        const query = withSearch({ campaignId }, args.search);
        if (args.category) query.category = args.category;
        if (args.folderId === "root") query.folderId = { $exists: false };
        else if (args.folderId) query.folderId = args.folderId;

        const page = await fetchPage<Json>(client, "/sounds", query, args.limit, args.skip);
        return json(pageResult(page, "sounds", (s) => soundSummary(s, folders)));
      });
    }),
  );

  server.registerTool(
    "realm_get_sound",
    {
      title: "Get one sound",
      description:
        "Read a single sound by record id, stored path, or name. Returns the full record — " +
        "including the playlist flags (`combatMusic`, `pauseMusic`, `hiddenFromControls`) that " +
        "decide whether the app plays it on its own — so an upload can be verified after the fact.",
      inputSchema: {
        sound: z.string().describe("Sound record id, stored path, or name to search for."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const folders = await tryLoadFolderIndex(client, campaignId, "sounds");
        const record = await resolveSound(client, campaignId, args.sound);
        return json({
          ...soundSummary(record, folders),
          identified: record.identified ?? false,
          unidentifiedName: record.unidentifiedName,
          createdAt: record.createdAt,
        });
      });
    }),
  );

  server.registerTool(
    "realm_place_sound",
    {
      title: "Place a sound on a scene",
      description:
        "Drop a library sound onto a scene as an ambient EMITTER — a point on the map that plays " +
        "and fades with distance. Works on both 2D and 3D scenes; the scene's type decides the " +
        "defaults, matching what dragging the sound onto the map would produce (2D: radius 1, " +
        "volume 0.5 — 3D: radius 5, volume 1).\n\n" +
        "`radius` is in GRID SQUARES (cubes in 3D), not pixels — a tavern's noise carrying across " +
        "half a street is a radius of about 5, not 200.\n\n" +
        "`ambient: true` means no falloff at all: the sound plays for everyone on the scene at " +
        "full volume wherever they stand. That's the setting for a scene's background wash — rain, " +
        "wind, a dungeon's drone — where position is meaningless.\n\n" +
        "Placed sounds loop forever; there is no one-shot. The emitter stores the sound's FILE " +
        "path, not its record id, so it keeps playing even if the library entry is later deleted.",
      inputSchema: {
        sceneId: z.string().describe("The scene to place it on."),
        sound: z.string().describe("Library sound: record id, stored path, or name to search for."),
        x: z.number().describe("Grid X. Squares from the origin, not pixels."),
        y: z.number().describe("Grid Y. Squares from the origin, not pixels."),
        z: z
          .number()
          .optional()
          .describe("Cube elevation (3D only). Omit for ground level; ignored by 2D scenes."),
        radius: z
          .number()
          .optional()
          .describe("Falloff radius in grid squares. Defaults to the scene type's own default."),
        volume: z.number().min(0).max(1).optional().describe("0 to 1. Default 0.5 in 2D, 1 in 3D."),
        ambient: z
          .boolean()
          .optional()
          .describe("Play everywhere at full volume, ignoring distance and `radius`."),
        muted: z.boolean().optional().describe("Place it silenced for all players."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const record = await resolveSound(client, campaignId, args.sound);
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const is3d = isScene3dLayer(layer);

        const placed = placedSoundFor(
          record,
          { x: args.x, y: args.y, ...(args.z !== undefined ? { z: args.z } : {}) },
          args,
          is3d,
        );
        const sounds = [...placedSoundsOn(layer), placed];
        await writeLayer(client, args.sceneId, scene, layerIndex, { sounds });

        return json({
          placed,
          // The index IS the handle — `realm_update_scene_sound` and
          // `realm_remove_scene_sound` take nothing else.
          index: sounds.length - 1,
          sceneType: is3d ? "3d" : "2d",
          sceneId: args.sceneId,
        });
      });
    }),
  );

  server.registerTool(
    "realm_list_scene_sounds",
    {
      title: "List the sounds placed on a scene",
      description:
        "The ambient sound emitters on a scene, each with the `index` that addresses it. Use it " +
        "to check what a scene actually plays before adding more — a soundscape with three " +
        "overlapping `ambient` tracks is a wall of noise, and this is the only way to see that.",
      inputSchema: { sceneId: z.string(), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { layer } = await getLayer(client, args.sceneId);
        const sounds = placedSoundsOn(layer);
        return json({
          sceneId: args.sceneId,
          sceneType: isScene3dLayer(layer) ? "3d" : "2d",
          total: sounds.length,
          sounds: sounds.map((s, index) => ({
            index,
            name: s.name,
            storedPath: s.url,
            position: s.position,
            radius: s.radius,
            volume: s.volume,
            ...(s.ambient ? { ambient: true } : {}),
            ...(s.muted ? { muted: true } : {}),
          })),
        });
      });
    }),
  );

  server.registerTool(
    "realm_update_scene_sound",
    {
      title: "Change a sound placed on a scene",
      description:
        "Adjust one emitter on a scene — move it, retune its radius or volume, or flip it between " +
        "positional and `ambient`. Address it by the `index` from `realm_list_scene_sounds`. " +
        "Only the fields you pass change.",
      inputSchema: {
        sceneId: z.string(),
        index: z.number().int().min(0).describe("The emitter's array position on the scene."),
        name: z.string().optional().describe("Rename this emitter (not the library record)."),
        x: z.number().optional().describe("New grid X."),
        y: z.number().optional().describe("New grid Y."),
        z: z.number().optional().describe("New cube elevation (3D only)."),
        radius: z.number().optional().describe("New falloff radius, in grid squares."),
        volume: z.number().min(0).max(1).optional().describe("New volume, 0 to 1."),
        ambient: z.boolean().optional().describe("Play everywhere at full volume, ignoring distance."),
        muted: z.boolean().optional().describe("Silence it for all players."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const sounds = placedSoundsOn(layer);
        const current = sounds[args.index];
        if (!current) {
          return text(
            `No sound at index ${args.index} — this scene has ${sounds.length}. ` +
              "List them with `realm_list_scene_sounds`.",
          );
        }

        // Position is one object on the document, so a lone `x` has to be merged
        // onto the existing pair rather than replacing it with a half-position.
        const position = { ...current.position };
        if (args.x !== undefined) position.x = args.x;
        if (args.y !== undefined) position.y = args.y;
        if (args.z !== undefined) position.z = args.z;

        const updated: PlacedSound = {
          ...current,
          position,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.radius !== undefined ? { radius: args.radius } : {}),
          ...(args.volume !== undefined ? { volume: args.volume } : {}),
          ...(args.ambient !== undefined ? { ambient: args.ambient } : {}),
          ...(args.muted !== undefined ? { muted: args.muted } : {}),
        };

        const next = sounds.map((s, i) => (i === args.index ? updated : s));
        await writeLayer(client, args.sceneId, scene, layerIndex, { sounds: next });
        return json({ index: args.index, sound: updated });
      });
    }),
  );

  server.registerTool(
    "realm_remove_scene_sound",
    {
      title: "Remove a sound from a scene",
      description:
        "Take an emitter off a scene, addressed by the `index` from `realm_list_scene_sounds`. " +
        "The library record is untouched — this removes the placement, not the sound. Requires " +
        "confirm: true.",
      inputSchema: {
        sceneId: z.string(),
        index: z.number().int().min(0).describe("The emitter's array position on the scene."),
        ...confirmArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `remove the sound at index ${args.index}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        const { scene, layer, layerIndex } = await getLayer(client, args.sceneId);
        const sounds = placedSoundsOn(layer);
        const doomed = sounds[args.index];
        if (!doomed) {
          return text(`No sound at index ${args.index} — this scene has ${sounds.length}.`);
        }

        const next = sounds.filter((_, i) => i !== args.index);
        await writeLayer(client, args.sceneId, scene, layerIndex, { sounds: next });
        return text(
          `Removed "${doomed.name}" from the scene. Indices after it have shifted down by one. ` +
            "The library sound itself is untouched.",
        );
      });
    }),
  );
}
