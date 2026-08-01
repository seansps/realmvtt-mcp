/**
 * "What uses this?" — backlinks, the dependency graph, link validation, and
 * retargeting a link.
 *
 * All four run on one `ReferenceIndex` (see refs/index.ts) rather than each
 * scanning the campaign its own way, so they cannot disagree about what is
 * linked. The cost is that any of them reads most of the campaign, which is why
 * every one of them reports what it did NOT read.
 *
 * Three of these tools are read-only. `realm_replace_link_target` is the one that
 * writes, and it takes `confirm` because retargeting links is a bulk edit across
 * pages a caller cannot see.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import {
  DEFAULT_PAGE_BUDGET,
  backlinksTo,
  buildReferenceIndex,
  findBrokenLinks,
  resolveTargetId,
  type ReferenceIndex,
} from "../refs/index.js";
import { storedPathOf, type Reference } from "../refs/extract.js";
import { retargetRecordLinks, retargetRecordPaths } from "../refs/retarget.js";
import type { JournalLinkType } from "./journals.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** Arguments controlling how much of the campaign an index reads. */
const scopeArgs = {
  recordTypes: z
    .array(z.string())
    .optional()
    .describe(
      "Ruleset record types to include (`items`, `spells`, …). Links into a type that is not " +
        "listed are reported as UNCHECKED rather than broken — there is no query for 'every " +
        "record type', so an omitted one genuinely cannot be verified.",
    ),
  pageBudget: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      `Max journal pages whose HTML is read (default ${DEFAULT_PAGE_BUDGET}). Page content is one ` +
        "request each and is the whole cost of this tool. If pages are skipped, the result says so.",
    ),
};

/** The scope caveats, attached to every result so a partial answer never reads as complete. */
function coverage(index: ReferenceIndex): Json {
  return {
    coverage: {
      journalPagesRead: index.pages.size,
      journalPagesSkipped: index.pagesSkipped,
      ...(index.pagesFailed ? { journalPagesFailed: index.pagesFailed } : {}),
      documentsIndexed: index.docs.size,
      ...(index.notes.length ? { caveats: index.notes } : {}),
    },
  };
}

/** A one-line description of where a reference lives, for a report a human reads. */
function describeSource(ref: { from: Reference["from"]; at?: string }): string {
  const { from } = ref;
  const where = from.parentName ? `${from.parentName} → ${from.name ?? from.id}` : from.name ?? from.id;
  return `${from.kind} "${where}"${ref.at ? ` (${ref.at})` : ""}`;
}

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "realm_find_backlinks",
    {
      title: "Find what references a scene, image, record or journal",
      description:
        "Everything in the campaign that points at one thing — journal links, table cells, " +
        "encounter rosters, scene backgrounds, portraits and token art.\n\n" +
        "ASK THIS BEFORE DELETING OR MOVING ANYTHING. Realm does not stop you removing a record " +
        "a dozen journal pages link to; the links simply stop working, and nothing in the app " +
        "reports it afterwards.\n\n" +
        "`target` is a document id, or a stored image path (`/images/abc_map.png`) — an image " +
        "referenced by path from a portrait and by id from a journal embed is the same picture, " +
        "and both are found either way.",
      inputSchema: {
        target: z.string().describe("Document id, or a stored image path."),
        ...scopeArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const index = await buildReferenceIndex(client, campaignId, {
          recordTypes: args.recordTypes,
          pageBudget: args.pageBudget,
        });

        const links = backlinksTo(index, args.target);
        const resolvedId = index.imagePathToId.get(storedPathOf(args.target)) ?? args.target;
        const doc = index.docs.get(resolvedId);

        return json({
          target: {
            id: resolvedId,
            ...(doc ? { name: doc.name, kind: doc.kind } : { note: "Not a document in this campaign — reporting references by path." }),
          },
          referencedBy: links.length,
          ...(links.length === 0
            ? {
                verdict:
                  "Nothing references this. Safe to delete or move, as far as links go — check " +
                  "`coverage` below before trusting that.",
              }
            : {}),
          links: links.map((l) => ({
            source: describeSource(l),
            kind: l.from.kind,
            id: l.from.id,
            ...(l.from.parentId ? { journalId: l.from.parentId } : {}),
            via: l.via,
            ...(l.at ? { at: l.at } : {}),
            ...(l.staleLabel ? { staleLabel: l.staleLabel } : {}),
          })),
          ...coverage(index),
        });
      });
    }),
  );

  server.registerTool(
    "realm_dependency_graph",
    {
      title: "What one thing depends on, and what depends on it",
      description:
        "The dependency neighbourhood around one document, out to `depth` hops in both " +
        "directions. Use it to scope an export (what must travel with this scene?) or a " +
        "deletion (what breaks?).\n\n" +
        "This is deliberately ROOTED and depth-capped rather than a whole-campaign dump — a " +
        "full graph of a real campaign is thousands of edges and answers no question anyone " +
        "actually asked.",
      inputSchema: {
        root: z.string().describe("Document id to centre the graph on."),
        depth: z.number().int().min(1).max(4).optional().describe("Hops to follow. Default 2."),
        direction: z
          .enum(["dependencies", "dependents", "both"])
          .optional()
          .describe(
            "`dependencies` = what this needs (follow outward, for an export). " +
              "`dependents` = what needs this (follow inward, for a delete). Default `both`.",
          ),
        include3dAssets: z
          .boolean()
          .optional()
          .describe(
            "Also read placed 3D objects to report which catalog assets a scene uses. Expensive " +
              "— a built town is thousands of placements.",
          ),
        ...scopeArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const index = await buildReferenceIndex(client, campaignId, {
          recordTypes: args.recordTypes,
          pageBudget: args.pageBudget,
          include3dObjects: args.include3dAssets,
        });

        const depth = args.depth ?? 2;
        const direction = args.direction ?? "both";

        // Adjacency built once from the flat reference list. Sources are keyed by
        // their own id, which for a journal PAGE is the page — a page is the unit
        // that actually holds the link, and rolling it up to the journal would
        // lose the only detail that makes a repair possible.
        const out = new Map<string, Set<string>>();
        const inn = new Map<string, Set<string>>();
        for (const ref of index.refs) {
          const to = resolveTargetId(index, ref);
          if (!to) continue;
          const from = ref.from.parentId ?? ref.from.id;
          if (from === to) continue;
          if (!out.has(from)) out.set(from, new Set());
          if (!inn.has(to)) inn.set(to, new Set());
          out.get(from)!.add(to);
          inn.get(to)!.add(from);
        }

        const label = (id: string): Json => {
          const d = index.docs.get(id);
          return d ? { id, name: d.name, kind: d.kind } : { id, unknown: true };
        };

        const walk = (map: Map<string, Set<string>>): Array<Json> => {
          const seen = new Set<string>([args.root]);
          const layers: Array<Json> = [];
          let frontier = [args.root];
          for (let d = 1; d <= depth && frontier.length; d += 1) {
            const next: string[] = [];
            for (const id of frontier) {
              for (const neighbour of map.get(id) ?? []) {
                if (seen.has(neighbour)) continue;
                seen.add(neighbour);
                next.push(neighbour);
              }
            }
            if (next.length) layers.push({ depth: d, nodes: next.map(label) });
            frontier = next;
          }
          return layers;
        };

        const assets = args.include3dAssets
          ? index.assetRefs.filter((a) => a.from.id === args.root)
          : [];

        return json({
          root: label(args.root),
          depth,
          ...(direction !== "dependents" ? { dependencies: walk(out) } : {}),
          ...(direction !== "dependencies" ? { dependents: walk(inn) } : {}),
          ...(assets.length
            ? {
                assets3d: assets
                  .sort((a, b) => b.count - a.count)
                  .map((a) => ({ assetId: a.to.path, placements: a.count })),
              }
            : {}),
          ...coverage(index),
        });
      });
    }),
  );

  server.registerTool(
    "realm_validate_links",
    {
      title: "Find broken links across the campaign",
      description:
        "Every reference that no longer lands: journal links and table cells pointing at deleted " +
        "records, scene default-pins and teleporters aimed at markers that are gone, and record " +
        "links whose stored JSON is corrupt.\n\n" +
        "REPORT ONLY — nothing is repaired. Fix a retargetable link with " +
        "`realm_replace_link_target`.\n\n" +
        "Links whose target type was not indexed are counted as UNCHECKED, never as broken: " +
        "there is no 'all record types' query, so an unlisted type cannot be verified and " +
        "reporting it as missing would be a fabricated deletion candidate.",
      inputSchema: {
        problems: z
          .array(
            z.enum([
              "missing-target",
              "image-not-in-library",
              "stale-label",
              "malformed-link",
              "broken-marker",
            ]),
          )
          .optional()
          .describe(
            "Which problems to report. Defaults to the three that mean something is BROKEN. " +
              "`stale-label` (a link showing an outdated name) and `image-not-in-library` (art " +
              "that displays fine but has no library row) are opt-in: both are common in healthy " +
              "campaigns and would bury the real findings.",
          ),
        limit: z.number().int().min(1).max(500).optional().describe("Max findings (default 100)."),
        ...scopeArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const index = await buildReferenceIndex(client, campaignId, {
          recordTypes: args.recordTypes,
          pageBudget: args.pageBudget,
        });

        const { broken, unchecked } = findBrokenLinks(index, args.recordTypes ?? []);
        const wanted = new Set(
          args.problems ?? [
            "missing-target",
            "malformed-link",
            "broken-marker",
          ],
        );
        const filtered = broken.filter((b) => wanted.has(b.problem));
        const limit = args.limit ?? 100;

        const byProblem: Record<string, number> = {};
        for (const b of filtered) byProblem[b.problem] = (byProblem[b.problem] ?? 0) + 1;

        return json({
          found: filtered.length,
          byProblem,
          ...(unchecked ? { unchecked } : {}),
          ...(filtered.length > limit
            ? { note: `Showing ${limit} of ${filtered.length}. Raise \`limit\` or filter \`problems\`.` }
            : {}),
          findings: filtered.slice(0, limit).map((b) => ({
            problem: b.problem,
            source: describeSource(b),
            sourceId: b.from.id,
            ...(b.from.parentId ? { journalId: b.from.parentId } : {}),
            via: b.via,
            ...(b.at ? { at: b.at } : {}),
            target: b.target,
            detail: b.detail,
          })),
          ...coverage(index),
        });
      });
    }),
  );

  server.registerTool(
    "realm_replace_link_target",
    {
      title: "Point existing links at a different record",
      description:
        "Rewrite every link to one record so it points at another — for merging duplicates, or " +
        "repairing links broken by a deletion.\n\n" +
        "This REBUILDS each link rather than swapping the id inside it. A stored link carries a " +
        "snapshot of its target (display name, icon, and for an NPC the token image and size " +
        "used when the chip is dragged onto the map), so a naive id swap leaves the page showing " +
        "the old name and dropping the old token while navigating to the new record.\n\n" +
        "Run with `dryRun: true` first to see exactly which pages, tables and records would " +
        "change. Applying requires `confirm: true`.",
      inputSchema: {
        from: z.string().describe("Id currently linked to — or a stored image path, to repoint art."),
        to: z.string().describe("Id to point at instead — or the replacement image path."),
        toType: z
          .string()
          .optional()
          .describe("The new target's link type, if it differs (`npcs`, `records`, `scenes`, …)."),
        toRecordType: z
          .string()
          .optional()
          .describe("With type `records`: the ruleset record type of the new target."),
        dryRun: z.boolean().optional().describe("Report what would change without writing."),
        ...confirmArg,
        ...scopeArgs,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const isPath = args.from.includes("/");
      if (!args.dryRun) {
        requireConfirm(args.confirm, `rewrite every link from ${args.from} to ${args.to}`);
      }

      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const index = await buildReferenceIndex(client, campaignId, {
          recordTypes: args.recordTypes,
          pageBudget: args.pageBudget,
        });

        if (isPath) return json(await repointPaths(client, index, args, campaignId));

        // The new target has to be READ, not assumed: its name and art are what
        // get baked into every rebuilt chip.
        const target = index.docs.get(args.to);
        if (!target) {
          return text(
            `${args.to} is not a document in this campaign's index. Check the id, or widen ` +
              `\`recordTypes\` if it is a ruleset record type.`,
          );
        }
        const toRecord = await client.get<Json>(target.service, args.to).catch(() => undefined);

        const spec = {
          fromId: args.from,
          toId: args.to,
          toName: target.name,
          ...(toRecord ? { toRecord } : {}),
          ...(args.toType ? { toType: args.toType as JournalLinkType } : {}),
          ...(args.toRecordType ? { toRecordType: args.toRecordType } : {}),
        };

        const changes: Json[] = [];

        // ── journal pages ────────────────────────────────────────────────────
        for (const [pageId, page] of index.pages) {
          const html = typeof page.content === "string" ? page.content : "";
          const result = retargetRecordLinks(html, spec);
          if (result.replaced === 0) continue;
          changes.push({
            kind: "journal-page",
            id: pageId,
            name: page.name,
            links: result.replaced,
            ...(result.skipped ? { skipped: result.skipped } : {}),
          });
          if (!args.dryRun) {
            await client.patch("/journal-pages", pageId, { content: result.html });
          }
        }

        // ── table cells ──────────────────────────────────────────────────────
        // A cell's link is stored JSON, not markup, so it is rebuilt field by
        // field — but the same rule applies: replace the whole link object rather
        // than editing its id, or `tooltip` keeps naming the old record.
        const tableRefs = index.refs.filter(
          (r) => r.via === "table-cell" && r.to.id === args.from,
        );
        const tableIds = new Set(tableRefs.map((r) => r.from.id));
        for (const tableId of tableIds) {
          const table = await client.get<Json>("/tables", tableId).catch(() => null);
          if (!table) continue;
          const rows = Array.isArray(table.rows) ? (table.rows as Json[]) : [];
          let hits = 0;
          const nextRows = rows.map((row) => {
            const columns = Array.isArray(row.columns) ? (row.columns as Json[]) : [];
            return {
              ...row,
              columns: columns.map((cell) => {
                const link = cell.recordLink as { value?: { _id?: string } } | undefined;
                if (String(link?.value?._id ?? "") !== args.from) return cell;
                hits += 1;
                return {
                  ...cell,
                  recordLink: {
                    type: args.toType ?? (cell.recordLink as Json).type,
                    tooltip: target.name,
                    ...((cell.recordLink as Json).icon ? { icon: (cell.recordLink as Json).icon } : {}),
                    value: {
                      _id: args.to,
                      name: target.name,
                      ...(args.toRecordType ? { recordType: args.toRecordType } : {}),
                    },
                  },
                };
              }),
            };
          });
          if (!hits) continue;
          changes.push({ kind: "table", id: tableId, name: table.name, links: hits });
          if (!args.dryRun) await client.patch("/tables", tableId, { rows: nextRows });
        }

        // ── encounter rosters ────────────────────────────────────────────────
        const encRefs = index.refs.filter(
          (r) => r.via === "encounter-npc" && r.to.id === args.from,
        );
        for (const encId of new Set(encRefs.map((r) => r.from.id))) {
          const enc = await client.get<Json>("/encounters", encId).catch(() => null);
          if (!enc) continue;
          const npcs = Array.isArray(enc.npcs) ? (enc.npcs as Json[]) : [];
          let hits = 0;
          const nextNpcs = npcs.map((n) => {
            if (String(n.npcId ?? "") !== args.from) return n;
            hits += 1;
            return { ...n, npcId: args.to, name: target.name };
          });
          if (!hits) continue;
          changes.push({ kind: "encounter", id: encId, name: enc.name, links: hits });
          if (!args.dryRun) await client.patch("/encounters", encId, { npcs: nextNpcs });
        }

        const total = changes.reduce((n, c) => n + Number(c.links ?? 0), 0);
        return json({
          [args.dryRun ? "wouldChange" : "changed"]: changes,
          linksAffected: total,
          from: args.from,
          to: { id: args.to, name: target.name, kind: target.kind },
          ...(args.dryRun && total > 0
            ? { next: "Re-run with `dryRun: false` and `confirm: true` to apply." }
            : {}),
          ...(total === 0 ? { note: "Nothing links to that id within the indexed scope." } : {}),
          ...coverage(index),
        });
      });
    }),
  );
}

/**
 * Repoint art that is stored as a PATH rather than an id — portraits, token
 * images, 2D scene backgrounds.
 *
 * Kept separate from the link rewrite because it is a genuinely different
 * operation: there is no chip to rebuild, just a string on a document, and the
 * risk is the opposite one (patching `token` wholesale would drop the fields the
 * patch does not mention).
 */
async function repointPaths(
  client: RealmClient,
  index: ReferenceIndex,
  args: { from: string; to: string; dryRun?: boolean },
  _campaignId: string,
): Promise<Json> {
  const fromPath = storedPathOf(args.from);
  const toPath = storedPathOf(args.to);
  const changes: Json[] = [];

  const affected = index.refs.filter(
    (r) => r.to.kind === "image-path" && r.to.path === fromPath,
  );

  for (const ref of affected) {
    if (ref.from.kind === "record") {
      const doc = await client.get<Json>(ref.from.service ?? "/records", ref.from.id).catch(() => null);
      if (!doc) continue;
      const patch = retargetRecordPaths(doc, fromPath, toPath);
      if (!patch) continue;
      changes.push({ kind: "record", id: ref.from.id, name: ref.from.name, fields: Object.keys(patch) });
      if (!args.dryRun) await client.patch(ref.from.service ?? "/records", ref.from.id, patch);
    } else if (ref.from.kind === "scene") {
      const scene = await client.get<Json>("/scenes", ref.from.id).catch(() => null);
      if (!scene) continue;
      const layers = Array.isArray(scene.layers) ? (scene.layers as Json[]) : [];
      let hit = false;
      const next = layers.map((l) => {
        if (typeof l.url !== "string" || storedPathOf(l.url) !== fromPath) return l;
        hit = true;
        return { ...l, url: toPath };
      });
      if (!hit) continue;
      changes.push({ kind: "scene", id: ref.from.id, name: ref.from.name, fields: ["layers[].url"] });
      if (!args.dryRun) await client.patch("/scenes", ref.from.id, { layers: next });
    } else if (ref.from.kind === "journal-page") {
      const page = index.pages.get(ref.from.id);
      const html = typeof page?.content === "string" ? page.content : "";
      // Journal embeds store the ABSOLUTE cdn url, so both spellings are swapped.
      const next = html.split(args.from).join(args.to).split(fromPath).join(toPath);
      if (next === html) continue;
      changes.push({ kind: "journal-page", id: ref.from.id, name: ref.from.name, fields: ["content"] });
      if (!args.dryRun) await client.patch("/journal-pages", ref.from.id, { content: next });
    }
  }

  return {
    [args.dryRun ? "wouldChange" : "changed"]: changes,
    from: fromPath,
    to: toPath,
    ...(changes.length === 0 ? { note: "Nothing uses that image path within the indexed scope." } : {}),
  };
}
