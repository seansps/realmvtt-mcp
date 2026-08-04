import { describe, expect, it } from "vitest";
import { BUILT_IN_EFFECT_TYPES, buildRecordLink, mergeEffectTypes } from "./records.js";

describe("buildRecordLink", () => {
  it("links a cell to another table — the mechanism for tables that roll on tables", () => {
    expect(buildRecordLink({ type: "tables", id: "t1", name: "Treasure" })).toEqual({
      type: "tables",
      tooltip: "Treasure",
      value: { _id: "t1", name: "Treasure" },
    });
  });

  it("carries recordType for ruleset-defined types, which all share the records service", () => {
    expect(
      buildRecordLink({ type: "records", id: "i1", name: "Longsword", recordType: "items" }),
    ).toEqual({
      type: "records",
      tooltip: "Longsword",
      value: { _id: "i1", name: "Longsword", recordType: "items" },
    });
  });

  it("omits recordType on services that don't need it", () => {
    const link = buildRecordLink({ type: "npcs", id: "n1", name: "Wolf", recordType: "npcs" });
    expect(link.value).toEqual({ _id: "n1", name: "Wolf" });
  });

  it("stores only identifying fields — a table row must not carry a whole record", () => {
    const link = buildRecordLink({ type: "npcs", id: "n1", name: "Wolf" });
    expect(Object.keys(link.value as object).sort()).toEqual(["_id", "name"]);
  });
});

/**
 * The conventions these guard are Realm's, not ours — they're re-asserted here so a
 * future edit to the tool descriptions can't quietly drift from the app's behaviour.
 */
describe("table cell conventions", () => {
  const MULTIPLIER = /^\s*\[[^\]]*x\]/i;

  it("treats a trailing x as the multiplier prefix", () => {
    expect(MULTIPLIER.test("[2x] gemstones")).toBe(true);
    expect(MULTIPLIER.test("[1d4x] trinkets")).toBe(true);
  });

  it("does not treat plain inline dice as a multiplier", () => {
    expect(MULTIPLIER.test("You find [2d6] gold pieces")).toBe(false);
    expect(MULTIPLIER.test("[1d4] rations")).toBe(false);
  });

  it("only matches a multiplier at the START of the text", () => {
    expect(MULTIPLIER.test("gemstones [2x]")).toBe(false);
  });
});

describe("encounter count conventions", () => {
  // Realm resolves `*` and `/` by numeric substitution BEFORE rolling, so a die on
  // the left of an operator is silently absorbed: "1d4*3" becomes "1d12".
  const DICE_BEFORE_OPERATOR = /\d*d\d+\s*[*/]/i;

  it("flags a die on the left of an operator", () => {
    expect(DICE_BEFORE_OPERATOR.test("1d4*$PC")).toBe(true);
    expect(DICE_BEFORE_OPERATOR.test("2d6 / 2")).toBe(true);
  });

  it("accepts the forms that actually work", () => {
    for (const ok of ["1", "6", "1d6", "1d4+1", "2d4", "3*$PC", "$PC", "#PC", "$PC/2"]) {
      expect(DICE_BEFORE_OPERATOR.test(ok)).toBe(false);
    }
  });
});

describe("mergeEffectTypes", () => {
  // Regression: the tool used to read `ruleset.effects`, but the ruleset schema puts
  // them under `settings.effects` (the client reads `selectedRuleset?.settings?.effects`).
  // Every ruleset therefore reported "declares no extra effect types".
  it("reads the declared types from settings.effects", () => {
    const types = mergeEffectTypes({
      settings: {
        effects: [
          {
            label: "Circumstance Penalty",
            type: "cir_pen",
            fields: [{ label: "Armor Class", field: "data.ac" }],
          },
        ],
      },
    });
    expect(types[0]).toEqual({
      type: "cir_pen",
      label: "Circumstance Penalty",
      source: "ruleset",
      freeTextField: false,
      fields: [{ field: "data.ac", label: "Armor Class" }],
    });
    expect(types).toHaveLength(BUILT_IN_EFFECT_TYPES.length + 1);
  });

  it("ignores a stray top-level effects array — that path is not the app's", () => {
    const types = mergeEffectTypes({ effects: [{ label: "Nope", type: "nope" }] } as never);
    expect(types.every((t) => t.source === "built-in")).toBe(true);
  });

  it("lets a ruleset redefine a built-in instead of listing it twice", () => {
    const types = mergeEffectTypes({
      settings: { effects: [{ label: "Change the Mini", type: "token", freeTextField: true }] },
    });
    expect(types.filter((t) => t.type === "token")).toEqual([
      { type: "token", label: "Change the Mini", source: "ruleset", freeTextField: true, fields: [] },
    ]);
    expect(types).toHaveLength(BUILT_IN_EFFECT_TYPES.length);
  });

  it("falls back to the built-ins with no ruleset", () => {
    expect(mergeEffectTypes(null).map((t) => t.type)).toEqual(
      BUILT_IN_EFFECT_TYPES.map((t) => t.type),
    );
  });
});
