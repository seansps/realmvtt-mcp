#!/usr/bin/env node
/**
 * Realm VTT MCP server.
 *
 * Speaks MCP over stdio, so anything on stdout is protocol traffic — every log,
 * warning and crash goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerGuideTools } from "./tools/guide.js";
import { registerImageTools } from "./tools/images.js";
import { registerJournalTools } from "./tools/journals.js";
import { registerRecordTools } from "./tools/records.js";
import { registerRulesetTools } from "./tools/rulesets.js";
import { registerScene3dTools } from "./tools/scenes3d.js";

export const SERVER_NAME = "realmvtt";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for a Realm VTT campaign: records (NPCs, items, spells, tables, characters), " +
        "effects, journals, encounters, rulesets, and 3D scene building.\n\n" +
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
  registerGuideTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} MCP server ready`);
}

// Only run when executed directly, so tests can import `createServer`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}
