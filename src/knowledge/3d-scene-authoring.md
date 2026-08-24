# Authoring a Realm VTT 3D scene

Everything on a 3D scene is a row in `scene-objects-3d`, placed with
`realm_place_objects`. This document is the contract those rows must satisfy. Get it
right and the scene reads correctly in the renderer; get it wrong and the JSON still
looks perfectly reasonable while the floor pokes through doorways and every chair
faces the wall.

There is **no story or level field**. A multi-story building is just objects at
different `pos.z`. Cutaway and vision are computed from geometry at render time.

---

## 1. The object

```jsonc
{
  "kind": "tile" | "prop" | "light",   // required
  "assetId": "fantasy-stone-floor",     // required — from realm_search_3d_assets
  "pos": { "x": 12, "y": 7, "z": 0 },   // required, in CUBES
  "rot": 0,                             // required, 0–23 (15° steps)

  "scale": 1,            // uniform multiplier on top of the asset's baseScale
  "pitch": 0, "roll": 0, // 0–23, for props the user deliberately tilts
  "blocksVision": true,  // defaults from the asset
  "visibleToPlayers": true,
  "locked": false,

  "portal": { "closed": true, "hostAssetId": "..." },  // doors/windows
  "light":  { "color": "#ffd9a0", "intensity": 3, "range": 4 },
  "roof":   { "w": 8, "h": 6, "style": "gable", "pitch": 30 }
}
```

`kind` is intrinsic, not cosmetic:

| kind | what it is | snapping |
|---|---|---|
| `tile` | grid-snapped blocks — **floors AND walls** | coarse horizontal, fine vertical |
| `prop` | free placement — furniture, decor, **doors and windows** | fine on all axes |
| `light` | a bare light source, no mesh | free |

Walls are `tile`. Doors and windows are `prop`. The floor/wall/door/window
distinction lives on the asset's **`role`**, not on `kind`.

---

## 2. Units

**1 cube = 1 grid cell = 5 feet.** `x`/`y` are the ground plane, `z` is up.

Two numbers drive nearly all vertical maths:

```
FLOOR_THICKNESS = 0.45     every floor slab
WALL_HEIGHT     = 2.0      the wall family's height (10 ft)
```

A floor tile at `pos.z` has its **walking surface at `z + 0.45`**. Props are
**base-anchored**, so you rest something on a surface by setting its `pos.z` to that
surface's z — not to the tile's z.

---

## 3. Vertical layout

### Ground story

```
floor tiles      z = 0        surface at 0.45
walls/doors/win  z = 0.45     ← ON TOP of the slab
wall top         z = 2.45
```

Walls seat on top of the floor slab. Put them at `z = 0` and the floor slab pokes up
through every doorway, because portals render base-anchored at their raw `pos.z`
with no surface resolution.

### Upper stories

Two conventions exist, and they are both correct for different jobs:

**Clipped (what the Rooms tool does).** The upper slab sits *inside* the walls
below, so the exterior skin runs unbroken past the story line:

```
upper floor  z = 2.0     (= ground wall z 0.45 + WALL_HEIGHT 2.0 − 0.45)
upper walls  z = 2.0     ← the slab clips into its own walls, deliberately
```

**Stacked (full headroom).** The upper slab rests on the wall tops:

```
upper floor  z = 2.45    (the ground wall top)
upper walls  z = 2.45
```

Clipped keeps the outside seamless; stacked gives the ground floor its full 2.0
cubes (10 ft) of headroom instead of 1.55 (7.75 ft). For a building the players walk
inside, prefer **stacked**. The story-to-story delta is the WALL height, not the
floor thickness.

Stacking terrain is simpler: repeat tiles at `z = 0, 0.45, 0.90 …`; a stack of
`n` tiers has its surface at `(n + 1) × 0.45`.

### Going below ground level

**`pos.z` is signed — nothing stops you building downward.** z 0 is a convention,
not a floor. Basements, cellars, crypts, sewers, mine shafts, sunken pits and
underwater ruins are all just negative z, and they follow exactly the same rules as
a story above ground.

One basement below a ground floor at z 0, using the stacked convention:

```
basement floor   z = −2.45    surface −2.0
basement walls   z = −2.0     top       0.0
ground floor     z =  0       surface   0.45
```

The ground floor's slab is the basement's ceiling. Work downward by subtracting a
full story (the wall height) each time, exactly as you add one going up — and cut a
stairwell in the ground floor for the stair down, just as you would for a stair up.

For a shallow pit or sunken area rather than a whole story, drop the floor tiles by
whatever depth you want (`z = −0.45` is one slab down, `−0.9` two) and wall the
sides. Keep each drop under **0.65 cubes** if tokens are meant to climb out; deeper
than that and they need a stair, ladder or a fall.

Nothing about vision, lighting or cutaway cares that z is negative.

---

## 4. Rotation

`rot` is a **byte 0–23**, one step per 15°. Tiles are clamped to multiples of 6
(90°); props can use all 24.

There are two different things `rot` means, and conflating them is the single most
common authoring bug.

### Walls: rot names the cell EDGE the piece hugs

One wall piece per cell edge:

```
 0 = north edge (+y)
 6 = east  edge (+x)
12 = south edge (−y)
18 = west  edge (−x)
```

Two adjacent cells share an edge — place **one** wall on it, not one from each side.

### Props: rot points the FRONT

Props are baked front = −Z, so a rot byte aims the front:

```
 0 → faces −y
 6 → faces −x
12 → faces +y
18 → faces +x
```

So a chair against the **north** wall faces the room at **rot 0**. The mnemonic that
keeps it straight: for a wall, rot names *where the piece is*; for a prop, rot names
*where it looks*. They coincidentally use the same numbers and mean opposite things.

Derive a prop's facing from the direction you want it to look:

| want the front to point | rot |
|---|---|
| −y (south-facing, i.e. against the north wall) | 0 |
| −x (west-facing, against the east wall) | 6 |
| +y (north-facing, against the south wall) | 12 |
| +x (east-facing, against the west wall) | 18 |

**Don't derive this by hand.** `realm_place_objects` accepts `facing: {x, y}` on a
prop — the point its front should look at — and works the byte out for you:

```jsonc
{ "kind": "prop", "assetId": "chair", "pos": {"x":5,"y":6,"z":0.45},
  "facing": {"x":5,"y":5} }        // the table → rot 0
```

A chair gets its table, a statue the doorway it watches, a throne the room's
entrance. This is worth using every time, because hand-derivation inverts
constantly — the wrong answer is always exactly 180° out, which is how a set of
chairs ends up facing the wall instead of the table they're pulled up to.

Some individual GLBs are baked off-convention and need a correction — cars whose
length runs along model X, for instance, need `(rot + 6) % 24`. If a placed prop
looks 90° or 180° out, that is the asset, not the rule.

---

## 5. Position

`pos` is continuous, but for a **prop an integer `pos` is the CELL CENTRE**. Tiles
fill the cell whose corner is at their integer position. So a prop at `x: 5` stands
in the middle of column 5; a floor tile at `x: 5` covers column 5.

Props are base-anchored: `pos.z` is where the bottom of the model sits.

- on the ground floor → `z = 0.45` (the slab's surface)
- on an upper floor at slab z 2.45 → `z = 2.9`
- on a table whose surface is 0.9 above the floor → `z = 0.45 + 0.9`

---

## 6. Props that touch a wall

Three things go wrong when a prop is positioned against a wall by hand, and all
three come from the same fact: **a wall does not fill its cell.** It's inset by its
own depth (0.65), so its inner FACE sits 0.15 into the room from the cell centre —
not at the cell boundary, and not at the cell centre.

Name the wall instead of computing the position:

```jsonc
// MOUNTED decor — torch, sconce, painting, banner
{ "kind": "prop", "assetId": "torch",
  "pos": { "z": 0.45 },                       // the wall's base
  "onWall": { "x": 5, "y": 5, "rot": 0, "heightFrac": 0.6 } }

// FLOOR-STANDING back-to-wall — bookcase, wardrobe, hearth, altar, workbench
{ "kind": "prop", "assetId": "bookcase",
  "pos": { "z": 0.45 },                       // the walking surface
  "againstWall": { "x": 5, "y": 5, "rot": 0 } }
```

Both take the host wall's cell and the edge rot it hugs, and derive position,
facing, and (for mounted decor) `mountCullZ`.

What each fixes:

- **Torches floating off the wall** — mounting at the wall's cell centre leaves the
  piece hanging 0.27 out in the room. `onWall` puts its back on the face.
- **Bookcases not flush** — placing one at the *adjacent* cell's centre leaves a
  ~0.5 gap. `againstWall` seats its back against the face.
- **A hearth sunk into the masonry** — placing it on the wall's own cell buries it.
  `againstWall` stands it out of the wall.

Two rules worth knowing even when using the helpers:

**Mounted decor uses the wall's OWN edge rot** — N→0, E→6, S→12, W→18 — because
these GLBs are baked with their flat BACK on +Z. Flipping it (the intuitive move)
mounts the piece facing into the wall.

**Mounted decor needs `mountCullZ`** set to the wall's base, so it dissolves *with*
its wall during cutaway rather than hanging in mid-air after the wall cuts away.

## 7. Doors and windows

A door or window is a `prop` placed on a wall's edge, carrying a `portal`:

```jsonc
{
  "kind": "prop",
  "assetId": "fantasy-stone-door",
  "pos": { "x": 4, "y": 2, "z": 0.45 },   // same z as the walls
  "rot": 6,                                // the EDGE it occupies
  "portal": {
    "closed": true,
    "hostAssetId": "fantasy-stone-wall",   // so filler renders in the wall's material
    "secret": false,
    "locked": false,
    "flip": false
  }
}
```

**A portal replaces the wall on that edge — do not place both.** The door piece is
the wall for that cell edge.

Match the door/window to the wall's **family** so the thickness agrees, or it will
sit proud of the wall or float inside it. `realm_search_3d_assets` exposes `family`,
`familyMaterial` and `familyThickness` for exactly this; assets in the same `family`
are thickness-matched to each other by construction.

Windows should set `blocksVision: false`.

### Secret doors

A secret door is **not a door asset with a flag on it**. It is the **wall itself**,
carrying a portal marked secret:

```jsonc
{
  "kind": "tile",                          // a TILE — it is a wall
  "assetId": "fantasy-stone-wall",         // the WALL asset, role: "wall"
  "pos": { "x": 4, "y": 2, "z": 0.45 },
  "rot": 6,                                // the edge it occupies
  "portal": { "closed": true, "secret": true }
}
```

That distinction is the whole trick. Because the placeable's role stays `wall`,
players see a plain, unremarkable stretch of wall — identical to the wall it sits in,
because it *is* that wall asset. The GM sees a swingable, tinted door and can open
it. The moment the GM opens it, every player sees the revealed doorway too.

Getting this wrong is easy and looks fine in the JSON:

- **Using a door asset** with `secret: true` gives a placeable whose role is `door`,
  so players see a door — visibly a door, just one they can't operate. Not secret.
- **Using a different wall asset** from the surrounding wall makes the secret door a
  differently-textured panel in an otherwise uniform wall. Use the *same* `assetId`
  as its neighbours.

Behaviour, for reference: a closed secret door blocks vision and movement exactly
like the wall it impersonates. Opening it makes it passable and visible to everyone.
Only doors can be secret — a window is always visible. Both doors and windows can be
`locked`, which makes them GM-only to open (players get a "Locked" message instead).

---

## 8. Lights

A bare `kind: "light"` object is a light with no mesh. A **light-emitting prop**
(torch, lantern, brazier) must carry the catalog asset's `light` blob **on the
placement** — the renderer reads `object.light`, not the asset's. Copy it from the
`light` field `realm_search_3d_assets` returns.

```jsonc
"light": {
  "color": "#ffd9a0",
  "intensity": 3,
  "range": 4,          // in grid squares
  "angle": 0,          // cone half-angle in radians; 0 = omnidirectional
  "rotation": 0,       // cone bearing in radians
  "flicker": 0.4,      // 0 steady … 1 max
  "falloff": 0.5       // 0 = bright to the edge, 0.5 = D&D-style
}
```

Patch `light: null` to remove a light from a lit prop without deleting the prop.
Light is expensive — a torch every 6–8 cells along a corridor is plenty.

---

## 9. Roofs

A roof is **one parametric object** spanning a whole footprint, not many tiles:

```jsonc
{
  "kind": "tile",
  "assetId": "<a role:'roof' asset>",
  "pos": { "x": 4, "y": 3, "z": 2.45 },   // footprint MIN CORNER, at the wall top
  "rot": 0,                                // 0 = ridge along x; 6 = ridge along y
  "roof": {
    "w": 8, "h": 6,
    "style": "gable",   // gable | shed | hip
    "pitch": 30,        // degrees
    "overhang": 0.5,    // eave extension, in cells
    "thickness": 0.2,
    "ridgeInset": 1     // hip only
  }
}
```

Convention: `rot 0` when `w ≥ h`, else `rot 6`. Roof assets are texture-only and
have no GLB — the mesh is generated at render time.

---

## 10. Creatures are not scenery

Everything above is **scenery** — `scene-objects-3d` rows placed with
`realm_place_objects`. Creatures are different: a goblin on the map is a **token**,
an instance of an NPC record, created with `realm_place_tokens`. Six goblins are six
token documents all pointing at one NPC record.

```jsonc
// realm_place_tokens
{
  "sceneId": "…",
  "record": "Goblin",              // by name or id
  "at": [ { "x": 19, "y": 12 }, { "x": 21, "y": 13 } ],
  "faction": "enemy"
}
```

Tokens use the **same grid coordinates** as the scenery, so a creature at `x:19,
y:12` stands on the floor tile at `19,12`.

- `z` is elevation in cubes. Leave it 0 for the ground floor, or set it to a
  storey's walking surface (2.9 in the stacked convention) to place a creature
  upstairs. A grounded token settles onto whatever surface is under it.
- `flying: true` is only for a creature genuinely airborne — never use it just
  because `z` is raised.
- Whether a token draws as a flat image or a 3D model comes from its RECORD
  (`token.model3D`), not from the token. `realm_set_3d_token` gives a monster a
  mini; without one it renders from its flat token image.
- Both fields are ignored on 2D scenes, which is what `realm_place_tokens` will
  tell you if you send them.

## 11. Your own models

When the shared catalog has nothing for a piece of scenery, upload a GLB with
`realm_upload_3d_model` and it comes back with an `assetId` that
`realm_place_objects` takes exactly like a catalog one. It's owner-scoped, and it
still renders for other people in a scene you share.

The conventions in `realm_guide` topic `3d-assets` apply — most importantly:

- **1 GLB unit = 1 grid cube = 5 ft.** A model authored in METRES needs
  `baseScale: 0.66` (1 / 1.524); millimetres need about `0.00066`. Getting this
  wrong is the difference between a chair and a monument.
- **Front faces −Z**, base at y = 0, centred on x/z. A model authored facing
  another way can be corrected on upload with `modelRotation` (degrees) rather than
  re-exporting.
- `role: "wall" | "door" | "window"` makes a custom model behave like a structure
  piece — edge snapping, portals — instead of free-placed decor.

### An uploaded model as a creature MINI

`realm_set_3d_token` takes a `cust-` id just as readily as a catalog one — a
`model3D.url` of `/3d/user/…` is as valid as `/3d/tokens/…`. So a character model
you uploaded can be assigned to an NPC or PC directly.

Four settings decide whether it actually sits right on the table, and all four are
adjustable **without re-uploading**:

| | |
|---|---|
| `usePedestal` | the standard token base. **On by default** for uploads — most GLBs are a bare figure with nothing under them. Turn it off only for a model that ships its own base. |
| `frontFaceDeg` | FACING. The model's front must point along 0-rotation (−Z / north). A mini facing backwards on the table needs `180`; sideways needs `90` or `270`. This is the model's baked correction — separate from the token's in-scene rotation, which is per placement. |
| `offsetY` | raise (+) / lower (−). The fix when a model floats above its pedestal or sinks into it, which happens whenever the GLB's origin isn't at its feet. |
| `offsetX` / `offsetZ` | left-right and forward-back nudges, to centre a model that sits off its base. |

Offsets are in cube units, so `0.1` is half a foot. Get the model in, look at it,
then adjust — that's faster than guessing from the GLB.

## 12. Pin what you build

A scene opens at its default framing. Build a map at (40, 25) and the GM arrives
looking at empty ground, with no clue where it went.

So finish a new scene with a camera pin at the middle of it:

```jsonc
// realm_add_pin
{ "sceneId": "…", "name": "Main Location", "center": true, "makeDefault": true }
```

`center: true` puts it at the middle of everything already placed; `makeDefault`
makes the camera open there. Pins are GM-only — players never see them.

Beyond that one, add pins, **teleporters**, **text blocks** and **journal links**
only when asked. Teleporters change how a map plays, and unrequested floating
labels make a scene read like a diagram instead of a place.

A **journal link** (`realm_add_journal_link`) is a note marker the GM clicks to
open a journal at a chosen page — the right tool when someone asks for room
descriptions or a read-aloud box attached to a spot on the map:

```jsonc
// realm_add_journal_link
{ "sceneId": "…", "journalId": "…", "x": 12, "y": 8, "z": 0.45, "page": "The Cellar" }
```

Give `page` a page NAME rather than a number: the scene stores a page number, and
numbers get reshuffled when pages are reordered, so a name is the only thing you
can actually know is right. `z` puts the link on the correct floor — without it a
link on an upper story is computed from the geometry underneath.

Journal links are addressed by their `index` in `realm_list_markers`, not by id
(their `id` is the journal's, and repeats when a journal is placed twice).

A **region** (`realm_add_region`) is a GM-only trigger area: when a character
token enters it, it can float text above the token, auto-pause the game (once,
until reset), and scale movement cost while inside (`moveSpeedFactor: 0.5` =
half speed / difficult terrain). Players never see regions.

```jsonc
// realm_add_region — a rect covering cells (10,8)..(15,13) on the ground floor
{ "sceneId": "…", "name": "Ambush", "x": 10, "y": 8, "w": 6, "h": 6,
  "text": "You feel watched…", "autoPause": true, "moveSpeedFactor": 0.5 }
```

Pass `points` instead of the rect for an irregular polygon. On a 3D scene, `z`
is the region's BOTTOM elevation in cubes and `height` (default 3) how far up it
reaches — so a region on the second story gets that story's floor z, exactly
like a prop placed there. Edit with `realm_update_region` (by `id` from
`realm_list_markers`; `resetAutoPause: true` re-arms a fired auto-pause), remove
with `realm_delete_marker` (`kind: "regions"`). Like teleporters, only add
regions when asked — they change how a map plays.

## 13. Checklist before placing

- [ ] Every `assetId` exists — verify with `realm_search_3d_assets` first. An
      unknown id renders as a magenta "missing asset" marker.
- [ ] Walls at `z = 0.45` on the ground story, not `z = 0`.
- [ ] One wall per shared edge, and no wall underneath a door or window.
- [ ] Doors/windows from the same `family` as their wall.
- [ ] Props that look at something use `facing`, not a hand-computed `rot`.
- [ ] Anything touching a wall uses `onWall` (decor) or `againstWall` (furniture).
- [ ] A `Main Location` pin marks the build (`realm_add_pin`, `makeDefault: true`).
- [ ] Lit props carry the asset's `light` blob on the placement.
- [ ] Props rest on a surface z (`floor z + 0.45`), not on the tile's z.

After placing, `realm_get_scene_objects` gives counts by kind and the z levels in
use — a fast way to catch a story built at the wrong height.
