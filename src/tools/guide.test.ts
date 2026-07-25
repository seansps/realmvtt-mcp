import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOPICS, knowledgeDir, readTopic, topicIndex } from "./guide.js";

describe("guide topics", () => {
  it("has a file on disk for every topic — a missing one is a dead tool call", async () => {
    for (const topic of TOPICS) {
      const path = join(knowledgeDir(), topic.file);
      expect(existsSync(path), `${topic.id} → ${topic.file}`).toBe(true);
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(400);
    }
  });

  it("uses unique ids and files", () => {
    expect(new Set(TOPICS.map((t) => t.id)).size).toBe(TOPICS.length);
    expect(new Set(TOPICS.map((t) => t.file)).size).toBe(TOPICS.length);
  });

  it("covers the subjects the tools point at", () => {
    const ids = TOPICS.map((t) => t.id);
    for (const required of [
      "effects",
      "effects-durations",
      "effects-ruleset",
      "3d-scene-authoring",
      "3d-rooms",
      "3d-caves",
      "api",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("lists every topic in the index", () => {
    const index = topicIndex();
    for (const t of TOPICS) expect(index).toContain(t.id);
  });

  it("reads a topic's contents", async () => {
    expect(await readTopic("3d-scene-authoring")).toContain("FLOOR_THICKNESS");
  });

  it("names the available topics when asked for one that doesn't exist", async () => {
    await expect(readTopic("nope")).rejects.toThrow(/Unknown topic.*effects/s);
  });
});

/**
 * These assert facts the guides state, so a doc edit can't silently contradict the
 * behaviour the tools rely on.
 */
describe("documented conventions", () => {
  const read = (file: string) => readFile(join(knowledgeDir(), file), "utf8");

  it("documents every duration unit the effect editor offers", async () => {
    const doc = await read("effects-durations.md");
    for (const unit of [
      "indefinite",
      "start_turn",
      "end_turn",
      "start_applier_turn",
      "end_applier_turn",
      "rounds",
      "minutes",
      "hours",
      "days",
      "seconds-real",
    ]) {
      expect(doc).toContain(unit);
    }
  });

  it("states the prop-facing convention, the recurring 180-degree bug", async () => {
    const doc = await read("3d-scene-authoring.md");
    expect(doc).toContain("front = −Z");
    expect(doc).toMatch(/0 → faces −y/);
  });

  it("says a secret door is a WALL carrying the portal, not a door asset", async () => {
    const doc = await read("3d-scene-authoring.md");
    expect(doc).toMatch(/secret door is \*\*not a door asset/i);
    expect(doc).toContain('"secret": true');
  });

  it("says pos.z can go below ground level", async () => {
    expect(await read("3d-scene-authoring.md")).toMatch(/pos\.z` is signed/);
  });

  it("warns that cave waves are edge-hugging despite carrying a shape", async () => {
    const doc = await read("3d-caves.md");
    expect(doc).toMatch(/Waves are edge-hugging/);
    expect(doc).toMatch(/FOUR bends/);
  });

  it("tells the reader they can pick assets from the whole catalog, not just a kit", async () => {
    expect(await read("3d-rooms.md")).toContain("realm_search_3d_assets");
  });
});
