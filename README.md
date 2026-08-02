<div align="center">

# Realm VTT MCP

**Bring your own AI agent to [Realm VTT](https://www.realmvtt.com).**

Write NPCs, author effects, build roll tables, edit rulesets, organize your
campaign into folders and construct 3D scenes — by asking.

</div>

---

## Install

```bash
claude mcp add realmvtt -- npx -y realmvtt-mcp
```

Then, in Claude:

> **log me into Realm VTT**

A sign-in page opens in your browser. If you're already signed in at
play.realmvtt.com you're done in one click — no typing, no developer tools, and it
works with Google accounts. Otherwise sign in with your email and password on that
page.

That's the whole setup. Your login is remembered for 30 days.

<details>
<summary>Claude Desktop, VS Code, or another MCP client</summary>

Add this to your client's MCP configuration:

```json
{
  "mcpServers": {
    "realmvtt": {
      "command": "npx",
      "args": ["-y", "realmvtt-mcp"]
    }
  }
}
```

Requires Node 20 or newer.
</details>

<details>
<summary>Headless / CI use</summary>

Set `REALMVTT_JWT` to a Realm VTT token and the browser flow is skipped entirely:

```json
{ "env": { "REALMVTT_JWT": "eyJhbGciOi..." } }
```
</details>

## First steps

> **list my Realm VTT campaigns**
>
> **use the campaign with invite code ABC123**

Everything after that works in the campaign you picked.

## What you can ask for

**Campaign content**

> Create a goblin ambusher NPC with 11 HP and a shortbow attack
>
> Find every spell in my campaign with "fire" in the name
>
> Add a session-notes journal page summarising tonight's session

**Roll tables**

> Build a d100 wilderness encounter table
>
> Make the "rare loot" row link to my Treasure Hoard table, rolled 1d4 times

Tables can link their results to records — or to **other tables**, which is how a
table rolls on a table. Prefix a linked cell with `[1d4x]` to roll it several times,
or use `[2d6]` anywhere in the text for inline dice.

**Images, maps and portraits**

> Upload ~/maps/tavern.png and make a scene out of it
>
> Give the Goblin Ambusher this portrait and use it as its token too
>
> Upload these three sketches and put them in the "Ruins of Kaltar" journal page

Uploads go through Realm's normal upload endpoint, so storage quota and asset
tracking are handled server-side exactly as they are in the app.

**Effects**

> Create a Bless effect: +1d4 to attack rolls and saves for 1 minute
>
> What effect rule types does this campaign's ruleset support?

The server bundles Realm's full effects reference, plus guides to duration units
(the difference between "end of turn" and "end of the *caster's* turn" matters) and
to the rule types **your ruleset** adds on top of the built-in ones.

**Encounters**

> Make an encounter with 3 goblins per PC and 1d4+1 wolves

`$PC` is the party size; counts can be dice or arithmetic.

**Rulesets**

> List the published rulesets
>
> Download the D&D 5e ruleset so you can see how it does spell records
>
> Compile my ruleset directory and push it

Rulesets are downloaded to a file rather than dumped into the conversation — they
run to megabytes. If you keep yours as source files, the server can drive your
local `ruleset-compiler` checkout — point it there once with `compilerPath` (or the
`REALMVTT_RULESET_COMPILER` env var) and it's remembered.

**3D scenes**

> Search the 3D catalog for fantasy dungeon walls
>
> Build a two-story tavern at 10,10 — common room downstairs, four guest rooms up,
> stairs in the back corner
>
> Carve a winding cave passage from the entrance to the chamber at 40,25
>
> Find a goblin mini and put it on my Goblin Ambusher NPC

The server knows Realm's 3D geometry: floor and wall heights, how stories stack, how
a door replaces a wall, which way a prop faces, how to build *below* ground, how
secret doors actually work, and how cave wall pieces connect. It can pull a
pre-matched **room kit** for a style, or search the whole asset catalog and compose
something bespoke — the layout is the agent's to design, not a template's.

## Tools

<details>
<summary>The full list</summary>

| | |
|---|---|
| **Session** | `realm_login` · `realm_whoami` · `realm_logout` |
| **Campaigns** | `realm_list_campaigns` · `realm_use_campaign` |
| **Records** | `realm_find_records` · `realm_get_record` · `realm_write_record` · `realm_delete_record` |
| **Tables** | `realm_write_table` · `realm_table_linking_guide` |
| **Effects** | `realm_find_effects` · `realm_write_effect` · `realm_delete_effect` · `realm_effect_types` |
| **Encounters** | `realm_find_encounters` · `realm_write_encounter` · `realm_delete_encounter` |
| **Folders** | `realm_list_folders` · `realm_write_folder` · `realm_move_to_folder` · `realm_delete_folder` |
| **Journals** | `realm_find_journals` · `realm_write_journal` · `realm_journal_pages` · `realm_write_journal_page` · `realm_delete_journal_page` |
| **Images** | `realm_upload_image` · `realm_list_images` · `realm_find_image` · `realm_set_portrait` · `realm_journal_image_html` |
| **Scenes** | `realm_create_scene` |
| **Rulesets** | `realm_list_rulesets` · `realm_get_ruleset` · `realm_write_ruleset` · `realm_compile_ruleset` |
| **3D scenes** | `realm_list_scenes` · `realm_get_scene` · `realm_search_3d_assets` · `realm_get_room_kit` · `realm_get_scene_objects` · `realm_place_objects` · `realm_update_object` · `realm_delete_objects` · `realm_clear_scene` |
| **Custom 3D models** | `realm_upload_3d_model` · `realm_list_3d_models` |
| **3D minis** | `realm_search_3d_tokens` · `realm_set_3d_token` |
| **Creature tokens** | `realm_list_tokens` · `realm_place_tokens` · `realm_move_token` · `realm_delete_tokens` |
| **Pins, teleports, text, journal links** | `realm_list_markers` · `realm_add_pin` · `realm_add_teleporter` · `realm_add_text` · `realm_add_journal_link` · `realm_update_journal_link` · `realm_delete_marker` |
| **Links & dependencies** | `realm_find_backlinks` · `realm_dependency_graph` · `realm_validate_links` · `realm_replace_link_target` |
| **Audit & tidying** | `realm_audit_campaign` · `realm_preview_folder_manifest` · `realm_apply_folder_manifest` |
| **Reference** | `realm_guide` |

Deleting anything requires an explicit confirmation, so nothing is destroyed by a
stray tool call.
</details>

## Your login

Stored at `~/.realmvtt-mcp/auth.json`, readable only by you. Your **password is never
stored** — it's sent to Realm VTT once, in exchange for a token. The sign-in page is
served by your own machine on `127.0.0.1`, carries no JavaScript, and can only talk
back to itself.

Tokens last 30 days. When one expires the tools say so and ask you to run
`realm_login` again. `realm_logout` deletes it.

## Troubleshooting

**"Not signed in" / "session has expired"** — run `realm_login` again.

**The sign-in page didn't come back after Google** — you're signed in now, so click
**Connect with Realm VTT** on that page again and it'll complete instantly.

**"Must query by ID, ownerId, campaignId, or moduleId"** — no campaign is selected.
Run `realm_list_campaigns`, then `realm_use_campaign`.

**"validation failed"** — the query used a field that service doesn't accept. Realm
whitelists query fields per service and rejects anything else outright.

## Configuration

| Variable | Purpose |
|---|---|
| `REALMVTT_JWT` | Use this token instead of signing in |
| `REALMVTT_API_URL` | Override the API base URL |
| `REALMVTT_APP_URL` | Override the app URL used for browser sign-in |
| `REALMVTT_RULESET_COMPILER` | Path to your ruleset-compiler checkout |
| `REALMVTT_MCP_HOME` | Where the login and campaign selection are stored |

## Development

```bash
npm install
npm test          # unit tests
npm run typecheck
npm run build
npm run sync:docs # refresh the bundled reference docs from realm15-client
```

## License

MIT
