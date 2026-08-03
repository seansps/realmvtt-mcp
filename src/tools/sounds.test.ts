import { describe, expect, it } from "vitest";
import { ASSET_CDN } from "./images.js";
import { folderIndexFrom } from "./listing.js";
import {
  isScene3dLayer,
  isSupportedSoundFile,
  placedSoundFor,
  placedSoundsOn,
  soundNameFromFile,
  soundSummary,
  soundUrl,
} from "./sounds.js";

const noFolders = folderIndexFrom([]);

describe("soundUrl", () => {
  it("prefixes a stored path that has no leading slash — the shape sounds actually use", () => {
    expect(soundUrl("sounds/8393d8e7-beba-4cc0-bb29-d1997660be39_Gothic_I_-_02_-_mine_vall.mp3")).toBe(
      `${ASSET_CDN}/sounds/8393d8e7-beba-4cc0-bb29-d1997660be39_Gothic_I_-_02_-_mine_vall.mp3`,
    );
  });

  it("does not double the separator when the path does have one", () => {
    expect(soundUrl("/sounds/a.mp3")).toBe(`${ASSET_CDN}/sounds/a.mp3`);
    expect(soundUrl("//sounds/a.mp3")).toBe(`${ASSET_CDN}/sounds/a.mp3`);
  });

  it("leaves an already-absolute url alone instead of prefixing the host twice", () => {
    expect(soundUrl("https://assets.realmvtt.com/sounds/a.mp3")).toBe(
      "https://assets.realmvtt.com/sounds/a.mp3",
    );
    expect(soundUrl("http://elsewhere.test/a.mp3")).toBe("http://elsewhere.test/a.mp3");
    expect(soundUrl("HTTPS://assets.realmvtt.com/a.mp3")).toBe("HTTPS://assets.realmvtt.com/a.mp3");
  });

  it("survives an empty or whitespace path rather than emitting a bare host", () => {
    expect(soundUrl("")).toBe("");
    expect(soundUrl("   ")).toBe("");
  });

  it("trims a path the API returned with stray whitespace", () => {
    expect(soundUrl(" sounds/a.mp3 ")).toBe(`${ASSET_CDN}/sounds/a.mp3`);
  });
});

describe("isSupportedSoundFile", () => {
  it("accepts exactly what the app's dropzone accepts", () => {
    for (const name of ["a.mp3", "a.m4a", "a.ogg", "a.wav"]) {
      expect(isSupportedSoundFile(name)).toBe(true);
    }
  });

  it("is case-insensitive, since downloads arrive shouting", () => {
    expect(isSupportedSoundFile("Cold Wind.WAV")).toBe(true);
    expect(isSupportedSoundFile("Dark Jazz.MP3")).toBe(true);
  });

  it("rejects formats no browser will decode, and files with no extension", () => {
    expect(isSupportedSoundFile("a.flac")).toBe(false);
    expect(isSupportedSoundFile("a.aiff")).toBe(false);
    expect(isSupportedSoundFile("a.png")).toBe(false);
    expect(isSupportedSoundFile("cemetery-ambience")).toBe(false);
  });

  it("does not match on a dot inside the name", () => {
    expect(isSupportedSoundFile("track.mp3.txt")).toBe(false);
  });
});

describe("soundNameFromFile", () => {
  it("turns a downloaded filename into a readable name", () => {
    expect(soundNameFromFile("horse_carriage_cobblestone.mp3")).toBe("horse carriage cobblestone");
    expect(soundNameFromFile("cold-wind.wav")).toBe("cold wind");
  });

  it("collapses runs of separators rather than leaving gaps", () => {
    expect(soundNameFromFile("dark__jazz--loop.ogg")).toBe("dark jazz loop");
  });

  it("keeps a name that is already clean", () => {
    expect(soundNameFromFile("Cemetery Ambience.wav")).toBe("Cemetery Ambience");
  });
});

describe("soundSummary", () => {
  it("reports both the stored path and the absolute url", () => {
    const row = soundSummary({ _id: "1", name: "Wind", url: "/sounds/abc_wind.mp3" }, noFolders);
    expect(row.storedPath).toBe("/sounds/abc_wind.mp3");
    expect(row.cdnUrl).toBe(`${ASSET_CDN}/sounds/abc_wind.mp3`);
  });

  it("surfaces the playlist flags that make a track play on its own", () => {
    const row = soundSummary(
      { _id: "1", name: "Battle", url: "/sounds/b.mp3", combatMusic: true, pauseMusic: true },
      noFolders,
    );
    expect(row.combatMusic).toBe(true);
    expect(row.pauseMusic).toBe(true);
  });

  it("omits flags that are off rather than reporting a wall of false", () => {
    const row = soundSummary({ _id: "1", name: "Wind", url: "/s.mp3" }, noFolders);
    expect(row).not.toHaveProperty("combatMusic");
    expect(row).not.toHaveProperty("hiddenFromControls");
    expect(row).not.toHaveProperty("category");
  });

  it("marks a module-installed sound as not the campaign's own", () => {
    const row = soundSummary({ _id: "1", name: "W", url: "/s.mp3", moduleId: "m1" }, noFolders);
    expect(row.source).toBe("module");
    expect(row.moduleId).toBe("m1");
  });
});

describe("placedSoundsOn", () => {
  it("treats a layer with no sounds as empty rather than throwing", () => {
    expect(placedSoundsOn(undefined)).toEqual([]);
    expect(placedSoundsOn({})).toEqual([]);
    expect(placedSoundsOn({ sounds: null })).toEqual([]);
  });
});

describe("isScene3dLayer", () => {
  it("reads the layer's own scene type", () => {
    expect(isScene3dLayer({ sceneType: "3d" })).toBe(true);
    expect(isScene3dLayer({})).toBe(false);
    expect(isScene3dLayer(undefined)).toBe(false);
  });
});

describe("placedSoundFor", () => {
  const record = { name: "Cemetery Ambience", url: "/sounds/abc_cem.mp3" };

  it("matches the 2D drop handler's defaults", () => {
    const s = placedSoundFor(record, { x: 12, y: 7 }, {}, false);
    expect(s).toEqual({
      name: "Cemetery Ambience",
      url: "/sounds/abc_cem.mp3",
      volume: 0.5,
      radius: 1,
      position: { x: 12, y: 7 },
    });
  });

  it("matches the 3D drop handler's defaults", () => {
    const s = placedSoundFor(record, { x: 12, y: 7, z: 2 }, {}, true);
    expect(s.volume).toBe(1);
    expect(s.radius).toBe(5);
    expect(s.ambient).toBe(false);
    expect(s.position).toEqual({ x: 12, y: 7, z: 2 });
  });

  it("never writes a z onto a 2D scene, which would be ignored anyway", () => {
    const s = placedSoundFor(record, { x: 1, y: 2, z: 9 }, {}, false);
    expect(s.position).toEqual({ x: 1, y: 2 });
  });

  it("keeps a 3D sound at ground level when no z is given", () => {
    const s = placedSoundFor(record, { x: 1, y: 2 }, {}, true);
    expect(s.position).toEqual({ x: 1, y: 2 });
  });

  it("lets explicit values win over both sets of defaults", () => {
    const s = placedSoundFor(record, { x: 0, y: 0 }, { radius: 20, volume: 0.25 }, true);
    expect(s.radius).toBe(20);
    expect(s.volume).toBe(0.25);
  });

  it("honours volume 0 and radius 0 instead of falling back to a default", () => {
    const s = placedSoundFor(record, { x: 0, y: 0 }, { volume: 0, radius: 0 }, false);
    expect(s.volume).toBe(0);
    expect(s.radius).toBe(0);
  });

  it("carries ambient through, including an explicit false in 2D", () => {
    expect(placedSoundFor(record, { x: 0, y: 0 }, { ambient: true }, false).ambient).toBe(true);
    expect(placedSoundFor(record, { x: 0, y: 0 }, { ambient: false }, false).ambient).toBe(false);
  });

  it("leaves ambient off the document entirely for a plain 2D placement", () => {
    expect(placedSoundFor(record, { x: 0, y: 0 }, {}, false)).not.toHaveProperty("ambient");
  });

  it("only writes `muted` when the sound is actually muted", () => {
    expect(placedSoundFor(record, { x: 0, y: 0 }, { muted: true }, false).muted).toBe(true);
    expect(placedSoundFor(record, { x: 0, y: 0 }, { muted: false }, false)).not.toHaveProperty(
      "muted",
    );
  });

  it("stores the file path, not the record id — the emitter outlives the library entry", () => {
    const s = placedSoundFor({ ...record, _id: "651f00000000000000000001" }, { x: 0, y: 0 }, {}, true);
    expect(s.url).toBe("/sounds/abc_cem.mp3");
    expect(s).not.toHaveProperty("_id");
  });
});
