/**
 * The cave-path chainer, ported from the client's Cave Draw tool
 * (`realm15-client/.../VttRenderer3D/cavePath.ts` + `wallShapeGeometry.ts`).
 *
 * WHY THIS IS CODE AND NOT A DOCUMENT
 *
 * Laying cave walls is not "place a wall on each cell edge". Every piece begins and
 * ends on a PORT — a point plus a heading — and a piece only connects if its entry
 * port lands exactly on the open port, at a legal cell, at one of four rotations,
 * traversed forwards or backwards. Getting that right means floating-point geometry
 * with a grid-snap validity check per candidate.
 *
 * That is not something a caller can work out by hand, and the failure mode is
 * quiet: unable to chain, you fall back to straight pieces on axis-aligned edges
 * and get a blocky, stair-stepped cave instead of a winding one.
 *
 * So the split is: the CALLER designs the route — where the passage goes, how wide,
 * where it opens into chambers, which is the creative part — and this turns that
 * route into correctly-connected pieces, which is purely mechanical.
 */

export type WallShape =
  | "diag"
  | "corner"
  | "corner_round"
  | "filler"
  | "diag_fill"
  | "bend"
  | "bend_mirror"
  | "bend_in"
  | "bend_in_mirror"
  | "wave";

export interface ShapePort {
  /** Where the centerline crosses the cell boundary. */
  p: { x: number; z: number };
  /** Unit tangent along the traversal direction. */
  t: { x: number; z: number };
}

export interface ShapePorts {
  entry: ShapePort;
  exit: ShapePort;
}

/** A world point in cube coords plus the direction the run continues in. */
export interface OpenPort {
  x: number;
  z: number;
  dx: number;
  dz: number;
}

/** One resolved piece of a chained run. */
export interface ChainedPiece {
  assetId: string;
  cell: { x: number; y: number };
  rot: number;
  next: OpenPort;
  turn: number;
}

/** The asset fields the chainer needs. */
export interface ChainAsset {
  id: string;
  shape?: string;
  depth?: number;
}

const EPS = 1e-3;
const S = Math.SQRT1_2;
const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) < eps;

/** Shapes seated at the CELL CENTER; everything else hugs a grid line. */
const CELL_CENTERED: ReadonlySet<string> = new Set<WallShape>([
  "diag",
  "corner",
  "corner_round",
  "filler",
  "diag_fill",
  "bend",
  "bend_mirror",
  "bend_in",
  "bend_in_mirror",
]);

/** `shape` is stamped from the filename suffix; matched LONGEST-FIRST so
 *  `-bendinb` isn't swallowed by `-bend`. */
const SHAPE_BY_SUFFIX: ReadonlyArray<readonly [string, WallShape]> = [
  ["-bendinb", "bend_in_mirror"],
  ["-bendin", "bend_in"],
  ["-bendb", "bend_mirror"],
  ["-bend", "bend"],
  ["-diagfill", "diag_fill"],
  ["-wave2", "wave"],
  ["-wave", "wave"],
  ["-round", "corner_round"],
  ["-diag", "diag"],
  ["-filler", "filler"],
  ["-corner", "corner"],
];

export function wallShapeFromId(id: string): WallShape | undefined {
  return SHAPE_BY_SUFFIX.find(([sfx]) => id.endsWith(sfx))?.[1];
}

/** A doc's own `shape`, falling back to its id suffix. A shapeless bend would
 *  otherwise get a STRAIGHT wall's ports and could never turn. */
export function effectiveShape(asset: ChainAsset): string | undefined {
  return asset.shape ?? wallShapeFromId(asset.id);
}

export function isCellCenteredShape(shape?: string): boolean {
  return !!shape && CELL_CENTERED.has(shape);
}

export function isEdgeHuggingShape(shape?: string): boolean {
  return !isCellCenteredShape(shape);
}

/** Strip a shape suffix to get the family's base id. */
export function wallBaseId(id: string): string {
  for (const [sfx] of SHAPE_BY_SUFFIX) if (id.endsWith(sfx)) return id.slice(0, -sfx.length);
  return id;
}

/** Rotate a cell-local point by a wall yaw. */
function rot2(p: { x: number; z: number }, th: number) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  return { x: p.x * c + p.z * s, z: -p.x * s + p.z * c };
}

/** Degrees → rotation byte (24 steps of 15°). */
function encodeRotDeg(degrees: number, stepDeg = 15): number {
  const stepsPerUnit = stepDeg / 15;
  const byte = Math.round(degrees / stepDeg) * stepsPerUnit;
  return ((byte % 24) + 24) % 24;
}

/**
 * A shape's connection ports, in cell-local cubes. `depth` is the through-wall
 * thickness — an axis port sits depth/2 in from its grid line.
 */
export function wallShapePorts(shape: string | undefined, depth: number): ShapePorts | null {
  const a = depth / 2;
  // The four 45° bends enter on an axis port at the cell's south edge heading north
  // and leave over a cell corner at 45°. `mirror` flips in x; `inward` turns over
  // the corner on the BODY side — the turn a zigzag needs.
  const bend = (mirror: boolean, inward: boolean): ShapePorts => {
    const s = mirror ? -1 : 1;
    const dir = inward ? -s : s;
    return {
      entry: { p: { x: s * (0.5 - a), z: -0.5 }, t: { x: 0, z: 1 } },
      exit: { p: { x: dir * 0.5, z: 0.5 }, t: { x: dir * S, z: S } },
    };
  };

  switch (shape) {
    case undefined:
    case "wave":
      return {
        entry: { p: { x: -0.5, z: 0 }, t: { x: 1, z: 0 } },
        exit: { p: { x: 0.5, z: 0 }, t: { x: 1, z: 0 } },
      };
    case "corner_round":
      return {
        entry: { p: { x: -0.5 + (1 - a), z: 0.5 }, t: { x: 0, z: -1 } },
        exit: { p: { x: -0.5, z: 0.5 - (1 - a) }, t: { x: -1, z: 0 } },
      };
    case "bend":
      return bend(false, false);
    case "bend_mirror":
      return bend(true, false);
    case "bend_in":
      return bend(false, true);
    case "bend_in_mirror":
      return bend(true, true);
    case "diag":
      return {
        entry: { p: { x: -0.5, z: 0.5 }, t: { x: S, z: -S } },
        exit: { p: { x: 0.5, z: -0.5 }, t: { x: S, z: -S } },
      };
    default:
      return null;
  }
}

/**
 * Every legal placement of `asset` whose entry port sits on `port`.
 *
 * Tries the four rotations AND traversal in reverse — a piece is just geometry, so
 * running it backwards is legal, and it's how one rounded corner serves turns both
 * ways. A candidate is rejected unless its cell lands exactly on the grid.
 */
export function placementsAt(asset: ChainAsset, port: OpenPort, depth?: number): ChainedPiece[] {
  const d = depth ?? asset.depth ?? 0.65;
  const shape = effectiveShape(asset);
  const ports = wallShapePorts(shape, d);
  if (!ports) return [];

  const edge = isEdgeHuggingShape(shape);
  const slide = 0.5 - d / 2; // the client's edge-hugging offset
  const traversals = [
    { p0: ports.entry.p, t0: ports.entry.t, p1: ports.exit.p, t1: ports.exit.t },
    {
      p0: ports.exit.p,
      t0: { x: -ports.exit.t.x, z: -ports.exit.t.z },
      p1: ports.entry.p,
      t1: { x: -ports.entry.t.x, z: -ports.entry.t.z },
    },
  ];

  const out: ChainedPiece[] = [];
  for (const tr of traversals) {
    for (let k = 0; k < 4; k++) {
      const th = (k * Math.PI) / 2;
      const t = rot2(tr.t0, th);
      if (!near(t.x, port.dx) || !near(t.z, port.dz)) continue;

      const lp = rot2(tr.p0, th);
      let cx = port.x - lp.x;
      let cz = port.z - lp.z;
      if (edge) {
        cx -= slide * Math.sin(th);
        cz -= slide * Math.cos(th);
      }
      // Cell centers sit at (n + 0.5); anything else can't reach the port legally.
      if (!near(cx - Math.round(cx - 0.5) - 0.5, 0, 1e-6)) continue;
      if (!near(cz - Math.round(cz - 0.5) - 0.5, 0, 1e-6)) continue;

      const exitP = rot2(tr.p1, th);
      const exitT = rot2(tr.t1, th);
      let ox = cx + exitP.x;
      let oz = cz + exitP.z;
      if (edge) {
        ox += slide * Math.sin(th);
        oz += slide * Math.cos(th);
      }

      out.push({
        assetId: asset.id,
        cell: { x: Math.round(cx - 0.5), y: Math.round(cz - 0.5) },
        rot: encodeRotDeg(k * 90, 90),
        next: { x: ox, z: oz, dx: exitT.x, dz: exitT.z },
        turn: Math.sign(Math.round((port.dx * exitT.z - port.dz * exitT.x) * 1e6) / 1e6),
      });
    }
  }
  return out;
}

/** The open port a straight run starts from: depth/2 in from its grid line. */
export function startPort(
  axis: "x" | "z",
  line: number,
  bodySide: 1 | -1,
  along: number,
  forward: 1 | -1,
  depth = 0.65,
): OpenPort {
  const c = line + (bodySide * depth) / 2;
  return axis === "x"
    ? { x: along, z: c, dx: forward, dz: 0 }
    : { x: c, z: along, dx: 0, dz: forward };
}

/** The starting port for a run leaving `cell` along the wall edge named by `rotByte`. */
export function cavePathStartPort(
  cell: { x: number; y: number },
  rotByte: number,
  forward: 1 | -1 = 1,
  depth = 0.65,
): OpenPort {
  const dir = ((Math.round((rotByte * 15) / 90) % 4) + 4) % 4;
  switch (dir) {
    case 0: // north edge
      return startPort("x", cell.y + 1, -1, forward > 0 ? cell.x : cell.x + 1, forward, depth);
    case 1: // east edge
      return startPort("z", cell.x + 1, -1, forward > 0 ? cell.y : cell.y + 1, forward, depth);
    case 2: // south edge
      return startPort("x", cell.y, 1, forward > 0 ? cell.x : cell.x + 1, forward, depth);
    default: // west edge
      return startPort("z", cell.x, 1, forward > 0 ? cell.y : cell.y + 1, forward, depth);
  }
}

export interface CavePathAssets {
  straight?: ChainAsset;
  waves: ChainAsset[];
  bends: ChainAsset[];
  diag?: ChainAsset;
  round?: ChainAsset;
}

/**
 * Sort a wall family's pieces into the roles the fitter needs.
 *
 * Returns null when the family has NO 45° bends — that means it's an ordinary wall
 * set (a room/dungeon family), not a cave piece set, and cave chaining doesn't
 * apply to it. This is the check that keeps the two techniques from being confused.
 */
export function cavePathAssetsFrom(siblings: ChainAsset[]): CavePathAssets | null {
  const shapeOf = (a: ChainAsset) => effectiveShape(a);
  const bends = siblings.filter((a) => {
    const s = shapeOf(a);
    return s === "bend" || s === "bend_mirror" || s === "bend_in" || s === "bend_in_mirror";
  });
  if (!bends.length) return null;

  return {
    straight: siblings.find((a) => !shapeOf(a)),
    waves: siblings.filter((a) => shapeOf(a) === "wave"),
    bends,
    diag: siblings.find((a) => shapeOf(a) === "diag"),
    round: siblings.find((a) => shapeOf(a) === "corner_round"),
  };
}

function snapTo8(vx: number, vz: number): { x: number; z: number } {
  const a = Math.atan2(vz, vx);
  const t = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: round6(Math.cos(t)), z: round6(Math.sin(t)) };
}

function isDiagonalHeading(h: { dx: number; dz: number }): boolean {
  return Math.abs(h.dx) > EPS && Math.abs(h.dz) > EPS;
}

/**
 * Fill in cells a sparse route skipped, stepping 8-WAY.
 *
 * Diagonal steps are first-class: a route given only axis-aligned waypoints can
 * only ever produce axis-aligned walls, which is exactly how a cave ends up looking
 * stair-stepped.
 */
export function densifyRoute(
  route: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  if (route.length < 2) return route.slice();
  const out = [route[0]!];
  for (let i = 1; i < route.length; i++) {
    const target = route[i]!;
    let cur = out[out.length - 1]!;
    for (let guard = 0; guard < 512; guard++) {
      if (cur.x === target.x && cur.y === target.y) break;
      cur = { x: cur.x + Math.sign(target.x - cur.x), y: cur.y + Math.sign(target.y - cur.y) };
      out.push(cur);
    }
  }
  return out;
}

/**
 * Offset a passage CENTRELINE into the two wall lines either side of it.
 *
 * The chainer traces a wall, not a passage — so a caller thinking in passages has
 * to hand-trace two parallel polylines, and any drift between them makes the
 * passage pinch. Given a centreline and a width in cells, this produces both walls
 * at a guaranteed constant separation.
 *
 * The perpendicular is taken from the local direction (averaged across a corner so
 * the offset turns smoothly), and points are rounded to cells with consecutive
 * duplicates dropped.
 */
export function offsetRoute(
  centre: Array<{ x: number; y: number }>,
  width: number,
  side: 1 | -1,
): Array<{ x: number; y: number }> {
  const path = densifyRoute(centre);
  if (path.length < 2) return path.slice();

  const half = width / 2;
  const out: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)]!;
    const next = path[Math.min(path.length - 1, i + 1)]!;
    // Direction across the joint, so a corner's offset bisects rather than jumping.
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    const p = path[i]!;
    const cell = {
      x: Math.round(p.x + -dy * half * side),
      y: Math.round(p.y + dx * half * side),
    };
    const last = out[out.length - 1];
    if (!last || last.x !== cell.x || last.y !== cell.y) out.push(cell);
  }
  return out;
}

/**
 * Turn a route into a chain of connected pieces.
 *
 * Holds an open port and, for each cell, picks by the angle between the port's
 * heading and the direction to that cell: carrying on takes the diagonal (on a 45°
 * run) or the straight wall; a square turn prefers the rounded corner; anything
 * shallower takes a 45° bend, and two bends make a 90 when the corner won't fit.
 *
 * `waveEvery` sprinkles wave variants through straight runs so a passage isn't
 * ruler-straight — 0 disables it.
 */
export function fitCavePath(
  route: Array<{ x: number; y: number }>,
  assets: CavePathAssets,
  start: OpenPort,
  waveEvery = 3,
): ChainedPiece[] {
  const out: ChainedPiece[] = [];
  const cells = densifyRoute(route);
  let port = start;
  let straightCount = 0;

  const place = (candidates: Array<ChainAsset | undefined>, turn?: number) => {
    for (const asset of candidates) {
      if (!asset) continue;
      const fits = placementsAt(asset, port);
      const match = turn ? fits.find((f) => f.turn === turn) : fits[0];
      if (match) {
        out.push(match);
        port = match.next;
        return true;
      }
    }
    return false;
  };

  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i]!;
    const target = { x: cell.x + 0.5, z: cell.y + 0.5 };
    let best = Math.hypot(target.x - port.x, target.z - port.z);

    // A route step is at most a couple of pieces away; the cap guards a pathological route.
    for (let guard = 0; guard < 6; guard++) {
      const vx = target.x - port.x;
      const vz = target.z - port.z;
      if (Math.hypot(vx, vz) < 0.75) break; // reached this cell
      const want = snapTo8(vx, vz);
      const dot = port.dx * want.x + port.dz * want.z;
      const cross = port.dx * want.z - port.dz * want.x;
      let placed = false;

      if (dot > 0.9) {
        straightCount++;
        const wave =
          waveEvery > 0 && assets.waves.length && straightCount % waveEvery === 0
            ? assets.waves[(straightCount / waveEvery - 1) % assets.waves.length]
            : undefined;
        placed = isDiagonalHeading({ dx: port.dx, dz: port.dz })
          ? place([assets.diag, assets.straight])
          : place([wave, assets.straight]);
      } else if (Math.abs(cross) > EPS && dot > -0.9) {
        const square = Math.abs(dot) < 0.4;
        straightCount = 0;
        placed = place(
          square ? [assets.round, ...assets.bends] : [...assets.bends, assets.round],
          Math.sign(cross),
        );
      }

      if (!placed) break; // nothing connects here; stop rather than guess
      const dist = Math.hypot(target.x - port.x, target.z - port.z);
      if (dist >= best - 1e-6) break; // no progress — don't spin
      best = dist;
    }
  }
  return out;
}
