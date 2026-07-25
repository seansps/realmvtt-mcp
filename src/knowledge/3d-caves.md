# Building caves

Read `3d-scene-authoring` first.

Cave walls are not ordinary straight walls. They ship as a **9-piece connecting
set** per family, designed so that any piece can abut any other. Understanding the
port model is what lets you build a winding passage that actually joins up instead
of a chain of near-misses.

## The port model

A wall run lives on a **grid line**, with its body occupying a band of width `depth`
on one side. The run's centerline therefore sits `depth / 2` in from that line.

Every piece begins and ends on one of two kinds of port:

- **AXIS port** — crosses a cell edge at `depth/2` from a grid line, perpendicular
  to it. This is exactly where a straight wall's end cap is.
- **DIAG port** — crosses a cell **corner** at 45°, its cross-section centred on the
  corner. This is exactly where a diagonal's end cap is.

**Pieces connect when their ports match.** That single rule is the whole system.

## The pieces

| `shape` | id suffix | seating | turns |
|---|---|---|---|
| *(none)* | — | edge-hugging | straight through |
| `wave` | `-wave`, `-wave2` | **edge-hugging** | straight through, but bulges |
| `corner_round` | `-round` | cell-centred | 90° |
| `diag` | `-diag` | cell-centred | 45° run across the cell |
| `bend` | `-bend` | cell-centred | 45° |
| `bend_mirror` | `-bendb` | cell-centred | 45°, mirrored |
| `bend_in` | `-bendin` | cell-centred | 45° inward |
| `bend_in_mirror` | `-bendinb` | cell-centred | 45° inward, mirrored |
| `diag_fill` | `-diagfill` | cell-centred | junction filler |
| `filler` | `-filler` | cell-centred | junction filler |

Two facts that are easy to get wrong:

**Waves are edge-hugging, not cell-centred.** They carry a `shape` value but they
are straight-ported walls that merely bulge in between. Do not treat "has a shape"
as "sits in the middle of its cell" — that's true of the corners and bends, and
false of the waves.

**There are FOUR bends, not two.** At any given port — a line, a heading, and which
side the body sits on — exactly *one* placement of *one* bend connects. The mirror
pair forces the turn direction, and the inward pair is what makes a zigzag possible.
If a bend refuses to line up, you almost certainly need one of the other three
rather than a different rotation.

Cave assets are `role: "wall"`, `kind: "tile"`. Find a family with
`realm_search_3d_assets` filtering `role: "wall"` and a cave-ish `category` or
`search`; every piece of one set shares a `family`.

## Laying out a passage

Work forward from an **open port** — a point plus the heading the run leaves it on:

1. Start on an axis port: a straight wall's end, on a grid line.
2. Choose the piece whose **entry** port lands on your current open port with the
   right heading. Straight and wave pieces continue in the same direction; a
   `corner_round` turns 90°; the bends and `diag` turn 45°.
3. That piece's **exit** port becomes the new open port.
4. Repeat until the run reaches where you're going.

Because the ports are exact, a closed loop comes back to its own starting port
precisely — an octagonal chamber built from 45° pieces meets itself with no fudging.
That's also the test: if your loop *nearly* closes, a piece is wrong, not the model.

Note that pieces advance by different amounts. A 45° piece moves the port across a
cell corner, a straight piece across a cell edge. **Don't assume one piece per
cell** when following a drawn route — chase the port until it reaches the target
cell, which may take more or fewer pieces than the cell count suggests.

## Designing the cave itself

The piece set is the vocabulary; the layout is yours. Some things worth doing that
a generator won't:

- **Vary the width.** A passage that is one cell wide everywhere reads as a corridor
  with a rock texture. Open into chambers, pinch into crawls.
- **Use the 45s.** Caves shouldn't read as a grid. Diagonals and bends are what
  make a passage look eroded rather than excavated.
- **Chambers from loops.** Ring a space with 45° pieces for a roughly circular
  chamber; the ports guarantee it closes.
- **Floor and ceiling.** Lay natural rock/dirt floor tiles through the passage. Cave
  floors can rise — stack tiers at 0.45 increments for a sloping cavern, keeping
  each step under the 0.65 step-up limit so tokens can walk it.
- **Light it sparsely.** Caves are dark; that's the point. A few lit props (glowing
  fungus, a brazier at a camp) placed where you want the party to stop.
- **Stack stories carefully.** An upper cave level follows the run below as a
  connected chain — advance it port by port, not by copying cells, since sampled
  cells skip.

## Verifying

Every cave piece is a wall, so `realm_get_scene_objects` shows them under `tile`.
Check the assetId breakdown: a passage that is 90% straight pieces probably isn't
winding much. And confirm each piece resolved — a missing cave asset renders as a
magenta marker, which is far more obvious in a dark cave than you might expect.
