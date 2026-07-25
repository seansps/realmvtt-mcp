/**
 * REST client for the Realm VTT API (`https://utilities.realmvtt.com`).
 *
 * A typed port of the `realm-api` CLI's RealmVTTClient — same endpoints, same
 * bearer-JWT auth, same quirks. Realm's backend is FeathersJS, which means:
 *   - `find` returns `{ total, limit, skip, data }` and is CLAMPED to 50 rows per
 *     page regardless of `$limit`, so anything that wants a full list has to page.
 *   - Custom service methods are invoked as a POST carrying an `X-Service-Method`
 *     header (there is no REST verb for them).
 *   - Query fields are whitelisted per service; an unlisted field is a 400, not a
 *     silently-ignored filter.
 */
import { ApiError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://utilities.realmvtt.com";

/** Feathers paginated `find` envelope. */
export interface Paginated<T> {
  total: number;
  limit: number;
  skip: number;
  data: T[];
}

export interface AuthResult {
  accessToken: string;
  user?: { _id: string; email?: string; displayName?: string; role?: string };
}

/** The page size the backend actually honours. Config claims 500; the service clamps to 50. */
const PAGE = 50;

export type Json = Record<string, unknown>;

/** A Feathers query value: a scalar, an array, or an operator object like `{ $in: [...] }`. */
export type QueryValue = string | number | boolean | QueryValue[] | { [key: string]: QueryValue };
export type Query = Record<string, QueryValue>;

/**
 * Encode a query the way Feathers' REST parser expects, using PHP-style bracket
 * notation for nesting: `{ userIds: { $in: ["u1"] } }` → `userIds[$in][]=u1`.
 *
 * This nesting is not optional. Realm validates queries against each service's
 * schema, and a scalar sent to an ARRAY-typed field (`userIds`, `tags`, …) is a
 * hard 400 rather than a loose match — `userIds=u1` fails where `userIds[$in][]=u1`
 * returns the campaigns that user belongs to.
 */
export function toQueryPairs(query: Query): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  const walk = (key: string, value: QueryValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(`${key}[]`, item);
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v as QueryValue);
      return;
    }
    pairs.push([key, String(value)]);
  };

  for (const [key, value] of Object.entries(query)) walk(key, value);
  return pairs;
}

/** Record types with their own top-level endpoint. Everything else lives on
 *  `/records`, discriminated by a `recordType` field. */
const DEDICATED_RECORD_ENDPOINTS = new Set(["npcs", "tables", "characters"]);

export class RealmClient {
  readonly baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string = DEFAULT_BASE_URL, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  /**
   * Exchange email + password for a JWT. `code` is the Google Authenticator TOTP,
   * required only for accounts with 2FA enabled.
   *
   * Accounts created through Google Sign-In have no password and are rejected here
   * with an explicit message — callers surface it rather than retrying.
   */
  async authenticate(email: string, password: string, code?: string): Promise<AuthResult> {
    const body: Json = { strategy: "local", email, password };
    if (code) body.code = code;
    return this.fetchJson<AuthResult>(`${this.baseUrl}/authentication`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Check that a JWT is valid for THIS API and find out who it belongs to.
   *
   * This is the `jwt` strategy on the ordinary authentication service — a plain POST,
   * NOT a Feathers custom method. It re-issues a token and returns the user, which is
   * exactly what we want after accepting a token we didn't mint ourselves.
   */
  async verifyToken(accessToken: string): Promise<AuthResult> {
    return this.fetchJson<AuthResult>(`${this.baseUrl}/authentication`, {
      method: "POST",
      body: JSON.stringify({ strategy: "jwt", accessToken }),
    });
  }

  // ── low-level ─────────────────────────────────────────────────────────────

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...options,
      headers: this.headers(options.headers as Record<string, string> | undefined),
    });

    if (!res.ok) {
      let message: string;
      try {
        const body = (await res.json()) as { message?: string };
        message = body.message || res.statusText;
      } catch {
        message = res.statusText;
      }
      throw new ApiError(res.status, message, options.method || "GET", url);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return (await res.json()) as T;
    // DELETE and a few custom endpoints answer with an empty body.
    return {} as T;
  }

  /** GET a Feathers `find`, one page. */
  async find<T = Json>(path: string, query: Query = {}): Promise<Paginated<T>> {
    const qs = new URLSearchParams(toQueryPairs(query)).toString();
    const res = await this.fetchJson<Paginated<T> | T[]>(
      `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`,
    );
    // A few services are registered with `paginate: false` and answer with a bare array.
    if (Array.isArray(res)) {
      return { total: res.length, limit: res.length, skip: 0, data: res };
    }
    return res;
  }

  /** GET every page of a `find`, working around the 50-row cap. */
  async findAll<T = Json>(path: string, query: Query = {}): Promise<T[]> {
    const all: T[] = [];
    let skip = 0;
    for (;;) {
      const res = await this.find<T>(path, { ...query, $limit: PAGE, $skip: skip });
      all.push(...res.data);
      skip += PAGE;
      if (res.data.length === 0 || all.length >= (res.total ?? all.length)) break;
      // Non-paginated services answer the same array every time; bail rather than loop.
      if (res.limit === res.total && res.skip === 0) break;
    }
    return all;
  }

  async get<T = Json>(path: string, id: string): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}/${id}`);
  }

  async create<T = Json>(path: string, data: unknown): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async patch<T = Json>(path: string, id: string, data: unknown): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async remove<T = Json>(path: string, id: string): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}/${id}`, { method: "DELETE" });
  }

  /** Batch remove by query (services that permit it, e.g. scene-objects-3d). */
  async removeMany<T = Json>(path: string, query: Record<string, string>): Promise<T> {
    const params = new URLSearchParams(query);
    return this.fetchJson<T>(`${this.baseUrl}${path}?${params}`, { method: "DELETE" });
  }

  /**
   * Invoke a Feathers CUSTOM METHOD. These are not ordinary REST verbs — the
   * transport is a POST to the service path with the method name in a header.
   */
  async customMethod<T = Json>(path: string, method: string, data: unknown = {}): Promise<T> {
    return this.fetchJson<T>(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "X-Service-Method": method },
      body: JSON.stringify(data),
    });
  }

  // ── records ───────────────────────────────────────────────────────────────

  /** Where a record type lives, and whether `recordType` belongs in the body. */
  recordEndpoint(recordType: string): { path: string; carriesRecordType: boolean } {
    if (DEDICATED_RECORD_ENDPOINTS.has(recordType)) {
      return { path: `/${recordType}`, carriesRecordType: false };
    }
    return { path: "/records", carriesRecordType: true };
  }

  async findRecords<T = Json>(
    recordType: string,
    campaignId: string,
    extra: Query = {},
  ): Promise<Paginated<T>> {
    const { path, carriesRecordType } = this.recordEndpoint(recordType);
    const query: Query = { campaignId, ...extra };
    if (carriesRecordType) query.recordType = recordType;
    return this.find<T>(path, query);
  }

  /**
   * Like {@link findRecords} but pages past the server's 50-row cap.
   *
   * `$limit` is NOT a way around that cap — the service clamps every page to 50
   * however large a limit you ask for, so a request for 200 quietly returns 50.
   * Anything wanting more has to walk `$skip`.
   */
  async findAllRecords<T = Json>(
    recordType: string,
    campaignId: string,
    extra: Query = {},
    max = 500,
  ): Promise<{ rows: T[]; total: number }> {
    const { path, carriesRecordType } = this.recordEndpoint(recordType);
    const query: Query = { campaignId, ...extra };
    if (carriesRecordType) query.recordType = recordType;

    const rows: T[] = [];
    let total = 0;
    let skip = 0;
    for (;;) {
      const page = await this.find<T>(path, { ...query, $limit: PAGE, $skip: skip });
      total = page.total ?? rows.length + page.data.length;
      rows.push(...page.data);
      skip += PAGE;
      if (page.data.length === 0 || rows.length >= total || rows.length >= max) break;
    }
    return { rows: rows.slice(0, max), total };
  }

  async createRecord<T = Json>(recordType: string, payload: Json): Promise<T> {
    const { path, carriesRecordType } = this.recordEndpoint(recordType);
    const body = { ...payload };
    if (carriesRecordType) body.recordType = recordType;
    else delete body.recordType;
    return this.create<T>(path, body);
  }

  async patchRecord<T = Json>(recordType: string, id: string, data: Json): Promise<T> {
    const { path } = this.recordEndpoint(recordType);
    return this.patch<T>(path, id, data);
  }

  async deleteRecord<T = Json>(recordType: string, id: string): Promise<T> {
    const { path } = this.recordEndpoint(recordType);
    return this.remove<T>(path, id);
  }

  // ── campaigns ─────────────────────────────────────────────────────────────

  async campaignByInviteCode(inviteCode: string): Promise<Json | null> {
    const res = await this.find(`/campaigns`, { inviteCode });
    return res.data[0] ?? null;
  }

  // ── journals ──────────────────────────────────────────────────────────────

  /**
   * A journal's page OUTLINE (id / name / pageNumber / indent — no content).
   *
   * The plain REST `find` on /journal-pages is unusable with a GM token: the query
   * validator whitelists _id/journalId/name/… while the auth hook demands moduleId or
   * campaignId — a combination no client can satisfy. The `pages` custom method on
   * /journal-functions is the supported path.
   */
  async journalPages<T = Json>(journalId: string): Promise<T> {
    return this.customMethod<T>("/journal-functions", "pages", { journalId });
  }

  // ── 3D ────────────────────────────────────────────────────────────────────

  /** The admin 3D asset catalog (floors, walls, doors, windows, props, roofs, lights). */
  async assets3d<T = Json>(query: Query = {}): Promise<T[]> {
    return this.findAll<T>("/assets-3d", query);
  }

  /** Resolve a room style into a concrete kit (or list the styles when `style` is absent). */
  async roomKit<T = Json>(data: Json = {}): Promise<T> {
    return this.customMethod<T>("/assets-3d", "roomKit", data);
  }

  /** Every placed object on a 3D scene. The service requires a campaign scope. */
  async sceneObjects3d<T = Json>(sceneId: string, campaignId: string): Promise<T[]> {
    return this.findAll<T>("/scene-objects-3d", { sceneId, campaignId });
  }

  /** Bulk-create placed objects — the service accepts an array. */
  async createSceneObjects3d<T = Json>(objects: Json[]): Promise<T> {
    return this.create<T>("/scene-objects-3d", objects);
  }

  async clearSceneObjects3d<T = Json>(sceneId: string, campaignId: string): Promise<T> {
    return this.removeMany<T>("/scene-objects-3d", { sceneId, campaignId });
  }

  // ── uploads ───────────────────────────────────────────────────────────────

  /** Upload a file; the response is PLAIN TEXT — the stored relative path. */
  async upload(fileName: string, data: Uint8Array, assetKind?: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([data]), fileName);

    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (assetKind) headers["X-Asset-Kind"] = assetKind;

    const res = await fetch(`${this.baseUrl}/upload`, { method: "POST", headers, body: form });
    if (!res.ok) {
      let message: string;
      try {
        const body = (await res.json()) as { message?: string };
        message = body.message || res.statusText;
      } catch {
        message = res.statusText;
      }
      throw new ApiError(res.status, message, "POST", `${this.baseUrl}/upload`);
    }
    return (await res.text()).trim();
  }
}
