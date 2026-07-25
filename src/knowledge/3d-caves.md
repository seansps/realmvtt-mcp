# Building caves

Read `3d-scene-authoring` first.

**Use `realm_build_cave_path`. Do not place cave walls by hand.**

That is not a style preference. A cave wall family is a 9-piece *connecting set*,
and the pieces only join where their ports land exactly — which takes floating-point
geometry with a grid-snap check per candidate. Placing straight pieces on cell edges
instead is what produces a blocky, stair-stepped cave with square corners, which is
the single most common way a cave comes out wrong.

## Caves are not rooms

| | Room / dungeon walls | Cave walls |
|---|---|---|
| Pieces | one straight wall (+ door, window) | 9-piece connecting set |
| Placement | one piece per cell EDGE, `rot` = the edge | chained along a route by port matching |
| Corners | 90°, implied by the grid | rounded corner, 45° bends, diagonals |
| Tool | `realm_place_objects` | `realm_build_cave_path` |

A family with **no bend pieces is not a cave set** — it's an ordinary wall family,
and `realm_build_cave_path` will refuse it and tell you to use per-edge walls. That's
the check that stops the two techniques being mixed up.

## The piece set

| `shape` | id suffix | seating | role |
|---|---|---|---|
| *(none)* | — | edge-hugging | straight |
| `wave` | `-wave`, `-wave2` | **edge-hugging** | straight, but bulging |
| `corner_round` | `-round` | cell-centred | 90° turn |
| `diag` | `-diag` | cell-centred | 45° run across a cell |
| `bend` / `bend_mirror` | `-bend` / `-bendb` | cell-centred | 45° turn, either direction |
| `bend_in` / `bend_in_mirror` | `-bendin` / `-bendinb` | cell-centred | 45° turn, inward pair |
| `diag_fill`, `filler` | `-diagfill`, `-filler` | cell-centred | junction fillers |

Two things that catch people out:

**Waves are edge-hugging.** They carry a `shape` but are straight-ported walls that
merely bulge. "Has a shape" does not mean "sits centred in its cell" — that's true of
the corners and bends, false of the waves.

**There are FOUR bends, not two.** At a given port exactly one placement of one bend
connects; the mirror pair forces the turn direction and the inward pair is what makes
a zigzag possible. This is why hand-placement fails: picking the wrong one of four
leaves a gap that looks like a modelling error.

## Drawing a route

`realm_build_cave_path` takes a `route` — the cells the wall run follows — and
chains pieces along it, exactly as the in-app Cave Draw tool does when you drag.

```jsonc
{
  "sceneId": "…",
  "family": "cave-rock",
  "route": [ {"x":0,"y":0}, {"x":5,"y":0}, {"x":10,"y":5}, {"x":10,"y":11} ],
  "z": 0.45,
  "apply": true
}
```

Three rules for a route that produces a real cave:

1. **Include diagonal moves.** Gaps are filled 8-way, so a route that only steps
   along x and y can only ever produce axis-aligned walls — a stair-step. Going from
   `(0,0)` to `(10,5)` in one waypoint gives you diagonals; going via `(10,0)` gives
   you a right angle.
2. **The route is the WALL LINE, not the passage centre.** Trace one side of the
   passage, then trace the other side as a second call.
3. **Waypoints, not every cell.** Corners of the winding path are enough.

The result reports `byShape`, so you can see immediately whether you got curves. A
run that is 100% `straight` means the route had no diagonals or turns in it.

## Sizing

The commonest complaint after stair-stepping is that passages feel cramped.

- **Passages: 3 cells wide minimum** (15 ft). Two cells is a squeeze corridor; one
  cell is a crawl and should be deliberate.
- **Chambers: 8–15 cells across.** A chamber wants to be visibly *not* a corridor —
  room for a fight, several tokens, and props around the edges.
- **Vary it.** A cave that is one width throughout reads as a corridor with a rock
  texture. Pinch to 2 cells at a chokepoint, open to 12 in a cavern.

Remember 1 cell = 5 ft: a 3-cell passage is 15 ft across, which is about right for a
party moving two abreast with room to fight.

## Finishing the cave

- **Floor** the whole interior with natural rock/dirt tiles (`role: "floor"`), at
  `z = 0` for the ground level.
- **Height variation** — stack floor tiers at 0.45 increments for a sloping cavern,
  keeping each step under the 0.65 step-up limit so tokens can walk it.
- **Light sparingly.** Caves are dark, and that's the point. A few lit props where
  the party will stop — a campfire, glowing fungus, a brazier at a camp.
- **Props**: rubble, stalagmites, bones. Scatter, don't line up.

## Verifying

`realm_get_scene_objects` breaks down what's placed by asset. If the cave's wall
count is overwhelmingly the plain straight piece, the route wasn't winding enough —
add diagonal waypoints and rebuild. Every piece should also resolve to a real asset;
a missing one renders as a magenta marker, which is very visible in a dark cave.
