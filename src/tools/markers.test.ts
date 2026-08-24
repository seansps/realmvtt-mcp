import { describe, expect, it } from "vitest";
import {
  centerOfObjects,
  journalLinksOn,
  markersOn,
  pageList,
  regionsOn,
  resolvePage,
} from "./markers.js";

describe("centerOfObjects", () => {
  it("finds the middle of a build so the pin frames it", () => {
    expect(
      centerOfObjects([
        { pos: { x: 10, y: 10, z: 0 } },
        { pos: { x: 20, y: 20, z: 0 } },
      ]),
    ).toEqual({ x: 15, y: 15, z: 0 });
  });

  it("uses the bounding box, not the mean, so a dense cluster doesn't drag the pin", () => {
    // Nine objects bunched at one end plus one far away: the mean would sit almost
    // on the cluster, framing half the map.
    const objects = [
      ...Array.from({ length: 9 }, () => ({ pos: { x: 0, y: 0, z: 0 } })),
      { pos: { x: 40, y: 40, z: 0 } },
    ];
    expect(centerOfObjects(objects)).toEqual({ x: 20, y: 20, z: 0 });
  });

  it("frames the lowest level, so a pin isn't left inside an upper wall", () => {
    expect(
      centerOfObjects([
        { pos: { x: 0, y: 0, z: 0 } },
        { pos: { x: 4, y: 4, z: 2.45 } },
      ]),
    ).toEqual({ x: 2, y: 2, z: 0 });
  });

  it("works for a scene built far from the origin — the case pins exist for", () => {
    expect(centerOfObjects([{ pos: { x: 40, y: 25, z: 0 } }])).toEqual({ x: 40, y: 25, z: 0 });
  });

  it("returns null for an empty scene rather than pinning nowhere", () => {
    expect(centerOfObjects([])).toBeNull();
    expect(centerOfObjects([{}, { pos: {} }])).toBeNull();
  });
});

describe("markersOn", () => {
  it("reads a layer's marker array", () => {
    const layer = { pins: [{ id: "p1", name: "Main", position: { x: 1, y: 1 } }] };
    expect(markersOn(layer, "pins")).toHaveLength(1);
  });

  it("treats a layer with no markers as empty rather than throwing", () => {
    expect(markersOn({}, "pins")).toEqual([]);
    expect(markersOn(undefined, "teleporters")).toEqual([]);
    expect(markersOn({ textBlocks: "not-an-array" }, "textBlocks")).toEqual([]);
  });
});

describe("regionsOn", () => {
  it("reads a layer's regions", () => {
    const layer = {
      regions: [
        {
          id: "r1",
          name: "Swamp",
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
          ],
          moveSpeedFactor: 0.5,
        },
      ],
    };
    expect(regionsOn(layer)).toHaveLength(1);
    expect(regionsOn(layer)[0]?.moveSpeedFactor).toBe(0.5);
  });

  it("treats a layer with no regions as empty rather than throwing", () => {
    expect(regionsOn({})).toEqual([]);
    expect(regionsOn(undefined)).toEqual([]);
    expect(regionsOn({ regions: "not-an-array" })).toEqual([]);
  });
});

describe("journalLinksOn", () => {
  it("reads a layer's journal links", () => {
    const layer = { journals: [{ id: "j1", name: "Rumours", position: { x: 3, y: 4 } }] };
    expect(journalLinksOn(layer)).toHaveLength(1);
  });

  it("keeps duplicate journal ids, which are normal — two markers into one journal", () => {
    const layer = {
      journals: [
        { id: "j1", pageNumber: 1, position: { x: 0, y: 0 } },
        { id: "j1", pageNumber: 4, position: { x: 9, y: 9 } },
      ],
    };
    expect(journalLinksOn(layer).map((j) => j.pageNumber)).toEqual([1, 4]);
  });

  it("treats a layer with no journals as empty rather than throwing", () => {
    expect(journalLinksOn({})).toEqual([]);
    expect(journalLinksOn(undefined)).toEqual([]);
    expect(journalLinksOn({ journals: "not-an-array" })).toEqual([]);
  });
});

describe("pageList", () => {
  it("accepts a bare array", () => {
    expect(pageList([{ pageNumber: 1 }])).toHaveLength(1);
  });

  it("unwraps a Feathers-paginated result", () => {
    expect(pageList({ total: 1, data: [{ pageNumber: 1 }] })).toHaveLength(1);
  });

  it("gives an empty list for anything else, so a lookup fails cleanly", () => {
    expect(pageList(null)).toEqual([]);
    expect(pageList(undefined)).toEqual([]);
    expect(pageList("nope")).toEqual([]);
  });
});

describe("resolvePage", () => {
  const pages = [
    { name: "Overview", pageNumber: 1 },
    { name: "Rumours", pageNumber: 2 },
    { name: "The Cellar", pageNumber: 3 },
  ];

  it("resolves a page by name, which is the form a caller can actually know", () => {
    expect(resolvePage(pages, "Rumours")).toEqual({ pageNumber: 2, pageName: "Rumours" });
  });

  it("matches a name case- and whitespace-insensitively", () => {
    expect(resolvePage(pages, "  the cellar ")).toEqual({ pageNumber: 3, pageName: "The Cellar" });
  });

  it("falls back to a partial name match before giving up", () => {
    expect(resolvePage(pages, "cellar")).toEqual({ pageNumber: 3, pageName: "The Cellar" });
  });

  it("prefers an exact match over a partial one", () => {
    const tricky = [
      { name: "Cellar Notes", pageNumber: 1 },
      { name: "Cellar", pageNumber: 2 },
    ];
    expect(resolvePage(tricky, "Cellar")).toEqual({ pageNumber: 2, pageName: "Cellar" });
  });

  it("returns null for an unknown name instead of silently linking page 1", () => {
    expect(resolvePage(pages, "Attic")).toBeNull();
  });

  it("takes a number as a page number and reports what it points at", () => {
    expect(resolvePage(pages, 3)).toEqual({ pageNumber: 3, pageName: "The Cellar" });
  });

  it("keeps a number outside the outline — the page may be added later", () => {
    expect(resolvePage(pages, 9)).toEqual({ pageNumber: 9, pageName: undefined });
  });

  it("reads a numeric string as a page number, not a page named '2'", () => {
    expect(resolvePage(pages, "2")).toEqual({ pageNumber: 2, pageName: "Rumours" });
  });

  it("still finds a page genuinely named with digits", () => {
    const numbered = [{ name: "2", pageNumber: 7 }];
    expect(resolvePage(numbered, "2")).toEqual({ pageNumber: 7, pageName: "2" });
  });

  it("defaults to page 1 when no page is asked for", () => {
    expect(resolvePage(pages, undefined)).toEqual({ pageNumber: 1, pageName: "Overview" });
    expect(resolvePage(pages, "")).toEqual({ pageNumber: 1, pageName: "Overview" });
  });

  it("defaults to page 1 for a journal whose outline didn't load", () => {
    expect(resolvePage([], undefined)).toEqual({ pageNumber: 1, pageName: undefined });
  });
});
