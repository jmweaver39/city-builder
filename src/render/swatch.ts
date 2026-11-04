/**
 * Marking previews for the panels, drawn by the game's own renderer: the same
 * paint geometry (paint.ts), the same paint shader and the same road surface
 * shader, lit like the scene, rendered top-down into a small target and handed
 * back as an image. So a preview is the marking, not a drawing of it.
 */
import * as THREE from 'three';
import type { DecalKind, LineStyleSpec } from '../core/types';
import { arrowShape } from '../core/paintStandard';
import { PAINT_SCHEMA, PaintBuf, SURF_SCHEMA, SurfBuf, type AttrSpec, type Piece } from './batch';
import { COL, KIND_ASPHALT, PAINT_COL } from './constants';
import { makePaintMaterial, makeSurfaceMaterial, type Shared } from './materials';
import { paintArea, paintCrossing, paintSpecAlong, placeStamp, type AreaLook } from './paint';

/** What a preview shows. */
export type SwatchSubject =
  | { kind: 'line'; spec: LineStyleSpec; speedKmh?: number }
  | { kind: 'crossing'; spec: LineStyleSpec }
  | { kind: 'area'; spec: AreaLook }
  | { kind: 'stamp'; decal: DecalKind; color: LineStyleSpec['color'] };

function geometryOf(piece: Piece, schema: AttrSpec[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  schema.forEach((s, i) => g.setAttribute(s.name, new THREE.BufferAttribute(piece.attrs[i], s.size)));
  g.setIndex(new THREE.BufferAttribute(piece.index, 1));
  return g;
}

/** Ground width in metres a subject is framed in (the height is half). */
function frameWidth(s: SwatchSubject): number {
  if (s.kind === 'line') return 16;
  if (s.kind === 'crossing') return s.spec.style === 'stopLine' || s.spec.style === 'sharkTeeth' ? 8 : 9;
  if (s.kind === 'area') return 9;
  return 8;
}

/** The paint of a subject, laid out round the origin, running along +x. */
function paintOf(s: SwatchSubject, w: number): PaintBuf {
  const buf = new PaintBuf();
  const h = w / 2;
  const y = 0;
  if (s.kind === 'line') {
    if (s.spec.style === 'sharkTeeth') paintSpecAlong(buf, [{ x: -w / 2 + 0.6, y, z: 0 }, { x: w / 2 - 0.6, y, z: 0 }], s.spec, 1);
    else if (s.spec.style.startsWith('crosswalk') || s.spec.style === 'stopLine') paintCrossing(buf, { x: 0, y, z: -h / 2 + 0.3 }, { x: 0, y, z: h / 2 - 0.3 }, s.spec);
    else paintSpecAlong(buf, [{ x: -w / 2 - 1, y, z: 0 }, { x: w / 2 + 1, y, z: 0 }], s.spec, 1, s.speedKmh ?? 50, -1.5);
  } else if (s.kind === 'crossing') {
    if (s.spec.style === 'sharkTeeth') paintSpecAlong(buf, [{ x: -w / 2 + 0.6, y, z: 0 }, { x: w / 2 - 0.6, y, z: 0 }], s.spec, 1);
    else paintCrossing(buf, { x: 0, y, z: -h / 2 + 0.2 }, { x: 0, y, z: h / 2 - 0.2 }, s.spec);
  } else if (s.kind === 'area') {
    const a = w / 2 - 0.8;
    const b = h / 2 - 0.5;
    paintArea(buf, [{ x: -a, y, z: -b }, { x: a, y, z: -b }, { x: a, y, z: b }, { x: -a, y, z: b }], y + 0.06, s.spec);
  } else {
    const k = s.decal;
    const l = k === 'arrowLeft' || k === 'arrowStraightLeft';
    const r = k === 'arrowRight' || k === 'arrowStraightRight';
    const st = k === 'arrowStraight' || k === 'arrowStraightLeft' || k === 'arrowStraightRight';
    // Arrows point along +x, as a driver reads them going right.
    buf.inLayer('symbol', () => buf.stamp(placeStamp(arrowShape(l, st, r, false), 0.3, 0, 1, 0, 1), y + 0.06, PAINT_COL[s.color]));
  }
  return buf;
}

// ACES filmic, as three.js applies it to the screen, so a preview matches the game.
function rrt(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

function aces(r: number, g: number, b: number, exposure: number): [number, number, number] {
  const e = exposure / 0.6;
  r *= e;
  g *= e;
  b *= e;
  const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fr = rrt(ir);
  const fg = rrt(ig);
  const fb = rrt(ib);
  const or = 1.60475 * fr - 0.53108 * fg - 0.07367 * fb;
  const og = -0.10208 * fr + 1.10813 * fg - 0.00605 * fb;
  const ob = -0.00327 * fr - 0.07276 * fg + 1.07602 * fb;
  return [Math.min(1, Math.max(0, or)), Math.min(1, Math.max(0, og)), Math.min(1, Math.max(0, ob))];
}

function toSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export class SwatchRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
  private readonly shared: Shared;
  private readonly paintMat: THREE.Material;
  private readonly roadMat: THREE.Material;
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly gl: THREE.WebGLRenderer,
    shared: Shared,
    private readonly lights: () => { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight },
  ) {
    // Own pixel scale (an orthographic view), everything else the scene's shared uniforms.
    this.shared = Object.assign(Object.create(Object.getPrototypeOf(shared)), shared, { uPxScale: { value: 1000 }, uCloud: { value: new THREE.Vector3(0, 0, 0) } }) as Shared;
    this.paintMat = makePaintMaterial(this.shared, { bias: 0, lift: 0.03 });
    this.paintMat.depthTest = false;
    this.roadMat = makeSurfaceMaterial(this.shared);
    this.camera.position.set(0, 50, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);
    this.sun.position.set(-20, 40, 12);
    this.scene.add(this.sun, this.hemi);
  }

  /** A data URL of the subject, `w` by `h` CSS pixels, drawn at twice that. */
  render(subject: SwatchSubject, w: number, h: number): string | null {
    const key = JSON.stringify([subject, w, h]);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pw = Math.round(w * 2);
    const ph = Math.round(h * 2);
    const width = frameWidth(subject);
    const height = (width * h) / w;
    const cam = this.camera;
    cam.left = -width / 2;
    cam.right = width / 2;
    cam.top = height / 2;
    cam.bottom = -height / 2;
    cam.updateProjectionMatrix();
    this.shared.uPxScale.value = 50 / (width / pw);
    const { sun, hemi } = this.lights();
    this.sun.color.copy(sun.color);
    this.sun.intensity = sun.intensity;
    this.hemi.color.copy(hemi.color);
    this.hemi.groundColor.copy(hemi.groundColor);
    this.hemi.intensity = hemi.intensity;

    // The road surface, with the road shader.
    const road = new SurfBuf();
    road.ru = 0;
    road.rv = 0;
    const style = { color: COL.asphalt, kind: KIND_ASPHALT, slot: 0, bias: 0 };
    const W = width;
    const H = height;
    road.flatQuad([-W, 0, H], [W, 0, H], [W, 0, -H], [-W, 0, -H], style);
    const roadPiece = road.toPiece();
    const paintPiece = paintOf(subject, width).toPiece();
    const meshes: THREE.Mesh[] = [];
    if (roadPiece) meshes.push(new THREE.Mesh(geometryOf(roadPiece, SURF_SCHEMA), this.roadMat));
    if (paintPiece) {
      const m = new THREE.Mesh(geometryOf(paintPiece, PAINT_SCHEMA), this.paintMat);
      m.renderOrder = 5;
      meshes.push(m);
    }
    for (const m of meshes) this.scene.add(m);

    const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: 4 });
    const prevTarget = this.gl.getRenderTarget();
    const prevClear = this.gl.getClearColor(new THREE.Color());
    const prevAlpha = this.gl.getClearAlpha();
    const prevShadow = this.gl.shadowMap.enabled;
    let url: string | null = null;
    try {
      this.gl.shadowMap.enabled = false;
      this.gl.setRenderTarget(target);
      this.gl.setClearColor(0x000000, 1);
      this.gl.clear();
      this.gl.render(this.scene, cam);
      const px = new Uint16Array(pw * ph * 4);
      this.gl.readRenderTargetPixels(target, 0, 0, pw, ph, px);
      const canvas = document.createElement('canvas');
      canvas.width = pw;
      canvas.height = ph;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(pw, ph);
        const half = (v: number) => THREE.DataUtils.fromHalfFloat(v);
        for (let yy = 0; yy < ph; yy++) {
          for (let xx = 0; xx < pw; xx++) {
            const src = ((ph - 1 - yy) * pw + xx) * 4;
            const dst = (yy * pw + xx) * 4;
            const [r, g, b] = aces(half(px[src]), half(px[src + 1]), half(px[src + 2]), this.gl.toneMappingExposure);
            img.data[dst] = toSrgb(r) * 255;
            img.data[dst + 1] = toSrgb(g) * 255;
            img.data[dst + 2] = toSrgb(b) * 255;
            img.data[dst + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        url = canvas.toDataURL();
      }
    } catch {
      url = null;
    } finally {
      this.gl.setRenderTarget(prevTarget);
      this.gl.setClearColor(prevClear, prevAlpha);
      this.gl.shadowMap.enabled = prevShadow;
      for (const m of meshes) {
        this.scene.remove(m);
        m.geometry.dispose();
      }
      target.dispose();
    }
    if (url) this.cache.set(key, url);
    return url;
  }

  dispose(): void {
    this.paintMat.dispose();
    this.roadMat.dispose();
    this.cache.clear();
  }
}
