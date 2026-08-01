/**
 * Pointing an existing link at a different record.
 *
 * ── Why this is not a string replace ──────────────────────────────────────────
 * A `<record-link>` does not merely hold an id. Its `recordlink` attribute is a
 * DENORMALIZED SNAPSHOT of the target — tooltip, display name, icon, recordType,
 * and for an NPC the token image and size that let the chip be dragged onto the
 * map as a correctly-sized token. Swapping the 24-hex id inside that JSON leaves
 * every one of those fields describing the OLD record: the page then renders the
 * old name, with the old icon, and drops the old token onto the table while
 * navigating to the new record. It looks like it worked, and it did not.
 *
 * So a retarget REBUILDS the node from the new record via the same
 * `journalRecordLinkHtml` the app's own drag produces, and only then splices it
 * into the HTML. The attribute is entity-escaped JSON, which is also why the
 * splice replaces the whole matched tag rather than editing inside it.
 */
import type { Json } from "../api/client.js";
import { journalRecordLinkHtml, type JournalLinkType } from "../tools/journals.js";
import { parseRecordLinks, type RecordLinkPayload } from "./extract.js";

export interface RetargetSpec {
  /** Only links pointing at this id are rewritten. */
  fromId: string;
  /** The id they should point at instead. */
  toId: string;
  /** The new target's name — the chip's visible text. */
  toName: string;
  /** The new target's full document, so the chip carries its art and size. */
  toRecord?: Json;
  /** Overrides the link's own type; defaults to keeping whatever it had. */
  toType?: JournalLinkType;
  toRecordType?: string;
}

export interface RetargetResult {
  html: string;
  /** How many links were rewritten. */
  replaced: number;
  /** Links that matched but whose payload could not be rebuilt, left untouched. */
  skipped: number;
}

/**
 * Rewrite every `<record-link>` in `html` that points at `spec.fromId`.
 *
 * Preserves what belongs to the LINK rather than to the target: a journals link
 * keeps its `pageNumber`, so retargeting a link that opens page 4 does not
 * silently send the reader to page 1. Everything else is taken from the new
 * record, because everything else describes the target.
 */
export function retargetRecordLinks(html: string, spec: RetargetSpec): RetargetResult {
  let out = html;
  let replaced = 0;
  let skipped = 0;

  for (const link of parseRecordLinks(html)) {
    const payload: RecordLinkPayload = link.payload;
    if (String(payload.value?._id ?? "") !== spec.fromId) continue;

    const type = (spec.toType ?? payload.type) as JournalLinkType | undefined;
    if (!type) {
      skipped += 1;
      continue;
    }

    const rebuilt = journalRecordLinkHtml({
      type,
      id: spec.toId,
      name: spec.toName,
      ...(spec.toRecord ? { record: spec.toRecord } : {}),
      ...(spec.toRecordType ? { recordType: spec.toRecordType } : {}),
      // A page number is a property of the LINK, not of what it points at.
      ...(type === "journals" && payload.value?.pageNumber
        ? { pageNumber: Number(payload.value.pageNumber) }
        : {}),
    });

    out = out.replace(link.html, rebuilt);
    replaced += 1;
  }

  return { html: out, replaced, skipped };
}

/**
 * Repoint the path-addressed art fields on a record (portrait, token image).
 *
 * Returns only the fields that actually change, so the caller can PATCH a minimal
 * body — patching a whole record round-trips fields it never meant to touch.
 */
export function retargetRecordPaths(
  record: Json,
  fromPath: string,
  toPath: string,
): Json | null {
  const patch: Json = {};
  const matches = (v: unknown) => typeof v === "string" && v.replace(/^https?:\/\/[^/]+/i, "") === fromPath;

  if (matches(record.portrait)) patch.portrait = toPath;

  const token = record.token as Json | undefined;
  if (token && matches(token.imageUrl)) {
    // `token` is a whole subdocument on the record; a patch of `{ token: {...} }`
    // REPLACES it, so the untouched keys have to be carried across or a retarget
    // would quietly drop the token's scale and 3D mini.
    patch.token = { ...token, imageUrl: toPath };
  }

  return Object.keys(patch).length ? patch : null;
}
