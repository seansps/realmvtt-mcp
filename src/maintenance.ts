/**
 * 1.x is in maintenance mode: Realm VTT MCP 2.0 is hosted at mcp.realmvtt.com.
 * The notice appears in the server instructions, realm_whoami, realm_login,
 * the startup log, and once (per process) at the end of the first tool result.
 */
export const MCP2_URL = "https://mcp.realmvtt.com";

export const MAINTENANCE_NOTICE =
  `realmvtt-mcp is in maintenance mode. Realm VTT MCP 2.0 is hosted at ${MCP2_URL}. ` +
  "Add it as a connector in Claude (no install needed). It includes every tool here plus " +
  "live play and headless GM tools. This package keeps working but only receives critical fixes.";

let shown = false;

/** The notice the first time it's asked for in this process, then nothing. */
export function takeNoticeOnce(): string | undefined {
  if (shown) return undefined;
  shown = true;
  return MAINTENANCE_NOTICE;
}

/** Tests only. */
export function resetNoticeForTests(): void {
  shown = false;
}
