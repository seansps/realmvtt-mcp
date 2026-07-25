import { describe, expect, it } from "vitest";
import { buildToken, has3dMini, reconcileWithScene, summarizeToken } from "./tokens.js";

const goblin = { _id: "n1", name: "Goblin" };

describe("buildToken", () => {
  it("instantiates a record at a grid square", () => {
    const token = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 19,
      y: 12,
    });

    expect(token).toMatchObject({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      recordType: "npcs",
      recordId: "n1",
      name: "Goblin",
      position: { x: 19, y: 12, z: 0 },
      rotation: 0,
      visible: true,
      linked: true,
    });
  });

  it("defaults z to 0 so a 2D token isn't accidentally elevated", () => {
    const token = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 1,
      y: 1,
    });
    expect((token.position as { z: number }).z).toBe(0);
  });

  it("carries elevation for an upstairs token", () => {
    const token = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 4,
      y: 4,
      z: 2.9,
    });
    expect((token.position as { z: number }).z).toBe(2.9);
  });

  it("lets one of a group be renamed without touching the record", () => {
    const token = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 1,
      y: 1,
      name: "Goblin Boss",
    });
    expect(token.name).toBe("Goblin Boss");
    expect(token.recordId).toBe("n1");
  });

  it("keeps an unidentified NPC unidentified", () => {
    const token = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: { _id: "n2", name: "Thing", identified: false, unidentifiedName: "Shambling Horror" },
      recordType: "npcs",
      x: 1,
      y: 1,
    });
    expect(token.identified).toBe(false);
    expect(token.unidentifiedName).toBe("Shambling Horror");
  });

  it("omits flying unless asked, so tokens don't float", () => {
    const grounded = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 1,
      y: 1,
    });
    expect(grounded).not.toHaveProperty("flying");

    const airborne = buildToken({
      campaignId: "c1",
      sceneId: "s1",
      layerIndex: 0,
      record: goblin,
      recordType: "npcs",
      x: 1,
      y: 1,
      flying: true,
    });
    expect(airborne.flying).toBe(true);
  });
});

describe("reconcileWithScene", () => {
  it("passes elevation and flying through on a 3D scene", () => {
    const out = reconcileWithScene("3d", { z: 2.9, flying: true });
    expect(out).toMatchObject({ z: 2.9, flying: true });
    expect(out.notes).toEqual([]);
  });

  it("drops elevation on a 2D scene and says so", () => {
    const out = reconcileWithScene("standard", { z: 2.9 });
    expect(out.z).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/2D.*ignored/i);
  });

  it("drops flying on a canvas scene and says so", () => {
    const out = reconcileWithScene("canvas", { flying: true });
    expect(out.flying).toBeUndefined();
    expect(out.notes.join(" ")).toMatch(/only applies in 3D/i);
  });

  it("stays quiet about z:0 on a 2D scene, which is what 2D means anyway", () => {
    expect(reconcileWithScene("standard", { z: 0 }).notes).toEqual([]);
  });
});

describe("has3dMini", () => {
  it("detects a record with a 3D model", () => {
    expect(has3dMini({ token: { model3D: { url: "/3d/tokens/goblin.glb" } } })).toBe(true);
  });

  it("treats a flat-token-only record as having no mini", () => {
    expect(has3dMini({ token: { imageUrl: "/images/goblin.png" } })).toBe(false);
    expect(has3dMini({ token: {} })).toBe(false);
    expect(has3dMini({})).toBe(false);
  });
});

describe("summarizeToken", () => {
  it("reports position and provenance without the record payload", () => {
    const row = summarizeToken({
      _id: "t1",
      name: "Goblin",
      recordType: "npcs",
      recordId: "n1",
      position: { x: 19, y: 12, z: 0 },
      visible: true,
      record: { huge: "payload" },
    } as never);

    expect(row).toMatchObject({ id: "t1", name: "Goblin", recordId: "n1" });
    expect(row).not.toHaveProperty("record");
  });
});
