/**
 * Layout of the top-down mini diagram in the signal editor: road arms from
 * nodeGeom and one arrow per movement. World x maps to canvas x and world z to
 * canvas y, so the picture matches a camera looking north.
 */
import { lerp } from '../core/math';
import type { RoadNetwork } from '../core/RoadNetwork';
import { movementsAt, type Movement } from '../core/signals';
import type { Id, MovementKey, TurnKind, Vec3 } from '../core/types';

export interface Pt {
  x: number;
  y: number;
}

export interface DiagramArm {
  segmentId: Id;
  tip: Pt;
  /** Half width of the arm on the canvas. */
  half: number;
  dir: Pt;
  name: string;
}

export interface DiagramMove {
  key: MovementKey;
  fromSegment: Id;
  toSegment: Id;
  turn: TurnKind;
  /** Polyline from the approach to the exit. */
  points: Pt[];
}

export interface JunctionDiagram {
  size: number;
  centre: Pt;
  arms: DiagramArm[];
  moves: DiagramMove[];
}

function fanOffset(turn: TurnKind): number {
  if (turn === 'right') return 5;
  if (turn === 'left') return -5;
  return 0;
}

export function layoutDiagram(net: RoadNetwork, nodeId: Id, size: number): JunctionDiagram | null {
  const geom = net.nodeGeom(nodeId);
  if (!geom || geom.arms.length === 0) return null;
  const c = size / 2;
  const reach = size * 0.47;
  const maxWidth = Math.max(...geom.arms.map((a) => net.roadTypeOf(a.segmentId).halfWidth));
  const k = Math.min(size * 0.14, 34) / Math.max(maxWidth, 1);
  const arms: DiagramArm[] = geom.arms.map((arm) => {
    const def = net.roadTypeOf(arm.segmentId);
    return {
      segmentId: arm.segmentId,
      tip: { x: c + arm.dir.x * reach, y: c + arm.dir.z * reach },
      half: Math.max(9, def.halfWidth * k),
      dir: { x: arm.dir.x, y: arm.dir.z },
      name: net.getSegment(arm.segmentId)?.overrides.name || def.name,
    };
  });
  const moves: DiagramMove[] = [];
  for (const m of movementsAt(net, nodeId)) {
    const from = arms.find((a) => a.segmentId === m.fromSegment);
    const to = arms.find((a) => a.segmentId === m.toSegment);
    if (from && to) moves.push(diagramMove(m, from, to, c, reach, net));
  }
  return { size, centre: { x: c, y: c }, arms, moves };
}

function diagramMove(m: Movement, from: DiagramArm, to: DiagramArm, c: number, reach: number, net: RoadNetwork): DiagramMove {
  const oneWay = (id: Id) => net.roadTypeOf(id).lanes.every((l) => l.dir === 1);
  const inward = reach * 0.8;
  // Right of travel on the way in. Travel is -dir, so right is (dir.y, -dir.x) on the canvas.
  const inLat = oneWay(m.fromSegment) ? 0 : from.half * 0.5;
  const fan = fanOffset(m.turn);
  const start: Vec3 = {
    x: c + from.dir.x * inward + from.dir.y * (inLat + fan),
    y: 0,
    z: c + from.dir.y * inward - from.dir.x * (inLat + fan),
  };
  const outLat = oneWay(m.toSegment) ? 0 : to.half * 0.5;
  // Right of travel on the way out. Travel is +dir, so right is (-dir.y, dir.x).
  const end: Vec3 = {
    x: c + to.dir.x * inward - to.dir.y * outLat,
    y: 0,
    z: c + to.dir.y * inward + to.dir.x * outLat,
  };
  const pull = m.turn === 'uturn' ? 0.2 : 0.55;
  const mid: Vec3 = {
    x: c + (from.dir.x + to.dir.x) * reach * (m.turn === 'straight' ? 0 : pull * 0.45),
    y: 0,
    z: c + (from.dir.y + to.dir.y) * reach * (m.turn === 'straight' ? 0 : pull * 0.45),
  };
  const points: Pt[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const p = lerp(lerp(start, mid, t), lerp(mid, end, t), t);
    points.push({ x: p.x, y: p.z });
  }
  return { key: m.key, fromSegment: m.fromSegment, toSegment: m.toSegment, turn: m.turn, points };
}

/** The movement nearest a canvas position, within `reach` pixels. */
export function moveAt(d: JunctionDiagram, x: number, y: number, reach = 7): DiagramMove | null {
  let best: DiagramMove | null = null;
  let bestD = reach;
  for (const m of d.moves) {
    for (let i = 0; i + 1 < m.points.length; i++) {
      const a = m.points[i];
      const b = m.points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      const dist = Math.hypot(a.x + dx * u - x, a.y + dy * u - y);
      if (dist < bestD) {
        bestD = dist;
        best = m;
      }
    }
  }
  return best;
}
