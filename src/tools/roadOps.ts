/** Edits and walks over the network that are built from several core calls. */
import { cubicTangentXZ } from '../core/bezier';
import { dotXZ, scale } from '../core/math';
import type { RoadNetwork } from '../core/RoadNetwork';
import { isOneWay, lanesMirror } from '../core/roadTypes';
import type { Id, Vec3 } from '../core/types';

/** Apply a road type over a segment, optionally flipping it. Returns the id it ends with. */
export function upgradeSegment(net: RoadNetwork, id: Id, roadType: string, reverse: boolean): Id {
  const seg = net.getSegment(id);
  if (!seg) return id;
  const def = net.roadType(roadType);
  if (!def) throw new Error(`Unknown road type "${roadType}"`);
  // A road that reads the same both ways has nothing to flip.
  const flip = reverse && (isOneWay(def) || !lanesMirror(def));
  if (seg.roadType === roadType && !flip) return id;
  net.batch(() => {
    if (seg.roadType !== roadType) {
      // Lane settings count lanes, so they mean nothing on a different layout.
      const same = net.roadTypeOf(id).lanes.length === def.lanes.length;
      net.setRoadType(id, roadType);
      if (!same) net.setSegmentOverrides(id, { laneKinds: undefined, laneSpeeds: undefined });
    }
    if (flip) net.reverseSegment(id);
  });
  return id;
}

/** Unit plan direction of a segment leaving a node. */
function awayFrom(net: RoadNetwork, segId: Id, nodeId: Id): Vec3 {
  const seg = net.getSegment(segId)!;
  const c = net.cubicOf(segId);
  return seg.a === nodeId ? cubicTangentXZ(c, 0) : scale(cubicTangentXZ(c, 1), -1);
}

/** Roads this close to dead ahead count as the same road through a junction. */
const THROUGH_COS = Math.cos((35 * Math.PI) / 180);

/**
 * Every segment of the same road as `id`: connected, the same type, carrying on
 * through plain joints, and straight on through junctions.
 */
export function connectedRoad(net: RoadNetwork, id: Id): Id[] {
  return connectedRoadOriented(net, id).map((r) => r.id);
}

export interface RoadPiece {
  id: Id;
  /** True when this piece was drawn the other way from the road it was found from. */
  flipped: boolean;
}

/** As connectedRoad, saying which pieces run the other way. Lane order flips on those. */
export function connectedRoadOriented(net: RoadNetwork, id: Id): RoadPiece[] {
  const start = net.getSegment(id);
  if (!start) return [];
  const flipped = new Map<Id, boolean>([[id, false]]);
  const queue: Id[] = [id];
  while (queue.length) {
    const cur = queue.pop()!;
    const seg = net.getSegment(cur)!;
    for (const nodeId of [seg.a, seg.b]) {
      const node = net.getNode(nodeId)!;
      const incoming = awayFrom(net, cur, nodeId);
      let best: Id | null = null;
      let bestCos = THROUGH_COS;
      for (const other of node.segments) {
        if (other === cur || net.getSegment(other)!.roadType !== start.roadType) continue;
        const cos = -dotXZ(incoming, awayFrom(net, other, nodeId));
        if (node.segments.length === 2) {
          best = other;
          break;
        }
        if (cos > bestCos) {
          best = other;
          bestCos = cos;
        }
      }
      if (best !== null && !flipped.has(best)) {
        const other = net.getSegment(best)!;
        // Two ends of the same kind at the shared node means they face each other.
        const headOn = (seg.a === nodeId) === (other.a === nodeId);
        flipped.set(best, flipped.get(cur)! !== headOn);
        queue.push(best);
      }
    }
  }
  return [...flipped].map(([piece, flip]) => ({ id: piece, flipped: flip }));
}

/** The lane on a flipped piece of road that lines up with lane `index`, or -1. */
export function mirroredLane(lanes: readonly { offset: number; dir: 1 | -1 }[], index: number): number {
  const lane = lanes[index];
  if (!lane) return -1;
  return lanes.findIndex((l) => l.dir === -lane.dir && Math.abs(l.offset + lane.offset) < 0.01);
}
