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
