/**
 * Operations on single markings at a junction, shared by Bulldoze and the junction
 * marking editor: take an automatic marking away or bring it back, turn one into an
 * editable marking, and find what is under the cursor, automatic or hand-placed.
 */
import { closestPointOnCubic } from '../core/bezier';
import { fillerPolygon, framesOf, markingPath, type ArmFrame } from '../core/nodeMarkings';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { DecalKind, Id, MarkingAnchor, MarkingHost, NodeLineStyle, TurnKind, Vec3 } from '../core/types';
import { autoItemAt, autoMarkingItems, type AutoItem, type AutoItemRef } from '../render/autoItems';
import { CROSSWALK_DEPTH, STOP_WIDTH, TEETH_DEPTH } from '../render/markings';

/** Take one automatic marking away. */
export function removeAutoItem(net: RoadNetwork, nodeId: Id, ref: AutoItemRef): void {
  if (ref.kind === 'crosswalk') net.setCrosswalk(nodeId, ref.segmentId, 'none');
  else net.setAutoMarking(nodeId, ref, false);
}

/** Bring one automatic marking back. */
export function restoreAutoItem(net: RoadNetwork, nodeId: Id, ref: AutoItemRef): void {
  if (ref.kind === 'crosswalk') {
    const node = net.getNode(nodeId);
    if (!node) return;
    const crosswalks = { ...node.control.crosswalks };
    delete crosswalks[ref.segmentId];
    net.setJunctionControl(nodeId, { crosswalks });
  } else net.setAutoMarking(nodeId, ref, true);
}

/** Can this automatic marking become an editable one? Gores have no anchors to hold them. */
export function canConvert(item: AutoItem): boolean {
  return item.ref.kind !== 'gore' && !item.off;
}

/** The anchor on an arm nearest a world point: its boundary, and how far back along the arm. */
function nearestAnchor(frame: ArmFrame, p: Vec3): MarkingAnchor {
  const back = Math.max(0, (p.x - frame.pos.x) * frame.backDir.x + (p.z - frame.pos.z) * frame.backDir.z);
  const lateral = (p.x - frame.pos.x) * frame.right.x + (p.z - frame.pos.z) * frame.right.z;
  let boundary = 0;
  let bestD = Infinity;
  frame.offsets.forEach((o, i) => {
    const d = Math.abs(o - lateral);
    if (d < bestD) {
      bestD = d;
      boundary = i;
    }
  });
  const out: MarkingAnchor = { segmentId: frame.segmentId, boundary };
  const rounded = Math.round(back * 100) / 100;
  if (rounded > 0.01) out.back = rounded;
  return out;
}

function turnsOf(net: RoadNetwork, segId: Id, lane: number): Set<TurnKind> {
  const g = net.laneGraph;
  const idx = g.roadLanes.get(segId)?.[lane];
  const out = new Set<TurnKind>();
  if (idx === undefined) return out;
  for (const nx of g.lanes[idx].next) {
    const t = g.lanes[nx]?.turn;
    if (t) out.add(t);
  }
  return out;
}

function arrowKind(turns: Set<TurnKind>): DecalKind {
  const s = turns.has('straight');
  const l = turns.has('left');
  const r = turns.has('right');
  if (s && l && !r) return 'arrowStraightLeft';
  if (s && r && !l) return 'arrowStraightRight';
  if (l && !s && !r) return 'arrowLeft';
  if (r && !s && !l) return 'arrowRight';
  return 'arrowStraight';
}

const CROSSWALK_STYLE: Record<string, NodeLineStyle> = { zebra: 'crosswalkZebra', ladder: 'crosswalkLadder', lines: 'crosswalkLines' };

/**
 * Replace an automatic marking with an editable one in the same place, in one batch.
 * Returns the new marking's id (a node marking, or a decal for an arrow), or null
 * when this kind cannot be converted.
 */
export function convertAutoItem(net: RoadNetwork, nodeId: Id, item: AutoItem): { marking?: Id; decal?: Id } | null {
  if (!canConvert(item)) return null;
  const frames = framesOf(net, nodeId);
  const ref = item.ref;
  let result: { marking?: Id; decal?: Id } | null = null;
  net.batch(() => {
    if (ref.kind === 'crosswalk' || ref.kind === 'stop') {
      const frame = frames.find((f) => f.segmentId === ref.segmentId);
      if (!frame || item.outline.length < 4) return;
      // The band's long sides run from one kerb to the other; take the middle line.
      const [p0, p1, p2, p3] = item.outline;
      const a = { x: (p0.x + p3.x) / 2, y: p0.y, z: (p0.z + p3.z) / 2 };
      const b = { x: (p1.x + p2.x) / 2, y: p1.y, z: (p1.z + p2.z) / 2 };
      let style: NodeLineStyle;
      let width: number;
      if (ref.kind === 'crosswalk') {
        const kind = net.getNode(nodeId)?.control.crosswalks[ref.segmentId];
        const road = net.getSegment(ref.segmentId);
        const roadStyle = kind && kind !== 'none' ? kind : (road?.overrides.markings?.crosswalk ?? net.roadTypeOf(ref.segmentId).markings.crosswalk);
        style = CROSSWALK_STYLE[roadStyle] ?? 'crosswalkZebra';
        width = CROSSWALK_DEPTH;
      } else {
        style = item.label.startsWith('Yield') ? 'sharkTeeth' : 'stopLine';
        width = style === 'sharkTeeth' ? TEETH_DEPTH : STOP_WIDTH;
      }
      const marking = net.addNodeMarking(nodeId, { kind: 'line', from: nearestAnchor(frame, a), to: nearestAnchor(frame, b), style, color: 'white', width, straight: true });
      removeAutoItem(net, nodeId, ref);
      result = { marking };
    } else if (ref.kind === 'arrow') {
      const seg = net.getSegment(ref.segmentId);
      if (!seg || item.outline.length < 4) return;
      const centre = item.outline.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: p.y, z: acc.z + p.z / 4 }), { x: 0, y: 0, z: 0 });
      const c = net.cubicOf(ref.segmentId);
      const hit = closestPointOnCubic(c, centre);
      const lane = net.roadTypeOf(ref.segmentId).lanes[ref.lane];
      const atB = seg.b === nodeId;
      const decal = net.addDecal({
        kind: arrowKind(turnsOf(net, ref.segmentId, ref.lane)),
        points: [],
        road: { pieces: [{ segmentId: ref.segmentId, t0: hit.t, t1: hit.t }], offset: lane?.offset ?? 0, dir: atB ? 1 : -1 },
        color: 'white',
        width: 1,
        rotation: 0,
      });
      removeAutoItem(net, nodeId, ref);
      result = { decal };
    } else if (ref.kind === 'guide') {
      const pts = item.outline;
      const fromFrame = frames.find((f) => f.segmentId === ref.from);
      const toFrame = frames.find((f) => f.segmentId === ref.to);
      if (!fromFrame || !toFrame || pts.length < 2) return;
      const from = nearestAnchor(fromFrame, pts[0]);
      const to = nearestAnchor(toFrame, pts[pts.length - 1]);
      delete from.back;
      delete to.back;
      const marking = net.addNodeMarking(nodeId, { kind: 'line', from, to, style: 'dashed', color: 'white', width: 0.12, straight: false, path: 'lanes', dash: 0.75, space: 0.75 });
      removeAutoItem(net, nodeId, ref);
      result = { marking };
    }
  });
  return result;
}

const autoCache = new WeakMap<RoadNetwork, { version: number; byNode: Map<Id, AutoItem[]> }>();

/** Automatic items at a node, worked out once per network version. */
export function cachedAutoItems(net: RoadNetwork, nodeId: Id): AutoItem[] {
  let entry = autoCache.get(net);
  if (!entry || entry.version !== net.version) {
    entry = { version: net.version, byNode: new Map() };
    autoCache.set(net, entry);
  }
  let items = entry.byNode.get(nodeId);
  if (!items) entry.byNode.set(nodeId, (items = autoMarkingItems(net, nodeId)));
  return items;
}

/** What is under a ground point at a node: a hand-placed marking first, then an automatic one. */
export type MarkingHit = { kind: 'user'; host: MarkingHost; id: Id } | { kind: 'auto'; nodeId: Id; item: AutoItem };

function distToPolyline(p: { x: number; z: number }, pts: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

function insidePoly(p: { x: number; z: number }, poly: readonly Vec3[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/** The hand-placed marking of a host under a point, last drawn first. */
export function userMarkingAt(net: RoadNetwork, host: MarkingHost, p: { x: number; z: number }, reach = 1): Id | null {
  const list = net.markingsOf(host);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind === 'filler') {
      const poly = fillerPolygon(net, host, m);
      if (poly && insidePoly(p, poly)) return m.id;
      continue;
    }
    const path = markingPath(net, host, m);
    if (!path) continue;
    const half = Math.max(reach, m.width / 2 + 0.3);
    if (distToPolyline(p, path) <= half) return m.id;
  }
  return null;
}

/** Hosts whose markings are near a point: nodes within reach, and segments the point is on. */
export function markingHostsNear(net: RoadNetwork, p: Vec3, reach = 40): MarkingHost[] {
  const out: MarkingHost[] = [];
  for (const n of net.nodes) {
    if (Math.hypot(n.pos.x - p.x, n.pos.z - p.z) > reach) continue;
    out.push({ kind: 'node', id: n.id });
  }
  for (const s of net.segments) if (s.overrides.handMarkings) out.push({ kind: 'segment', id: s.id });
  return out;
}

/**
 * The single marking under a ground point anywhere: hand-placed ones at nearby
 * nodes and along segments first, then automatic ones at nearby junctions.
 */
export function markingAt(net: RoadNetwork, p: Vec3, opts: { auto?: boolean; reach?: number } = {}): MarkingHit | null {
  const hosts = markingHostsNear(net, p);
  for (const host of hosts) {
    const id = userMarkingAt(net, host, p, opts.reach ?? 0.6);
    if (id !== null) return { kind: 'user', host, id };
  }
  if (opts.auto === false) return null;
  let best: MarkingHit | null = null;
  for (const host of hosts) {
    if (host.kind !== 'node') continue;
    const node = net.getNode(host.id);
    if (!node || node.segments.length < 3) continue;
    const item = autoItemAt(cachedAutoItems(net, host.id), p);
    if (item) {
      best = { kind: 'auto', nodeId: host.id, item };
      // Arrows and stop lines are small; a crosswalk is the larger target. Take the first found.
      break;
    }
  }
  return best;
}

/** The outline to draw round a hit marking: its path, or its area closed. */
export function hitOutline(net: RoadNetwork, hit: MarkingHit): Vec3[] {
  if (hit.kind === 'auto') {
    const o = hit.item.outline;
    return hit.item.closed && o.length > 2 ? [...o, o[0]] : o;
  }
  const m = net.markingsOf(hit.host).find((x) => x.id === hit.id);
  if (!m) return [];
  if (m.kind === 'filler') {
    const poly = fillerPolygon(net, hit.host, m);
    return poly ? [...poly, poly[0]] : [];
  }
  return markingPath(net, hit.host, m) ?? [];
}

/** A short name for a hit marking. */
export function hitLabel(net: RoadNetwork, hit: MarkingHit): string {
  if (hit.kind === 'auto') return hit.item.label.charAt(0).toLowerCase() + hit.item.label.slice(1);
  const m = net.markingsOf(hit.host).find((x) => x.id === hit.id);
  if (!m) return 'marking';
  return m.kind === 'filler' ? 'filled area' : 'painted line';
}
