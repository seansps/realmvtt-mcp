import { describe, expect, it } from "vitest";
import {
  ICON_PREFIX,
  categoryTree,
  describeIcon,
  iconCategory,
  iconName,
  inCategory,
  isIconPath,
  normalizeIconPath,
  pathFilter,
} from "./icons.js";

/** A slice of the real manifest, paths copied verbatim from the live catalog. */
const CATALOG = [
  "/icons/fantasy/magic/fire/fireball.webp",
  "/icons/fantasy/magic/fire/fireball-2.webp",
  "/icons/fantasy/magic/fire/projectile-fireball-sparks-orange.webp",
  "/icons/fantasy/magic/air/air-wave-gust-blue.webp",
  "/icons/fantasy/skills/bard/musical-energy-orb.webp",
  "/icons/fantasy/skills/assorted/fireball.webp",
  "/icons/fantasy/actions/attack-1.webp",
  "/icons/fantasy/avatars/characters/elven-archer.webp",
];

describe("iconName", () => {
  it("reads the picker's label off the filename", () => {
    expect(iconName("/icons/fantasy/magic/air/air-wave-gust-blue.webp")).toBe(
      "Air Wave Gust Blue",
    );
  });

  it("drops every image extension the catalog uses, not just webp", () => {
    expect(iconName("/icons/a/b/skull.png")).toBe("Skull");
    expect(iconName("/icons/a/b/skull.SVG")).toBe("Skull");
  });

  it("treats underscores and runs of hyphens as one separator", () => {
    // A doubled separator would otherwise title-case an empty string into the name.
    expect(iconName("/icons/a/rusty_iron--key.webp")).toBe("Rusty Iron Key");
  });
});

describe("iconCategory", () => {
  it("is the folder path under /icons/, without the filename", () => {
    expect(iconCategory("/icons/fantasy/magic/fire/fireball.webp")).toBe("fantasy/magic/fire");
  });

  it("is empty for an icon sitting directly in /icons/", () => {
    expect(iconCategory("/icons/loose.webp")).toBe("");
  });
});

describe("describeIcon", () => {
  it("keeps `path` as the stored key and builds a separate preview URL", () => {
    // The record stores `path`; `url` is only for a human to look at. Confusing the
    // two is how a full CDN URL ends up written into `portrait`.
    const icon = describeIcon("/icons/fantasy/magic/fire/fireball.webp");
    expect(icon.path).toBe("/icons/fantasy/magic/fire/fireball.webp");
    expect(icon.url).toBe("https://assets.realmvtt.com/icons/fantasy/magic/fire/fireball.webp");
    expect(icon.name).toBe("Fireball");
    expect(icon.category).toBe("fantasy/magic/fire");
  });
});

describe("normalizeIconPath", () => {
  it("leaves a canonical catalog path alone", () => {
    expect(normalizeIconPath("/icons/fantasy/magic/fire/fireball.webp")).toBe(
      "/icons/fantasy/magic/fire/fireball.webp",
    );
  });

  it("restores a missing leading slash", () => {
    expect(normalizeIconPath("icons/fantasy/magic/fire/fireball.webp")).toBe(
      "/icons/fantasy/magic/fire/fireball.webp",
    );
  });

  it("strips the CDN host, since that is what a model copies out of a preview URL", () => {
    expect(
      normalizeIconPath("https://assets.realmvtt.com/icons/fantasy/magic/fire/fireball.webp"),
    ).toBe("/icons/fantasy/magic/fire/fireball.webp");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeIconPath("  /icons/a/b.webp  ")).toBe("/icons/a/b.webp");
  });
});

describe("isIconPath", () => {
  it("accepts catalog references in any of the forms callers send", () => {
    expect(isIconPath("/icons/a/b.webp")).toBe(true);
    expect(isIconPath("icons/a/b.webp")).toBe(true);
    expect(isIconPath("https://assets.realmvtt.com/icons/a/b.webp")).toBe(true);
  });

  it("rejects an uploaded image path — those are library assets, not catalog icons", () => {
    expect(isIconPath("/images/7bf613aa-31ac_skill_icon_45.webp")).toBe(false);
  });

  it(`is anchored on ${ICON_PREFIX}, so a path merely containing "icons" fails`, () => {
    expect(isIconPath("/images/icons/a.webp")).toBe(false);
  });
});

describe("pathFilter", () => {
  it("requires every term, in any order and any position", () => {
    // `magic` matches the folder, `fireball` the filename — so the same-named icon
    // over in skills/assorted drops out, and word order makes no difference.
    const expected = [
      "/icons/fantasy/magic/fire/fireball.webp",
      "/icons/fantasy/magic/fire/fireball-2.webp",
      "/icons/fantasy/magic/fire/projectile-fireball-sparks-orange.webp",
    ];
    expect(pathFilter("magic fireball", CATALOG)).toEqual(expected);
    expect(pathFilter("fireball magic", CATALOG)).toEqual(expected);
  });

  it("matches each term as a substring, so `fire ball` still finds `fireball`", () => {
    // Terms are independent substrings, not word-boundary matches. This is the
    // picker's behavior, and it is why a two-word query doesn't come back empty.
    expect(pathFilter("fire ball", CATALOG)).toEqual([
      "/icons/fantasy/magic/fire/fireball.webp",
      "/icons/fantasy/magic/fire/fireball-2.webp",
      "/icons/fantasy/magic/fire/projectile-fireball-sparks-orange.webp",
      "/icons/fantasy/skills/assorted/fireball.webp",
    ]);
  });

  it("ignores punctuation on both sides, so `fireball-2` matches `fireball2`", () => {
    expect(pathFilter("fireball2", CATALOG)).toEqual(["/icons/fantasy/magic/fire/fireball-2.webp"]);
  });

  it("returns everything for an empty query rather than nothing", () => {
    expect(pathFilter("   ", CATALOG)).toHaveLength(CATALOG.length);
  });
});

describe("inCategory", () => {
  it("matches the exact folder", () => {
    expect(inCategory("/icons/fantasy/magic/fire/fireball.webp", "fantasy/magic/fire")).toBe(true);
  });

  it("matches subfolders, so a parent category takes in its children", () => {
    expect(inCategory("/icons/fantasy/magic/fire/fireball.webp", "fantasy/magic")).toBe(true);
    expect(inCategory("/icons/fantasy/magic/fire/fireball.webp", "fantasy")).toBe(true);
  });

  it("stops at the segment boundary, so `fantasy/magic` doesn't pull in `fantasy/magical`", () => {
    expect(inCategory("/icons/fantasy/magical/x.webp", "fantasy/magic")).toBe(false);
  });

  it("tolerates the `/icons/` prefix and a trailing slash a caller may paste in", () => {
    expect(inCategory("/icons/fantasy/magic/fire/x.webp", "/icons/fantasy/magic/")).toBe(true);
  });

  it("does not match a sibling folder", () => {
    expect(inCategory("/icons/fantasy/magic/air/x.webp", "fantasy/magic/fire")).toBe(false);
  });
});

describe("categoryTree", () => {
  it("counts icons per folder so a caller can browse 18k paths without listing them", () => {
    expect(categoryTree(CATALOG)).toEqual([
      { category: "fantasy/actions", icons: 1 },
      { category: "fantasy/avatars/characters", icons: 1 },
      { category: "fantasy/magic/air", icons: 1 },
      { category: "fantasy/magic/fire", icons: 3 },
      { category: "fantasy/skills/assorted", icons: 1 },
      { category: "fantasy/skills/bard", icons: 1 },
    ]);
  });

  it("narrows to one subtree when asked", () => {
    expect(categoryTree(CATALOG, "fantasy/magic")).toEqual([
      { category: "fantasy/magic/air", icons: 1 },
      { category: "fantasy/magic/fire", icons: 3 },
    ]);
  });
});
