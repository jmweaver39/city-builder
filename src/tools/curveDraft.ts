/**
 * Fitted curves for the road tool's Curved and Freeform modes. The click points
 * go to core/curveFit.ts, which returns a chain of cubics laid out as tangent,
 * spiral, arc, spiral, tangent. This module checks such a chain against the
 * network as validateDraft checks one cubic, and summarises it for the readout.
 */
import { closestPointOnCubic, cubicLength, cubicPoint, intersectCubicsXZ, type Cubic } from '../core/bezier';
import { comfortRadius, hardMinRadius } from '../core/curveChain';
import { fitCurve, type FitResult } from '../core/curveFit';
import { maxGrade } from '../core/geometry';
import { add, distXZ, scale, sub } from '../core/math';
import { totalHalfWidth } from '../core/roadTypes';
import { JUNCTION_ALLOWANCE, DIVERGE_ALLOWANCE } from '../core/overlap';
import type { CrossingInfo, DraftIssue, RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import { GRADE_CLEARANCE } from '../core/terrain';
import type { RampAttach, Vec3 } from '../core/types';
import type { Tone } from './types';

export interface ChainEnds {
  start: Vec3;
  end: Vec3;
  startDir: Vec3 | null;
  endDir: Vec3 | null;
  startSlope: number | null;
  endSlope: number | null;
  /** The Curved mode's middle click. */
  control: Vec3 | null;
}

/** Fit the road between the clicks, with this road type's radius limits. */
export function fitDraft(net: RoadNetwork, ends: ChainEnds, roadType: string): FitResult | null {
  const def = net.roadType(roadType);
  if (!def || distXZ(ends.start, ends.end) < 0.05) return null;
  return fitCurve({
    start: ends.start,
    end: ends.end,
    startDir: ends.startDir,
    endDir: ends.endDir,
    control: ends.control,
    startSlope: ends.startSlope,
    endSlope: ends.endSlope,
    minRadius: hardMinRadius(def),
    comfortRadius: comfortRadius(def),
    // No sliver shorter than the road is wide, which validateDraft would refuse.
    minPieceLength: Math.max(6, def.halfWidth + 1),
  });
}

/** A joint closer than this to a road it would sit on, beyond both half widths, is moved off. */
const JOINT_CLEAR = 2;
/** Most a merged piece may stray from the two it replaces, metres. */
const MERGE_TOLERANCE = 0.35;

/** The road surface at the same level that a point lies on or beside, or null. */
function roadUnder(net: RoadNetwork, p: Vec3, halfWidth: number): number | null {
  const reach = 60;
  const box = { minX: p.x - reach, minZ: p.z - reach, maxX: p.x + reach, maxZ: p.z + reach };
  for (const id of net.segmentsInRegion(box, true)) {
    const def = net.roadTypeOf(id);
    const hit = closestPointOnCubic(net.cubicOf(id), p);
    if (Math.abs(hit.point.y - p.y) >= GRADE_CLEARANCE) continue;
    if (hit.distance < totalHalfWidth(def) + halfWidth + JOINT_CLEAR) return id;
  }
  return null;
}

/** One cubic in place of two neighbours, same ends and end tangents, if it stays close to them. */
function mergePair(a: Cubic, b: Cubic): Cubic | null {
  const p0 = a.p0;
  const p3 = b.p3;
  const d0 = sub(a.p1, a.p0);
  const d1 = sub(b.p3, b.p2);
  const l0 = Math.hypot(d0.x, d0.z);
  const l1 = Math.hypot(d1.x, d1.z);
  const chord = distXZ(p0, p3);
  if (l0 < 1e-6 || l1 < 1e-6 || chord < 1e-6) return null;
  const samples: Vec3[] = [];
  for (const c of [a, b]) for (let i = 1; i < 8; i++) samples.push(cubicPoint(c, i / 8));
  samples.push(a.p3);
  let best: Cubic | null = null;
  let bestDev = MERGE_TOLERANCE;
  for (let i = 1; i <= 12; i++) {
    for (let j = 1; j <= 12; j++) {
      const k0 = (chord * i) / 18 / l0;
      const k1 = (chord * j) / 18 / l1;
      const c: Cubic = { p0, p1: add(p0, scale(d0, k0)), p2: sub(p3, scale(d1, k1)), p3 };
      let dev = 0;
      for (const q of samples) {
        dev = Math.max(dev, closestPointOnCubic(c, q).distance);
        if (dev >= bestDev) break;
      }
      if (dev < bestDev) {
        bestDev = dev;
        best = c;
      }
    }
  }
  return best;
}

/**
 * A fitted chain whose joints keep off other roads. A joint becomes a node, and a
 * node on another road's surface is a road ending on that road, not crossing it:
 * it overlaps and is refused. The two pieces either side of such a joint are
 * replaced by one, so the road passes over and crosses as a single stroke.
 */
export function jointsOffRoads(net: RoadNetwork, cubics: Cubic[], roadType: string): Cubic[] {
  const def = net.roadType(roadType);
  if (!def || cubics.length < 2) return cubics;
  const hw = totalHalfWidth(def);
  const out = cubics.slice();
  for (let i = 0; i + 1 < out.length; ) {
    if (roadUnder(net, out[i].p3, hw) === null) {
      i++;
      continue;
    }
    const merged = mergePair(out[i], out[i + 1]);
    if (!merged) {
      i++;
      continue;
    }
    out.splice(i, 2, merged);
  }
  return out;
}

/** The same chain driven the other way. */
export function reverseChain(cubics: Cubic[]): Cubic[] {
  return [...cubics].reverse().map((c) => ({ p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 }));
}

export interface ChainCheck {
  issues: DraftIssue[];
  crossings: CrossingInfo[];
  state: Tone;
}

/**
 * Problems with a chain about to be drawn. Each piece goes through validateDraft
 * with its own ends: the real anchors at the two ends of the chain, free points at
 * the joints in between, which become plain joints and never overlap anything.
 * Then what only makes sense for the whole chain: radius from the fitted arc,
 * overlap allowances measured from the real ends, and the chain crossing itself.
 */
export function checkChain(
  net: RoadNetwork,
  cubics: Cubic[],
  start: RoadAnchor,
  end: RoadAnchor,
  roadType: string,
  startAttach: RampAttach | undefined,
  endAttach: RampAttach | undefined,
  fit: FitResult | null,
): ChainCheck {
  const def = net.roadType(roadType)!;
  const n = cubics.length;
  const lengths = cubics.map((c) => cubicLength(c, 48));
  const offsets: number[] = [];
  let total = 0;
  for (const l of lengths) {
    offsets.push(total);
    total += l;
  }
  const rampy = def.category === 'highway' || def.category === 'ramp';
  const allowance = rampy ? DIVERGE_ALLOWANCE : JUNCTION_ALLOWANCE;
  const anchored = (a: RoadAnchor) => a.kind !== 'free';
  /** Distance along the chain of a point on piece i. */
  const along = (i: number, p: Vec3) => offsets[i] + closestPointOnCubic(cubics[i], p).t * lengths[i];
  /**
   * Whether an overlap found on piece i lies within reach of a real end of the
   * chain that this piece was not checked from, where it is the junction there.
   */
  const nearEnd = (i: number, issue: DraftIssue) => {
    const pts = issue.stretch?.length ? issue.stretch : issue.at ? [issue.at] : [];
    if (!pts.length) return false;
    return pts.every((p) => {
      const s = along(i, p);
      return (i > 0 && anchored(start) && s <= allowance) || (i < n - 1 && anchored(end) && total - s <= allowance);
    });
  };

  const issues: DraftIssue[] = [];
  const crossings: CrossingInfo[] = [];
  const seen = new Set<string>();
  const add = (issue: DraftIssue) => {
    const key = `${issue.code}|${issue.severity}|${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (let i = 0; i < n; i++) {
    const c = cubics[i];
    const a: RoadAnchor = i === 0 ? start : { kind: 'free', pos: c.p0 };
    const b: RoadAnchor = i === n - 1 ? end : { kind: 'free', pos: c.p3 };
    const pieceIssues = net.validateDraft({
      start: a,
      end: b,
      c1: c.p1,
      c2: c.p2,
      roadType,
      startAttach: i === 0 ? startAttach : undefined,
      endAttach: i === n - 1 ? endAttach : undefined,
    });
    for (const issue of pieceIssues) {
      // Judged on the whole chain below.
      if (issue.code === 'tightCurve' || issue.code === 'tooShort') continue;
      // Overlap and closeness near a real end is the junction there, as for one cubic.
      if (issue.code === 'tooClose' && nearEnd(i, issue)) continue;
      add(issue);
    }
    const ignore = [a, b].flatMap((x) => (x.kind === 'node' ? [x.id] : []));
    for (const hit of net.findCrossings(c, ignore, roadType)) {
      const atStart = i === 0 && start.kind === 'segment' && start.id === hit.segmentId && hit.t < 0.02;
      const atEnd = i === n - 1 && end.kind === 'segment' && end.id === hit.segmentId && hit.t > 0.98;
      if (atStart || atEnd) continue;
      crossings.push({ ...hit, t: (offsets[i] + hit.t * lengths[i]) / Math.max(total, 1e-9) });
    }
  }

  const minLength = Math.max(5, def.halfWidth);
  if (total < minLength) {
    add({ code: 'tooShort', severity: 'error', message: `Too short: ${total.toFixed(1)} m, needs at least ${minLength.toFixed(1)} m.`, at: cubics[0].p0 });
  }
  if (fit && !fit.ok && fit.reason) add({ code: 'tightCurve', severity: 'error', message: fit.reason, at: tightestPoint(fit) });
  else if (fit?.warning) add({ code: 'tightCurve', severity: 'warning', message: fit.warning, at: tightestPoint(fit) });
  for (const issue of selfIssues(cubics, lengths, def.halfWidth)) add(issue);

  const state: Tone = issues.some((i) => i.severity === 'error') ? 'error' : issues.length ? 'warning' : 'ok';
  return { issues, crossings, state };
}

/** Where the fitted arc starts, for the tight curve marker. */
function tightestPoint(fit: FitResult): Vec3 | undefined {
  const al = fit.alignment;
  const i = al.elements.findIndex((e) => e.kind === 'arc');
  const k = i >= 0 ? i : 0;
  const st = al.starts[k];
  if (!st) return undefined;
  const y = fit.cubics[0]?.p0.y ?? 0;
  return { x: st.x, y, z: st.z };
}

/** The chain crossing or lying on itself at the same level, between pieces that are not neighbours. */
function selfIssues(cubics: Cubic[], lengths: number[], hw: number): DraftIssue[] {
  const out: DraftIssue[] = [];
  for (let i = 0; i < cubics.length; i++) {
    for (let j = i + 2; j < cubics.length; j++) {
      for (const hit of intersectCubicsXZ(cubics[i], cubics[j])) {
        const other = closestPointOnCubic(cubics[j], hit.point);
        if (Math.abs(other.point.y - hit.point.y) >= GRADE_CLEARANCE) continue;
        out.push({ code: 'selfCrossing', severity: 'error', message: 'The road crosses itself.', at: hit.point });
        return out;
      }
    }
  }
  // Surfaces lying on each other without the centrelines crossing.
  const samples: { p: Vec3; s: number; piece: number }[] = [];
  let s0 = 0;
  cubics.forEach((c, k) => {
    const m = Math.max(4, Math.ceil(lengths[k] / 3));
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      const p = cubicAt(c, t);
      samples.push({ p, s: s0 + t * lengths[k], piece: k });
    }
    s0 += lengths[k];
  });
  const apart = 4 * hw + 10;
  const bad: Vec3[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      if (Math.abs(a.piece - b.piece) < 2 || b.s - a.s < apart) continue;
      if (distXZ(a.p, b.p) < 2 * hw - 0.3 && Math.abs(a.p.y - b.p.y) < GRADE_CLEARANCE) bad.push(a.p, b.p);
    }
  }
  if (bad.length) out.push({ code: 'tooClose', severity: 'error', message: 'Doubles back over itself.', at: bad[0], stretch: bad });
  return out;
}

function cubicAt(c: Cubic, t: number): Vec3 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
    z: a * c.p0.z + b * c.p1.z + d * c.p2.z + e * c.p3.z,
  };
}

export interface ChainReadout {
  length: number;
  /** Radius of the fitted arc, Infinity when straight. */
  radius: number;
  grade: number;
  /** Signed total turn, radians. */
  sweep: number;
  pieces: number;
}

export function chainReadout(cubics: Cubic[], fit: FitResult | null): ChainReadout {
  return {
    length: cubics.reduce((s, c) => s + cubicLength(c, 48), 0),
    radius: fit ? fit.radius : Infinity,
    grade: cubics.reduce((g, c) => Math.max(g, maxGrade(c)), 0),
    sweep: fit ? fit.sweep : 0,
    pieces: cubics.length,
  };
}

/** Extra readout lines for a fitted curve: how far it turns, and in how many pieces. */
export function chainLines(r: ChainReadout): string[] {
  const deg = Math.abs((r.sweep * 180) / Math.PI);
  if (deg < 0.5) return [];
  return [`Turn ${deg.toFixed(0)}°${r.pieces > 1 ? `, ${r.pieces} pieces` : ''}`];
}
