/**
 * The bundled reference material, served two ways: as a tool the model can call on
 * demand, and as MCP resources a host can surface or attach.
 *
 * No retrieval, no embeddings, no chunking — the topic set is small and closed, and
 * a whole document is what's actually useful. Guessing which paragraph of the
 * effects reference matters is exactly the kind of help that makes effects wrong.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { failure, safe, text } from "./registry.js";

export interface Topic {
  id: string;
  file: string;
  title: string;
  blurb: string;
}

export const TOPICS: Topic[] = [
  {
    id: "effects",
    file: "effects.md",
    title: "Effects system reference",
    blurb:
      "The full effects reference: Data, Override, ChoiceSet, Input, Aura and Light rules, " +
      "`@record.data.path` expressions, inline {math}, merging, durations, expiry.",
  },
  {
    id: "effects-quick",
    file: "effects-quick.md",
    title: "Effects quick reference",
    blurb: "Condensed effects syntax — reach for this once you know the model.",
  },
  {
    id: "effects-durations",
    file: "effects-durations.md",
    title: "Effect durations",
    blurb:
      "Every `durationUnit` and exactly when it expires — including the difference between the " +
      "affected token's turn and the CASTER's turn, and rounds vs game time vs real time.",
  },
  {
    id: "effects-ruleset",
    file: "effects-ruleset.md",
    title: "Ruleset-defined effect rules",
    blurb:
      "A ruleset declares its OWN effect rule types on top of the nine built-ins, and a system's " +
      "content usually depends on them. How they work, and how to discover a campaign's set.",
  },
  {
    id: "3d-scene-authoring",
    file: "3d-scene-authoring.md",
    title: "3D scene geometry contract",
    blurb:
      "How placed objects work: units, floor/wall heights, building below ground, wall-edge vs " +
      "prop-facing rotation, portals and secret doors, lights, roofs. Read before placing anything.",
  },
  {
    id: "3d-rooms",
    file: "3d-rooms.md",
    title: "Building rooms and stories",
    blurb:
      "Laying out rooms, doors, windows and furniture; stacking stories; stairs; multi-room " +
      "buildings. Design guidance, not a generator.",
  },
  {
    id: "3d-caves",
    file: "3d-caves.md",
    title: "Building caves",
    blurb: "The cave wall port model and its 9-piece connecting set, and how to chain a passage.",
  },
  {
    id: "3d-assets",
    file: "3d-assets.md",
    title: "3D asset conventions",
    blurb: "Scale, orientation and pivot rules that every 3D asset follows.",
  },
  {
    id: "api",
    file: "api.md",
    title: "Realm VTT API notes",
    blurb:
      "Which endpoint holds what, record types vs rulesets, pagination and scope rules, and what " +
      "each error status actually means.",
  },
];

const TOPIC_IDS = TOPICS.map((t) => t.id) as [string, ...string[]];

/** knowledge/ sits next to the compiled code in dist, and next to the source in dev. */
export function knowledgeDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "knowledge");
}

export async function readTopic(id: string): Promise<string> {
  const topic = TOPICS.find((t) => t.id === id);
  if (!topic) {
    throw new Error(`Unknown topic "${id}". Available: ${TOPICS.map((t) => t.id).join(", ")}`);
  }
  const path = join(knowledgeDir(), topic.file);
  if (!existsSync(path)) {
    throw new Error(`Guide "${id}" is missing from this install (expected ${path}).`);
  }
  return readFile(path, "utf8");
}

export function topicIndex(): string {
  return [
    "Available guides — call `realm_guide` with one of these topics:",
    "",
    ...TOPICS.map((t) => `• ${t.id} — ${t.title}\n  ${t.blurb}`),
  ].join("\n");
}

export function registerGuideTools(server: McpServer): void {
  server.registerTool(
    "realm_guide",
    {
      title: "Read a Realm VTT reference guide",
      description:
        "Read bundled reference documentation. Call with no topic to list what's available.\n\n" +
        "Read `3d-scene-authoring` before building any 3D scene, and `effects` before authoring " +
        "an effect — both describe conventions that produce plausible-looking but wrong results " +
        "when guessed at.",
      inputSchema: {
        topic: z
          .enum(TOPIC_IDS)
          .optional()
          .describe("Which guide to read. Omit to list the available topics."),
      },
    },
    safe(async ({ topic }: { topic?: string }) => {
      if (!topic) return text(topicIndex());
      return text(await readTopic(topic));
    }),
  );

  // The same material as resources, so a host can list or attach it directly.
  for (const t of TOPICS) {
    server.registerResource(
      `realm-guide-${t.id}`,
      `realm://guide/${t.id}`,
      { title: t.title, description: t.blurb, mimeType: "text/markdown" },
      async (uri) => {
        try {
          return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await readTopic(t.id) }] };
        } catch (err) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "text/plain",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      },
    );
  }

  void failure;
}
