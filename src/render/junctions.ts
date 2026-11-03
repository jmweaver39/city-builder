/**
 * Junction meshing. The carriageway fills NodeGeom.outline, triangulated in XZ
 * so sloped nodes keep their edge heights. Kerbs and sidewalks run corner by
 * corner, between the outline and the outer outline.
 */
import * as THREE from 'three';
import type { Id, NodeArm, NodeGeom, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { sidewalkOn } from '../core/roadTypes';
import { terrainHeight } from '../core/terrain';
import type { SurfBuf, SurfStyle } from './batch';
import {
  BIAS_JUNCTION,
  COL,
  DECK_DEPTH,
  ELEVATED_CLEARANCE,
  KERB_HEIGHT,
  KIND_JUNCTION,
  KIND_CONCRETE,
  KIND_GRASS,
  KIND_PLAIN,
  KIND_SIDEWALK,
  ROAD_LIFT,
  TUNNEL_Y,
} from './constants';
import { surfaceColour, type RoadOutputs } from './roads';
import { addPierAt } from './structures';

type Pt = { x: number; y: number; z: number };

function fillPolygon(buf: SurfBuf, poly: readonly Vec3[], dy: number, style: SurfStyle, down = false): void {
  if (poly.length < 3) return;
  const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  const base = buf.vertexCount;
  const n = poly.length;
  const ny = new Float32Array(n * 3);
  const yAt = (i: number) => poly[i].y + dy;
  const tris: [number, number, number][] = [];
  for (const [a0, b0, c0] of faces) {
    let a = a0;
    let b = b0;
    let c = c0;
    const ux = poly[b].x - poly[a].x;
    const uy = yAt(b) - yAt(a);
    const uz = poly[b].z - poly[a].z;
    const vx = poly[c].x - poly[a].x;
    const vy = yAt(c) - yAt(a);
    const vz = poly[c].z - poly[a].z;
    let nx = uy * vz - uz * vy;
    let nY = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (nY < 0 !== down) {
      [b, c] = [c, b];
      nx = -nx;
      nY = -nY;
      nz = -nz;
    }
    tris.push([a, b, c]);
    for (const v of [a, b, c]) {
      ny[v * 3] += nx;
      ny[v * 3 + 1] += nY;
      ny[v * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(ny[i * 3], ny[i * 3 + 1], ny[i * 3 + 2]) || 1;
    const p = poly[i];
    buf.vert(p.x, p.y + dy, p.z, ny[i * 3] / l, ny[i * 3 + 1] / l, ny[i * 3 + 2] / l, style);
  }
  for (const [a, b, c] of tris) buf.tri(base + a, base + b, base + c);
}

/** Vertical wall under a polyline. Clockwise from above with the inside to the right. */
function wall(buf: SurfBuf, chain: readonly Pt[], top: (i: number) => number, bottom: (i: number) => number, style: SurfStyle, faceOut: boolean): void {
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) continue;
    // Outside is left of clockwise travel.
    const sign = faceOut ? 1 : -1;
    const nx = (sign * dz) / l;
    const nz = (sign * -dx) / l;
    const v0 = buf.vert(a.x, top(i), a.z, nx, 0, nz, style);
    const v1 = buf.vert(b.x, top(i + 1), b.z, nx, 0, nz, style);
    const v2 = buf.vert(b.x, bottom(i + 1), b.z, nx, 0, nz, style);
    const v3 = buf.vert(a.x, bottom(i), a.z, nx, 0, nz, style);
    if (faceOut) buf.quad(v0, v1, v2, v3);
    else buf.quad(v1, v0, v3, v2);
  }
}

function resample(chain: readonly Pt[], count: number): Pt[] {
  const cum = [0];
  for (let i = 1; i < chain.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].z - chain[i - 1].z));
  }
  const total = cum[cum.length - 1];
  const out: Pt[] = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    const s = (total * i) / (count - 1);
    while (k + 2 < chain.length && cum[k + 1] < s) k++;
    const span = cum[k + 1] - cum[k];
    const f = span > 1e-6 ? (s - cum[k]) / span : 0;
    const a = chain[k];
    const b = chain[k + 1];
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  }
  return out;
}

function offsetChain(chain: readonly Pt[], d: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < chain.length; i++) {
    const a = chain[Math.max(0, i - 1)];
    const b = chain[Math.min(chain.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.push({ x: chain[i].x + (dz / l) * d, y: chain[i].y, z: chain[i].z - (dx / l) * d });
  }
  return out;
}

/** Quad strip between two chains of equal length, with heights from dy. */
function stripBetween(buf: SurfBuf, inner: readonly Pt[], outer: readonly Pt[], dyIn: (i: number) => number, dyOut: (i: number) => number, style: SurfStyle): void {
  const n = inner.length;
  const base = buf.vertexCount;
  for (let i = 0; i < n; i++) {
    const a = inner[i];
    const b = outer[i];
    buf.vert(a.x, a.y + dyIn(i), a.z, 0, 1, 0, style);
    buf.vert(b.x, b.y + dyOut(i), b.z, 0, 1, 0, style);
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = base + i * 2;
    // Clockwise travel with outside on the left: inner, outer, next outer is up-facing when reversed.
    buf.quad(a, a + 2, a + 3, a + 1);
  }
}

function findPoint(poly: readonly Vec3[], p: Vec3): number {
  let best = -1;
  let bestD = 0.0025;
  for (let i = 0; i < poly.length; i++) {
    const dx = poly[i].x - p.x;
    const dz = poly[i].z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Outline points from one index forward to another. Null when it wraps too far. */
function walk(poly: readonly Vec3[], from: number, to: number): Vec3[] | null {
  if (from < 0 || to < 0) return null;
  const out: Vec3[] = [];
  const n = poly.length;
  for (let k = 0; k <= n; k++) {
    const i = (from + k) % n;
    out.push(poly[i]);
    if (i === to && k > 0) return out;
  }
  return null;
}

interface ArmEdges {
  arm: NodeArm;
  sidewalk: number;
  /** Sidewalk on each side, as seen looking at the node. */
  walkLeft: number;
  walkRight: number;
  outerLeft: Vec3;
  outerRight: Vec3;
}

function armEdges(net: RoadNetwork, arm: NodeArm): ArmEdges {
  const def = net.roadTypeOf(arm.segmentId);
  const H = def.halfWidth;
  // An arm's left, looking at the node, is the segment's right when it leaves from a.
  const walkLeft = sidewalkOn(def, arm.atStart ? 1 : -1);
  const walkRight = sidewalkOn(def, arm.atStart ? -1 : 1);
  const ux = (arm.leftEdge.x - arm.centre.x) / H;
  const uz = (arm.leftEdge.z - arm.centre.z) / H;
  const y = arm.centre.y;
  return {
    arm,
    sidewalk: def.sidewalk,
    walkLeft,
    walkRight,
    outerLeft: { x: arm.centre.x + ux * (H + walkLeft), y, z: arm.centre.z + uz * (H + walkLeft) },
    outerRight: { x: arm.centre.x - ux * (H + walkRight), y, z: arm.centre.z - uz * (H + walkRight) },
  };
}

interface EdgeStyles {
  slot: number;
  /** Clearance over the terrain. */
  clearance: number;
  /** Terrain height, for walls of a junction sitting in a cutting. */
  ground: number;
}

/** Sidewalk, kerb, verge, deck and barrier for one edge between two arms. */
function buildCorner(buf: SurfBuf, innerRaw: readonly Vec3[], outerRaw: readonly Vec3[], kerbA: number, kerbB: number, e: EdgeStyles): void {
  const slot = e.slot;
  const count = Math.max(innerRaw.length, outerRaw.length, 2);
  const inner = resample(innerRaw.map((p) => ({ x: p.x, y: p.y + ROAD_LIFT, z: p.z })), count);
  const outer = resample(outerRaw.map((p) => ({ x: p.x, y: p.y + ROAD_LIFT, z: p.z })), count);
  const kerb = (i: number) => kerbA + ((kerbB - kerbA) * i) / (count - 1);
  const hasWalk = kerbA > 0 || kerbB > 0;
  if (hasWalk) {
    stripBetween(buf, inner, outer, kerb, kerb, { color: COL.sidewalk, kind: KIND_SIDEWALK, slot, bias: 0 });
    wall(buf, inner, (i) => inner[i].y + kerb(i), (i) => inner[i].y, { color: COL.kerb, kind: KIND_PLAIN, slot, bias: 0 }, false);
  }
  const raised = e.clearance > 0.08;
  if (!hasWalk && !raised && e.clearance > -0.05) {
    const vergeOut = offsetChain(outer, 0.9);
    stripBetween(buf, outer, vergeOut, () => 0, () => -0.22, { color: COL.gravel, kind: KIND_GRASS, slot, bias: 0 });
  }
  if (raised || hasWalk) {
    const depth = raised ? Math.min(DECK_DEPTH, e.clearance + 0.35) : 0.3;
    wall(buf, outer, (i) => outer[i].y + kerb(i), (i) => outer[i].y - depth, { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 }, true);
  }
  if (outer.some((p) => p.y < e.ground)) {
    const top = (i: number) => {
      const below = e.ground - outer[i].y;
      return outer[i].y + Math.max(0, below) + 0.45 * Math.min(1, Math.max(0, below / 0.4));
    };
    wall(buf, outer, top, (i) => outer[i].y, { color: COL.concrete, kind: KIND_CONCRETE, slot, bias: 0 }, false);
  }
  if (e.clearance > ELEVATED_CLEARANCE) {
    const style: SurfStyle = { color: COL.barrier, kind: KIND_PLAIN, slot: 0, bias: 0 };
    const inside = offsetChain(outer, -0.3);
    const outside = offsetChain(outer, 0.02);
    const h = 0.9;
    wall(buf, inside, (i) => inside[i].y + kerb(i) + h, (i) => inside[i].y + kerb(i), style, false);
    wall(buf, outside, (i) => outside[i].y + kerb(i) + h, (i) => outside[i].y + kerb(i) - 0.1, style, true);
    stripBetween(buf, inside, outside, (i) => kerb(i) + h, (i) => kerb(i) + h, style);
  }
}

function junctionColour(net: RoadNetwork, g: NodeGeom) {
  // A junction keeps a special surface only when every arm agrees on it.
  const first = net.getSegment(g.arms[0]?.segmentId ?? -1);
  const surface = first?.overrides.surface;
  for (const arm of g.arms) {
    if (net.getSegment(arm.segmentId)?.overrides.surface !== surface) return surfaceColour(undefined);
  }
  return surfaceColour(first);
}

function buildDeadEnd(net: RoadNetwork, g: NodeGeom, slot: number, out: RoadOutputs): void {
  const arm = g.arms[0];
  if (!arm) return;
  const def = net.roadTypeOf(arm.segmentId);
  const H = def.halfWidth;
  const W = def.sidewalk;
  const ux = (arm.leftEdge.x - arm.centre.x) / H;
  const uz = (arm.leftEdge.z - arm.centre.z) / H;
  const dx = -arm.dir.x;
  const dz = -arm.dir.z;
  const y = arm.centre.y;
  const arc = (r: number) => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * Math.PI;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      pts.push({ x: arm.centre.x + ux * c + dx * s, y, z: arm.centre.z + uz * c + dz * s });
    }
    return pts;
  };
  const inner = arc(H);
  fillPolygon(out.surf, inner, ROAD_LIFT, { color: surfaceColour(net.getSegment(arm.segmentId)), kind: KIND_JUNCTION, slot, bias: 0 });
  const clearance = y - terrainHeight(arm.centre.x, arm.centre.z);
  const kerb = W > 0 ? KERB_HEIGHT : 0;
  buildCorner(out.surf, inner, arc(H + W), kerb, kerb, { slot, clearance, ground: y - clearance });
  if (clearance > 0.08) {
    const under: SurfStyle = { color: COL.concreteDark, kind: KIND_CONCRETE, slot, bias: 0 };
    fillPolygon(out.surf, arc(H + W), ROAD_LIFT - Math.min(DECK_DEPTH, clearance + 0.35), under, true);
  }
}

/** Mesh one node. */
export function buildJunction(net: RoadNetwork, id: Id, slot: number, out: RoadOutputs): void {
  const g = net.nodeGeom(id);
  const node = net.getNode(id);
  if (!g || !node) return;
  // Track junctions are turnouts, meshed by render/tracks. A level crossing keeps its road surface.
  if (g.arms.every((arm) => net.roadTypeOf(arm.segmentId).category === 'rail')) return;
  if (g.kind === 'deadEnd') {
    buildDeadEnd(net, g, slot, out);
    return;
  }
  if (g.kind !== 'junction' || g.outline.length < 3) return;

  const surf = out.surf;
  fillPolygon(surf, g.outline, ROAD_LIFT, { color: junctionColour(net, g), kind: KIND_JUNCTION, slot, bias: BIAS_JUNCTION });

  const ground = terrainHeight(node.pos.x, node.pos.z);
  const clearance = node.pos.y - ground;
  const n = g.arms.length;
  const edges = g.arms.map((a) => armEdges(net, a));
  let failed = false;
  for (let i = 0; i < n; i++) {
    const a = edges[i];
    const b = edges[(i + 1) % n];
    const innerChain = walk(g.outline, findPoint(g.outline, a.arm.leftEdge), findPoint(g.outline, b.arm.rightEdge));
    const outerChain = walk(g.outerOutline, findPoint(g.outerOutline, a.outerLeft), findPoint(g.outerOutline, b.outerRight));
    if (!innerChain || !outerChain) {
      failed = true;
      continue;
    }
    buildCorner(surf, innerChain, outerChain, a.walkLeft > 0 ? KERB_HEIGHT : 0, b.walkRight > 0 ? KERB_HEIGHT : 0, { slot, clearance, ground });
  }
  // Hull fallback: no corners to follow, so lay the sidewalk flat under the road.
  if ((failed || g.outlineSimplified) && edges.some((e) => e.sidewalk > 0)) {
    fillPolygon(surf, g.outerOutline, ROAD_LIFT - 0.012, { color: COL.sidewalk, kind: KIND_SIDEWALK, slot, bias: 0 });
  }
  if (clearance > 0.08) {
    const depth = Math.min(DECK_DEPTH, clearance + 0.35);
    const under: SurfStyle = { color: COL.concreteDark, kind: KIND_CONCRETE, slot, bias: 0 };
    fillPolygon(surf, g.outerOutline, ROAD_LIFT - depth, under, true);
    if (clearance > 3.2) {
      const style: SurfStyle = { color: COL.concrete, kind: KIND_CONCRETE, slot: 0, bias: 0 };
      addPierAt(surf, node.pos.x, node.pos.y + ROAD_LIFT, node.pos.z, 1.6, style);
    }
  }
  // Any part below the ground needs the terrain opened over the whole junction.
  const low = Math.min(...g.outline.map((p) => p.y));
  if (low < ground - 0.02 && low > TUNNEL_Y - 3) {
    const pts: number[] = [];
    for (const p of g.outerOutline) pts.push(p.x, ground + 0.02, p.z);
    const faces = THREE.ShapeUtils.triangulateShape(g.outerOutline.map((p) => new THREE.Vector2(p.x, p.z)), []);
    out.hole.polygon(pts, faces.flat());
  }
}
