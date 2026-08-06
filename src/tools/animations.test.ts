import { describe, expect, it } from "vitest";
import {
  ANIMATIONS,
  DEFAULT_ANIMATION_PATH,
  DEFAULT_SOUNDS,
  buildAnimation,
  findAnimation,
  getByPath,
  isCustomAnimation,
  pathSegments,
  setByPath,
} from "./animations.js";

describe("the catalog", () => {
  it("mirrors the client's 25 built-in effects", () => {
    // If defaultAnimations.ts gains an entry this is the test that should fail.
    expect(ANIMATIONS).toHaveLength(25);
  });

  it("has no duplicate names, since the name is the stored key", () => {
    expect(new Set(ANIMATIONS.map((a) => a.name)).size).toBe(ANIMATIONS.length);
  });

  it("covers every motion, so each kind of spell has something to pick", () => {
    expect(new Set(ANIMATIONS.map((a) => a.motion))).toEqual(
      new Set(["projectile", "burst", "melee", "self"]),
    );
  });

  it("keeps the motions that matter for choosing an effect", () => {
    // These four anchor the guidance in the tool description; if the underlying
    // table's flags change, the advice stops being true.
    expect(findAnimation("explosion_1")?.motion).toBe("burst");
    expect(findAnimation("fire_1")?.motion).toBe("projectile");
    expect(findAnimation("slash_1")?.motion).toBe("melee");
    expect(findAnimation("shield_1")?.motion).toBe("self");
  });

  it("describes every effect, so a caller never picks blind", () => {
    for (const anim of ANIMATIONS) {
      expect(anim.looks.length, anim.name).toBeGreaterThan(0);
      expect(anim.goodFor.length, anim.name).toBeGreaterThan(0);
    }
  });

  it("only references sounds that exist", () => {
    const sounds = new Set<string>(DEFAULT_SOUNDS);
    for (const anim of ANIMATIONS) {
      if (anim.sound) expect(sounds, anim.name).toContain(anim.sound);
    }
  });
});

describe("findAnimation", () => {
  it("is exact — a near-miss name is not silently accepted", () => {
    expect(findAnimation("fire_1")?.name).toBe("fire_1");
    expect(findAnimation("fire")).toBeUndefined();
    expect(findAnimation("Fire_1")).toBeUndefined();
  });
});

describe("isCustomAnimation", () => {
  it("recognises a campaign WEBM upload, which is not validated against the catalog", () => {
    expect(isCustomAnimation("/images/abc_cool-effect.webm")).toBe(true);
    expect(isCustomAnimation("/images/abc.mp4")).toBe(true);
  });

  it("treats a built-in name as a catalog reference", () => {
    expect(isCustomAnimation("fire_1")).toBe(false);
    expect(isCustomAnimation("explosion_1")).toBe(false);
  });
});

describe("buildAnimation", () => {
  it("writes only the name when nothing is overridden", () => {
    // Writing a full set of defaults would pin values that should track the
    // effect's own definition, so absent options must stay absent.
    expect(buildAnimation({ animationName: "fire_1" })).toEqual({ animationName: "fire_1" });
  });

  it("includes an override only when it was actually passed", () => {
    expect(buildAnimation({ animationName: "explosion_1", scale: 1.5, sound: "explosive_1" })).toEqual(
      { animationName: "explosion_1", scale: 1.5, sound: "explosive_1" },
    );
  });

  it("keeps a falsy override, which is the whole point of setting it", () => {
    // `opacity: 0` and `count: 1` are meaningful values, not "unset".
    const blob = buildAnimation({ animationName: "orb_1", opacity: 0, rotation: 0 });
    expect(blob).toEqual({ animationName: "orb_1", opacity: 0, rotation: 0 });
  });

  it("keeps `false` for the boolean flags rather than dropping them", () => {
    expect(buildAnimation({ animationName: "orb_1", destinationOnly: false })).toEqual({
      animationName: "orb_1",
      destinationOnly: false,
    });
  });
});

describe("pathSegments", () => {
  it("splits the default FX path", () => {
    expect(pathSegments(DEFAULT_ANIMATION_PATH)).toEqual(["data", "animation"]);
  });

  it("rejects paths with an empty segment rather than writing somewhere odd", () => {
    expect(() => pathSegments("data..animation")).toThrow(/empty segment/);
    expect(() => pathSegments(".data")).toThrow(/empty segment/);
    expect(() => pathSegments("data.")).toThrow(/empty segment/);
  });
});

describe("setByPath", () => {
  it("sets a nested value", () => {
    expect(setByPath({}, "data.animation", { animationName: "fire_1" })).toEqual({
      data: { animation: { animationName: "fire_1" } },
    });
  });

  it("preserves every sibling — the rest of `data` must survive the write", () => {
    const record = { data: { level: "3", school: "Evocation" }, name: "Fireball" };
    expect(setByPath(record, "data.animation", { animationName: "explosion_1" })).toEqual({
      name: "Fireball",
      data: {
        level: "3",
        school: "Evocation",
        animation: { animationName: "explosion_1" },
      },
    });
  });

  it("does not mutate the record it was given", () => {
    // The source is the record we just fetched; sharing structure with it makes a
    // partial failure impossible to reason about.
    const record = { data: { level: "3" } };
    const out = setByPath(record, "data.animation", { animationName: "fire_1" });
    expect(record).toEqual({ data: { level: "3" } });
    expect(out.data).not.toBe(record.data);
  });

  it("replaces a non-object standing where the path needs to descend", () => {
    expect(setByPath({ data: "oops" }, "data.animation", { animationName: "fire_1" })).toEqual({
      data: { animation: { animationName: "fire_1" } },
    });
  });

  it("writes undefined to clear, matching the app's 'None'", () => {
    expect(setByPath({ data: { animation: { animationName: "fire_1" } } }, "data.animation", undefined))
      .toEqual({ data: { animation: undefined } });
  });
});

describe("getByPath", () => {
  it("reads a nested value back for verification", () => {
    const record = { data: { animation: { animationName: "fire_1" } } };
    expect(getByPath(record, "data.animation")).toEqual({ animationName: "fire_1" });
  });

  it("returns undefined for an absent path instead of throwing", () => {
    // An unset FX control writes nothing at all, so this is the normal case.
    expect(getByPath({ data: {} }, "data.animation")).toBeUndefined();
    expect(getByPath(undefined, "data.animation")).toBeUndefined();
    expect(getByPath({ data: "scalar" }, "data.animation")).toBeUndefined();
  });
});
