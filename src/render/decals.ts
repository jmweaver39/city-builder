/**
 * Paint tool paint, every DecalKind including text, drawn through the shared paint
 * pipeline (paint.ts) in the looks of core/paintStandard.ts: a decal lane line is
 * the very geometry of an automatic one in the same place, dashed in the road's
 * own phase, and snapped onto the automatic line it is drawn near.
 */
import * as THREE from 'three';
import type { Decal, Id, Vec3 } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import { PaintBuf } from './batch';
import { bridgeBetween, piecePoints, resolveDecal } from '../core/roadPaint';
import { decalFill, decalLineRuns, decalLook, isArrowDecal, isLineDecal, roadSpeed } from '../core/paintCoherence';
import { resolvedStyle } from '../core/markingStyle';
import { ARROW, PAINT_MATERIAL, TEXT, arrowShape } from '../core/paintStandard';
import { PAINT_COL, ROAD_LIFT } from './constants';
import { segmentDashPhase } from './markings';
import { PAINT_ORDER, PaintBatches, StationPath, markingMaterial, paintArea, paintCrossing, paintRGB, paintRoadLine, paintSpecAlong, placeStamp, ribbonPoints } from './paint';
import type { Shared } from './materials';
import { makeTextTexture } from './textures';

function forwardOf(rotation: number): { fx: number; fz: number } {
  return { fx: -Math.sin(rotation), fz: -Math.cos(rotation) };
}

/** A line decal along roads: each piece in its road's frame and dash phase, bridges through junctions between. */
function roadLine(raw: Decal, net: RoadNetwork, buf: PaintBuf): boolean {
  const ref = raw.road;
  const look = decalLook(raw);
  if (!ref || !look || ref.offsetEnd !== undefined) return false;
  const runs = decalLineRuns(net, raw);
  if (!runs.length) return false;
  for (const r of runs) {
    const geom = net.segmentGeom(r.segmentId);
    const phase = segmentDashPhase(net, r.segmentId);
    if (!geom || !phase) continue;
    const spec = resolvedStyle(r.look, roadSpeed(net, r.segmentId));
    paintRoadLine(buf, new StationPath(geom.stations), r.s0, r.s1, r.offset, spec, phase, paintRGB(spec));
  }
  // Through junctions: the lane path or a smooth curve, dashed on from the piece before.
  const ends = ref.pieces.map((p) => piecePoints(net, p, p.offset ?? ref.offset));
  for (let i = 1; i < ref.pieces.length; i++) {
    const a = ends[i - 1];
    const b = ends[i];
    if (a.length < 1 || b.length < 1) continue;
    const mid = bridgeBetween(net, ref.pieces[i - 1], ref.pieces[i], a[a.length - 2], a[a.length - 1], b[0], b[1]);
    if (mid.length) paintSpecAlong(buf, [a[a.length - 1], ...mid, b[0]], look, 1, roadSpeed(net, ref.pieces[i].segmentId));
  }
  return true;
}

function buildDecal(raw: Decal, net: RoadNetwork, buf: PaintBuf): void {
  const d = resolveDecal(net, raw);
  const pts = d.points;
  if (!pts.length) return;
  const p0 = pts[0];
  const end = pts[pts.length - 1];
  const look = decalLook(raw);
  const speed = raw.road ? roadSpeed(net, raw.road.pieces[0].segmentId) : 50;
  // Two points across a lane or road, from a stamp's points or its rotation.
  const across = (half: number): [Vec3, Vec3] => {
    if (pts.length >= 2) return [p0, end];
    const { fx, fz } = forwardOf(d.rotation);
    return [
      { x: p0.x + fz * half, y: p0.y, z: p0.z - fx * half },
      { x: p0.x - fz * half, y: p0.y, z: p0.z + fx * half },
    ];
  };
  if (isLineDecal(raw)) {
    if (roadLine(raw, net, buf)) return;
    if (look && pts.length >= 2) paintSpecAlong(buf, pts, look, 1, speed);
    return;
  }
  if (isArrowDecal(raw)) {
    const k = raw.kind;
    const l = k === 'arrowLeft' || k === 'arrowStraightLeft';
    const r = k === 'arrowRight' || k === 'arrowStraightRight';
    const s = k === 'arrowStraight' || k === 'arrowStraightLeft' || k === 'arrowStraightRight';
    const { fx, fz } = forwardOf(d.rotation);
    const scale = d.width > 0 ? d.width : ARROW.scale;
    buf.inLayer('symbol', () => buf.stamp(placeStamp(arrowShape(l, s, r, false), p0.x, p0.z, fx, fz, scale), p0.y + ROAD_LIFT, PAINT_COL[d.color]));
    return;
  }
  switch (d.kind) {
    case 'hatch':
    case 'fill': {
      const fill = decalFill(raw);
      if (fill && pts.length >= 3) paintArea(buf, pts, pts[0].y + ROAD_LIFT, fill);
      break;
    }
    case 'crosswalk':
      if (look) {
        const [a, b] = across(4);
        paintCrossing(buf, a, b, look);
      }
      break;
    case 'stopLine':
      if (look) {
        const [a, b] = across(2);
        paintCrossing(buf, a, b, look);
      }
      break;
    case 'yieldTriangles':
      if (look) {
        const [a, b] = across(2);
        // Teeth point back at the driver coming towards the stamp.
        const { fx, fz } = forwardOf(d.rotation);
        const tip = -(b.z - a.z) * -fx + (b.x - a.x) * -fz >= 0 ? 1 : -1;
        paintSpecAlong(buf, [a, b], look, tip, speed);
      }
      break;
    case 'text':
      break;
  }
}

/** The paint of one decal, for previews and tests. */
export function decalPaint(net: RoadNetwork, d: Decal): PaintBuf {
  const buf = new PaintBuf();
  buildDecal(d, net, buf);
  return buf;
}

export { ribbonPoints };

interface TextDecal {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  material: THREE.Material;
  sig: string;
}

export class DecalLayer {
  readonly group = new THREE.Group();
  private batch: PaintBatches;
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
    // The one paint material and stacking order every marking uses.
    this.material = markingMaterial(shared);
    this.batch = new PaintBatches(this.material, { chunkSize: 500 });
    this.group.add(this.batch.group);
  }

  /** True when a change to the roads can move paint. */
  get followsRoads(): boolean {
    return this.net.decals.some((d) => d.road);
  }

  private signatureOf(d: Decal): string {
    const r = resolveDecal(this.net, d);
    const ends = r.points.length ? [r.points[0], r.points[Math.floor(r.points.length / 2)], r.points[r.points.length - 1]] : [];
    return JSON.stringify([d.kind, d.style, d.fill, d.lineStyle, d.color, d.width, r.rotation, r.points.length, ends, this.net.version]);
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
      this.batch.set(d.id, buf);
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
    const color = paintRGB({ color: d.color });
    const sig = `${d.text}|${d.color}|${d.width}|${p.x},${p.y},${p.z}|${d.rotation}`;
    const old = this.text.get(d.id);
    if (old?.sig === sig) return;
    if (old) this.dropText(old);
    const { texture, aspect } = makeTextTexture(d.text ?? '', this.anisotropy);
    const material = new THREE.MeshStandardMaterial({
      roughness: PAINT_MATERIAL.roughness,
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
  gl_FragDepth -= ${PAINT_MATERIAL.bias.toExponential(3)};
#endif
`,
      );
    };
    material.customProgramCacheKey = () => 'cl-text-decal';
    const mesh = new THREE.Mesh(this.quad, material);
    // Width is the letter height, stretched along travel like real road text.
    const h = d.width > 0 ? d.width : 2;
    mesh.scale.set(h * aspect, h * TEXT.stretch, 1);
    mesh.position.set(p.x, p.y + ROAD_LIFT + PAINT_MATERIAL.lift, p.z);
    mesh.rotation.set(-Math.PI / 2, d.rotation, 0, 'YXZ');
    mesh.renderOrder = PAINT_ORDER.symbol;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.text.set(d.id, { mesh, texture, material, sig });
  }

  dispose(): void {
    for (const t of this.text.values()) this.dropText(t);
    this.text.clear();
    this.batch.dispose();
    this.quad.dispose();
  }
}
