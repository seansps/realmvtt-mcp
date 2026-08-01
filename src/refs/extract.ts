/**
 * Finding every reference one piece of campaign content makes to another.
 *
 * This is the substrate under backlinks, the dependency graph, link validation
 * and the audit — all four are the same question ("what points at what?") asked
 * from different ends, so they share one extractor rather than four half-agreeing
 * ones.
 *
 * ── Everything here is PURE ───────────────────────────────────────────────────
 * These functions take documents and return references. Nothing fetches, so the
 * hard parts (entity-escaped JSON in an HTML attribute, a portrait that is a path
 * rather than an id) are testable without a backend, and the tools decide how
 * much of a campaign to feed in.
 *
 * ── References are not all the same shape ─────────────────────────────────────
 * Realm points at things three different ways, and conflating them loses
 * information a cleanup needs:
 *   - by ID     — a `<record-link>`, a table cell link, an encounter's npcId
 *   - by PATH   — a portrait, a token image, a 2D scene's background: these store
 *                 a CDN-relative string, not the id of the image library row
 *   - by ASSET  — a 3D placement's `assetId`, naming a catalog entry or a `cust-`
 *                 upload rather than any campaign document
 * A path reference can only be tied back to an image record by looking the path
 * up, which is why `ReferenceIndex` carries a path→id map instead of pretending
 * the extractor can resolve it.
 */
import type { Json } from "../api/client.js";

/** The kinds of document that can HOLD a reference. */
export type SourceKind =
  | "journal-page"
  | "record"
  | "scene"
  | "table"
  | "encounter"
  | "scene-object";

/**
 * What a reference points at. The first group are campaign documents addressed by
 * id; `image-path` and `model-path` are addressed by CDN path; `asset-3d` names a
 * catalog or custom asset that is not a campaign document at all.
 */
export type TargetKind =
  | "scenes"
  | "journals"
  | "npcs"
  | "characters"
  | "records"
  | "tables"
  | "encounters"
  | "effects"
  | "decks"
  | "images"
  | "sounds"
  | "image-path"
  | "model-path"
  | "asset-3d";

/** How the reference is written down — the field or markup carrying it. */
export type RefVia =
  | "record-link"
  | "img-tag"
  | "portrait"
  | "token-image"
  | "token-model"
  | "scene-background"
  | "table-cell"
  | "encounter-npc"
  | "object-asset"
  | "default-pin"
  | "teleporter";

export interface RefSource {
  kind: SourceKind;
  id: string;
  name?: string;
  /** The service the source lives on, so a repair knows where to PATCH. */
  service?: string;
  /** For a journal page: the journal it belongs to. */
  parentId?: string;
  parentName?: string;
}

export interface RefTarget {
  kind: TargetKind;
  /** Set for id-addressed targets. */
  id?: string;
  /** Set for path-addressed targets (`/images/abc_map.png`) and asset ids. */
  path?: string;
  /** Narrows a `records` target to its ruleset type. */
  recordType?: string;
  /** The link's own copy of the target's name, which may be STALE. */
  label?: string;
}

export interface Reference {
  from: RefSource;
  to: RefTarget;
  via: RefVia;
  /** Where inside the source, precisely enough to repair it (`row 3, column 2`). */
  at?: string;
}

// ── journal page HTML ────────────────────────────────────────────────────────

/**
 * Undo the entity escaping the link markup applies.
 *
 * ORDER MATTERS and is the reverse of the escape: `&` was escaped first, so it
 * must be unescaped LAST. Doing it first would turn a literal `&amp;quot;` (an
 * ampersand followed by the text "quot;") into `&quot;` and then into a stray
 * quote, corrupting the JSON of any link whose target name contains an escaped
 * entity.
 */
export function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The payload a `<record-link>` stores, as written by `journalRecordLinkHtml`. */
export interface RecordLinkPayload extends Json {
  type?: string;
  tooltip?: string;
  icon?: string;
  value?: { _id?: string; name?: string; recordType?: string; pageNumber?: number } & Json;
}

export interface ParsedRecordLink {
  payload: RecordLinkPayload;
  /** The exact `<record-link …></record-link>` text, so a rewrite can replace it. */
  html: string;
  /** The raw attribute value, still escaped. */
  raw: string;
}

/**
 * Every `<record-link>` in a page, with its decoded payload.
 *
 * Malformed links are SKIPPED rather than thrown on: one hand-edited page with
 * broken JSON should not make a whole campaign's link report fail, and
 * `parseRecordLinks` is the first thing every reference tool calls. The audit
 * finds them separately by comparing this count against the raw tag count.
 */
export function parseRecordLinks(html: string): ParsedRecordLink[] {
  const out: ParsedRecordLink[] = [];
  const re = /<record-link\b[^>]*\brecordlink="([^"]*)"[^>]*>(?:<\/record-link>)?/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1] ?? "";
    try {
      const payload = JSON.parse(unescapeAttr(raw)) as RecordLinkPayload;
      out.push({ payload, html: m[0], raw });
    } catch {
      // Left to `countRecordLinkTags` to report as malformed.
    }
  }
  return out;
}

/** How many `<record-link>` tags exist at all, parseable or not. */
export function countRecordLinkTags(html: string): number {
  return [...html.matchAll(/<record-link\b/gi)].length;
}

export interface ParsedImg {
  src: string;
  /** The image RECORD id, which the app writes into `id` on an embed. */
  imageId?: string;
  html: string;
}

/** Every `<img>` in a page, with the image-record id when the embed carries one. */
export function parseImgTags(html: string): ParsedImg[] {
  const out: ParsedImg[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
    if (!src) continue;
    const id = /\bid="([^"]*)"/i.exec(tag)?.[1];
    out.push({ src: unescapeAttr(src), ...(id ? { imageId: id } : {}), html: tag });
  }
  return out;
}

/**
 * A CDN url reduced to the stored path an image record holds.
 *
 * Journal markup embeds the absolute url while every other reference stores the
 * relative path, so without this the same image looks like two different targets
 * and an "unused image" check reports pictures that are plainly on the page.
 */
export function storedPathOf(url: string): string {
  const withoutHost = url.replace(/^https?:\/\/[^/]+/i, "");
  return withoutHost.startsWith("/") ? withoutHost : `/${withoutHost}`;
}

/** References made by one journal page's HTML content. */
export function refsFromJournalPage(
  page: Json,
  journal?: { _id?: unknown; name?: unknown },
): Reference[] {
  const html = typeof page.content === "string" ? page.content : "";
  const from: RefSource = {
    kind: "journal-page",
    id: String(page._id ?? ""),
    name: page.name ? String(page.name) : undefined,
    service: "/journal-pages",
    ...(journal?._id ? { parentId: String(journal._id) } : {}),
    ...(journal?.name ? { parentName: String(journal.name) } : {}),
  };

  const refs: Reference[] = [];

  for (const link of parseRecordLinks(html)) {
    const type = link.payload.type;
    const id = link.payload.value?._id;
    if (!type || !id) continue;
    refs.push({
      from,
      to: {
        kind: type as TargetKind,
        id: String(id),
        ...(link.payload.value?.recordType
          ? { recordType: String(link.payload.value.recordType) }
          : {}),
        ...(link.payload.value?.name ? { label: String(link.payload.value.name) } : {}),
      },
      via: "record-link",
    });
  }

  for (const img of parseImgTags(html)) {
    refs.push({
      from,
      to: {
        kind: img.imageId ? "images" : "image-path",
        ...(img.imageId ? { id: img.imageId } : {}),
        path: storedPathOf(img.src),
      },
      via: "img-tag",
    });
  }

  return refs;
}

// ── records ──────────────────────────────────────────────────────────────────

/**
 * A record's art: portrait, 2D token image, 3D mini.
 *
 * All three are stored as PATHS, not as ids of image-library rows — a portrait is
 * `/images/abc_map.png`, and nothing on the record says which library entry that
 * came from (or whether one exists at all). They are emitted as `image-path` /
 * `model-path` targets and resolved later against the library.
 */
export function refsFromRecord(record: Json, service = "/records"): Reference[] {
  const from: RefSource = {
    kind: "record",
    id: String(record._id ?? ""),
    name: record.name ? String(record.name) : undefined,
    service,
  };
  const refs: Reference[] = [];

  if (typeof record.portrait === "string" && record.portrait) {
    refs.push({ from, to: { kind: "image-path", path: storedPathOf(record.portrait) }, via: "portrait" });
  }

  const token = record.token as Json | undefined;
  if (typeof token?.imageUrl === "string" && token.imageUrl) {
    refs.push({
      from,
      to: { kind: "image-path", path: storedPathOf(token.imageUrl) },
      via: "token-image",
    });
  }

  const model = token?.model3D as Json | undefined;
  if (typeof model?.url === "string" && model.url) {
    refs.push({
      from,
      to: { kind: "model-path", path: storedPathOf(model.url) },
      via: "token-model",
    });
  }
  // `catalogId` means the mini was picked from Realm's catalog. It is a separate
  // reference from the url: the url can be fine while the catalog entry is gone.
  if (typeof model?.catalogId === "string" && model.catalogId) {
    refs.push({
      from,
      to: { kind: "asset-3d", path: String(model.catalogId) },
      via: "token-model",
    });
  }

  return refs;
}

// ── scenes ───────────────────────────────────────────────────────────────────

/**
 * What a scene points at: its background image per layer, plus the intra-scene
 * pointers that can dangle (`defaultPinId`, a teleporter's destination).
 *
 * Teleporter destinations are emitted even though they reference a marker rather
 * than a document, because a teleporter aimed at a deleted pad is exactly the
 * "bad pin" class of breakage the audit is asked about, and nothing else in the
 * campaign would ever notice it.
 */
export function refsFromScene(scene: Json): Reference[] {
  const from: RefSource = {
    kind: "scene",
    id: String(scene._id ?? ""),
    name: scene.name ? String(scene.name) : undefined,
    service: "/scenes",
  };
  const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
  const refs: Reference[] = [];

  layers.forEach((layer, index) => {
    const at = layers.length > 1 ? `layer ${index}` : undefined;
    if (typeof layer.url === "string" && layer.url) {
      refs.push({
        from,
        to: { kind: "image-path", path: storedPathOf(layer.url) },
        via: "scene-background",
        ...(at ? { at } : {}),
      });
    }

    const pins = Array.isArray(layer.pins) ? (layer.pins as Json[]) : [];
    const pinIds = new Set(pins.map((p) => String(p.id)));
    if (layer.defaultPinId && !pinIds.has(String(layer.defaultPinId))) {
      // Emitted only when BROKEN: a valid default pin is not a dependency anyone
      // needs to see, but a dangling one means the camera opens nowhere.
      refs.push({
        from,
        to: { kind: "scenes", id: String(scene._id ?? ""), label: String(layer.defaultPinId) },
        via: "default-pin",
        at: at ?? "layer 0",
      });
    }

    const teleporters = Array.isArray(layer.teleporters) ? (layer.teleporters as Json[]) : [];
    for (const t of teleporters) {
      const dest = t.destination as { layerIndex?: number; teleporterId?: string } | undefined;
      if (!dest?.teleporterId) continue;
      const targetLayer = layers[dest.layerIndex ?? index];
      const targetIds = new Set(
        (Array.isArray(targetLayer?.teleporters) ? (targetLayer.teleporters as Json[]) : []).map(
          (x) => String(x.id),
        ),
      );
      if (targetIds.has(String(dest.teleporterId))) continue;
      refs.push({
        from,
        to: { kind: "scenes", id: String(scene._id ?? ""), label: String(dest.teleporterId) },
        via: "teleporter",
        at: `teleporter ${t.name ? String(t.name) : String(t.id)}`,
      });
    }
  });

  return refs;
}

// ── tables and encounters ────────────────────────────────────────────────────

/** Links carried by a roll table's cells (`row.columns[].recordLink`). */
export function refsFromTable(table: Json): Reference[] {
  const from: RefSource = {
    kind: "table",
    id: String(table._id ?? ""),
    name: table.name ? String(table.name) : undefined,
    service: "/tables",
  };
  const rows = Array.isArray(table.rows) ? (table.rows as Json[]) : [];
  const refs: Reference[] = [];

  rows.forEach((row, ri) => {
    const columns = Array.isArray(row.columns) ? (row.columns as Json[]) : [];
    columns.forEach((cell, ci) => {
      const link = cell.recordLink as RecordLinkPayload | undefined;
      const id = link?.value?._id;
      if (!link?.type || !id) return;
      refs.push({
        from,
        to: {
          kind: link.type as TargetKind,
          id: String(id),
          ...(link.value?.recordType ? { recordType: String(link.value.recordType) } : {}),
          ...(link.value?.name ? { label: String(link.value.name) } : {}),
        },
        via: "table-cell",
        at: `row ${ri + 1}, column ${ci + 1}`,
      });
    });
  });

  return refs;
}

/** The NPCs an encounter will put on the tracker. */
export function refsFromEncounter(encounter: Json): Reference[] {
  const from: RefSource = {
    kind: "encounter",
    id: String(encounter._id ?? ""),
    name: encounter.name ? String(encounter.name) : undefined,
    service: "/encounters",
  };
  const npcs = Array.isArray(encounter.npcs) ? (encounter.npcs as Json[]) : [];
  return npcs
    .filter((n) => n.npcId)
    .map((n) => ({
      from,
      to: {
        kind: "npcs" as TargetKind,
        id: String(n.npcId),
        ...(n.name ? { label: String(n.name) } : {}),
      },
      via: "encounter-npc" as RefVia,
      ...(n.name ? { at: String(n.name) } : {}),
    }));
}

/**
 * The 3D assets a scene's placed objects use.
 *
 * Deduplicated by assetId: a town is thousands of placements drawing on a few
 * dozen assets, and one row per placement would bury the answer to "what does
 * this scene depend on" under its own noise. `count` keeps the scale visible.
 */
export function refsFromSceneObjects(
  sceneId: string,
  sceneName: string | undefined,
  objects: Json[],
): Array<Reference & { count: number }> {
  const from: RefSource = {
    kind: "scene-object",
    id: sceneId,
    name: sceneName,
    service: "/scene-objects-3d",
  };
  const counts = new Map<string, number>();
  for (const o of objects) {
    if (!o.assetId) continue;
    const id = String(o.assetId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([assetId, count]) => ({
    from,
    to: { kind: "asset-3d" as TargetKind, path: assetId },
    via: "object-asset" as RefVia,
    count,
  }));
}
