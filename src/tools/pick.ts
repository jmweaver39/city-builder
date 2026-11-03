/**
 * Finding what is under the cursor, by casting the camera ray against what is
 * actually drawn: each junction's outline polygon at the node's true height, and
 * each road's surface between its edges along its stations, slopes included. The
 * hit nearest the camera wins, so a bridge hides the road below it. A small slack,
 * measured in screen pixels, catches thin targets at any zoom. Tunnels are only
 * pickable in the underground view, where the terrain does not hide them.
 */
import { closestPointOnCubic, cubicPoint, cubicTangentXZ } from '../core/bezier';
import { distXZ, rightOf } from '../core/math';
import type { NearestSegment, RoadNetwork } from '../core/RoadNetwork';
import { resolveDecal } from '../core/roadPaint';
import { totalHalfWidth } from '../core/roadTypes';
import { ELEVATION_STEP, terrainHeight } from '../core/terrain';
import type { Decal, Id, TrafficEndpoint, Vec3 } from '../core/types';
import type { ToolContext, ToolPointer } from './types';

const BAND = ELEVATION_STEP;
const BAND_TOLERANCE = BAND / 2 + 0.5;

const levelCache = new WeakMap<RoadNetwork, { version: number; levels: number[] }>();

/** Height bands that hold a node, highest first. Always includes 0. */
export function heightLevels(net: RoadNetwork): number[] {
  const hit = levelCache.get(net);
  if (hit && hit.version === net.version) return hit.levels;
  let lo = 0;
  let hi = 0;
  for (const n of net.nodes) {
    if (n.pos.y < lo) lo = n.pos.y;
    if (n.pos.y > hi) hi = n.pos.y;
  }
  lo = Math.floor(lo / BAND) * BAND;
  hi = Math.ceil(hi / BAND) * BAND;
  const levels: number[] = [];
  for (let y = hi; y >= lo; y -= BAND) levels.push(y);
  levelCache.set(net, { version: net.version, levels });
  return levels;
}

export interface PickedRoad extends NearestSegment {
  /** The cursor position on the plane of the road. */
  raw: Vec3;
}

/**
 * Nearest road at about this height. nearestSegment works in plan view only, so
 * where a bridge crosses a road it can answer with the wrong one of the two.
 */
export function nearestOnLevel(net: RoadNetwork, pos: Vec3, level: number, maxDistance: number): NearestSegment | null {
  const box = { minX: pos.x - maxDistance, minZ: pos.z - maxDistance, maxX: pos.x + maxDistance, maxZ: pos.z + maxDistance };
  let best: NearestSegment | null = null;
  for (const id of net.segmentsInRegion(box, true)) {
    const c = net.cubicOf(id);
    const hit = closestPointOnCubic(c, pos);
    if (hit.distance > maxDistance || Math.abs(hit.point.y - level) > BAND_TOLERANCE) continue;
    if (best && hit.distance >= best.distance) continue;
    const right = rightOf(cubicTangentXZ(c, hit.t));
    best = {
      segmentId: id,
      t: hit.t,
      point: hit.point,
      distance: hit.distance,
      lateral: (pos.x - hit.point.x) * right.x + (pos.z - hit.point.z) * right.z,
    };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ray casting
// ---------------------------------------------------------------------------

export interface Ray {
  origin: Vec3;
  /** Unit direction, away from the camera. */
  dir: Vec3;
}

/** One object the ray hit or passed close to. */
export interface SurfaceHit {
  kind: 'node' | 'segment';
  id: Id;
  /** Where the ray meets the object's surface, or its plane when it misses by a little. */
  point: Vec3;
  /** Distance along the ray. Smaller is nearer the camera. */
  s: number;
  /** 0 for a real hit, else how far outside the surface the ray passed, in metres. */
  miss: number;
}

/** Slack around small targets, in screen pixels. */
export const PICK_SLACK_PX = 7;
/** A surface this much higher than another, where both are under the cursor, hides it. */
const OCCLUDE_HEIGHT = 1.5;
/** Below the terrain by this much is a tunnel. */
const TUNNEL_DEPTH = 1.5;
/** Longest ground track searched, for a ray close to the horizon. */
const MAX_TRACK = 4000;
const TRACK_STEP = 48;
/** Widest road half width, sidewalks included, for the candidate search. */
const ROAD_PAD = 32;
/** Furthest a junction outline reaches from its node: the trim cap plus a road. */
const NODE_PAD = 110;

/** The camera ray through a client point. */
export function pickRay(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>): Ray | null {
  const { view } = ctx;
  if (view.pickRay) return view.pickRay(e.x, e.y);
  // A view with no camera access: two planes give the line.
  const a = view.pickPlane(e.x, e.y, 200);
  const b = view.pickPlane(e.x, e.y, 0);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  return { origin: a, dir: { x: dx / len, y: dy / len, z: dz / len } };
}

/** Where the ray crosses height y, or null when it never does in front of the camera. */
export function rayAtY(ray: Ray, y: number): { point: Vec3; s: number } | null {
  if (Math.abs(ray.dir.y) < 1e-9) return null;
  const s = (y - ray.origin.y) / ray.dir.y;
  if (s < 0) return null;
  return { point: { x: ray.origin.x + ray.dir.x * s, y, z: ray.origin.z + ray.dir.z * s }, s };
}

/** Metres covered by one screen pixel at height y under the cursor. */
export function metresPerPixel(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, y: number): number {
  const a = ctx.view.pickPlane(e.x, e.y, y);
  const b = ctx.view.pickPlane(e.x + 10, e.y, y);
  if (!a || !b) return 0.25;
  return Math.min(50, distXZ(a, b) / 10);
}

function isUnderground(ctx: ToolContext): boolean {
  return ctx.view.getUnderground?.() ?? false;
}

function hiddenTunnel(p: Vec3, underground: boolean): boolean {
  return !underground && p.y - terrainHeight(p.x, p.z) < -TUNNEL_DEPTH;
}

/** Ids near the ray's ground track between the highest and lowest roads. */
function candidates(net: RoadNetwork, ray: Ray): { segments: Set<Id>; nodes: Set<Id> } {
  const segments = new Set<Id>();
  const nodes = new Set<Id>();
  const levels = heightLevels(net);
  const top = rayAtY(ray, levels[0] + 3);
  const bottom = rayAtY(ray, levels[levels.length - 1] - 3);
  const a = top?.point ?? (ray.origin.y < levels[0] + 3 ? ray.origin : null);
  if (!a) return { segments, nodes };
  let b = bottom?.point;
  if (!b) b = { x: a.x + ray.dir.x * MAX_TRACK, y: 0, z: a.z + ray.dir.z * MAX_TRACK };
  let len = distXZ(a, b);
  if (len > MAX_TRACK) {
    const k = MAX_TRACK / len;
    b = { x: a.x + (b.x - a.x) * k, y: 0, z: a.z + (b.z - a.z) * k };
    len = MAX_TRACK;
  }
  const steps = Math.max(1, Math.ceil(len / TRACK_STEP));
  for (let i = 0; i < steps; i++) {
    const x0 = a.x + ((b.x - a.x) * i) / steps;
    const z0 = a.z + ((b.z - a.z) * i) / steps;
    const x1 = a.x + ((b.x - a.x) * (i + 1)) / steps;
    const z1 = a.z + ((b.z - a.z) * (i + 1)) / steps;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    for (const id of net.segmentsInRegion({ minX: minX - ROAD_PAD, minZ: minZ - ROAD_PAD, maxX: maxX + ROAD_PAD, maxZ: maxZ + ROAD_PAD }, true)) {
      segments.add(id);
    }
    for (const id of net.nodesInRegion({ minX: minX - NODE_PAD, minZ: minZ - NODE_PAD, maxX: maxX + NODE_PAD, maxZ: maxZ + NODE_PAD })) {
      nodes.add(id);
    }
  }
  return { segments, nodes };
}

/** The best hit on one road surface, or null when the ray passes further than `slack` from it. */
function castSegment(net: RoadNetwork, id: Id, ray: Ray, slack: number, underground: boolean): SurfaceHit | null {
  const geom = net.segmentGeom(id);
  const st = geom?.stations;
  if (!st || st.length < 2) return null;
  const half = totalHalfWidth(net.roadTypeOf(id));
  let best: SurfaceHit | null = null;
  for (let i = 0; i + 1 < st.length; i++) {
    const p0 = st[i].pos;
    const p1 = st[i + 1].pos;
    if (hiddenTunnel(p0, underground) && hiddenTunnel(p1, underground)) continue;
    const ax = p1.x - p0.x;
    const az = p1.z - p0.z;
    const len = Math.hypot(ax, az);
    if (len < 1e-6) continue;
    // Meet the quad's height where the ray crosses it, refined once along a slope.
    let y = (p0.y + p1.y) / 2;
    let hit = rayAtY(ray, y);
    if (!hit) continue;
    for (let k = 0; k < 2; k++) {
      const f = Math.max(0, Math.min(1, ((hit.point.x - p0.x) * ax + (hit.point.z - p0.z) * az) / (len * len)));
      const ny = p0.y + (p1.y - p0.y) * f;
      if (Math.abs(ny - y) < 0.01) break;
      y = ny;
      const again = rayAtY(ray, y);
      if (!again) break;
      hit = again;
    }
    const dx = hit.point.x - p0.x;
    const dz = hit.point.z - p0.z;
    const u = (dx * ax + dz * az) / len;
    const along = u < 0 ? -u : u > len ? u - len : 0;
    if (along > slack) continue;
    // Lateral from a right vector blended between the two stations.
    const f = Math.max(0, Math.min(1, u / len));
    const rx = st[i].right.x * (1 - f) + st[i + 1].right.x * f;
    const rz = st[i].right.z * (1 - f) + st[i + 1].right.z * f;
    const rl = Math.hypot(rx, rz) || 1;
    const cx = p0.x + (ax * f);
    const cz = p0.z + (az * f);
    const v = ((hit.point.x - cx) * rx + (hit.point.z - cz) * rz) / rl;
    const side = Math.max(0, Math.abs(v) - half);
    const miss = Math.hypot(side, along);
    if (miss > slack) continue;
    if (!best || miss < best.miss || (miss === best.miss && hit.s < best.s)) {
      best = { kind: 'segment', id, point: hit.point, s: hit.s, miss };
    }
  }
  return best;
}

function castNode(net: RoadNetwork, id: Id, ray: Ray, slack: number, underground: boolean): SurfaceHit | null {
  const node = net.getNode(id);
  const geom = net.nodeGeom(id);
  if (!node || !geom || geom.kind === 'empty') return null;
  if (hiddenTunnel(node.pos, underground)) return null;
  const hit = rayAtY(ray, node.pos.y);
  if (!hit) return null;
  let miss: number;
  if (geom.outline.length >= 3) {
    miss = pointInPolygon(hit.point, geom.outline) ? 0 : distToPolyline(hit.point, [...geom.outline, geom.outline[0]]);
  } else {
    miss = Math.max(0, distXZ(hit.point, node.pos) - nodeReach(net, id));
  }
  if (miss > slack) return null;
  return { kind: 'node', id, point: hit.point, s: hit.s, miss };
}

const castCache = new WeakMap<RoadNetwork, { key: string; hits: SurfaceHit[] }>();

/**
 * Everything the ray hits, or passes within `slackPx` screen pixels of, plus
 * `slackMetres`. One entry per object.
 */
export function castRay(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, slackMetres = 0, slackPx = PICK_SLACK_PX): SurfaceHit[] {
  const { net } = ctx;
  const ray = pickRay(ctx, e);
  if (!ray) return [];
  const underground = isUnderground(ctx);
  const o = ray.origin;
  const d = ray.dir;
  const key = `${net.version}|${o.x},${o.y},${o.z}|${d.x},${d.y},${d.z}|${underground}|${slackMetres}|${slackPx}`;
  const cached = castCache.get(net);
  if (cached && cached.key === key) return cached.hits;
  const found = candidates(net, ray);
  const hits: SurfaceHit[] = [];
  // Slack scales with distance from the camera, so take it at each candidate's height.
  const slackAt = (y: number) => slackMetres + slackPx * metresPerPixel(ctx, e, y);
  const ground = slackAt(0);
  for (const id of found.segments) {
    const hit = castSegment(net, id, ray, ground, underground);
    if (hit) {
      // Recheck with the slack at the road's own height.
      if (hit.miss === 0 || hit.miss <= slackAt(hit.point.y)) hits.push(hit);
    }
  }
  for (const id of found.nodes) {
    const y = net.getNode(id)?.pos.y ?? 0;
    const hit = castNode(net, id, ray, slackAt(y), underground);
    if (hit) hits.push(hit);
  }
  castCache.set(net, { key, hits });
  return hits;
}

/** The nearest real hit of anything. */
function topHit(hits: readonly SurfaceHit[]): SurfaceHit | null {
  let top: SurfaceHit | null = null;
  for (const h of hits) if (h.miss === 0 && (!top || h.s < top.s)) top = h;
  return top;
}

/**
 * The best accepted hit: a real hit nearest the camera, else the closest near miss.
 * Either loses to a surface clearly above it under the cursor, such as a bridge.
 */
export function chooseHit(hits: readonly SurfaceHit[], accept: (h: SurfaceHit) => boolean): SurfaceHit | null {
  const top = topHit(hits);
  const visible = (h: SurfaceHit) => !top || top === h || top.point.y <= h.point.y + OCCLUDE_HEIGHT;
  let best: SurfaceHit | null = null;
  for (const h of hits) {
    if (h.miss !== 0 || !accept(h) || !visible(h)) continue;
    if (!best || h.s < best.s) best = h;
  }
  if (best) return best;
  for (const h of hits) {
    if (!accept(h) || !visible(h)) continue;
    if (!best || h.miss < best.miss || (h.miss === best.miss && h.s < best.s)) best = h;
  }
  return best;
}

/** The road surface under the cursor. `slack` widens the hit area in metres, on top of a few pixels. */
export function pickRoad(
  ctx: ToolContext,
  e: Pick<ToolPointer, 'x' | 'y'>,
  slack = 0,
  accept: (id: Id) => boolean = () => true,
): PickedRoad | null {
  const { net } = ctx;
  const hit = chooseHit(castRay(ctx, e, slack), (h) => h.kind === 'segment' && accept(h.id));
  if (!hit) return null;
  const c = net.cubicOf(hit.id);
  const near = closestPointOnCubic(c, hit.point);
  const right = rightOf(cubicTangentXZ(c, near.t));
  return {
    segmentId: hit.id,
    t: near.t,
    point: near.point,
    distance: near.distance,
    lateral: (hit.point.x - near.point.x) * right.x + (hit.point.z - near.point.z) * right.z,
    raw: hit.point,
  };
}

/** Radius of the junction surface around a node. */
export function nodeReach(net: RoadNetwork, id: Id): number {
  const node = net.getNode(id);
  if (!node) return 0;
  let r = 3;
  for (const seg of node.segments) r = Math.max(r, totalHalfWidth(net.roadTypeOf(seg)));
  return r + 1.5;
}

/**
 * The node under the cursor: inside its junction outline, or near a node with no
 * surface of its own such as a dead end. `accept` filters candidates.
 */
export function pickNode(
  ctx: ToolContext,
  e: Pick<ToolPointer, 'x' | 'y'>,
  accept: (id: Id) => boolean = () => true,
): Id | null {
  return pickNodeHit(ctx, e, accept)?.id ?? null;
}

/** As pickNode, with where the ray met it. */
export function pickNodeHit(
  ctx: ToolContext,
  e: Pick<ToolPointer, 'x' | 'y'>,
  accept: (id: Id) => boolean = () => true,
): SurfaceHit | null {
  return chooseHit(castRay(ctx, e), (h) => h.kind === 'node' && accept(h.id));
}

/** Nodes whose position the ray passes within `reach` metres of, at each node's own height. */
export function nodesNearRay(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, reach: number): { id: Id; point: Vec3; d: number }[] {
  const ray = pickRay(ctx, e);
  if (!ray) return [];
  const out: { id: Id; point: Vec3; d: number }[] = [];
  const underground = isUnderground(ctx);
  for (const id of candidates(ctx.net, ray).nodes) {
    const node = ctx.net.getNode(id)!;
    if (hiddenTunnel(node.pos, underground)) continue;
    const hit = rayAtY(ray, node.pos.y);
    if (!hit) continue;
    const d = distXZ(hit.point, node.pos);
    if (d <= reach) out.push({ id, point: hit.point, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

export function isJunctionNode(net: RoadNetwork, id: Id): boolean {
  return net.nodeGeom(id)?.kind === 'junction';
}

/** World position of an endpoint's marker. */
export function endpointPosition(net: RoadNetwork, ep: TrafficEndpoint): Vec3 | null {
  if (ep.nodeId !== null) return net.getNode(ep.nodeId)?.pos ?? null;
  if (ep.segmentId === null || !net.getSegment(ep.segmentId)) return null;
  const c = net.cubicOf(ep.segmentId);
  const p = cubicPoint(c, ep.t);
  const right = rightOf(cubicTangentXZ(c, ep.t));
  const off = (totalHalfWidth(net.roadTypeOf(ep.segmentId)) + 6) * ep.side;
  return { x: p.x + right.x * off, y: p.y, z: p.z + right.z * off };
}

/** The traffic endpoint marker under the cursor. */
export function pickEndpoint(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, reach = 8): Id | null {
  const { net, view } = ctx;
  let best: Id | null = null;
  let bestD = reach;
  for (const ep of net.endpoints) {
    const pos = endpointPosition(net, ep);
    if (!pos) continue;
    const raw = view.pickPlane(e.x, e.y, pos.y);
    if (!raw) continue;
    const d = distXZ(pos, raw);
    if (d <= bestD) {
      best = ep.id;
      bestD = d;
    }
  }
  return best;
}

function pointInPolygon(p: Vec3, poly: readonly Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distToPolyline(p: Vec3, pts: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(a.x + dx * u - p.x, a.z + dz * u - p.z);
    if (d < best) best = d;
  }
  return best;
}

export function decalHit(decal: Decal, raw: Vec3, slack = 1.5): boolean {
  if (decal.points.length === 0) return false;
  if (decal.kind === 'fill' || decal.kind === 'hatch') {
    return pointInPolygon(raw, decal.points) || distToPolyline(raw, [...decal.points, decal.points[0]]) <= slack;
  }
  if (decal.points.length === 1) return distXZ(decal.points[0], raw) <= Math.max(3, decal.width + slack);
  return distToPolyline(raw, decal.points) <= decal.width / 2 + slack;
}

/** The decal under the cursor. Later decals sit on top. */
export function pickDecal(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>): Id | null {
  const { net, view } = ctx;
  for (let i = net.decals.length - 1; i >= 0; i--) {
    const d = resolveDecal(net, net.decals[i]);
    if (d.points.length === 0) continue;
    const raw = view.pickPlane(e.x, e.y, d.points[0].y);
    if (raw && decalHit(d, raw)) return d.id;
  }
  return null;
}
