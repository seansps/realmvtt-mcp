import { describe, expect, it } from "vitest";
import { CHUNK, compactAsset, resolveRot, rotFacing, sceneTypeOf, toModel3D } from "./scenes3d.js";

/**
 * A scene has no `renderer` field — its type is `sceneType` on the ACTIVE LAYER.
 * Reading `scene.renderer` returns undefined for everything, so every scene looked
 * like a 2D map and the 3D tools refused perfectly good 3D scenes.
 */
describe("sceneTypeOf", () => {
  it("recognises a real 3D scene", () => {
    // The exact document that was misreported as 2D.
    expect(
      sceneTypeOf({
        name: "Test3D",
        activeLayer: 0,
        layers: [
          {
            sceneType: "3d",
            cubeUnits: { size: 5 },
            unitsPerSquare: 5,
            units: "feet",
            gridType: "square",
            vision: true,
          },
        ],
      }),
    ).toBe("3d");
  });

  it("never trusts a `renderer` field, which does not exist on scenes", () => {
    expect(sceneTypeOf({ renderer: "standard", layers: [{ sceneType: "3d" }] })).toBe("3d");
  });

  it("reads the ACTIVE layer, not always the first", () => {
    const scene = { activeLayer: 1, layers: [{ sceneType: "standard" }, { sceneType: "3d" }] };
    expect(sceneTypeOf(scene)).toBe("3d");
  });

  it("falls back to the first layer when activeLayer points nowhere", () => {
    expect(sceneTypeOf({ activeLayer: 7, layers: [{ sceneType: "3d" }] })).toBe("3d");
  });

  it("treats a legacy canvas layer as canvas", () => {
    expect(sceneTypeOf({ layers: [{ isCanvasMode: true }] })).toBe("canvas");
  });

  it("treats a legacy image layer as standard", () => {
    expect(sceneTypeOf({ layers: [{ url: "/images/map.png" }] })).toBe("standard");
    expect(sceneTypeOf({ layers: [{ isCanvasMode: false }] })).toBe("standard");
  });

  it("prefers an explicit sceneType over the legacy isCanvasMode flag", () => {
    expect(sceneTypeOf({ layers: [{ sceneType: "3d", isCanvasMode: true }] })).toBe("3d");
  });

  it("degrades to standard for a scene with no layers at all", () => {
    expect(sceneTypeOf({})).toBe("standard");
    expect(sceneTypeOf({ layers: [] })).toBe("standard");
  });

  it("ignores an unrecognised sceneType rather than passing it through", () => {
    expect(sceneTypeOf({ layers: [{ sceneType: "hologram" }] })).toBe("standard");
  });
});

describe("toModel3D", () => {
  it("normalises modelPath to a leading slash — the catalog stores it without one", () => {
    expect(toModel3D({ assetId: "goblin", name: "Goblin", modelPath: "3d/tokens/goblin.glb" }).url).toBe(
      "/3d/tokens/goblin.glb",
    );
    expect(toModel3D({ assetId: "g", name: "G", modelPath: "/3d/tokens/g.glb" }).url).toBe(
      "/3d/tokens/g.glb",
    );
  });

  it("carries the catalog's own defaults so the mini renders as authored", () => {
    expect(
      toModel3D({
        assetId: "ogre",
        name: "Ogre",
        modelPath: "3d/tokens/ogre.glb",
        baseScale: 1.4,
        usePedestal: false,
        frontFaceDeg: 180,
        offsetX: 0.1,
        offsetZ: -0.2,
        offsetY: 0.05,
      }),
    ).toEqual({
      url: "/3d/tokens/ogre.glb",
      catalogId: "ogre",
      baseScale: 1.4,
      usePedestal: false,
      frontFaceDeg: 180,
      offsetX: 0.1,
      offsetZ: -0.2,
      offsetY: 0.05,
    });
  });

  it("omits defaults the catalog didn't set, rather than inventing zeros", () => {
    const model = toModel3D({ assetId: "g", name: "G", modelPath: "a.glb" });
    expect(Object.keys(model).sort()).toEqual(["catalogId", "url"]);
  });

  it("keeps usePedestal:false, which a truthiness check would drop", () => {
    expect(toModel3D({ assetId: "g", name: "G", modelPath: "a.glb", usePedestal: false })).toHaveProperty(
      "usePedestal",
      false,
    );
  });

  it("records provenance so the record knows which catalog entry it came from", () => {
    expect(toModel3D({ assetId: "wolf", name: "Wolf", modelPath: "a.glb" }).catalogId).toBe("wolf");
  });
});

describe("compactAsset", () => {
  it("keeps the fields that drive placement and drops texture bulk", () => {
    const row = compactAsset({
      assetId: "stone-wall",
      name: "Stone Wall",
      kind: "tile",
      role: "wall",
      category: "fantasy/dungeon",
      depth: 0.65,
      family: "fantasy-stone",
      familyThickness: "standard",
      modelPath: "3d/walls/stone.glb",
      material: { map: "…", normalMap: "…" },
    } as never);

    expect(row).toMatchObject({
      assetId: "stone-wall",
      role: "wall",
      depth: 0.65,
      family: "fantasy-stone",
      familyThickness: "standard",
    });
    expect(row).not.toHaveProperty("material");
    expect(row).not.toHaveProperty("noModel");
  });

  it("flags an asset with no GLB, since that renders as nothing", () => {
    expect(compactAsset({ assetId: "roof-tex", name: "Roof", kind: "tile", role: "roof" })).toHaveProperty(
      "noModel",
      true,
    );
  });

  it("keeps the light blob — a lit prop must copy it onto its placement", () => {
    const row = compactAsset({
      assetId: "torch",
      name: "Torch",
      kind: "prop",
      modelPath: "a.glb",
      light: { color: "#ffd9a0", intensity: 3, range: 4 },
    });
    expect(row.light).toEqual({ color: "#ffd9a0", intensity: 3, range: 4 });
  });
});

describe("bulk placement", () => {
  it("sends a whole scene in one request", async () => {
    // A town-sized build (~3,300 objects) is well under the server's 50MB body
    // limit, and scene-objects-3d declares multi-create for exactly this reason.
    const townSized = 3264;
    expect(Math.ceil(townSized / CHUNK)).toBe(1);
  });

  it("keeps a full chunk comfortably inside the 50MB JSON limit", () => {
    const object = {
      campaignId: "6880ee122b69e12313666f40",
      sceneId: "6a584936fe3d14db5aed27e3",
      layerIndex: 0,
      kind: "tile",
      assetId: "fantasy-stone-floor",
      pos: { x: 12, y: 7, z: 0.45 },
      rot: 6,
      blocksVision: true,
    };
    const bytes = JSON.stringify(object).length * CHUNK;
    expect(bytes).toBeLessThan(50 * 1024 * 1024 * 0.1); // under a tenth of the limit
  });
});

/**
 * The recurring 180° bug: chairs facing away from their table. The mapping is
 * counter-intuitive because props are baked front = −Z and the ROT_* names refer to
 * the wall EDGE a piece hugs, not where it looks — so hand-derivation inverts.
 */
describe("rotFacing", () => {
  it("maps a facing direction to the byte the renderer expects", () => {
    expect(rotFacing(0, -1)).toBe(0); // front points −y
    expect(rotFacing(-1, 0)).toBe(6); // front points −x
    expect(rotFacing(0, 1)).toBe(12); // front points +y
    expect(rotFacing(1, 0)).toBe(18); // front points +x
  });

  it("resolves a diagonal to the dominant axis, preferring y on a tie", () => {
    expect(rotFacing(0.3, -1)).toBe(0);
    expect(rotFacing(-1, 0.3)).toBe(6);
    expect(rotFacing(1, 1)).toBe(12); // |dy| >= |dx| → y wins
  });
});

describe("resolveRot", () => {
  const chairAt = (x: number, y: number) => ({
    kind: "prop",
    assetId: "chair",
    pos: { x, y, z: 0.45 },
    facing: { x: 5, y: 5 }, // the table
  });

  it("points a chair at its table from every side", () => {
    expect(resolveRot(chairAt(5, 6)).rot).toBe(0); // south of table → faces −y
    expect(resolveRot(chairAt(6, 5)).rot).toBe(6); // east of table  → faces −x
    expect(resolveRot(chairAt(5, 4)).rot).toBe(12); // north of table → faces +y
    expect(resolveRot(chairAt(4, 5)).rot).toBe(18); // west of table  → faces +x
  });

  it("strips `facing` so it never reaches the API", () => {
    const out = resolveRot(chairAt(5, 6));
    expect(out).not.toHaveProperty("facing");
    expect(out).toHaveProperty("assetId", "chair");
  });

  it("leaves an explicit rot alone when there's no facing", () => {
    const out = resolveRot({ kind: "prop", assetId: "barrel", pos: { x: 1, y: 1, z: 0 }, rot: 6 });
    expect(out.rot).toBe(6);
  });

  it("refuses a facing point identical to the object's own position", () => {
    expect(() =>
      resolveRot({ kind: "prop", assetId: "c", pos: { x: 2, y: 2, z: 0 }, facing: { x: 2, y: 2 } }),
    ).toThrow(/can't face its own position/);
  });

  it("requires a pos to face from", () => {
    expect(() => resolveRot({ kind: "prop", assetId: "c", facing: { x: 1, y: 1 } })).toThrow(
      /needs a `pos`/,
    );
  });
});
