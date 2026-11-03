import { describe, expect, it } from 'vitest';
import { defaultSignalPlan } from '../../src/core';
import { Simulation } from '../../src/sim';
import { crossroads, run } from './helpers';

function fingerprint(seed: number, seconds: number): string {
  const { net, hub, segs } = crossroads('avenue-4');
  const plan = defaultSignalPlan(net, hub, 'protectedLefts');
  net.setJunctionControl(hub, { mode: 'signal', signal: plan });
  net.setTraffic({ autoGatewayRatePerLane: 500 });
  const sim = new Simulation(net, seed);
  run(sim, seconds / 2);
  net.setRoadType(segs[0], 'avenue-6');
  run(sim, seconds / 2);
  const v = sim.vehicles;
  const parts: string[] = [];
  for (let i = 0; i < v.count; i++) parts.push(`${v.id[i]}:${v.x[i]}:${v.z[i]}:${v.speed[i]}`);
  const s = sim.stats();
  return `${s.spawnedTotal}|${s.arrivedTotal}|${s.active}|${parts.join(',')}`;
}

describe('determinism', () => {
  it('gives identical results for one seed, and different ones for another', () => {
    const a = fingerprint(71, 400);
    const b = fingerprint(71, 400);
    const c = fingerprint(72, 400);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeGreaterThan(200);
  });

  it('is not sensitive to how a run is driven by advance', () => {
    const one = crossroads('street-2');
    const two = crossroads('street-2');
    const a = new Simulation(one.net, 5);
    const b = new Simulation(two.net, 5);
    for (let i = 0; i < 1000; i++) a.step();
    a.speed = 1;
    b.speed = 4;
    let guard = 0;
    while (b.time < 99.95 && guard++ < 10000) b.advance(0.05);
    expect(b.time).toBeCloseTo(a.time, 5);
    expect(b.stats().spawnedTotal).toBe(a.stats().spawnedTotal);
    expect(b.stats().arrivedTotal).toBe(a.stats().arrivedTotal);
  });
});
