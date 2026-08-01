/**
 * Building a campaign's reference graph, and answering questions with it.
 *
 * The extractor (`extract.ts`) is pure and per-document; this is the part that
 * decides HOW MUCH of a campaign to read, which is the whole cost of every tool
 * built on top. The rules it follows:
 *
 *   - Fetch each collection ONCE. Backlinks, validation and the audit all want
 *     the same journal pages; reading them per question would multiply an already
 *     expensive scan by the number of checks.
 *   - Journal page CONTENT is the expensive part — one request per page, because
 *     the outline endpoint deliberately omits HTML. Everything else is a handful
 *     of list calls. So page fetching is bounded and reports what it skipped.
 *   - 3D scene objects are NOT read by default. A single built town is thousands
 *     of rows, and only the asset-dependency question needs them.
 *
 * Nothing here deletes or repairs anything. Freeing storage correctly is the
 * backend's job (see images.ts), so an orphan is something this reports, never
 * something it cleans.
 */
import type { Json, RealmClient } from "../api/client.js";
import {
  countRecordLinkTags,
  refsFromEncounter,
  refsFromJournalPage,
  refsFromRecord,
  refsFromScene,
  refsFromSceneObjects,
  refsFromTable,
  storedPathOf,
  type Reference,
  type TargetKind,
} from "./extract.js";

/** How many journal pages to read the HTML of before giving up. */
export const DEFAULT_PAGE_BUDGET = 400;

export interface IndexOptions {
  /** Cap on journal pages whose content is fetched. */
  pageBudget?: number;
  /** Also read `scene-objects-3d` for every 3D scene. Expensive; off by default. */
  include3dObjects?: boolean;
  /** Ruleset record types to include beyond npcs/characters/tables. */
  recordTypes?: string[];
}

export interface IndexedDoc {
  id: string;
  name: string;
  kind: TargetKind;
  service: string;
  folderId?: string;
  moduleId?: string;
}

export interface ReferenceIndex {
  campaignId: string;
  refs: Reference[];
  /** Every document that can be REFERRED to, by id. */
  docs: Map<string, IndexedDoc>;
  /** Stored image path → image record id, for resolving path-addressed art. */
  imagePathToId: Map<string, string>;
  /** Image records by id. */
  images: Map<string, Json>;
  /** Journal pages whose HTML we read, by page id. */
  pages: Map<string, Json>;
  /** Pages that exist but whose content was not fetched, because of the budget. */
  pagesSkipped: number;
  /** Pages whose content fetch failed outright — their links are invisible here. */
  pagesFailed: number;
  /** Pages containing at least one `<record-link>` we could not parse. */
  malformedLinkPages: Array<{ pageId: string; pageName?: string; tags: number; parsed: number }>;
  /** Asset ids referenced by 3D placements, when `include3dObjects` was set. */
  assetRefs: Array<Reference & { count: number }>;
  notes: string[];
}

/** Everything a campaign holds that a link could point at. */
async function loadDocs(
  client: RealmClient,
  campaignId: string,
  recordTypes: string[],
): Promise<{ docs: Map<string, IndexedDoc>; raw: Map<string, Json[]> }> {
  const docs = new Map<string, IndexedDoc>();
  const raw = new Map<string, Json[]>();

  const collections: Array<{ kind: TargetKind; service: string; query?: Json }> = [
    { kind: "scenes", service: "/scenes" },
    { kind: "journals", service: "/journals" },
    { kind: "npcs", service: "/npcs" },
    { kind: "characters", service: "/characters" },
    { kind: "tables", service: "/tables" },
    { kind: "encounters", service: "/encounters" },
    { kind: "effects", service: "/effects" },
    { kind: "images", service: "/images" },
  ];

  for (const c of collections) {
    const rows = await client.findAll<Json>(c.service, { campaignId });
    raw.set(c.kind, rows);
    for (const row of rows) {
      docs.set(String(row._id), {
        id: String(row._id),
        name: String(row.name ?? ""),
        kind: c.kind,
        service: c.service,
        ...(row.folderId ? { folderId: String(row.folderId) } : {}),
        ...(row.moduleId ? { moduleId: String(row.moduleId) } : {}),
      });
    }
  }

  // Ruleset-defined types all share /records and must be asked for by name; there
  // is no "give me every record type" query, so an unlisted type is simply not
  // indexed and links into it will read as unresolved. `recordTypes` is how a
  // caller widens that, and the tools surface it.
  const records: Json[] = [];
  for (const type of recordTypes) {
    const rows = await client.findAll<Json>("/records", { campaignId, recordType: type });
    records.push(...rows);
    for (const row of rows) {
      docs.set(String(row._id), {
        id: String(row._id),
        name: String(row.name ?? ""),
        kind: "records",
        service: "/records",
        ...(row.folderId ? { folderId: String(row.folderId) } : {}),
        ...(row.moduleId ? { moduleId: String(row.moduleId) } : {}),
      });
    }
  }
  raw.set("records", records);

  return { docs, raw };
}

/**
 * Read a campaign and extract every reference in it.
 *
 * The page budget is a real limit, not a formality: a large campaign can hold
 * more journal pages than is sensible to fetch one at a time, and a tool that
 * quietly read half of them would report "no backlinks" for content that is
 * plainly linked. `pagesSkipped` is non-zero exactly when the answer is partial,
 * and every tool built on this says so in its output.
 */
export async function buildReferenceIndex(
  client: RealmClient,
  campaignId: string,
  opts: IndexOptions = {},
): Promise<ReferenceIndex> {
  const pageBudget = opts.pageBudget ?? DEFAULT_PAGE_BUDGET;
  const recordTypes = opts.recordTypes ?? [];
  const notes: string[] = [];

  const { docs, raw } = await loadDocs(client, campaignId, recordTypes);
  const refs: Reference[] = [];

  const images = new Map<string, Json>();
  const imagePathToId = new Map<string, string>();
  for (const img of raw.get("images") ?? []) {
    images.set(String(img._id), img);
    if (typeof img.url === "string") imagePathToId.set(storedPathOf(img.url), String(img._id));
  }

  for (const scene of raw.get("scenes") ?? []) refs.push(...refsFromScene(scene));
  for (const table of raw.get("tables") ?? []) refs.push(...refsFromTable(table));
  for (const enc of raw.get("encounters") ?? []) refs.push(...refsFromEncounter(enc));
  for (const npc of raw.get("npcs") ?? []) refs.push(...refsFromRecord(npc, "/npcs"));
  for (const pc of raw.get("characters") ?? []) refs.push(...refsFromRecord(pc, "/characters"));
  for (const rec of raw.get("records") ?? []) refs.push(...refsFromRecord(rec, "/records"));

  // ── journal pages ──────────────────────────────────────────────────────────
  const pages = new Map<string, Json>();
  const malformedLinkPages: ReferenceIndex["malformedLinkPages"] = [];
  let pagesSkipped = 0;
  let pagesFailed = 0;

  for (const journal of raw.get("journals") ?? []) {
    const outline = await client
      .journalPages<{ data?: Json[] } | Json[]>(String(journal._id))
      .catch(() => null);
    const list = Array.isArray(outline)
      ? outline
      : Array.isArray((outline as { data?: Json[] })?.data)
        ? (outline as { data: Json[] }).data
        : [];

    for (const stub of list) {
      if (pages.size >= pageBudget) {
        pagesSkipped += 1;
        continue;
      }
      // The outline's entries are keyed `id`, NOT `_id` — it is a custom method
      // shaping its own response, not a Feathers document listing. Reading `_id`
      // here yields undefined, turns every page fetch into a 404, and (because a
      // failed fetch is skipped) reports a campaign with no journal content at
      // all rather than an error.
      const pageId = String(stub.id ?? stub._id ?? "");
      if (!pageId || pageId === "undefined") continue;

      // The outline omits HTML by design, so content costs one GET per page.
      // This is the only per-document fetch in the whole index.
      const page = await client.get<Json>("/journal-pages", pageId).catch(() => null);
      if (!page) {
        pagesFailed += 1;
        continue;
      }
      pages.set(String(page._id ?? pageId), page);

      const pageRefs = refsFromJournalPage(page, journal);
      refs.push(...pageRefs);

      const html = typeof page.content === "string" ? page.content : "";
      const tags = countRecordLinkTags(html);
      const parsed = pageRefs.filter((r) => r.via === "record-link").length;
      if (tags > parsed) {
        malformedLinkPages.push({
          pageId: String(page._id),
          pageName: page.name ? String(page.name) : undefined,
          tags,
          parsed,
        });
      }
    }
  }

  if (pagesFailed > 0) {
    // Loudly, because a silently-skipped page reads as "nothing links here".
    notes.push(
      `${pagesFailed} journal pages could not be fetched and were not scanned. Any link on them ` +
        `is invisible to this result.`,
    );
  }
  if (pagesSkipped > 0) {
    notes.push(
      `${pagesSkipped} journal pages were not read (budget ${pageBudget}). Results are partial — ` +
        `raise \`pageBudget\` or narrow the campaign scope for a complete answer.`,
    );
  }
  if (recordTypes.length === 0) {
    notes.push(
      "No ruleset record types were indexed, so links into items/spells/feats resolve as unknown " +
        "rather than valid. Pass `recordTypes` to include them.",
    );
  }

  // ── 3D placements ──────────────────────────────────────────────────────────
  const assetRefs: ReferenceIndex["assetRefs"] = [];
  if (opts.include3dObjects) {
    for (const scene of raw.get("scenes") ?? []) {
      const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
      const layer = layers[typeof scene.activeLayer === "number" ? scene.activeLayer : 0] ?? layers[0];
      if (layer?.sceneType !== "3d") continue;
      const objects = await client
        .sceneObjects3d<Json>(String(scene._id), campaignId)
        .catch(() => [] as Json[]);
      assetRefs.push(
        ...refsFromSceneObjects(
          String(scene._id),
          scene.name ? String(scene.name) : undefined,
          objects,
        ),
      );
    }
  }

  return {
    campaignId,
    refs,
    docs,
    imagePathToId,
    images,
    pages,
    pagesSkipped,
    pagesFailed,
    malformedLinkPages,
    assetRefs,
    notes,
  };
}

// ── queries over the index ───────────────────────────────────────────────────

/**
 * Resolve a reference to the campaign document it lands on.
 *
 * Path-addressed references (`image-path`) are looked up in the image library, so
 * a portrait and a journal embed of the same picture answer with the same image
 * record — which is what makes "what uses this image?" a question with one answer
 * rather than two half-answers.
 */
export function resolveTargetId(index: ReferenceIndex, ref: Reference): string | undefined {
  if (ref.to.id) return ref.to.id;
  if (ref.to.kind === "image-path" && ref.to.path) return index.imagePathToId.get(ref.to.path);
  return undefined;
}

export interface Backlink {
  from: Reference["from"];
  via: Reference["via"];
  at?: string;
  /** The name the LINK carries, when it disagrees with the target's real name. */
  staleLabel?: string;
}

/**
 * Everything that points at one target.
 *
 * `target` may be a document id or a stored image path — both are accepted
 * because the two are the same question asked about the same picture, and a
 * caller holding a path from a scene layer should not have to resolve it first.
 */
export function backlinksTo(index: ReferenceIndex, target: string): Backlink[] {
  const byPath = index.imagePathToId.get(storedPathOf(target));
  const wanted = byPath ?? target;
  const doc = index.docs.get(wanted);

  const out: Backlink[] = [];
  for (const ref of index.refs) {
    const resolved = resolveTargetId(index, ref);
    const hit = resolved === wanted || (ref.to.path !== undefined && ref.to.path === target);
    if (!hit) continue;
    // A link stores a copy of the target's name; when the target has since been
    // renamed the page still shows the old one, which is worth reporting because
    // nothing in the app ever corrects it.
    const staleLabel =
      doc && ref.to.label && ref.to.label !== doc.name ? ref.to.label : undefined;
    out.push({
      from: ref.from,
      via: ref.via,
      ...(ref.at ? { at: ref.at } : {}),
      ...(staleLabel ? { staleLabel } : {}),
    });
  }
  return out;
}

export type LinkProblem =
  | "missing-target"
  | "image-not-in-library"
  | "stale-label"
  | "malformed-link"
  | "broken-marker";

export interface BrokenLink {
  problem: LinkProblem;
  from: Reference["from"];
  via: Reference["via"];
  at?: string;
  target: { kind: TargetKind; id?: string; path?: string; label?: string };
  detail: string;
}

/**
 * Every reference that does not land on something.
 *
 * A reference into a record type that was never indexed is NOT reported as
 * broken — that would turn "I didn't look" into "it's missing", which is the
 * worst possible answer for a tool whose output drives deletions. Those are
 * counted separately and surfaced as an unchecked count.
 */
export function findBrokenLinks(
  index: ReferenceIndex,
  indexedRecordTypes: string[],
): { broken: BrokenLink[]; unchecked: number } {
  const broken: BrokenLink[] = [];
  let unchecked = 0;
  const knownTypes = new Set(indexedRecordTypes);

  for (const ref of index.refs) {
    if (ref.via === "default-pin" || ref.via === "teleporter") {
      broken.push({
        problem: "broken-marker",
        from: ref.from,
        via: ref.via,
        ...(ref.at ? { at: ref.at } : {}),
        target: { kind: ref.to.kind, id: ref.to.id, label: ref.to.label },
        detail:
          ref.via === "default-pin"
            ? `The scene's default pin (${ref.to.label}) no longer exists, so the camera opens at the default framing instead.`
            : `Teleporter destination ${ref.to.label} no longer exists, so stepping on the pad does nothing.`,
      });
      continue;
    }

    if (ref.to.kind === "image-path" || ref.to.kind === "model-path") {
      // A model path points at the CDN, not at a campaign document, so there is
      // nothing here to verify — only images have a library row to match.
      if (ref.to.kind === "model-path") continue;
      if (ref.to.path && !index.imagePathToId.has(ref.to.path)) {
        // NOT breakage. Uploading a map through the app stores the file on the
        // CDN and puts the path on the scene; it does not necessarily add a row
        // to the image LIBRARY, which is a separately curated list. Measured on a
        // real campaign this fires for essentially every scene background — 193
        // findings out of 206 — so reporting it as a broken link buries the 12
        // that actually are. It matters only for export completeness, which is
        // why it is its own problem type and off by default.
        broken.push({
          problem: "image-not-in-library",
          from: ref.from,
          via: ref.via,
          ...(ref.at ? { at: ref.at } : {}),
          target: { kind: ref.to.kind, path: ref.to.path },
          detail:
            `Uses image path ${ref.to.path}, which has no row in the campaign's image library. ` +
            `The picture still displays — this is an EXPORT concern, not a broken link: a module ` +
            `built from this campaign may not carry the file.`,
        });
      }
      continue;
    }

    if (ref.to.kind === "asset-3d") continue;

    // A journal `<img>` renders from its `src`. If the image-library row it was
    // stamped with has since been deleted, the picture still displays — so this
    // is never a missing TARGET. What matters is whether the path is in the
    // library at all, which is the export question handled above.
    if (ref.via === "img-tag" && ref.to.path) {
      if (!index.imagePathToId.has(ref.to.path)) {
        broken.push({
          problem: "image-not-in-library",
          from: ref.from,
          via: ref.via,
          ...(ref.at ? { at: ref.at } : {}),
          target: { kind: "image-path", path: ref.to.path },
          detail:
            `Embeds ${ref.to.path}, which has no row in the campaign's image library. The image ` +
            `still displays — this is an EXPORT concern, not a broken link.`,
        });
      }
      continue;
    }

    if (!ref.to.id) continue;
    const doc = index.docs.get(ref.to.id);
    if (!doc) {
      if (ref.to.kind === "records" && !knownTypes.has(ref.to.recordType ?? "")) {
        unchecked += 1;
        continue;
      }
      // decks and sounds have no collection in the index yet; do not accuse them.
      if (ref.to.kind === "decks" || ref.to.kind === "sounds") {
        unchecked += 1;
        continue;
      }
      broken.push({
        problem: "missing-target",
        from: ref.from,
        via: ref.via,
        ...(ref.at ? { at: ref.at } : {}),
        target: { kind: ref.to.kind, id: ref.to.id, label: ref.to.label },
        detail: `Points at ${ref.to.kind} ${ref.to.id}${
          ref.to.label ? ` ("${ref.to.label}")` : ""
        }, which does not exist in this campaign.`,
      });
      continue;
    }

    if (ref.to.label && doc.name && ref.to.label !== doc.name) {
      broken.push({
        problem: "stale-label",
        from: ref.from,
        via: ref.via,
        ...(ref.at ? { at: ref.at } : {}),
        target: { kind: ref.to.kind, id: ref.to.id, label: ref.to.label },
        detail: `Displays "${ref.to.label}" but the target is now named "${doc.name}". The link still works; the visible text is stale.`,
      });
    }
  }

  for (const page of index.malformedLinkPages) {
    broken.push({
      problem: "malformed-link",
      from: { kind: "journal-page", id: page.pageId, name: page.pageName, service: "/journal-pages" },
      via: "record-link",
      target: { kind: "journals" },
      detail: `${page.tags - page.parsed} of ${page.tags} record links on this page could not be parsed — the stored JSON is corrupt and those chips will not render.`,
    });
  }

  return { broken, unchecked };
}

/** Images in the library that nothing references. */
export function unusedImages(index: ReferenceIndex): Array<{ id: string; name: string; path: string }> {
  const used = new Set<string>();
  for (const ref of index.refs) {
    const id = resolveTargetId(index, ref);
    if (id) used.add(id);
  }
  const out: Array<{ id: string; name: string; path: string }> = [];
  for (const [id, img] of index.images) {
    if (used.has(id)) continue;
    out.push({ id, name: String(img.name ?? ""), path: storedPathOf(String(img.url ?? "")) });
  }
  return out;
}
