/**
 * Render hooks for hand-edited junction shapes (core/junctionShape.ts): raised
 * islands, and which corners have lost their sidewalk. The asphalt, kerbs and
 * sidewalks themselves come from NodeGeom's outlines, which already honour the
 * shape, so render/junctions.ts draws them as usual.
 */
import * as THREE from 'three';
import type { Id, NodeArm, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { cornerKey, islandPolygons } from '../core/junctionShape';
import type { SurfBuf, SurfStyle } from './batch';
import { COL, KERB_HEIGHT, KIND_PLAIN, KIND_SIDEWALK, ROAD_LIFT } from './constants';

/** Kerb heights at the two ends of a corner: none where the shape took the sidewalk off. */
export function cornerKerbs(net: RoadNetwork, nodeId: Id, a: NodeArm, b: NodeArm, kerbA: number, kerbB: number): [number, number] {
  const corner = net.getNode(nodeId)?.control.shape?.corners?.[cornerKey(a.segmentId, b.segmentId)];
  return corner?.sidewalk === false ? [0, 0] : [kerbA, kerbB];
}

function fillTop(buf: SurfBuf, poly: readonly Vec3[], dy: number, style: SurfStyle): void {
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p.x, p.z)), []);
  } catch {
    return;
  }
  const base = buf.vertexCount;
  for (const p of poly) buf.vert(p.x, p.y + dy, p.z, 0, 1, 0, style);
  for (const [a, b, c] of faces) {
    // Face up: the plan cross product of the triangle must point along +Y.
    const ux = poly[b].x - poly[a].x;
    const uz = poly[b].z - poly[a].z;
    const vx = poly[c].x - poly[a].x;
    const vz = poly[c].z - poly[a].z;
    const ny = uz * vx - ux * vz;
    if (ny >= 0) buf.tri(base + a, base + b, base + c);
    else buf.tri(base + a, base + c, base + b);
  }
}

/** Kerb face round a clockwise polygon, looking out. */
function kerbWall(buf: SurfBuf, poly: readonly Vec3[], top: number, bottom: number, style: SurfStyle): void {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) continue;
    const nx = dz / l;
    const nz = -dx / l;
    const v0 = buf.vert(a.x, a.y + top, a.z, nx, 0, nz, style);
    const v1 = buf.vert(b.x, b.y + top, b.z, nx, 0, nz, style);
    const v2 = buf.vert(b.x, b.y + bottom, b.z, nx, 0, nz, style);
    const v3 = buf.vert(a.x, a.y + bottom, a.z, nx, 0, nz, style);
    buf.quad(v0, v1, v2, v3);
  }
}

/** Raised islands at a junction: sidewalk on top, kerb round the edge. */
export function buildJunctionIslands(net: RoadNetwork, nodeId: Id, slot: number, buf: SurfBuf): void {
  for (const { poly } of islandPolygons(net, nodeId)) {
    fillTop(buf, poly, ROAD_LIFT + KERB_HEIGHT, { color: COL.sidewalk, kind: KIND_SIDEWALK, slot, bias: 0 });
    kerbWall(buf, poly, ROAD_LIFT + KERB_HEIGHT, ROAD_LIFT - 0.02, { color: COL.kerb, kind: KIND_PLAIN, slot, bias: 0 });
  }
}
