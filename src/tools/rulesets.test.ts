import { describe, expect, it } from "vitest";
import { describeRuleset, slugify } from "./rulesets.js";

describe("slugify", () => {
  it("makes a filesystem-safe name from a ruleset title", () => {
    expect(slugify("D&D 5e (2024)")).toBe("d-d-5e-2024");
    expect(slugify("Cyberpunk RED")).toBe("cyberpunk-red");
  });

  it("never produces an empty filename", () => {
    expect(slugify("!!!")).toBe("ruleset");
    expect(slugify("")).toBe("ruleset");
  });
});

describe("describeRuleset", () => {
  it("maps the ruleset's shape without carrying its bulk", () => {
    const summary = describeRuleset({
      _id: "r1",
      name: "Test System",
      version: 3,
      published: true,
      records: [
        { type: "characters", name: "Characters", tabs: [{ name: "Main" }, { name: "Skills" }] },
        { type: "items", name: "Items", tabs: [{ name: "Main" }] },
      ],
      settings: {
        otherSettings: { scripts: { helpers: "…10kb…", combat: "…8kb…" } },
        damage: { damageScript: "…" },
      },
    });

    expect(summary).toMatchObject({
      id: "r1",
      name: "Test System",
      version: 3,
      published: true,
      recordTypes: [
        { type: "characters", name: "Characters", tabs: ["Main", "Skills"] },
        { type: "items", name: "Items", tabs: ["Main"] },
      ],
      globalScripts: ["helpers", "combat"],
      settingsKeys: ["otherSettings", "damage"],
    });
    // The point of the summary is that none of the actual code comes along.
    expect(JSON.stringify(summary)).not.toContain("10kb");
  });

  it("tolerates a ruleset with no records or settings", () => {
    const summary = describeRuleset({ _id: "r2", name: "Bare" });
    expect(summary).toMatchObject({ recordTypes: [], globalScripts: [], settingsKeys: [] });
    expect(summary).toMatchObject({ hasOnCampaignLoad: false });
    expect(JSON.stringify(summary)).not.toContain("campaignPanel");
  });

  it("surfaces the Campaign Values hook and panel without carrying the layout", () => {
    const summary = describeRuleset({
      _id: "r3",
      name: "Destiny System",
      settings: {
        otherSettings: {
          onCampaignLoad: "api.setCampaignVariable('doom', 13);",
          campaignPanel: {
            name: "Destiny Points",
            icon: "IconSparkle",
            gmOnly: false,
            layout: "…6kb of layout HTML…",
          },
        },
      },
    });
    expect(summary).toMatchObject({
      hasOnCampaignLoad: true,
      campaignPanel: { name: "Destiny Points", gmOnly: false },
    });
    expect(JSON.stringify(summary)).not.toContain("6kb of layout");
  });
});
