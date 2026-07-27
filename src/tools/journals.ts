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
 * Scenes carry `IconMap` at both levels, as the importer does for its icons:
 * the chip renders the top-level `icon`, and `value.icon` is what survives if
 * the link is re-sanitized after a drag.
 */
export function journalRecordLinkHtml(link: JournalLinkInput): string {
  const value: Json = { _id: link.id, name: link.name };
  if (link.type === "records" && link.recordType) value.recordType = link.recordType;
  if (link.type === "journals" && link.pageNumber) value.pageNumber = link.pageNumber;

  const payload: Json = { type: link.type, tooltip: link.name, value };
  if (link.type === "scenes") {
    payload.icon = "IconMap";
    value.icon = "IconMap";
  }

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
      description: "List or search the campaign's journals (the containers that hold pages).",
      inputSchema: { name: z.string().optional(), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Query = { campaignId };
        if (args.name) query.name = args.name;
        const journals = await client.findAll<Json>("/journals", query);
        return json({
          total: journals.length,
          journals: journals.map((j) => ({ id: j._id, name: j.name, category: j.category })),
        });
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
        label: z.string().optional().describe("Link text. Defaults to the target's name."),
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
        const html = journalRecordLinkHtml({
          type: args.type,
          id: String(resolved._id),
          name: args.label ?? String(resolved.name ?? args.target),
          ...(args.recordType ? { recordType: args.recordType } : {}),
          ...(args.pageNumber ? { pageNumber: args.pageNumber } : {}),
        });
        return json({ html, id: resolved._id, name: resolved.name });
      });
    }),
  );
}
