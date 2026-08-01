/**
 * Folder manifests: declare where content should live, preview the difference,
 * then apply it.
 *
 * ── Why there is no rollback ──────────────────────────────────────────────────
 * Filing an item is a PATCH on the item (`folderId`), not an operation on the
 * folder — so applying a manifest of 300 moves is 300 independent requests with
 * no transaction around them. A failure halfway leaves a half-moved tree, and a
 * "rollback" would be 300 more requests that can fail exactly the same way. There
 * is no honest way to offer atomicity over an API that does not have it.
 *
 * What is offered instead is an INVERSE MANIFEST: apply records every item's
 * previous `folderId` and returns a manifest that puts everything back. It is a
 * re-runnable undo the caller can inspect and keep, rather than a promise the
 * transport cannot keep. It is also produced for a partial apply — in fact that
 * is when it matters most.
 *
 * ── Idempotence is free ───────────────────────────────────────────────────────
 * A move is a patch to a TARGET VALUE, not a relative operation, so applying the
 * same manifest twice is the same as applying it once. `plan` reports moves that
 * are already satisfied as `unchanged` and does not re-issue them.
 *
 * ── The trap this exists to avoid ─────────────────────────────────────────────
 * The backend does NOT validate `folderId` on items. Filing something into an id
 * that does not exist, or into a folder belonging to a different list, is
 * accepted and makes the item invisible in the app. So planning resolves and
 * checks every destination BEFORE a single write.
 */
import type { Json } from "../api/client.js";
import type { FolderDoc } from "../tools/folders.js";

/** One line of a manifest: put this item at this folder path. */
export interface ManifestEntry {
  /** Item id. */
  id: string;
  /**
   * Slash-separated destination path (`Bestiary / Undead / Liches`). An empty
   * string or `root` means the tab's root level, which is an UNSET rather than a
   * null — see `plan`.
   */
  path: string;
}

export type MoveAction = "move" | "unchanged" | "create-folder" | "unresolved";

export interface PlannedMove {
  action: MoveAction;
  itemId: string;
  itemName?: string;
  fromPath: string;
  toPath: string;
  /** Resolved destination folder id; absent when moving to root. */
  toFolderId?: string;
  reason?: string;
}

export interface ManifestPlan {
  moves: PlannedMove[];
  /** Folder paths that must be created first, parents before children. */
  foldersToCreate: string[];
  /** Manifest entries naming an item that is not in this list. */
  unresolved: Array<{ id: string; path: string; reason: string }>;
  counts: { move: number; unchanged: number; unresolved: number; foldersToCreate: number };
}

export const ROOT_PATH = "";

/** Normalise a path so `A/B`, `A / B` and ` a / b ` are the same destination. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.toLowerCase() === "root") return ROOT_PATH;
  return trimmed
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" / ");
}

/** Breadcrumb for each folder id, matching `folderPathsById` but keyed both ways. */
function pathIndex(folders: FolderDoc[]): {
  idToPath: Map<string, string>;
  pathToId: Map<string, string>;
} {
  const byId = new Map(folders.map((f) => [String(f._id), f]));
  const idToPath = new Map<string, string>();

  const pathOf = (id: string, seen: Set<string>): string => {
    const cached = idToPath.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder) return "";
    if (seen.has(id)) return folder.name;
    seen.add(id);
    const parent = folder.parentId ? byId.get(String(folder.parentId)) : undefined;
    const full = parent ? `${pathOf(String(parent._id), seen)} / ${folder.name}` : folder.name;
    idToPath.set(id, full);
    return full;
  };

  for (const f of folders) pathOf(String(f._id), new Set());

  // Later folders win a duplicate path only if the earlier one is a cycle
  // artefact; two genuinely identically-named siblings are a campaign problem the
  // audit reports, and picking the first keeps planning deterministic.
  const pathToId = new Map<string, string>();
  for (const [id, path] of idToPath) if (!pathToId.has(path)) pathToId.set(path, id);

  return { idToPath, pathToId };
}

/** Every ancestor path of a path, shallowest first (`A`, `A / B`, `A / B / C`). */
export function ancestorPaths(path: string): string[] {
  const parts = path.split(" / ").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join(" / "));
}

/**
 * Work out what applying a manifest would do, without doing any of it.
 *
 * Nothing is written and nothing is created; folders that would need creating are
 * listed in dependency order so the caller (or apply) can make them parents-first.
 */
export function planManifest(
  entries: ManifestEntry[],
  folders: FolderDoc[],
  items: Array<Json & { _id: string }>,
): ManifestPlan {
  const { idToPath, pathToId } = pathIndex(folders);
  const itemsById = new Map(items.map((i) => [String(i._id), i]));

  const moves: PlannedMove[] = [];
  const unresolved: ManifestPlan["unresolved"] = [];
  const needed = new Set<string>();

  for (const entry of entries) {
    const item = itemsById.get(entry.id);
    if (!item) {
      unresolved.push({
        id: entry.id,
        path: entry.path,
        reason:
          "No item with this id in this list. It may belong to a different content type, or " +
          "have been deleted.",
      });
      continue;
    }

    const toPath = normalizePath(entry.path);
    const fromPath = item.folderId ? (idToPath.get(String(item.folderId)) ?? "(missing folder)") : ROOT_PATH;
    const name = item.name ? String(item.name) : undefined;

    if (fromPath === toPath) {
      moves.push({
        action: "unchanged",
        itemId: entry.id,
        itemName: name,
        fromPath,
        toPath,
        ...(item.folderId ? { toFolderId: String(item.folderId) } : {}),
      });
      continue;
    }

    if (toPath === ROOT_PATH) {
      moves.push({ action: "move", itemId: entry.id, itemName: name, fromPath, toPath });
      continue;
    }

    const existing = pathToId.get(toPath);
    if (existing) {
      moves.push({
        action: "move",
        itemId: entry.id,
        itemName: name,
        fromPath,
        toPath,
        toFolderId: existing,
      });
      continue;
    }

    // Destination does not exist yet. Every missing ancestor has to be created
    // too, or the new folder would be parented to nothing.
    for (const ancestor of ancestorPaths(toPath)) {
      if (!pathToId.has(ancestor)) needed.add(ancestor);
    }
    moves.push({
      action: "create-folder",
      itemId: entry.id,
      itemName: name,
      fromPath,
      toPath,
      reason: `Folder "${toPath}" does not exist yet and would be created.`,
    });
  }

  // Shallowest first, so a parent is always created before its child.
  const foldersToCreate = [...needed].sort((a, b) => a.split(" / ").length - b.split(" / ").length);

  return {
    moves,
    foldersToCreate,
    unresolved,
    counts: {
      move: moves.filter((m) => m.action === "move" || m.action === "create-folder").length,
      unchanged: moves.filter((m) => m.action === "unchanged").length,
      unresolved: unresolved.length,
      foldersToCreate: foldersToCreate.length,
    },
  };
}

/**
 * The manifest that undoes an applied one.
 *
 * Built from where each item WAS, so replaying it restores the previous filing.
 * Items that were at root come back as `root`, which apply turns into the
 * `$unset` the backend needs — a null `folderId` would match neither the root
 * listing nor any folder, hiding the item instead of unfiling it.
 */
export function inverseManifest(applied: PlannedMove[]): ManifestEntry[] {
  return applied
    .filter((m) => m.action === "move" || m.action === "create-folder")
    .map((m) => ({ id: m.itemId, path: m.fromPath === ROOT_PATH ? "root" : m.fromPath }));
}
