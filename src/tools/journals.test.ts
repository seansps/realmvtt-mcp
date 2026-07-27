import { describe, expect, it } from "vitest";
import { JOURNAL_LINK_TYPES, journalRecordLinkHtml } from "./journals.js";

/**
 * Pull the JSON back out the way the app does: read the `recordlink` attribute,
 * decode HTML entities, parse. Mirrors an HTML parser's attribute-value
 * decoding, which is what TipTap's `element.getAttribute("recordlink")` returns.
 */
const payloadOf = (html: string) => {
  const match = html.match(/^<record-link recordlink="(.*)"><\/record-link>$/);
  if (!match) throw new Error(`not a record-link: ${html}`);
  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // last, so &amp;quot; decodes to &quot; not "
  return JSON.parse(decoded);
};

describe("journalRecordLinkHtml", () => {
  it("emits the tag shape the bulk journal importer writes", () => {
    // Same serialization the importers use: a double-quoted attribute holding
    // entity-escaped JSON.
    const html = journalRecordLinkHtml({ type: "scenes", id: "s1", name: "The Docks" });
    expect(html.startsWith('<record-link recordlink="')).toBe(true);
    expect(html.endsWith('"></record-link>')).toBe(true);
  });

  it("stores the stripped link the app stores — id and name, nothing else", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({ type: "npcs", id: "n1", name: "Goblin" }),
    );
    expect(payload).toEqual({
      type: "npcs",
      tooltip: "Goblin",
      value: { _id: "n1", name: "Goblin" },
    });
  });

  it("gives scenes the map glyph at both levels, and nothing else that icon", () => {
    const scene = payloadOf(journalRecordLinkHtml({ type: "scenes", id: "s", name: "n" }));
    // Top level is what the chip renders; value.icon is what survives a
    // re-drag through sanitizeRecordLink.
    expect(scene.icon).toBe("IconMap");
    expect(scene.value.icon).toBe("IconMap");
    expect(
      payloadOf(journalRecordLinkHtml({ type: "npcs", id: "n1", name: "Goblin" })).icon,
    ).toBeUndefined();
  });

  it("narrows a ruleset record by its type", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({ type: "records", id: "r1", name: "Longsword", recordType: "items" }),
    );
    expect(payload.value.recordType).toBe("items");
  });

  it("ignores recordType for services that are not /records", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({ type: "scenes", id: "s1", name: "Docks", recordType: "items" }),
    );
    expect(payload.value.recordType).toBeUndefined();
  });

  it("carries a journal page number so the link opens that page", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({ type: "journals", id: "j1", name: "Session 3", pageNumber: 4 }),
    );
    expect(payload.value.pageNumber).toBe(4);
  });

  it("escapes the JSON's own double quotes so they cannot close the attribute", () => {
    const html = journalRecordLinkHtml({ type: "scenes", id: "s1", name: "Docks" });
    expect(html).toContain("&quot;");
    expect(html.match(/"/g)).toHaveLength(2); // only the attribute's own delimiters
  });

  it("survives an ampersand in the name, which would otherwise decode as an entity", () => {
    // The failure this guards: unescaped, "Ale &amp; Anchor" written literally
    // decodes back to "&" and the JSON still parses, but "Salt &copy Docks"
    // would lose characters. Escaping & up front makes every name safe.
    for (const name of ["Ale & Anchor", "Salt &copy Docks", "A &amp; B", "&lt;Vault&gt;"]) {
      const payload = payloadOf(journalRecordLinkHtml({ type: "scenes", id: "s1", name }));
      expect(payload.value.name).toBe(name);
    }
  });

  it("survives quotes, angle brackets and apostrophes in the name", () => {
    for (const name of ['The "Old" Docks', "Koren's Rest", "<script>alert(1)</script>"]) {
      const payload = payloadOf(journalRecordLinkHtml({ type: "scenes", id: "s1", name }));
      expect(payload.value.name).toBe(name);
    }
  });

  it("does not let a name break out of the tag", () => {
    const html = journalRecordLinkHtml({
      type: "scenes",
      id: "s1",
      name: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html.match(/<record-link/g)).toHaveLength(1);
  });

  it("offers scenes as a link type", () => {
    expect(JOURNAL_LINK_TYPES).toContain("scenes");
  });
});

/**
 * Payloads lifted verbatim out of a real journal page, so the generator is
 * pinned to what the app itself writes rather than to our reading of it.
 */
describe("journalRecordLinkHtml — matches links stored by the app", () => {
  it("reproduces a stored scene link exactly", () => {
    const html = journalRecordLinkHtml({
      type: "scenes",
      id: "68e12e4fcbb1e209a47d5f68",
      name: "10testiso",
      record: { _id: "68e12e4fcbb1e209a47d5f68", name: "10testiso" },
    });
    expect(html).toBe(
      '<record-link recordlink="{&quot;type&quot;:&quot;scenes&quot;,&quot;tooltip&quot;:&quot;10testiso&quot;,' +
        "&quot;icon&quot;:&quot;IconMap&quot;,&quot;value&quot;:{&quot;_id&quot;:&quot;68e12e4fcbb1e209a47d5f68&quot;," +
        '&quot;name&quot;:&quot;10testiso&quot;,&quot;icon&quot;:&quot;IconMap&quot;}}"></record-link>',
    );
  });

  it("reproduces a stored ruleset-record link, icon at both levels", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "records",
        id: "6a065052e4f7dd62e79d75a9",
        name: "Dagger",
        recordType: "items",
        record: { _id: "6a065052e4f7dd62e79d75a9", name: "Dagger", recordType: "items", icon: "IconMoneybag" },
      }),
    );
    expect(payload).toEqual({
      type: "records",
      tooltip: "Dagger",
      icon: "IconMoneybag",
      value: {
        _id: "6a065052e4f7dd62e79d75a9",
        name: "Dagger",
        recordType: "items",
        icon: "IconMoneybag",
      },
    });
  });

  it("carries the token and size an NPC link needs to be dropped on the map", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "npcs",
        id: "6a03388112bef02703fed11f",
        name: "Camel",
        record: {
          _id: "6a03388112bef02703fed11f",
          name: "Camel",
          recordType: "npcs",
          // A real NPC document carries far more than this; only these survive.
          data: { size: "large", hp: 15, statblock: "…" },
          token: { imageUrl: "/images/50b1a49d_token-Camel.webp", scaleX: 1, scaleY: 1 },
        },
      }),
    );
    expect(payload.value).toEqual({
      _id: "6a03388112bef02703fed11f",
      name: "Camel",
      recordType: "npcs",
      data: { size: "large" },
      token: { imageUrl: "/images/50b1a49d_token-Camel.webp", scaleX: 1, scaleY: 1 },
    });
  });

  it("keeps the rest of a record out of the link", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "npcs",
        id: "n1",
        name: "Camel",
        record: {
          _id: "n1",
          name: "Camel",
          recordType: "npcs",
          data: { size: "large", hp: 15, description: "x".repeat(5000) },
          campaignId: "c1",
          owner: "u1",
          effectIds: ["e1"],
        },
      }),
    );
    // The whole point of the sanitized shape: a link never embeds a record.
    expect(payload.value.data).toEqual({ size: "large" });
    expect(payload.value.campaignId).toBeUndefined();
    expect(payload.value.owner).toBeUndefined();
    expect(payload.value.effectIds).toBeUndefined();
  });

  it("reproduces a stored journal link — id and name only", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "journals",
        id: "69954f7d1bc95ace447efa59",
        name: "MM",
        record: { _id: "69954f7d1bc95ace447efa59", name: "MM", campaignId: "c1" },
      }),
    );
    expect(payload).toEqual({
      type: "journals",
      tooltip: "MM",
      value: { _id: "69954f7d1bc95ace447efa59", name: "MM" },
    });
  });

  it("reproduces a stored table link — id and name only", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "tables",
        id: "681e2de2b9a36b3d4b5838fa",
        name: "Test Export with Links",
        record: { _id: "681e2de2b9a36b3d4b5838fa", name: "Test Export with Links", rows: [1, 2, 3] },
      }),
    );
    expect(payload).toEqual({
      type: "tables",
      tooltip: "Test Export with Links",
      value: { _id: "681e2de2b9a36b3d4b5838fa", name: "Test Export with Links" },
    });
  });

  it("does not stamp a recordType onto types that never carry one", () => {
    // Stored scene and table links have no recordType, even though the
    // documents behind them may.
    const scene = payloadOf(
      journalRecordLinkHtml({
        type: "scenes",
        id: "s1",
        name: "Docks",
        record: { _id: "s1", name: "Docks", recordType: "scenes" },
      }),
    );
    expect(scene.value.recordType).toBeUndefined();
  });

  it("defaults a token's scale, which older records omit", () => {
    const payload = payloadOf(
      journalRecordLinkHtml({
        type: "npcs",
        id: "n1",
        name: "Dragon",
        record: { _id: "n1", name: "Dragon", token: { imageUrl: "/images/d.webp" } },
      }),
    );
    expect(payload.value.token).toEqual({ imageUrl: "/images/d.webp", scaleX: 1, scaleY: 1 });
  });
});
