/**
 * Folders: the tree every compendium tab (NPCs, Journals, Scenes, Sounds, …) can
 * file its content into.
 *
 * A folder belongs to exactly one list, named by `type`. Ten of those types are
 * the list's own service (`npcs`, `journals`, `scenes`, …); everything a RULESET
 * defines (items, spells, feats, …) shares one `records` tree per record type —
 * a folder of spells is `{ type: "records", recordType: "spells" }`. Callers of
 * these tools never spell that out: they pass the list name or the ruleset
 * record type (`"spells"`), and the scope is derived.
 *
 * Filing an item is a patch on the ITEM (`folderId`), not on the folder — so
 * moving things is `realm_move_to_folder`, and unfiling $unsets the field
 * (a null folderId would match neither the root listing nor any folder).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, Query } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** The lists whose documents live on a service of the same name. Mirrors the
 *  backend's FOLDER_TYPES minus `records`, which is scoped per ruleset type. */
export const DEDICATED_FOLDER_TYPES = [
  "images",
  "scenes",
  "sounds",
  "tables",
  "encounters",
  "effects",
  "journals",
  "decks",
  "npcs",
  "characters",
] as const;

export interface FolderScope {
  /** The backend folder `type` — a dedicated list name, or `records`. */
  folderType: string;
  /** Set only when folderType is `records`: the ruleset record type. */
  recordType?: string;
  /** The service holding the ITEMS this tree files. */
  servicePath: string;
}

/**
 * Map the `type` a tool call passes to the backend folder scope and the item
 * service. Ruleset-defined types all share the /records service and are told
 * apart by `recordType` on the folder.
 */
export function folderScopeFor(type: string): FolderScope {
  const t = type.trim().toLowerCase();
  if ((DEDICATED_FOLDER_TYPES as readonly string[]).includes(t)) {
    return { folderType: t, servicePath: `/${t}` };
  }
  if (t === "records") {
    throw new Error(
      "For ruleset-defined content pass the record type itself (e.g. `items`, `spells`), " +
        "not the literal `records` — each record type has its own folder tree.",
    );
  }
  return { folderType: "records", recordType: t, servicePath: "/records" };
}

const FOLDER_TYPE_GUIDE =
  "Which list this folder tree organizes:\n" +
  `• one of ${DEDICATED_FOLDER_TYPES.join(", ")} — the app's own tabs\n` +
  "• or a ruleset-defined record type (`items`, `spells`, `feats`, …) — each record " +
  "type gets its own tree. Pass the type itself, never the literal `records`.";

const folderTypeArg = z.string().describe(FOLDER_TYPE_GUIDE);

interface FolderDoc {
  _id: string;
  name: string;
  parentId?: string | null;
  color?: string;
  moduleId?: string;
  [k: string]: unknown;
}

/**
 * Breadcrumb path for every folder ("Bestiary / Undead / Liches"), so the model
 * can tell same-named folders apart without walking parentIds itself.
 */
export function folderPathsById(folders: FolderDoc[]): Record<string, string> {
  const byId = new Map(folders.map((f) => [String(f._id), f]));
  const paths: Record<string, string> = {};
  const pathOf = (id: string, seen: Set<string>): string => {
    if (paths[id]) return paths[id];
    const folder = byId.get(id);
    if (!folder) return "?";
    // A cycle can only come from corrupt data, but a hang would be worse.
    if (seen.has(id)) return folder.name;
    seen.add(id);
    const parent = folder.parentId ? byId.get(String(folder.parentId)) : undefined;
    paths[id] = parent ? `${pathOf(String(parent._id), seen)} / ${folder.name}` : folder.name;
    return paths[id];
  };
  for (const folder of folders) pathOf(String(folder._id), new Set());
  return paths;
}

export function registerFolderTools(server: McpServer): void {
  server.registerTool(
    "realm_list_folders",
    {
      title: "List a campaign's folders for one list",
      description:
        "List the folder tree one list files its content into — NPCs, journals, scenes, " +
        "sounds, or any ruleset record type. Each entry carries its full breadcrumb `path`, " +
        "so nesting is readable at a glance. Use the ids with `realm_move_to_folder` to file " +
        "content, and with `parentId` on `realm_write_folder` to nest.",
      inputSchema: {
        type: folderTypeArg,
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const scope = folderScopeFor(args.type);
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Query = { campaignId, type: scope.folderType, $sort: { name: 1 } };
        if (scope.recordType) query.recordType = scope.recordType;
        const folders = await client.findAll<FolderDoc>("/folders", query);
        const paths = folderPathsById(folders);
        return json({
          type: args.type,
          total: folders.length,
          folders: folders.map((f) => ({
            id: f._id,
            name: f.name,
            path: paths[String(f._id)],
            ...(f.parentId ? { parentId: f.parentId } : {}),
            ...(f.color ? { color: f.color } : {}),
            ...(f.moduleId ? { moduleId: f.moduleId } : {}),
          })),
        });
      });
    }),
  );

  server.registerTool(
    "realm_write_folder",
    {
      title: "Create or update a folder",
      description:
        "Write a folder in one list's tree. With `id` it patches (rename, recolor, or " +
        "re-parent); without one it creates. Folders nest via `parentId`; pass parentId `null` " +
        "on an update to move a folder to the root. Filing CONTENT into a folder is a separate " +
        "operation — `realm_move_to_folder`.",
      inputSchema: {
        type: folderTypeArg,
        id: z.string().optional().describe("Folder id to update. Omit to create."),
        name: z.string().optional().describe("Folder name. Required when creating."),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Parent folder id to nest under, or null for the root. On update, omit to leave " +
              "the parent unchanged.",
          ),
        color: z.string().optional().describe("Display color, e.g. `#8b6fc9`."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const scope = folderScopeFor(args.type);
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) {
          const patch: Json = {};
          if (args.name !== undefined) patch.name = args.name;
          if (args.parentId !== undefined) patch.parentId = args.parentId;
          if (args.color !== undefined) patch.color = args.color;
          if (Object.keys(patch).length === 0) {
            return text("Nothing to update — pass name, parentId, or color.");
          }
          const updated = await client.patch<FolderDoc>("/folders", args.id, patch);
          return json({ updated: { id: updated._id, name: updated.name, parentId: updated.parentId ?? null } });
        }

        if (!args.name) return text("Creating a folder requires a `name`.");
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const created = await client.create<FolderDoc>("/folders", {
          campaignId,
          type: scope.folderType,
          ...(scope.recordType ? { recordType: scope.recordType } : {}),
          name: args.name,
          parentId: args.parentId ?? null,
          ...(args.color ? { color: args.color } : {}),
        });
        return json({ created: { id: created._id, name: created.name, parentId: created.parentId ?? null } });
      });
    }),
  );

  server.registerTool(
    "realm_delete_folder",
    {
      title: "Delete a folder",
      description:
        "Delete a folder. By default its subfolders and contents are PROMOTED to the parent " +
        "(nothing else is deleted); with `cascade: true` the whole subtree AND every item " +
        "filed anywhere inside it are permanently destroyed. Requires confirm: true.",
      inputSchema: {
        id: z.string().describe("Folder id."),
        cascade: z
          .boolean()
          .optional()
          .describe("Also delete every subfolder and all content filed in the subtree."),
        ...confirmArg,
      },
    },
    safe(async (args) => {
      requireConfirm(
        args.confirm,
        args.cascade
          ? `delete folder ${args.id} AND all content inside it`
          : `delete folder ${args.id} (contents are promoted to its parent)`,
      );
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.cascade) {
          await client.removeWithQuery("/folders", args.id, { cascade: "true" });
          return text(`Deleted folder ${args.id} and everything filed inside it.`);
        }
        await client.remove("/folders", args.id);
        return text(`Deleted folder ${args.id}; its subfolders and contents moved to its parent.`);
      });
    }),
  );

  server.registerTool(
    "realm_move_to_folder",
    {
      title: "File content into a folder (or back to the root)",
      description:
        "Move one or more items of a list into a folder, or unfile them back to the root " +
        "with folderId null. Works for every foldered list: npcs, characters, journals, " +
        "scenes, sounds, images, tables, encounters, effects, decks, and any ruleset record " +
        "type (items, spells, …). Look ids up with `realm_find_records` / `realm_find_journals` " +
        "etc., and folder ids with `realm_list_folders`.",
      inputSchema: {
        type: folderTypeArg,
        ids: z.array(z.string()).min(1).describe("Ids of the items to move."),
        folderId: z
          .string()
          .nullable()
          .describe("Destination folder id, or null to unfile back to the root."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const scope = folderScopeFor(args.type);
      const client = session.client();
      return withAuthRecovery(async () => {
        // The backend does not validate folderId on items, and an id pointing at a
        // missing or wrong-list folder makes the item invisible in every listing —
        // it matches neither the root filter nor any real folder. Check first.
        if (args.folderId) {
          const folder = await client.get<FolderDoc>("/folders", args.folderId);
          if (
            folder.type !== scope.folderType ||
            (scope.recordType && folder.recordType !== scope.recordType)
          ) {
            return text(
              `Folder ${args.folderId} ("${folder.name}") belongs to the ` +
                `${folder.recordType ?? folder.type} list, not ${args.type}. ` +
                `Items can only be filed into their own list's folders — ` +
                `use realm_list_folders type "${args.type}" to pick one.`,
            );
          }
        }

        // Unfiling must $unset: the schemas type folderId as an optional string
        // (null fails validation), and a null would still satisfy $exists anyway.
        const patch = args.folderId
          ? { folderId: args.folderId }
          : { $unset: { folderId: "" } };

        const moved: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const id of args.ids) {
          try {
            await client.patch(scope.servicePath, id, patch);
            moved.push(id);
          } catch (err) {
            failed.push({ id, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return json({
          destination: args.folderId ?? "root",
          moved: moved.length,
          ...(failed.length ? { failed } : {}),
        });
      });
    }),
  );
}
