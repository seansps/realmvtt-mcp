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
import type { Json, Query } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

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
}
