import { describe, expect, it } from "vitest";
import type { Json, Paginated, Query, RealmClient } from "../api/client.js";
import {
  SERVER_PAGE,
  fetchPage,
  folderIndexFrom,
  MISSING_FOLDER,
  pageResult,
  provenanceOf,
  scanPage,
  withSearch,
} from "./listing.js";

/**
 * A stand-in for the backend that behaves the way the real one measurably does:
 * `paginate: { default: 50, max: 500 }`. Omitting `$limit` yields 50 rows; asking
 * for more than the ceiling yields the ceiling. Verified against a local backend
 * (`$limit=200` on a 171-row library returns all 171; `$limit=1000` returns 171).
 *
 * `ceiling` is settable because a couple of services declare their own — folders
 * allows 1000 — and the paging loop must not assume ours.
 */
function fakeClient(
  rows: Json[],
  ceiling = SERVER_PAGE,
): { client: RealmClient; queries: Query[] } {
  const queries: Query[] = [];
  const client = {
    async find<T>(_path: string, query: Query = {}): Promise<Paginated<T>> {
      queries.push(query);
      const skip = Number(query.$skip ?? 0);
      const limit = Math.min(Number(query.$limit ?? 50), ceiling);
      return {
        total: rows.length,
        limit,
        skip,
        data: rows.slice(skip, skip + limit) as T[],
      };
    },
  } as unknown as RealmClient;
  return { client, queries };
}

const many = (n: number): Json[] =>
  Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, name: `Row ${i}` }));

describe("fetchPage", () => {
  it("asks the server for exactly the rows requested, not the whole collection", async () => {
    const { client, queries } = fakeClient(many(500));
    const page = await fetchPage(client, "/images", { campaignId: "c1" }, 10);

    expect(page.returned).toBe(10);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ campaignId: "c1", $skip: 0, $limit: 10 });
  });

  it("reports the SERVER's total, not how many rows it fetched", async () => {
    const { client } = fakeClient(many(812));
    const page = await fetchPage(client, "/images", {}, 50);
    expect(page.total).toBe(812);
    expect(page.returned).toBe(50);
    expect(page.note).toContain("762 more");
    expect(page.note).toContain("skip: 50");
  });

  // 500 is the server's ceiling, not ours, so a limit under it must cost ONE
  // request. This is the regression guard for the old belief that pages clamped
  // at 50, which made every full listing ten times as many round trips.
  it("fetches up to the server ceiling in a single request", async () => {
    const { client, queries } = fakeClient(many(1000));
    const page = await fetchPage(client, "/records", {}, 400);

    expect(page.returned).toBe(400);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.$limit).toBe(400);
  });

  it("satisfies a limit above the ceiling with consecutive requests", async () => {
    const { client, queries } = fakeClient(many(2000));
    const page = await fetchPage(client, "/records", {}, 1200);

    expect(page.returned).toBe(1200);
    expect(queries.map((q) => q.$skip)).toEqual([0, 500, 1000]);
    expect(page.total).toBe(2000);
  });

  // The loop advances by rows RECEIVED, never by rows requested — so a service
  // whose ceiling is below ours costs an extra round trip instead of silently
  // dropping the remainder.
  it("completes against a service with a lower ceiling than ours", async () => {
    const { client, queries } = fakeClient(many(1000), 50);
    const page = await fetchPage(client, "/some-capped-service", {}, 200);

    expect(page.returned).toBe(200);
    expect(queries).toHaveLength(4);
    expect(queries.map((q) => q.$skip)).toEqual([0, 50, 100, 150]);
  });

  it("offsets by skip and stops at the end without a phantom next page", async () => {
    const { client } = fakeClient(many(60));
    const page = await fetchPage(client, "/images", {}, 50, 50);
    expect(page.skip).toBe(50);
    expect(page.returned).toBe(10);
    expect(page.note).toBeUndefined();
  });

  it("does not loop forever against a service registered with paginate: false", async () => {
    // Such a service answers the same array to every request; `findAll` guards on
    // exactly this and so must we, or a limit of 200 spins on the same 3 rows.
    const client = {
      async find<T>(): Promise<Paginated<T>> {
        return { total: 3, limit: 3, skip: 0, data: many(3) as T[] };
      },
    } as unknown as RealmClient;

    const page = await fetchPage(client, "/whatever", {}, 200);
    expect(page.returned).toBe(3);
  });
});

describe("scanPage", () => {
  const typed = (n: number, every: number): Json[] =>
    Array.from({ length: n }, (_, i) => ({ _id: `id${i}`, kind: i % every === 0 ? "3d" : "2d" }));

  it("pages by MATCHES, so skip lands where the caller expects", async () => {
    const { client } = fakeClient(typed(200, 4)); // 50 matches
    const first = await scanPage(client, "/scenes", {}, (r) => r.kind === "3d", 10);
    const second = await scanPage(client, "/scenes", {}, (r) => r.kind === "3d", 10, 10);

    expect(first.rows.map((r) => r._id)).toEqual(
      ["id0", "id4", "id8", "id12", "id16", "id20", "id24", "id28", "id32", "id36"],
    );
    expect(second.rows[0]?._id).toBe("id40");
  });

  // `total` is the server's unfiltered count on purpose: a filtered total would
  // mean reading every row, which is the thing a scan exists to avoid.
  it("keeps total as the server's unfiltered count and reports how far it scanned", async () => {
    const { client } = fakeClient(typed(200, 4));
    const page = await scanPage(client, "/scenes", {}, (r) => r.kind === "3d", 10);
    expect(page.total).toBe(200);
    expect(page.scanned).toBeGreaterThan(0);
  });

  it("stops at maxScan and says so rather than walking the whole campaign", async () => {
    const { client } = fakeClient(typed(5000, 1000), 50);
    const page = await scanPage(client, "/scenes", {}, (r) => r.kind === "3d", 50, 0, 100);

    expect(page.scanLimitReached).toBe(true);
    expect(page.scanned).toBeLessThanOrEqual(100);
    expect(page.note).toContain("no server-side");
  });

  it("exhausts a short collection without claiming it hit a scan limit", async () => {
    const { client } = fakeClient(typed(30, 3));
    const page = await scanPage(client, "/scenes", {}, (r) => r.kind === "3d", 50);
    expect(page.returned).toBe(10);
    expect(page.scanLimitReached).toBeUndefined();
  });
});

describe("withSearch", () => {
  // An empty `$search` is not an empty filter — the backend builds a Mongo stage
  // from it and answers 500, which is what made "list every image" impossible.
  it("omits $search entirely when there is nothing to search for", () => {
    expect(withSearch({ campaignId: "c" }, undefined)).toEqual({ campaignId: "c" });
    expect(withSearch({ campaignId: "c" }, "")).toEqual({ campaignId: "c" });
    expect(withSearch({ campaignId: "c" }, "   ")).toEqual({ campaignId: "c" });
  });

  it("sends a trimmed $search when there is one", () => {
    expect(withSearch({ campaignId: "c" }, "  goblin ")).toEqual({
      campaignId: "c",
      $search: "goblin",
    });
  });
});

describe("folderIndexFrom", () => {
  const index = folderIndexFrom([
    { _id: "a", name: "Bestiary" },
    { _id: "b", name: "Undead", parentId: "a" },
  ]);

  it("decorates an item with its folder breadcrumb", () => {
    expect(index.decorate({ folderId: "b" })).toEqual({
      folderId: "b",
      folderPath: "Bestiary / Undead",
    });
  });

  it("adds nothing for an unfiled item", () => {
    expect(index.decorate({})).toEqual({});
  });

  // The backend does not validate `folderId` on items, so a dangling one is a
  // real state that hides the item in the app. Surfacing it is the point.
  it("flags a folderId pointing at a folder that no longer exists", () => {
    expect(index.decorate({ folderId: "gone" })).toEqual({
      folderId: "gone",
      folderPath: MISSING_FOLDER,
    });
  });
});

describe("provenanceOf", () => {
  it("marks module-installed content, which is the thing cleanup must not touch", () => {
    expect(provenanceOf({ moduleId: "m1", shared: true })).toEqual({
      source: "module",
      moduleId: "m1",
      shared: true,
    });
  });

  it("marks campaign-authored content", () => {
    expect(provenanceOf({ shared: false, locked: true })).toEqual({
      source: "campaign",
      shared: false,
      locked: true,
    });
  });
});

describe("pageResult", () => {
  it("keeps the envelope identical across tools and names the rows", () => {
    const out = pageResult({ total: 3, returned: 1, skip: 0, rows: [{ _id: "x" }] }, "images", (r) => ({
      id: r._id,
    }));
    expect(out).toEqual({ total: 3, returned: 1, skip: 0, images: [{ id: "x" }] });
  });

  it("passes scan diagnostics through so a partial answer never looks complete", () => {
    const out = pageResult(
      { total: 900, returned: 0, skip: 0, rows: [], scanned: 100, scanLimitReached: true },
      "scenes",
      (r) => r,
    );
    expect(out).toMatchObject({ scanned: 100, scanLimitReached: true });
  });
});
