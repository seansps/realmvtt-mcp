import { afterEach, describe, expect, it, vi } from "vitest";
import { RealmClient } from "../api/client.js";

/**
 * A campaign's title lives on `displayName`; a ruleset's on `name`. Reading `name`
 * off a campaign yields `undefined`, which is exactly what shipped — every campaign
 * listed with no title at all. These pin the field names against the real services.
 */
afterEach(() => vi.unstubAllGlobals());

function stubApi(byPath: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      const body = byPath[path] ?? { total: 0, limit: 50, skip: 0, data: [] };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch,
  );
}

describe("campaign identity", () => {
  it("reads a campaign's title from displayName, not name", async () => {
    stubApi({
      "/campaigns": {
        total: 1,
        limit: 50,
        skip: 0,
        data: [
          {
            _id: "c1",
            displayName: "Curse of Strahd",
            inviteCode: "ABC123",
            rulesetId: "r1",
          },
        ],
      },
    });

    const client = new RealmClient("https://api.test", "t");
    const campaigns = await client.findAll<{ displayName?: string; name?: string }>("/campaigns", {
      ownerId: "u1",
    });

    expect(campaigns[0]!.displayName).toBe("Curse of Strahd");
    // The field that used to be read, and never existed:
    expect(campaigns[0]!.name).toBeUndefined();
  });

  it("reads a ruleset's title from name", async () => {
    stubApi({
      "/ruleset-list": { total: 1, limit: 50, skip: 0, data: [{ _id: "r1", name: "D&D 5e" }] },
    });

    const client = new RealmClient("https://api.test", "t");
    const rulesets = await client.find<{ name?: string }>("/ruleset-list", {});
    expect(rulesets.data[0]!.name).toBe("D&D 5e");
  });
});
