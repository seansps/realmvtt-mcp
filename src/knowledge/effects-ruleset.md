# Ruleset-defined effect rules

The `effects` guide documents the rule types Realm ships with. It is **not the whole
list for any given campaign** — a ruleset declares its own effect rule types on top
of the built-ins, and those are usually the ones a system's content actually uses.

Call **`realm_effect_types`** to see what a campaign really supports before writing
an effect. Guessing produces an effect that saves cleanly and does nothing.

## An effect's rules

An effect carries a `rules` array. Every rule has the same shape regardless of where
its type came from:

```jsonc
{
  "type":  "data",        // which rule type
  "field": "abilities.str.mod",
  "valueType": "number",  // "number" | "string" | …
  "value": "2"
}
```

## The built-in types

Always present, in every ruleset:

| type | what it does |
|---|---|
| `data` | alter a data field |
| `override` | override a data field outright |
| `choiceSet` | offer the player a choice when the effect is applied |
| `input` | prompt for a value when applied |
| `aura` | emit an aura affecting nearby tokens |
| `light` | set a light on the token |
| `senses` | set senses (darkvision and similar) |
| `token` | change the token |
| `addEffect` | apply another effect |

Their semantics — expressions, `@record.data.path` references, inline `{math}`,
merging, durations, expiry — are all in the `effects` guide.

## The ruleset's own types

A ruleset declares extra types in its `effects` array:

```jsonc
"effects": [
  {
    "label": "Circumstance Penalty",   // what the GM sees in the dropdown
    "type":  "cir_pen",                // what a rule stores, and what the ruleset's scripts check
    "fields": [                        // the fields this type can target
      { "label": "Attack Rolls", "field": "attack" },
      { "label": "Saving Throws", "field": "save" }
    ],
    "freeTextField": false
  }
]
```

Using one is no different from using a built-in:

```jsonc
{ "type": "cir_pen", "field": "attack", "valueType": "number", "value": "-2" }
```

What makes these types *do* anything is the ruleset's own JavaScript: its roll
handlers and scripts look for rules of that `type` and apply them. That is why the
type string must match the ruleset's exactly — `cir_pen` is checked literally.

### Fields

- If the type declares `fields`, prefer one of those `field` values. They are what
  the ruleset's scripts expect.
- A **custom field** string is always permitted; the app offers a "Custom…" option
  on every type. Only do this when you know the ruleset handles it.
- If `freeTextField` is `true`, the type has no fixed field list and expects a
  free-text field value.

## Discovering what a campaign supports

`realm_effect_types` reads the campaign's ruleset and returns the merged list —
built-ins plus whatever the ruleset adds, each with its available fields. Do that
first when authoring effects for an unfamiliar system; the ruleset-defined types are
frequently the whole point (bonus stacking categories, condition tracks, resource
pools) and they differ completely between systems.

If the campaign has no ruleset attached, or the ruleset declares no `effects`, you
get the nine built-ins and nothing else.
