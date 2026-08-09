/**
 * Journals and their pages.
 *
 * Journal page CONTENT is an HTML string — not markdown, not a rich-text document
 * model. Reading the page list goes through a custom service method because the
 * plain REST find on /journal-pages can't be satisfied by a GM token.
 *
 * Embedding images is in `images.ts` (`realm_journal_image_html`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, Query, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";
import {
  fetchPage,
  pageArgs,
  pageResult,
  provenanceOf,
  tryLoadFolderIndex,
  withSearch,
} from "./listing.js";

/**
 * What a journal page can link to, and the service each type is fetched from.
 * `records` covers every ruleset-defined type (items, spells, …) and is narrowed
 * by `recordType` on the link itself.
 */
const LINK_SERVICES = {
  scenes: "/scenes",
  journals: "/journals",
  npcs: "/npcs",
  characters: "/characters",
  records: "/records",
  tables: "/tables",
  encounters: "/encounters",
  effects: "/effects",
  decks: "/decks",
} as const;

export type JournalLinkType = keyof typeof LINK_SERVICES;

export const JOURNAL_LINK_TYPES = Object.keys(LINK_SERVICES) as JournalLinkType[];

export interface JournalLinkInput {
  type: JournalLinkType;
  id: string;
  name: string;
  recordType?: string;
  /** Journals only: clicking the link opens this page. */
  pageNumber?: number;
  /**
   * Journals only: the page's own id. Written alongside `pageNumber`, which
   * older clients read. The id is what survives the journal being reordered,
   * and what lets the app report a deleted page instead of opening whichever
   * page inherited the number.
   */
  pageId?: string;
  /**
   * Chip icon, when the caller genuinely knows it — e.g. read off the ruleset's
   * record-type definition. Never guessed here; see `enrichLinkValue`.
   */
  icon?: string;
  /** The resolved document, if we have it — see `enrichLinkValue`. */
  record?: Json;
}

/** Services whose links carry a `recordType` inside `value`. */
const TYPED_LINKS = new Set<JournalLinkType>(["records", "npcs", "characters"]);

/**
 * Copy across the extra fields a dragged link carries, exactly the set
 * `sanitizeRecordLink` keeps — no more, since the point of the sanitizer is that
 * a link never embeds a whole record.
 *
 * These are not decoration. `token.imageUrl` and `data.size` are what let an NPC
 * chip be dragged out of the page and dropped onto the map as a correctly-sized
 * token; without them the drop falls back to a letter token.
 *
 * ICONS: only ever what we actually know. `scenes` is the one type whose icon is
 * fixed across every campaign (`IconMap`, what the Scenes panel puts in its own
 * drag payload). Every other type's icon is defined per-ruleset on the record
 * type, so a record that doesn't carry one is left without — the app falls back
 * to the ruleset's icon at render time anyway. We do NOT keep a record-type →
 * icon table here: it would be a guess that silently disagrees with whatever
 * ruleset the campaign is actually on.
 */
function enrichLinkValue(value: Json, type: JournalLinkType, record: Json): void {
  const data = record.data as Json | undefined;
  const token = record.token as Json | undefined;

  if (TYPED_LINKS.has(type) && record.recordType) value.recordType = record.recordType;
  if (record.icon) value.icon = record.icon;
  if (record.portrait) value.portrait = record.portrait;
  if (data?.size) value.data = { size: data.size };
  if (token?.imageUrl) {
    value.token = {
      imageUrl: token.imageUrl,
      scaleX: token.scaleX ?? 1,
      scaleY: token.scaleY ?? 1,
    };
  }
}

/** HTML-attribute escaping, matching the bulk journal importer's. */
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The `<record-link>` markup a journal page stores for an inline link.
 *
 * The app writes these by dragging a record into the page; the TipTap node keeps
 * the whole link as JSON in a `recordlink` attribute, already stripped by
 * `sanitizeRecordLink` to just what display and navigation need. We build that
 * stripped form directly.
 *
 * Byte-for-byte the shape the bulk journal importer writes — a double-quoted
 * attribute holding entity-escaped JSON. Escaping `&` is the part that matters:
 * unescaped, a name containing `&` plus letters is decoded as an entity by the
 * HTML parser and the JSON no longer parses.
 *
 * When there IS an icon it appears at BOTH levels, as it does in stored pages:
 * the chip renders the top-level `icon`, and `value.icon` is what survives if the
 * link is dragged back out and re-sanitized. `scenes` is the only type given one
 * unconditionally — every other icon is per-ruleset, so it comes from the record
 * or the caller, or not at all.
 *
 * Key order matches stored pages too (type, tooltip, icon, value) — irrelevant
 * to any parser, but it keeps a generated page diffable against a hand-made one.
 */
export function journalRecordLinkHtml(link: JournalLinkInput): string {
  const value: Json = { _id: link.id, name: link.name };
  if (link.record) enrichLinkValue(value, link.type, link.record);
  // An explicit recordType wins: it is how the caller narrows /records.
  if (TYPED_LINKS.has(link.type) && link.recordType) value.recordType = link.recordType;
  if (link.type === "journals" && link.pageNumber) value.pageNumber = link.pageNumber;
  if (link.type === "journals" && link.pageId) value.pageId = link.pageId;
  // A caller-supplied icon beats the record's; scenes are fixed regardless.
  if (link.icon) value.icon = link.icon;
  if (link.type === "scenes") value.icon = "IconMap";

  const payload: Json = { type: link.type, tooltip: link.name };
  if (value.icon) payload.icon = value.icon;
  payload.value = value;

  return `<record-link recordlink="${escapeAttr(JSON.stringify(payload))}"></record-link>`;
}

/** Resolve a link target given either its id or its name. */
async function resolveLinkTarget(
  client: RealmClient,
  campaignId: string,
  type: JournalLinkType,
  target: string,
  recordType?: string,
): Promise<Json> {
  const path = LINK_SERVICES[type];

  // An id is the cheap path, but a name that happens to look like one must
  // still resolve, so a failed get falls through to the search.
  if (/^[a-f0-9]{24}$/i.test(target)) {
    const byId = await client.get<Json>(path, target).catch(() => null);
    if (byId) return byId;
  }

  const query: Query = { campaignId, $search: target };
  if (type === "records" && recordType) query.recordType = recordType;
  const matches = await client.findAll<Json>(path, query);

  const exact = matches.filter((m) => String(m.name ?? "").toLowerCase() === target.toLowerCase());
  const pool = exact.length ? exact : matches;

  if (pool.length > 1) {
    const names = pool.slice(0, 8).map((m) => `${m.name} (${m._id})`);
    throw new Error(
      `"${target}" matches ${pool.length} ${type}: ${names.join(", ")}. Pass the id instead.`,
    );
  }

  const [only] = pool;
  if (!only) throw new Error(`No ${type} named "${target}" in this campaign.`);
  return only;
}

export function registerJournalTools(server: McpServer): void {
  server.registerTool(
    "realm_find_journals",
    {
      title: "Find journals",
      description:
        "List or search the campaign's journals (the containers that hold pages). Reports each " +
        "journal's folder and provenance, and pages with `limit`/`skip`.",
      inputSchema: {
        name: z.string().optional().describe("Exact name match."),
        search: z.string().optional().describe("Free-text search. Omit to list everything."),
        folderId: z
          .string()
          .optional()
          .describe("Only journals in this folder. Pass `root` for unfiled ones."),
        ...pageArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const folders = await tryLoadFolderIndex(client, campaignId, "journals");
        const query: Query = { campaignId };
        if (args.name) query.name = args.name;
        if (args.folderId === "root") query.folderId = { $exists: false };
        else if (args.folderId) query.folderId = args.folderId;

        const page = await fetchPage<Json>(
          client,
          "/journals",
          withSearch(query, args.search),
          args.limit,
          args.skip,
        );

        return json(
          pageResult(page, "journals", (j) => ({
            id: j._id,
            name: j.name,
            ...(j.category ? { category: j.category } : {}),
            ...folders.decorate(j),
            ...provenanceOf(j),
          })),
        );
      });
    }),
  );

  server.registerTool(
    "realm_write_journal",
    {
      title: "Create or update a journal",
      description: "Write a journal. With `id` it patches, without one it creates.",
      inputSchema: {
        id: z.string().optional(),
        journal: z.record(z.string(), z.unknown()).describe("Journal body — at minimum a `name`."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) return json({ updated: await client.patch<Json>("/journals", args.id, args.journal) });
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        return json({
          created: await client.create<Json>("/journals", { ...(args.journal as Json), campaignId }),
        });
      });
    }),
  );

  server.registerTool(
    "realm_journal_pages",
    {
      title: "Read journal pages",
      description:
        "With `journalId`: the page OUTLINE (id, name, pageNumber, indent — no content). " +
        "With `pageId`: that one page including its HTML content.",
      inputSchema: {
        journalId: z.string().optional().describe("List this journal's page outline."),
        pageId: z.string().optional().describe("Fetch one page in full."),
      },
    },
    safe(async (args) => {
      if (!args.journalId && !args.pageId) {
        return text("Pass either `journalId` (for the outline) or `pageId` (for one page).");
      }
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.pageId) return json(await client.get<Json>("/journal-pages", args.pageId), 60_000);
        return json(await client.journalPages(args.journalId!), 40_000);
      });
    }),
  );

  server.registerTool(
    "realm_write_journal_page",
    {
      title: "Create or update a journal page",
      description:
        "Write a page. With `id` it patches, without one it creates. `content` is an HTML STRING " +
        "(`<h1>`, `<p>`, `<ul><li>`, `<table>` …) — not markdown. `indent` controls left-nav " +
        "nesting: 0 = top level, 1 = subsection. `pageNumber` is 1-based.\n\n" +
        "To embed an image, upload it with `realm_upload_image` (which returns ready-to-paste " +
        "`<img>` HTML) or build the markup for an existing one with `realm_journal_image_html`.",
      inputSchema: {
        id: z.string().optional().describe("Page id to update. Omit to create."),
        page: z
          .record(z.string(), z.unknown())
          .describe("Page body: journalId, pageNumber, name, indent, content (HTML string)."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const doc = args.id
          ? await client.patch<Json>("/journal-pages", args.id, args.page)
          : await client.create<Json>("/journal-pages", args.page);
        return json({
          [args.id ? "updated" : "created"]: {
            id: doc._id,
            name: doc.name,
            pageNumber: doc.pageNumber,
            indent: doc.indent,
          },
        });
      });
    }),
  );

  server.registerTool(
    "realm_delete_journal_page",
    {
      title: "Delete a journal page",
      description: "Permanently delete a journal page. Requires confirm: true.",
      inputSchema: { id: z.string(), ...confirmArg },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `delete journal page ${args.id}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        await client.remove("/journal-pages", args.id);
        return text(`Deleted journal page ${args.id}.`);
      });
    }),
  );

  server.registerTool(
    "realm_journal_record_link_html",
    {
      title: "Build journal HTML for a record link",
      description:
        "Produce the `<record-link>` markup that puts a clickable link to campaign content " +
        "inline in a journal page. Paste the result into a page's `content` via " +
        "`realm_write_journal_page`.\n\n" +
        "A SCENE link is how you send the table to a map from the prose: clicking it asks the " +
        "GM to view or activate the scene, and lets a player view it if the GM has shared it. " +
        "Other types (npcs, records, tables, …) open that record's window.\n\n" +
        "`target` is an id or a name; ambiguous names come back as an error listing the matches.",
      inputSchema: {
        type: z
          .enum(JOURNAL_LINK_TYPES as [JournalLinkType, ...JournalLinkType[]])
          .describe("What the link points at. Use `records` for ruleset types (items, spells, …)."),
        target: z.string().describe("Id or name of the thing to link."),
        recordType: z
          .string()
          .optional()
          .describe("With type `records`: the ruleset record type (e.g. `items`)."),
        pageNumber: z
          .number()
          .optional()
          .describe("With type `journals`: open this page number (1-based)."),
        pageId: z
          .string()
          .optional()
          .describe(
            "With type `journals`: the page's id. Looked up from `pageNumber` when omitted, " +
              "so a link keeps working after the journal is reordered.",
          ),
        label: z.string().optional().describe("Link text. Defaults to the target's name."),
        icon: z
          .string()
          .optional()
          .describe(
            "Chip icon, e.g. `IconSword`. Only pass one you actually know — the record's own, " +
              "or the record type's `icon` from `realm_get_ruleset`. Leave it off otherwise; " +
              "the app falls back to the ruleset's icon on its own. Ignored for scenes, which " +
              "are always `IconMap`.",
          ),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const resolved = await resolveLinkTarget(
          client,
          campaignId,
          args.type,
          args.target,
          args.recordType,
        );
        // Resolve the page id from the number so the link survives a reorder.
        // Best-effort: a journal whose pages cannot be read still yields a
        // working number-only link, exactly as before.
        let pageId = args.pageId;
        if (args.type === "journals" && args.pageNumber && !pageId) {
          try {
            const pages = await client.journalPages<
              { id: string; pageNumber: number }[]
            >(String(resolved._id));
            pageId = pages.find((p) => p.pageNumber === args.pageNumber)?.id;
          } catch {
            pageId = undefined;
          }
        }

        const html = journalRecordLinkHtml({
          type: args.type,
          id: String(resolved._id),
          name: args.label ?? String(resolved.name ?? args.target),
          record: resolved,
          ...(args.icon ? { icon: args.icon } : {}),
          ...(args.recordType ? { recordType: args.recordType } : {}),
          ...(args.pageNumber ? { pageNumber: args.pageNumber } : {}),
          ...(pageId ? { pageId } : {}),
        });
        return json({ html, id: resolved._id, name: resolved.name, pageId });
      });
    }),
  );
}
