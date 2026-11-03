/**
 * Shared interchange parts: road type choices, carriageways, and ramps that leave
 * and join a mainline the way core's junction trimming needs them to.
 */
import { Blueprint, Road, type Pose3 } from './blueprint';
import { Path, Profile, VERTICAL_BLEND, deg, fitCsc, poseAdvance, type TurnSign } from './path';
import { builtinRoadType, totalHalfWidth, type SegmentOverrides } from '../core';

export type Params = Record<string, number>;

export interface BuildContext {
  p: Params;
  /** Road type asked for by the placement, if any. */
  roadType?: string;
}

/** Vertical gap between levels. Core wants 6 m; a metre spare absorbs vertical curves. */
export const LEVEL = 7;
/** Design grade for mainlines and cross roads. */
export const MAIN_GRADE = 0.05;
/** Length past the last junction, so the node can sit clear of the gateway. */
export const STUB = 160;
/** A ramp stays straight and flat this far from a mainline, past the longest trim. */
export const RAMP_RUN = 90;
/** Station of a ramp's first height knot, so the vertical curve starts past the run. */
export const RAMP_FLAT = RAMP_RUN + VERTICAL_BLEND;
/** Distance within which a ramp must clear the mainline, so the trim stays under core's cap. */
const CLEAR_WITHIN = 64;
const GAP = 1;
/** A ramp arc turning further than this means the shape does not really fit. */
const MAX_SWEEP = deg(200);
/** Speed through a loop, set from a comfortable side friction. */
export const loopSpeed = (radius: number): number => Math.round(Math.min(60, Math.sqrt(127 * 0.22 * radius)));

/** A one-way mainline with the given lanes, or the type the placement asks for. */
export function mainType(ctx: BuildContext, lanes: number): string {
  const asked = ctx.roadType ? builtinRoadType(ctx.roadType) : undefined;
  if (asked) {
    if (asked.lanes.every((l) => l.dir === 1) && asked.category === 'highway') return asked.id;
    // A dual carriageway becomes its two one-way halves through an interchange.
    const m = /^dual-(\d+)$/.exec(asked.id);
    if (m) return `highway-${Number(m[1]) / 2}`;
  }
  return `highway-${lanes}`;
}

/** The placement's road type if it is a two-way road, else the fallback. */
export function twoWayType(ctx: BuildContext, fallback: string): string {
  const asked = ctx.roadType ? builtinRoadType(ctx.roadType) : undefined;
  return asked && asked.lanes.some((l) => l.dir === -1) ? asked.id : fallback;
}

/** A two-way cross road by total lanes. */
export function crossType(lanes: number): string {
  if (lanes <= 2) return 'street-2';
  if (lanes <= 4) return 'avenue-4';
  return 'avenue-6';
}

export const rampType = (lanes: number): string => `ramp-${lanes >= 2 ? 2 : 1}`;

export function halfWidth(bp: Blueprint, type: string): number {
  return totalHalfWidth(bp.typeDef(type));
}

/** Half the spacing of two carriageways: a road either side of a small median. */
export function carriagewayOffset(bp: Blueprint, type: string): number {
  return halfWidth(bp, type) + 2;
}

/** The angle a ramp must leave a mainline at to clear it within the trim cap. */
export function clearAngle(bp: Blueprint, main: string, ramp: string): number {
  const clear = halfWidth(bp, main) + halfWidth(bp, ramp) + GAP;
  return Math.max(deg(8), Math.asin(Math.min(0.5, clear / CLEAR_WITHIN)));
}

export interface Carriageways {
  eb: Road;
  wb: Road;
}

export interface CrossCarriageways {
  sb: Road;
  nb: Road;
}

/** Two one-way roads along x, centred on the origin. Eastbound runs on the +z side. */
export function eastWest(bp: Blueprint, type: string, m: number, half: number, profile: (len: number) => Profile): Carriageways {
  const len = half * 2;
  const eb = bp.road({
    name: 'Eastbound',
    path: new Path({ x: -half, z: m, h: 0 }).line(len),
    profile: profile(len),
    type,
  });
  const wb = bp.road({
    name: 'Westbound',
    path: new Path({ x: half, z: -m, h: Math.PI }).line(len),
    profile: profile(len),
    type,
  });
  bp.port('W.in', eb, 'start', 'in');
  bp.port('E.out', eb, 'end', 'out');
  bp.port('E.in', wb, 'start', 'in');
  bp.port('W.out', wb, 'end', 'out');
  return { eb, wb };
}

/** Two one-way roads along z, centred on the origin. Southbound runs on the -x side. */
export function northSouth(bp: Blueprint, type: string, m: number, half: number, profile: (len: number) => Profile): CrossCarriageways {
  const len = half * 2;
  const sb = bp.road({
    name: 'Southbound',
    path: new Path({ x: -m, z: -half, h: Math.PI / 2 }).line(len),
    profile: profile(len),
    type,
  });
  const nb = bp.road({
    name: 'Northbound',
    path: new Path({ x: m, z: half, h: -Math.PI / 2 }).line(len),
    profile: profile(len),
    type,
  });
  bp.port('N.in', sb, 'start', 'in');
  bp.port('S.out', sb, 'end', 'out');
  bp.port('S.in', nb, 'start', 'in');
  bp.port('N.out', nb, 'end', 'out');
  return { sb, nb };
}

/** A road flat at `level` through the middle and down to 0 at both stub ends. */
export function hump(level: number, flatHalf: number): (len: number) => Profile {
  return (len) => {
    const mid = len / 2;
    if (level === 0) return Profile.flat(0);
    const run = Math.abs(level) / MAIN_GRADE;
    return new Profile([
      [0, 0],
      [mid - flatHalf - run, 0],
      [mid - flatHalf, level],
      [mid + flatHalf, level],
      [mid + flatHalf + run, 0],
      [len, 0],
    ], 40);
  };
}

/** Half length of a road that is flat at `level` for flatHalf, then down, then a stub. */
export function humpHalf(level: number, flatHalf: number): number {
  return flatHalf + Math.abs(level) / MAIN_GRADE + STUB;
}

export interface RampShape {
  from: Pose3;
  to: Pose3;
  /** Heading added at the start, right positive. Leave 0 for a square start. */
  exitAngle?: number;
  /** Heading taken off at the end, so the ramp arrives from the right of the road it joins. */
  mergeAngle?: number;
  exitRun?: number;
  mergeRun?: number;
  r1: number;
  r2?: number;
  /** Fixed turn directions. Omit to take the shortest that fits. */
  turns?: [TurnSign, TurnSign];
}

/** Plan of a ramp: straight off the road, curve-line-curve, straight on to the next. */
export function rampPath(shape: RampShape): Path {
  const { from, to, r1 } = shape;
  const r2 = shape.r2 ?? r1;
  const exitRun = shape.exitRun ?? RAMP_RUN;
  const mergeRun = shape.mergeRun ?? RAMP_RUN;
  const start = { x: from.x, z: from.z, h: from.h + (shape.exitAngle ?? 0) };
  const finish = { x: to.x, z: to.z, h: to.h - (shape.mergeAngle ?? 0) };
  const path = new Path(start).line(exitRun);
  const tail = poseAdvance(finish, -mergeRun);
  let turns = shape.turns;
  if (!turns) {
    let best = Infinity;
    for (const s1 of [1, -1] as const) {
      for (const s2 of [1, -1] as const) {
        const fit = fitCsc(path.end, tail, r1, s1, r2, s2);
        if (!fit || fit.sweep1 > MAX_SWEEP || fit.sweep2 > MAX_SWEEP) continue;
        const len = fit.sweep1 * r1 + fit.line + fit.sweep2 * r2;
        if (len < best) {
          best = len;
          turns = [s1, s2];
        }
      }
    }
    if (!turns) throw new RangeError('No ramp fits between these poses');
  }
  const fit = fitCsc(path.end, tail, r1, turns[0], r2, turns[1]);
  if (!fit || fit.sweep1 > MAX_SWEEP || fit.sweep2 > MAX_SWEEP) throw new RangeError('Ramp would have to circle to fit');
  path.curveTo(tail, r1, turns[0], r2, turns[1]);
  return path.line(mergeRun);
}

/** A straight grade between two levels, flat for `flatA` and `flatB` at the ends. */
export function rampProfile(len: number, y0: number, y1: number, flatA = RAMP_RUN, flatB = RAMP_RUN): Profile {
  return new Profile([
    [0, y0],
    [flatA + VERTICAL_BLEND, y0],
    [len - flatB - VERTICAL_BLEND, y1],
    [len, y1],
  ]);
}

export function addRamp(
  bp: Blueprint,
  name: string,
  type: string,
  shape: RampShape,
  profile?: (path: Path) => Profile,
  overrides?: SegmentOverrides,
): Road {
  const path = rampPath(shape);
  return bp.road({
    name,
    path,
    profile:
      profile?.(path) ??
      rampProfile(path.length, shape.from.y, shape.to.y, shape.exitRun ?? RAMP_RUN, shape.mergeRun ?? RAMP_RUN),
    type,
    overrides,
  });
}

export interface LoopFit {
  /** Distance from the crossing of the two roads to each end of the loop. */
  t: number;
  theta: number;
  run: number;
}

/**
 * Size a 270 degree right-hand loop tucked into the corner of two crossing roads.
 * The loop is mirror symmetric about the corner's diagonal, so half of it decides
 * everything: leave at theta, run straight, then the circle up to the diagonal.
 * Theta grows until the loop starts far enough past the crossing and its circle
 * clears the road it comes back alongside.
 */
export function fitLoop(radius: number, clear: number, leaveClear: number, minT: number, minTheta: number): LoopFit {
  for (let degrees = Math.ceil((minTheta * 180) / Math.PI); degrees <= 40; degrees++) {
    const theta = deg(degrees);
    // Long enough that the junction trim stays on the first straight.
    const run = Math.max(58, (leaveClear + 14) / Math.sin(theta), (clear + 14) / Math.sin(theta));
    const half = new Path({ x: 0, z: 0, h: theta }).line(run).right(radius, deg(135) - theta);
    const e = half.end;
    const t = e.z - e.x;
    const inner = e.z - radius * (1 + Math.SQRT1_2);
    if (t >= minT && inner >= clear) return { t, theta, run };
  }
  throw new RangeError('No loop fits this radius and road width');
}

/** A loop from `inRoad` round to `outRoad`, which it joins on the right. */
export function addLoop(bp: Blueprint, name: string, type: string, inRoad: Road, outRoad: Road, radius: number, minT = 34): { road: Road; fit: LoopFit } {
  const clear = halfWidth(bp, outRoad.type) + halfWidth(bp, type) + 3;
  const leaveClear = halfWidth(bp, inRoad.type) + halfWidth(bp, type) + 3;
  const fit = fitLoop(radius, clear, leaveClear, minT, Math.max(deg(16), clearAngle(bp, inRoad.type, type)));
  const cross = inRoad.path.crossings(outRoad.path)[0];
  if (!cross) throw new Error(`${name}: the roads do not cross`);
  const from = inRoad.at(cross.s + fit.t);
  const to = outRoad.at(cross.otherS - fit.t);
  const path = new Path({ x: from.x, z: from.z, h: from.h + fit.theta })
    .line(fit.run)
    .right(radius, deg(270) - 2 * fit.theta)
    .line(fit.run);
  const road = bp.road({
    name,
    path,
    profile: rampProfile(path.length, from.y, to.y, fit.run, fit.run),
    type,
    overrides: { speedKmh: loopSpeed(radius) },
  });
  return { road, fit };
}

/** Smallest plan distance between two paths. */
export function pathGap(a: Path, b: Path, step = 6): number {
  let best = Infinity;
  const n = Math.ceil(a.length / step);
  const m = Math.ceil(b.length / step);
  for (let i = 0; i <= n; i++) {
    const p = a.poseAt((i / n) * a.length);
    for (let j = 0; j <= m; j++) {
      const q = b.poseAt((j / m) * b.length);
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * A right-turn ramp from one road to the road it crosses, going round whatever is
 * in the corner. `d` is measured from the crossing back along inRoad and forward
 * along outRoad.
 */
export function addRightTurn(bp: Blueprint, name: string, type: string, inRoad: Road, outRoad: Road, d: number, radius: number): Road {
  const cross = inRoad.path.crossings(outRoad.path)[0];
  if (!cross) throw new Error(`${name}: the roads do not cross`);
  const from = inRoad.at(cross.s - d);
  const to = outRoad.at(cross.otherS + d);
  return addRamp(bp, name, type, {
    from,
    to,
    exitAngle: clearAngle(bp, inRoad.type, type),
    mergeAngle: clearAngle(bp, outRoad.type, type),
    r1: radius,
    turns: [1, 1],
  });
}

/** Smallest `d` for which a right-turn ramp stays `gap` clear of every given path. */
export function rightTurnReach(
  bp: Blueprint,
  type: string,
  inRoad: Road,
  outRoad: Road,
  radius: number,
  minD: number,
  avoid: readonly Path[],
  gap: number,
): number {
  const cross = inRoad.path.crossings(outRoad.path)[0];
  for (let d = minD; d < minD + 900; d += 10) {
    let path: Path;
    try {
      path = rampPath({
        from: inRoad.at(cross.s - d),
        to: outRoad.at(cross.otherS + d),
        exitAngle: clearAngle(bp, inRoad.type, type),
        mergeAngle: clearAngle(bp, outRoad.type, type),
        r1: radius,
        turns: [1, 1],
      });
    } catch {
      continue; // Not enough room for this radius yet.
    }
    if (avoid.every((a) => pathGap(path, a) >= gap)) return d;
  }
  throw new RangeError('No right-turn ramp clears the corner');
}
