#!/usr/bin/env node
/**
 * Realm VTT MCP server.
 *
 * Speaks MCP over stdio, so anything on stdout is protocol traffic — every log,
 * warning and crash goes to stderr.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerGuideTools } from "./tools/guide.js";
import { registerImageTools } from "./tools/images.js";
import { registerJournalTools } from "./tools/journals.js";
import { registerRecordTools } from "./tools/records.js";
import { registerRulesetTools } from "./tools/rulesets.js";
import { registerScene3dTools } from "./tools/scenes3d.js";
import { registerSoundTools } from "./tools/sounds.js";
import { registerMarkerTools } from "./tools/markers.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerReferenceTools } from "./tools/references.js";
import { registerAuditTools } from "./tools/audit.js";

export const SERVER_NAME = "realmvtt";
export const SERVER_VERSION = "0.9.2";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for a Realm VTT campaign: records (NPCs, items, spells, tables, characters), " +
        "effects, journals, encounters, rulesets, folders, and 3D scene building.\n\n" +
        "Start with `realm_whoami`. If it reports no session, call `realm_login`. " +
        "Then select a campaign with `realm_use_campaign` before using campaign-scoped tools.",
    },
  );

  registerAuthTools(server);
  registerRecordTools(server);
  registerJournalTools(server);
  registerImageTools(server);
  registerRulesetTools(server);
  registerScene3dTools(server);
  registerSoundTools(server);
  registerTokenTools(server);
  registerMarkerTools(server);
  registerFolderTools(server);
  registerReferenceTools(server);
  registerAuditTools(server);
  registerGuideTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} MCP server ready`);
}

/**
 * Are we being executed as the program, rather than imported?
 *
 * `process.argv[1]` must be REAL-PATHed before comparing. npm installs a bin as a
 * symlink (`node_modules/.bin/realmvtt-mcp` → `../realmvtt-mcp/dist/index.js`),
 * so argv[1] is the symlink while `import.meta.url` is always the resolved target.
 * Comparing them raw means this never matches under npx or a global install — the
 * process starts, does nothing, and exits 0 in total silence.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] isn't a real file (bundled, or an odd loader) — assume we're the program.
    return true;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}
