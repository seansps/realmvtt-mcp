import { describe, expect, it } from "vitest";
import { compactAsset, sceneTypeOf, toModel3D } from "./scenes3d.js";

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
