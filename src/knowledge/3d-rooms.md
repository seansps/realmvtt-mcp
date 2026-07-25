# Building rooms, buildings and stories

Read `3d-scene-authoring` first — this assumes the geometry contract (floor 0.45,
walls at 0.45 on the ground story, wall edges vs prop facing).

The in-app Rooms tool generates rooms procedurally from a style. **You are not
limited to what it produces, and you shouldn't be.** It arranges furniture with
fixed rules and no understanding of what the room is *for*; you know the room is a
smuggler's back office with a hidden door behind the ledger shelf, and can lay it
out accordingly. Use the tooling for what it's genuinely good at — telling you which
assets belong together — and do the design yourself.

## Two ways to get assets

**`realm_get_room_kit`** resolves a style into a coherent, pre-matched set: a floor,
wall families with thickness-matched doors and windows, a wall light, a stair, and
themed prop pools grouped by slot. Call it with no `style` to list the styles.
This is the fast path when you want a room that looks like it belongs to a setting,
and it saves you checking thickness matching by hand.

**`realm_search_3d_assets`** gives you the whole catalog to pick from — filter by
`kind`, `role`, `category` (folder-like, e.g. `fantasy/dungeon`), `tag`, `family`,
or a name regex. Use this when the kit's pools are too narrow, when you want to
combine settings deliberately, or when you're placing something specific the kit
would never choose.

Mix them freely: take the kit's wall family (so the doors fit) and hand-pick every
prop from the catalog. That is usually the best of both.

---

## Laying out a room

A rectangular room from `(x0, y0)` to `(x1, y1)` inclusive, on the ground story:

**1. Floor.** One `tile` per cell at `z = 0`, using a `role: "floor"` asset.
If the ground already has terrain tiles under the footprint, delete them first —
new floor tiles at the same level will otherwise collide and the room ends up
floorless.

**2. Perimeter walls.** Walk the boundary and place one wall per outward-facing cell
edge, at `z = 0.45`:

| edge | cell | rot |
|---|---|---|
| north | every cell with `y = y1` | 0 |
| east | every cell with `x = x1` | 6 |
| south | every cell with `y = y0` | 12 |
| west | every cell with `x = x0` | 18 |

Corner cells get two walls (one per exposed edge).

**3. Doors.** Pick edge slots and place a `prop` door there *instead of* the wall,
with `portal: { closed: true, hostAssetId: "<the wall's assetId>" }`. Keep a clear
cell in front of each door — nothing should spawn in a doorway. Doors belong on the
long sides where traffic actually flows, not jammed into corners.

**4. Windows.** Same substitution, but only on **exterior** walls. A wall shared
with an adjacent room is interior — putting a window there looks into a corridor.
Space them evenly, and set `blocksVision: false`.

**5. Wall lights.** Sconces and torches are `prop`s with `placementType: "wall"`.
Mount one with the rot byte of the **wall's own edge** (north wall → 0, east → 6,
south → 12, west → 18) — that faces the fixture out of the wall into the room. Set
`mountCullZ` to the host wall's top z so the sconce disappears together with its
wall during cutaway instead of hanging in mid-air. Every 5–8 cells is plenty, and
each one must carry the asset's `light` blob.

**6. Furniture.** This is where judgment beats generation. Some principles worth
keeping:

- **Zone it.** Anchor pieces (beds, shelves, workbenches, hearths) go against
  walls; clusters (a table with its chairs) go in the open middle; small scatter
  props fill the gaps.
- **Leave it walkable.** Keep roughly half the floor clear. A room where tokens
  can't move is a bad map, however handsome the screenshot.
- **Reserve clearance.** Nothing directly in front of a door, and keep a cell of
  breathing room around anything a token needs to reach.
- **Face things correctly.** Chairs face their table (front points along
  `(−dx, −dy)` from the chair to the table). Wall-backed furniture faces into the
  room. See the facing table in `3d-scene-authoring`.
- **Make it mean something.** An overturned chair, a bedroll by the fire, crates
  stacked against the door being barricaded — these are what the procedural
  generator can't do and you can.

---

## Second stories

Pick a convention from `3d-scene-authoring` §3 and hold it for the whole building.
Using the **stacked** one (full headroom), for a ground story with floor z 0:

```
ground floor   z = 0        surface 0.45
ground walls   z = 0.45     top 2.45
upper floor    z = 2.45     surface 2.90
upper walls    z = 2.45     top 4.45
```

Build the upper story exactly like the ground story at those heights, with one
addition: **cut the stairwell**. Omit the floor tiles the stair rises through, or
the stair emerges into the underside of a slab. Omit the *ramp* cells only — the
landing at the top keeps its floor, or you get a missing tile beside the stairs.

---

## Stairs

A stair asset carries a `stair` descriptor: `{ rise, run, width }` in cubes/cells.
`rise: 2` is exactly one story (the wall height).

Place it as a prop:

- `pos` = the **foot** cell, at the lower story's **walking surface** z (0.45 for a
  ground floor at z 0)
- `rot` = the direction it climbs: `0` climbs +y, `6` climbs +x, `12` climbs −y,
  `18` climbs −x
- it occupies `run` cells in that direction and `width` cells across — keep them
  clear of furniture, and cut the matching hole in the floor above

`realm_search_3d_assets` with `role: "prop"` and a `stair` search will find them;
kit results expose `stair` directly.

**If no stair asset fits**, build one from floor tiles: a rising column of tiles per
step, each step no more than **0.65 cubes** taller than the last (that's the
step-up limit for token movement). With `FLOOR_THICKNESS = 0.45`, one tile per step
is comfortably under it, so a 2.0-cube story needs about 5 steps — size the run so
the total rise divides evenly.

---

## Multi-room buildings

- **Share walls.** Two adjacent rooms sharing an edge get **one** wall on it, not
  two. Doubling up causes z-fighting where the faces coincide.
- **Connect deliberately.** A shared wall needs a door to be a doorway; without one
  the rooms are simply sealed off from each other.
- **Windows are exterior-only.** When you add a room against an existing wall, any
  windows on the now-interior wall should be replaced with solid wall.
- **Roofs go on last**, one parametric roof object per footprint at the wall top —
  see `3d-scene-authoring` §8.

## Verifying

`realm_get_scene_objects` reports counts by kind and every z level in use. A story
built at the wrong height shows up immediately as an unexpected z. Check that wall
counts look like a perimeter (roughly `2 × (width + height)`), and that door count
matches what you intended — a doubled number usually means you placed a wall under
each portal.
