import { describe, expect, it } from "vitest";
import {
  cavePathAssetsFrom,
  cavePathStartPort,
  densifyRoute,
  effectiveShape,
  fitCavePath,
  placementsAt,
  wallBaseId,
  wallShapeFromId,
  wallShapePorts,
} from "./cavePath.js";

/** A full 9-piece cave set, named the way the generator names them. */
const caveSet = [
  { id: "cave-rock", depth: 0.65 },
  { id: "cave-rock-wave", depth: 0.65 },
  { id: "cave-rock-wave2", depth: 0.65 },
  { id: "cave-rock-round", depth: 0.65 },
  { id: "cave-rock-diag", depth: 0.65 },
  { id: "cave-rock-bend", depth: 0.65 },
  { id: "cave-rock-bendb", depth: 0.65 },
  { id: "cave-rock-bendin", depth: 0.65 },
  { id: "cave-rock-bendinb", depth: 0.65 },
];

/** An ordinary room wall family: a straight wall and its door/window, no bends. */
const roomSet = [
  { id: "fantasy-stone-wall", depth: 0.65 },
  { id: "fantasy-stone-door", depth: 0.65 },
  { id: "fantasy-stone-window", depth: 0.65 },
];

describe("shape identification", () => {
  it("reads a shape off the id suffix, longest-first", () => {
    expect(wallShapeFromId("cave-rock-bendinb")).toBe("bend_in_mirror");
    expect(wallShapeFromId("cave-rock-bendin")).toBe("bend_in");
    expect(wallShapeFromId("cave-rock-bendb")).toBe("bend_mirror");
    expect(wallShapeFromId("cave-rock-bend")).toBe("bend");
  });

  it("treats a plain wall as shapeless (a straight, edge-hugging piece)", () => {
    expect(wallShapeFromId("cave-rock")).toBeUndefined();
    expect(effectiveShape({ id: "cave-rock" })).toBeUndefined();
  });

  it("prefers a doc's own shape over the id suffix", () => {
    expect(effectiveShape({ id: "anything", shape: "diag" })).toBe("diag");
  });

  it("strips the suffix to find the family base", () => {
    expect(wallBaseId("cave-rock-bendinb")).toBe("cave-rock");
    expect(wallBaseId("cave-rock")).toBe("cave-rock");
  });
});

describe("cavePathAssetsFrom", () => {
  it("sorts a cave set into its roles", () => {
    const set = cavePathAssetsFrom(caveSet)!;
    expect(set.straight?.id).toBe("cave-rock");
    expect(set.waves).toHaveLength(2);
    expect(set.bends).toHaveLength(4); // FOUR bends — the mirror/inward pairs
    expect(set.diag?.id).toBe("cave-rock-diag");
    expect(set.round?.id).toBe("cave-rock-round");
  });

  /**
   * The guard that keeps caves and rooms from being confused. An ordinary wall
   * family has no bends, so cave chaining doesn't apply and the caller is told to
   * use plain per-edge walls instead.
   */
  it("rejects an ordinary room wall family", () => {
    expect(cavePathAssetsFrom(roomSet)).toBeNull();
  });
});

describe("port geometry", () => {
  it("gives a straight wall entry and exit ports on opposite cell edges", () => {
    const ports = wallShapePorts(undefined, 0.65)!;
    expect(ports.entry.p.x).toBe(-0.5);
    expect(ports.exit.p.x).toBe(0.5);
    expect(ports.entry.t).toEqual(ports.exit.t); // straight through
  });

  it("gives a diagonal a 45° tangent", () => {
    const ports = wallShapePorts("diag", 0.65)!;
    expect(Math.abs(ports.entry.t.x)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(ports.entry.t.z)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("turns each of the four bends a different way", () => {
    const exits = (["bend", "bend_mirror", "bend_in", "bend_in_mirror"] as const).map(
      (s) => wallShapePorts(s, 0.65)!.exit.p.x,
    );
    // The mirror/inward pairs must not all leave over the same corner, or a
    // zigzag would be impossible.
    expect(new Set(exits).size).toBeGreaterThan(1);
  });

  it("has no ports for the junction fillers, which have no defined run", () => {
    expect(wallShapePorts("filler", 0.65)).toBeNull();
    expect(wallShapePorts("corner", 0.65)).toBeNull();
  });
});

describe("placementsAt", () => {
  it("only accepts placements that land exactly on the grid", () => {
    const port = cavePathStartPort({ x: 0, y: 0 }, 12, 1, 0.65);
    for (const fit of placementsAt({ id: "cave-rock", depth: 0.65 }, port)) {
      expect(Number.isInteger(fit.cell.x)).toBe(true);
      expect(Number.isInteger(fit.cell.y)).toBe(true);
      expect(fit.rot % 6).toBe(0); // walls are 90° multiples
    }
  });

  it("finds a placement for a straight piece on a fresh run", () => {
    const port = cavePathStartPort({ x: 5, y: 5 }, 12, 1, 0.65);
    expect(placementsAt({ id: "cave-rock", depth: 0.65 }, port).length).toBeGreaterThan(0);
  });
});

describe("densifyRoute", () => {
  it("fills gaps 8-way, so diagonals are first-class", () => {
    const filled = densifyRoute([
      { x: 0, y: 0 },
      { x: 3, y: 3 },
    ]);
    expect(filled).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it("leaves a single-point route alone", () => {
    expect(densifyRoute([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
  });
});

describe("fitCavePath", () => {
  const set = cavePathAssetsFrom(caveSet)!;
  const shapesUsed = (pieces: Array<{ assetId: string }>) =>
    new Set(pieces.map((p) => effectiveShape({ id: p.assetId }) ?? "straight"));

  it("chains a straight run", () => {
    const route = Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0 }));
    const pieces = fitCavePath(route, set, cavePathStartPort(route[0]!, 12, 1, 0.65), 0);
    expect(pieces.length).toBeGreaterThan(0);
    for (const p of pieces) expect(Number.isInteger(p.cell.x)).toBe(true);
  });

  /**
   * The bug this whole module exists to fix: a cave built only from straight
   * pieces reads as a blocky stair-step. A winding route must actually produce
   * curved geometry.
   */
  it("produces CURVED pieces on a winding route, not just straights", () => {
    const route = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 8, y: 4 },
      { x: 8, y: 9 },
      { x: 4, y: 13 },
    ];
    const pieces = fitCavePath(route, set, cavePathStartPort(route[0]!, 12, 1, 0.65), 0);

    expect(pieces.length).toBeGreaterThan(5);
    const shapes = shapesUsed(pieces);
    const curved = [...shapes].filter((s) => s !== "straight");
    expect(curved.length).toBeGreaterThan(0);
  });

  it("sprinkles waves through long straight runs so they aren't ruler-straight", () => {
    const route = Array.from({ length: 15 }, (_, i) => ({ x: i, y: 0 }));
    const withWaves = fitCavePath(route, set, cavePathStartPort(route[0]!, 12, 1, 0.65), 3);
    expect(shapesUsed(withWaves).has("wave")).toBe(true);

    const without = fitCavePath(route, set, cavePathStartPort(route[0]!, 12, 1, 0.65), 0);
    expect(shapesUsed(without).has("wave")).toBe(false);
  });

  it("keeps every piece on integer cells", () => {
    const route = [
      { x: 2, y: 2 },
      { x: 6, y: 6 },
      { x: 10, y: 4 },
    ];
    for (const p of fitCavePath(route, set, cavePathStartPort(route[0]!, 12, 1, 0.65))) {
      expect(Number.isInteger(p.cell.x)).toBe(true);
      expect(Number.isInteger(p.cell.y)).toBe(true);
    }
  });

  it("returns nothing rather than guessing when the set can't start", () => {
    const empty = { waves: [], bends: [{ id: "x-bend" }] };
    expect(fitCavePath([{ x: 0, y: 0 }, { x: 5, y: 0 }], empty, cavePathStartPort({ x: 0, y: 0 }, 12))).toEqual(
      [],
    );
  });
});
