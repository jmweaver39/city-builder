import { describe, expect, it } from 'vitest';
import { defaultSignalPlan, type RoadNetwork, type SignalPlan } from '../../src/core';
import { Simulation } from '../../src/sim';
import { crossroads, expectFiniteState, run, worstLaneOverlap } from './helpers';

/** Watches lane changes between steps and counts crossings of the stop lines. */
function watchLines(sim: Simulation) {
  const lastLane = new Map<number, number>();
  const crossed = new Map<string, number>();
  let onRed = 0;
  let onYellow = 0;
  return {
    check() {
      const { veh, g } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        const id = veh.id[k];
        const lane = veh.lane[k];
        const was = lastLane.get(id);
        if (was !== lane) {
          if (was !== undefined && g.isConn[lane] && !g.isConn[was]) {
            const light = sim.connectorLight(lane);
            if (light === 'red') onRed++;
            if (light === 'yellow') onYellow++;
            const seg = g.graph.lanes[was].segmentId;
            crossed.set(String(seg), (crossed.get(String(seg)) ?? 0) + 1);
          }
          lastLane.set(id, lane);
        }
      }
    },
    get onRed() {
      return onRed;
    },
    get onYellow() {
      return onYellow;
    },
    crossed,
  };
}

function signalled(type: string, plan: (net: RoadNetwork, hub: number) => SignalPlan, rate = 500) {
  const { net, hub, segs } = crossroads(type);
  net.setJunctionControl(hub, { mode: 'signal', signal: plan(net, hub) });
  net.setTraffic({ autoGatewayRatePerLane: rate });
  return { net, hub, segs };
}

describe('fixed signals', () => {
  it('no vehicle crosses on red, and every approach gets through', () => {
    const { net, hub, segs } = signalled('street-2', (n, h) => defaultSignalPlan(n, h, 'opposing'));
    const sim = new Simulation(net, 3);
    const watch = watchLines(sim);
    run(sim, 1800, () => {
      watch.check();
      expect(worstLaneOverlap(sim)).toBe(0);
    });
    expect(watch.onRed).toBe(0);
    for (const seg of segs) expect(watch.crossed.get(String(seg)) ?? 0).toBeGreaterThan(40);
    expect(sim.stats().arrivedTotal).toBeGreaterThan(300);
    expect(sim.signalStatus(hub)).not.toBeNull();
  });

  it.each([['protectedLefts'], ['split']] as const)('runs the %s preset with no red running', (preset) => {
    const { net, segs } = signalled('avenue-4', (n, h) => defaultSignalPlan(n, h, preset), 400);
    const sim = new Simulation(net, 4);
    const watch = watchLines(sim);
    run(sim, 1500, () => watch.check());
    expect(watch.onRed).toBe(0);
    for (const seg of segs) expect(watch.crossed.get(String(seg)) ?? 0).toBeGreaterThan(30);
  });

  it('follows the phase clock, stages and offset', () => {
    const { net, hub } = crossroads('street-2');
    const plan = defaultSignalPlan(net, hub, 'opposing');
    plan.phases[0].greenSec = 10;
    plan.phases[0].yellowSec = 3;
    plan.phases[0].allRedSec = 2;
    plan.phases[1].greenSec = 20;
    plan.phases[1].yellowSec = 3;
    plan.phases[1].allRedSec = 2;
    net.setJunctionControl(hub, { mode: 'signal', signal: plan });
    net.setTraffic({ multiplier: 0 });
    const sim = new Simulation(net, 1);
    const stages: string[] = [];
    run(sim, 40, () => {
      const st = sim.signalStatus(hub)!;
      const label = `${st.phaseIndex}:${st.stage}`;
      if (stages[stages.length - 1] !== label) stages.push(label);
    });
    expect(stages.slice(0, 6)).toEqual(['0:green', '0:yellow', '0:allRed', '1:green', '1:yellow', '1:allRed']);
    plan.offsetSec = 12;
    net.setJunctionControl(hub, { signal: { ...plan } });
    const shifted = new Simulation(net, 1);
    shifted.step();
    expect(shifted.signalStatus(hub)!.stage).toBe('yellow');
    const heads = sim.signalHeads();
    expect(heads.length).toBe(4);
    expect(heads.every((h) => ['red', 'yellow', 'green'].includes(h.state))).toBe(true);
  });

  it('gives permissive lefts gaps through protected flow', () => {
    const { net, hub, segs } = crossroads('street-2');
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'opposing') });
    net.setTraffic({ autoGatewayRatePerLane: 450 });
    const sim = new Simulation(net, 7);
    const { g } = sim.state;
    const lefts = new Set(net.laneGraph.connectorsAt.get(hub)!.filter((c) => g.graph.lanes[c].turn === 'left'));
    const seen = new Set<number>();
    run(sim, 1500, () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        if (lefts.has(veh.lane[k])) seen.add(veh.id[k]);
      }
    });
    expect(seen.size).toBeGreaterThan(30);
    expect(segs.length).toBe(4);
  });
});

describe('actuated signals', () => {
  it('skips a phase nobody wants and serves a phase that has demand', () => {
    const { net, hub, ends } = crossroads('street-2');
    const plan = defaultSignalPlan(net, hub, 'opposing');
    plan.kind = 'actuated';
    for (const p of plan.phases) {
      p.minGreenSec = 5;
      p.maxGreenSec = 20;
    }
    net.setJunctionControl(hub, { mode: 'signal', signal: plan });
    net.setTraffic({ autoGateways: false });
    // Traffic only on one axis: only ends[0] sends, to ends[1].
    net.addEndpoint({ kind: 'gateway', nodeId: ends[0], ratePerHour: 600 });
    net.addEndpoint({ kind: 'gateway', nodeId: ends[1], ratePerHour: 600 });
    const sim = new Simulation(net, 5);
    const watch = watchLines(sim);
    // The plan may start on the empty axis. Once off it, it must never go back.
    run(sim, 60, () => watch.check());
    const phases = new Set<number>();
    run(sim, 600, () => {
      watch.check();
      phases.add(sim.signalStatus(hub)!.phaseIndex);
      expectFiniteState(sim);
    });
    expect(watch.onRed).toBe(0);
    expect(sim.stats().arrivedTotal).toBeGreaterThan(100);
    expect(phases.size).toBe(1);
  });

  it('alternates when both axes have demand', () => {
    const { net, hub, segs } = crossroads('street-2');
    const plan = defaultSignalPlan(net, hub, 'opposing');
    plan.kind = 'actuated';
    for (const p of plan.phases) {
      p.minGreenSec = 5;
      p.maxGreenSec = 25;
    }
    net.setJunctionControl(hub, { mode: 'signal', signal: plan });
    net.setTraffic({ autoGatewayRatePerLane: 400 });
    const sim = new Simulation(net, 6);
    const watch = watchLines(sim);
    const phases = new Set<number>();
    run(sim, 1200, () => {
      watch.check();
      phases.add(sim.signalStatus(hub)!.phaseIndex);
    });
    expect(watch.onRed).toBe(0);
    expect(phases.size).toBe(2);
    for (const seg of segs) expect(watch.crossed.get(String(seg)) ?? 0).toBeGreaterThan(30);
  });
});
