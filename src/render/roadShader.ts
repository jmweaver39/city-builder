/**
 * GLSL for detailed road surfaces, spliced into the surface material
 * (materials.ts). The ROAD_DETAIL define picks the level (roadDetail.ts):
 *   0  one small texture, no normal map, no wear
 *   1  two-scale asphalt and concrete textures with normals, wheel paths, seams, slab joints
 *   2  plus sealed cracks, patches, oil, tyre marks, deck joints, textured structures
 *   3  as 2, fed with the largest textures
 *
 * Inputs (see roads.ts, HintFn, for what the hints mean per kind):
 *   vWorld world position, vRoad road coordinates, vSurf hints, vSlot overlay slot.
 * Everything here writes into the material's `diffuseColor`, `gRough` and `gBump`.
 */
import { ASPHALT_TILE, CONCRETE_TILE } from './roadTextures';

const f = (v: number) => v.toFixed(4);

export const ROAD_SURFACE_PARS = /* glsl */ `
uniform sampler2D uAsphalt;
uniform sampler2D uConcrete;
varying vec4 vSurf;
flat varying float vSlot;

float rsHash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

/** Box-filtered coverage of a line of half width hw at distance d, pixel footprint fw. */
float rsLine(float d, float hw, float fw) {
  fw = max(fw, 1e-5);
  return clamp((min(d + 0.5 * fw, hw) - max(d - 0.5 * fw, -hw)) / fw, 0.0, 1.0);
}

/** 1 while a feature of this size is several pixels across, fading to 0 below a pixel. */
float rsFade(float fw, float size) {
  return 1.0 - smoothstep(size * 0.5, size * 2.0, fw);
}

/** Distance to the nearest multiple of period. */
float rsPeriodic(float x, float period) {
  float q = fract(x / period);
  return min(q, 1.0 - q) * period;
}

/** Metres a pixel covers on the surface. */
float rsPixel() {
  return max(length(vec2(fwidth(vWorld.x), fwidth(vWorld.z))) * 0.7071, 1e-4);
}

/** World plan gradient of a value varying over the surface. */
vec2 rsGradXZ(float v) {
  vec3 dpx = dFdx(vWorld);
  vec3 dpy = dFdy(vWorld);
  float dvx = dFdx(v);
  float dvy = dFdy(v);
  float det = dpx.x * dpy.z - dpx.z * dpy.x;
  if (abs(det) < 1e-12) return vec2(0.0);
  return vec2(dvx * dpy.z - dpx.z * dvy, dpx.x * dvy - dvx * dpy.x) / det;
}

#if ROAD_DETAIL >= 1
struct RsTex { float alb; vec2 n; float rough; };

/**
 * Two scales of one tiling texture: the close layer at its own tile, a rotated layer
 * 3.43 times larger for the middle distance, crossfaded by distance so neither repeats.
 */
RsTex rsSample(sampler2D t, vec2 wp, float tile, float dist) {
  vec4 a = texture2D(t, wp / tile);
  vec2 q = vec2(0.8829 * wp.x - 0.4695 * wp.y, 0.4695 * wp.x + 0.8829 * wp.y) / (tile * 3.43) + 0.37;
  vec4 b = texture2D(t, q);
  float near = 1.0 - smoothstep(14.0, 60.0, dist);
  vec2 nb = b.gb * 2.0 - 1.0;
  nb = vec2(0.8829 * nb.x + 0.4695 * nb.y, -0.4695 * nb.x + 0.8829 * nb.y) * 0.3;
  RsTex r;
  r.alb = mix(b.r, a.r, near);
  r.n = mix(nb, a.gb * 2.0 - 1.0, near) * (1.0 - 0.75 * smoothstep(60.0, 400.0, dist));
  r.rough = mix(b.a, a.a, near);
  return r;
}

/**
 * Wear that asphalt and concrete pavements share: polished wheel paths, oil in the
 * lane centre (heaviest before the stop line), dust at the kerb, deck joints.
 */
void rsWear(inout float tone, inout float r, inout vec2 n, vec2 wp, bool concrete) {
  float laneHalf = mod(vSurf.x, 8.0);
  float laneId = floor(vSurf.x / 8.0);
  float ru = vRoad.x;
  float s = vRoad.y;
  float px = rsPixel();
  if (laneHalf > 0.1) {
    float off = min(0.85, laneHalf * 0.48);
    float w = exp(-pow((abs(ru) - off) / 0.33, 2.0));
    w *= 0.7 + 0.6 * texture2D(uNoise, vec2(s / 41.0, laneId * 0.37 + vSlot * 0.013)).g;
    tone *= 1.0 - (concrete ? 0.06 : 0.075) * w;
    r -= 0.2 * w;
    n *= 1.0 - 0.45 * w;
#if ROAD_DETAIL >= 2
    float stop = vSurf.z;
    float dens = 0.1 + 0.9 * exp(-max(stop, 0.0) / 12.0) * step(-1.0, stop);
    float central = 1.0 - smoothstep(0.25, 0.6, abs(ru));
    vec2 oc = vec2(ru, s) / 0.32;
    vec2 ci = floor(oc);
    float h = rsHash(ci + vec2(vSlot * 0.173, laneId * 7.31));
    vec2 jit = vec2(rsHash(ci + 3.1), rsHash(ci + 5.7)) * 0.6 + 0.2;
    float rad = 0.12 + 0.25 * rsHash(ci + 9.3);
    // Irregular blots rather than discs.
    float d = length(oc - ci - jit) / rad * (0.75 + 0.5 * texture2D(uNoise, wp / 0.37).r);
    float chance = dens * central * 0.22;
    float spot = (1.0 - smoothstep(0.5, 1.0, d)) * step(h, chance);
    float oil = mix(chance * 0.15, spot, rsFade(px, 0.06));
    float stain = central * dens * (0.4 + 0.6 * texture2D(uNoise, wp / 3.7).g);
    tone *= 1.0 - 0.24 * oil - 0.07 * stain;
    r -= 0.3 * oil + 0.08 * stain;
#endif
  }
  // Dust and grit collect against the kerb; the very edge is a darker gutter line.
  float e = vSurf.y;
  float wear = (1.0 - smoothstep(0.1, 0.7, e)) * (0.6 + 0.4 * texture2D(uNoise, wp / 2.3).g);
  tone *= (1.0 + 0.09 * wear) * (1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.18, e)));
  r += 0.06 * wear;
  n *= 1.0 + 0.4 * wear;
#if ROAD_DETAIL >= 2
  // Deck expansion joint: a rubber seal between two steel nosings.
  float j = vSurf.w;
  if (j < 0.8) {
    float pxs = max(fwidth(s), 1e-4);
    float seal = rsLine(j, 0.26, pxs);
    float nose = rsLine(j - 0.26, 0.025, pxs);
    tone *= mix(1.0, 0.62, seal) * (1.0 + 0.7 * nose);
    r = mix(r, 0.75, seal);
    r = mix(r, 0.4, nose);
    n *= 1.0 - seal;
  }
#endif
}

void rsAsphalt(inout vec3 col, inout float rough, inout vec2 bump, vec2 wp, float dist, bool junction) {
  RsTex t = rsSample(uAsphalt, wp, ${f(ASPHALT_TILE)}, dist);
  float macro = texture2D(uNoise, wp / 97.0).g;
  float mid = texture2D(uNoise, wp / 23.0 + 0.5).b;
  // Stones read strongly close up; the larger middle layer is kept soft so it never shows its tile.
  float tone = 1.0 + mix(0.5, 1.15, 1.0 - smoothstep(10.0, 45.0, dist)) * (t.alb - 0.5) + 0.05 * (macro - 0.5) + 0.04 * (mid - 0.5);
  float r = clamp(t.rough * 0.9 + 0.08, 0.45, 0.97);
  vec2 n = t.n;
  float px = rsPixel();
  bool hasRoad = !junction && vSurf.x > 0.5;
  if (hasRoad) {
    float laneHalf = mod(vSurf.x, 8.0);
    float laneId = floor(vSurf.x / 8.0);
    float ru = vRoad.x;
    float s = vRoad.y;
    rsWear(tone, r, n, wp, false);
    if (laneHalf > 0.1) {
      // Longitudinal paving joint where lanes were laid side by side.
      float fwr = max(fwidth(ru), 1e-4);
      float wob = 0.03 * (texture2D(uNoise, wp / 6.0).r - 0.5);
      float seam = rsLine(laneHalf - abs(ru) + wob, 0.02, fwr);
      tone *= 1.0 - 0.2 * seam;
      r -= 0.15 * seam;
#if ROAD_DETAIL >= 2
      // A patch repair now and then: a rectangle of newer or older asphalt, sealed round its edge.
      float pc = floor(s / 19.0);
      vec2 pk = vec2(pc, laneId * 3.7 + vSlot * 0.11);
      if (rsHash(pk) < 0.14) {
        float p0 = (pc + 0.1 + 0.5 * rsHash(pk + 1.3)) * 19.0;
        float len = 1.6 + 4.5 * rsHash(pk + 2.9);
        float a0 = -laneHalf * (0.2 + 0.7 * rsHash(pk + 4.1));
        float a1 = laneHalf * (0.2 + 0.7 * rsHash(pk + 5.3));
        vec2 q = abs(vec2(ru, s) - vec2((a0 + a1) * 0.5, p0 + len * 0.5)) - vec2((a1 - a0) * 0.5, len * 0.5);
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
        float inside = 1.0 - smoothstep(-px, px, sd);
        float border = rsLine(sd, 0.03, px);
        float fresh = rsHash(pk + 6.7);
        tone *= mix(1.0, fresh > 0.5 ? 0.87 : 1.06, inside) * (1.0 - 0.28 * border);
        r -= 0.08 * inside * step(0.5, fresh) + 0.25 * border;
        n *= mix(1.0, fresh > 0.5 ? 0.6 : 1.2, inside);
      }
      // Transverse cracks, sealed, every so often along the road.
      float cs = floor(s / 11.0);
      vec2 ck = vec2(cs, vSlot * 0.31 + 0.5);
      if (rsHash(ck) < 0.26) {
        float sc = (cs + 0.2 + 0.6 * rsHash(ck + 2.0)) * 11.0;
        float dd = s - sc - 0.6 * (texture2D(uNoise, wp / 9.0).g - 0.5) - 0.06 * (texture2D(uNoise, wp / 1.3).r - 0.5);
        float crack = rsLine(dd, 0.025, max(fwidth(s), 1e-4));
        tone *= 1.0 - 0.3 * crack;
        r -= 0.35 * crack;
        n *= 1.0 - crack;
      }
      // Now and then a longitudinal crack near a lane edge, sealed, over a stretch of road.
      float ls = floor(s / 27.0);
      vec2 lk = vec2(ls, laneId * 1.9 + vSlot * 0.23);
      if (rsHash(lk) < 0.2) {
        float a = (ls + 0.1 * rsHash(lk + 1.0)) * 27.0;
        float b = a + 6.0 + 14.0 * rsHash(lk + 2.0);
        float side = rsHash(lk + 3.0) < 0.5 ? -1.0 : 1.0;
        float lat = side * (laneHalf - 0.25 - 0.4 * rsHash(lk + 4.0));
        float dd = ru - lat - 0.35 * (texture2D(uNoise, wp / 7.0).g - 0.5) - 0.05 * (texture2D(uNoise, wp / 1.1).r - 0.5);
        float span = smoothstep(a, a + 0.6, s) * (1.0 - smoothstep(b - 0.6, b, s));
        float crack = rsLine(dd, 0.022, max(fwidth(ru), 1e-4)) * span;
        tone *= 1.0 - 0.28 * crack;
        r -= 0.35 * crack;
        n *= 1.0 - crack;
      }
#endif
    }
  }
#if ROAD_DETAIL >= 2
  if (junction) {
    // Turning tyre marks: arcs round the junction centre, broken up, faint.
    vec2 loc = vRoad;
    float rr = length(loc);
    vec2 dirv = loc / max(rr, 0.01);
    float nz = texture2D(uNoise, dirv * 0.35 + vec2(rr * 0.013)).g;
    float band = rr / 1.9 + 0.6 * nz;
    float fwb = max(fwidth(band), 1e-4);
    float mark = rsLine(fract(band) - 0.5, 0.06, fwb) * rsFade(fwb * 1.9, 0.1);
    mark *= smoothstep(0.6, 0.75, texture2D(uNoise, dirv * 0.8 + vec2(rr * 0.05, 0.3)).b);
    mark *= smoothstep(0.45, 0.6, texture2D(uNoise, dirv * 3.1 + vec2(rr * 0.21, 0.7)).g);
    mark *= (1.0 - smoothstep(14.0, 26.0, rr)) * smoothstep(1.5, 4.0, rr);
    tone *= 1.0 - 0.09 * mark;
    r -= 0.1 * mark;
    // Oil where traffic waits and turns, thinning out from the centre.
    vec2 oc = wp / 0.4;
    vec2 ci = floor(oc);
    float d = length(oc - ci - vec2(rsHash(ci + 3.1), rsHash(ci + 5.7)) * 0.6 - 0.2) / (0.08 + 0.2 * rsHash(ci + 9.3));
    float chance = 0.035 * (1.0 - smoothstep(3.0, 12.0, rr));
    float spot = (1.0 - smoothstep(0.6, 1.0, d)) * step(rsHash(ci + 0.7), chance);
    float oil = mix(chance * 0.15, spot, rsFade(px, 0.08));
    float pool = (1.0 - smoothstep(2.0, 9.0, rr)) * (0.5 + 0.5 * texture2D(uNoise, wp / 4.3).g);
    tone *= 1.0 - 0.25 * oil - 0.06 * pool;
    r -= 0.3 * oil;
    // Now and then a patch, on a world grid.
    vec2 pc = floor(wp / 9.0);
    if (rsHash(pc + vSlot * 0.07) < 0.08) {
      vec2 c = (pc + 0.3 + 0.4 * vec2(rsHash(pc + 1.1), rsHash(pc + 2.2))) * 9.0;
      vec2 hs = vec2(0.8, 0.8) + 1.8 * vec2(rsHash(pc + 3.3), rsHash(pc + 4.4));
      vec2 q = abs(wp - c) - hs;
      float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      float inside = 1.0 - smoothstep(-px, px, sd);
      float border = rsLine(sd, 0.03, px);
      tone *= mix(1.0, 0.92, inside) * (1.0 - 0.28 * border);
      r -= 0.25 * border;
    }
  }
#endif
  col *= max(tone, 0.2);
  rough = clamp(r, 0.3, 1.0);
  bump += n;
}

void rsConcrete(inout vec3 col, inout float rough, inout vec2 bump, vec2 wp, float dist) {
  RsTex t = rsSample(uConcrete, wp, ${f(CONCRETE_TILE)}, dist);
  float macro = texture2D(uNoise, wp / 71.0).g;
  float tone = 1.0 + 0.3 * (t.alb - 0.5) + 0.04 * (macro - 0.5);
  float r = clamp(t.rough * 0.85 + 0.1, 0.5, 0.97);
  vec2 n = t.n * 0.8;
  float px = rsPixel();
  bool roadSpace = vSurf.x > 0.5;
  float joint;
  float fwj;
  vec2 slab;
  if (roadSpace) {
    float laneHalf = mod(vSurf.x, 8.0);
    float laneId = floor(vSurf.x / 8.0);
    float ru = vRoad.x;
    float s = vRoad.y;
    rsWear(tone, r, n, wp, true);
    // Slabs 4.5 m long and a lane wide: transverse joints, and longitudinal ones at lane edges.
    fwj = max(fwidth(s), 1e-4);
    joint = rsLine(rsPeriodic(s, 4.5), 0.006, fwj);
    float chamf = rsLine(rsPeriodic(s, 4.5), 0.02, fwj);
    if (laneHalf > 0.1) {
      float fwr = max(fwidth(ru), 1e-4);
      joint = max(joint, rsLine(laneHalf - abs(ru), 0.006, fwr));
      chamf = max(chamf, rsLine(laneHalf - abs(ru), 0.02, fwr));
    }
    tone *= 1.0 - 0.08 * chamf;
    slab = vec2(floor(s / 4.5), laneId + vSlot * 0.07);
    // Transverse tining, irregularly spaced grooves; fades to a slight roughness far off.
    float tn = s / 0.021 + 3.0 * texture2D(uNoise, vec2(s / 0.9, ru / 4.0)).r;
    float fwt = fwidth(tn);
    float vis = 1.0 - smoothstep(0.2, 0.5, fwt);
    vec2 gs = rsGradXZ(s);
    float gl = length(gs);
    if (gl > 1e-6 && vis > 0.0) n += (gs / gl) * (0.22 * sin(6.2832 * tn)) * vis;
    tone *= 1.0 - 0.025 * (1.0 - vis);
    r += 0.04;
  } else {
    // Junction slabs on a world grid.
    fwj = px;
    joint = max(rsLine(rsPeriodic(wp.x, 4.5), 0.006, px), rsLine(rsPeriodic(wp.y, 4.5), 0.006, px));
    float chamf = max(rsLine(rsPeriodic(wp.x, 4.5), 0.02, px), rsLine(rsPeriodic(wp.y, 4.5), 0.02, px));
    tone *= 1.0 - 0.08 * chamf;
    slab = floor(wp / 4.5) + vSlot * 0.07;
  }
  // Each slab poured a touch lighter or darker, warmer or cooler.
  float sh = rsHash(slab);
  float sw = rsHash(slab + 7.7);
  // Softer from afar, where a slab is a few pixels and the variation reads as a checkerboard.
  float sv = mix(0.1, 0.035, smoothstep(60.0, 250.0, dist));
  tone *= 1.0 + sv * (sh - 0.5);
  col *= vec3(1.0 + 0.02 * (sw - 0.5), 1.0, 1.0 - 0.02 * (sw - 0.5));
  tone *= 1.0 - 0.55 * joint;
  r = mix(r, 0.6, joint);
  n *= 1.0 - joint;
  col *= max(tone, 0.2);
  rough = clamp(r, 0.3, 1.0);
  bump += n;
}

void rsSidewalk(inout vec3 col, inout float rough, inout vec2 bump, vec2 wp, float dist) {
  RsTex t = rsSample(uConcrete, wp, ${f(CONCRETE_TILE)}, dist);
  float tone = 1.0 + 0.32 * (t.alb - 0.5);
  float r = clamp(t.rough * 0.85 + 0.12, 0.5, 0.98);
  vec2 n = t.n * 0.7;
  float px = rsPixel();
  bool hasRoad = abs(vRoad.y) > 0.001;
  float tooled;
  float expansion;
  vec2 bay;
  if (hasRoad) {
    // Bays 1.5 m long with tooled joints, an expansion joint every fourth.
    float s = vRoad.y;
    float fws = max(fwidth(s), 1e-4);
    tooled = rsLine(rsPeriodic(s, 1.5), 0.005, fws);
    expansion = rsLine(rsPeriodic(s, 6.0), 0.009, fws);
    bay = vec2(floor(s / 1.5), vSlot * 0.19);
  } else {
    tooled = max(rsLine(rsPeriodic(wp.x, 1.5), 0.005, px), rsLine(rsPeriodic(wp.y, 1.5), 0.005, px));
    expansion = max(rsLine(rsPeriodic(wp.x, 6.0), 0.009, px), rsLine(rsPeriodic(wp.y, 6.0), 0.009, px));
    bay = floor(wp / 1.5);
  }
  tone *= 0.96 + 0.08 * rsHash(bay);
  // A groove is in shadow even when it is narrower than a pixel.
  tone *= 1.0 - 0.45 * tooled - 0.55 * expansion;
  r = mix(r, 0.7, expansion);
  n *= 1.0 - max(tooled, expansion);
  // Tactile paving on a dropped kerb: buff blisters near the kerb edge.
  if (hasRoad && vSurf.x > 0.4 && vSurf.y < 0.85) {
    // Laid slabs end square: crisp, pixel-filtered edges, not a fade along the ramp.
    float pad = clamp((vSurf.x - 0.55) / max(fwidth(vSurf.x), 1e-4) + 0.5, 0.0, 1.0)
              * clamp((0.8 - vSurf.y) / max(fwidth(vSurf.y), 1e-4) + 0.5, 0.0, 1.0);
    vec2 c = fract(vec2(vRoad.y, vSurf.y) / 0.067) - 0.5;
    float dd = length(c) * 0.067;
    float blister = (1.0 - smoothstep(0.010, 0.0125, dd)) * rsFade(px, 0.02);
    col = mix(col, vec3(0.52, 0.40, 0.17), pad * 0.85);
    tone *= 1.0 + 0.12 * blister * pad;
    n += normalize(c + 1e-5) * 0.5 * blister * pad;
  }
  col *= max(tone, 0.2);
  rough = clamp(r, 0.3, 1.0);
  bump += n;
}

void rsKerb(inout vec3 col, inout float rough, inout vec2 bump, vec2 wp, float dist) {
  vec3 nw = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  bool top = abs(nw.y) > 0.6;
  float along = vRoad.y;
  vec2 uv = top ? wp : vec2(along, vWorld.y);
  RsTex t = rsSample(uConcrete, uv, ${f(CONCRETE_TILE)}, dist);
  float tone = 1.0 + 0.3 * (t.alb - 0.5);
  float r = clamp(t.rough * 0.85 + 0.1, 0.5, 0.97);
  // Precast stones about 0.9 m long.
  float fwa = max(fwidth(along), 1e-4);
  float stoneId = floor(along / 0.915);
  float joint = abs(along) > 0.001 ? rsLine(rsPeriodic(along, 0.915), 0.004, fwa) : 0.0;
  tone *= (0.95 + 0.1 * rsHash(vec2(stoneId, vSlot * 0.29))) * (1.0 - 0.5 * joint);
  // Road grime up the foot of the face, scuffs on the top arris.
  float h = vSurf.x;
  tone *= 0.8 + 0.2 * smoothstep(0.0, 0.55, h);
  float scuff = smoothstep(0.85, 1.0, h) * smoothstep(0.55, 0.75, texture2D(uNoise, vec2(along / 1.7, 0.3)).g);
  tone *= 1.0 - 0.12 * scuff;
  col *= max(tone, 0.2);
  rough = clamp(r, 0.3, 1.0);
  if (top) bump += t.n * 0.6;
}

/** Bridge decks, piers and walls: concrete grain projected three ways. */
void rsStructure(inout vec3 col, float dist) {
  vec3 nw = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 w3 = abs(nw);
  w3 /= (w3.x + w3.y + w3.z + 1e-5);
  float c = texture2D(uConcrete, vWorld.zy / ${f(CONCRETE_TILE * 2)}).r * w3.x
          + texture2D(uConcrete, vWorld.xz / ${f(CONCRETE_TILE * 2)}).r * w3.y
          + texture2D(uConcrete, vWorld.xy / ${f(CONCRETE_TILE * 2)}).r * w3.z;
  float m = texture2D(uNoise, (vWorld.xz + vWorld.y) / 23.0).g;
  col *= 0.93 + 0.14 * c + 0.05 * (m - 0.5);
}
#endif
`;

/**
 * The colour step. Expects k (kind), wp (world plan position) and dist (to the
 * camera) in scope. Returns true in `rsDone` when it handled the kind.
 */
export const ROAD_SURFACE_MAIN = /* glsl */ `
bool rsDone = false;
#if ROAD_DETAIL == 0
if (k < 0.5 || k == 6.0 || k == 9.0) {
  float g = texture2D(uAsphalt, wp / ${f(ASPHALT_TILE)}).r;
  float macro = texture2D(uNoise, wp / 97.0).g;
  diffuseColor.rgb *= 0.95 + (k == 9.0 ? 0.05 : 0.1) * g + 0.03 * (macro - 0.5);
  gRough = k == 9.0 ? 0.88 : 0.86;
  rsDone = true;
}
#else
if (k < 0.5 || k == 6.0) {
  rsAsphalt(diffuseColor.rgb, gRough, gBump, wp, dist, k == 6.0);
  rsDone = true;
} else if (k == 9.0) {
  rsConcrete(diffuseColor.rgb, gRough, gBump, wp, dist);
  rsDone = true;
} else if (k > 0.5 && k < 1.5) {
  rsSidewalk(diffuseColor.rgb, gRough, gBump, wp, dist);
  rsDone = true;
} else if (k == 10.0) {
  rsKerb(diffuseColor.rgb, gRough, gBump, wp, dist);
  rsDone = true;
}
#if ROAD_DETAIL >= 2
else if (k > 2.5 && k < 3.5) {
  rsStructure(diffuseColor.rgb, dist);
  gRough = 0.88;
  rsDone = true;
}
#endif
#endif
`;
