/**
 * Where nothing may stand: road carriageways (lanes and shoulders), junction
 * surfaces, rail track beds and water. Shared by the pedestrian graph, the street
 * detail placer and the tests that check both.
 */
import { closestPointOnCubic } from '../core/bezier';
import { behindQuay } from '../core/quays';
import type { RoadNetwork } from '../core/RoadNetwork';
import { riverDistance, RIVER_HALF_WIDTH, terrainHeight } from '../core/terrain';
import type { Id, Vec3 } from '../core/types';
import { pointInPolygon } from '../core/zones';

/** Height difference beyond which a road is above or below, not in the way. */
const LEVEL_GAP = 2.5;

export interface FootprintOptions {
  /** Ignore this segment's carriageway (a prop of its own on its own kerb line, say). */
  ignore?: Id;
  /** Extra clearance around the object, metres. */
  radius?: number;
}

function distToSegment2(px: number, pz: number, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2)) : 0;
  const qx = a.x + dx * t - px;
  const qz = a.z + dz * t - pz;
  return qx * qx + qz * qz;
}

/** Distance in plan from a point to a closed polygon's boundary. */
export function polygonEdgeDistance(x: number, z: number, poly: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) best = Math.min(best, distToSegment2(x, z, poly[j], poly[i]));
  return Math.sqrt(best);
}

/**
 * What covers (x, z) at height y: 'road' (a carriageway or junction surface),
 * 'rail', 'water', or null for free ground or sidewalk.
 */
export function footprintAt(net: RoadNetwork, x: number, y: number, z: number, opts: FootprintOptions = {}): 'road' | 'rail' | 'water' | null {
  const r = opts.radius ?? 0;
  if (riverDistance(x, z) < RIVER_HALF_WIDTH + r && y < terrainHeight(x, z) + 1.5 && !nearQuay(net, x, z)) return 'water';
  const reach = 40;
  const p = { x, y: 0, z };
  for (const id of net.segmentsInRegion({ minX: x - reach, minZ: z - reach, maxX: x + reach, maxZ: z + reach }, true)) {
    if (id === opts.ignore) continue;
    const def = net.roadTypeOf(id);
    const hit = closestPointOnCubic(net.cubicOf(id), p);
    const rail = def.category === 'rail';
    if (hit.distance > def.halfWidth + r) continue;
    if (Math.abs(hit.point.y - y) > LEVEL_GAP) continue;
    // Clip to the visible span: the curve runs on into junctions, which have their own outline.
    const geom = net.segmentGeom(id);
    if (geom && geom.stations.length >= 2) {
      const t0 = geom.stations[0].t;
      const t1 = geom.stations[geom.stations.length - 1].t;
      if (hit.t < t0 - 1e-4 || hit.t > t1 + 1e-4) continue;
    }
    return rail ? 'rail' : 'road';
  }
  for (const id of net.nodesInRegion({ minX: x - 90, minZ: z - 90, maxX: x + 90, maxZ: z + 90 })) {
    const g = net.nodeGeom(id);
    if (!g || g.outline.length < 3) continue;
    const node = net.getNode(id)!;
    if (Math.abs(node.pos.y - y) > LEVEL_GAP) continue;
    const allRail = g.arms.every((a) => net.roadTypeOf(a.segmentId).category === 'rail');
    if (pointInPolygon(x, z, g.outline) || (r > 0 && polygonEdgeDistance(x, z, g.outline) < r)) return allRail ? 'rail' : 'road';
  }
  return null;
}

/** A quay wall makes the bank behind it land; the river is not there any more. */
function nearQuay(net: RoadNetwork, x: number, z: number): boolean {
  const quays = net.project.quays;
  return !!quays?.length && quays.some((q) => behindQuay(q, x, z));
}
