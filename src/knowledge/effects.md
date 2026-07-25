<!-- Copied from realm15-client/docs/effects-system.md by scripts/sync-docs.mjs.
     Edit it there, not here. `npm run check:sync` fails when this copy is stale. -->

# Effects System Documentation

## Table of Contents
- [Overview](#overview)
- [Rule Types](#rule-types)
  - [Data Rules](#data-rules)
  - [Override Rules](#override-rules)
  - [ChoiceSet Rules](#choiceset-rules)
  - [Input Rules](#input-rules)
  - [Aura Rules](#aura-rules)
  - [Light Rules](#light-rules)
- [Expression Syntax](#expression-syntax)
  - [Basic References](#basic-references)
  - [Array Indexing](#array-indexing)
  - [Math Expressions](#math-expressions)
  - [Inline Math with Curly Braces](#inline-math-with-curly-braces)
  - [Instant Dice Rolls](#instant-dice-rolls)
- [Merge Functionality](#merge-functionality)
  - [Simple Merge](#simple-merge)
  - [Merge with Base Values](#merge-with-base-values)
- [Dynamic Duration Rolls](#dynamic-duration-rolls)
- [Expires at Roll](#expires-at-roll)
- [Complete Examples](#complete-examples)
- [Best Practices](#best-practices)

---

## Overview

The Effects system allows you to create dynamic character modifications that can:
- Modify numeric or string data fields
- Override complex nested data structures
- Present user choices that affect how the effect works
- Evaluate mathematical expressions
- Merge data from multiple sources

Effects are applied to characters or tokens and can stack, have durations, and be removed to restore original values.

---

## Rule Types

### Data Rules

Data rules modify individual character fields using mathematical operations. They maintain a history stack to properly reverse changes when the effect is removed.

#### Structure
```json
{
  "type": "data",
  "value": {
    "field": "fieldName",
    "operation": "add|subtract|multiply|divideRoundDown|divideRoundUp",
    "value": 5,
    "min": 0,
    "max": 100
  }
}
```

#### Operations
- **`add`**: Adds value to current field (works for numbers and strings)
- **`subtract`**: Subtracts value from current field (numbers only)
- **`multiply`**: Multiplies current field by value (numbers only)
- **`divideRoundDown`**: Divides and rounds down (numbers only)
- **`divideRoundUp`**: Divides and rounds up (numbers only)

#### Optional Parameters
- **`min`**: Minimum allowed value after operation (numbers only)
- **`max`**: Maximum allowed value after operation (numbers only)
- **`valueFromField`**: Get the value from another field instead of using `value`

#### Example: Add bonus to AC
```json
{
  "type": "data",
  "value": {
    "field": "ac",
    "operation": "add",
    "value": 2,
    "min": 0,
    "max": 30
  }
}
```

#### Example: Add proficiency based on level
```json
{
  "type": "data",
  "value": {
    "field": "attackBonus",
    "operation": "add",
    "valueFromField": "level"
  }
}
```

---

### Override Rules

Override rules replace or merge complex nested data structures. They support deep merging, expression evaluation, `@caster.data` references, and can reference choice values.

#### Structure
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "fieldName": "value or expression",
    "nested": {
      "property": "value"
    }
  }
}
```

#### Features
- **Deep Merging**: When the current value is an object, nested properties are merged
- **Expression Evaluation**: Supports `@record.data.path`, `@caster.data.path`, and math expressions
- **Array Handling**: Arrays from override are appended to existing arrays
- **Snapshot Storage**: Original values are stored for proper restoration

#### Example: Simple Override
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "ac": 18,
    "speed": 30,
    "senses": "Darkvision"
  }
}
```

#### Example: Override with Expressions
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "ac": "15 + @record.data.dexMod",
    "hitPoints": "@record.data.level * 10",
    "senses": "@record.data.ancestryTraits.senses"
  }
}
```

#### Example: Override with Caster References
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "spellDC": "8 + @caster.data.proficiencyBonus + @caster.data.spellcastingMod",
    "spellAttack": "@caster.data.proficiencyBonus + @caster.data.spellcastingMod",
    "casterName": "@caster.data.name"
  }
}
```
When an effect is applied by another actor (the caster), `@caster.data.field` resolves from the caster's data. If no caster context is available, values resolve to `0`.

---

### ChoiceSet Rules

ChoiceSet rules present a modal to the user, allowing them to choose from predefined options. The chosen value is stored and can be referenced by other rules in the same effect.

#### Structure
```json
{
  "type": "choiceSet",
  "field": "data.effects.effectName.choiceName",
  "valueType": "string|number|object",
  "value": {
    "prompt": "Prompt text for user",
    "choices": [
      {
        "label": "Display label",
        "value": "stored value"
      }
    ]
  }
}
```

#### Value Types
- **`string`**: Store the value as a string
- **`number`**: Convert and store as a number
- **`object`**: Parse JSON and store as an object

#### Example: Simple Choice
```json
{
  "type": "choiceSet",
  "field": "data.effects.rage.damageType",
  "valueType": "string",
  "value": {
    "prompt": "Select Damage Type",
    "choices": [
      { "label": "Fire", "value": "fire" },
      { "label": "Cold", "value": "cold" },
      { "label": "Lightning", "value": "lightning" }
    ]
  }
}
```

#### Example: Complex Object Choice
```json
{
  "type": "choiceSet",
  "field": "data.effects.dragonForm.stats",
  "valueType": "object",
  "value": {
    "prompt": "Select Dragon Type",
    "choices": [
      {
        "label": "Fire Dragon",
        "value": "{\n  \"ac\": \"18 + @record.data.level\",\n  \"damageType\": \"fire\",\n  \"breathWeapon\": {\n    \"damage\": \"6d6\",\n    \"save\": \"reflex\"\n  }\n}"
      },
      {
        "label": "Ice Dragon",
        "value": "{\n  \"ac\": \"20 + @record.data.level\",\n  \"damageType\": \"cold\",\n  \"breathWeapon\": {\n    \"damage\": \"8d6\",\n    \"save\": \"fortitude\"\n  }\n}"
      }
    ]
  }
}
```

**Important Notes:**
- Expressions in choice values (like `"ac": "18 + @record.data.level"`) are automatically evaluated before being used by override rules
- Multiple choiceSet rules in one effect will prompt sequentially
- If user cancels any choice, the entire effect is not applied

---

### Input Rules

Input rules present a modal that prompts the user to type a free-form value (string or number). The entered value is stored at the configured field path and can be referenced by other rules in the same effect — exactly like `choiceSet`, but without a fixed list of options.

Use this when the value space is open-ended (e.g. an arbitrary number of stacks, a custom name/label, a target ability score), where authoring an exhaustive `choices` array would be impractical.

#### Structure
```json
{
  "type": "input",
  "field": "data.effects.effectName.fieldName",
  "valueType": "string|number",
  "value": {
    "prompt": "Prompt text for user",
    "placeholder": "Hint shown in the field",
    "defaultValue": "Optional initial value",
    "min": 0,
    "max": 999
  }
}
```

#### Value Types
- **`string`**: Stores whatever the user typed as a string
- **`number`**: Stores a number (rendered as a numeric input). `min` / `max` are honored only in this mode.

#### Example: Free-form Number Input
```json
{
  "type": "input",
  "field": "data.effects.bonusBoost.amount",
  "valueType": "number",
  "value": {
    "prompt": "How much bonus to grant?",
    "defaultValue": 1,
    "min": 1,
    "max": 10
  }
}
```

Then, in a sibling rule:
```json
{
  "type": "data",
  "value": {
    "field": "ac",
    "operation": "add",
    "valueFromField": "@record.data.effects.bonusBoost.amount"
  }
}
```

#### Example: Free-form String Input
```json
{
  "type": "input",
  "field": "data.effects.markedTarget.name",
  "valueType": "string",
  "value": {
    "prompt": "Name your quarry",
    "placeholder": "e.g. The red dragon"
  }
}
```

Then in an override:
```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "quarryDescription": "Hunting @record.data.effects.markedTarget.name to the ends of the earth."
  }
}
```

**Important Notes:**
- Input rules are processed in the same prompt phase as `choiceSet` rules and prompt sequentially in declaration order
- If the user cancels the prompt, the entire effect is not applied
- On effect removal, the stored field is cleared (set to `null`), matching `choiceSet` behavior
- For numeric inputs, validation is enforced via the configured `min`/`max`; for strings any text is accepted

---

### Aura Rules

Aura rules create an area of effect around a token that automatically applies another effect to tokens within range. Auras support expression evaluation for dynamic ranges based on character data.

#### Structure
```json
{
  "type": "aura",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "5",
    "color": "#03c3e8",
    "faction": "enemy|friend|all",
    "effectId": "effect_id_to_apply"
  }
}
```

#### Properties
- **`range`**: Distance in map units (supports expressions)
- **`color`**: Hex color for aura visualization (displayed on token hover)
- **`faction`**: Which tokens are affected
  - `"enemy"` - Affects tokens of different faction than the aura source
  - `"friend"` - Affects tokens of same faction as the aura source
  - `"all"` - Affects all tokens regardless of faction
- **`effectId`**: The ID of the effect to apply to tokens within range

#### Expression Support
The `range` property supports all expression syntax, including:
- **Simple values**: `"5"` (static 5 units)
- **References**: `"@record.data.auraRange"` (from character data)
- **Math expressions**: `"5 * @record.data.level"` (calculated range)
- **Inline math**: `"{5 * @record.data.effects.aura.multiplier}"` (with curly braces)
- **Stack count**: `"@effect.count"` (number of times this effect is stacked on the token)
- **Stack-based math**: `"{5 * @effect.count}"` or `"{10 + @effect.count * 2}"` (range scales with stacks)

#### Example: Static Aura
```json
{
  "type": "aura",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "10",
    "color": "#ff0000",
    "faction": "enemy",
    "effectId": "6123abc456def789"
  }
}
```

#### Example: Dynamic Aura with Expressions
```json
{
  "name": "Variable Range Aura",
  "stackable": false,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.testaura",
      "valueType": "number",
      "value": {
        "prompt": "Select Range",
        "choices": [
          { "label": "5 feet", "value": "1" },
          { "label": "10 feet", "value": "2" },
          { "label": "15 feet", "value": "3" }
        ]
      }
    },
    {
      "type": "aura",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{5 * @record.data.effects.testaura}",
        "color": "#03c3e8",
        "faction": "enemy",
        "effectId": "abc123def456"
      }
    }
  ]
}
```

**How this works:**
1. User selects a range option (1, 2, or 3)
2. The aura range expression evaluates (e.g., `5 * 2 = 10` feet)
3. Any enemy tokens within 10 feet automatically receive the specified effect
4. The aura is visualized as a colored circle when hovering over the token
5. When the token moves or the choice changes, affected tokens are automatically updated

#### Example: Level-Based Aura
```json
{
  "type": "aura",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "{10 + @record.data.level * 5}",
    "color": "#00ff00",
    "faction": "friend",
    "effectId": "healing_aura_effect_id"
  }
}
```

**Result:**
- Level 1: 15 feet range
- Level 5: 35 feet range
- Level 10: 60 feet range

#### Example: Stackable Aura
```json
{
  "name": "Stacking Power Aura",
  "stackable": true,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "aura",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{5 * @effect.count}",
        "color": "#ff00ff",
        "faction": "friend",
        "effectId": "power_boost_effect_id"
      }
    }
  ]
}
```

**How this works:**
- Apply the effect once: 5 feet range (1 stack × 5 = 5)
- Apply again (2 stacks): 10 feet range (2 stacks × 5 = 10)
- Apply again (3 stacks): 15 feet range (3 stacks × 5 = 15)
- Each additional stack increases the aura range by 5 feet

**Important Notes:**
- Auras are only processed by the GM (players cannot trigger aura effects)
- Affected tokens receive the effect with `effectValue: "aura"` to track that it came from an aura
- When tokens move out of aura range, the aura effect is automatically removed
- Aura effects are throttled to prevent performance issues (updates every 1 second max)
- The `effectId` must be a valid effect ID from your campaign

#### Referencing the Aura Source's Stack Count

When an aura applies its linked effect to a token in range, the linked effect's rules can reference the **aura source's** stack count of the *parent* aura effect via `@effect.sourceCount`. This is useful when the aura's behavior should scale with how many stacks of the parent effect the source has — without the source needing to write that count into its own data.

**How it works:**
- The parent aura effect on the source is stackable. Its stack count on the source is captured when the aura applies the linked effect to a recipient.
- Inside the linked effect's rules, `@effect.sourceCount` resolves to that captured count.
- When the source's stack count changes, the linked effect is automatically re-applied on affected recipients so `@effect.sourceCount` stays in sync (debounced so rapid changes collapse into a single reapply).
- If the effect was not applied via an aura, `@effect.sourceCount` is `undefined` / `0`.

**Example: Tactics Die scaling with source stacks**

Parent effect on the source (stackable, applied N times to pick the die size):

```json
{
  "name": "Tactical Edge",
  "stackable": true,
  "rules": [
    {
      "type": "aura",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "60",
        "color": "#ffd166",
        "faction": "friend",
        "effectId": "tactical_edge_recipient_id"
      }
    }
  ]
}
```

Linked "recipient" effect applied by the aura to friendlies in range:

```json
{
  "name": "Tactical Edge (Recipient)",
  "stackable": false,
  "rules": [
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "tacticsDie": "ternary(eq(@effect.sourceCount,1),'d4',ternary(eq(@effect.sourceCount,2),'d6',ternary(eq(@effect.sourceCount,3),'d8','d12')))"
      }
    }
  ]
}
```

**Result:**
- Source has 1 stack of Tactical Edge → recipients get `tacticsDie = "d4"`
- Source has 2 stacks → recipients get `"d6"`
- Source has 3 stacks → recipients get `"d8"`
- Source has 4+ stacks → recipients get `"d12"`

**Why this pattern:** Keeping the ternary on the *recipient* side means the source's own data isn't mutated by a stack-count-dependent override, which avoids issues when stacks are added and removed rapidly. The recipient's value is re-derived each time the aura reapplies.

---

### Light Rules

Light rules add a dynamic light source to a token that automatically casts light in the VTT environment. Lights support expression evaluation for dynamic ranges, intensities, and other properties.

#### Structure
```json
{
  "type": "light",
  "field": "",
  "valueType": "object",
  "value": {
    "range": "10",
    "color": "#ffaa00",
    "intensity": 3,
    "angle": 0,
    "rotation": 0,
    "flicker": 0,
    "falloff": 0.5
  }
}
```

#### Properties
- **`range`**: Light radius in map units (supports expressions)
- **`color`**: Hex color of the light (e.g., `"#ffaa00"` for warm torch light)
- **`intensity`**: Brightness of the light (0-3, default: 3)
- **`angle`**: Cone angle in radians (0 = 360° omnidirectional, Math.PI/2 = 90° cone)
- **`rotation`**: Direction the cone points (if angle is set)
- **`flicker`**: Flicker amount (0 = no flicker, 1 = maximum flicker)
- **`falloff`**: Light falloff (0 = full bright to edge, 0.5 = D&D style bright/dim, 1 = fast falloff)

#### Expression Support
The `range` property supports all expression syntax, including:
- **Simple values**: `"10"` (static 10 units)
- **References**: `"@record.data.lightRadius"` (from character data)
- **Math expressions**: `"5 + @record.data.level"` (calculated range)
- **Inline math**: `"{10 * @record.data.effects.torch.multiplier}"` (with curly braces)
- **Stack count**: `"@effect.count"` (number of times this effect is stacked)
- **Stack-based math**: `"{5 * @effect.count}"` (range scales with stacks)

#### Example: Static Torch Light
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

#### Example: Level-Based Light
```json
{
  "name": "Divine Radiance",
  "stackable": false,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "light",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{10 + @record.data.level * 2}",
        "color": "#ffffff",
        "intensity": 3,
        "angle": 0,
        "flicker": 0,
        "falloff": 0.3
      }
    }
  ]
}
```

**Result:**
- Level 1: 12 feet range
- Level 5: 20 feet range
- Level 10: 30 feet range

#### Example: Stackable Light Source
```json
{
  "name": "Stacking Illumination",
  "stackable": true,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "light",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{5 * @effect.count}",
        "color": "#ffdd88",
        "intensity": 2,
        "angle": 0,
        "flicker": 0,
        "falloff": 0.5
      }
    }
  ]
}
```

**How this works:**
- Apply the effect once: 5 feet range (1 stack × 5 = 5)
- Apply again (2 stacks): 10 feet range (2 stacks × 5 = 10)
- Apply again (3 stacks): 15 feet range (3 stacks × 5 = 15)
- Each additional stack increases the light range by 5 feet

#### Example: Choice-Based Light
```json
{
  "name": "Variable Light Spell",
  "stackable": false,
  "durationUnit": "minutes",
  "duration": 10,
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.lightspell.range",
      "valueType": "number",
      "value": {
        "prompt": "Select Light Range",
        "choices": [
          { "label": "Dim (10 feet)", "value": "1" },
          { "label": "Normal (20 feet)", "value": "2" },
          { "label": "Bright (30 feet)", "value": "3" }
        ]
      }
    },
    {
      "type": "light",
      "field": "",
      "valueType": "object",
      "value": {
        "range": "{10 * @record.data.effects.lightspell.range}",
        "color": "#aaddff",
        "intensity": 3,
        "angle": 0,
        "flicker": 0,
        "falloff": 0.5
      }
    }
  ]
}
```

**Important Notes:**
- Lights are rendered in real-time by the VTT dynamic lighting system
- Range is measured in map units (typically 5 feet per unit)
- Multiple light effects on the same token will all render
- Lights automatically move with the token
- Light colors can be any hex color value

---

## Expression Syntax

### Basic References

Reference character data using `@record.data.fieldPath`:

```json
"ac": "@record.data.baseAC"
"name": "@record.data.characterName"
"modifier": "@record.data.abilities.strength.modifier"
```

### Array Indexing

Access array elements using numeric indices:

```json
"firstAttack": "@record.data.attacks.0.name"
"secondBonus": "@record.data.bonuses.1.value"
"chosenStrike": "@record.data.effects.polymorph.strikes.2.damage"
```

**Note:** Array indices use dot notation, e.g., `attacks.0` for the first element.

### Math Expressions

When an entire value is a math expression, it's automatically evaluated:

```json
{
  "ac": "10 + @record.data.dexMod + @record.data.level",
  "hp": "@record.data.level * 8 + @record.data.conMod",
  "bonus": "(@record.data.strength - 10) / 2"
}
```

**Supported Operators:**
- `+` Addition
- `-` Subtraction
- `*` Multiplication
- `/` Division
- `()` Parentheses for grouping

### Inline Math with Curly Braces

For math expressions within strings, use curly braces `{}`:

```json
{
  "description": "Attack bonus: {5 + @record.data.level}",
  "label": "Strike {@record.data.modifier - 2}",
  "text": "Deal {(@record.data.level + 1) * 2}d6 damage"
}
```

**How it works:**
1. Everything inside `{...}` is evaluated as a math expression
2. The result replaces the entire `{...}` block
3. Multiple `{...}` blocks in one string are all evaluated

**Examples:**
```json
// Input
"Strike {@record.data.effects.form.attackBonus - 2}"

// If attackBonus is 7, resolves to:
"Strike 5"

// Multiple expressions
"Attack {5 + @record.data.level} vs AC {@record.data.enemyAC - 2}"

// If level is 4 and enemyAC is 18, resolves to:
"Attack 9 vs AC 16"
```

### Instant Dice Rolls

Use `@roll(XdY)` to roll dice instantly when the effect is applied. The dice are rolled once and the numeric result is substituted into the expression.

```json
{
  "hitpoints": "@record.data.hitpoints + @roll(2d10)",
  "curhp": "@record.data.curhp + @roll(2d10)"
}
```

**How it works:**
1. When the effect is applied, each unique `@roll()` expression is rolled once
2. The same `@roll()` expression used multiple times within the same effect shares the same result — so `@roll(2d10)` in both `hitpoints` and `curhp` above will produce the same number
3. The rolled total replaces the `@roll(...)` token, then the rest of the expression is evaluated as normal math
4. Supports any dice notation that `performRollInstant` accepts: `2d10`, `4d6+3`, `1d20`, etc.

**Examples:**
```json
// Add a random HP boost
"curhp": "@record.data.curhp + @roll(2d6)"

// Combine with other math
"tempHp": "@roll(2d10) + @record.data.level"

// Use inside inline math for strings
"description": "Gained {@roll(2d10)} temporary hit points"
```

**Important:** Dice are rolled at effect application time and the result is baked in. When the effect is removed, the original values are restored from the snapshot — the roll is not "re-rolled".

### Logical Operations and Conditionals

Use function-style syntax for conditional logic and comparisons:

#### Ternary (Conditional)

**Syntax:** `ternary(condition, valueIfTrue, valueIfFalse)`

```json
{
  "proficiencyBonus": "ternary(gte(@record.data.level, 5), 3, 2)"
}
```

**Nested ternaries for multi-tier logic:**
```json
{
  "proficiencyBonus": "ternary(lt(@record.data.level, 5), 1, ternary(lt(@record.data.level, 11), 2, ternary(lt(@record.data.level, 17), 3, 4)))"
}
```

**Result:**
- Level 1-4: 1
- Level 5-10: 2
- Level 11-16: 3
- Level 17+: 4

#### Comparison Operators

| Function | Description | Example | Result |
|----------|-------------|---------|--------|
| `lt(a, b)` | Less than | `lt(5, 10)` | `true` |
| `lte(a, b)` | Less than or equal | `lte(5, 5)` | `true` |
| `gt(a, b)` | Greater than | `gt(10, 5)` | `true` |
| `gte(a, b)` | Greater than or equal | `gte(5, 5)` | `true` |
| `eq(a, b)` | Equal | `eq(5, 5)` | `true` |
| `ne(a, b)` | Not equal | `ne(5, 10)` | `true` |

**Examples:**
```json
{
  "canCast": "gte(@record.data.level, 3)",
  "isLowLevel": "lt(@record.data.level, 5)",
  "hasAdvantage": "gt(@record.data.dexMod, @record.data.enemyAC)"
}
```

#### Logical Operators

| Function | Description | Example | Result |
|----------|-------------|---------|--------|
| `and(a, b)` | Logical AND | `and(true, true)` | `true` |
| `or(a, b)` | Logical OR | `or(true, false)` | `true` |
| `not(a)` | Logical NOT | `not(false)` | `true` |
| `nand(a, b)` | Logical NAND | `nand(true, true)` | `false` |
| `xor(a, b)` | Logical XOR | `xor(true, false)` | `true` |

**Examples:**
```json
{
  "canUseAbility": "and(gte(@record.data.level, 5), gt(@record.data.spellSlots, 0))",
  "hasBonusAction": "or(eq(@record.data.class, 'Rogue'), eq(@record.data.class, 'Monk'))",
  "isNotProficient": "not(@record.data.proficient)"
}
```

#### Complex Example: Level-Based Damage Scaling

```json
{
  "name": "Sneak Attack",
  "rules": [
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "sneakAttackDice": "ternary(lt(@record.data.level, 3), 1, ternary(lt(@record.data.level, 5), 2, ternary(lt(@record.data.level, 7), 3, ternary(lt(@record.data.level, 9), 4, ternary(lt(@record.data.level, 11), 5, 6)))))",
        "sneakAttackDamage": "{@record.data.sneakAttackDice}d6"
      }
    }
  ]
}
```

**Result:**
- Level 1-2: 1d6
- Level 3-4: 2d6
- Level 5-6: 3d6
- Level 7-8: 4d6
- Level 9-10: 5d6
- Level 11+: 6d6

#### Using Conditionals with Choices

```json
{
  "name": "Conditional Power",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.power.useHighPower",
      "valueType": "number",
      "value": {
        "prompt": "Use high power mode?",
        "choices": [
          { "label": "Yes", "value": "1" },
          { "label": "No", "value": "0" }
        ]
      }
    },
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "damage": "ternary(eq(@record.data.effects.power.useHighPower, 1), {3 * @record.data.level}, {@record.data.level})",
        "range": "ternary(eq(@record.data.effects.power.useHighPower, 1), 30, 60)"
      }
    }
  ]
}
```

**How this works:**
- User selects "Yes" (value: 1): damage = 3× level, range = 30 feet
- User selects "No" (value: 0): damage = 1× level, range = 60 feet

---

## Merge Functionality

### Simple Merge

Use `@merge(@record.data.path)` to merge an entire object from another source:

```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "strikes": "@merge(@record.data.effects.dragonForm.strikes)"
  }
}
```

**Behavior:**
- If current `strikes` exists: Deep merges the new strikes into existing ones
- If current `strikes` is null/undefined: Sets to the merged value
- Properties in the merge source override properties in the current value
- Nested objects are merged recursively

### Merge with Base Values

Use the special `__merge` key to define base values AND merge in additional values:

```json
{
  "type": "override",
  "field": "",
  "valueType": "object",
  "value": {
    "strikes": {
      "claw": {
        "damage": "1d6",
        "damageType": "slashing",
        "traits": ["agile"]
      },
      "tail": {
        "damage": "2d6",
        "damageType": "bludgeoning"
      },
      "__merge": "@merge(@record.data.effects.dragonForm.strikes)"
    }
  }
}
```

**Behavior:**
1. Starts with base strikes (`claw` and `tail` defined in override)
2. Merges in strikes from `effects.dragonForm.strikes`
3. If both define the same strike, properties are deep merged
4. Result contains all strikes from both sources

**Example Result:**
```json
// Override defines:
{
  "claw": { "damage": "1d6", "traits": ["agile"] },
  "tail": { "damage": "2d6" }
}

// ChoiceSet provides:
{
  "claw": { "damageType": "slashing", "attack": "+10" },
  "bite": { "damage": "2d8", "damageType": "piercing" }
}

// Final merged result:
{
  "claw": {
    "damage": "1d6",           // from override
    "traits": ["agile"],       // from override
    "damageType": "slashing",  // from choice (merged)
    "attack": "+10"            // from choice (merged)
  },
  "tail": {
    "damage": "2d6"            // from override
  },
  "bite": {
    "damage": "2d8",           // from choice (new)
    "damageType": "piercing"   // from choice (new)
  }
}
```

---

## Dynamic Duration Rolls

Effects can use a `durationRoll` field to roll their duration dynamically at application time. The roll string supports `@record.data` references (from the target token) and `@caster.data` references (from the actor applying the effect), as well as inline math with curly braces.

### Basic Duration Roll
```json
{
  "name": "Bless",
  "durationRoll": "1d4+2",
  "durationUnit": "rounds",
  "rules": [...]
}
```

### Caster-Based Duration Roll
Use `@caster.data.field` to reference the applier's data. If no caster context is available, it falls back to `1` by default:
```json
{
  "name": "Inspire Courage",
  "durationRoll": "1d4+@caster.data.proficiencyBonus",
  "durationUnit": "rounds",
  "rules": [...]
}
```

### Pipe Fallback Syntax
Use `|value` to specify a custom fallback when the referenced field is missing:
```json
{
  "durationRoll": "1d4+@caster.data.proficiencyBonus|2"
}
```
If the caster has `proficiencyBonus: 4`, resolves to `1d4+4`. If no caster or field is missing, resolves to `1d4+2`.

### Target-Based Duration Roll
Use `@record.data.field` to reference the target token's data:
```json
{
  "name": "Scaling Effect",
  "durationRoll": "@record.data.level",
  "durationUnit": "rounds",
  "rules": [...]
}
```

### Inline Math in Duration Rolls
Use curly braces `{expression}` to evaluate math after references are resolved:
```json
{
  "durationRoll": "{@record.data.level + 2}d6",
  "durationUnit": "rounds"
}
```
For a level 5 character, this resolves to `7d6`.

### Mixed References
Both `@record` and `@caster` can be used in the same roll string:
```json
{
  "durationRoll": "{@record.data.level + @caster.data.spellcastingMod}",
  "durationUnit": "minutes"
}
```

### Reference Summary

| Syntax | Source | Default Fallback |
|--------|--------|-----------------|
| `@record.data.field` | Target token | `1` |
| `@record.data.field\|N` | Target token | `N` |
| `@caster.data.field` | Applier/caster | `1` |
| `@caster.data.field\|N` | Applier/caster | `N` |
| `{expression}` | Inline math | — |

**Note:** The `durationRoll` field takes precedence over the static `duration` field, but a duration explicitly passed at application time (e.g., from UI) takes precedence over both.

### Overriding the Duration Unit at Application Time

The macro API `addEffect` family (`addEffect`, `addEffects`, `addEffectById`, `addEffectsByIds`) accepts the duration argument as either a plain number — interpreted in the effect template's own `durationUnit` — or an object `{ value, unit }` that overrides the unit for that one application:

```js
// Apply "Ongoing Damage" for 3 combat rounds, even though the
// effect template itself is not a rounds-unit effect.
api.addEffect("Ongoing Damage", target, { value: 3, unit: "rounds" }, "1d10 fire");
```

`unit` accepts the same values as a template `durationUnit` (`"rounds"`, `"seconds"`, `"minutes"`, `"hours"`, `"days"`, `"seconds-real"`, `"end_turn"`, `"start_turn"`, …). A `"rounds"` override stamps a combat-round anchor so the effect ticks down once per round; time-unit overrides are converted to seconds like the default path. The override is stored per-instance in the token's `effectDurationUnits` map and cleared automatically when the effect expires or is removed.

---

## Expires at Roll

Effects can be configured to be consumed automatically when the bearing token performs a roll. This is useful for one-shot bonuses ("+2 to your next attack", "advantage on your next ability check") that should expire after they're used.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `expiresAtRoll` | boolean | When `true`, one stack of this effect is removed after the bearing token performs a roll. |
| `expiresAtRollTypes` | string | Comma-separated `rollType` values that trigger consumption. Blank/omitted = any roll type triggers it. Matching is case-insensitive and trims whitespace. |

### How it works

1. The effect still applies to the triggering roll — consumption happens *after* the roll is sent, so a "+2 to your next attack" effect modifies that attack and is then removed.
2. For stackable effects, each qualifying roll removes a single stack. The effect is fully removed only when its stack count reaches zero (handled by the existing stacked-effect machinery).
3. The trigger is the `rollType` argument of `performRoll` (e.g. `"attack"`, `"skill"`, `"save"`, `"initiative"`, `"damage"`, `"chat"`, `"table"`). Each ruleset defines its own `rollType` vocabulary in `settings.rollTypes`.
4. `expiresAtRoll` is independent of `duration`/`durationUnit` — an effect can have both, in which case it expires on whichever condition is met first.
5. Subrolls evaluated via `performRollInstant` (e.g. duration rolls, damage components) do *not* trigger consumption.

### Example: One-shot attack bonus

```json
{
  "name": "Guidance",
  "stackable": false,
  "expiresAtRoll": true,
  "expiresAtRollTypes": "attack",
  "rules": [
    {
      "type": "circumstance bonus",
      "field": "Attack",
      "valueType": "number",
      "value": 2
    }
  ]
}
```

This applies a +2 attack bonus that is removed after the bearer's next attack roll. Skill checks, saves, or other rolls leave the effect intact.

### Example: Any-roll consumable with multiple types

```json
{
  "name": "Lucky Charm",
  "stackable": true,
  "expiresAtRoll": true,
  "expiresAtRollTypes": "attack, skill, save",
  "rules": [
    {
      "type": "circumstance bonus",
      "field": "AllRolls",
      "valueType": "number",
      "value": 1
    }
  ]
}
```

Stacked three times, this gives +3 to attack/skill/save rolls. Each qualifying roll consumes one stack. Damage rolls or chat rolls do not consume stacks.

### Example: Match any roll type

```json
{
  "name": "Bardic Inspiration",
  "stackable": false,
  "expiresAtRoll": true,
  "rules": [...]
}
```

With `expiresAtRollTypes` omitted (or blank), the effect expires on the bearer's next roll regardless of type.

### Combining with a duration

```json
{
  "name": "Sneak Setup",
  "stackable": false,
  "expiresAtRoll": true,
  "expiresAtRollTypes": "attack",
  "duration": 1,
  "durationUnit": "rounds",
  "rules": [...]
}
```

Expires on the bearer's next attack *or* at the end of the round, whichever comes first.

---

## Complete Examples

### Example 1: Dragon Polymorph Effect

```json
{
  "name": "Dragon Form",
  "stackable": false,
  "duration": 10,
  "durationUnit": "minutes",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.dragonForm.type",
      "valueType": "object",
      "value": {
        "prompt": "Select Dragon Type",
        "choices": [
          {
            "label": "Fire Dragon (Medium)",
            "value": "{\n  \"size\": \"Medium\",\n  \"ac\": \"18 + @record.data.level\",\n  \"senses\": \"Darkvision, Scent (imprecise) 60 feet\",\n  \"speed\": 40,\n  \"fly\": 100,\n  \"strikes\": {\n    \"jaws\": {\n      \"damage\": \"2d8\",\n      \"damageType\": \"piercing\"\n    },\n    \"breathWeapon\": {\n      \"damage\": \"{4 + @record.data.level}d6\",\n      \"damageType\": \"fire\",\n      \"save\": \"reflex\",\n      \"dc\": \"{10 + @record.data.level + @record.data.keyAbilityMod}\"\n    }\n  }\n}"
          },
          {
            "label": "Ice Dragon (Large)",
            "value": "{\n  \"size\": \"Large\",\n  \"ac\": \"20 + @record.data.level\",\n  \"senses\": \"Darkvision, Scent (imprecise) 60 feet\",\n  \"speed\": 40,\n  \"fly\": 120,\n  \"strikes\": {\n    \"jaws\": {\n      \"damage\": \"2d10\",\n      \"damageType\": \"piercing\"\n    },\n    \"breathWeapon\": {\n      \"damage\": \"{6 + @record.data.level}d6\",\n      \"damageType\": \"cold\",\n      \"save\": \"reflex\",\n      \"dc\": \"{10 + @record.data.level + @record.data.keyAbilityMod}\"\n    }\n  }\n}"
          }
        ]
      }
    },
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "size": "@record.data.effects.dragonForm.type.size",
        "ac": "@record.data.effects.dragonForm.type.ac",
        "senses": "@record.data.effects.dragonForm.type.senses",
        "speed": "@record.data.effects.dragonForm.type.speed",
        "fly": "@record.data.effects.dragonForm.type.fly",
        "strikes": {
          "claw": {
            "damage": "1d6",
            "damageType": "slashing",
            "traits": ["agile"]
          },
          "tail": {
            "damage": "2d6",
            "damageType": "bludgeoning",
            "traits": ["reach"]
          },
          "__merge": "@merge(@record.data.effects.dragonForm.type.strikes)"
        }
      }
    }
  ]
}
```

**How this works:**
1. User selects Fire Dragon or Ice Dragon
2. The AC expression evaluates (e.g., `18 + 4` = `22`)
3. The breath weapon damage evaluates (e.g., `{4 + 4}d6` = `"8d6"`)
4. Override applies:
   - Sets size, ac, senses, speed, fly from choice
   - Defines base strikes (claw, tail)
   - Merges in dragon-specific strikes (jaws, breathWeapon)
5. Final character has all four strikes with all properties

---

### Example 2: Rage with Damage Type Choice

```json
{
  "name": "Elemental Rage",
  "stackable": false,
  "duration": 3,
  "durationUnit": "rounds",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.rage.element",
      "valueType": "string",
      "value": {
        "prompt": "Select Element",
        "choices": [
          { "label": "Fire", "value": "fire" },
          { "label": "Cold", "value": "cold" },
          { "label": "Lightning", "value": "lightning" },
          { "label": "Acid", "value": "acid" }
        ]
      }
    },
    {
      "type": "data",
      "value": {
        "field": "meleeDamageBonus",
        "operation": "add",
        "value": 4
      }
    },
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "rageDamageType": "@record.data.effects.rage.element",
        "rageActive": true
      }
    }
  ]
}
```

---

### Example 3: Level-Based Ability Boost

```json
{
  "name": "Level 5 Ability Boost",
  "stackable": false,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.level5Boost.ability",
      "valueType": "string",
      "value": {
        "prompt": "Choose an ability score to boost",
        "choices": [
          { "label": "Strength", "value": "strength" },
          { "label": "Dexterity", "value": "dexterity" },
          { "label": "Constitution", "value": "constitution" },
          { "label": "Intelligence", "value": "intelligence" },
          { "label": "Wisdom", "value": "wisdom" },
          { "label": "Charisma", "value": "charisma" }
        ]
      }
    },
    {
      "type": "data",
      "value": {
        "field": "@record.data.effects.level5Boost.ability",
        "operation": "add",
        "value": 2
      }
    }
  ]
}
```

**Note:** This example shows using a choice value as the field path in a data rule.

---

### Example 4: Complex Multi-Choice Effect

```json
{
  "name": "Adaptable Weapon",
  "stackable": false,
  "durationUnit": "indefinite",
  "rules": [
    {
      "type": "choiceSet",
      "field": "data.effects.adaptableWeapon.damageType",
      "valueType": "string",
      "value": {
        "prompt": "Select Primary Damage Type",
        "choices": [
          { "label": "Slashing", "value": "slashing" },
          { "label": "Piercing", "value": "piercing" },
          { "label": "Bludgeoning", "value": "bludgeoning" }
        ]
      }
    },
    {
      "type": "choiceSet",
      "field": "data.effects.adaptableWeapon.element",
      "valueType": "string",
      "value": {
        "prompt": "Select Elemental Enhancement",
        "choices": [
          { "label": "Flaming", "value": "fire" },
          { "label": "Frost", "value": "cold" },
          { "label": "Shock", "value": "lightning" },
          { "label": "Corrosive", "value": "acid" }
        ]
      }
    },
    {
      "type": "override",
      "field": "",
      "valueType": "object",
      "value": {
        "weaponDamageType": "@record.data.effects.adaptableWeapon.damageType",
        "weaponElementalDamage": "1d6 @record.data.effects.adaptableWeapon.element",
        "weaponDescription": "A magical weapon dealing @record.data.effects.adaptableWeapon.damageType and {1 + @record.data.level / 5}d6 @record.data.effects.adaptableWeapon.element damage"
      }
    }
  ]
}
```

---

## Best Practices

### 1. Field Path Consistency
Always use the full `@record.data.` prefix for clarity and consistency:
```json
// ✅ Good
"ac": "@record.data.effects.dragonForm.ac"
"__merge": "@merge(@record.data.effects.dragonForm.strikes)"

// ❌ Inconsistent
"ac": "@record.data.effects.dragonForm.ac"
"__merge": "@merge(effects.dragonForm.strikes)"  // Missing @record.data.
```

### 2. Use Meaningful Choice Field Paths
Store choices in a structured way under `data.effects.effectName`:
```json
// ✅ Good - clear and namespaced
"field": "data.effects.dragonForm.type"
"field": "data.effects.rage.element"

// ❌ Bad - unclear, might conflict
"field": "data.choice1"
"field": "data.temp"
```

### 3. Inline Math for String Context
Use curly braces when embedding math in strings:
```json
// ✅ Good - clear that it's a calculated value
"damage": "{4 + @record.data.level}d6"

// ❌ Won't work - will be treated as literal string
"damage": "4 + @record.data.level d6"
```

### 4. Expression Evaluation in Choices
Put expressions in your choice values, not in the override:
```json
// ✅ Good - expression evaluated once when choice is made
{
  "type": "choiceSet",
  "value": {
    "choices": [
      {
        "label": "Fire",
        "value": "{ \"ac\": \"18 + @record.data.level\" }"
      }
    ]
  }
}

// Then in override:
"ac": "@record.data.effects.choice.ac"  // Already evaluated to a number
```

### 5. Deep Merge vs Direct Assignment
Use `__merge` when you want to combine data:
```json
// Use __merge when combining
{
  "strikes": {
    "baseStrike": { "damage": "1d6" },
    "__merge": "@merge(@record.data.effects.form.strikes)"
  }
}

// Use direct merge when replacing
{
  "strikes": "@merge(@record.data.effects.form.strikes)"
}
```

### 6. Error Handling
The system handles missing values gracefully:
- Missing `@record.data.path` resolves to `0` for math, `""` for strings
- Invalid merge targets log warnings but don't break
- Failed expressions return the original value

### 7. Testing Your Effects
1. Test with null/undefined fields
2. Test with extreme values (very high/low levels)
3. Test multiple instances if stackable
4. Test removal to ensure values restore correctly
5. Test all choice combinations

### 8. Documentation in Effect Descriptions
Include helpful info in your effect descriptions:
```json
{
  "name": "Dragon Form",
  "description": "Transform into a dragon. AC, strikes, and movement are overridden. Choose dragon type when applied. Duration: 10 minutes.",
  "rules": [...]
}
```

---

## Technical Notes

### Effect Application Order
1. ChoiceSet and Input rules prompt the user and store values (in declaration order)
2. Choice values with expressions are evaluated
3. Data rules are processed and applied
4. Override rules are processed with access to choice/input values
5. All changes are committed atomically

### Effect Removal
- Data rules: Restore values from operation history stack
- Override rules: Restore values from snapshot
- ChoiceSet / Input rules: Clear the stored value

### Snapshot Storage
Override rules store original values at:
```
fields.__overrides.{effectId}
```

Data rule history is stored at:
```
fields.{fieldName}.{effectId}
```

### MongoDB Compatibility
- Null values in snapshots represent originally undefined fields
- Complete objects are set when current value is null to avoid MongoDB field creation errors
- Dot notation is used for nested updates when safe

---

## Support & Questions

For issues or questions about the Effects system:
1. Check this documentation for examples
2. Review the source code at `src/actions/characters.js`
3. Test your effects in a development campaign first
4. Report bugs with example effect JSON and expected vs actual behavior
