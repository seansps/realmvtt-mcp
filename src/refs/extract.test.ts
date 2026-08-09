import { describe, expect, it } from "vitest";
import { journalRecordLinkHtml } from "../tools/journals.js";
import { journalImgTag } from "../tools/images.js";
import {
  countRecordLinkTags,
  parseImgTags,
  parseRecordLinks,
  refsFromEncounter,
  refsFromJournalPage,
  refsFromRecord,
  refsFromScene,
  refsFromSceneObjects,
  refsFromTable,
  storedPathOf,
  unescapeAttr,
} from "./extract.js";

describe("unescapeAttr", () => {
  it("round-trips whatever journalRecordLinkHtml wrote", () => {
    const html = journalRecordLinkHtml({ type: "npcs", id: "n1", name: 'Bob "The Rat" & Sons <esq>' });
    const [link] = parseRecordLinks(html);
    expect(link?.payload.value?.name).toBe('Bob "The Rat" & Sons <esq>');
  });

  // The escape does `&` FIRST, so the unescape must do it LAST. Getting this
  // backwards corrupts any name containing something that looks like an entity.
  it("unescapes the ampersand last, so a literal &quot; survives", () => {
    expect(unescapeAttr("&amp;quot;")).toBe("&quot;");
    expect(unescapeAttr("&amp;amp;")).toBe("&amp;");
  });
});

describe("parseRecordLinks", () => {
  it("reads back a link the app's own markup builder produced", () => {
    const html = `<p>See ${journalRecordLinkHtml({
      type: "records",
      id: "r1",
      name: "Longsword",
      recordType: "items",
    })} for details.</p>`;
    const links = parseRecordLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]?.payload.type).toBe("records");
    expect(links[0]?.payload.value?._id).toBe("r1");
    expect(links[0]?.payload.value?.recordType).toBe("items");
  });

  // One hand-edited page must not fail a whole-campaign scan, so bad JSON is
  // skipped here and reported by comparing against the raw tag count.
  it("skips a corrupt link instead of throwing, and the tag count reveals it", () => {
    const good = journalRecordLinkHtml({ type: "npcs", id: "n1", name: "Goblin" });
    const bad = `<record-link recordlink="{not json"></record-link>`;
    const html = good + bad;
    expect(parseRecordLinks(html)).toHaveLength(1);
    expect(countRecordLinkTags(html)).toBe(2);
  });

  it("finds several links in one page", () => {
    const html = [
      journalRecordLinkHtml({ type: "npcs", id: "a", name: "A" }),
      journalRecordLinkHtml({ type: "scenes", id: "b", name: "B" }),
    ].join("<p>x</p>");
    expect(parseRecordLinks(html).map((l) => l.payload.value?._id)).toEqual(["a", "b"]);
  });
});

describe("parseImgTags", () => {
  it("reads the src and the image record id off a generated embed", () => {
    const html = journalImgTag("https://assets.realmvtt.com/images/map.png", {
      alt: "Map",
      imageId: "img1",
    });
    const [img] = parseImgTags(html);
    expect(img?.src).toBe("https://assets.realmvtt.com/images/map.png");
    expect(img?.imageId).toBe("img1");
  });

  it("handles an embed with no record id", () => {
    const [img] = parseImgTags('<img src="/images/x.png">');
    expect(img?.imageId).toBeUndefined();
    expect(img?.src).toBe("/images/x.png");
  });
});

describe("storedPathOf", () => {
  // A journal embeds the absolute url while portraits and scene layers store the
  // relative path. Without normalising, one picture looks like two targets and
  // "unused image" reports images that are plainly on a page.
  it("reduces a cdn url and a bare path to the same thing", () => {
    expect(storedPathOf("https://assets.realmvtt.com/images/map.png")).toBe("/images/map.png");
    expect(storedPathOf("/images/map.png")).toBe("/images/map.png");
    expect(storedPathOf("images/map.png")).toBe("/images/map.png");
  });
});

describe("refsFromJournalPage", () => {
  const page = {
    _id: "p1",
    name: "Chapter 1",
    content:
      journalRecordLinkHtml({ type: "npcs", id: "n1", name: "Goblin Boss" }) +
      journalImgTag("https://assets.realmvtt.com/images/map.png", { imageId: "img1" }),
  };

  it("reports the journal it belongs to, so a finding names a place a human can go", () => {
    const refs = refsFromJournalPage(page, { _id: "j1", name: "Adventure" });
    expect(refs[0]?.from).toMatchObject({
      kind: "journal-page",
      id: "p1",
      parentId: "j1",
      parentName: "Adventure",
    });
  });

  it("extracts both the record link and the image embed", () => {
    const refs = refsFromJournalPage(page);
    expect(refs.map((r) => r.via)).toEqual(["record-link", "img-tag"]);
    expect(refs[0]?.to).toMatchObject({ kind: "npcs", id: "n1", label: "Goblin Boss" });
    expect(refs[1]?.to).toMatchObject({ kind: "images", id: "img1", path: "/images/map.png" });
  });
});

describe("refsFromRecord", () => {
  it("treats portrait and token art as PATHS, because that is how they are stored", () => {
    const refs = refsFromRecord(
      {
        _id: "n1",
        name: "Goblin",
        portrait: "/images/gob.png",
        token: { imageUrl: "https://assets.realmvtt.com/images/gob_token.png", scaleX: 1 },
      },
      "/npcs",
    );
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ via: "portrait", to: { kind: "image-path", path: "/images/gob.png" } });
    expect(refs[1]).toMatchObject({
      via: "token-image",
      to: { kind: "image-path", path: "/images/gob_token.png" },
    });
  });

  // The model url and the catalog id fail independently: the file can serve fine
  // while the catalog entry it came from has been retired.
  it("emits the 3D model url and its catalog id as separate references", () => {
    const refs = refsFromRecord({
      _id: "n2",
      token: { model3D: { url: "/3d/tokens/orc.glb", catalogId: "tok-orc" } },
    });
    expect(refs.map((r) => r.to.kind)).toEqual(["model-path", "asset-3d"]);
    expect(refs[1]?.to.path).toBe("tok-orc");
  });

  it("emits nothing for a record with no art", () => {
    expect(refsFromRecord({ _id: "x", name: "Plain" })).toEqual([]);
  });
});

describe("refsFromScene", () => {
  it("reports each layer's background image", () => {
    const refs = refsFromScene({
      _id: "s1",
      name: "Tavern",
      layers: [{ url: "/images/tavern.png" }],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ via: "scene-background", to: { path: "/images/tavern.png" } });
  });

  // A valid default pin is not a dependency worth listing; a dangling one means
  // the camera opens on empty ground, and nothing else would ever report it.
  it("reports a defaultPinId that points at no pin, and stays quiet when it is valid", () => {
    const broken = refsFromScene({
      _id: "s1",
      layers: [{ pins: [{ id: "keep" }], defaultPinId: "gone" }],
    });
    expect(broken.map((r) => r.via)).toEqual(["default-pin"]);

    const fine = refsFromScene({
      _id: "s1",
      layers: [{ pins: [{ id: "keep" }], defaultPinId: "keep" }],
    });
    expect(fine).toEqual([]);
  });

  it("reports a teleporter aimed at a destination that no longer exists", () => {
    const refs = refsFromScene({
      _id: "s1",
      layers: [
        {
          teleporters: [
            { id: "t1", name: "Door", destination: { layerIndex: 0, teleporterId: "vanished" } },
            { id: "t2", destination: { layerIndex: 0, teleporterId: "t1" } },
          ],
        },
      ],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ via: "teleporter", at: "teleporter Door" });
  });
});

describe("refsFromTable", () => {
  it("locates a linked cell precisely enough to repair it", () => {
    const refs = refsFromTable({
      _id: "t1",
      name: "Loot",
      rows: [
        { columns: [{ text: "nothing" }] },
        {
          columns: [
            { text: "a sword", recordLink: { type: "records", value: { _id: "r1", name: "Longsword", recordType: "items" } } },
          ],
        },
      ],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      via: "table-cell",
      at: "row 2, column 1",
      to: { kind: "records", id: "r1", recordType: "items" },
    });
  });
});

describe("refsFromEncounter", () => {
  it("lists the roster and ignores entries with no npcId", () => {
    const refs = refsFromEncounter({
      _id: "e1",
      name: "Ambush",
      npcs: [{ npcId: "n1", name: "Goblin", count: "2d4" }, { name: "unsaved" }],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ via: "encounter-npc", to: { kind: "npcs", id: "n1" } });
  });

  // An entry's token-art override keeps that image in use even though no record
  // points at it — miss it and an "unused images" sweep offers to delete it.
  it("counts an entry's token image override as a reference", () => {
    const refs = refsFromEncounter({
      _id: "e1",
      name: "Ambush",
      npcs: [
        {
          npcId: "n1",
          name: "Goblin",
          count: "2",
          tokenImageUrl: "https://cdn.example.com/images/dire-wolf.webp",
        },
      ],
    });
    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatchObject({
      via: "token-image",
      to: { kind: "image-path", path: "/images/dire-wolf.webp" },
    });
  });
});

describe("refsFromSceneObjects", () => {
  // A town is thousands of placements over a few dozen assets; one row each would
  // bury the answer under its own noise.
  it("collapses placements to one row per asset with a count", () => {
    const refs = refsFromSceneObjects("s1", "Town", [
      { assetId: "floor-wood" },
      { assetId: "floor-wood" },
      { assetId: "wall-stone" },
      { notAnObject: true },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.to.path === "floor-wood")?.count).toBe(2);
    expect(refs.find((r) => r.to.path === "wall-stone")?.count).toBe(1);
  });
});
