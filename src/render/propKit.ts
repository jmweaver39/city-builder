/**
 * Small geometry kit for close-up props and people: boxes, cylinders, discs and
 * blobs with vertex colours, plus a per-vertex flag saying which parts take the
 * instance's tint. Also the shared material patch that tints those parts and fades
 * everything out with a dither beyond a view distance.
 */
import * as THREE from 'three';
import { hexRGB, type RGB } from './constants';
import { worldMaterial } from './style';

export class PropGeo {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  tint: number[] = [];
  /** Extra per-vertex value, free for a model's own use (people use it for body parts). */
  part: number[] = [];
  private curPart = 0;

  setPart(p: number): this {
    this.curPart = p;
    return this;
  }

  private tri(a: number[], b: number[], c: number[], color: RGB, t: number, normals?: number[][]): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const pts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const p = pts[k];
      this.pos.push(p[0], p[1], p[2]);
      if (normals) this.nor.push(normals[k][0], normals[k][1], normals[k][2]);
      else this.nor.push(nx, ny, nz);
      this.col.push(color[0], color[1], color[2]);
      this.tint.push(t);
      this.part.push(this.curPart);
    }
  }

  quad(a: number[], b: number[], c: number[], d: number[], color: RGB, t = 0): void {
    this.tri(a, b, c, color, t);
    this.tri(a, c, d, color, t);
  }

  /** Quad with its own normal at each corner, for smooth round surfaces. */
  private quadN(a: number[], b: number[], c: number[], d: number[], na: number[], nb: number[], nc: number[], nd: number[], color: RGB, t: number): void {
    this.tri(a, b, c, color, t, [na, nb, nc]);
    this.tri(a, c, d, color, t, [na, nc, nd]);
  }

  /** Axis-aligned box from its centre and half sizes, turned by `yaw` about its centre. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, color: RGB, t = 0, yaw = 0, bottom = false): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const P = (x: number, y: number, z: number) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    this.quad(v[0], v[3], v[2], v[1], color, t);
    this.quad(v[4], v[5], v[6], v[7], color, t);
    this.quad(v[0], v[4], v[7], v[3], color, t);
    this.quad(v[1], v[2], v[6], v[5], color, t);
    this.quad(v[3], v[7], v[6], v[2], color, t);
    if (bottom) this.quad(v[0], v[1], v[5], v[4], color, t);
  }

  /** Upright cylinder or cone frustum from y0 to y1. */
  cyl(cx: number, y0: number, cz: number, r0: number, y1: number, r1: number, color: RGB, t = 0, n = 8, cap = true): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, r: number, y: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      // Smooth radial normals, tilted by the taper, so poles and posts are round, not faceted.
      const slope = (r0 - r1) / Math.max(1e-4, y1 - y0);
      const nrm = (a: number) => {
        const l = Math.hypot(1, slope);
        return [Math.cos(a) / l, slope / l, Math.sin(a) / l];
      };
      this.quadN(p(a0, r0, y0), p(a0, r1, y1), p(a1, r1, y1), p(a1, r0, y0), nrm(a0), nrm(a0), nrm(a1), nrm(a1), color, t);
      if (cap && r1 > 0) this.tri([cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1), color, t);
    }
  }

  /** Cylinder lying along x, from x0 to x1, centred at (cy, cz). */
  cylX(x0: number, x1: number, cy: number, cz: number, r: number, color: RGB, t = 0, n = 10): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (x: number, a: number) => [x, cy + Math.cos(a) * r, cz + Math.sin(a) * r];
      const n0 = [0, Math.cos(a0), Math.sin(a0)];
      const n1 = [0, Math.cos(a1), Math.sin(a1)];
      this.quadN(p(x0, a0), p(x0, a1), p(x1, a1), p(x1, a0), n0, n1, n1, n0, color, t);
      this.tri([x0, cy, cz], p(x0, a1), p(x0, a0), color, t);
      this.tri([x1, cy, cz], p(x1, a0), p(x1, a1), color, t);
    }
  }

  /** Flat disc lying at height y. */
  disc(cx: number, y: number, cz: number, r: number, color: RGB, t = 0, n = 12, sx = 1): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      this.tri([cx, y, cz], [cx + Math.cos(a1) * r * sx, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r * sx, y, cz + Math.sin(a0) * r], color, t);
    }
  }

  /** Flat rectangle lying at height y. */
  flat(cx: number, y: number, cz: number, hx: number, hz: number, color: RGB, t = 0, yaw = 0): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const P = (x: number, z: number) => [cx + x * c + z * s, y, cz - x * s + z * c];
    this.quad(P(-hx, -hz), P(-hx, hz), P(hx, hz), P(hx, -hz), color, t);
  }

  /** Low round blob (an octahedron squashed and stretched), for heads, shrubs and rocks. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: RGB, t = 0, rings = 3, segs = 6): void {
    const pt = (i: number, j: number) => {
      const th = (i / rings) * Math.PI;
      const ph = (j / segs) * Math.PI * 2;
      return [cx + Math.sin(th) * Math.cos(ph) * rx, cy + Math.cos(th) * ry, cz + Math.sin(th) * Math.sin(ph) * rz];
    };
    // Ellipsoid normals, so heads, shrubs and rocks shade smoothly.
    const nrm = (q: number[]) => {
      const x = (q[0] - cx) / (rx * rx);
      const y = (q[1] - cy) / (ry * ry);
      const z = (q[2] - cz) / (rz * rz);
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = pt(i, j);
        const b = pt(i + 1, j);
        const c = pt(i + 1, j + 1);
        const d = pt(i, j + 1);
        if (i === 0) this.tri(a, c, b, color, t, [nrm(a), nrm(c), nrm(b)]);
        else if (i === rings - 1) this.tri(a, d, b, color, t, [nrm(a), nrm(d), nrm(b)]);
        else this.quadN(a, d, c, b, nrm(a), nrm(d), nrm(c), nrm(b), color, t);
      }
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export const C = (hex: number): RGB => hexRGB(hex);

export interface FadeUniforms {
  uFadeNear: { value: number };
  uFadeFar: { value: number };
}

/**
 * The prop material: vertex colours, the instance colour applied only to tinted
 * parts, and a dithered fade between uFadeNear and uFadeFar of view depth.
 */
export function propMaterial(
  fade: FadeUniforms,
  opts: { decal?: boolean; extraVertex?: string; extraVertexMain?: string; key?: string; uniforms?: Record<string, { value: unknown }> } = {},
): THREE.MeshStandardMaterial {
  const m = worldMaterial({ vertexColors: true, roughness: 0.82 });
  if (opts.decal) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  m.onBeforeCompile = (s) => {
    s.uniforms.uFadeNear = fade.uFadeNear;
    s.uniforms.uFadeFar = fade.uFadeFar;
    for (const [k, u] of Object.entries(opts.uniforms ?? {})) s.uniforms[k] = u;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aTint;\nattribute float aPart;\nvarying float vViewDepth;\n${opts.extraVertex ?? ''}`)
      .replace(
        '#include <color_vertex>',
        /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color.rgb;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix( vColor.rgb, vColor.rgb * instanceColor.rgb, aTint );
#endif
`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.extraVertexMain ?? ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\nvViewDepth = -mvPosition.z;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uFadeNear;\nuniform float uFadeFar;\nvarying float vViewDepth;`)
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `#include <clipping_planes_fragment>
{
  float fadeK = 1.0 - smoothstep( uFadeNear, uFadeFar, vViewDepth );
  if ( fadeK < 0.999 ) {
    float h = fract( sin( dot( floor( gl_FragCoord.xy ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    if ( h > fadeK ) discard;
  }
}`,
      );
  };
  const onCompile = m.onBeforeCompile;
  m.onBeforeCompile = (s, r) => {
    onCompile.call(m, s, r);
    // Tinted parts are painted metal or plastic: a little sheen. The rest stays matte.
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying float vPaint;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPaint = aTint;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPaint;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.42, vPaint);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.25, vPaint);');
  };
  m.customProgramCacheKey = () => `cl-prop-${opts.key ?? 'base'}${opts.decal ? '-decal' : ''}`;
  return m;
}
