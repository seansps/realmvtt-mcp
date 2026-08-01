import { describe, expect, it } from "vitest";
import type { FolderDoc } from "../tools/folders.js";
import {
  ancestorPaths,
  inverseManifest,
  normalizePath,
  planManifest,
  ROOT_PATH,
} from "./manifest.js";

const folders: FolderDoc[] = [
  { _id: "f1", name: "Bestiary" },
  { _id: "f2", name: "Undead", parentId: "f1" },
  { _id: "f3", name: "Loose" },
];

const items = [
  { _id: "i1", name: "Lich", folderId: "f2" },
  { _id: "i2", name: "Goblin", folderId: "f1" },
  { _id: "i3", name: "Unfiled Thing" },
];

describe("normalizePath", () => {
  it("treats spacing variants as the same destination", () => {
    expect(normalizePath("A/B")).toBe("A / B");
    expect(normalizePath("  A  /  B  ")).toBe("A / B");
    expect(normalizePath("A / B")).toBe("A / B");
  });

  it("maps the several ways of saying 'root' onto one value", () => {
    expect(normalizePath("")).toBe(ROOT_PATH);
    expect(normalizePath("root")).toBe(ROOT_PATH);
    expect(normalizePath("  ROOT ")).toBe(ROOT_PATH);
  });
});

describe("ancestorPaths", () => {
  it("lists ancestors shallowest first, so parents get created before children", () => {
    expect(ancestorPaths("A / B / C")).toEqual(["A", "A / B", "A / B / C"]);
  });
});

describe("planManifest", () => {
  it("plans a move into an existing folder and resolves its id", () => {
    const plan = planManifest([{ id: "i2", path: "Bestiary / Undead" }], folders, items);
    expect(plan.moves[0]).toMatchObject({
      action: "move",
      itemId: "i2",
      fromPath: "Bestiary",
      toPath: "Bestiary / Undead",
      toFolderId: "f2",
    });
  });

  // Idempotence: a move is a patch to a target value, so re-applying the same
  // manifest must be a no-op rather than a second round of writes.
  it("reports an item already at its destination as unchanged", () => {
    const plan = planManifest([{ id: "i1", path: "Bestiary / Undead" }], folders, items);
    expect(plan.moves[0]?.action).toBe("unchanged");
    expect(plan.counts.move).toBe(0);
    expect(plan.counts.unchanged).toBe(1);
  });

  it("plans every missing ancestor of a new destination, parents first", () => {
    const plan = planManifest([{ id: "i2", path: "New / Deep / Place" }], folders, items);
    expect(plan.foldersToCreate).toEqual(["New", "New / Deep", "New / Deep / Place"]);
    expect(plan.moves[0]?.action).toBe("create-folder");
  });

  it("does not re-create an ancestor that already exists", () => {
    const plan = planManifest([{ id: "i2", path: "Bestiary / Dragons" }], folders, items);
    expect(plan.foldersToCreate).toEqual(["Bestiary / Dragons"]);
  });

  it("plans a move to root", () => {
    const plan = planManifest([{ id: "i1", path: "root" }], folders, items);
    expect(plan.moves[0]).toMatchObject({ action: "move", toPath: ROOT_PATH });
    expect(plan.moves[0]?.toFolderId).toBeUndefined();
  });

  // The whole reason preview exists: the backend does not validate folderId, so
  // an unresolvable entry must be caught before anything is written.
  it("reports an entry whose item is not in this list instead of planning a write", () => {
    const plan = planManifest([{ id: "nope", path: "Bestiary" }], folders, items);
    expect(plan.moves).toHaveLength(0);
    expect(plan.unresolved[0]).toMatchObject({ id: "nope" });
    expect(plan.unresolved[0]?.reason).toMatch(/different content type|deleted/);
  });

  it("describes an item filed into a folder that no longer exists", () => {
    const plan = planManifest(
      [{ id: "orphan", path: "Bestiary" }],
      folders,
      [...items, { _id: "orphan", name: "Ghost", folderId: "deleted" }],
    );
    expect(plan.moves[0]).toMatchObject({ fromPath: "(missing folder)", action: "move" });
  });
});

describe("inverseManifest", () => {
  it("sends each item back where it came from", () => {
    const plan = planManifest(
      [
        { id: "i2", path: "Bestiary / Undead" },
        { id: "i3", path: "Loose" },
      ],
      folders,
      items,
    );
    expect(inverseManifest(plan.moves)).toEqual([
      { id: "i2", path: "Bestiary" },
      { id: "i3", path: "root" },
    ]);
  });

  // Unfiling needs an explicit `root`, which apply turns into a $unset. A null
  // folderId matches neither the root listing nor any folder, so it would hide
  // the item rather than restore it.
  it("expresses 'was at root' as root, not as an empty path", () => {
    const plan = planManifest([{ id: "i3", path: "Bestiary" }], folders, items);
    expect(inverseManifest(plan.moves)).toEqual([{ id: "i3", path: "root" }]);
  });

  it("ignores unchanged entries, so undoing a no-op does nothing", () => {
    const plan = planManifest([{ id: "i1", path: "Bestiary / Undead" }], folders, items);
    expect(inverseManifest(plan.moves)).toEqual([]);
  });

  // A partial apply is exactly when the undo matters, so the inverse is built
  // from what SUCCEEDED, not from what was planned.
  it("covers only the moves it is given, so a partial apply undoes cleanly", () => {
    const plan = planManifest(
      [
        { id: "i1", path: "Loose" },
        { id: "i2", path: "Loose" },
      ],
      folders,
      items,
    );
    const succeeded = plan.moves.slice(0, 1);
    expect(inverseManifest(succeeded)).toEqual([{ id: "i1", path: "Bestiary / Undead" }]);
  });
});
