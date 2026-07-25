<!-- Copied from realm15-client/docs/effects-quick-reference.md by scripts/sync-docs.mjs.
     Edit it there, not here. `npm run check:sync` fails when this copy is stale. -->

# Effects System - Quick Reference

## Expression Syntax Cheatsheet

| Syntax | Use Case | Example |
|--------|----------|---------|
| `@record.data.field` | Reference a field | `@record.data.level` |
| `@record.data.nested.path` | Reference nested field | `@record.data.abilities.strength.mod` |
| `@record.data.array.0` | Access array element | `@record.data.attacks.0.bonus` |
| `@effect.count` | Stack count | `@effect.count` (number of stacked instances) |
| `@effect.sourceCount` | Aura source's stack count (child effect applied by an aura) | `"ternary(eq(@effect.sourceCount,1),'d4','d6')"` |
| `10 + @record.data.field` | Math expression | `10 + @record.data.dexMod` |
| `{...}` | Inline math in string | `"Strike {5 + @record.data.level}"` |
| `{... @effect.count}` | Stack-based math | `"{5 * @effect.count}"` (scales with stacks) |
| `@caster.data.field` | Reference caster's data (overrides & durations) | `@caster.data.proficiencyBonus` |
| `@caster.data.field\|N` | Caster ref with fallback (duration rolls) | `@caster.data.proficiencyBonus\|2` (falls back to 2) |
| `@record.data.field\|N` | Record ref with fallback | `@record.data.level\|1` (falls back to 1) |
| `@roll(XdY)` | Instant dice roll | `@roll(2d10)` (rolled once on apply, cached per effect) |
| `@merge(path)` | Merge entire object | `@merge(@record.data.effects.form.strikes)` |
| `__merge` | Merge with base values | `{ "baseKey": "val", "__merge": "@merge(path)" }` |

## Logical Functions

| Function | Description | Example |
|----------|-------------|---------|
| `ternary(cond, ifTrue, ifFalse)` | Conditional | `"ternary(gte(@record.data.level, 5), 3, 2)"` |
| `lt(a, b)` | Less than | `"lt(@record.data.level, 5)"` |
| `lte(a, b)` | Less than or equal | `"lte(@record.data.level, 5)"` |
| `gt(a, b)` | Greater than | `"gt(@record.data.level, 10)"` |
| `gte(a, b)` | Greater than or equal | `"gte(@record.data.level, 10)"` |
| `eq(a, b)` | Equal | `"eq(@record.data.class, 'Rogue')"` |
| `ne(a, b)` | Not equal | `"ne(@record.data.hp, 0)"` |
| `and(a, b)` | Logical AND | `"and(gte(@record.data.level, 5), eq(@record.data.class, 'Wizard'))"` |
| `or(a, b)` | Logical OR | `"or(eq(@record.data.class, 'Rogue'), eq(@record.data.class, 'Bard'))"` |
| `not(a)` | Logical NOT | `"not(@record.data.isDead)"` |
| `nand(a, b)` | Logical NAND | `"nand(eq(@record.data.level, 1), eq(@record.data.class, 'Fighter'))"` |
| `xor(a, b)` | Logical XOR | `"xor(@record.data.hasAdvantage, @record.data.hasDisadvantage)"` |

---

## Rule Type Templates

### Data Rule (Numeric Modification)
```json
{
  "type": "data",
  "value": {
    "field": "ac",
    "operation": "add",
    "value": 2
  }
}
```

### Override Rule (Replace Data)
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "ac": 18,
    "speed": 30
  }
}
```

### ChoiceSet Rule (User Choice)
```json
{
  "type": "choiceSet",
  "field": "data.effects.myEffect.choice",
  "valueType": "string",
  "value": {
    "prompt": "Select Option",
    "choices": [
      { "label": "Option 1", "value": "value1" },
      { "label": "Option 2", "value": "value2" }
    ]
  }
}
```

### Input Rule (Free-form User Input)
```json
{
  "type": "input",
  "field": "data.effects.myEffect.amount",
  "valueType": "number",
  "value": {
    "prompt": "Enter amount",
    "placeholder": "1-10",
    "defaultValue": 1,
    "min": 1,
    "max": 10
  }
}
```

Use `valueType: "string"` for free-form text. Like `choiceSet`, the entered value is stored at `field` and can be referenced by sibling rules (e.g. `@record.data.effects.myEffect.amount`). Cancelling the prompt aborts the entire effect.

### Aura Rule (Area of Effect)
```json
{
  "type": "aura",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "10",
    "color": "#03c3e8",
    "faction": "enemy",
    "effectId": "effect_id_here"
  }
}
```

**Range supports expressions:**
- Static: `"range": "10"`
- Dynamic: `"range": "{5 * @record.data.effects.aura.multiplier}"`
- Level-based: `"range": "{10 + @record.data.level * 5}"`
- Stack-based: `"range": "{5 * @effect.count}"`

### Light Rule (Dynamic Lighting)
```json
{
  "type": "light",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "20",
    "color": "#ffaa00",
    "intensity": 2.5,
    "angle": 0,
    "flicker": 0.3,
    "falloff": 0.5
  }
}
```

**Range supports expressions:**
- Static: `"range": "20"`
- Dynamic: `"range": "{10 * @record.data.effects.light.multiplier}"`
- Level-based: `"range": "{10 + @record.data.level * 2}"`
- Stack-based: `"range": "{5 * @effect.count}"`

---

## Dynamic Duration Rolls

Use `durationRoll` on an effect for dynamic durations rolled at application time. Supports `@record.data`, `@caster.data`, pipe fallbacks, and inline math.

```json
{
  "durationRoll": "1d4+@caster.data.proficiencyBonus|2",
  "durationUnit": "rounds"
}
```

| Example | Description |
|---------|-------------|
| `"1d4+@caster.data.proficiencyBonus"` | Caster's prof bonus, fallback 1 |
| `"1d4+@caster.data.proficiencyBonus\|2"` | Caster's prof bonus, fallback 2 |
| `"@record.data.level"` | Target's level as flat duration |
| `"{@record.data.level + 2}d6"` | Inline math → e.g. `7d6` at level 5 |

### Override the duration unit at application time

The `addEffect`/`addEffects`/`addEffectById`/`addEffectsByIds` macro API accepts the duration argument as a plain number (uses the template's `durationUnit`) **or** an object `{ value, unit }` that overrides the unit for that application:

```js
// Apply for 3 combat rounds regardless of the effect template's unit
api.addEffect("Ongoing Damage", target, { value: 3, unit: "rounds" }, "1d10 fire");
```

---

## Expires at Roll

Set `expiresAtRoll: true` to consume one stack of the effect after the bearer's next roll. The effect still applies to the triggering roll. Optionally restrict to specific roll types via a comma-separated `expiresAtRollTypes` (blank = any).

```json
{
  "expiresAtRoll": true,
  "expiresAtRollTypes": "attack,skill"
}
```

| Field | Notes |
|-------|-------|
| `expiresAtRoll` | `true` to enable consume-on-roll. |
| `expiresAtRollTypes` | Comma-separated `rollType` filter (case-insensitive). Blank/omitted matches any roll. |

- Stackable effects lose one stack per qualifying roll; the effect is removed when stacks hit 0.
- Independent of `duration`/`durationUnit` — combine for "expires on next attack OR end of round, whichever first".
- Subrolls via `performRollInstant` (duration rolls, damage components) don't trigger consumption.

---

## Common Patterns

### Pattern: Choice + Override
```json
{
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.myEffect.data",
      "valueType": "object",
      "value": {
        "prompt": "Select Type",
        "choices": [
          {
            "label": "Type A",
            "value": "{ \"ac\": \"18 + @record.data.level\", \"speed\": 30 }"
          }
        ]
      }
    },
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "ac": "@record.data.effects.myEffect.data.ac",
        "speed": "@record.data.effects.myEffect.data.speed"
      }
    }
  ]
}
```

### Pattern: Base + Merge
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "strikes": {
      "claw": { "damage": "1d6", "traits": ["agile"] },
      "tail": { "damage": "2d6" },
      "__merge": "@merge(@record.data.effects.form.strikes)"
    }
  }
}
```

### Pattern: Multiple Inline Math
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "description": "Attack {5 + @record.data.level} vs AC {@record.data.enemyAC - 2}"
  }
}
```

### Pattern: Array Access
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "firstAttack": "@record.data.attacks.0.name",
    "firstBonus": "@record.data.attacks.0.modifier"
  }
}
```

### Pattern: Dynamic Aura with Choice
```json
{
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.aura.range",
      "valueType": "number",
      "value": {
        "prompt": "Select Aura Range",
        "choices": [
          { "label": "5 feet", "value": "1" },
          { "label": "10 feet", "value": "2" }
        ]
      }
    },
    {
      "type": "aura",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{5 * @record.data.effects.aura.range}",
        "color": "#03c3e8",
        "faction": "enemy",
        "effectId": "effect_id"
      }
    }
  ]
}
```

### Pattern: Level-Based Scaling with Ternary
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "proficiencyBonus": "ternary(lt(@record.data.level, 5), 2, ternary(lt(@record.data.level, 9), 3, ternary(lt(@record.data.level, 13), 4, ternary(lt(@record.data.level, 17), 5, 6))))",
    "sneakAttackDice": "ternary(lt(@record.data.level, 3), 1, ternary(lt(@record.data.level, 5), 2, ternary(lt(@record.data.level, 7), 3, 4)))"
  }
}
```

### Pattern: Conditional Logic with AND/OR
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "canSneak": "and(eq(@record.data.class, 'Rogue'), gte(@record.data.level, 2))",
    "hasBonusAction": "or(eq(@record.data.class, 'Rogue'), eq(@record.data.class, 'Monk'))",
    "damageBonus": "ternary(and(gte(@record.data.level, 5), gt(@record.data.dex, 14)), 2, 0)"
  }
}
```

---

## Operations Reference

| Operation | Numbers | Strings | Notes |
|-----------|---------|---------|-------|
| `add` | ✅ | ✅ | Concatenates strings |
| `subtract` | ✅ | ❌ | Numbers only |
| `multiply` | ✅ | ❌ | Numbers only |
| `divideRoundDown` | ✅ | ❌ | Floor division |
| `divideRoundUp` | ✅ | ❌ | Ceiling division |

---

## Math Operators

| Operator | Example | Result |
|----------|---------|--------|
| `+` | `5 + @record.data.level` | Addition |
| `-` | `20 - @record.data.penalty` | Subtraction |
| `*` | `@record.data.level * 2` | Multiplication |
| `/` | `@record.data.value / 2` | Division |
| `()` | `(10 + @record.data.str) / 2` | Grouping |

---

## Value Types

| Type | Used For | Example Value |
|------|----------|---------------|
| `string` | Text values | `"fire"` or `"Darkvision"` |
| `number` | Numeric values | `7` or `3.5` |
| `object` | Complex JSON | `{ "ac": 18, "speed": 30 }` |

---

## Common Mistakes

| ❌ Wrong | ✅ Correct | Issue |
|---------|----------|-------|
| `"strikes": null` in character | Initialize as `{}` | MongoDB can't create fields in null |
| `@merge(effects.path)` | `@merge(@record.data.effects.path)` | Missing prefix (works but inconsistent) |
| `"damage": "4 + @record.data.level d6"` | `"damage": "{4 + @record.data.level}d6"` | Need `{}` for inline math |
| `"field": "data.choice"` | `"field": "data.effects.myEffect.choice"` | Use namespaced paths |

---

## Field Naming Convention

```
data.effects.{effectName}.{propertyName}
```

Examples:
- `data.effects.dragonForm.type`
- `data.effects.rage.element`
- `data.effects.polymorphSpell.stats`

---

## Testing Checklist

- [ ] Test with null/undefined fields
- [ ] Test with level 1 and level 20 characters
- [ ] Test all choice options
- [ ] Test stacking (if stackable: true)
- [ ] Test removal (values restore correctly)
- [ ] Test with empty/missing data structures
- [ ] Test expressions evaluate correctly
- [ ] Test merge behavior

---

For full documentation, see [effects-system.md](effects-system.md)
