import { describe, expect, it } from 'vitest';
import { aoPosScaleBias, aoSourceTexel, decodeLogDepth, encodeLogDepth, logFar, tangentSide, texelCentreUv, viewPosition } from '../../src/render/aoMath';

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// The game's camera: 40 degree fov, far 40000, a 1920 by 1200 target and AO at half size.
const FAR = 40000;
const LF = logFar(FAR);
const FULL_W = 1920;
const FULL_H = 1200;
const AO_W = 960;
const AO_H = 600;
const TAN_Y = Math.tan((40 * Math.PI) / 360);
const TAN_X = TAN_Y * (FULL_W / FULL_H);

/** A 24-bit depth buffer holding ground seen from `height` metres at `pitch` radians down. */
function groundScene(height: number, pitch: number) {
  const n: V = [0, Math.cos(pitch), Math.sin(pitch)];
  const depthAt = (i: number, j: number): number => {
    const r: V = [(texelCentreUv(i, FULL_W) * 2 - 1) * TAN_X, (texelCentreUv(j, FULL_H) * 2 - 1) * TAN_Y, -1];
    const w = -height / dot(n, r);
    const d = encodeLogDepth(w, FAR);
    return Math.round(d * 0xffffff) / 0xffffff;
  };
  return { n, depthAt };
}

/** Ground point and normal as the AO pass rebuilds them for AO texel (x, y). */
function rebuild(scene: ReturnType<typeof groundScene>, x: number, y: number) {
  const sx = (a: number) => aoSourceTexel(a, FULL_W / AO_W, FULL_W);
  const sy = (a: number) => aoSourceTexel(a, FULL_H / AO_H, FULL_H);
  const z = (a: number, b: number) => decodeLogDepth(scene.depthAt(sx(a), sy(b)), LF);
  const p = (a: number, b: number): V => viewPosition(texelCentreUv(sx(a), FULL_W), texelCentreUv(sy(b), FULL_H), z(a, b), TAN_X, TAN_Y);
  const P = p(x, y);
  const side = (dx: number, dy: number) => tangentSide(z(x, y), z(x - dx, y - dy), z(x - 2 * dx, y - 2 * dy), z(x + dx, y + dy), z(x + 2 * dx, y + 2 * dy));
  const tx = side(1, 0) < 0 ? sub(P, p(x - 1, y)) : sub(p(x + 1, y), P);
  const ty = side(0, 1) < 0 ? sub(P, p(x, y - 1)) : sub(p(x, y + 1), P);
  return { P, N: norm(cross(tx, ty)) };
}

describe('AO depth reconstruction', () => {
  it('decodes 24-bit logarithmic depth to well under a millimetre at street distances', () => {
    for (const w of [0.5, 8, 30, 300, 1500]) {
      const d = Math.round(encodeLogDepth(w, FAR) * 0xffffff) / 0xffffff;
      expect(Math.abs(decodeLogDepth(d, LF) - w)).toBeLessThan(Math.max(1e-4, w * 2e-6));
    }
  });

  it('reads every AO texel from a full-resolution texel that exists, also for odd sizes', () => {
    for (const [full, ao] of [
      [1920, 960],
      [1921, 961],
      [1199, 600],
      [7, 4],
    ]) {
      const used = new Set<number>();
      for (let a = 0; a < ao; a++) {
        const s = aoSourceTexel(a, full / ao, full);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(full);
        used.add(s);
      }
      expect(used.size).toBe(ao);
    }
  });

  it('keeps an exact 2:1 ratio off texel boundaries, so rounding cannot flip rows', () => {
    for (let a = 0; a < 600; a++) {
      const v = (a + 0.5) * 2 - 0.5;
      expect(v - Math.floor(v)).toBeCloseTo(0.5, 9);
    }
  });

  it('rebuilds flat ground at low and medium pitch as flat: on the plane, with the true normal', () => {
    for (const [height, pitch] of [
      [2.5, 0.12],
      [3, 0.22],
      [8, 0.5],
      [20, 0.9],
    ]) {
      const scene = groundScene(height, pitch);
      // Lower half of the screen: the ground nearest the camera, 8 to 30 m away.
      for (let y = 20; y < AO_H / 2; y += 7) {
        for (let x = 20; x < AO_W - 20; x += 53) {
          const { P, N } = rebuild(scene, x, y);
          // Distance from the plane dot(n, P) = -height.
          expect(Math.abs(dot(scene.n, P) + height)).toBeLessThan(2e-4 * -P[2] + 1e-5);
          // Within a tenth of a degree of the true normal: no tilt, so no self-occlusion.
          expect(dot(N, scene.n)).toBeGreaterThan(Math.cos((0.1 * Math.PI) / 180));
        }
      }
    }
  });

  it('shows the old fault: the AO texel centre with a neighbouring depth puts ground off its plane', () => {
    // What the pass used to do: position from the AO texel's own centre, depth from the
    // full-resolution texel beside it. Half a pixel apart, at a low angle.
    const height = 2.5;
    const pitch = 0.12;
    const scene = groundScene(height, pitch);
    let worst = 0;
    for (let y = 20; y < AO_H / 2; y += 3) {
      const u = (480 + 0.5) / AO_W;
      const v = (y + 0.5) / AO_H;
      const w = decodeLogDepth(scene.depthAt(Math.floor(u * FULL_W), Math.floor(v * FULL_H)), LF);
      const P = viewPosition(u, v, w, TAN_X, TAN_Y);
      worst = Math.max(worst, Math.abs(dot(scene.n, P) + height));
    }
    // Millimetres off the plane: on the order of the old bias, so taps on flat ground
    // read as occluders and banded with the rounding of each row.
    expect(worst).toBeGreaterThan(2e-3);
  });

  it('folds texel index to view position the same as going through UV', () => {
    const [sx, bx] = aoPosScaleBias(TAN_X, FULL_W);
    const [sy, by] = aoPosScaleBias(TAN_Y, FULL_H);
    for (const [i, j, z] of [
      [0, 0, 3],
      [959, 600, 12.5],
      [1919, 1199, 40],
    ]) {
      const p = viewPosition(texelCentreUv(i, FULL_W), texelCentreUv(j, FULL_H), z, TAN_X, TAN_Y);
      expect((i * sx + bx) * z).toBeCloseTo(p[0], 9);
      expect((j * sy + by) * z).toBeCloseTo(p[1], 9);
    }
  });

  it('picks the tangent on the same surface across a kerb', () => {
    // Ground at 10 m on the minus side, a kerb face jumping to 9.4 m on the plus side.
    expect(tangentSide(10, 10.05, 10.1, 9.4, 9.38)).toBe(-1);
    expect(tangentSide(9.4, 10, 10.05, 9.38, 9.36)).toBe(1);
  });
});
