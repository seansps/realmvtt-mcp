/**
 * Where Realm's assets are served from.
 *
 * Its own module purely so the things that build asset URLs — images, sounds, the
 * icon catalog — can share it without importing each other. `images.ts` re-exports
 * both names, since that is where callers historically found them.
 */

/** Uploaded files and the stock icon catalog are both served from here. Stored
 *  paths (`/images/…`, `/sounds/…`, `/icons/…`) are relative to it. */
export const ASSET_CDN = "https://assets.realmvtt.com";

export function cdnUrl(storedPath: string): string {
  const path = storedPath.startsWith("/") ? storedPath : `/${storedPath}`;
  return `${ASSET_CDN}${path}`;
}
