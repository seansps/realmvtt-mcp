/**
 * `realm_audit_campaign` and the folder-manifest pair.
 *
 * The audit is a REPORT built from the same reference index the backlink tools
 * use — it does not scan the campaign a second time and it never repairs
 * anything. The manifest tools are the only writers here, and the write is a
 * folder move, which is the one bulk operation people actually asked to automate.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, Query, RealmClient } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { buildReferenceIndex, DEFAULT_PAGE_BUDGET } from "../refs/index.js";
import { AUDIT_CHECKS, DEFAULT_CHECKS, runAudit, type AuditCheck } from "../refs/audit.js";
import { ROOT_PATH, inverseManifest, planManifest, type ManifestEntry } from "../refs/manifest.js";
import {
  countItemsByFolder,
  folderScopeFor,
  listItemsIn,
  type FolderDoc,
} from "./folders.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** Load the folder tree and item counts for one list. */
async function loadTree(
  client: RealmClient,
  campaignId: string,
  type: string,
): Promise<{ folders: FolderDoc[]; counts: ReturnType<typeof countItemsByFolder>; items: Array<Json & { _id: string }> }> {
  const scope = folderScopeFor(type);
  const query: Query = { campaignId, type: scope.folderType };
  if (scope.recordType) query.recordType = scope.recordType;
  const folders = await client.findAll<FolderDoc>("/folders", query);
  const items = await listItemsIn(client, campaignId, scope);
  return { folders, counts: countItemsByFolder(folders, items), items };
}

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "realm_audit_campaign",
    {
      title: "Audit a campaign for broken and messy content",
      description:
        "Report problems across a campaign: broken journal and table links, encounters pointing " +
        "at deleted NPCs, scene pins and teleporters aimed at markers that are gone, duplicate " +
        "names, empty folders, items filed into folders that no longer exist, and records with " +
        "no art.\n\n" +
        "REPORT ONLY. Nothing is deleted, moved or repaired. Orphaned images in particular " +
        "cannot be cleaned from here at all — freeing storage means removing the file from the " +
        "CDN and adjusting account usage, which only the app's own delete does.\n\n" +
        "Findings carry a stable `id`, so two runs can be diffed and a known-acceptable finding " +
        "can be ignored by the caller.\n\n" +
        "Pass `checks` to narrow it. Two checks are OFF by default because on a healthy campaign " +
        "they produce hundreds of non-defects that bury the real findings: `stale-labels` (a " +
        "link showing a name that has since changed) and `unlinked-images` (art that displays " +
        "fine but has no image-library row — an export concern, not breakage).",
      inputSchema: {
        checks: z
          .array(z.enum(AUDIT_CHECKS as unknown as [AuditCheck, ...AuditCheck[]]))
          .optional()
          .describe(`Which checks to run. Default: ${DEFAULT_CHECKS.join(", ")}.`),
        folderTypes: z
          .array(z.string())
          .optional()
          .describe(
            "Which folder trees to check for empty folders and orphaned items " +
              "(`npcs`, `scenes`, `images`, `spells`, …). Each costs a listing of that content.",
          ),
        recordTypes: z
          .array(z.string())
          .optional()
          .describe(
            "Ruleset record types to index (`items`, `spells`, …). Links into a type that is " +
              "not listed are counted UNCHECKED, never reported as broken.",
          ),
        pageBudget: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(`Max journal pages whose HTML is read. Default ${DEFAULT_PAGE_BUDGET}.`),
        severity: z
          .enum(["error", "warning", "info"])
          .optional()
          .describe("Only report findings at this severity or worse."),
        limit: z.number().int().min(1).max(500).optional().describe("Max findings (default 100)."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const checks = (args.checks as AuditCheck[] | undefined) ?? DEFAULT_CHECKS;
        const recordTypes = args.recordTypes ?? [];

        const index = await buildReferenceIndex(client, campaignId, {
          recordTypes,
          pageBudget: args.pageBudget,
        });

        // Folder trees are only loaded when a check actually needs them — each is
        // a full listing of that content type.
        const needsFolders =
          checks.includes("empty-folders") || checks.includes("orphaned-folder-items");
        const folders = new Map<string, { folders: FolderDoc[]; counts: ReturnType<typeof countItemsByFolder> }>();
        if (needsFolders) {
          for (const type of args.folderTypes ?? ["npcs", "scenes", "journals", "images"]) {
            try {
              const tree = await loadTree(client, campaignId, type);
              folders.set(type, { folders: tree.folders, counts: tree.counts });
            } catch {
              // A type this campaign's ruleset does not define is not an error;
              // it simply has no tree to check.
            }
          }
        }

        const all = runAudit({ index, recordTypes, folders }, checks);
        const rank = { error: 0, warning: 1, info: 2 } as const;
        const cutoff = rank[args.severity ?? "info"];
        const filtered = all.filter((f) => rank[f.severity] <= cutoff);
        const limit = args.limit ?? 100;

        const byCheck: Record<string, number> = {};
        const bySeverity: Record<string, number> = {};
        for (const f of filtered) {
          byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
          bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
        }

        return json({
          checksRun: checks,
          found: filtered.length,
          bySeverity,
          byCheck,
          ...(filtered.length > limit
            ? { note: `Showing ${limit} of ${filtered.length}. Raise \`limit\` or narrow \`checks\`.` }
            : {}),
          findings: filtered.slice(0, limit),
          coverage: {
            journalPagesRead: index.pages.size,
            journalPagesSkipped: index.pagesSkipped,
            ...(index.pagesFailed ? { journalPagesFailed: index.pagesFailed } : {}),
            documentsIndexed: index.docs.size,
            folderTreesChecked: [...folders.keys()],
            ...(index.notes.length ? { caveats: index.notes } : {}),
          },
          reportOnly:
            "Nothing was changed. This tool never deletes, moves or repairs — use " +
            "`realm_replace_link_target` for links and `realm_apply_folder_manifest` for filing.",
        });
      });
    }),
  );

  server.registerTool(
    "realm_preview_folder_manifest",
    {
      title: "Preview filing content into a folder layout",
      description:
        "Given a list of `{ id, path }` entries, work out exactly what filing them would do — " +
        "which items move, which are already where you want them, which folders would have to " +
        "be created, and which ids do not resolve to anything in this list.\n\n" +
        "NOTHING IS WRITTEN. Run this first: the backend does not validate `folderId` on items, " +
        "so filing something into an id that does not exist (or into another list's folder) is " +
        "accepted silently and makes the item invisible in the app.\n\n" +
        "`path` is slash-separated (`Bestiary / Undead / Liches`); use `root` to unfile.",
      inputSchema: {
        type: z
          .string()
          .describe("Which list this manifest files: `npcs`, `scenes`, `images`, `spells`, …"),
        entries: z
          .array(z.object({ id: z.string(), path: z.string() }))
          .describe("The manifest: item id → destination folder path."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const tree = await loadTree(client, campaignId, args.type);
        const plan = planManifest(args.entries as ManifestEntry[], tree.folders, tree.items);

        return json({
          type: args.type,
          ...plan.counts,
          foldersToCreate: plan.foldersToCreate,
          unresolved: plan.unresolved,
          moves: plan.moves.filter((m) => m.action !== "unchanged"),
          ...(plan.counts.unchanged
            ? { unchangedNote: `${plan.counts.unchanged} items are already where the manifest wants them.` }
            : {}),
          next:
            "Apply with `realm_apply_folder_manifest` (confirm: true). It returns an INVERSE " +
            "manifest that puts everything back — keep it, because a partial failure cannot be " +
            "rolled back automatically.",
        });
      });
    }),
  );

  server.registerTool(
    "realm_apply_folder_manifest",
    {
      title: "File content into a folder layout",
      description:
        "Apply a `{ id, path }` manifest, creating missing folders parents-first and moving each " +
        "item into place. Idempotent — a move is a patch to a target value, so re-applying the " +
        "same manifest changes nothing.\n\n" +
        "RETURNS AN INVERSE MANIFEST. There is no transaction: filing is one PATCH per item, so " +
        "a failure partway leaves a partly-moved tree. The inverse manifest records where every " +
        "item came from and can be applied to put it back — including after a partial failure, " +
        "which is when it matters most. Keep it; it is not stored anywhere.\n\n" +
        "Requires `confirm: true`. Preview first with `realm_preview_folder_manifest`.",
      inputSchema: {
        type: z.string().describe("Which list this manifest files."),
        entries: z
          .array(z.object({ id: z.string(), path: z.string() }))
          .describe("The manifest: item id → destination folder path."),
        createMissingFolders: z
          .boolean()
          .optional()
          .describe("Create folders named in the manifest that do not exist yet. Default true."),
        stopOnError: z
          .boolean()
          .optional()
          .describe(
            "Stop at the first failed move rather than continuing. Default false — continuing " +
              "moves as many as possible and reports the rest, which is usually easier to finish " +
              "by hand.",
          ),
        ...confirmArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `file ${args.entries.length} items into folders`);

      const client = session.client();
      const scope = folderScopeFor(args.type);

      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const tree = await loadTree(client, campaignId, args.type);
        const plan = planManifest(args.entries as ManifestEntry[], tree.folders, tree.items);

        // ── create folders, parents first ────────────────────────────────────
        const pathToId = new Map<string, string>();
        for (const f of tree.folders) {
          const parts: string[] = [];
          let cursor: FolderDoc | undefined = f;
          const byId = new Map(tree.folders.map((x) => [String(x._id), x]));
          const seen = new Set<string>();
          while (cursor && !seen.has(String(cursor._id))) {
            seen.add(String(cursor._id));
            parts.unshift(cursor.name);
            cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : undefined;
          }
          pathToId.set(parts.join(" / "), String(f._id));
        }

        const created: Array<{ path: string; id: string }> = [];
        if (args.createMissingFolders !== false) {
          for (const path of plan.foldersToCreate) {
            const parts = path.split(" / ");
            const name = parts[parts.length - 1]!;
            const parentPath = parts.slice(0, -1).join(" / ");
            const parentId = parentPath ? pathToId.get(parentPath) : undefined;
            const folder = await client.create<Json>("/folders", {
              name,
              campaignId,
              type: scope.folderType,
              ...(scope.recordType ? { recordType: scope.recordType } : {}),
              ...(parentId ? { parentId } : {}),
            });
            pathToId.set(path, String(folder._id));
            created.push({ path, id: String(folder._id) });
          }
        }

        // ── move items ───────────────────────────────────────────────────────
        const applied: typeof plan.moves = [];
        const failures: Array<{ itemId: string; toPath: string; error: string }> = [];

        for (const move of plan.moves) {
          if (move.action === "unchanged" || move.action === "unresolved") continue;

          const targetId = move.toPath === ROOT_PATH ? undefined : move.toFolderId ?? pathToId.get(move.toPath);
          if (move.toPath !== ROOT_PATH && !targetId) {
            failures.push({
              itemId: move.itemId,
              toPath: move.toPath,
              error: "Destination folder does not exist and was not created.",
            });
            if (args.stopOnError) break;
            continue;
          }

          // Unfiling must $unset. A null folderId matches neither the root
          // listing nor any folder, so it hides the item rather than moving it.
          const patch: Json = targetId ? { folderId: targetId } : { $unset: { folderId: "" } };
          try {
            await client.patch(scope.servicePath, move.itemId, patch);
            applied.push(move);
          } catch (err) {
            failures.push({
              itemId: move.itemId,
              toPath: move.toPath,
              error: err instanceof Error ? err.message : String(err),
            });
            if (args.stopOnError) break;
          }
        }

        return json({
          type: args.type,
          moved: applied.length,
          unchanged: plan.counts.unchanged,
          foldersCreated: created,
          ...(plan.unresolved.length ? { unresolved: plan.unresolved } : {}),
          ...(failures.length ? { failures } : {}),
          // The whole point: a re-runnable undo, produced even (especially) when
          // the apply was partial.
          inverseManifest: {
            type: args.type,
            entries: inverseManifest(applied),
            note:
              "Apply this with `realm_apply_folder_manifest` to put everything back. It covers " +
              `the ${applied.length} moves that SUCCEEDED — nothing else was touched. Folders ` +
              "created by this run are not removed by it.",
          },
          ...(failures.length
            ? {
                warning:
                  `${failures.length} moves failed. There is no transaction here — the ${applied.length} ` +
                  "that succeeded are already applied. Use the inverse manifest above to undo them.",
              }
            : {}),
        });
      });
    }),
  );
}
