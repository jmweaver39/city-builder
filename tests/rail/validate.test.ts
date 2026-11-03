import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { straightLine, v } from './helpers';

const codes = (net: RoadNetwork, d: Parameters<RoadNetwork['validateDraft']>[0]) =>
  net.validateDraft(d).filter((i) => i.severity === 'error').map((i) => i.code);

/** A cubic arc of about the given radius over a right angle. */
function arc(r: number) {
  const k = 0.5523 * r;
  return { start: { kind: 'free' as const, pos: v(0, 0) }, end: { kind: 'free' as const, pos: v(r, r) }, c1: v(k, 0), c2: v(r, r - k) };
}

describe('track drafts', () => {
  it.each([
    ['rail-single', 150],
    ['rail-double', 150],
    ['metro-double', 80],
    ['hsr-double', 600],
  ])('%s needs a radius of %d m', (roadType, radius) => {
    const net = new RoadNetwork();
    expect(codes(net, { ...arc(radius * 1.15), roadType })).not.toContain('tightCurve');
    expect(codes(net, { ...arc(radius * 0.8), roadType })).toContain('tightCurve');
  });

  it('holds main line to 2.5% and metro to 4%', () => {
    const net = new RoadNetwork();
    const draft = (run: number, rise: number, roadType: string) => ({
      start: { kind: 'free' as const, pos: v(0, 0) },
      end: { kind: 'free' as const, pos: v(run, 0, rise) },
      roadType,
    });
    expect(codes(net, draft(400, 8, 'rail-double'))).not.toContain('tooSteep');
    expect(codes(net, draft(400, 12, 'rail-double'))).toContain('tooSteep');
    expect(codes(net, draft(400, 12, 'metro-double'))).not.toContain('tooSteep');
    expect(codes(net, draft(400, 20, 'metro-double'))).toContain('tooSteep');
  });

  it('refuses metro at grade over a road, and a road over metro', () => {
    const net = new RoadNetwork();
    straightLine(net, 'metro-double', -300, 300);
    const road = { start: { kind: 'free' as const, pos: v(0, -200) }, end: { kind: 'free' as const, pos: v(0, 200) } };
    expect(codes(net, { ...road, roadType: 'street-2' })).toContain('railCrossing');
    expect(codes(net, { ...road, roadType: 'rail-single' })).toContain('railCrossing');
    const other = new RoadNetwork();
    straightLine(other, 'street-2', -300, 300);
    expect(codes(other, { ...road, roadType: 'metro-double' })).toContain('railCrossing');
    expect(codes(other, { ...road, roadType: 'rail-double' })).not.toContain('railCrossing');
  });

  it('lets metro pass under a road with clearance', () => {
    const net = new RoadNetwork();
    straightLine(net, 'street-2', -300, 300);
    expect(
      codes(net, { start: { kind: 'free', pos: v(0, -200, -12) }, end: { kind: 'free', pos: v(0, 200, -12) }, roadType: 'metro-double' }),
    ).not.toContain('railCrossing');
  });

  it('refuses track ending on a road', () => {
    const net = new RoadNetwork();
    const { seg } = straightLine(net, 'street-2', -300, 300);
    expect(codes(net, { start: { kind: 'segment', id: seg, t: 0.5 }, end: { kind: 'free', pos: v(0, 300) }, roadType: 'rail-single' })).toContain('railCrossing');
  });
});
