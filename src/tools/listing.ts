/**
 * Shared shape for every "list the campaign's X" tool.
 *
 * Before this existed each list tool invented its own envelope: images had
 * `total` meaning "matches", scenes had `total` meaning "before filtering" and a
 * separate `returned`, journals had neither a search nor a way to ask for a second
 * page. A model that learned one could not read the next, and the ones backed by
 * `findAll` would happily pour four thousand rows into the context window because
 * nothing between the API and the result had a ceiling.
 *
 * So: one page envelope, one folder decoration, one provenance block, applied
 * everywhere.
 *
 * ── Paging is the BACKEND's, not ours ─────────────────────────────────────────
 * Every Realm service paginates by default: 50 rows if you send no `$limit`, up
 * to its configured `max` (500 globally) if you do. A caller-facing `limit`/`skip`
 * therefore maps onto `$limit`/`$skip` and nothing else. We do NOT assemble the
 * full collection with `findAll` and slice it, because that turns `limit: 10` into
 * a download of every row in the campaign and reports a `total` we paid for rather
 * than one the server gave us.
 *
 * The one place rows are examined client-side is a filter with no query field
 * behind it (see `scanPage`), and that case reports itself as a bounded scan
 * instead of quietly pretending to be a page.
 */
import { z } from "zod";
import type { Json, Query, RealmClient } from "../api/client.js";
import { folderPathsById, folderScopeFor } from "./folders.js";

/** The paging arguments every list tool accepts, worded identically in each. */
export const pageArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max rows to return (default 50). `total` always reports how many exist."),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many rows before returning — page 2 of a 50-row page is `skip: 50`."),
};

export interface Page<T> {
  /** How many rows exist, ignoring `limit`/`skip`. The SERVER's count. */
  total: number;
  /** How many are in `rows`. */
  returned: number;
  skip: number;
  rows: T[];
  /** Present only when rows were withheld, so the model knows to ask for more. */
  note?: string;
}

export const DEFAULT_PAGE_LIMIT = 50;

/**
 * The most rows to ask the backend for in one request.
 *
 * Realm paginates every service by default — 50 rows when `$limit` is omitted,
 * and `max` (500 globally) when it is given. So this is the SERVER's ceiling, not
 * a page size we chose, and `limit` above it costs consecutive requests. Mirrors
 * `PAGE` in client.ts.
 *
 * `fetchPage` advances by the rows it actually received rather than by this
 * constant, so the two services with their own ceilings (folders, which allows
 * more; anything that might allow less) are handled without special-casing.
 */
export const SERVER_PAGE = 500;

/**
 * One page, fetched THE BACKEND'S way.
 *
 * `skip` and `limit` map onto the service's own `$skip`/`$limit`, so asking for
 * ten rows transfers ten rows. `total` is the server's count of everything
 * matching the query, not of what we happened to fetch — which is what makes
 * "there are 812, here are 50" a truthful statement rather than an inferred one.
 *
 * A `limit` above the server's per-request ceiling is satisfied by consecutive
 * requests, the same way `findAll` does it. The loop advances by the rows actually
 * RECEIVED, never by the requested size — a service whose ceiling is lower than
 * ours then costs one more round trip instead of silently dropping the remainder.
 */
export async function fetchPage<T = Json>(
  client: RealmClient,
  path: string,
  query: Query,
  limit?: number,
  skip?: number,
): Promise<Page<T>> {
  const start = Math.max(0, skip ?? 0);
  const want = limit ?? DEFAULT_PAGE_LIMIT;

  const rows: T[] = [];
  let total = 0;
  while (rows.length < want) {
    const res = await client.find<T>(path, {
      ...query,
      $skip: start + rows.length,
      $limit: Math.min(SERVER_PAGE, want - rows.length),
    });
    total = res.total ?? rows.length;
    rows.push(...res.data);
    if (res.data.length === 0) break;
    // A service registered with `paginate: false` answers the same array every
    // time; without this a request for 200 rows would loop on the same 50.
    if (res.limit === res.total && res.skip === 0) break;
    if (start + rows.length >= total) break;
  }

  const withheld = Math.max(0, total - (start + rows.length));
  return {
    total,
    returned: rows.length,
    skip: start,
    rows,
    // Deliberately actionable: a bare `total: 812, returned: 50` reads to a model
    // as a complete answer often enough to matter.
    ...(withheld > 0
      ? { note: `${withheld} more exist — pass \`skip: ${start + rows.length}\` for the next page.` }
      : {}),
  };
}

/**
 * A page of rows matching a predicate the SERVER can't express.
 *
 * Some filters have no query field behind them — a scene's `3d`-ness lives on its
 * active layer, not on the scene document — so the only way to honour them is to
 * walk pages and test rows here. That is a scan, and it is reported as one:
 * `scanned` says how far we got and `total` stays the server's unfiltered count,
 * because a filtered total would require reading the entire collection and would
 * be a lie the moment `scanLimitReached` is set.
 *
 * `maxScan` bounds it so a filter that matches nothing costs a known number of
 * requests rather than walking a 20,000-row campaign to the end.
 */
export interface ScanPage<T> extends Page<T> {
  scanned: number;
  scanLimitReached?: true;
}

export async function scanPage<T extends Json = Json>(
  client: RealmClient,
  path: string,
  query: Query,
  predicate: (row: T) => boolean,
  limit?: number,
  skip?: number,
  maxScan = 2000,
): Promise<ScanPage<T>> {
  const want = limit ?? DEFAULT_PAGE_LIMIT;
  const start = Math.max(0, skip ?? 0);

  const kept: T[] = [];
  let scanned = 0;
  let matched = 0;
  let total = 0;
  let exhausted = false;

  while (kept.length < want && scanned < maxScan) {
    const res = await client.find<T>(path, {
      ...query,
      $skip: scanned,
      $limit: SERVER_PAGE,
    });
    total = res.total ?? total;
    if (res.data.length === 0) {
      exhausted = true;
      break;
    }
    scanned += res.data.length;
    for (const row of res.data) {
      if (!predicate(row)) continue;
      matched += 1;
      // `skip` counts MATCHES, not scanned rows — otherwise page 2 of a filtered
      // list would start at an arbitrary point in the unfiltered collection.
      if (matched > start && kept.length < want) kept.push(row);
    }
    if (res.limit === res.total && res.skip === 0) {
      exhausted = true;
      break;
    }
    if (scanned >= total) {
      exhausted = true;
      break;
    }
  }

  const hitLimit = !exhausted && kept.length < want;
  return {
    total,
    returned: kept.length,
    skip: start,
    rows: kept,
    scanned,
    ...(hitLimit ? { scanLimitReached: true as const } : {}),
    ...(kept.length === want
      ? { note: `More may match — pass \`skip: ${start + kept.length}\` for the next page.` }
      : {}),
    ...(hitLimit
      ? {
          note:
            `Stopped after scanning ${scanned} of ${total} rows. This filter has no server-side ` +
            `query behind it, so it is applied row by row — narrow the search, or raise \`skip\`.`,
        }
      : {}),
  };
}

/**
 * A page as a tool result: the envelope fields, then the rows under the name the
 * tool calls them (`images`, `scenes`, `journals`, …). Keeping the row key
 * tool-specific reads better than a generic `rows`, while the envelope stays
 * identical across every tool.
 */
export function pageResult<T, U>(
  page: Page<T> | ScanPage<T>,
  key: string,
  map: (row: T) => U,
): Json {
  const scan = page as ScanPage<T>;
  return {
    total: page.total,
    returned: page.returned,
    skip: page.skip,
    ...(scan.scanned !== undefined ? { scanned: scan.scanned } : {}),
    ...(scan.scanLimitReached ? { scanLimitReached: true } : {}),
    ...(page.note ? { note: page.note } : {}),
    [key]: page.rows.map(map),
  };
}

/**
 * Where a document came from and who can see it.
 *
 * `moduleId` is the load-bearing one: a document carrying it was installed from a
 * module rather than authored in this campaign, which means editing it is usually
 * a mistake (the module owns it) and deleting it is reversible only by reinstalling.
 * Every audit and cleanup question starts with "is this mine?", so it belongs in
 * the summary rather than behind a full fetch.
 */
export interface Provenance extends Json {
  source: "module" | "campaign";
  moduleId?: string;
  shared?: boolean;
  locked?: boolean;
}

export function provenanceOf(doc: Json): Provenance {
  const moduleId = doc.moduleId ? String(doc.moduleId) : undefined;
  return {
    source: moduleId ? "module" : "campaign",
    ...(moduleId ? { moduleId } : {}),
    ...(doc.shared !== undefined ? { shared: Boolean(doc.shared) } : {}),
    ...(doc.locked ? { locked: true } : {}),
  };
}

/**
 * Resolves `folderId` → readable breadcrumb for one list's folder tree.
 *
 * A summary that reports a bare 24-hex `folderId` tells a model nothing it can
 * act on, and makes it fetch the folder tree separately to find out. Fetching the
 * tree once per list call and decorating in place costs one request and removes
 * the round trip entirely.
 *
 * An id pointing at a folder that no longer exists resolves to `"(missing)"`
 * rather than being dropped: the backend does not validate `folderId` on items
 * (see folders.ts), so a dangling one is a real state that renders the item
 * invisible in the app, and hiding it here would hide the bug.
 */
export interface FolderIndex {
  /** Breadcrumb by folder id. */
  paths: Record<string, string>;
  /** The `{ folderId, folderPath }` fields to spread into a summary. */
  decorate(doc: Json): Json;
  /** Ids that exist in the tree, for orphan checks. */
  ids: Set<string>;
}

export const MISSING_FOLDER = "(missing)";

export function folderIndexFrom(folders: Array<Json & { _id: string }>): FolderIndex {
  const paths = folderPathsById(
    folders.map((f) => ({ ...f, _id: String(f._id), name: String(f.name ?? "") })),
  );
  const ids = new Set(Object.keys(paths));
  return {
    paths,
    ids,
    decorate(doc: Json): Json {
      if (!doc.folderId) return {};
      const id = String(doc.folderId);
      return { folderId: id, folderPath: paths[id] ?? MISSING_FOLDER };
    },
  };
}

/** Fetch and index the folder tree for one list (`images`, `scenes`, `spells`, …). */
export async function loadFolderIndex(
  client: RealmClient,
  campaignId: string,
  type: string,
): Promise<FolderIndex> {
  const scope = folderScopeFor(type);
  const query: Query = { campaignId, type: scope.folderType };
  if (scope.recordType) query.recordType = scope.recordType;
  const folders = await client.findAll<Json & { _id: string }>("/folders", query);
  return folderIndexFrom(folders);
}

/**
 * A folder index that never fails a list call.
 *
 * Listing images is not a folder operation, and a folder tree that 403s or is
 * simply empty should degrade to "no folder shown" rather than turning a working
 * inventory into an error.
 */
export async function tryLoadFolderIndex(
  client: RealmClient,
  campaignId: string,
  type: string,
): Promise<FolderIndex> {
  try {
    return await loadFolderIndex(client, campaignId, type);
  } catch {
    return folderIndexFrom([]);
  }
}

/**
 * Add `$search` only when there is something to search for.
 *
 * `$search: ""` is not an empty filter — Realm's search hook builds a Mongo
 * `$regex`/text stage from it and answers 500, which is why "list every image"
 * was previously impossible to express. Callers pass the raw optional string and
 * this decides.
 */
export function withSearch(query: Query, search?: string): Query {
  const needle = search?.trim();
  if (needle) query.$search = needle;
  return query;
}

/** Case-insensitive substring match, for filtering rows the API can't filter for us. */
export function matchesName(doc: Json, needle?: string): boolean {
  const trimmed = needle?.trim().toLowerCase();
  if (!trimmed) return true;
  return String(doc.name ?? "").toLowerCase().includes(trimmed);
}
