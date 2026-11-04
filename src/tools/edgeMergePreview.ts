/**
 * Preview of an edge merge while a ramp is drawn onto a highway lane: the taper's
 * outer edge, where it blends into the highway, and the gore between ramp and
 * highway (core/edgeMerge.ts). Approximate, from the draft curve alone; the built
 * junction works out the exact shape.
 */
import { cubicPoint, cubicTangentXZ, type Cubic } from '../core/bezier';
import { defaultTaper } from '../core/edgeMerge';
import { addScaled, distXZ, normalizeXZ, rightOf, scale } from '../core/math';
import { carriagewayEdge, pickHost } from '../core/ramps';
import type { RoadAnchor, RoadNetwork } from '../core/RoadNetwork';
import type { RampAttach, RoadTypeDef, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { COLORS } from './types';

interface DraftLike {
  cubics: Cubic[];
  start: RoadAnchor;
  end: RoadAnchor;
  startAttach?: RampAttach;
  endAttach?: RampAttach;
  state: string;
}

function hostDefAt(net: RoadNetwork, anchor: RoadAnchor): RoadTypeDef | null {
  if (anchor.kind === 'segment') return net.getSegment(anchor.id) ? net.roadTypeOf(anchor.id) : null;
  if (anchor.kind === 'node') {
    const host = pickHost(net.attachAccess, anchor.id, -1);
    return host ? net.roadTypeOf(host.id) : null;
  }
  return null;
}

/** Point and travel direction at arc length `s` from the start of a cubic (or from its end, `fromEnd`). */
function along(c: Cubic, s: number, fromEnd: boolean): { p: Vec3; t: Vec3 } {
  let acc = 0;
  let prev = cubicPoint(c, fromEnd ? 1 : 0);
  const n = 64;
  for (let i = 1; i <= n; i++) {
    const u = fromEnd ? 1 - i / n : i / n;
    const p = cubicPoint(c, u);
    acc += distXZ(prev, p);
    prev = p;
    if (acc >= s) return { p, t: cubicTangentXZ(c, u) };
  }
  return { p: prev, t: cubicTangentXZ(c, fromEnd ? 0 : 1) };
}

function hermite(p: Vec3, dp: Vec3, q: Vec3, dq: Vec3, n = 16): Vec3[] {
  const h = distXZ(p, q) / 3;
  const c1 = addScaled(p, dp, h);
  const c2 = addScaled(q, dq, -h);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(cubicPoint({ p0: p, p1: c1, p2: c2, p3: q }, i / n));
  return out;
}

export function edgeMergePreview(net: RoadNetwork, draft: DraftLike, roadType: string): ToolMark[] {
  const def = net.roadType(roadType);
  if (!def || draft.state === 'error') return [];
  const out: ToolMark[] = [];
  const lift = (pts: Vec3[]) => pts.map((p) => ({ ...p, y: p.y + 0.35 }));
  for (const merge of [false, true]) {
    const attach = merge ? draft.endAttach : draft.startAttach;
    if (!attach?.edge) continue;
    const host = hostDefAt(net, merge ? draft.end : draft.start);
    if (!host) continue;
    const c = merge ? draft.cubics[draft.cubics.length - 1] : draft.cubics[0];
    const side: 1 | -1 = attach.hostSide === -1 ? 1 : -1;
    const end = cubicPoint(c, merge ? 1 : 0);
    const travelEnd = cubicTangentXZ(c, merge ? 1 : 0);
    const rEnd = rightOf(travelEnd);
    const inner = Math.abs(carriagewayEdge(def.lanes, 1, side === 1 ? -1 : 1));
    const hostCw = Math.abs(carriagewayEdge(host.lanes, 1, 1));
    const hostLane = addScaled(end, rEnd, -side * inner);
    const hostRoad = addScaled(hostLane, rEnd, side * Math.max(0, host.halfWidth - hostCw));
    let length = 0;
    for (let i = 1, prev = c.p0; i <= 32; i++) {
      const p = cubicPoint(c, i / 32);
      length += distXZ(prev, p);
      prev = p;
    }
    const L = Math.min(attach.edge.taper ?? defaultTaper(host.speedKmh), length * 0.8);
    const cut = along(c, L, merge);
    const rc = rightOf(cut.t);
    const outerAtCut = addScaled(cut.p, rc, side * def.halfWidth);
    const innerAtCut = addScaled(cut.p, rc, -side * inner);
    const back = (d: number) => addScaled(hostLane, travelEnd, merge ? -d : d);
    const taper = merge ? hermite(outerAtCut, cut.t, hostRoad, travelEnd) : hermite(hostRoad, travelEnd, outerAtCut, cut.t);
    out.push({ kind: 'line', points: lift(taper), color: COLORS.ok, width: 0.45 });
    const tip = back(L * 0.55);
    const nose = merge ? hermite(innerAtCut, cut.t, tip, travelEnd, 10) : hermite(tip, travelEnd, innerAtCut, cut.t, 10);
    const gore = merge ? [...nose, back(L)] : [back(L), ...nose];
    gore.push(gore[0]);
    out.push({ kind: 'line', points: lift(gore), color: COLORS.warn, width: 0.3 });
    // A few chevrons in the gore, so it reads as one.
    const mid = scale(normalizeXZ(travelEnd), merge ? 1 : -1);
    for (const f of [0.3, 0.55, 0.8]) {
      const a = back(L * (1 - f * 0.45));
      const w = Math.min(2.5, distXZ(innerAtCut, back(L)) * (1 - f) * 0.8 + 0.4);
      const tipP = addScaled(a, rEnd, side * w * 0.5);
      out.push({ kind: 'line', points: lift([addScaled(tipP, mid, -1.2), tipP, addScaled(addScaled(tipP, rEnd, side * w * 0.5), mid, -1.2)]), color: COLORS.warn, width: 0.2 });
    }
  }
  return out;
}
