import { describe, expect, it } from 'vitest';
import {
  alignmentPoint,
  cubicSweep,
  curvatureSpread,
  fitCurve,
  refitCubic,
  type FitResult,
} from '../../src/core/curveFit';
import {
  closestPointOnCubic,
  cubicDerivative,
  cubicPoint,
  cubicTangentXZ,
  curvatureXZ,
  type Cubic,
} from '../../src/core/bezier';
import { signedTurn } from '../../src/core/math';
import type { Vec3 } from '../../src/core/types';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
const EAST = v(1, 0);
const deg = (r: number) => (r * 180) / Math.PI;

/** Largest plan distance from the alignment to the chain, and from the chain to the alignment. */
function chainError(fit: FitResult): number {
  let worst = 0;
  const al = fit.alignment;
  const n = Math.ceil(al.length / 0.5);
  const poly: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const q = alignmentPoint(al, (al.length * i) / n);
    const p = v(q.x, q.z);
    poly.push(p);
    let best = Infinity;
    for (const c of fit.cubics) best = Math.min(best, closestPointOnCubic(c, p).distance);
    worst = Math.max(worst, best);
  }
  // The other way: every point of the chain lies near the alignment polyline.
  for (const c of fit.cubics) {
    for (let i = 0; i <= 64; i++) {
      const p = cubicPoint(c, i / 64);
      let best = Infinity;
      for (let j = 0; j + 1 < poly.length; j++) best = Math.min(best, segDist(p, poly[j], poly[j + 1]));
      worst = Math.max(worst, best);
    }
  }
  return worst;
}

function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

function expectJoinsSmooth(cubics: Cubic[]): void {
  for (let i = 0; i + 1 < cubics.length; i++) {
    const a = cubics[i];
    const b = cubics[i + 1];
    expect(Math.hypot(a.p3.x - b.p0.x, a.p3.y - b.p0.y, a.p3.z - b.p0.z), `gap at join ${i}`).toBeLessThan(1e-9);
    // G1 in plan.
    const turn = Math.abs(signedTurn(cubicTangentXZ(a, 1), cubicTangentXZ(b, 0)));
    expect(deg(turn), `tangent at join ${i}`).toBeLessThan(1e-4);
    // Near G2: curvature agrees across the join.
    const ka = curvatureXZ(a, 1);
    const kb = curvatureXZ(b, 0);
    const scale = Math.max(Math.abs(ka), Math.abs(kb), 1e-4);
    expect(Math.abs(ka - kb) / scale, `curvature at join ${i}: ${ka} vs ${kb}`).toBeLessThan(0.02);
    // Grade carries on across the join.
    const ga = gradeAt(a, 1);
    const gb = gradeAt(b, 0);
    expect(Math.abs(ga - gb), `grade at join ${i}`).toBeLessThan(1e-6);
  }
}

function gradeAt(c: Cubic, t: number): number {
  const d = cubicDerivative(c, t);
  return d.y / Math.hypot(d.x, d.z);
}

function pieceTurns(fit: FitResult): number[] {
  return fit.cubics.map((c) => Math.abs(cubicSweep(c)));
}

/** Curvature along every piece lying wholly inside an arc element, relative to the arc's. */
function arcCurvatureSpread(fit: FitResult): { pieces: number; worst: number } {
  const al = fit.alignment;
  let pieces = 0;
  let worst = 0;
  for (const piece of fit.pieces) {
    const i = al.elements.findIndex(
      (e, k) => e.kind === 'arc' && al.starts[k].s <= piece.s0 + 1e-6 && al.starts[k].s + e.length >= piece.s1 - 1e-6,
    );
    if (i < 0) continue;
    pieces++;
    const k = Math.abs(al.elements[i].k0);
    for (let j = 0; j <= 32; j++) {
      const kc = Math.abs(curvatureXZ(piece.cubic, j / 32));
      worst = Math.max(worst, Math.abs(kc - k) / k);
    }
  }
  return { pieces, worst };
}

describe('curve fitter: shapes', () => {
  it('a 270 degree loop from a continued tangent is round, not a teardrop', () => {
    // Heading east from the origin, clicking up and back to the left.
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(-60, 60), minRadius: 10 });
    expect(fit.ok).toBe(true);
    expect(fit.kind).toBe('loop');
    expect(deg(fit.sweep)).toBeGreaterThan(255);
    expect(deg(fit.sweep)).toBeLessThan(285);
    // Six or more pieces, none turning much more than 45 degrees.
    expect(fit.cubics.length).toBeGreaterThanOrEqual(6);
    for (const t of pieceTurns(fit)) expect(deg(t)).toBeLessThan(46);
    expect(chainError(fit)).toBeLessThan(0.03);
    expectJoinsSmooth(fit.cubics);
    // The arc is a true arc: constant curvature within a few percent.
    const arc = arcCurvatureSpread(fit);
    expect(arc.pieces).toBeGreaterThanOrEqual(3);
    expect(arc.worst).toBeLessThan(0.03);
    // Ends exactly where asked, leaving along the start direction.
    expect(fit.cubics[0].p0).toEqual(v(0, 0));
    const last = fit.cubics.at(-1)!;
    expect(Math.hypot(last.p3.x + 60, last.p3.z - 60)).toBeLessThan(1e-9);
    expect(cubicTangentXZ(fit.cubics[0], 0).x).toBeCloseTo(1, 9);
    // Mostly one constant radius, eased in and out by short spirals.
    const arcLength = fit.alignment.elements.filter((e) => e.kind === 'arc').reduce((s, e) => s + e.length, 0);
    expect(arcLength / fit.length).toBeGreaterThan(0.75);
    expect(fit.radius).toBeGreaterThan(50);
    expect(fit.radius).toBeLessThan(90);
  });

  it('a single cubic for the same loop has a lopsided curvature, the chain does not', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(-60, 60) });
    // The arc pieces of the chain all share one radius.
    const radii = fit.cubics.map((c) => 1 / Math.abs(curvatureXZ(c, 0.5)));
    const arcRadii = radii.filter((r) => Math.abs(r - fit.radius) / fit.radius < 0.03);
    expect(arcRadii.length).toBeGreaterThanOrEqual(3);
    // Spirals ease the ends: curvature starts and ends at zero.
    expect(Math.abs(curvatureXZ(fit.cubics[0], 0))).toBeLessThan(1e-6);
    expect(Math.abs(curvatureXZ(fit.cubics.at(-1)!, 1))).toBeLessThan(1e-6);
  });

  it('handles sweeps up to about 350 degrees', () => {
    // Pure arc of 340 degrees: end is at chord angle 170 degrees.
    const a = (170 * Math.PI) / 180;
    const R = 80;
    const chord = 2 * R * Math.sin(a);
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(chord * Math.cos(a), chord * Math.sin(a)), spirals: false });
    expect(fit.ok).toBe(true);
    expect(deg(fit.sweep)).toBeCloseTo(340, 3);
    expect(fit.radius).toBeCloseTo(R, 6);
    expect(chainError(fit)).toBeLessThan(0.03);
    expectJoinsSmooth(fit.cubics);
    // Directly behind cannot be reached.
    const behind = fitCurve({ start: v(0, 0), startDir: EAST, end: v(-50, 0.01) });
    expect(behind.ok).toBe(false);
  });

  it('an S-curve is two opposite arcs with a short straight between', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(200, 40), endDir: EAST, minRadius: 10 });
    expect(fit.ok).toBe(true);
    expect(fit.kind).toBe('reverse');
    expect(Math.abs(fit.sweep)).toBeLessThan(1e-9);
    const signs = fit.alignment.elements.filter((e) => e.kind === 'arc').map((e) => Math.sign(e.k0));
    expect(signs).toEqual([1, -1]);
    expect(fit.alignment.elements.some((e) => e.kind === 'line')).toBe(true);
    expect(chainError(fit)).toBeLessThan(0.03);
    expectJoinsSmooth(fit.cubics);
    const last = fit.cubics.at(-1)!;
    expect(cubicTangentXZ(last, 1).x).toBeCloseTo(1, 6);
    expect(Math.hypot(last.p3.x - 200, last.p3.z - 40)).toBeLessThan(1e-9);
  });

  it('a gentle bend collapses to one cubic', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(120, 10) });
    expect(fit.ok).toBe(true);
    expect(fit.cubics).toHaveLength(1);
    expect(chainError(fit)).toBeLessThan(0.03);
  });

  it('a straight request stays straight', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(150, 0) });
    expect(fit.kind).toBe('straight');
    expect(fit.cubics).toHaveLength(1);
    expect(fit.radius).toBe(Infinity);
    const c = fit.cubics[0];
    expect(c.p1.z).toBeCloseTo(0, 9);
    expect(c.p2.z).toBeCloseTo(0, 9);
  });

  it('a radius under the road minimum is refused with the reason', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(10, 10), minRadius: 25 });
    expect(fit.ok).toBe(false);
    expect(fit.reason).toMatch(/under this road's minimum/);
    // The geometry is still there to show in red.
    expect(fit.cubics.length).toBeGreaterThan(0);
  });

  it('warns under the comfortable radius', () => {
    const fit = fitCurve({ start: v(0, 0), startDir: EAST, end: v(60, 60), minRadius: 10, comfortRadius: 200 });
    expect(fit.ok).toBe(true);
    expect(fit.warning).toMatch(/advised/);
  });

  it('Curved mode: the control point is the tangent intersection', () => {
    const fit = fitCurve({ start: v(0, 0), control: v(100, 0), end: v(100, 100) });
    expect(fit.ok).toBe(true);
    expect(deg(fit.sweep)).toBeCloseTo(90, 6);
    // Symmetric legs leave no straight on either side.
    expect(fit.alignment.elements.every((e) => e.kind !== 'line')).toBe(true);
    expect(cubicTangentXZ(fit.cubics[0], 0).x).toBeCloseTo(1, 9);
    expect(cubicTangentXZ(fit.cubics.at(-1)!, 1).z).toBeCloseTo(1, 9);
    expect(chainError(fit)).toBeLessThan(0.03);
    expectJoinsSmooth(fit.cubics);
    // Unequal legs: a straight on the longer one, and the largest radius that fits.
    const lop = fitCurve({ start: v(0, 0), control: v(200, 0), end: v(200, 60) });
    const lines = lop.alignment.elements.filter((e) => e.kind === 'line');
    expect(lines).toHaveLength(1);
    expect(lop.alignment.elements[0].kind).toBe('line');
    expect(chainError(lop)).toBeLessThan(0.03);
  });

  it('only an arrival direction: fitted backwards and driven forwards', () => {
    const fit = fitCurve({ start: v(0, 0), end: v(100, 100), endDir: v(0, 1) });
    expect(fit.ok).toBe(true);
    expect(cubicTangentXZ(fit.cubics.at(-1)!, 1).z).toBeCloseTo(1, 6);
    expect(fit.cubics[0].p0).toEqual(v(0, 0));
    expect(Math.hypot(fit.cubics.at(-1)!.p3.x - 100, fit.cubics.at(-1)!.p3.z - 100)).toBeLessThan(1e-6);
    expectJoinsSmooth(fit.cubics);
  });

  it('error to the ideal alignment stays within a few cm across many requests', () => {
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      const a = -2.9 + (5.8 * i) / 29;
      const d = 40 + ((i * 37) % 300);
      const fit = fitCurve({ start: v(5, -3), startDir: v(0.6, 0.8), end: v(5 + d * Math.cos(a + 0.927), -3 + d * Math.sin(a + 0.927)) });
      if (!fit.cubics.length) continue;
      worst = Math.max(worst, chainError(fit));
      expectJoinsSmooth(fit.cubics);
    }
    expect(worst).toBeLessThan(0.03);
  });
});

describe('curve fitter: elevation', () => {
  it('spreads a climb over the whole chain with eased, continuous grade', () => {
    const fit = fitCurve({ start: v(0, 0, 0), startDir: EAST, end: v(-60, 60, 12), minRadius: 10 });
    expectJoinsSmooth(fit.cubics);
    // Heights rise steadily and grade changes gently, with no kinks.
    const samples: { s: number; y: number; g: number }[] = [];
    let s = 0;
    for (const c of fit.cubics) {
      const n = 32;
      let prev = cubicPoint(c, 0);
      for (let i = 0; i <= n; i++) {
        const p = cubicPoint(c, i / n);
        s += Math.hypot(p.x - prev.x, p.z - prev.z);
        prev = p;
        samples.push({ s, y: p.y, g: gradeAt(c, i / n) });
      }
    }
    for (let i = 1; i < samples.length; i++) expect(samples[i].y).toBeGreaterThanOrEqual(samples[i - 1].y - 1e-9);
    const L = fit.length;
    const mean = 12 / L;
    // Free ends ease in at half the mean grade, peaking near 1.25 times it in the middle.
    expect(samples[0].g).toBeCloseTo(mean * 0.5, 6);
    expect(samples.at(-1)!.g).toBeCloseTo(mean * 0.5, 6);
    const peak = Math.max(...samples.map((x) => x.g));
    expect(peak).toBeLessThan(mean * 1.3);
    // Grade changes no faster than the smooth profile would: |dg/ds| <= 6 rise / L^2 with room.
    let worstRate = 0;
    for (let i = 1; i < samples.length; i++) {
      const ds = samples[i].s - samples[i - 1].s;
      if (ds > 0.5) worstRate = Math.max(worstRate, Math.abs(samples[i].g - samples[i - 1].g) / ds);
    }
    expect(worstRate).toBeLessThan((6 * 12) / (L * L));
  });

  it('carries a slope into the chain and lands level', () => {
    const fit = fitCurve({ start: v(0, 0, 8), startDir: EAST, end: v(150, 150, 0), startSlope: -0.04, endSlope: 0 });
    expect(gradeAt(fit.cubics[0], 0)).toBeCloseTo(-0.04, 6);
    expect(gradeAt(fit.cubics.at(-1)!, 1)).toBeCloseTo(0, 6);
    expect(fit.cubics.at(-1)!.p3.y).toBe(0);
  });
});

describe('curve fitter: refitting a lopsided cubic', () => {
  it('keeps ends and end tangents, evens out the curvature', () => {
    // A teardrop loop like a single-cubic ramp: tight near the start, ballooning later.
    const lop: Cubic = { p0: v(0, 0), p1: v(140, 0), p2: v(-110, 160), p3: v(-40, 40) };
    const sweep = cubicSweep(lop);
    expect(Math.abs(deg(sweep))).toBeGreaterThan(200);
    const fit = refitCubic(lop, { minRadius: 5 });
    expect(fit.ok).toBe(true);
    expect(fit.sweep).toBeCloseTo(sweep, 6);
    const first = fit.cubics[0];
    const last = fit.cubics.at(-1)!;
    expect(first.p0).toEqual(lop.p0);
    expect(Math.hypot(last.p3.x - lop.p3.x, last.p3.z - lop.p3.z)).toBeLessThan(1e-6);
    expect(Math.abs(signedTurn(cubicTangentXZ(first, 0), cubicTangentXZ(lop, 0)))).toBeLessThan(1e-6);
    expect(Math.abs(signedTurn(cubicTangentXZ(last, 1), cubicTangentXZ(lop, 1)))).toBeLessThan(1e-6);
    expectJoinsSmooth(fit.cubics);
    expect(chainError(fit)).toBeLessThan(0.03);
    // The original's curvature varies many times over; the arc pieces of the chain do not.
    expect(curvatureSpread(lop)).toBeGreaterThan(4);
    expect(arcCurvatureSpread(fit).worst).toBeLessThan(0.03);
  });
});
