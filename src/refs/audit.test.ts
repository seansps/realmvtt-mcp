import { describe, expect, it } from "vitest";
import type { FolderDoc } from "../tools/folders.js";
import { countItemsByFolder } from "../tools/folders.js";
import type { ReferenceIndex } from "./index.js";
import { DEFAULT_CHECKS, duplicateNames, emptyFolders, missingArt, orphanedFolderItems, runAudit } from "./audit.js";

function indexWith(docs: ReferenceIndex["docs"], refs: ReferenceIndex["refs"] = []): ReferenceIndex {
  return {
    campaignId: "c1",
    refs,
    docs,
    imagePathToId: new Map(),
    images: new Map(),
    pages: new Map(),
    pagesSkipped: 0,
    pagesFailed: 0,
    malformedLinkPages: [],
    assetRefs: [],
    notes: [],
  };
}

const doc = (
  id: string,
  name: string,
  extra: Partial<{ kind: string; folderId: string; moduleId: string }> = {},
) =>
  [
    id,
    {
      id,
      name,
      kind: (extra.kind ?? "npcs") as never,
      service: "/npcs",
      ...(extra.folderId ? { folderId: extra.folderId } : {}),
      ...(extra.moduleId ? { moduleId: extra.moduleId } : {}),
    },
  ] as const;

describe("duplicateNames", () => {
  it("flags same-named content in the same folder", () => {
    const index = indexWith(
      new Map([doc("a", "Guard", { folderId: "f1" }), doc("b", "Guard", { folderId: "f1" })]),
    );
    const found = duplicateNames(index);
    expect(found).toHaveLength(1);
    expect(found[0]?.summary).toContain("Guard");
    expect(found[0]?.detail).toContain("a, b");
  });

  // Two "Guard"s in different folders is ordinary organisation; only a collision
  // in one folder is the thing that makes a GM pick the wrong one mid-session.
  it("does not flag the same name in different folders", () => {
    const index = indexWith(
      new Map([doc("a", "Guard", { folderId: "f1" }), doc("b", "Guard", { folderId: "f2" })]),
    );
    expect(duplicateNames(index)).toEqual([]);
  });

  it("is case- and whitespace-insensitive", () => {
    const index = indexWith(new Map([doc("a", "Guard"), doc("b", " guard ")]));
    expect(duplicateNames(index)).toHaveLength(1);
  });

  // A campaign copy shadowing a module original is how overrides are meant to
  // work, so it must not be reported as a duplicate.
  it("ignores module-installed content", () => {
    const index = indexWith(new Map([doc("a", "Guard"), doc("b", "Guard", { moduleId: "m1" })]));
    expect(duplicateNames(index)).toEqual([]);
  });

  it("does not flag different kinds sharing a name", () => {
    const index = indexWith(new Map([doc("a", "Dragon"), doc("b", "Dragon", { kind: "scenes" })]));
    expect(duplicateNames(index)).toEqual([]);
  });
});

describe("missingArt", () => {
  const src = (id: string) => ({ kind: "record" as const, id, service: "/npcs" });

  it("reports an NPC with neither portrait nor token", () => {
    const index = indexWith(new Map([doc("a", "Goblin")]));
    const found = missingArt(index);
    expect(found[0]?.summary).toContain("no portrait and no token");
  });

  it("reports only what is actually missing", () => {
    const index = indexWith(new Map([doc("a", "Goblin")]), [
      { from: src("a"), to: { kind: "image-path", path: "/i/a.png" }, via: "portrait" },
    ]);
    expect(missingArt(index)[0]?.summary).toContain("no token");
    expect(missingArt(index)[0]?.summary).not.toContain("no portrait");
  });

  it("says nothing about a fully-illustrated record", () => {
    const index = indexWith(new Map([doc("a", "Goblin")]), [
      { from: src("a"), to: { kind: "image-path", path: "/i/a.png" }, via: "portrait" },
      { from: src("a"), to: { kind: "image-path", path: "/i/t.png" }, via: "token-image" },
    ]);
    expect(missingArt(index)).toEqual([]);
  });

  it("counts a 3D mini as token art", () => {
    const index = indexWith(new Map([doc("a", "Goblin")]), [
      { from: src("a"), to: { kind: "image-path", path: "/i/a.png" }, via: "portrait" },
      { from: src("a"), to: { kind: "model-path", path: "/3d/a.glb" }, via: "token-model" },
    ]);
    expect(missingArt(index)).toEqual([]);
  });

  it("ignores kinds that have no art, like scenes", () => {
    const index = indexWith(new Map([doc("s", "Tavern", { kind: "scenes" })]));
    expect(missingArt(index)).toEqual([]);
  });
});

describe("emptyFolders", () => {
  const tree = (folders: FolderDoc[], items: Array<{ folderId?: string }>) =>
    new Map([["npcs", { folders, counts: countItemsByFolder(folders, items) }]]);

  // The load-bearing case: a folder whose only job is holding subfolders full of
  // monsters has direct: 0 and is NOT empty.
  it("does not call a parent empty when its children hold content", () => {
    const folders: FolderDoc[] = [
      { _id: "p", name: "Bestiary" },
      { _id: "c", name: "Undead", parentId: "p" },
    ];
    const found = emptyFolders({
      index: indexWith(new Map()),
      recordTypes: [],
      folders: tree(folders, [{ folderId: "c" }]),
    });
    expect(found).toEqual([]);
  });

  it("flags a folder with nothing anywhere beneath it", () => {
    const folders: FolderDoc[] = [{ _id: "e", name: "Abandoned" }];
    const found = emptyFolders({
      index: indexWith(new Map()),
      recordTypes: [],
      folders: tree(folders, []),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.summary).toContain("Abandoned");
  });

  it("leaves module-provided folders alone", () => {
    const folders: FolderDoc[] = [{ _id: "e", name: "Module Folder", moduleId: "m1" }];
    expect(
      emptyFolders({ index: indexWith(new Map()), recordTypes: [], folders: tree(folders, []) }),
    ).toEqual([]);
  });
});

describe("orphanedFolderItems", () => {
  // These are invisible in the app — neither the root listing nor any folder
  // matches them — which is why this is an error rather than a note.
  it("reports items filed into a folder that no longer exists, as an error", () => {
    const folders: FolderDoc[] = [{ _id: "f1", name: "Real" }];
    const found = orphanedFolderItems({
      index: indexWith(new Map()),
      recordTypes: [],
      folders: new Map([
        ["npcs", { folders, counts: countItemsByFolder(folders, [{ folderId: "deleted" }]) }],
      ]),
    });
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.detail).toContain("invisible");
  });
});

describe("runAudit", () => {
  it("runs only the checks it was asked for", () => {
    const index = indexWith(new Map([doc("a", "Guard"), doc("b", "Guard")]));
    const dupOnly = runAudit({ index, recordTypes: [], folders: new Map() }, ["duplicate-names"]);
    expect(dupOnly.every((f) => f.check === "duplicate-names")).toBe(true);

    const artOnly = runAudit({ index, recordTypes: [], folders: new Map() }, ["missing-art"]);
    expect(artOnly.every((f) => f.check === "missing-art")).toBe(true);
  });

  it("sorts errors before warnings before info", () => {
    const folders: FolderDoc[] = [{ _id: "f1", name: "Real" }];
    const found = runAudit(
      {
        index: indexWith(new Map([doc("a", "Guard"), doc("b", "Guard")])),
        recordTypes: [],
        folders: new Map([
          ["npcs", { folders, counts: countItemsByFolder(folders, [{ folderId: "gone" }]) }],
        ]),
      },
      ["duplicate-names", "missing-art", "orphaned-folder-items"],
    );
    const severities = found.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) =>
      ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b],
    ));
    expect(severities[0]).toBe("error");
  });

  it("gives every finding a stable id, so two runs can be diffed", () => {
    const index = indexWith(new Map([doc("a", "Guard"), doc("b", "Guard")]));
    const first = runAudit({ index, recordTypes: [], folders: new Map() }, ["duplicate-names"]);
    const second = runAudit({ index, recordTypes: [], folders: new Map() }, ["duplicate-names"]);
    expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
  });

  // Measured on a real campaign these two produce 200+ non-defects that bury the
  // dozen findings that mean something is actually broken.
  it("leaves the noisy checks out of the default set", () => {
    expect(DEFAULT_CHECKS).not.toContain("stale-labels");
    expect(DEFAULT_CHECKS).not.toContain("unlinked-images");
    expect(DEFAULT_CHECKS).toContain("broken-links");
  });
});
