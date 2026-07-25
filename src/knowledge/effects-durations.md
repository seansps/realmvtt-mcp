# Effect durations

An effect carries a `duration` (a number) and a `durationUnit` (how to count it).
The unit decides *when* the effect ends, and the choices are not interchangeable —
"until end of turn" and "until end of the caster's turn" expire at completely
different moments and are the classic way to get a spell's timing wrong.

## The units

| `durationUnit` | Shown as | Ends when |
|---|---|---|
| `indefinite` | Indefinite | Never, on its own. Only removal clears it. |
| `start_turn` | Until Start of Turn | The **affected token's** next turn begins |
| `end_turn` | Until End of Turn | The **affected token's** current/next turn ends |
| `start_applier_turn` | Until Start of Caster's Turn | The **applier's** next turn begins |
| `end_applier_turn` | Until End of Caster's Turn | The **applier's** current/next turn ends |
| `rounds` | Rounds | `duration` combat rounds have elapsed |
| `minutes` | Minutes | **Calendar** game time advances that many minutes |
| `hours` | Hours | **Calendar** game time advances that many hours |
| `days` | Days | **Calendar** game time advances that many days |
| `seconds-real` | Real Time (seconds) | That many seconds of **real, unpaused** time pass |

## The distinction that matters: whose turn?

Four units are turn-anchored, and they split into two pairs:

- `start_turn` / `end_turn` follow the **token the effect is on**.
- `start_applier_turn` / `end_applier_turn` follow the **token that applied it** —
  the caster.

For an effect a creature puts on *itself*, the two are the same and either works.
For anything one creature does to another they are different, and the wrong one
gives the target either a free extra turn under the effect or none at all.

The rule of thumb: if the fiction is *"until the end of your next turn"* said by the
caster about themselves, that's `end_applier_turn`. If it's a condition the target
shakes off on their own turn, that's `end_turn` or `start_turn`.

`start_*` versus `end_*` is the same question one step finer: a condition that
prevents acting usually wants `start_turn` (it lifts as the turn begins, or it
would waste the whole turn), while a bonus you get to use during your turn wants
`end_turn`.

## Rounds versus time

`rounds` counts **combat rounds** and ticks down once per round on the combat
tracker. Use it for anything measured in rounds by the rules.

`minutes` / `hours` / `days` count **game time**, and game time is advanced through
the campaign's in-game **Calendar** — the GM moves the clock forward there (resting,
travelling, skipping ahead). Combat rounds do **not** advance it. So a 10-minute
effect sits unchanged through an entire fight and only expires once someone advances
the calendar.

That makes the two families genuinely different clocks, not different scales of one:
10 rounds is a minute of fiction, but a `rounds` effect ticks on the combat tracker
while a `minutes` effect waits on the calendar. Pick whichever the rules text uses,
and be aware that a short "1 minute" buff will outlast a fight unless the GM advances
time afterwards.

## Real time

`seconds-real` counts wall-clock seconds of **unpaused** game time — useful for a
timer the players feel at the table rather than one their characters experience.

It is **only updated in 30-second intervals**, so anything shorter than about half
a minute is imprecise. Don't use it for fine-grained mechanics.

## Setting a duration

```jsonc
{
  "name": "Bless",
  "duration": 10,
  "durationUnit": "minutes",
  "rules": [ /* … */ ]
}
```

`indefinite` ignores `duration` entirely.

Durations can also be **rolled** rather than fixed — `1d4` rounds, or a value
derived from the caster with a `@record.data.path` reference. The `effects` guide
covers that under "Dynamic Duration Rolls", along with the pipe-fallback syntax and
inline `{math}`.

## Overriding at application time

A ruleset script applying an effect can override the unit for that one application:

```js
addEffect("Bless", token, { value: 3, unit: "rounds" });
```

A plain number instead of an object is interpreted in the effect's own
`durationUnit`. The override is stored per instance and cleared when the effect
expires or is removed, so the template is untouched. The API also accepts
`"seconds"` in addition to the units the editor's dropdown offers.
