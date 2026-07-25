# The Realm VTT API, as these tools use it

Base URL `https://utilities.realmvtt.com`. FeathersJS over REST, bearer-JWT auth.
You don't call it directly — the tools do — but knowing its shape explains the
errors you'll see.

## Where content lives

| Content | Endpoint | Tool |
|---|---|---|
| Player characters | `/characters` | `realm_find_records` / `realm_write_record` type `characters` |
| NPCs and monsters | `/npcs` | …type `npcs` |
| Roll tables | `/tables` | `realm_write_table` (distinct shape) |
| Items, spells, feats, classes, … | `/records` + `recordType` | …type `<the ruleset's type>` |
| Effects | `/effects` | `realm_find_effects` / `realm_write_effect` |
| Encounters | `/encounters` | `realm_find_encounters` / `realm_write_encounter` |
| Journals | `/journals` | `realm_find_journals` |
| Journal pages | `/journal-pages` | `realm_journal_pages` |
| Images | `/images`, `/upload` | `realm_upload_image` |
| Scenes | `/scenes` | `realm_list_scenes` |
| 3D scenery catalog | `/assets-3d` | `realm_search_3d_assets` |
| 3D token (mini) catalog | `/tokens-3d` | `realm_search_3d_tokens` |
| Placed 3D objects | `/scene-objects-3d` | `realm_place_objects` |
| Rulesets | `/rulesets`, `/owned-rulesets`, `/ruleset-list` | `realm_list_rulesets` |

**Record types come from the ruleset**, not from Realm. A D&D 5e campaign has
`spells` and `feats`; a Cyberpunk campaign has entirely different ones. Only
`characters`, `npcs` and `tables` are universal. If you're unsure what a campaign
supports, download its ruleset (`realm_get_ruleset`) and read the `recordTypes` in
the summary.

### Two separate 3D catalogs

`assets-3d` holds **scenery** — floors, walls, doors, windows, props, lights, roofs.
Those become `scene-objects-3d` rows placed on a scene.

`tokens-3d` holds **minis** — the 3D models that represent creatures. A mini is not
placed as a scene object; it is attached to a *record* at `token.model3D`, and the
creature's token then renders as that model on 3D scenes. A record can carry both a
flat 2D token image and a `model3D`, and each is used on the scene type that needs
it. `realm_set_3d_token` writes it, carrying the catalog's scale, pedestal and
facing defaults across.

## Things that will bite you

**Pagination is capped at 50.** `find` returns `{ total, limit, skip, data }` and
the service clamps every page to 50 rows regardless of `$limit`. The tools page
through with `$skip` where it matters, so `total` may exceed what one call returns.

**Query fields are whitelisted per service.** An unlisted field is a hard 400
("validation failed"), not an ignored filter. Types matter too: an array field like
`userIds` or `tags` rejects a bare scalar and needs `{ $in: [...] }`.

**Campaign scope is mandatory on some services.** `scene-objects-3d` rejects a read
without a campaign: *"Must query by ID, ownerId, campaignId, or moduleId"*. Select a
campaign with `realm_use_campaign`, or pass `campaign` to the tool.

**Journal pages can't be listed by plain REST.** The query validator and the auth
hook contradict each other for a GM token, so the outline comes from a custom
service method instead. `realm_journal_pages` handles it; the outline carries no
page content, so fetch a page by id to read its HTML.

**Journal page content is an HTML string.** Not markdown, not a document model.
`<h1>`, `<p>`, `<ul><li>`, `<table>` all work.

**Rulesets are big.** `realm_get_ruleset` writes to a file rather than returning
megabytes of tab HTML and roll-handler JavaScript inline. Reads are unminified, so
edit-and-upload round trips preserve the source.

## Errors

| Status | Means |
|---|---|
| 400 | Payload or query failed schema validation — usually an unlisted or wrongly-typed query field |
| 401 | The token is expired or invalid — run `realm_login` again |
| 403 | Authenticated but not permitted, or a required scope (campaign) is missing |
| 404 | Bad id, or the record belongs to a different campaign |

## Auth

Sign-in mints a JWT that lasts **30 days**, with no refresh token. It is stored at
`~/.realmvtt-mcp/auth.json` (mode 0600) and reused across sessions;
`realm_whoami` reports how long is left. `REALMVTT_JWT` overrides the stored
credential for headless use.
