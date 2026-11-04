/**
 * Automatic road paint, driven entirely by effectiveMarkings, drawn through the
 * shared paint pipeline (paint.ts) with the measures of core/paintStandard.ts, so
 * it is the same paint the player places by hand. Lines are ribbons along the
 * stations; stop lines, crosswalks, arrows and yield teeth sit at lane ends.
 * Where a hand-placed marking holds the same place, the automatic one is left
 * off there (core/paintCoherence.ts).
 */
import type { CrosswalkStyle, Id, LaneDef, TurnKind, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { effectiveLanes, effectiveMarkings } from '../core/roadTypes';
import { effectiveControl } from '../core/signals';
import { PaintBuf, type LinePoint } from './batch';
import { paintLaneSymbols } from './laneSymbols';
import { isAutoOff } from '../core/autoMarkings';
import { isRampJunction, overlapClip } from './gore';
import { terrainHeight } from '../core/terrain';
import { PAINT_COL, ROAD_LIFT, hexRGB, strokesOf, type RGB } from './constants';
import { EXIT_ONLY, ARROW, CROSSWALK, GUIDE_DASH, LINE_W, STOP, TEETH, arrowShape, autoLineSpec, boundaryLines as coreBoundaryLines, crosswalkSpec, fitDashes, lineStandard, type BoundaryLine } from '../core/paintStandard';
import { coveredStretches, roadSpeed, snapToAutoLine, subtractIntervals, userArmMarks, userRoadLines, userRoadStamps } from '../core/paintCoherence';
import { framesOf as framesOfNode } from '../core/nodeMarkings';
import { resolvedStyle } from '../core/markingStyle';
import { segmentKerbShift } from '../core/junctionShape';
import { StationPath, paintCrossing, paintRoadLine, paintSpecAlong, placeStamp, type DashPhase } from './paint';

export { StationPath, placeStamp, arrowShape, fitDashes };
export type { BoundaryLine };

export const CROSSWALK_DEPTH = CROSSWALK.depth;
export const CROSSWALK_GAP = CROSSWALK.setback;
export const STOP_WIDTH = STOP.width;
const STOP_GAP = STOP.beforeCrosswalk;
const ARROW_BACK = ARROW.back;

function rect(a0: number, b0: number, a1: number, b1: number): number[] {
  return [a0, b0, a1, b0, a1, b1, a0, b0, a1, b1, a0, b1];
}

/** An automatic crosswalk: the standard crosswalk look of its style, through the shared painter. */
export function paintCrosswalk(buf: PaintBuf, a: Vec3, b: Vec3, depth: number, style: CrosswalkStyle): void {
  const spec = crosswalkSpec(style);
  if (!spec) return;
  paintCrossing(buf, a, b, { ...spec, width: depth });
}

/** A row of give-way teeth from a to b, tips pointing along (pointX, pointZ). */
export function paintTeeth(buf: PaintBuf, a: Vec3, b: Vec3, pointX: number, pointZ: number): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // Right of a-to-b is (-dz, dx); tips go to whichever side faces the driver.
  const tipSide = -dz * pointX + dx * pointZ >= 0 ? 1 : -1;
  paintSpecAlong(buf, [a, b], lineStandard('giveWay').spec, tipSide);
}

// ---------------------------------------------------------------------------
// Segment paint
// ---------------------------------------------------------------------------

interface EndPlan {
  /** Arm is at a junction with paint at this end. */
  junction: boolean;
  crosswalk: CrosswalkStyle;
  /** Arc length from the cut line to where lane lines stop. The same on every arm of a junction. */
  setback: number;
  node: Id;
  sign: string;
  controlled: boolean;
  stopLine: boolean;
}

export const TEETH_DEPTH = TEETH.length;

interface ArmControl {
  crosswalk: CrosswalkStyle;
  sign: string;
  controlled: boolean;
  /** Depth of the bar or teeth this arm paints, 0 for none. */
  bar: number;
  /** Paints a stop line: a controlled approach that does not have priority. */
  stopLine: boolean;
}

function armControl(net: RoadNetwork, segId: Id, nodeId: Id): ArmControl | null {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  const seg = net.getSegment(segId);
  if (!g || !node || !seg || g.kind !== 'junction' || g.arms.length < 3) return null;
  // Hidden automatic paint leaves the turn arrows, which belong to the lanes.
  if (node.control.hideAutoMarkings) return { crosswalk: 'none', sign: 'none', controlled: false, bar: 0, stopLine: false };
  // Highway merges and diverges flow freely: no crossings, stop lines or teeth (gore.ts).
  if (isRampJunction(net, nodeId)) return { crosswalk: 'none', sign: 'none', controlled: false, bar: 0, stopLine: false };
  const m = effectiveMarkings(net.roadTypeOf(segId), seg.overrides);
  const crosswalk = node.control.crosswalks[segId] ?? m.crosswalk;
  const ctl = effectiveControl(net, nodeId);
  const sign = ctl.signs[segId] ?? 'none';
  const controlled = ctl.kind !== 'none';
  // A road's `stopLines` is off by default on fast roads, which seldom meet a junction; where
  // one stops at lights or a stop sign (a highway crossing at grade) it still gets its line.
  const stopLine = controlled && sign !== 'yield' && sign !== 'priority' && (m.stopLines || ctl.kind === 'signal' || sign === 'stop');
  const bar = !controlled ? 0 : sign === 'yield' ? TEETH_DEPTH : stopLine ? STOP_WIDTH : 0;
  return { crosswalk, sign, controlled, bar, stopLine };
}

/**
 * How far back from the cut line every arm of a junction stops its lane lines.
 * One value per junction, so stop lines and crosswalks line up across all arms.
 */
export function junctionSetback(net: RoadNetwork, nodeId: Id): number {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction' || g.arms.length < 3) return 0;
  let crosswalk = false;
  let bar = 0;
  for (const arm of g.arms) {
    const c = armControl(net, arm.segmentId, nodeId);
    if (!c) continue;
    if (c.crosswalk !== 'none') crosswalk = true;
    bar = Math.max(bar, c.bar);
  }
  if (!crosswalk && bar === 0) return 0;
  return (crosswalk ? CROSSWALK_GAP + CROSSWALK_DEPTH + STOP_GAP : 0.5) + bar;
}

/**
 * How far back from the cut line a raised median's nose stands at a junction: just
 * behind the crosswalk and stop line (render/roads.ts builds it here, and the median
 * edge lines turn round it).
 */
export function medianNoseBack(net: RoadNetwork, nodeId: Id): number {
  return Math.max(2.4, junctionSetback(net, nodeId) + 0.5);
}

function planEnd(net: RoadNetwork, segId: Id, nodeId: Id): EndPlan {
  const c = armControl(net, segId, nodeId);
  if (!c) return { junction: false, crosswalk: 'none', setback: 0, node: nodeId, sign: 'none', controlled: false, stopLine: false };
  return { junction: true, crosswalk: c.crosswalk, setback: junctionSetback(net, nodeId), node: nodeId, sign: c.sign, controlled: c.controlled, stopLine: c.stopLine };
}

/** A raised median's nose at a junction end, in arc length along the road. */
interface MedianNose {
  /** The tip, nearest the junction. */
  tipS: number;
  /** Where the median reaches its full width; the edge lines beside it end here and turn round. */
  fullS: number;
  /** Centre of the median from the centreline, and its half width. */
  centre: number;
  halfWidth: number;
}

function medianNose(net: RoadNetwork, segId: Id, path: StationPath, end: -1 | 1): MedianNose | null {
  const seg = net.getSegment(segId);
  if (!seg) return null;
  const def = net.roadTypeOf(segId);
  const md = def.median;
  if (md.width <= 0 || (md.kind !== 'grass' && md.kind !== 'barrier')) return null;
  const nodeId = end > 0 ? seg.b : seg.a;
  if (!planEnd(net, segId, nodeId).junction) return null;
  const cutS = end > 0 ? path.s1 : path.s0;
  const back = medianNoseBack(net, nodeId);
  // The nose rounds over this length (render/roads.ts `median`).
  const along = Math.max(md.width / 2, 0.6);
  if (path.s1 - path.s0 < 2 * (back + along)) return null;
  return { tipS: cutS - end * back, fullS: cutS - end * (back + along), centre: md.offset ?? 0, halfWidth: md.width / 2 };
}

/** An edge line beside a raised median (boundaryLines keys `b{i}L` / `b{i}R`). */
function isMedianEdge(l: BoundaryLine): boolean {
  return l.role === 'edge' && /^b\d+[LR]$/.test(l.key);
}

/**
 * The return of a median edge line round the nose: from where the line ends, a
 * quarter ellipse just outside the nose's kerb to its tip. Unlifted road points.
 */
function noseReturn(path: StationPath, nose: MedianNose, offset: number, end: -1 | 1): Vec3[] {
  const lat = offset - nose.centre;
  const gap = Math.max(0, Math.abs(lat) - nose.halfWidth);
  const reach = Math.abs(nose.tipS - nose.fullS) + gap;
  const out: Vec3[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (Math.PI / 2);
    const p = path.at(nose.fullS + end * reach * Math.sin(t), nose.centre + lat * Math.cos(t));
    out.push({ x: p.x, y: p.y - ROAD_LIFT, z: p.z });
  }
  return out;
}

/** Every painted line along a road, as offsets from the centreline (core/paintStandard.ts). */
export function boundaryLines(...args: Parameters<typeof coreBoundaryLines>): BoundaryLine[] {
  return coreBoundaryLines(...args);
}

/** Where automatic lines along a road start and end: inside the setbacks of junctions at its ends. */
function lineSpan(net: RoadNetwork, id: Id, path: StationPath): { s0: number; s1: number } {
  const seg = net.getSegment(id)!;
  return { s0: path.s0 + planEnd(net, id, seg.a).setback, s1: path.s1 - planEnd(net, id, seg.b).setback };
}

/**
 * The dash phase of a road: its automatic lines' run. Every dashed line along the
 * road, automatic or hand-placed, is dashed from here, so they meet dash for dash.
 */
export function segmentDashPhase(net: RoadNetwork, id: Id): DashPhase | null {
  const geom = net.segmentGeom(id);
  if (!net.getSegment(id) || !geom || geom.stations.length < 2) return null;
  const { s0, s1 } = lineSpan(net, id, new StationPath(geom.stations));
  return { origin: s0, run: Math.max(0, s1 - s0) };
}

/** The colour of an automatic line. */
function lineRGB(l: BoundaryLine) {
  return l.hex ? hexRGB(parseInt(l.hex.slice(1), 16)) : PAINT_COL[l.color];
}

/**
 * Draw automatic lines between s0 and s1, leaving off what a ramp junction's other
 * road covers (`clip`), what the player took away, and what hand-placed lines hold.
 */
function drawLines(
  buf: PaintBuf,
  path: StationPath,
  lines: readonly BoundaryLine[],
  s0: number,
  s1: number,
  phase: DashPhase,
  speedKmh: number,
  clip?: ((offset: number, s0: number, s1: number) => [number, number]) | null,
  held: (offset: number) => [number, number][] = () => [],
): void {
  for (const l of lines) {
    const spec = autoLineSpec(l.style, l.color, l.width, speedKmh);
    if (!spec) continue;
    // Near a ramp junction a line may lie on another road; that stretch is left off.
    const [a, b] = clip ? clip(l.offset, s0, s1) : [s0, s1];
    if (b - a <= 0.05) continue;
    for (const [p, q] of subtractIntervals(a, b, held(l.offset))) paintRoadLine(buf, path, p, q, l.offset, spec, phase, lineRGB(l));
  }
}

function turnsOfLane(net: RoadNetwork, segId: Id, laneIndex: number): Set<TurnKind> | null {
  const graph = net.laneGraph;
  const idx = graph.roadLanes.get(segId)?.[laneIndex];
  if (idx === undefined || idx < 0) return null;
  const lane = graph.lanes[idx];
  const out = new Set<TurnKind>();
  for (const nx of lane.next) {
    const t = graph.lanes[nx]?.turn;
    if (t) out.add(t);
  }
  return out.size ? out : null;
}

export interface ArmEndLayout {
  /** Arc length of the cut line, where the road meets the junction surface. */
  cutS: number;
  setback: number;
  /** Where every lane line stops, at the setback. */
  lineEnds: Vec3[];
  /** Stop bar or teeth base, from the centre line or median edge to the kerb. */
  stop: { a: Vec3; b: Vec3; kind: 'bar' | 'teeth'; s: number; lo: number; hi: number } | null;
  /** Lateral stretches of the stop line that hand-placed stop lines hold. */
  stopCuts: [number, number][];
  crosswalk: { a: Vec3; b: Vec3; style: CrosswalkStyle } | null;
  /** Where turn arrows go, one per approaching lane. */
  arrows: { pos: Vec3; laneIndex: number }[];
}

/** Paint positions at one end of a segment. end -1 is a, +1 is b. Null away from junctions. */
export function armEndLayout(net: RoadNetwork, segId: Id, end: -1 | 1): ArmEndLayout | null {
  const seg = net.getSegment(segId);
  const geom = net.segmentGeom(segId);
  if (!seg || !geom || geom.stations.length < 2) return null;
  const plan = planEnd(net, segId, end > 0 ? seg.b : seg.a);
  if (!plan.junction) return null;
  const def = net.roadTypeOf(segId);
  const m = effectiveMarkings(def, seg.overrides);
  const lanes = effectiveLanes(def, seg.overrides);
  const path = new StationPath(geom.stations);
  const oneWay = lanes.every((l) => l.dir === 1);
  const cutS = end > 0 ? path.s1 : path.s0;
  const inward = -end;
  const at = (s: number, o: number): Vec3 => {
    const p = path.at(s, o);
    return { x: p.x, y: p.y, z: p.z };
  };
  const lineS = cutS + inward * plan.setback;
  const lines = boundaryLines(lanes, m, oneWay, def.median.kind, def.median.width, def.median.offset ?? 0, 0, roadSpeed(net, segId));
  // Edge lines beside a median nose turn round it instead (medianNose); every other line ends here.
  const nose = medianNose(net, segId, path, end);
  const lineEnds: Vec3[] = [];
  for (const l of lines) if (!(nose && isMedianEdge(l))) for (const k of strokesOf(l.style)) lineEnds.push(at(lineS, l.offset + k.shift));

  let crosswalk: ArmEndLayout['crosswalk'] = null;
  if (plan.crosswalk !== 'none') {
    const centre = cutS + inward * (CROSSWALK_GAP + CROSSWALK_DEPTH / 2);
    // Kerb to kerb, where a shaped junction moved the kerb at this end too.
    const shift = segmentKerbShift(net, segId);
    const left = def.halfWidth - (shift ? shift(-1, centre) : 0);
    const right = def.halfWidth - (shift ? shift(1, centre) : 0);
    crosswalk = { a: at(centre, -left), b: at(centre, right), style: plan.crosswalk };
  }

  const incoming = lanes.map((l, i) => ({ l, i })).filter(({ l }) => l.dir === end);
  let stop: ArmEndLayout['stop'] = null;
  if (incoming.length && plan.controlled) {
    const lo = Math.min(...incoming.map(({ l }) => l.offset - l.width / 2));
    const hi = Math.max(...incoming.map(({ l }) => l.offset + l.width / 2));
    const opposing = lanes.filter((l) => l.dir !== end);
    // From the centre line (or median edge) on the inside to the kerb on the outside.
    let inner: number;
    let outer: number;
    if (!opposing.length) {
      inner = -def.halfWidth;
      outer = def.halfWidth;
    } else if (end > 0) {
      const oppHi = Math.max(...opposing.map((l) => l.offset + l.width / 2));
      const gapIsMedian = lo - oppHi > 0.4;
      inner = gapIsMedian ? lo : (lo + oppHi) / 2;
      outer = def.halfWidth;
    } else {
      const oppLo = Math.min(...opposing.map((l) => l.offset - l.width / 2));
      const gapIsMedian = oppLo - hi > 0.4;
      inner = gapIsMedian ? hi : (hi + oppLo) / 2;
      outer = -def.halfWidth;
    }
    const a = Math.min(inner, outer);
    const b = Math.max(inner, outer);
    if (plan.sign === 'yield') {
      const base = cutS + inward * (plan.setback - TEETH_DEPTH);
      stop = { a: at(base, a), b: at(base, b), kind: 'teeth', s: base, lo: a, hi: b };
    } else if (plan.stopLine) {
      const centre = cutS + inward * (plan.setback - STOP_WIDTH / 2);
      stop = { a: at(centre, a), b: at(centre, b), kind: 'bar', s: centre, lo: a, hi: b };
    }
  }
  const arrows: ArmEndLayout['arrows'] = [];
  if (m.turnArrows && path.s1 - path.s0 > 22 && !isRampJunction(net, plan.node)) {
    const arrowS = lineS + inward * ARROW_BACK;
    for (const { l, i } of incoming) if (l.kind !== 'bike') arrows.push({ pos: at(arrowS, l.offset), laneIndex: i });
  }
  // Single automatic markings the user took away (core/autoMarkings.ts).
  const ctl = net.getNode(plan.node)?.control;
  if (ctl?.autoOff) {
    if (stop && isAutoOff(ctl, { kind: 'stop', segmentId: segId })) stop = null;
    const kept = arrows.filter((a) => !isAutoOff(ctl, { kind: 'arrow', segmentId: segId, lane: a.laneIndex }));
    arrows.length = 0;
    arrows.push(...kept);
  }
  // Where a hand-placed marking holds the place, the automatic one is left off.
  const held = userArmMarks(net, plan.node, segId);
  const stamps = userRoadStamps(net, segId);
  if (crosswalk) {
    const cs = cutS + inward * (CROSSWALK_GAP + CROSSWALK_DEPTH / 2);
    if (held.crossing || stamps.some((st) => st.kind === 'crossing' && Math.abs(st.s - cs) < (st.depth + CROSSWALK_DEPTH) / 2 + 0.5)) crosswalk = null;
  }
  const stopCuts: [number, number][] = [];
  if (stop && held.stop) stop = null;
  if (stop) {
    const at0 = stop;
    for (const st of stamps) if (st.kind === 'stop' && Math.abs(st.s - at0.s) < 1.5) stopCuts.push([st.lo, st.hi]);
    if (stopCuts.length && !subtractIntervals(stop.lo, stop.hi, stopCuts).length) stop = null;
  }
  if (arrows.length) {
    const arrowS = lineS + inward * ARROW_BACK;
    const kept = arrows.filter((a) => {
      const off = lanes[a.laneIndex].offset;
      return !stamps.some((st) => st.kind === 'arrow' && st.dir === end && Math.abs(st.lo - off) < 1 && Math.abs(st.s - arrowS) < 10);
    });
    arrows.length = 0;
    arrows.push(...kept);
  }
  return { cutS, setback: plan.setback, lineEnds, stop, stopCuts, crosswalk, arrows };
}

/** Paint at one end. */
function drawEnd(buf: PaintBuf, net: RoadNetwork, segId: Id, path: StationPath, end: -1 | 1, layout = armEndLayout(net, segId, end)): void {
  if (!layout) return;
  const white = PAINT_COL.white;
  // Layout points are lifted onto the road; the shared painters lift by themselves.
  const unlift = (p: Vec3): Vec3 => ({ x: p.x, y: p.y - ROAD_LIFT, z: p.z });
  if (layout.crosswalk) paintCrosswalk(buf, unlift(layout.crosswalk.a), unlift(layout.crosswalk.b), CROSSWALK_DEPTH, layout.crosswalk.style);
  if (layout.stop) {
    const stop = layout.stop;
    // Lift off: paint.ts lifts road points itself.
    const pt = (o: number): Vec3 => {
      const p = path.at(stop.s, o);
      return { x: p.x, y: p.y - ROAD_LIFT, z: p.z };
    };
    for (const [lo, hi] of subtractIntervals(stop.lo, stop.hi, layout.stopCuts)) {
      if (stop.kind === 'teeth') {
        // Travel direction from the right vector: t = (r.z, -r.x). Teeth point at the driver.
        const p = path.at(layout.cutS, 0);
        paintTeeth(buf, pt(lo), pt(hi), -p.rz * end, p.rx * end);
      } else {
        paintCrossing(buf, pt(lo), pt(hi), lineStandard('stop').spec);
      }
    }
  }
  buf.inLayer('symbol', () => {
    for (const arrow of layout.arrows) {
      const turns = turnsOfLane(net, segId, arrow.laneIndex);
      if (!turns) continue;
      // Every arrow on an approach shares one station, so they line up across the lanes.
      const p = path.at(layout.cutS + -end * (layout.setback + ARROW_BACK), 0);
      const fx = p.rz * end;
      const fz = -p.rx * end;
      const shape = arrowShape(turns.has('left'), turns.has('straight'), turns.has('right'), turns.has('uturn'));
      buf.stamp(placeStamp(shape, arrow.pos.x, arrow.pos.z, fx, fz, ARROW.scale), arrow.pos.y, white);
    }
  });
}

// ---------------------------------------------------------------------------
// Guide lines through a junction
// ---------------------------------------------------------------------------

interface Track {
  pts: { x: number; y: number; z: number }[];
}

function connectorTrack(pts: Float32Array): Track {
  const out: Track['pts'] = [];
  for (let i = 0; i < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
  return { pts: out };
}

/** Resample to n points evenly by arc length. */
function resampleTrack(t: Track, n: number): Track['pts'] {
  const p = t.pts;
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
  const total = cum[cum.length - 1] || 1;
  const out: Track['pts'] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = (total * i) / (n - 1);
    while (k + 2 < p.length && cum[k + 1] < s) k++;
    const f = Math.min(1, Math.max(0, (s - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-9)));
    out.push({ x: p[k].x + (p[k + 1].x - p[k].x) * f, y: p[k].y + (p[k + 1].y - p[k].y) * f, z: p[k].z + (p[k + 1].z - p[k].z) * f });
  }
  return out;
}

/**
 * Ribbon points along a track, shifted right of travel by `shift`. The ends take
 * the road's own direction, so a shifted end lands exactly on the cut line.
 */
function trackLine(p: Track['pts'], shift: number, startDir?: { x: number; z: number }, endDir?: { x: number; z: number }): LinePoint[] {
  const out: LinePoint[] = [];
  let u = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[Math.max(0, i - 1)];
    const b = p[Math.min(p.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    if (i === 0 && startDir) {
      dx = startDir.x;
      dz = startDir.z;
    } else if (i === p.length - 1 && endDir) {
      dx = endDir.x;
      dz = endDir.z;
    }
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    if (i > 0) u += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    out.push({ x: p[i].x + rx * shift, y: p[i].y + ROAD_LIFT, z: p[i].z + rz * shift, rx, rz, u });
  }
  return out;
}

export interface GuideLine {
  pts: LinePoint[];
  color: RGB;
  /** Which guide this is, to take it away by itself: 'T' the inside of a left turn, 'T0'... between turning lanes. */
  from: Id;
  to: Id;
  part: string;
}

/** Left turns at least this long (metres, along the turning path) get guides: big junctions only. */
export const GUIDE_MIN_TURN = 30;
/** Approaches with fewer lanes in than this turn without guides. */
const GUIDE_MIN_LANES = 2;

function crossesPolyline(p: readonly { x: number; z: number }[], q: readonly { x: number; z: number }[]): boolean {
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i];
    const b = p[i + 1];
    for (let j = 0; j + 1 < q.length; j++) {
      const c = q[j];
      const d = q[j + 1];
      const d1 = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      const d2 = (b.x - a.x) * (d.z - a.z) - (b.z - a.z) * (d.x - a.x);
      const d3 = (d.x - c.x) * (a.z - c.z) - (d.z - c.z) * (a.x - c.x);
      const d4 = (d.x - c.x) * (b.z - c.z) - (d.z - c.z) * (b.x - c.x);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** Closed band of a crosswalk, `depth` deep about the line a-b. */
function crosswalkBand(a: Vec3, b: Vec3, depth: number): { x: number; z: number }[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  const nx = (-dz / l) * (depth / 2);
  const nz = (dx / l) * (depth / 2);
  return [
    { x: a.x + nx, z: a.z + nz },
    { x: b.x + nx, z: b.z + nz },
    { x: b.x - nx, z: b.z - nz },
    { x: a.x - nx, z: a.z - nz },
    { x: a.x + nx, z: a.z + nz },
  ];
}

function insidePoly(p: { x: number; z: number }, poly: readonly { x: number; z: number }[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/**
 * Automatic guides inside an ordinary junction. Lane lines stop at every arm's stop
 * line and are not carried through the box; the only automatic paint inside is a
 * dashed guide for left turns on big junctions (multi-lane approaches turning a long
 * way): along the inside of the turn, and between the lanes of a double left. A guide
 * never crosses another (the main road's turns win) or a crosswalk. Ramp junctions and
 * transitions paint their own lines (gore.ts, transitionLines).
 */
export function junctionGuides(net: RoadNetwork, nodeId: Id): GuideLine[] {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!g || !node || g.kind !== 'junction' || g.arms.length < 3 || node.control.hideAutoMarkings || isRampJunction(net, nodeId)) return [];
  const graph = net.laneGraph;
  const ids = graph.connectorsAt.get(nodeId) ?? [];
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const c = graph.lanes[id];
    if (c.turn !== 'left' || c.vehicleKind === 'bike' || c.vehicleKind === 'rail') continue;
    const key = `${graph.lanes[c.fromLane].segmentId}>${graph.lanes[c.toLane].segmentId}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(id);
  }
  // Travel direction where a road lane meets the junction: its last or first step.
  const endDir = (laneIdx: number, atEnd: boolean) => {
    const p = graph.lanes[laneIdx].pts;
    const n = p.length / 3;
    return atEnd ? { x: p[n * 3 - 3] - p[n * 3 - 6], z: p[n * 3 - 1] - p[n * 3 - 4] } : { x: p[3] - p[0], z: p[5] - p[2] };
  };
  const length = (pts: readonly { x: number; z: number }[]) => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    return s;
  };
  const lanesIn = (segId: Id) => {
    const seg = net.getSegment(segId);
    if (!seg) return 0;
    const dir = seg.b === nodeId ? 1 : -1;
    return effectiveLanes(net.roadTypeOf(segId), seg.overrides).filter((l) => l.dir === dir && l.kind !== 'bike').length;
  };
  const candidates: (GuideLine & { rank: number; len: number })[] = [];
  for (const list of groups.values()) {
    const c0 = graph.lanes[list[0]];
    const fromSeg = graph.lanes[c0.fromLane].segmentId;
    const toSeg = graph.lanes[c0.toLane].segmentId;
    if (lanesIn(fromSeg) < GUIDE_MIN_LANES) continue;
    // One path per turning lane: the tightest, into the nearest lane out.
    const best = new Map<number, number>();
    for (const id of list) {
      const from = graph.lanes[id].fromLane;
      const cur = best.get(from);
      if (cur === undefined || graph.lanes[id].length < graph.lanes[cur].length) best.set(from, id);
    }
    const lanes = [...best.values()];
    // Order across the movement, left to right of travel, where it enters.
    const first = graph.lanes[lanes[0]].pts;
    const d0 = endDir(graph.lanes[lanes[0]].fromLane, true);
    const l0 = Math.hypot(d0.x, d0.z) || 1;
    const lat = (id: number) => ((graph.lanes[id].pts[0] - first[0]) * -d0.z + (graph.lanes[id].pts[2] - first[2]) * d0.x) / l0;
    lanes.sort((p, q) => lat(p) - lat(q));
    const inner = graph.lanes[lanes[0]];
    const innerPts = resampleTrack(connectorTrack(inner.pts), 24);
    if (length(innerPts) < GUIDE_MIN_TURN) continue;
    // The main road's own turns first: by the rank of the road turned from, then turned into.
    const rank = net.roadTypeOf(fromSeg).rank * 100 + net.roadTypeOf(toSeg).rank;
    const push = (pts: LinePoint[], part: string) => candidates.push({ pts, color: PAINT_COL.white, from: fromSeg, to: toSeg, part, rank, len: length(pts) });
    push(trackLine(innerPts, -inner.width / 2, endDir(inner.fromLane, true), endDir(inner.toLane, false)), 'T');
    for (let k = 0; k + 1 < lanes.length; k++) {
      const a = graph.lanes[lanes[k]];
      const b = graph.lanes[lanes[k + 1]];
      const pa = resampleTrack(connectorTrack(a.pts), 24);
      const pb = resampleTrack(connectorTrack(b.pts), 24);
      const mid = pa.map((p, i) => ({ x: (p.x + pb[i].x) / 2, y: (p.y + pb[i].y) / 2, z: (p.z + pb[i].z) / 2 }));
      push(trackLine(mid, 0, endDir(a.fromLane, true), endDir(a.toLane, false)), `T${k}`);
    }
  }
  // Crosswalks of the arms, which no guide may run through.
  const bands: { x: number; z: number }[][] = [];
  for (const arm of g.arms) {
    const cw = armEndLayout(net, arm.segmentId, arm.atStart ? -1 : 1)?.crosswalk;
    if (cw) bands.push(crosswalkBand(cw.a, cw.b, CROSSWALK_DEPTH));
  }
  // The main road's turns first, then the longer ones; a guide that would cross one already kept is left off.
  candidates.sort((p, q) => q.rank - p.rank || q.len - p.len);
  const out: GuideLine[] = [];
  for (const c of candidates) {
    if (out.some((o) => crossesPolyline(o.pts, c.pts))) continue;
    if (bands.some((band) => crossesPolyline(band, c.pts) || c.pts.some((p) => insidePoly(p, band)))) continue;
    out.push({ pts: c.pts, color: c.color, from: c.from, to: c.to, part: c.part });
  }
  if (!node.control.autoOff) return out;
  return out.filter((gl) => !isAutoOff(node.control, { kind: 'guide', from: gl.from, to: gl.to, part: gl.part }));
}

/**
 * The pale outline round a junction, along its corner curves, wherever the roads
 * either side have no kerb. Cut lines, where roads join, are left open.
 */
export function junctionOutline(net: RoadNetwork, nodeId: Id): LinePoint[][] {
  const g = net.nodeGeom(nodeId);
  if (!g || g.kind !== 'junction' || g.outline.length < 3) return [];
  const poly = g.outline;
  const n = poly.length;
  const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z) < 0.05;
  const armAt = (p: Vec3) => g.arms.find((a) => near(a.kerbLeft ?? a.leftEdge, p) || near(a.kerbRight ?? a.rightEdge, p));
  const kerbless = (segId: Id) => net.roadTypeOf(segId).category !== 'rail';
  const out: LinePoint[][] = [];
  let run: Vec3[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const pts: LinePoint[] = [];
      let u = 0;
      for (let i = 0; i < run.length; i++) {
        const a = run[Math.max(0, i - 1)];
        const b = run[Math.min(run.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        // Clockwise outline: the inside is on the right. Sit the line just inside.
        const rx = -dz / l;
        const rz = dx / l;
        if (i > 0) u += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
        pts.push({ x: run[i].x + rx * 0.1, y: run[i].y + ROAD_LIFT, z: run[i].z + rz * 0.1, rx, rz, u });
      }
      out.push(pts);
    }
    run = [];
  };
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const armA = armAt(a);
    const armB = armAt(b);
    // An edge between the two cut points of one arm is where its road joins.
    const isCut = armA && armB && armA === armB;
    const corner = !isCut && (!armA || kerbless(armA.segmentId)) && (!armB || kerbless(armB.segmentId));
    if (!corner) {
      flush();
      continue;
    }
    if (!run.length) run.push(a);
    run.push(b);
  }
  flush();
  return out;
}

const OUTLINE = hexRGB(0xc9c9c4);

export function buildJunctionGuides(net: RoadNetwork, nodeId: Id, buf: PaintBuf): void {
  const period = GUIDE_DASH.dash + GUIDE_DASH.gap;
  buf.inLayer('line', () => {
    for (const g of junctionGuides(net, nodeId)) buf.ribbon(g.pts, LINE_W.guide, g.color, period, GUIDE_DASH.dash / period);
    for (const pts of junctionOutline(net, nodeId)) buf.ribbon(pts, LINE_W.outline, OUTLINE, 0, 1);
  });
  // Where two roads meet end to end over a surface (a taper between road types), their lines carry on across it.
  for (const t of transitionLines(net, nodeId)) paintSpecAlong(buf, t.pts, t.spec, 1, t.speed);
}

// ---------------------------------------------------------------------------
// Lines through a transition: two roads end to end over a junction surface
// ---------------------------------------------------------------------------

interface CutLine {
  pos: Vec3;
  /** Unit travel direction through the transition, from the first arm to the second. */
  dir: { x: number; z: number };
  /** Metres right of that direction. */
  lat: number;
  line: BoundaryLine;
  segmentId: Id;
  /** -1 when the road's a-to-b runs against the way through. */
  sign: 1 | -1;
}

/** The automatic lines of an arm where it meets the node, in the frame going through. */
function cutLines(net: RoadNetwork, segId: Id, nodeId: Id, entering: boolean): CutLine[] {
  const seg = net.getSegment(segId);
  const st = net.segmentGeom(segId)?.stations;
  if (!seg || !st || st.length < 2) return [];
  const atB = seg.b === nodeId;
  const cut = atB ? st[st.length - 1] : st[0];
  // Entering, the way through runs into the node; leaving, away from it.
  const sign: 1 | -1 = entering === atB ? 1 : -1;
  const def = net.roadTypeOf(segId);
  const lanes = effectiveLanes(def, seg.overrides);
  const off = new Set(seg.overrides.paintOff ?? []);
  const lines = boundaryLines(lanes, effectiveMarkings(def, seg.overrides), lanes.every((l) => l.dir === 1), def.median.kind, def.median.width, def.median.offset ?? 0, 0, roadSpeed(net, segId));
  return lines
    .filter((l) => !off.has(l.key))
    .map((l) => ({
      pos: { x: cut.pos.x + cut.right.x * l.offset, y: cut.pos.y, z: cut.pos.z + cut.right.z * l.offset },
      dir: { x: cut.tangent.x * sign, z: cut.tangent.z * sign },
      lat: l.offset * sign,
      line: l,
      segmentId: segId,
      sign,
    }));
}

/** Points of a smooth curve from p, leaving along dp, to q, arriving along dq. Unlifted. */
function bridgeCurve(p: Vec3, dp: { x: number; z: number }, q: Vec3, dq: { x: number; z: number }, n = 24): Vec3[] {
  const h = 0.42 * Math.hypot(q.x - p.x, q.z - p.z);
  const p1 = { x: p.x + dp.x * h, z: p.z + dp.z * h };
  const p2 = { x: q.x - dq.x * h, z: q.z - dq.z * h };
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * q.x,
      y: p.y + (q.y - p.y) * t,
      z: u * u * u * p.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * q.z,
    });
  }
  return out;
}

export interface TransitionLine {
  pts: Vec3[];
  spec: import('../core/types').LineStyleSpec;
  speed: number;
  /** Through-frame offsets at the two cuts, for matching hand-placed lines. */
  latA: number;
  latB: number;
}

/**
 * The lines carried across a two-armed node with a surface (a taper or plain-joint
 * transition between road types): the centre to the centre, edges to edges, lane
 * lines to lane lines counted out from the centre on each side. A lane line with no
 * partner on the other road is where a lane ends or begins: it is painted as the
 * lane-drop line and runs most of the way across. Lines a hand-placed line already
 * carries across are left off.
 */
export function transitionLines(net: RoadNetwork, nodeId: Id): TransitionLine[] {
  const g = net.nodeGeom(nodeId);
  const node = net.getNode(nodeId);
  if (!g || !node || g.kind !== 'junction' || g.arms.length !== 2 || node.control.hideAutoMarkings || isRampJunction(net, nodeId)) return [];
  const [armA, armB] = g.arms;
  const A = cutLines(net, armA.segmentId, nodeId, true);
  const B = cutLines(net, armB.segmentId, nodeId, false);
  if (!A.length || !B.length) return [];
  const pairs: { a: CutLine; b: CutLine; drop?: boolean }[] = [];
  const centreA = A.filter((x) => x.line.role === 'centre');
  const centreB = B.filter((x) => x.line.role === 'centre');
  // Centre lines, nearest first.
  const cA = centreA.length ? centreA.reduce((m, x) => (Math.abs(x.lat) < Math.abs(m.lat) ? x : m)) : null;
  const cB = centreB.length ? centreB.reduce((m, x) => (Math.abs(x.lat) < Math.abs(m.lat) ? x : m)) : null;
  if (cA && cB) pairs.push({ a: cA, b: cB });
  const mid = (list: CutLine[], c: CutLine | null) => (c ? c.lat : list.length ? (Math.min(...list.map((x) => x.lat)) + Math.max(...list.map((x) => x.lat))) / 2 : 0);
  const midA = mid(A, cA);
  const midB = mid(B, cB);
  for (const side of [-1, 1] as const) {
    // Edges: the outermost edge line each side.
    const edge = (list: CutLine[], m: number) => list.filter((x) => x.line.role === 'edge' && Math.sign(x.lat - m) === side).sort((p, q) => (q.lat - p.lat) * side)[0];
    const eA = edge(A, midA);
    const eB = edge(B, midB);
    if (eA && eB) pairs.push({ a: eA, b: eB });
    // Lane lines counted out from the centre.
    const lanes = (list: CutLine[], m: number) => list.filter((x) => x.line.role === 'lane' && Math.sign(x.lat - m) === side).sort((p, q) => (p.lat - q.lat) * side);
    const lA = lanes(A, midA);
    const lB = lanes(B, midB);
    const n = Math.min(lA.length, lB.length);
    for (let i = 0; i < n; i++) pairs.push({ a: lA[i], b: lB[i] });
    // A lane ends (or begins): the outer lane goes, so its line heads out for the
    // other road's edge line, or its kerb where it has none.
    for (let i = n; i < lA.length; i++) {
      const target = eB ?? kerbCut(net, armB.segmentId, nodeId, false, side, lA[i]);
      if (target) pairs.push({ a: lA[i], b: target, drop: true });
    }
    for (let i = n; i < lB.length; i++) {
      const target = eA ?? kerbCut(net, armA.segmentId, nodeId, true, side, lB[i]);
      if (target) pairs.push({ a: target, b: lB[i], drop: true });
    }
  }
  // Lines a hand-placed line or junction marking already carries across.
  const held = userTransitionLats(net, nodeId, armA.segmentId, armB.segmentId);
  const out: TransitionLine[] = [];
  for (const { a, b, drop } of pairs) {
    if (held.some(([x, y]) => Math.abs(x - a.lat) < 0.12 && Math.abs(y - b.lat) < 0.12)) continue;
    let pts = bridgeCurve(a.pos, a.dir, b.pos, b.dir);
    // A lane-drop line runs from the road that has the lane most of the way across.
    if (drop) {
      const aHasLane = lanesCount(A) > lanesCount(B);
      pts = aHasLane ? pts.slice(0, Math.ceil(pts.length * 0.7)) : pts.slice(Math.floor(pts.length * 0.3));
    }
    const src = drop ? (lanesCount(A) > lanesCount(B) ? a : b) : a;
    const speed = roadSpeed(net, src.segmentId);
    const look = drop
      ? { ...lineStandard('laneDrop').spec, color: src.line.color }
      : { style: src.line.style as import('../core/types').NodeLineStyle, color: src.line.color, width: src.line.width, ...(src.line.hex ? { hex: src.line.hex } : {}) };
    // Strokes are left and right of the way through: a one-sided look on a road running against it is mirrored.
    const spec = src.sign < 0 && (look.style === 'solidDashed' || look.style === 'dashedSolid') ? { ...look, style: look.style === 'solidDashed' ? ('dashedSolid' as const) : ('solidDashed' as const) } : look;
    out.push({ pts, spec, speed, latA: a.lat, latB: b.lat });
  }
  return out;
}

/** A point on an arm's cut at the outer lane edge on one side of the way through, for a line to head for. */
function kerbCut(net: RoadNetwork, segId: Id, nodeId: Id, entering: boolean, side: -1 | 1, like: CutLine): CutLine | null {
  const seg = net.getSegment(segId);
  const st = net.segmentGeom(segId)?.stations;
  if (!seg || !st || st.length < 2) return null;
  const atB = seg.b === nodeId;
  const cut = atB ? st[st.length - 1] : st[0];
  const sign: 1 | -1 = entering === atB ? 1 : -1;
  const lanes = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  if (!lanes.length) return null;
  // The outer lane edge on this side, in the road's own frame.
  const edges = lanes.map((l) => l.offset + side * sign * (l.width / 2));
  const offset = side * sign > 0 ? Math.max(...edges) : Math.min(...edges);
  return {
    pos: { x: cut.pos.x + cut.right.x * offset, y: cut.pos.y, z: cut.pos.z + cut.right.z * offset },
    dir: { x: cut.tangent.x * sign, z: cut.tangent.z * sign },
    lat: offset * sign,
    line: like.line,
    segmentId: segId,
    sign,
  };
}

function lanesCount(list: CutLine[]): number {
  return list.filter((x) => x.line.role === 'lane').length;
}

/**
 * Through-frame offsets [at the first arm, at the second] of hand-placed lines that
 * cross a two-armed node: Paint tool lines running from one arm into the other, and
 * junction markings from an anchor on one arm to one on the other.
 */
function userTransitionLats(net: RoadNetwork, nodeId: Id, segA: Id, segB: Id): [number, number][] {
  const out: [number, number][] = [];
  const signOf = (seg: Id, entering: boolean) => {
    const s = net.getSegment(seg)!;
    return entering === (s.b === nodeId) ? 1 : -1;
  };
  for (const d of net.decals) {
    const r = d.road;
    if (!r || r.offsetEnd !== undefined) continue;
    for (let i = 0; i + 1 < r.pieces.length; i++) {
      const p = r.pieces[i];
      const q = r.pieces[i + 1];
      const pair = [p.segmentId, q.segmentId];
      if (!(pair[0] === segA && pair[1] === segB) && !(pair[0] === segB && pair[1] === segA)) continue;
      // Offsets are right of walking; walking A to B is the way through, B to A the reverse.
      const op = p.offset ?? r.offset;
      const oq = q.offset ?? r.offset;
      if (p.segmentId === segA) out.push([op, oq]);
      else out.push([-oq, -op]);
    }
  }
  const frames = framesOfNode(net, nodeId);
  for (const m of net.markingsOf({ kind: 'node', id: nodeId })) {
    if (m.kind !== 'line' || m.from.segmentId === m.to.segmentId) continue;
    const fa = frames.find((f) => f.segmentId === m.from.segmentId);
    const fb = frames.find((f) => f.segmentId === m.to.segmentId);
    if (!fa || !fb) continue;
    const oa = fa.offsets[m.from.boundary];
    const ob = fb.offsets[m.to.boundary];
    if (oa === undefined || ob === undefined) continue;
    const latFrom = oa * signOf(m.from.segmentId, m.from.segmentId === segA);
    const latTo = ob * signOf(m.to.segmentId, m.to.segmentId === segA);
    // Snap to the automatic lines they sit by, as the renderer draws them.
    const snap = (seg: Id, lat: number, sign: number) => snapToAutoLine(net, seg, lat * sign) * sign;
    const a = m.from.segmentId === segA ? snap(segA, latFrom, signOf(segA, true)) : snap(segA, latTo, signOf(segA, true));
    const b = m.from.segmentId === segA ? snap(segB, latTo, signOf(segB, false)) : snap(segB, latFrom, signOf(segB, false));
    out.push([a, b]);
  }
  return out;
}

const GRATE = hexRGB(0x101214);
const IRON = hexRGB(0x24262a);
const JOINT = hexRGB(0x16181b);
const EXPANSION_EVERY = 102;

/** Small dark marks that make a road feel made: gullies, manholes, deck joints. */
function drawFixtures(buf: PaintBuf, id: Id, path: StationPath, lanes: readonly LaneDef[], halfWidth: number, sidewalk: number, s0: number, s1: number): void {
  const hash = (n: number) => {
    const v = Math.sin(n * 12.9898 + id * 4.1) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let k = Math.ceil(s0 / EXPANSION_EVERY); k * EXPANSION_EVERY < s1; k++) {
    const p = path.at(k * EXPANSION_EVERY, 0);
    if (p.y - ROAD_LIFT - terrainHeight(p.x, p.z) < 3) continue;
    const a = path.at(k * EXPANSION_EVERY, -halfWidth);
    const b = path.at(k * EXPANSION_EVERY, halfWidth);
    buf.bar(a.x, a.y, a.z, b.x, b.y, b.z, 0.32, JOINT);
  }
  if (sidewalk > 0) {
    // Gullies against the kerb, on alternating sides.
    let side = hash(1) < 0.5 ? 1 : -1;
    for (let s = s0 + 8 + hash(2) * 12; s < s1 - 6; s += 38 + hash(s) * 14) {
      side = -side;
      const c = path.at(s, side * (halfWidth - 0.26));
      const fx = c.rz;
      const fz = -c.rx;
      buf.stamp(placeStamp(rect(-0.2, -0.42, 0.2, 0.42), c.x, c.z, fx, fz, 1), c.y, IRON);
      for (let b = -0.32; b < 0.33; b += 0.106) {
        buf.stamp(placeStamp(rect(-0.16, b - 0.024, 0.16, b + 0.024), c.x, c.z, fx, fz, 1), c.y + 0.002, GRATE);
      }
    }
  }
  // Manhole covers in the lanes, off the wheel paths.
  const drive = lanes.filter((l) => l.kind === 'drive');
  if (drive.length) {
    for (let s = s0 + 14 + hash(3) * 40; s < s1 - 8; s += 62 + hash(s + 9) * 70) {
      const lane = drive[Math.floor(hash(s) * drive.length) % drive.length];
      const c = path.at(s, lane.offset);
      const disc = (r: number) => {
        const out: number[] = [];
        for (let i = 0; i < 12; i++) {
          const a0 = (i / 12) * Math.PI * 2;
          const a1 = ((i + 1) / 12) * Math.PI * 2;
          out.push(c.x, c.z, c.x + Math.cos(a0) * r, c.z + Math.sin(a0) * r, c.x + Math.cos(a1) * r, c.z + Math.sin(a1) * r);
        }
        return out;
      };
      buf.stamp(disc(0.42), c.y, JOINT);
      buf.stamp(disc(0.36), c.y + 0.002, IRON);
    }
  }
}

/**
 * Lane lines that change near a highway exit or lane drop: the line beside a lane
 * that only leaves at the exit ahead becomes the exit-only line, and the line beside
 * a lane that ends becomes the lane-drop line, over the last stretch before the
 * junction (core/paintStandard.ts EXIT_ONLY, LANE_DROP). Keyed by boundary key.
 */
export function laneEndLines(net: RoadNetwork, segId: Id): Map<string, { kind: 'exitOnly' | 'laneDrop'; end: -1 | 1 }> {
  const out = new Map<string, { kind: 'exitOnly' | 'laneDrop'; end: -1 | 1 }>();
  const seg = net.getSegment(segId);
  if (!seg) return out;
  const lanes = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  const graph = net.laneGraph;
  const ids = graph.roadLanes.get(segId);
  if (!ids) return out;
  // Where each lane goes at the end it runs towards: the roads, and the lanes it feeds.
  const dest = lanes.map((l, i) => {
    const node = l.dir > 0 ? seg.b : seg.a;
    const idx = ids[i];
    if (idx === undefined || idx < 0 || l.kind === 'bike' || !isRampJunction(net, node)) return null;
    const segs = new Set<Id>();
    const feeds = new Set<number>();
    for (const c of graph.lanes[idx].next) {
      const conn = graph.lanes[c];
      if (!conn || conn.kind !== 'connector') continue;
      segs.add(graph.lanes[conn.toLane].segmentId);
      feeds.add(conn.toLane);
    }
    return segs.size ? { segs, feeds, end: (l.dir > 0 ? 1 : -1) as -1 | 1 } : null;
  });
  // The road most lanes carry on into is the mainline; any other is an exit.
  const count = new Map<Id, number>();
  for (const d of dest) for (const x of d?.segs ?? []) count.set(x, (count.get(x) ?? 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1] || net.roadTypeOf(b[0]).rank - net.roadTypeOf(a[0]).rank)[0]?.[0];
  for (let i = 0; i + 1 < lanes.length; i++) {
    const a = dest[i];
    const b = dest[i + 1];
    if (!a || !b || lanes[i].dir !== lanes[i + 1].dir) continue;
    const exitOnly = (d: NonNullable<typeof a>) => main !== undefined && !d.segs.has(main);
    if (exitOnly(a) !== exitOnly(b)) {
      out.set(`b${i}`, { kind: 'exitOnly', end: a.end });
      continue;
    }
    // A lane whose every target is also fed by its neighbour ends here.
    const ends = (d: NonNullable<typeof a>, other: NonNullable<typeof a>) => d.feeds.size > 0 && [...d.feeds].every((f) => other.feeds.has(f));
    if (ends(a, b) || ends(b, a)) out.set(`b${i}`, { kind: 'laneDrop', end: a.end });
  }
  return out;
}

/** All paint of one segment. */
export function buildSegmentPaint(net: RoadNetwork, id: Id, buf: PaintBuf): void {
  const seg = net.getSegment(id);
  const geom = net.segmentGeom(id);
  if (!seg || !geom || geom.stations.length < 2) return;
  const def = net.roadTypeOf(id);
  const m = effectiveMarkings(def, seg.overrides);
  const lanes = effectiveLanes(def, seg.overrides);
  const path = new StationPath(geom.stations);
  const oneWay = lanes.every((l) => l.dir === 1);
  const { s0, s1 } = lineSpan(net, id, path);
  const phase: DashPhase = { origin: s0, run: Math.max(0, s1 - s0) };
  const speed = roadSpeed(net, id);
  const off = new Set(seg.overrides.paintOff ?? []);
  // Hand-placed lines along this road hold their stretch: the automatic line is left off there.
  const runs = userRoadLines(net, id);
  const held = (offset: number) => coveredStretches(runs, offset);
  const lines = boundaryLines(lanes, m, oneWay, def.median.kind, def.median.width, def.median.offset ?? 0, 0, speed).filter((l) => !off.has(l.key));
  const clip = overlapClip(net, id);
  // Beside an exit-only lane or a lane that ends, the last stretch takes the highway line for it.
  const special = laneEndLines(net, id);
  // Beside a median nose at a junction the median's edge lines end where it narrows and turn round its tip.
  const noseA = medianNose(net, id, path, -1);
  const noseB = medianNose(net, id, path, 1);
  const wraps = (l: BoundaryLine) => (noseA || noseB) && isMedianEdge(l);
  const plain = lines.filter((l) => !special.has(l.key) && !wraps(l));
  drawLines(buf, path, plain, s0, s1, phase, speed, clip, held);
  for (const l of lines) {
    if (special.has(l.key) || !wraps(l)) continue;
    const a = noseA ? noseA.fullS : s0;
    const b = noseB ? noseB.fullS : s1;
    drawLines(buf, path, [l], a, b, phase, speed, clip, held);
    const look = { style: l.style as import('../core/types').NodeLineStyle, color: l.color, width: l.width, ...(l.hex ? { hex: l.hex } : {}) };
    for (const [nose, end] of [[noseA, -1], [noseB, 1]] as const) {
      if (!nose || b - a <= 0.05) continue;
      // A hand-placed line holding the end of this one takes the turn with it.
      if (held(l.offset).some(([p, q]) => q > Math.min(nose.fullS, nose.tipS) - 0.5 && p < Math.max(nose.fullS, nose.tipS) + 0.5)) continue;
      paintSpecAlong(buf, noseReturn(path, nose, l.offset, end), look, 1, speed);
    }
  }
  for (const l of lines) {
    const sp = special.get(l.key);
    if (!sp) continue;
    const reach = Math.min(EXIT_ONLY.reach, (s1 - s0) * 0.6);
    const [n0, n1, e0, e1] = sp.end > 0 ? [s0, s1 - reach, s1 - reach, s1] : [s0 + reach, s1, s0, s0 + reach];
    drawLines(buf, path, [l], n0, n1, phase, speed, clip, held);
    const spec = resolvedStyle({ ...lineStandard(sp.kind).spec, color: l.color }, speed);
    for (const [p, q] of subtractIntervals(e0, e1, held(l.offset))) paintRoadLine(buf, path, p, q, l.offset, spec, { origin: e0, run: e1 - e0 }, PAINT_COL[l.color]);
  }
  const endA = armEndLayout(net, id, -1);
  const endB = armEndLayout(net, id, 1);
  if (def.category !== 'rail') {
    const edges = boundaryLines([], m, oneWay, 'none', 0, 0, def.halfWidth);
    // The outline stays off the crosswalks and off any stretch where a shaped junction moved the kerb.
    const gaps: [number, number][] = [];
    for (const [layout, end] of [[endA, -1], [endB, 1]] as const) {
      if (!layout?.crosswalk) continue;
      const near = layout.cutS - end * CROSSWALK_GAP;
      const far = layout.cutS - end * (CROSSWALK_GAP + CROSSWALK_DEPTH);
      gaps.push([Math.min(near, far), Math.max(near, far)]);
    }
    const shift = segmentKerbShift(net, id);
    const shifted = (offset: number): [number, number][] => {
      if (!shift) return [];
      const side = offset < 0 ? -1 : 1;
      const out: [number, number][] = [];
      for (let s = path.s0; s < path.s1; s += 0.25) {
        if (Math.abs(shift(side, s)) < 0.03) continue;
        const last = out[out.length - 1];
        if (last && s - last[1] < 0.3) last[1] = s + 0.25;
        else out.push([s - 0.25, s + 0.25]);
      }
      return out;
    };
    drawLines(buf, path, edges, path.s0, path.s1, { origin: path.s0, run: path.s1 - path.s0 }, speed, clip, (o) => [...gaps, ...shifted(o)]);
  }
  drawEnd(buf, net, id, path, -1, endA);
  drawEnd(buf, net, id, path, 1, endB);
  buf.inLayer('symbol', () => paintLaneSymbols(buf, path, lanes, s0, s1));
}
