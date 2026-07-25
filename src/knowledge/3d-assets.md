<!-- Copied from realm15-client/docs/3d-asset-conventions.md by scripts/sync-docs.mjs.
     Edit it there, not here. `npm run check:sync` fails when this copy is stale. -->

# 3D asset conventions (scale, orientation, pivot)

Status: accepted — the contract every GLB the 3D renderer places must satisfy.

These are the conventions the **asset-generator** (`tools/asset-generator`) bakes
into the GLBs it produces, and the ones a **custom prop / token upload** should
match so it lands at the right size, facing, and height on the tabletop. When a
model looks giant, tiny, sideways, sunk into the floor, or floating, it's almost
always a violation of one of the three rules below.

## 1. Scale — 1 GLB unit = 1 grid cube = 5 ft = 1.524 m

Models are authored at true proportions (uniform scale, no per-axis stretch). The
renderer scales the model by `cubeSize` on load, so a model authored at
"1 unit = 1 cube" renders at correct real-world size with no extra multiplier.

- Canonical constants: `METRES_PER_CUBE = 1.524`,
  `BASE_SCALE_FOR_METRES = 1 / 1.524 ≈ 0.6562`
  (`tools/asset-generator/src/import3d/classify.js`).
- Parametric pieces are authored directly in cube units — e.g. a wall is
  `1.08 × 2.0 × 0.65`, a floor tile slab is `1 × 1 × 0.45` thick.
- **Fit-to-target-size is OFF by default.** The generator preserves native units
  (`normalizeGlb.js` `targetMaxDim` defaults to `null` → `scale = 1`); it only
  rescales as an explicit outlier rescue.

### What this means for `baseScale` on an upload

`baseScale` is a per-asset multiplier (rendered size = per-instance scale ×
`baseScale`). Pick it from the **units the GLB was exported in**:

| GLB authored in | Approx. `baseScale` to reach tabletop size |
| --------------- | ------------------------------------------ |
| grid cubes (Realm-native) | `1` |
| meters          | `~0.66` (= 1 / 1.524) |
| centimeters     | `~0.0066` |
| millimeters     | `~0.00066` |

This is why the custom-asset and token upload dialogs allow a very small Base
Scale (floor `0.0001`, 4-decimal precision): a millimeter-native Blender/CAD
export needs a multiplier around `0.00066`. The live preview renders the model
against a single 1×1 grid cell so the base scale can be judged directly.

For imports, the generator auto-detects units from the bbox magnitude
(max extent > 30 → treated as centimeters) and writes the result as a `baseScale`
**data field** — it does not rescale the geometry.

## 2. Orientation — Y-up, front faces −Z (north) at rotation 0

- **Up axis is Y** (glTF standard). Geometry authored in Blender (Z-up) is
  converted to Y-up by the glTF exporter
  (`tools/asset-generator/src/import3d/blender_export.py`); the Unreal exporter
  does the same.
- **Front faces −Z** ("north") at rotation 0, so rotating the placeable turns its
  nose the way you'd expect. Tripo outputs models facing ≈ +Z (toward the concept
  camera), so a 180° yaw correction exists (`normalizeGlb.js`
  `DEFAULT_FACE_DEG = 180`).
  - **Tokens** generally defer facing to a sidecar `frontFaceDeg` field, corrected
    in the upload UI (the blue arrow in the preview points −Z; line the model's
    nose up with it).
  - **Props** bake no facing rotation by default (`faceDeg = 0`) — the authored
    front is taken as-is. A wrong-facing prop needs a reorient-and-resave in the
    generator, not a runtime field.

## 3. Pivot / origin — centered on X/Z, base on the ground (min Y = 0)

The origin is a **bottom-center anchor**: centered on X and Z, with the lowest
point of the model at Y = 0, so it rests on the cell floor.

- **Props** get this baked: `normalizePropGlb` (`normalizeGlb.js`) recenters X/Z,
  drops min-Y to 0, then flattens the transform into the vertices.
- **Parametric builders** author base-at-Y=0 natively (columns, walls, tiles).
- **Tokens** intentionally do NOT bake centering/grounding — the renderer
  (`Token3DModel.buildTokenObject`) recenters X/Z and drops the lowest point to
  Y = 0 at load, so baking it would be redundant. The token pedestal is sized by
  creature size, not by `baseScale`.

## Where these are enforced (asset-generator)

- Scale: `src/import3d/classify.js` (`METRES_PER_CUBE`, `BASE_SCALE_FOR_METRES`),
  `src/builder/wallDims.js`, `src/builder/tileGeometry.js`.
- Orientation: `src/import3d/blender_export.py` (Z-up → Y-up),
  `src/gen/normalizeGlb.js` (`DEFAULT_FACE_DEG`, `normalizeTokenGlb`).
- Pivot: `src/gen/normalizeGlb.js` (`normalizePropGlb`), plus base-at-Y=0 authoring
  in each parametric builder.
- Prose reference: `tools/asset-generator/README.md` ("authored in grid-cube
  units, 1 unit = 1 cube… base at Y=0… footprint fills exactly one grid cell").

## REST API examples

Both flows use JWT bearer auth (`Authorization: Bearer <token>`). Uploads and the
owner-scoped `custom-assets-3d` service live on the app backend; campaign records
(`/npcs`, `/records`, …) also resolve through `utilities.realmvtt.com`. Every
request below takes the same JWT.

```bash
JWT="eyJhbGciOi…"
API="https://utilities.realmvtt.com"
```

### A. Upload a custom 3D asset (a prop)

Two steps: upload the `.glb` to get its storage path, then create the
`custom-assets-3d` record that points at it.

```bash
# 1) Upload the GLB. X-Asset-Kind: model-3d routes it to the 3d/user/ prefix.
#    The response is PLAIN TEXT — the storage path, e.g. "/3d/user/ab12….glb".
MODEL_PATH=$(curl -sS -X POST "$API/upload" \
  -H "Authorization: Bearer $JWT" \
  -H "X-Asset-Kind: model-3d" \
  -F "file=@./oak-barrel.glb;type=model/gltf-binary")

# modelPath is stored WITHOUT the leading slash.
MODEL_PATH="${MODEL_PATH#/}"

# 2) Create the owner-scoped custom asset. ownerId is set server-side from the JWT.
#    baseScale 0.66 ≈ a meters-native GLB (= 1 / 1.524); use ~0.00066 for a mm export.
curl -sS -X POST "$API/custom-assets-3d" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Oak Barrel",
    "kind": "prop",
    "placementType": "free",
    "modelPath": "'"$MODEL_PATH"'",
    "baseScale": 0.66,
    "blocksVision": false,
    "walkable": false
  }'
```

- `placementType`: `"free"` (freeform prop) or `"wall"` (snaps to walls).
- Optional `previewPath`: upload a PNG/JPG/WebP the same way but **without** the
  `X-Asset-Kind` header, strip the leading slash, and pass it here (falls back to
  an icon if omitted).
- Optional `light`: `{ "color": "#ffaa55", "intensity": 1, "range": 4,
  "angle": 0, "flicker": 0.4, "falloff": 0.5 }` for a glowing prop (torch/brazier).

### B. Attach a GLB as a token's 3D model on another record

A token's 3D model lives at `record.token.model3D`. Patch the record, replacing the
whole `token` object (merge any existing 2D token fields you want to keep — the
patch overwrites `token` wholesale). `imageUrl` must be a string (`""` if none).

```bash
RECORD_ID="66f0…"   # e.g. an NPC. Characters: PATCH $API/records/<id> with recordType.

curl -sS -X PATCH "$API/npcs/$RECORD_ID" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "token": {
      "imageUrl": "",
      "model3D": {
        "url": "3d/user/ab12….glb",
        "baseScale": 0.66,
        "usePedestal": false,
        "frontFaceDeg": 180,
        "offsetX": 0,
        "offsetZ": 0,
        "offsetY": 0
      }
    }
  }'
```

`model3D` fields (all optional except `url`):

- `url` — GLB path: a `3d/user/…` upload (from flow A, cleaned up on record delete)
  or a Realm catalog model `3d/tokens/…` (shared, never CDN-deleted).
- `baseScale` — multiplier on top of creature-size scaling (default `1`; see the
  units table above).
- `usePedestal` — render the default stand under the model; turn off when the GLB
  ships its own base (default `true`).
- `frontFaceDeg` — rotate the model so its nose points along the −Z ("north")
  facing at rotation 0 (Tripo-authored models usually need `180`).
- `offsetX` / `offsetZ` / `offsetY` — nudge/raise the model in model-local cube
  units to center it on the base (scales + rotates with the model).

To use the SAME uploaded GLB as both a placeable prop AND a token, run flow A once
and reuse its `modelPath` as the token's `model3D.url`.

## Client touch points

- Custom prop upload + live preview:
  `src/components/Dashboard/Custom3DAssets/Custom3DAssetModal.tsx`.
- Token 3D settings + live preview:
  `src/components/Dashboard/RecordWindow/Portrait/Token3DSettings.tsx`,
  `src/components/Dashboard/RecordWindow/Portrait/Token3DPreview.tsx`
  (1×1 grid cell = the true-scale size reference; −Z facing arrow).
