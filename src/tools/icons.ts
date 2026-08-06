/**
 * The shared Realm VTT icon catalog — the ~18k stock icons the app's "Select Realm
 * VTT Icon" picker offers, and what spells, items, feats and every other record use
 * for artwork when nobody has drawn something bespoke.
 *
 * ── Why this is NOT the image library ─────────────────────────────────────────
 * These icons are read-only, ship with Realm, and live under `/icons/…` in the same
 * bucket the CDN serves. Pointing a record at one is a pure REFERENCE: it creates no
 * `images` record, uploads nothing, and consumes none of the account's storage quota.
 * That is what makes it the right way to art up 500 spells at once — the alternative,
 * uploading 500 copies of stock art into the campaign's image library, bills the user
 * for artwork Realm already hosts.
 *
 * ── Where an assignment is stored ─────────────────────────────────────────────
 * On `portrait`, as a plain catalog path. Records have NO separate `icon` field —
 * `portrait` holds either an uploaded image's stored path (`/images/…`) or a catalog
 * icon path (`/icons/…`), and the client's `getImageUrl` prefixes whichever it finds
 * with the asset host. (Macros are the exception: they store `icon`. Nothing here
 * writes macros.) So the readback for QA is the `portrait` field that
 * `realm_get_record` and `realm_find_records` already return.
 *
 * ── Search ────────────────────────────────────────────────────────────────────
 * The backend's `realmvtt-icons` service does hybrid retrieval — BM25 over path
 * tokens plus AI descriptions, reranked by MiniLM embeddings — which is what makes
 * "necrotic damage" find `magic/death/skull-energy-green.webp`. Coverage of the
 * embedding half is partial by design: icons that aren't embedded yet still surface
 * via BM25, so results always come back ranked rather than empty.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { ASSET_CDN } from "./assets.js";
import { json, safe } from "./registry.js";

/** Every catalog path starts here; it is also the marker that tells an icon
 *  reference apart from an uploaded image's `/images/…` path. */
export const ICON_PREFIX = "/icons/";

/** The backend clamps a fuzzy query to this many results (MAX_FUZZY_LIMIT). */
const MAX_BACKEND_LIMIT = 1000;

/**
 * The picker hides this folder unless you search for it — it holds thousands of
 * near-identical ability glyphs that otherwise swamp every browse. Mirrored here so
 * a category listing looks like what the user sees in the app.
 */
const NOISY_FOLDER = "/icons/fantasy/actions";

/**
 * A "bulk" assignment here is bulk only in the TOOL's interface — it fans out to one
 * ordinary single-record PATCH per entry, issued strictly one at a time.
 *
 * The API has no multi-patch, deliberately: a Feathers `patch(null, …)` bypasses the
 * per-record hooks and emits one event for the whole write, so a bulk endpoint would
 * silently skip validation and leave every connected client's store stale. Nothing
 * here may work around that — not with a null-id patch, and not by firing the
 * individual patches concurrently, which just moves the stampede to the socket.
 */

export interface IconInfo extends Json {
  /** The stable key: what gets stored on the record, and what the CDN serves. */
  path: string;
  /** Human-readable, derived from the filename the way the picker derives it. */
  name: string;
  /** Folder path under `/icons/`, e.g. `fantasy/magic/fire`. */
  category: string;
  /** Fully-qualified preview URL. */
  url: string;
}

/**
 * The picker's `getIconName`: filename, extension dropped, separators to spaces,
 * title-cased. Reproduced rather than invented so a name here matches the label the
 * user sees under the same icon in the app.
 */
export function iconName(path: string): string {
  const filename = path.split("/").pop() ?? path;
  return filename
    .replace(/\.(webp|png|jpg|jpeg|gif|svg)$/i, "")
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The folder an icon sits in, with the `/icons/` prefix and filename stripped. */
export function iconCategory(path: string): string {
  const parts = path.replace(/^\/?icons\/?/, "").split("/");
  return parts.slice(0, -1).join("/");
}

export function describeIcon(path: string): IconInfo {
  return {
    path,
    name: iconName(path),
    category: iconCategory(path),
    url: `${ASSET_CDN}${path}`,
  };
}

/**
 * Accept the several shapes a caller plausibly hands us for one icon — a bare
 * catalog path, one missing its leading slash, or a full CDN URL — and return the
 * canonical stored form. Anything that isn't a catalog reference comes back
 * unchanged, so the caller can tell it apart and reject it.
 */
export function normalizeIconPath(value: string): string {
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return value.trim();
    }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  return path;
}

export function isIconPath(value: string): boolean {
  return normalizeIconPath(value).startsWith(ICON_PREFIX);
}

/**
 * The picker's non-fuzzy mode: every whitespace-separated term must appear literally
 * somewhere in the path, comparing alphanumerics only so `fire ball` matches
 * `fireball` and punctuation never blocks a match.
 */
export function pathFilter(query: string, icons: string[]): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return icons;
  return icons.filter((icon) => {
    const flat = icon.toLowerCase().replace(/[^a-z0-9/]/g, "");
    return terms.every((term) => flat.includes(term));
  });
}

/**
 * Category matching is by folder PREFIX, so `fantasy/magic` takes in
 * `fantasy/magic/fire` too. Matching on the segment boundary keeps `magic` from
 * also pulling in a hypothetical `magical/`.
 */
export function inCategory(path: string, category: string): boolean {
  const wanted = category.replace(/^\/?icons\/?/, "").replace(/\/+$/, "").toLowerCase();
  if (!wanted) return true;
  const actual = iconCategory(path).toLowerCase();
  return actual === wanted || actual.startsWith(`${wanted}/`);
}

/** Folder counts, deepest-first-sortable, for browsing a catalog too big to list. */
export function categoryTree(icons: string[], under = ""): Array<{ category: string; icons: number }> {
  const counts = new Map<string, number>();
  for (const path of icons) {
    if (under && !inCategory(path, under)) continue;
    const category = iconCategory(path);
    if (!category) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, icons: count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * The whole manifest, cached for the life of the process.
 *
 * 18k paths is ~1MB on the wire and the catalog only changes when an admin rescans,
 * so re-fetching it per call would be pure latency. Every non-fuzzy path (browsing,
 * exact filtering, and validating a bulk assignment) reads this.
 */
let manifestCache: string[] | null = null;

export async function loadManifest(client: RealmClient): Promise<string[]> {
  if (manifestCache) return manifestCache;
  const page = await client.find<string>("/realmvtt-icons");
  manifestCache = page.data.filter((entry): entry is string => typeof entry === "string");
  return manifestCache;
}

/** Exposed for tests; also the escape hatch if an admin rescans mid-session. */
export function clearManifestCache(): void {
  manifestCache = null;
}

async function fuzzySearch(client: RealmClient, q: string, limit: number): Promise<string[]> {
  const page = await client.find<string>("/realmvtt-icons", {
    q,
    fuzzy: true,
    limit: Math.min(limit, MAX_BACKEND_LIMIT),
  });
  return page.data.filter((entry): entry is string => typeof entry === "string");
}

export interface Assignment {
  recordId: string;
  recordType?: string;
  icon: string;
}

export function registerIconTools(server: McpServer): void {
  server.registerTool(
    "realm_find_icons",
    {
      title: "Search the Realm VTT icon catalog",
      description:
        "Find stock icons by MEANING — `search: 'necrotic damage'` returns skull and green-energy " +
        "glyphs, not just files with those words in the name. This is the same catalog the app's " +
        "'Select Realm VTT Icon' picker shows (~18k icons), and it is the right source of artwork " +
        "for bulk-importing spells, items and feats: an icon is a REFERENCE, so using one creates " +
        "no image-library asset and uses none of the account's storage quota.\n\n" +
        "Each result's `path` is the stable key — store it on a record's `portrait` field " +
        "(`realm_set_record_icons` for many records, `realm_set_portrait` or `realm_write_record` " +
        "for one). `url` is a preview link.\n\n" +
        "RESULTS ARE RANKED GUESSES, NOT ANSWERS. This is a text-and-embedding search over " +
        "filenames and generated descriptions — nothing here has looked at the artwork, and " +
        "coverage of the AI-described half of the index is partial, so weaker matches still come " +
        "back rather than nothing. Read the paths: the top hit for a niche query is often only " +
        "loosely related. Prefer a sensible generic icon from the right category over a specific " +
        "one whose name merely shares a word, and if nothing fits, leave the record's artwork " +
        "alone rather than assigning a poor match.\n\n" +
        "With no `search` and no `category` it returns the CATEGORY TREE instead of 18k paths, " +
        "which is how to explore what exists.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            "What the icon should depict, in plain words — e.g. `fireball`, `holy healing light`, " +
              "`rusty iron key`. Semantic by default.",
          ),
        exact: z
          .boolean()
          .optional()
          .describe(
            "Match `search` as literal path text instead of by meaning — every term must appear " +
              "in the path. Use when you know a filename and want only it.",
          ),
        category: z
          .string()
          .optional()
          .describe(
            "Restrict to a folder, e.g. `fantasy/magic/fire`. Prefix match, so `fantasy/magic` " +
              "includes its subfolders. Alone (no `search`) it lists that folder's icons.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe("Max icons to return. Default 30."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      const limit = args.limit ?? 30;
      const query = args.search?.trim();

      return withAuthRecovery(async () => {
        // Nothing to go on — browsing the tree beats dumping the catalog.
        if (!query && !args.category) {
          const tree = categoryTree(await loadManifest(client));
          return json({
            categories: tree,
            note:
              "Pass `search` to find icons by meaning, or `category` to list one of these folders.",
          });
        }

        let matches: string[];
        let mode: string;

        if (query && !args.exact) {
          // The category filter runs client-side over the ranked list, so ask the
          // backend for enough headroom that filtering doesn't empty the page.
          const want = args.category ? Math.max(limit * 10, 300) : limit;
          matches = await fuzzySearch(client, query, want);
          mode = "semantic";
        } else {
          const manifest = await loadManifest(client);
          matches = query ? pathFilter(query, manifest) : manifest;
          mode = query ? "exact" : "browse";
          // Browsing a folder shouldn't open on the thousands of near-identical
          // action glyphs the picker itself hides until you search for them.
          if (!query && !args.category?.toLowerCase().includes("action")) {
            matches = matches.filter((path) => !path.startsWith(NOISY_FOLDER));
          }
        }

        if (args.category) matches = matches.filter((path) => inCategory(path, args.category!));

        const page = matches.slice(0, limit);
        return json({
          mode,
          total: matches.length,
          returned: page.length,
          ...(matches.length > page.length
            ? { note: `${matches.length - page.length} more match — raise \`limit\` or narrow the search.` }
            : {}),
          icons: page.map(describeIcon),
        });
      });
    }),
  );

  server.registerTool(
    "realm_set_record_icons",
    {
      title: "Assign catalog icons to records in bulk",
      description:
        "Point many records at Realm VTT catalog icons in one call — built for arting up a whole " +
        "imported spell or item library. Each icon is stored on the record's `portrait` field as a " +
        "catalog reference, so nothing is uploaded and no image-library assets are created.\n\n" +
        "Every `icon` is checked against the catalog BEFORE anything is written: a path that " +
        "doesn't exist is reported and skipped, never silently stored as a broken image. Find " +
        "valid paths with `realm_find_icons`.\n\n" +
        "Writes are ordinary single-record updates issued one at a time, so a few hundred " +
        "assignments take a while — expect roughly a second per hundred records and don't split " +
        "one library across parallel calls. A record that fails is reported; the rest still run.\n\n" +
        "Verify afterwards by reading `portrait` back from `realm_find_records` or " +
        "`realm_get_record`. For a single record, `realm_set_portrait` with `icon` is simpler.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe(
            "Default record type for every assignment, e.g. `spells`, `items`, `npcs`. Override " +
              "per entry with `recordType`.",
          ),
        assignments: z
          .array(
            z.object({
              recordId: z.string().describe("The record's `_id`."),
              recordType: z
                .string()
                .optional()
                .describe("This record's type, if it differs from the top-level `type`."),
              icon: z
                .string()
                .describe("Catalog icon path from `realm_find_icons`, e.g. `/icons/fantasy/magic/fire/fireball.webp`."),
            }),
          )
          .min(1)
          .max(1000)
          .describe("The records to art up."),
      },
    },
    safe(async (args) => {
      const client = session.client();

      return withAuthRecovery(async () => {
        const manifest = new Set(await loadManifest(client));

        const planned: Array<{ recordId: string; recordType: string; icon: string }> = [];
        const rejected: Array<{ recordId: string; icon: string; reason: string }> = [];

        for (const entry of args.assignments as Assignment[]) {
          const recordType = entry.recordType ?? args.type;
          if (!recordType) {
            rejected.push({
              recordId: entry.recordId,
              icon: entry.icon,
              reason: "No record type — set `type`, or `recordType` on this entry.",
            });
            continue;
          }
          const icon = normalizeIconPath(entry.icon);
          if (!icon.startsWith(ICON_PREFIX)) {
            rejected.push({
              recordId: entry.recordId,
              icon: entry.icon,
              reason: `Not a catalog icon path (must start with \`${ICON_PREFIX}\`).`,
            });
            continue;
          }
          if (!manifest.has(icon)) {
            rejected.push({
              recordId: entry.recordId,
              icon,
              reason: "No such icon in the catalog — check the path with `realm_find_icons`.",
            });
            continue;
          }
          planned.push({ recordId: entry.recordId, recordType, icon });
        }

        const updated: Array<{ id: string; name?: unknown; portrait: string }> = [];
        const failed: Array<{ recordId: string; icon: string; reason: string }> = [];

        // One record at a time — see the note on multi-patch above. A failure is
        // recorded and the run continues, so one locked record can't strand the rest.
        for (const entry of planned) {
          try {
            const record = await client.patchRecord<Json>(entry.recordType, entry.recordId, {
              portrait: entry.icon,
            });
            updated.push({ id: entry.recordId, name: record.name, portrait: entry.icon });
          } catch (err) {
            failed.push({
              recordId: entry.recordId,
              icon: entry.icon,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const problems = [...rejected, ...failed];
        return json({
          requested: (args.assignments as Assignment[]).length,
          updated: updated.length,
          ...(problems.length ? { skipped: problems.length, problems } : {}),
          // The full success list is noise at 551 records; a sample is enough to
          // eyeball, and `realm_find_records` is the real readback.
          sample: updated.slice(0, 10),
        });
      });
    }),
  );
}

/** Resolve an icon reference for the single-record path, or explain why it can't be. */
export async function resolveIcon(client: RealmClient, value: string): Promise<string> {
  const icon = normalizeIconPath(value);
  if (!icon.startsWith(ICON_PREFIX)) {
    throw new Error(
      `\`${value}\` is not a Realm VTT catalog icon — those paths start with \`${ICON_PREFIX}\`. ` +
        `Find one with \`realm_find_icons\`, or pass \`image\`/\`imagePath\` for campaign artwork.`,
    );
  }
  const manifest = await loadManifest(client);
  if (!manifest.includes(icon)) {
    throw new Error(`No icon \`${icon}\` in the catalog — check the path with \`realm_find_icons\`.`);
  }
  return icon;
}
