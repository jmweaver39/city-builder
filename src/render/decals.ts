/** Free-form paint from the Paint tool, every DecalKind including text. */
import * as THREE from 'three';
import type { Decal, Id, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { PaintBuf, PAINT_SCHEMA, ChunkBatch, type LinePoint } from './batch';
import { resolveDecal } from '../core/roadPaint';
import { BIAS_DECAL, DOUBLE_GAP, LINE_WIDTH, MARK_LIFT, PAINT_COL, ROAD_LIFT, strokesOf } from './constants';
import { arrowShape, paintCrosswalk, paintTeeth, placeStamp } from './markings';
import { makePaintMaterial, type Shared } from './materials';
import { makeTextTexture } from './textures';

/** Polyline to ribbon points, with mitred side vectors and a shift to the right. */
function polyline(points: readonly Vec3[], shift = 0): LinePoint[] {
  const out: LinePoint[] = [];
  const n = points.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l;
    const rz = dx / l;
    if (i > 0) u += Math.hypot(p.x - prev.x, p.z - prev.z);
    out.push({ x: p.x + rx * shift, y: p.y + ROAD_LIFT, z: p.z + rz * shift, rx, rz, u });
  }
  return out;
}

function lifted(p: Vec3): Vec3 {
  return { x: p.x, y: p.y + ROAD_LIFT, z: p.z };
}

/** Diagonal stripes clipped to a polygon, plus its outline. */
function hatch(buf: PaintBuf, poly: readonly Vec3[], width: number, color: readonly [number, number, number]): void {
  const n = poly.length;
  if (n < 3) return;
  const closed = [...poly, poly[0]];
  buf.ribbon(polyline(closed), Math.max(0.12, width), color, 0, 1);
  const ca = Math.SQRT1_2;
  // Stripe coordinate v = (x + z) / sqrt2. Stripes run along (1, -1).
  const vOf = (p: Vec3) => (p.x + p.z) * ca;
  const uOf = (p: Vec3) => (p.x - p.z) * ca;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of poly) {
    vMin = Math.min(vMin, vOf(p));
    vMax = Math.max(vMax, vOf(p));
  }
  const step = 1.6;
  const y = poly[0].y + ROAD_LIFT;
  for (let v = vMin + step / 2; v < vMax; v += step) {
    const hits: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = closed[i + 1];
      const va = vOf(a);
      const vb = vOf(b);
      if ((va < v) === (vb < v)) continue;
      const f = (v - va) / (vb - va);
      hits.push(uOf(a) + (uOf(b) - uOf(a)) * f);
    }
    hits.sort((p, q) => p - q);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const x0 = (hits[k] + v) * ca;
      const z0 = (v - hits[k]) * ca;
      const x1 = (hits[k + 1] + v) * ca;
      const z1 = (v - hits[k + 1]) * ca;
      buf.bar(x0, y, z0, x1, y, z1, 0.3, color);
    }
  }
}

function fill(buf: PaintBuf, poly: readonly Vec3[], color: readonly [number, number, number]): void {
  if (poly.length < 3) return;
  const contour = poly.map((p) => new THREE.Vector2(p.x, p.z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const coords: number[] = [];
  for (const f of faces) for (const i of f) coords.push(poly[i].x, poly[i].z);
  buf.stamp(coords, poly[0].y + ROAD_LIFT, color);
}

function forwardOf(rotation: number): { fx: number; fz: number } {
  return { fx: -Math.sin(rotation), fz: -Math.cos(rotation) };
}

function buildDecal(raw: Decal, net: RoadNetwork, buf: PaintBuf): void {
  const d = resolveDecal(net, raw);
  const color = PAINT_COL[d.color];
  const pts = d.points;
  if (!pts.length) return;
  const p0 = pts[0];
  const w = d.width > 0 ? d.width : 0.2;
  const line = pts.length >= 2 ? polyline(pts) : null;
  const end = pts[pts.length - 1];
  // A stamp's arrows are 5 m long at width 1.
  const stamp = (l: boolean, s: boolean, r: boolean) => {
    const { fx, fz } = forwardOf(d.rotation);
    buf.stamp(placeStamp(arrowShape(l, s, r, false), p0.x, p0.z, fx, fz, w), p0.y + ROAD_LIFT, color);
  };
  if (d.lineStyle && d.kind === 'line') {
    const scale = w / LINE_WIDTH;
    for (const k of strokesOf(d.lineStyle)) buf.ribbon(polyline(pts, k.shift * scale), w, color, k.period, k.duty);
    return;
  }
  switch (d.kind) {
    case 'line':
      if (line) buf.ribbon(line, w, color, 0, 1);
      break;
    case 'dashedLine':
      if (line) buf.ribbon(line, w, color, 6, 0.5);
      break;
    case 'doubleLine':
      if (pts.length >= 2) {
        const g = (w + DOUBLE_GAP) / 2;
        buf.ribbon(polyline(pts, -g), w, color, 0, 1);
        buf.ribbon(polyline(pts, g), w, color, 0, 1);
      }
      break;
    case 'stopLine':
      if (pts.length >= 2) buf.ribbon(polyline(pts), Math.max(w, 0.45), color, 0, 1);
      else {
        const { fx, fz } = forwardOf(d.rotation);
        const rx = -fz;
        const rz = fx;
        const a = lifted(p0);
        buf.bar(a.x - rx * 2, a.y, a.z - rz * 2, a.x + rx * 2, a.y, a.z + rz * 2, Math.max(w, 0.45), color);
      }
      break;
    case 'hatch':
      hatch(buf, pts, 0.15, color);
      break;
    case 'fill':
      fill(buf, pts, color);
      break;
    case 'crosswalk': {
      const depth = Math.max(w, 2);
      if (pts.length >= 2) paintCrosswalk(buf, lifted(p0), lifted(end), depth, 'zebra', color);
      else {
        const { fx, fz } = forwardOf(d.rotation);
        const rx = -fz;
        const rz = fx;
        const a = lifted(p0);
        paintCrosswalk(buf, { x: a.x - rx * 4, y: a.y, z: a.z - rz * 4 }, { x: a.x + rx * 4, y: a.y, z: a.z + rz * 4 }, depth, 'zebra', color);
      }
      break;
    }
    case 'yieldTriangles': {
      const { fx, fz } = forwardOf(d.rotation);
      if (pts.length >= 2) paintTeeth(buf, lifted(p0), lifted(end), -fx, -fz, color, Math.max(w, 0.6));
      else {
        const rx = -fz;
        const rz = fx;
        const a = lifted(p0);
        paintTeeth(buf, { x: a.x - rx * 2, y: a.y, z: a.z - rz * 2 }, { x: a.x + rx * 2, y: a.y, z: a.z + rz * 2 }, -fx, -fz, color, Math.max(w, 0.6));
      }
      break;
    }
    case 'arrowStraight':
      stamp(false, true, false);
      break;
    case 'arrowLeft':
      stamp(true, false, false);
      break;
    case 'arrowRight':
      stamp(false, false, true);
      break;
    case 'arrowStraightLeft':
      stamp(true, true, false);
      break;
    case 'arrowStraightRight':
      stamp(false, true, true);
      break;
    case 'text':
      break;
  }
}

interface TextDecal {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  material: THREE.Material;
  sig: string;
}

export class DecalLayer {
  readonly group = new THREE.Group();
  private batch: ChunkBatch;
  private known = new Set<Id>();
  private drawn = new Map<Id, string>();
  private text = new Map<Id, TextDecal>();
  private quad = new THREE.PlaneGeometry(1, 1);
  private material: THREE.Material;

  constructor(
    private readonly net: RoadNetwork,
    private readonly shared: Shared,
    private readonly anisotropy: number,
  ) {
    this.material = makePaintMaterial(shared, { bias: BIAS_DECAL, lift: MARK_LIFT + 0.004, fade: false });
    this.batch = new ChunkBatch(PAINT_SCHEMA, this.material, { renderOrder: 6, receiveShadow: true, chunkSize: 500 });
    this.group.add(this.batch.group);
  }

  /** True when a change to the roads can move paint. */
  get followsRoads(): boolean {
    return this.net.decals.some((d) => d.road);
  }

  private signatureOf(d: Decal): string {
    const r = resolveDecal(this.net, d);
    const ends = r.points.length ? [r.points[0], r.points[Math.floor(r.points.length / 2)], r.points[r.points.length - 1]] : [];
    return JSON.stringify([d.kind, d.lineStyle, d.color, d.width, r.rotation, r.points.length, ends]);
  }

  rebuild(): void {
    const seen = new Set<Id>();
    const textSeen = new Set<Id>();
    for (const d of this.net.decals) {
      seen.add(d.id);
      if (d.kind === 'text') {
        this.batch.set(d.id, null);
        textSeen.add(d.id);
        this.syncText(d);
        continue;
      }
      // Road paint moves with its road, so compare what it would draw.
      const sig = this.signatureOf(d);
      if (this.drawn.get(d.id) === sig) continue;
      this.drawn.set(d.id, sig);
      const buf = new PaintBuf();
      buildDecal(d, this.net, buf);
      this.batch.set(d.id, buf.toPiece());
    }
    for (const id of this.known) {
      if (seen.has(id)) continue;
      this.batch.set(id, null);
      this.drawn.delete(id);
    }
    for (const [id, t] of this.text) {
      if (textSeen.has(id)) continue;
      this.dropText(t);
      this.text.delete(id);
    }
    this.known = seen;
    this.batch.flush();
  }

  private dropText(t: TextDecal): void {
    this.group.remove(t.mesh);
    t.texture.dispose();
    t.material.dispose();
  }

  private syncText(raw: Decal): void {
    const d = resolveDecal(this.net, raw);
    const p = d.points[0];
    if (!p) return;
    const color = PAINT_COL[d.color];
    const sig = `${d.text}|${d.color}|${d.width}|${p.x},${p.y},${p.z}|${d.rotation}`;
    const old = this.text.get(d.id);
    if (old?.sig === sig) return;
    if (old) this.dropText(old);
    const { texture, aspect } = makeTextTexture(d.text ?? '', this.anisotropy);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.65,
      metalness: 0,
      map: texture,
      transparent: true,
      depthWrite: false,
      color: new THREE.Color(color[0], color[1], color[2]),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace(
        '#include <logdepthbuf_fragment>',
        /* glsl */ `#include <logdepthbuf_fragment>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_FragDepth -= ${BIAS_DECAL.toExponential(3)};
#endif
`,
      );
    };
    material.customProgramCacheKey = () => 'cl-text-decal';
    const mesh = new THREE.Mesh(this.quad, material);
    // Width is the letter height, stretched along travel like real road text.
    const h = d.width > 0 ? d.width : 2;
    mesh.scale.set(h * aspect, h * 1.6, 1);
    mesh.position.set(p.x, p.y + ROAD_LIFT + MARK_LIFT + 0.004, p.z);
    mesh.rotation.set(-Math.PI / 2, d.rotation, 0, 'YXZ');
    mesh.renderOrder = 7;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.text.set(d.id, { mesh, texture, material, sig });
  }

  dispose(): void {
    for (const t of this.text.values()) this.dropText(t);
    this.text.clear();
    this.batch.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
