import { describe, expect, it } from 'vitest';
import { createRoadTextureJob, generateRoadTexture } from '../../src/render/roadTextures';

function digest(d: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
  return h >>> 0;
}

function channelMean(d: Uint8Array, c: number): number {
  let s = 0;
  for (let i = c; i < d.length; i += 4) s += d[i];
  return s / (d.length / 4);
}

describe('procedural road textures', () => {
  it('gives the same bytes for the same seed', () => {
    for (const kind of ['asphalt', 'concrete'] as const) {
      const a = generateRoadTexture(kind, 128, 7);
      const b = generateRoadTexture(kind, 128, 7);
      expect(digest(a)).toBe(digest(b));
    }
  });

  it('gives different textures for different seeds and kinds', () => {
    const a = generateRoadTexture('asphalt', 128, 7);
    expect(digest(generateRoadTexture('asphalt', 128, 8))).not.toBe(digest(a));
    expect(digest(generateRoadTexture('concrete', 128, 7))).not.toBe(digest(a));
  });

  it('matches the one-shot result when generated a slice at a time', () => {
    const job = createRoadTextureJob('asphalt', 128, 3);
    let steps = 0;
    while (!job.step(0)) steps++;
    expect(steps).toBeGreaterThan(4);
    expect(job.rows).toBe(128);
    expect(digest(job.data)).toBe(digest(generateRoadTexture('asphalt', 128, 3)));
  });

  it('keeps albedo centred and normals near flat at every size', () => {
    for (const size of [64, 256]) {
      const d = generateRoadTexture('asphalt', size, 7);
      expect(channelMean(d, 0)).toBeGreaterThan(110);
      expect(channelMean(d, 0)).toBeLessThan(145);
      // Normal x and y average out to flat over a tiling texture.
      expect(Math.abs(channelMean(d, 1) - 127.5)).toBeLessThan(6);
      expect(Math.abs(channelMean(d, 2) - 127.5)).toBeLessThan(6);
      // Roughness stays in the matte range.
      expect(channelMean(d, 3)).toBeGreaterThan(150);
    }
  });

  it('tiles: the first and last columns join without a jump', () => {
    const N = 256;
    const d = generateRoadTexture('concrete', N, 7);
    let edge = 0;
    let inner = 0;
    for (let y = 0; y < N; y++) {
      edge += Math.abs(d[(y * N + N - 1) * 4] - d[y * N * 4]);
      inner += Math.abs(d[(y * N + 100) * 4] - d[(y * N + 101) * 4]);
    }
    expect(edge).toBeLessThan(inner * 1.6);
  });
});
