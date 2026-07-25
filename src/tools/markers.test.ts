import { describe, expect, it } from "vitest";
import { centerOfObjects, markersOn } from "./markers.js";

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
