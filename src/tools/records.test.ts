import { describe, expect, it } from "vitest";
import { buildRecordLink } from "./records.js";

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
