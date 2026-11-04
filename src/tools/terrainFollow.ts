/**
 * Drawing on landscaped land: picking the ground under the cursor, and giving a
 * road at "Ground 0 m" (or any height above ground) a profile that follows the
 * earth.
 *
 * The profile is the lowest line that stays on or above the ground plus the
 * elevation setting and never climbs or falls faster than the road's grade:
 * over a hill the road follows the hilltop, across a valley steeper than its
 * grade it spans it as a bridge, which then gets pillars. Over water the ground
 * counts as 0 m, as before landscaping. The chain is split only where a single
 * cubic cannot hold the profile within a few decimetres, so flat land keeps one
 * piece and nothing changes where nothing was landscaped.
 */
import { cubicPoint, type Cubic } from '../core/bezier';
import { EDIT_CELL, EDIT_ORIGIN, EDIT_TILE, EDIT_TILES, terrainEditor } from '../core/terrainEdit';
import { hasTerrainEdits, isWater, MAX_ELEVATION, MIN_ELEVATION, surfaceLevel, terrainHeight } from '../core/terrain';
import type { Vec3 } from '../core/types';
import { pickRay } from './pick';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id } from '../core/types';
import { structureOf } from '../core/walls';
import { applyStructure } from './wallOps';
import type { ToolContext, ToolPointer } from './types';

/** Where the cursor's ray meets the landscaped ground, lifted by `lift`. */
export function pickGround(ctx: ToolContext, e: Pick<ToolPointer, 'x' | 'y'>, lift = 0): Vec3 | null {
  const ray = pickRay(ctx, e);
  if (!ray) return ctx.view.pickPlane(e.x, e.y, lift);
  const { origin: o, dir: d } = ray;
  const above = (s: number) => o.y + d.y * s - (terrainHeight(o.x + d.x * s, o.z + d.z * s) + lift);
  // Start where the ray comes down through the highest the land can be.
  let s = 0;
  if (o.y > MAX_ELEVATION + lift + 1 && d.y < 0) s = (MAX_ELEVATION + lift + 1 - o.y) / d.y;
  let h = above(s);
  if (h < 0) return { x: o.x + d.x * s, y: terrainHeight(o.x + d.x * s, o.z + d.z * s) + lift, z: o.z + d.z * s };
  for (let n = 0; n < 4000 && s < 20000; n++) {
    const step = Math.max(0.5, Math.min(16, h * 0.7));
    const next = s + step;
    const hn = above(next);
    if (hn <= 0) {
      let a = s;
      let b = next;
      for (let k = 0; k < 24; k++) {
        const m = (a + b) / 2;
        if (above(m) > 0) a = m;
        else b = m;
      }
      const x = o.x + d.x * b;
      const z = o.z + d.z * b;
      return { x, y: terrainHeight(x, z) + lift, z };
    }
    s = next;
    h = hn;
  }
  return ctx.view.pickPlane(e.x, e.y, lift);
}

/** The ground a road at this point rests on: the land, with water as 0 m. */
export function roadBed(x: number, z: number): number {
  const h = terrainHeight(x, z);
  return isWater(x, z) ? Math.max(h, 0) : h;
}

/** Height above the surface things are built on (water counts as 0 m). */
export function heightAboveGround(p: Vec3): number {
  return p.y - surfaceLevel(p.x, p.z);
}

/** True when landscaping touches the plan box of these curves, widened. */
export function editsNear(cubics: readonly Cubic[], pad = 20): boolean {
  if (!hasTerrainEdits()) return false;
  const ed = terrainEditor();
  if (!ed) return false;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const c of cubics) {
    for (const p of [c.p0, c.p1, c.p2, c.p3]) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  const span = EDIT_TILE * EDIT_CELL;
  const c = (v: number) => Math.max(0, Math.min(EDIT_TILES - 1, Math.floor((v - EDIT_ORIGIN) / span)));
  for (let tj = c(minZ - pad); tj <= c(maxZ + pad); tj++) for (let ti = c(minX - pad); ti <= c(maxX + pad); ti++) if (ed.grid.eff[tj * EDIT_TILES + ti]) return true;
  return false;
}

function split(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  const a = lerp(c.p0, c.p1, t);
  const b = lerp(c.p1, c.p2, t);
  const d = lerp(c.p2, c.p3, t);
  const e = lerp(a, b, t);
  const f = lerp(b, d, t);
  const m = lerp(e, f, t);
  return [
    { p0: c.p0, p1: a, p2: e, p3: m },
    { p0: m, p1: f, p2: d, p3: c.p3 },
  ];
}

export interface FollowOptions {
  /** Metres above the ground the road keeps (the elevation setting). */
  elevation: number;
  /** Steepest grade the profile uses, as rise over run. */
  grade: number;
  /** Largest gap between the profile and the fitted pieces. */
  tolerance?: number;
  /** Shortest piece the chain is split into. */
  minPiece?: number;
}

const STEP = 4;

/**
 * The chain re-profiled to follow the landscaped ground, ends kept at their
 * heights. Returns the input unchanged when no landscaping is nearby.
 */
export function followTerrain(cubics: readonly Cubic[], opt: FollowOptions): Cubic[] {
  if (!cubics.length || !editsNear(cubics)) return cubics.slice();
  const tol = opt.tolerance ?? 0.3;
  const minPiece = opt.minPiece ?? 16;
  const G = Math.max(0.01, opt.grade);
  // Sample the plan along the chain.
  const xs: number[] = [];
  const zs: number[] = [];
  const ss: number[] = [];
  let total = 0;
  let last: Vec3 | null = null;
  for (const c of cubics) {
    const n = 64;
    for (let k = last ? 1 : 0; k <= n; k++) {
      const p = cubicPoint(c, k / n);
      if (last) total += Math.hypot(p.x - last.x, p.z - last.z);
      xs.push(p.x);
      zs.push(p.z);
      ss.push(total);
      last = p;
    }
  }
  if (total < 1) return cubics.slice();
  const n = Math.max(2, Math.ceil(total / STEP) + 1);
  const ds = total / (n - 1);
  const px: number[] = [];
  const pz: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    while (j + 2 < ss.length && ss[j + 1] < s) j++;
    const f = (s - ss[j]) / Math.max(ss[j + 1] - ss[j], 1e-9);
    px.push(xs[j] + (xs[j + 1] - xs[j]) * Math.min(1, Math.max(0, f)));
    pz.push(zs[j] + (zs[j + 1] - zs[j]) * Math.min(1, Math.max(0, f)));
  }
  const target = px.map((x, i) => roadBed(x, pz[i]) + opt.elevation);
  // Lowest grade-limited line on or over the target (under it for a tunnel).
  const env = target.slice();
  const up = opt.elevation >= 0;
  const drop = G * ds;
  for (let i = 1; i < n; i++) env[i] = up ? Math.max(env[i], env[i - 1] - drop) : Math.min(env[i], env[i - 1] + drop);
  for (let i = n - 2; i >= 0; i--) env[i] = up ? Math.max(env[i], env[i + 1] - drop) : Math.min(env[i], env[i + 1] + drop);
  // Pin the ends to where they are, reached within the grade where possible.
  const y0 = cubics[0].p0.y;
  const y1 = cubics[cubics.length - 1].p3.y;
  const prof = env.map((v, i) => {
    const s = i * ds;
    const lo = Math.max(y0 - G * s, y1 - G * (total - s));
    const hi = Math.min(y0 + G * s, y1 + G * (total - s));
    const y = lo > hi ? y0 + ((y1 - y0) * s) / total : Math.min(hi, Math.max(lo, v));
    return Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, y));
  });
  // Round the crests and sags a little, then put the ends back exactly.
  for (let pass = 0; pass < 2; pass++) {
    const src = prof.slice();
    for (let i = 1; i + 1 < n; i++) prof[i] = (src[i - 1] + 2 * src[i] + src[i + 1]) / 4;
  }
  prof[0] = y0;
  prof[n - 1] = y1;
  const at = (s: number) => {
    const g = Math.min(n - 1.000001, Math.max(0, s / ds));
    const i = Math.floor(g);
    return prof[i] + (prof[i + 1] - prof[i]) * (g - i);
  };
  const slopeAt = (s: number) => (at(Math.min(total, s + ds)) - at(Math.max(0, s - ds))) / (Math.min(total, s + ds) - Math.max(0, s - ds));
  // Fit pieces, splitting where one cubic cannot hold the profile.
  const out: Cubic[] = [];
  const fit = (c: Cubic, s0: number, depth: number): void => {
    const samples: { t: number; s: number }[] = [];
    let len = 0;
    let prev = cubicPoint(c, 0);
    const m = 24;
    for (let k = 0; k <= m; k++) {
      const p = cubicPoint(c, k / m);
      if (k) len += Math.hypot(p.x - prev.x, p.z - prev.z);
      samples.push({ t: k / m, s: s0 + len });
      prev = p;
    }
    const s1 = s0 + len;
    const ya = at(s0);
    const yb = at(s1);
    const l01 = Math.hypot(c.p1.x - c.p0.x, c.p1.z - c.p0.z);
    const l23 = Math.hypot(c.p3.x - c.p2.x, c.p3.z - c.p2.z);
    const shaped: Cubic = {
      p0: { ...c.p0, y: ya },
      p1: { ...c.p1, y: ya + slopeAt(s0) * l01 },
      p2: { ...c.p2, y: yb - slopeAt(s1) * l23 },
      p3: { ...c.p3, y: yb },
    };
    let worst = 0;
    for (const sm of samples) worst = Math.max(worst, Math.abs(cubicPoint(shaped, sm.t).y - at(sm.s)));
    if (worst > tol && len > minPiece * 2 && depth < 8) {
      const [a, b] = split(c, 0.5);
      const la = samples[12].s - s0;
      fit(a, s0, depth + 1);
      fit(b, s0 + la, depth + 1);
      return;
    }
    out.push(shaped);
  };
  let s0 = 0;
  for (const c of cubics) {
    let len = 0;
    let prev = cubicPoint(c, 0);
    for (let k = 1; k <= 48; k++) {
      const p = cubicPoint(c, k / 48);
      len += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    fit(c, s0, 0);
    s0 += len;
  }
  // Ends exactly as given, so anchors still meet.
  out[0] = { ...out[0], p0: { ...out[0].p0, y: y0 } };
  const e = out.length - 1;
  out[e] = { ...out[e], p3: { ...out[e].p3, y: y1 } };
  return out;
}

/**
 * A road drawn at ground level that runs well below the landscaped ground (into
 * a dug pit, say) is built as a sloped cut, the walls module's open earthwork,
 * not a tunnel: it stays open to the sky and dry. Only roads left on Auto.
 */
export function autoCut(net: RoadNetwork, segments: readonly Id[], elevation: number): void {
  if (elevation !== 0 || !hasTerrainEdits()) return;
  for (const id of segments) {
    const seg = net.getSegment(id);
    if (!seg || structureOf(seg.overrides).mode !== 'auto') continue;
    const st = net.curveOf(id).stations;
    const sunk = st.some((s) => s.pos.y < surfaceLevel(s.pos.x, s.pos.z) - 1.5);
    if (sunk) applyStructure(net, id, { mode: 'cut' });
  }
}
