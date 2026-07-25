import { describe, expect, it } from "vitest";
import { ASSET_CDN, cdnUrl, journalImgTag } from "./images.js";

describe("cdnUrl", () => {
  it("builds an absolute url from a stored path, with or without a leading slash", () => {
    expect(cdnUrl("/images/abc_map.png")).toBe(`${ASSET_CDN}/images/abc_map.png`);
    expect(cdnUrl("images/abc_map.png")).toBe(`${ASSET_CDN}/images/abc_map.png`);
  });
});

describe("journalImgTag", () => {
  it("defaults to a full-width block image", () => {
    const html = journalImgTag("https://cdn.test/a.png", { alt: "A map" });
    expect(html).toContain('width="800"');
    expect(html).toContain('data-display="block"');
    expect(html).toContain('data-float="left"');
    expect(html).toContain('alt="A map"');
  });

  it("renders a floated image narrow and inline so text wraps it", () => {
    const html = journalImgTag("https://cdn.test/a.png", { float: "right" });
    expect(html).toContain('width="300"');
    expect(html).toContain('data-display="inline"');
    expect(html).toContain('data-float="right"');
  });

  it("treats an explicit `block` float as the block layout", () => {
    const html = journalImgTag("https://cdn.test/a.png", { float: "block" });
    expect(html).toContain('width="800"');
    expect(html).toContain('data-display="block"');
  });

  it("carries the image record id so an embed traces back to the library entry", () => {
    expect(journalImgTag("https://cdn.test/a.png", { imageId: "abc123" })).toContain(' id="abc123"');
  });

  it("omits the id attribute entirely when there's no record", () => {
    expect(journalImgTag("https://cdn.test/a.png")).not.toContain(" id=");
  });

  it("escapes quotes in alt text so the attribute can't be broken out of", () => {
    const html = journalImgTag("https://cdn.test/a.png", { alt: 'He said "hi"' });
    expect(html).toContain("&quot;hi&quot;");
    expect(html).not.toContain('alt="He said "hi""');
  });

  it("produces a single well-formed img tag", () => {
    const html = journalImgTag("https://cdn.test/a.png", { alt: "x", imageId: "i" });
    expect(html.startsWith("<img ")).toBe(true);
    expect(html.endsWith(">")).toBe(true);
    expect(html.match(/<img/g)).toHaveLength(1);
  });
});
