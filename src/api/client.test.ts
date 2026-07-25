import { afterEach, describe, expect, it, vi } from "vitest";
import { RealmClient, toQueryPairs } from "./client.js";
import { ApiError, explainApiError, isAuthFailure } from "./errors.js";

/** Stand in for `fetch`, recording every call and replaying scripted responses. */
function mockFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    const status = r.status ?? 200;
    const isJson = r.json !== undefined;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      headers: new Headers(isJson ? { "content-type": "application/json" } : { "content-type": "text/plain" }),
      json: async () => r.json,
      text: async () => r.text ?? "",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("RealmClient auth header", () => {
  it("sends a bearer token when one is set, and omits it when not", async () => {
    const { calls } = mockFetch([{ json: { total: 0, limit: 50, skip: 0, data: [] } }]);
    const client = new RealmClient("https://example.test", "jwt-abc");
    await client.find("/records");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");

    client.setToken(null);
    await client.find("/records");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("strips a trailing slash from the base url so paths don't double up", async () => {
    const { calls } = mockFetch([{ json: { total: 0, limit: 50, skip: 0, data: [] } }]);
    await new RealmClient("https://example.test/", "t").find("/records");
    expect(calls[0]!.url).toBe("https://example.test/records");
  });
});

describe("toQueryPairs", () => {
  it("passes scalars straight through", () => {
    expect(toQueryPairs({ campaignId: "c1", $limit: 50 })).toEqual([
      ["campaignId", "c1"],
      ["$limit", "50"],
    ]);
  });

  it("encodes an operator object with bracket notation", () => {
    // Regression: `userIds=<id>` is a 400 from the campaigns service because the
    // field is an array; `$in` is the shape that actually matches membership.
    expect(toQueryPairs({ userIds: { $in: ["u1"] } })).toEqual([["userIds[$in][]", "u1"]]);
  });

  it("encodes a bare array as repeated [] keys", () => {
    expect(toQueryPairs({ tags: ["a", "b"] })).toEqual([
      ["tags[]", "a"],
      ["tags[]", "b"],
    ]);
  });

  it("handles nesting deeper than one level", () => {
    expect(toQueryPairs({ name: { $regex: "gob", $options: "i" } })).toEqual([
      ["name[$regex]", "gob"],
      ["name[$options]", "i"],
    ]);
  });

  it("drops null and undefined instead of sending the string 'null'", () => {
    expect(toQueryPairs({ a: undefined as never, b: null as never, c: "keep" })).toEqual([
      ["c", "keep"],
    ]);
  });

  it("survives the round trip through URLSearchParams", () => {
    const qs = new URLSearchParams(toQueryPairs({ userIds: { $in: ["u1"] } })).toString();
    expect(qs).toBe("userIds%5B%24in%5D%5B%5D=u1");
    expect(decodeURIComponent(qs)).toBe("userIds[$in][]=u1");
  });
});

describe("findAll pagination", () => {
  it("pages past the backend's 50-row cap until it has every row", async () => {
    const page = (n: number, total: number) => ({
      json: { total, limit: 50, skip: 0, data: Array.from({ length: n }, (_, i) => ({ i })) },
    });
    const { calls } = mockFetch([page(50, 120), page(50, 120), page(20, 120)]);

    const all = await new RealmClient("https://example.test", "t").findAll("/assets-3d");

    expect(all).toHaveLength(120);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain("%24skip=0");
    expect(calls[1]!.url).toContain("%24skip=50");
    expect(calls[2]!.url).toContain("%24skip=100");
  });

  it("stops on an empty page rather than looping forever when total lies", async () => {
    const { calls } = mockFetch([
      { json: { total: 999, limit: 50, skip: 0, data: [{ a: 1 }] } },
      { json: { total: 999, limit: 50, skip: 50, data: [] } },
    ]);
    const all = await new RealmClient("https://example.test", "t").findAll("/assets-3d");
    expect(all).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("treats a bare array response (paginate:false services) as one complete page", async () => {
    const { calls } = mockFetch([{ json: [{ _id: "a" }, { _id: "b" }] }]);
    const all = await new RealmClient("https://example.test", "t").findAll("/owned-rulesets");
    expect(all).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

describe("record endpoint routing", () => {
  const client = new RealmClient("https://example.test", "t");

  it("routes npcs, tables and characters to their own endpoints", () => {
    for (const type of ["npcs", "tables", "characters"]) {
      expect(client.recordEndpoint(type)).toEqual({ path: `/${type}`, carriesRecordType: false });
    }
  });

  it("routes everything else to /records with a recordType discriminator", () => {
    expect(client.recordEndpoint("spells")).toEqual({ path: "/records", carriesRecordType: true });
  });

  it("puts recordType in the body only for /records creates", async () => {
    const { calls } = mockFetch([{ json: {} }, { json: {} }]);

    await client.createRecord("spells", { name: "Fireball" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "Fireball", recordType: "spells" });
    expect(calls[0]!.url).toBe("https://example.test/records");

    await client.createRecord("npcs", { name: "Goblin", recordType: "npcs" });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ name: "Goblin" });
    expect(calls[1]!.url).toBe("https://example.test/npcs");
  });

  it("adds recordType to a /records query but not to a dedicated-endpoint query", async () => {
    const { calls } = mockFetch([
      { json: { total: 0, limit: 50, skip: 0, data: [] } },
      { json: { total: 0, limit: 50, skip: 0, data: [] } },
    ]);

    await client.findRecords("spells", "camp1", { name: "Fireball" });
    expect(calls[0]!.url).toContain("recordType=spells");

    await client.findRecords("npcs", "camp1");
    expect(calls[1]!.url).not.toContain("recordType");
  });
});

describe("custom methods", () => {
  it("POSTs with the X-Service-Method header Feathers requires", async () => {
    const { calls } = mockFetch([{ json: { styles: [] } }]);
    await new RealmClient("https://example.test", "t").roomKit({ style: "fantasy-tavern" });

    expect(calls[0]!.url).toBe("https://example.test/assets-3d");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Service-Method"]).toBe("roomKit");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ style: "fantasy-tavern" });
  });
});

describe("authenticate", () => {
  it("sends the local strategy, omitting the 2FA code when absent", async () => {
    const { calls } = mockFetch([{ json: { accessToken: "jwt" } }]);
    await new RealmClient("https://example.test").authenticate("a@b.test", "pw");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      strategy: "local",
      email: "a@b.test",
      password: "pw",
    });
  });

  it("includes the 2FA code when the account needs one", async () => {
    const { calls } = mockFetch([{ json: { accessToken: "jwt" } }]);
    await new RealmClient("https://example.test").authenticate("a@b.test", "pw", "123456");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ code: "123456" });
  });
});

describe("verifyToken", () => {
  it("is a PLAIN post to /authentication — never a custom method", async () => {
    // Regression: sending X-Service-Method with this call makes the real API answer
    // 405, which surfaced as "that token was rejected" for perfectly good tokens.
    const { calls } = mockFetch([{ json: { accessToken: "fresh", user: { _id: "u1" } } }]);
    const out = await new RealmClient("https://example.test").verifyToken("incoming-jwt");

    expect(calls[0]!.url).toBe("https://example.test/authentication");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Service-Method"]).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      strategy: "jwt",
      accessToken: "incoming-jwt",
    });
    expect(out.accessToken).toBe("fresh");
  });
});

describe("errors", () => {
  it("raises ApiError carrying the status, and only 401 counts as an auth failure", async () => {
    mockFetch([{ status: 401, json: { message: "jwt expired" } }]);
    const err = await new RealmClient("https://example.test", "stale")
      .find("/records")
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("jwt expired");
    expect(isAuthFailure(err)).toBe(true);
    expect(isAuthFailure(new ApiError(403, "nope", "GET", "u"))).toBe(false);
  });

  it("falls back to the status text when the error body isn't JSON", async () => {
    mockFetch([{ status: 500, text: "<html>oops</html>" }]);
    const err = await new RealmClient("https://example.test", "t").find("/records").catch((e) => e);
    expect(err.message).toContain("status 500");
  });

  it("explains the scene-objects-3d campaign-scope rejection", () => {
    const err = new ApiError(403, "Must query by ID, ownerId, campaignId, or moduleId", "GET", "u");
    expect(explainApiError(err)).toContain("realm_use_campaign");
  });
});

describe("empty bodies", () => {
  it("returns an object rather than throwing when DELETE answers with no JSON", async () => {
    mockFetch([{ status: 200, text: "" }]);
    await expect(
      new RealmClient("https://example.test", "t").remove("/records", "abc"),
    ).resolves.toEqual({});
  });
});
