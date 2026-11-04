import { describe, expect, it } from 'vitest';
import { RoadNetwork, crossingPair } from '../../src/core';
import { Simulation } from '../../src/sim';
import { expectFiniteState, free, newSweep, run, sweepCrossings, worstLaneOverlap } from './helpers';

/** A street drawn in one stroke across a one-way highway, a dual carriageway, or a divided highway of two one-way roads. */
function scene(kind: 'highway-3' | 'dual-4' | 'divided'): { net: RoadNetwork; street: number[] } {
  const net = new RoadNetwork();
  if (kind === 'divided') {
    net.drawRoad({ start: free(-700, 15), end: free(700, 15), roadType: 'highway-3' });
    net.drawRoad({ start: free(700, -15), end: free(-700, -15), roadType: 'highway-3' });
  } else {
    net.drawRoad({ start: free(-700, 0), end: free(700, 0), roadType: kind });
  }
  const street = net.drawRoad({ start: free(0, -500), end: free(0, 500), roadType: 'street-2' }).segments;
  return { net, street };
}

describe('traffic through highway crossings at grade', () => {
  for (const kind of ['highway-3', 'dual-4', 'divided'] as const) {
    for (const [label, rate, seed] of [
      ['moderate', 300, 71],
      ['heavy', 450, 72],
    ] as const) {
      it(`${kind}, ${label} traffic: crosses and turns with no clashes and nothing stuck`, () => {
        const { net, street } = scene(kind);
        expect(street).toHaveLength(kind === 'divided' ? 3 : 2);
        if (kind === 'divided') expect(crossingPair(net, net.getSegment(street[1])!.a)).not.toBeNull();
        net.setTraffic({ autoGatewayRatePerLane: rate });
        const sim = new Simulation(net, seed);
        const sweep = newSweep();
        run(sim, 1200, () => {
          if (sim.state.tick % 5 === 0) {
            sweepCrossings(sim, sweep);
            expect(worstLaneOverlap(sim)).toBe(0);
            expectFiniteState(sim);
          }
        });
        const s = sim.stats();
        expect(sweep.sample).toEqual([]);
        expect(s.despawnedStuck).toBe(0);
        expect(s.arrivedTotal).toBeGreaterThan(300);
        // Every piece of the street carries traffic across, the median link included.
        for (const seg of street) expect(sim.segmentTraffic(seg).flowPerHour, `street ${seg}`).toBeGreaterThan(50);
      });
    }
  }
});
