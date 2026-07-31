import { describe, expect, it } from "vitest";
import { DEDICATED_FOLDER_TYPES, folderPathsById, folderScopeFor } from "./folders.js";

describe("folderScopeFor", () => {
  it("maps dedicated lists to their own service", () => {
    expect(folderScopeFor("journals")).toEqual({
      folderType: "journals",
      servicePath: "/journals",
    });
    expect(folderScopeFor("npcs")).toEqual({ folderType: "npcs", servicePath: "/npcs" });
  });

  it("maps ruleset record types onto the shared /records tree", () => {
    expect(folderScopeFor("spells")).toEqual({
      folderType: "records",
      recordType: "spells",
      servicePath: "/records",
    });
  });

  it("normalizes case and whitespace", () => {
    expect(folderScopeFor(" Scenes ").folderType).toBe("scenes");
  });

  // Each record type has its own tree, so a bare `records` scope is ambiguous —
  // filing into it would put spell folders in the item tab.
  it("rejects the literal `records`", () => {
    expect(() => folderScopeFor("records")).toThrow(/record type itself/);
  });

  it("covers every backend folder type except records", () => {
    // Mirror of the backend's FOLDER_TYPES; if a list is added there, add it here.
    expect([...DEDICATED_FOLDER_TYPES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });
});

describe("folderPathsById", () => {
  it("builds breadcrumbs through nested parents", () => {
    const paths = folderPathsById([
      { _id: "a", name: "Bestiary" },
      { _id: "b", name: "Undead", parentId: "a" },
      { _id: "c", name: "Liches", parentId: "b" },
    ]);
    expect(paths.c).toBe("Bestiary / Undead / Liches");
    expect(paths.a).toBe("Bestiary");
  });

  it("treats a missing parent as a root rather than dropping the folder", () => {
    const paths = folderPathsById([{ _id: "x", name: "Orphan", parentId: "gone" }]);
    expect(paths.x).toBe("Orphan");
  });

  it("survives a parent cycle instead of hanging", () => {
    const paths = folderPathsById([
      { _id: "a", name: "A", parentId: "b" },
      { _id: "b", name: "B", parentId: "a" },
    ]);
    expect(paths.a).toContain("A");
    expect(paths.b).toContain("B");
  });
});
