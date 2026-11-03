import { describe, expect, it } from 'vitest';
import { metresPerPixel } from '../../src/render/gridLevels';
import { LINE_MIN_PX, MARK_MAX_SCALE, MARK_MIN_PX, MARK_MIN_SCALE, MARK_REF_MPP, lineWidth, markRadius, metresPerPixelAt, ringThickness } from '../../src/render/markScale';

const mppAt = (d: number) => metresPerPixel(d, 40, 700);
const px = (r: number, d: number) => markRadius(r, mppAt(d)) / mppAt(d);

describe('tool mark screen size', () => {
  it('keeps a node snap ring a sensible size from street level to map-wide', () => {
    const nominal = 6 / MARK_REF_MPP;
    for (const d of [7, 12, 50, 220, 1000, 4000, 6800]) {
      const s = px(6, d);
      expect(s).toBeGreaterThanOrEqual(nominal * MARK_MIN_SCALE - 1e-9);
      expect(s).toBeLessThanOrEqual(nominal * MARK_MAX_SCALE + 1e-9);
    }
    // Close up it is capped, not hundreds of pixels; map-wide it stays visible.
    expect(px(6, 12)).toBeLessThan(40);
    expect(px(6, 4000)).toBeGreaterThan(12);
    // At a normal drawing zoom the metre size is used as given.
    expect(markRadius(6, MARK_REF_MPP)).toBeCloseTo(6, 9);
  });

  it('grows monotonically on screen as the camera closes in, then holds', () => {
    let last = 0;
    for (const d of [6800, 4000, 1000, 400, 220, 100, 50, 12, 7]) {
      const s = px(1, d);
      expect(s).toBeGreaterThanOrEqual(last - 1e-9);
      last = s;
    }
    expect(px(1, 4000)).toBeGreaterThanOrEqual(MARK_MIN_PX);
  });

  it('honours an exact pixel radius', () => {
    for (const d of [12, 220, 4000]) expect(markRadius(99, mppAt(d), 8) / mppAt(d)).toBeCloseTo(8, 9);
  });

  it('falls back to metres without a projection', () => {
    expect(markRadius(3, 0)).toBe(3);
    expect(lineWidth(0.4, 0)).toBe(0.4);
  });

  it('keeps lines in metres but never thinner than a pixel and a half', () => {
    expect(lineWidth(0.4, mppAt(12))).toBe(0.4);
    expect(lineWidth(0.4, mppAt(4000)) / mppAt(4000)).toBeCloseTo(LINE_MIN_PX, 9);
    expect(ringThickness(10, 0.01)).toBeCloseTo(0.8, 9);
  });

  it('measures the pixel size from a projection', () => {
    const scale = 3; // pixels per metre
    const project = (p: { x: number; z: number }) => ({ x: p.x * scale, y: p.z * scale * 0.5 });
    expect(metresPerPixelAt(project, { x: 10, y: 0, z: 10 })).toBeCloseTo(1 / 3, 9);
    expect(metresPerPixelAt(() => null, { x: 0, y: 0, z: 0 })).toBe(0);
  });
});
