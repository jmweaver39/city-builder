/**
 * A road may not lie on top of another road at the same level. Two road surfaces
 * overlap only where they meet at a junction: at the node a road starts or ends
 * at, where it crosses another at grade (which becomes a junction), and along the
 * taper of a ramp leaving or joining a highway at a small angle.
 *
 * This complements findCrossings, which misses roads that run along each other
 * without their centrelines crossing.
 */
import type { Id, RoadTypeDef, Vec3 } from './types';
import type { Cubic } from './bezier';
import { closestPointOnCubic, cubicPoint, cubicTangentXZ } from './bezier';
import type { DraftIssue, RoadAnchor, RoadNetwork } from './RoadNetwork';
import { dotXZ, distXZ } from './math';
import { MAX_TRIM } from './junction';
import { GRADE_CLEARANCE } from './terrain';

/** Overlap a ramp may have with its highway along the taper of a diverge or merge. */
export const DIVERGE_ALLOWANCE = 150;
/** Overlap two roads may have near the node they share: the longest junction trim. */
export const JUNCTION_ALLOWANCE = MAX_TRIM;
/** Surfaces may touch by this much without counting, metres. */
const TOUCH = 0.3;
/** Past this far from the junction, centrelines this close mean one road drawn on top of the other. */
const ON_TOP_AFTER = 40;
const ON_TOP_GAP = 1;
/** A crossing closer than this to a node uses that node, as drawRoad does. */
const NODE_SNAP = 2.5;
const SHALLOW = (15 * Math.PI) / 180;

/** Where the road being checked joins the network, and what it may overlap there. */
interface Connection {
  s: number;
  /** -1 looks back from an end, 1 forward from a start, 0 both ways from a crossing. */
  dir: -1 | 0 | 1;
  segs: Set<Id>;
  nodes: Set<Id>;
  /** Per segment, the overlap allowed. */
  allowance: (seg: Id) => number;
}

interface Sample {
  p: Vec3;
  s: number;
  tan: Vec3;
  hits: { seg: Id; centre: number }[];
  junctions: Id[];
}

const rampy = (def: RoadTypeDef) => def.category === 'highway' || def.category === 'ramp';

function allowanceFor(net: RoadNetwork, def: RoadTypeDef) {
  return (seg: Id): number => {
    const other = net.getSegment(seg);
    if (!other) return JUNCTION_ALLOWANCE;
    return rampy(def) && rampy(net.roadTypeOf(seg)) ? DIVERGE_ALLOWANCE : JUNCTION_ALLOWANCE;
  };
}

function pointInPolygon(x: number, z: number, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function distToPolygon(p: Vec3, poly: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
}

export interface OverlapOptions {
  /** Never test against these, such as the road itself. */
  ignore?: ReadonlySet<Id>;
  /** Test only against these, such as the roads that were there before a template. */
  only?: ReadonlySet<Id>;
}

function scan(net: RoadNetwork, def: RoadTypeDef, cubic: Cubic, connections: Connection[], opts: OverlapOptions): DraftIssue[] {
  const hw = def.halfWidth;
  // Sample about every 2 m.
  let rough = 0;
  for (let i = 1; i <= 16; i++) rough += distXZ(cubicPoint(cubic, (i - 1) / 16), cubicPoint(cubic, i / 16));
  const n = Math.max(16, Math.min(400, Math.ceil(rough / 2)));
  const samples: Sample[] = [];
  let s = 0;
  let prev: Vec3 | null = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = cubicPoint(cubic, t);
    if (prev) s += distXZ(prev, p);
    prev = p;
    samples.push({ p, s, tan: cubicTangentXZ(cubic, t), hits: [], junctions: [] });
  }
  const L = s;
  for (const c of connections) if (c.s < 0) c.s = L;

  // What each sample overlaps.
  const reachOf = new Map<Id, number>();
  for (const smp of samples) {
    const { p } = smp;
    const r = hw + 40;
    for (const id of net.segmentsInRegion({ minX: p.x - r, minZ: p.z - r, maxX: p.x + r, maxZ: p.z + r }, true)) {
      if (opts.ignore?.has(id) || (opts.only && !opts.only.has(id))) continue;
      const otherDef = net.roadTypeOf(id);
      if (otherDef.category === 'rail' || def.category === 'rail') continue;
      let reach = reachOf.get(id);
      if (reach === undefined) {
        reach = otherDef.halfWidth;
        reachOf.set(id, reach);
      }
      const hit = closestPointOnCubic(net.cubicOf(id), p);
      if (hit.distance >= hw + reach - TOUCH) continue;
      if (Math.abs(hit.point.y - p.y) >= GRADE_CLEARANCE) continue;
      smp.hits.push({ seg: id, centre: hit.distance });
    }
    for (const id of net.nodesInRegion({ minX: p.x - 90, minZ: p.z - 90, maxX: p.x + 90, maxZ: p.z + 90 })) {
      const g = net.nodeGeom(id);
      const node = net.getNode(id);
      if (!g || !node || g.kind !== 'junction' || g.outline.length < 3) continue;
      if (opts.only && !node.segments.some((x) => opts.only!.has(x))) continue;
      if (opts.ignore && node.segments.every((x) => opts.ignore!.has(x))) continue;
      if (Math.abs(node.pos.y - p.y) >= GRADE_CLEARANCE) continue;
      if (pointInPolygon(p.x, p.z, g.outline) || distToPolygon(p, g.outline) < hw - TOUCH) {
        smp.junctions.push(id);
      }
    }
  }

  // Overlap near a connection is the junction itself, while it stays one stretch.
  const exempt = samples.map(() => new Set<Id>());
  for (const c of connections) {
    for (const seg of c.segs) {
      const allow = c.allowance(seg);
      const walk = (step: 1 | -1) => {
        let i = nearestIndex(samples, c.s);
        let misses = 0;
        while (i >= 0 && i < samples.length) {
          const smp = samples[i];
          const away = Math.abs(smp.s - c.s);
          if (away > allow) break;
          const h = smp.hits.find((x) => x.seg === seg);
          if (!h) {
            if (++misses > 1) break;
          } else {
            misses = 0;
            const onTop = away > ON_TOP_AFTER && h.centre < ON_TOP_GAP;
            if (onTop) break;
            exempt[i].add(seg);
          }
          i += step;
        }
      };
      if (c.dir >= 0) walk(1);
      if (c.dir <= 0) walk(-1);
    }
  }

  const roadBad: number[] = [];
  const junctionBad: number[] = [];
  samples.forEach((smp, i) => {
    if (smp.hits.some((h) => !exempt[i].has(h.seg))) roadBad.push(i);
    else if (smp.junctions.some((id) => !connections.some((c) => c.nodes.has(id) && Math.abs(smp.s - c.s) <= JUNCTION_ALLOWANCE))) {
      junctionBad.push(i);
    }
  });

  // A road doubling back over itself.
  const selfBad: number[] = [];
  const apart = 4 * hw + 10;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      if (samples[j].s - samples[i].s < apart) continue;
      const a = samples[i].p;
      const b = samples[j].p;
      if (distXZ(a, b) < 2 * hw - TOUCH && Math.abs(a.y - b.y) < GRADE_CLEARANCE) {
        selfBad.push(i, j);
      }
    }
  }

  const issues: DraftIssue[] = [];
  const report = (idx: number[], message: string) => {
    if (!idx.length) return;
    const sorted = [...new Set(idx)].sort((a, b) => a - b);
    issues.push({
      code: 'tooClose',
      severity: 'error',
      message,
      at: samples[sorted[0]].p,
      stretch: sorted.map((i) => samples[i].p),
    });
  };
  report(roadBad, 'Overlaps an existing road.');
  report(junctionBad, 'Runs through an existing junction without joining it.');
  report(selfBad, 'Doubles back over itself.');
  return issues;
}

function nearestIndex(samples: Sample[], s: number): number {
  let best = 0;
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].s - s) < Math.abs(samples[best].s - s)) best = i;
  return best;
}

/** Connections where a road meets crossings at grade, which become junctions. */
function crossingConnections(net: RoadNetwork, def: RoadTypeDef, cubic: Cubic, ends: Id[], skipNear: (segId: Id, t: number) => boolean): Connection[] {
  const out: Connection[] = [];
  // Arc length of a parameter, roughly, for placing crossings among the samples.
  const lengthTo = (t: number) => {
    let s = 0;
    const k = 32;
    for (let i = 1; i <= k; i++) s += distXZ(cubicPoint(cubic, ((i - 1) / k) * t), cubicPoint(cubic, (i / k) * t));
    return s;
  };
  for (const hit of net.findCrossings(cubic, ends)) {
    if (!hit.atGrade || skipNear(hit.segmentId, hit.t)) continue;
    const other = net.getSegment(hit.segmentId);
    if (!other) continue;
    const a = cubicTangentXZ(cubic, hit.t);
    const b = cubicTangentXZ(net.cubicOf(hit.segmentId), hit.segmentT);
    const sin = Math.sqrt(Math.max(0, 1 - dotXZ(a, b) ** 2));
    const theta = Math.asin(Math.min(1, sin));
    const reach = def.halfWidth + net.roadTypeOf(hit.segmentId).halfWidth + 3;
    const radius = theta > SHALLOW ? reach / sin : reach;
    const segs = new Set<Id>([hit.segmentId]);
    const nodes = new Set<Id>();
    for (const nodeId of [other.a, other.b]) {
      const node = net.getNode(nodeId);
      if (node && distXZ(node.pos, hit.point) < NODE_SNAP) {
        // The crossing will use this node, so this is a junction on that node.
        nodes.add(nodeId);
        for (const x of node.segments) segs.add(x);
      }
    }
    const s = lengthTo(hit.t);
    out.push({ s, dir: 0, segs, nodes, allowance: (seg) => (seg === hit.segmentId && !nodes.size ? radius : Math.max(radius, JUNCTION_ALLOWANCE)) });
  }
  return out;
}

/** Overlap problems for a road about to be drawn. `cubic` already sits on any attached lanes. */
export function draftOverlapIssues(net: RoadNetwork, def: RoadTypeDef, cubic: Cubic, start: RoadAnchor, end: RoadAnchor): DraftIssue[] {
  const allowance = allowanceFor(net, def);
  const connections: Connection[] = [];
  const endNodes: Id[] = [];
  const anchorSegs: Id[] = [];
  const add = (anchor: RoadAnchor, atStart: boolean) => {
    const segs = new Set<Id>();
    const nodes = new Set<Id>();
    if (anchor.kind === 'node') {
      const node = net.getNode(anchor.id);
      if (!node) return;
      nodes.add(anchor.id);
      endNodes.push(anchor.id);
      for (const x of node.segments) segs.add(x);
    } else if (anchor.kind === 'segment') {
      if (!net.getSegment(anchor.id)) return;
      segs.add(anchor.id);
      anchorSegs.push(anchor.id);
      const seg = net.getSegment(anchor.id)!;
      const len = net.segmentGeom(anchor.id)?.fullLength ?? 0;
      // Splitting near an end makes a junction that also takes in that end's node.
      for (const [nodeId, t] of [[seg.a, 0], [seg.b, 1]] as const) {
        if (Math.abs(anchor.t - t) * len < JUNCTION_ALLOWANCE) {
          nodes.add(nodeId);
          for (const x of net.getNode(nodeId)?.segments ?? []) segs.add(x);
        }
      }
    } else {
      return;
    }
    connections.push({ s: atStart ? 0 : -1, dir: atStart ? 1 : -1, segs, nodes, allowance });
  };
  add(start, true);
  add(end, false);
  const skipNear = (segId: Id, t: number) => anchorSegs.includes(segId) && Math.min(t, 1 - t) < 0.02;
  connections.push(...crossingConnections(net, def, cubic, endNodes, skipNear));
  return scan(net, def, cubic, connections, {});
}

/**
 * Overlap problems for a road already in the network, as after a move. `only`
 * restricts the check to some roads, such as those that were there before.
 */
export function segmentOverlapIssues(net: RoadNetwork, segId: Id, only?: ReadonlySet<Id>): DraftIssue[] {
  const seg = net.getSegment(segId);
  if (!seg) return [];
  const def = net.roadTypeOf(segId);
  const allowance = allowanceFor(net, def);
  const connections: Connection[] = [];
  for (const [nodeId, atStart] of [[seg.a, true], [seg.b, false]] as const) {
    const node = net.getNode(nodeId);
    if (!node) continue;
    connections.push({ s: atStart ? 0 : -1, dir: atStart ? 1 : -1, segs: new Set(node.segments), nodes: new Set([nodeId]), allowance });
  }
  const cubic = net.cubicOf(segId);
  connections.push(...crossingConnections(net, def, cubic, [seg.a, seg.b], (other, t) => {
    const o = net.getSegment(other);
    const shares = !!o && (o.a === seg.a || o.a === seg.b || o.b === seg.a || o.b === seg.b);
    return other === segId || (shares && Math.min(t, 1 - t) < 0.02);
  }));
  return scan(net, def, cubic, connections, { ignore: new Set([segId]), only });
}
