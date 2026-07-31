/**
 * Campaign content: records (NPCs, items, spells, tables, characters, and every
 * ruleset-defined type), effects, and encounters.
 *
 * Realm splits these across a few endpoints but they share one editing model, so
 * they share one set of tools here: find / get / write / delete. `write` upserts —
 * an id patches, no id creates — which is how the ruleset-compiler already treats
 * them and keeps the tool count sane.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json, Query } from "../api/client.js";
import { session, withAuthRecovery } from "../context.js";
import { campaignArg, confirmArg, json, requireConfirm, safe, text } from "./registry.js";

/** Trim a record down to something worth putting in front of a model. */
function summarize(doc: Json): Json {
  const { _id, name, recordType, category, portrait, shared, locked, moduleId, folderId } =
    doc as {
      [k: string]: unknown;
    };
  return {
    id: _id,
    name,
    ...(recordType ? { recordType } : {}),
    ...(category ? { category } : {}),
    ...(folderId ? { folderId } : {}),
    ...(portrait ? { portrait } : {}),
    ...(shared !== undefined ? { shared } : {}),
    ...(locked ? { locked } : {}),
    ...(moduleId ? { moduleId } : {}),
  } as Json;
}

/**
 * Realm splits campaign content across four endpoint families. Callers pick one
 * with a single `type`, but the distinction is real and worth stating plainly —
 * guessing wrong is a 404 or a silently mis-shaped record.
 */
const RECORD_TYPE_GUIDE =
  "Which kind of content:\n" +
  "• `characters` — player characters (their own API; sheet data lives under `data`)\n" +
  "• `npcs` — NPCs and monsters (their own API)\n" +
  "• `tables` — roll tables (their own API and a distinct shape; WRITE them with " +
  "`realm_write_table`, not `realm_write_record`)\n" +
  "• anything else — `items`, `spells`, `feats`, `classes`, … whatever record types " +
  "the campaign's RULESET defines. These all share the /records API and are told apart " +
  "by this value, so use the exact plural lowercase type the ruleset declares " +
  "(check with `realm_list_rulesets` → `realm_get_ruleset` if unsure).";

const recordTypeArg = z.string().describe(RECORD_TYPE_GUIDE);

/** Which services a table cell may point at. `records` covers every ruleset-defined
 *  type (items, spells, …), which is then narrowed by `recordType` on the link. */
export const LINK_TYPES = [
  "tables",
  "scenes",
  "npcs",
  "characters",
  "records",
  "journals",
  "encounters",
  "effects",
  "images",
  "sounds",
  "decks",
] as const;

export type LinkType = (typeof LINK_TYPES)[number];

export interface CellLinkInput {
  type: LinkType;
  id: string;
  name: string;
  recordType?: string;
}

/**
 * Build the `recordLink` a table cell stores.
 *
 * The app writes these by dragging a record onto a cell and then stripping it down
 * (`sanitizeRecordLink`) to just what display and navigation need. We construct that
 * stripped form directly — storing a whole record here bloats every table row.
 */
export function buildRecordLink(link: CellLinkInput): Json {
  const value: Json = { _id: link.id, name: link.name };
  if (link.type === "records" && link.recordType) value.recordType = link.recordType;
  const built: Json = { type: link.type, tooltip: link.name, value };
  // `scenes` is the one type with a fixed icon across every campaign — the map
  // glyph the Scenes panel itself drags. Any other type's icon is defined
  // per-ruleset, so we leave it off rather than guess and let the app resolve it.
  if (link.type === "scenes") {
    built.icon = "IconMap";
    value.icon = "IconMap";
  }
  return built;
}

/** An effect rule type declared by a ruleset (`ruleset.effects[]`). */
export interface RulesetEffectType {
  label: string;
  type: string;
  freeTextField?: boolean;
  fields?: Array<{ label: string; field: string }>;
}

/**
 * The rule types Realm ships with. Every campaign has these; a ruleset adds its own
 * on top (and may redefine one of these to give it a field list).
 */
export const BUILT_IN_EFFECT_TYPES: Array<{ type: string; label: string }> = [
  { type: "data", label: "Alter a Data Field" },
  { type: "override", label: "Override a Data Field" },
  { type: "choiceSet", label: "Offer a Choice" },
  { type: "input", label: "Prompt for a Value" },
  { type: "aura", label: "Emit an Aura" },
  { type: "light", label: "Set a Light" },
  { type: "senses", label: "Set Senses" },
  { type: "token", label: "Change the Token" },
  { type: "addEffect", label: "Apply Another Effect" },
];

const TABLE_LINKING_GUIDE = `Linking roll-table results
==========================

Any result cell can carry a LINK alongside its text, so rolling the table hands the
GM a clickable record — an NPC, an item, a journal page, or ANOTHER TABLE.

Setting a link
--------------
With \`realm_write_table\`, give the cell a \`link\`:

  { text: "A snarling wolf", link: { type: "npcs", id: "<npcId>", name: "Wolf" } }

\`type\` names the service the target lives in:
  tables · scenes · npcs · characters · records · journals · encounters · effects · images · sounds · decks

A \`scenes\` link sends the table to a map: rolling it hands the GM a link that asks
whether to view or activate that scene.

For anything the RULESET defines (items, spells, feats, …) use type "records" and add
\`recordType\`, because those all share one service:

  { text: "Longsword", link: { type: "records", recordType: "items", id: "<id>", name: "Longsword" } }

Find the id first with \`realm_find_records\` (or \`realm_find_records\` type \`tables\`
for a table). The link stores only { _id, name } — never paste a whole record in.

Tables that roll on tables
--------------------------
A cell whose link is \`type: "tables"\` chains: rolling the parent table and following
that result rolls the linked table too. That is the entire mechanism — there is no
separate "subtable" field.

  { text: "Roll on the Treasure table", link: { type: "tables", id: "<tableId>", name: "Treasure" } }

Rolling a linked table SEVERAL times — the [Nx] prefix
------------------------------------------------------
Put a multiplier at the START of the cell's text to roll the linked table more than
once. The brackets must end in \`x\`:

  "[2x] gemstones"     → roll the linked table exactly 2 times
  "[1d4x] trinkets"    → roll 1d4, then roll the linked table that many times
  "[2d6x] coins"       → roll 2d6, then roll the linked table that many times

The prefix is stripped from the text that gets shown, and it only means anything on a
cell that HAS a table link.

Inline dice — [dice] without the x
----------------------------------
Bracketed dice that do NOT end in \`x\` are rolled and substituted into the result text
when the row comes up:

  "You find [2d6] gold pieces"   → "You find 9 gold pieces"
  "[1d4] rations"                → "3 rations"

So the two conventions are told apart purely by the trailing \`x\`: \`[1d4x]\` decides HOW
MANY TIMES to roll a linked table, \`[1d4]\` prints a rolled NUMBER in the text. Bare
dice outside brackets are left alone as prose.`;

export function registerRecordTools(server: McpServer): void {
  server.registerTool(
    "realm_find_records",
    {
      title: "Find campaign records",
      description:
        "Search a campaign's records by type, optionally filtered by name (exact) or a free-text " +
        "search. Returns summaries — use `realm_get_record` for a full record.",
      inputSchema: {
        type: recordTypeArg,
        name: z.string().optional().describe("Exact name match."),
        search: z.string().optional().describe("Free-text search across the record."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Max results (default 50). The API caps a page at 50, so anything above that is " +
              "fetched by paging — `total` always reports how many exist.",
          ),
        full: z
          .boolean()
          .optional()
          .describe("Return complete records instead of summaries. Use sparingly — records are large."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const extra: Record<string, string | number> = {};
        if (args.name) extra.name = args.name;
        if (args.search) extra.$search = args.search;

        // Pages past the server's hard 50-per-page cap; `$limit` alone can't exceed it.
        const { rows, total } = await client.findAllRecords<Json>(
          args.type,
          campaignId,
          extra,
          args.limit ?? 50,
        );

        return json({
          type: args.type,
          total,
          returned: rows.length,
          ...(total > rows.length
            ? { note: `${total - rows.length} more exist — raise \`limit\` or narrow the search.` }
            : {}),
          records: args.full ? rows : rows.map(summarize),
        });
      });
    }),
  );

  server.registerTool(
    "realm_get_record",
    {
      title: "Get one campaign record",
      description: "Fetch a single record in full by its id.",
      inputSchema: {
        id: z.string().describe("Record id."),
        type: recordTypeArg.optional().describe(
          "Record type, needed only for `npcs`, `tables` or `characters` (they live on their own endpoints).",
        ),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const { path } = client.recordEndpoint(args.type ?? "records");
        return json(await client.get<Json>(path, args.id), 60_000);
      });
    }),
  );

  server.registerTool(
    "realm_write_record",
    {
      title: "Create or update a campaign record",
      description:
        "Write a character, NPC, or ruleset-defined record (item, spell, feat, class, …). " +
        "With `id` it patches that record; without one it creates a new record in the campaign. " +
        "Ruleset fields usually live under `data` — fetch a similar existing record first to see " +
        "the shape that campaign's ruleset expects, since it differs per ruleset. " +
        "For roll tables use `realm_write_table` instead.",
      inputSchema: {
        type: recordTypeArg,
        id: z.string().optional().describe("Record id to update. Omit to create."),
        record: z
          .record(z.string(), z.unknown())
          .describe(
            "The record body: `name` plus ruleset fields (usually under `data`). campaignId and " +
              "recordType are filled in automatically.",
          ),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      if (args.type === "tables") {
        return text(
          "Roll tables have their own shape (a die-roll expression plus rows with value ranges). " +
            "Use `realm_write_table` instead.",
        );
      }
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) {
          const updated = await client.patchRecord<Json>(args.type, args.id, args.record as Json);
          return json({ updated: summarize(updated) });
        }
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const created = await client.createRecord<Json>(args.type, {
          ...(args.record as Json),
          campaignId,
        });
        return json({ created: summarize(created) });
      });
    }),
  );

  // ── roll tables ───────────────────────────────────────────────────────────

  server.registerTool(
    "realm_table_linking_guide",
    {
      title: "How to link table cells to records and other tables",
      description:
        "Explain the linking and dice conventions for roll tables — how a result cell points at " +
        "an NPC/item/journal, how a table rolls on another table, and the `[Nx]` / `[NdMx]` " +
        "prefix that rolls a linked table several times. Read this before authoring a table " +
        "with links.",
      inputSchema: {},
    },
    safe(async () => text(TABLE_LINKING_GUIDE)),
  );

  server.registerTool(
    "realm_write_table",
    {
      title: "Create or update a roll table",
      description:
        "Write a roll table. With `id` it patches, without one it creates.\n\n" +
        "The shape is specific:\n" +
        "• `dieRoll` — the expression rolled on the table, e.g. `1d100`, `2d6`.\n" +
        "• `columns` — a COUNT, not a list. It is the number of result columns AFTER the " +
        "implicit first column (which always holds the rolled range).\n" +
        "• `columnNames` — the headings for those result columns; its length must equal `columns`.\n" +
        "• `rows` — `[{ minValue, maxValue, columns: [{ text }] }]`. `minValue`/`maxValue` are the " +
        "inclusive roll range for that row (use the same number for both on a single-value row), " +
        "and each row's `columns` array must also have `columns` entries, in order.\n\n" +
        "So a d100 table with one 'Result' column: columns: 1, columnNames: ['Result'], " +
        "rows: [{ minValue: 1, maxValue: 10, columns: [{ text: 'A rusty dagger' }] }, …]. " +
        "Cover the die's whole range with no gaps or overlaps.\n\n" +
        "LINKS: a cell may carry a `link` to a record, journal, encounter — or another TABLE, " +
        "which is how a table rolls on a table. Prefix the cell text with `[2x]` or `[1d4x]` to " +
        "roll a linked table that many times, and use `[2d6]` (no trailing x) for inline dice " +
        "substituted into the text. Call `realm_table_linking_guide` for the details.",
      inputSchema: {
        id: z.string().optional().describe("Table id to update. Omit to create."),
        name: z.string().describe("Table name."),
        dieRoll: z.string().describe("Die expression rolled on this table, e.g. `1d100`."),
        columnNames: z
          .array(z.string())
          .min(1)
          .describe("Headings for the result columns (excluding the implicit roll-range column)."),
        rows: z
          .array(
            z.object({
              minValue: z.number().describe("Lowest roll that hits this row (inclusive)."),
              maxValue: z.number().describe("Highest roll that hits this row (inclusive)."),
              columns: z
                .array(
                  z.object({
                    text: z
                      .string()
                      .describe(
                        "Result text. May start with `[2x]`/`[1d4x]` to roll a linked table " +
                          "that many times, and may contain `[2d6]` for inline dice.",
                      ),
                    link: z
                      .object({
                        type: z
                          .enum(LINK_TYPES)
                          .describe(
                            "Where the target lives. Use `tables` to chain onto another table, " +
                              "and `records` (plus recordType) for ruleset types like items or spells.",
                          ),
                        id: z.string().describe("The target's _id."),
                        name: z.string().describe("The target's name, shown on the link."),
                        recordType: z
                          .string()
                          .optional()
                          .describe("Required with type `records`, e.g. `items`, `spells`."),
                      })
                      .optional()
                      .describe("Optional link from this cell to a record, journal, or table."),
                  }),
                )
                .describe("One entry per result column, in the order of columnNames."),
            }),
          )
          .min(1)
          .describe("The table's rows."),
        category: z.string().optional().describe("Optional grouping category."),
        shared: z.boolean().optional().describe("Visible to players."),
        showResult: z.boolean().optional().describe("Show the roll result when rolled."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const width = args.columnNames.length;

      // Catch the mistakes that produce a table which saves but renders wrong.
      const badRows = args.rows
        .map((r, i) => ({ i, r }))
        .filter(({ r }) => r.columns.length !== width || r.minValue > r.maxValue);
      if (badRows.length) {
        const first = badRows[0]!;
        return text(
          first.r.columns.length !== width
            ? `Row ${first.i + 1} has ${first.r.columns.length} column(s) but columnNames declares ${width}. ` +
                `Every row needs exactly one entry per column name.`
            : `Row ${first.i + 1} has minValue ${first.r.minValue} greater than maxValue ${first.r.maxValue}.`,
        );
      }

      // Guard the multiplier convention: `[2x]` only does anything on a cell that
      // actually links to a table, and silently doing nothing is worse than saying so.
      const strayMultiplier = args.rows.flatMap((r, ri) =>
        r.columns
          .map((c, ci) => ({ ri, ci, c }))
          .filter(({ c }) => /^\s*\[[^\]]*x\]/i.test(c.text) && c.link?.type !== "tables"),
      );
      if (strayMultiplier.length) {
        const { ri, ci } = strayMultiplier[0]!;
        return text(
          `Row ${ri + 1}, column ${ci + 1} starts with an [Nx] multiplier but has no table link. ` +
            `That prefix only means anything on a cell whose link is type "tables" — either add ` +
            `the link, or drop the prefix (use [2d6] without the x for inline dice in the text).`,
        );
      }

      const rows = args.rows.map((r) => ({
        minValue: r.minValue,
        maxValue: r.maxValue,
        columns: r.columns.map((c) => ({
          text: c.text,
          ...(c.link ? { recordLink: buildRecordLink(c.link) } : {}),
        })),
      }));

      const body: Json = {
        name: args.name,
        dieRoll: args.dieRoll,
        columns: width,
        columnNames: args.columnNames,
        rows,
        ...(args.category ? { category: args.category } : {}),
        ...(args.shared !== undefined ? { shared: args.shared } : {}),
        ...(args.showResult !== undefined ? { showResult: args.showResult } : {}),
      };

      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) {
          return json({ updated: summarize(await client.patchRecord<Json>("tables", args.id, body)) });
        }
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const created = await client.createRecord<Json>("tables", { ...body, campaignId });
        return json({
          created: summarize(created),
          rows: args.rows.length,
          range: `${Math.min(...args.rows.map((r) => r.minValue))}–${Math.max(
            ...args.rows.map((r) => r.maxValue),
          )}`,
        });
      });
    }),
  );

  server.registerTool(
    "realm_delete_record",
    {
      title: "Delete a campaign record",
      description: "Permanently delete a record. Requires confirm: true.",
      inputSchema: {
        id: z.string().describe("Record id."),
        type: recordTypeArg,
        ...confirmArg,
      },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `delete ${args.type} record ${args.id}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        await client.deleteRecord(args.type, args.id);
        return text(`Deleted ${args.type} record ${args.id}.`);
      });
    }),
  );

  // ── effects ───────────────────────────────────────────────────────────────

  server.registerTool(
    "realm_find_effects",
    {
      title: "Find campaign effects",
      description:
        "List or search the campaign's effects. Effects modify character data through Data, " +
        "Override, ChoiceSet, Input, Aura and Light rules — call `realm_guide` with topic " +
        "`effects` before authoring one.",
      inputSchema: {
        name: z.string().optional().describe("Exact name match."),
        limit: z.number().int().min(1).max(200).optional(),
        full: z.boolean().optional().describe("Return complete effects including their rules."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Query = { campaignId };
        if (args.name) query.name = args.name;

        // Pages past the 50-row cap rather than pretending `$limit` can beat it.
        const rows = await client.findAll<Json>("/effects", query);
        const limited = rows.slice(0, args.limit ?? 50);

        return json(
          {
            total: rows.length,
            returned: limited.length,
            ...(rows.length > limited.length
              ? { note: `${rows.length - limited.length} more exist — raise \`limit\`.` }
              : {}),
            effects: args.full ? limited : limited.map(summarize),
          },
          args.full ? 60_000 : 24_000,
        );
      });
    }),
  );

  server.registerTool(
    "realm_effect_types",
    {
      title: "List the effect rule types this campaign supports",
      description:
        "Read the campaign's ruleset and list every effect rule type available, with the fields " +
        "each one targets. This is the union of Realm's nine built-in types and the types the " +
        "RULESET declares — and a system's own content usually depends on the latter (bonus " +
        "categories, condition tracks, resource pools), which differ completely between systems. " +
        "Call this before authoring an effect for an unfamiliar campaign.",
      inputSchema: { ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const campaign = await client.get<Json>("/campaigns", campaignId);
        const rulesetId = campaign.rulesetId ? String(campaign.rulesetId) : "";

        let declared: RulesetEffectType[] = [];
        if (rulesetId) {
          const ruleset = await client.get<{ effects?: RulesetEffectType[] }>(
            "/rulesets",
            rulesetId,
          );
          declared = Array.isArray(ruleset.effects) ? ruleset.effects : [];
        }

        // The app merges the same way: the ruleset's types first, then any built-in
        // it didn't already define. A ruleset CAN redefine a built-in's label/fields.
        const seen = new Set(declared.map((e) => e.type));
        const types = [
          ...declared.map((e) => ({
            type: e.type,
            label: e.label,
            source: "ruleset" as const,
            freeTextField: Boolean(e.freeTextField),
            fields: (e.fields ?? []).map((f) => ({ field: f.field, label: f.label })),
          })),
          ...BUILT_IN_EFFECT_TYPES.filter((t) => !seen.has(t.type)).map((t) => ({
            ...t,
            source: "built-in" as const,
            freeTextField: false,
            fields: [],
          })),
        ];

        return json({
          campaignId,
          rulesetId: rulesetId || null,
          note:
            declared.length > 0
              ? "Rule shape: { type, field, valueType, value }. A custom `field` string is always " +
                "allowed, but prefer a declared one — the ruleset's scripts look for those."
              : "This campaign's ruleset declares no extra effect types, so only the built-ins apply.",
          types,
        });
      });
    }),
  );

  server.registerTool(
    "realm_write_effect",
    {
      title: "Create or update an effect",
      description:
        "Write an effect. With `id` it patches, without one it creates.\n\n" +
        "`rules` is an array of { type, field, valueType, value }. Call `realm_effect_types` " +
        "first to see which types this campaign actually supports — the RULESET declares its own " +
        "on top of the nine built-ins, and a system's content usually depends on those. " +
        "Then read `realm_guide` topic `effects` (or `effects-quick` for syntax): " +
        "`@record.data.path` references, inline `{math}` and merge semantics are all easy to get " +
        "subtly wrong in ways that still save cleanly.\n\n" +
        "`durationUnit` is one of: indefinite, start_turn, end_turn, start_applier_turn, " +
        "end_applier_turn, rounds, minutes, hours, days, seconds-real. Note that the plain " +
        "`*_turn` units follow the AFFECTED token while `*_applier_turn` follow the caster — " +
        "see `realm_guide` topic `effects-durations`.",
      inputSchema: {
        id: z.string().optional().describe("Effect id to update. Omit to create."),
        effect: z
          .record(z.string(), z.unknown())
          .describe("Effect body: name, description, rules[], duration, durationUnit, etc."),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) {
          return json({ updated: summarize(await client.patch<Json>("/effects", args.id, args.effect)) });
        }
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const created = await client.create<Json>("/effects", { ...(args.effect as Json), campaignId });
        return json({ created: summarize(created) });
      });
    }),
  );

  server.registerTool(
    "realm_delete_effect",
    {
      title: "Delete an effect",
      description: "Permanently delete an effect. Requires confirm: true.",
      inputSchema: { id: z.string().describe("Effect id."), ...confirmArg },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `delete effect ${args.id}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        await client.remove("/effects", args.id);
        return text(`Deleted effect ${args.id}.`);
      });
    }),
  );

  // ── encounters ────────────────────────────────────────────────────────────

  server.registerTool(
    "realm_find_encounters",
    {
      title: "List campaign encounters",
      description:
        "List encounters — named groups of NPCs with per-entry counts (a count may be a dice " +
        "formula like `1d4`).",
      inputSchema: { name: z.string().optional(), ...campaignArg },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        const query: Query = { campaignId };
        if (args.name) query.name = args.name;
        const encounters = await client.findAll<Json>("/encounters", query);
        return json({ total: encounters.length, encounters });
      });
    }),
  );

  server.registerTool(
    "realm_write_encounter",
    {
      title: "Create or update an encounter",
      description:
        "Write an encounter — a named group of NPCs with a per-entry count. Look up npcIds with " +
        "`realm_find_records` type `npcs` first.\n\n" +
        "`count` is always a STRING, and it is an expression, not just a number:\n" +
        "• a fixed number — `\"1\"`, `\"6\"`\n" +
        "• dice — `\"1d6\"`, `\"1d4+1\"`, `\"2d4\"` (rolled when the encounter is added to the tracker)\n" +
        "• party size — `$PC` (or `#PC`, identical) becomes the number of PCs on the party sheet\n" +
        "• arithmetic — `*` and `/` are evaluated, division rounding DOWN\n\n" +
        "So \"3 goblins per PC\" is `\"3*$PC\"`, \"half as many ogres as PCs\" is `\"$PC/2\"`, " +
        "and \"one wolf pack of 1d4+1\" is `\"1d4+1\"`.\n\n" +
        "CAUTION: `*` and `/` are resolved by a plain numeric substitution BEFORE the dice are " +
        "rolled, so never put a die on the left of `*` — `\"1d4*$PC\"` with 4 PCs mangles into " +
        "`1d16`, not four separate d4s. Keep multiplication to plain numbers (`\"3*$PC\"`). " +
        "An encounter is also capped at 100 tokens total when added to the combat tracker.",
      inputSchema: {
        id: z.string().optional().describe("Encounter id to update. Omit to create."),
        encounter: z
          .record(z.string(), z.unknown())
          .describe(
            "Encounter body: `name` plus a non-empty `npcs` array of { npcId, name, count } — " +
              "count being the string expression described above.",
          ),
        ...campaignArg,
      },
    },
    safe(async (args) => {
      // Catch the dice-times-number mangling before it silently ships a wrong encounter.
      const entries = (args.encounter as { npcs?: Array<{ name?: string; count?: unknown }> }).npcs;
      for (const npc of entries ?? []) {
        const count = String(npc?.count ?? "");
        if (/\d*d\d+\s*[*/]/i.test(count)) {
          return text(
            `The count "${count}" for ${npc?.name ?? "an NPC"} puts a die on the left of ` +
              `${count.includes("*") ? "*" : "/"}. Realm substitutes the arithmetic numerically ` +
              `before rolling, so "1d4*3" becomes "1d12" rather than three d4 rolls. ` +
              `Use a plain number on the left (e.g. "3*$PC"), or a flat dice expression like "2d4".`,
          );
        }
      }

      const client = session.client();
      return withAuthRecovery(async () => {
        if (args.id) {
          return json({ updated: await client.patch<Json>("/encounters", args.id, args.encounter) });
        }
        const campaignId = await session.resolveCampaignId(client, args.campaign);
        return json({
          created: await client.create<Json>("/encounters", {
            ...(args.encounter as Json),
            campaignId,
          }),
        });
      });
    }),
  );

  server.registerTool(
    "realm_delete_encounter",
    {
      title: "Delete an encounter",
      description: "Permanently delete an encounter. Requires confirm: true.",
      inputSchema: { id: z.string().describe("Encounter id."), ...confirmArg },
    },
    safe(async (args) => {
      requireConfirm(args.confirm, `delete encounter ${args.id}`);
      const client = session.client();
      return withAuthRecovery(async () => {
        await client.remove("/encounters", args.id);
        return text(`Deleted encounter ${args.id}.`);
      });
    }),
  );
}
