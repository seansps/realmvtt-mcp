import { describe, expect, it } from "vitest";
import { journalRecordLinkHtml } from "../tools/journals.js";
import { parseRecordLinks } from "./extract.js";
import { retargetRecordLinks, retargetRecordPaths } from "./retarget.js";

const linkTo = (id: string, name: string, record?: Record<string, unknown>) =>
  journalRecordLinkHtml({ type: "npcs", id, name, ...(record ? { record } : {}) });

describe("retargetRecordLinks", () => {
  it("rewrites only the links pointing at the old id", () => {
    const html = `<p>${linkTo("old", "Goblin")} and ${linkTo("other", "Orc")}</p>`;
    const out = retargetRecordLinks(html, { fromId: "old", toId: "new", toName: "Hobgoblin" });

    expect(out.replaced).toBe(1);
    const ids = parseRecordLinks(out.html).map((l) => l.payload.value?._id);
    expect(ids).toEqual(["new", "other"]);
  });

  // The whole point of this module. A link stores a SNAPSHOT of its target, so
  // swapping the id alone leaves the chip rendering the old name.
  it("replaces the target's denormalized name, not just the id", () => {
    const html = linkTo("old", "Goblin");
    const out = retargetRecordLinks(html, { fromId: "old", toId: "new", toName: "Hobgoblin" });

    const [link] = parseRecordLinks(out.html);
    expect(link?.payload.value?.name).toBe("Hobgoblin");
    expect(link?.payload.tooltip).toBe("Hobgoblin");
    expect(out.html).not.toContain("Goblin\\"); // no stale name left anywhere
    expect(JSON.stringify(link?.payload)).not.toContain("Goblin\"");
  });

  // Without this, dragging the chip onto the map drops the OLD creature's token
  // at the OLD creature's size, while the chip navigates to the new record.
  it("carries the new record's token art and size instead of the old one's", () => {
    const html = linkTo("old", "Goblin", {
      token: { imageUrl: "/images/goblin.png", scaleX: 1, scaleY: 1 },
      data: { size: "small" },
    });
    expect(html).toContain("goblin.png");

    const out = retargetRecordLinks(html, {
      fromId: "old",
      toId: "new",
      toName: "Ogre",
      toRecord: {
        token: { imageUrl: "/images/ogre.png", scaleX: 2, scaleY: 2 },
        data: { size: "large" },
      },
    });

    const [link] = parseRecordLinks(out.html);
    expect(link?.payload.value?.token).toMatchObject({ imageUrl: "/images/ogre.png", scaleX: 2 });
    expect(link?.payload.value?.data).toEqual({ size: "large" });
    expect(out.html).not.toContain("goblin.png");
  });

  // A page number belongs to the LINK, not to the thing linked — retargeting a
  // link that opens page 4 must not silently send the reader to page 1.
  it("preserves a journal link's pageNumber across the rewrite", () => {
    const html = journalRecordLinkHtml({
      type: "journals",
      id: "old",
      name: "Old Journal",
      pageNumber: 4,
    });
    const out = retargetRecordLinks(html, {
      fromId: "old",
      toId: "new",
      toName: "New Journal",
      toType: "journals",
    });

    const [link] = parseRecordLinks(out.html);
    expect(link?.payload.value?.pageNumber).toBe(4);
    expect(link?.payload.value?._id).toBe("new");
  });

  it("leaves surrounding prose untouched", () => {
    const html = `<h1>Chapter</h1><p>Meet ${linkTo("old", "Goblin")} at dusk.</p>`;
    const out = retargetRecordLinks(html, { fromId: "old", toId: "new", toName: "Hobgoblin" });
    expect(out.html).toContain("<h1>Chapter</h1>");
    expect(out.html).toContain("at dusk.");
  });

  it("reports nothing changed when no link matches", () => {
    const html = linkTo("other", "Orc");
    const out = retargetRecordLinks(html, { fromId: "old", toId: "new", toName: "X" });
    expect(out.replaced).toBe(0);
    expect(out.html).toBe(html);
  });
});

describe("retargetRecordPaths", () => {
  it("repoints a portrait", () => {
    const patch = retargetRecordPaths({ portrait: "/images/a.png" }, "/images/a.png", "/images/b.png");
    expect(patch).toEqual({ portrait: "/images/b.png" });
  });

  it("matches an absolute cdn url against a stored path", () => {
    const patch = retargetRecordPaths(
      { portrait: "https://assets.realmvtt.com/images/a.png" },
      "/images/a.png",
      "/images/b.png",
    );
    expect(patch).toEqual({ portrait: "/images/b.png" });
  });

  // `token` is a subdocument and a patch REPLACES it, so the keys we are not
  // changing have to be carried across or the token loses its scale and mini.
  it("preserves the rest of the token when swapping its image", () => {
    const patch = retargetRecordPaths(
      { token: { imageUrl: "/images/a.png", scaleX: 2, scaleY: 2, model3D: { url: "/3d/x.glb" } } },
      "/images/a.png",
      "/images/b.png",
    );
    expect(patch?.token).toEqual({
      imageUrl: "/images/b.png",
      scaleX: 2,
      scaleY: 2,
      model3D: { url: "/3d/x.glb" },
    });
  });

  it("returns null when nothing on the record uses that path", () => {
    expect(retargetRecordPaths({ portrait: "/images/z.png" }, "/images/a.png", "/images/b.png")).toBeNull();
  });
});
