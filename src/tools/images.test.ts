import { describe, expect, it } from "vitest";
import { ASSET_CDN, canvasGridSize, cdnUrl, journalImgTag } from "./images.js";

describe("canvasGridSize", () => {
  it("matches the app's own numbers", () => {
    expect(canvasGridSize(30, 30)).toBe(100); // small: capped at the max
    expect(canvasGridSize(100, 100)).toBe(50); // lands exactly on the 25MP budget
    expect(canvasGridSize(200, 200)).toBe(50); // large: the 50px floor takes over
  });

  it("aims at the ~25 megapixel budget until the resolution floor takes over", () => {
    // Below the floor the budget governs...
    const px = canvasGridSize(100, 100);
    expect(100 * 100 * px * px).toBeLessThanOrEqual(25_000_000);
    // ...but a big canvas keeps a legible 50px grid instead, deliberately going over.
    // The app surfaces the resulting megapixel count to the user rather than shrinking further.
    expect(canvasGridSize(500, 500)).toBe(50);
  });

  it("stays inside the app's 50–100 pixels-per-grid range", () => {
    for (const [w, h] of [[1, 1], [30, 30], [100, 100], [5000, 5000]] as const) {
      const px = canvasGridSize(w, h);
      expect(px).toBeGreaterThanOrEqual(50);
      expect(px).toBeLessThanOrEqual(100);
    }
  });

  it("does not divide by zero on a degenerate canvas", () => {
    expect(canvasGridSize(0, 0)).toBe(100);
  });
});

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
