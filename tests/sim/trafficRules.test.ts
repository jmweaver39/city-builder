import { describe, expect, it } from 'vitest';
import { defaultSignalPlan, type Id } from '../../src/core';
import { laneArrowsAt, setArmRule, setLaneArrows, setLaneVehicles } from '../../src/core/trafficRules';
import { Simulation } from '../../src/sim';
import { TURN_LEFT, TURN_RIGHT, TURN_UTURN } from '../../src/sim/compiled';
import { TYPE_TRUCK } from '../../src/sim/vehicleTypes';
import { LIGHT_RED } from '../../src/sim/signals';
import { crossroads, expectFiniteState, run } from './helpers';

/** Calls back once for every vehicle that moves from one lane onto another. */
function watchEntries(sim: Simulation, onEnter: (lane: number, from: number, type: number) => void) {
  const last = new Map<number, number>();
  return () => {
    const { veh } = sim.state;
    for (let i = 0; i < veh.liveCount; i++) {
      const k = veh.live[i];
      const id = veh.id[k];
      const lane = veh.lane[k];
      const was = last.get(id);
      if (was !== undefined && was !== lane) onEnter(lane, was, veh.type[k]);
      last.set(id, lane);
    }
  };
}

function busy(type = 'street-4', rate = 500) {
  const c = crossroads(type);
  c.net.setTraffic({ autoGatewayRatePerLane: rate });
  return c;
}

describe('traffic rules in the simulation', () => {
  it('drivers follow lane arrows, with no collisions', () => {
    const { net, hub, segs } = busy();
    // Every lane of every arm may only go straight or right: no left turns anywhere.
    for (const l of laneArrowsAt(net, hub)) setLaneArrows(net, hub, l.ref, l.available.filter((t) => t === 'straight' || t === 'right'));
    const sim = new Simulation(net, 3);
    let lefts = 0;
    let entries = 0;
    const each = watchEntries(sim, (lane) => {
      const g = sim.state.g;
      if (!g.isConn[lane]) return;
      entries++;
      if (g.turn[lane] === TURN_LEFT || g.turn[lane] === TURN_UTURN) lefts++;
    });
    run(sim, 240, each);
    expectFiniteState(sim);
    expect(entries).toBeGreaterThan(50);
    expect(lefts).toBe(0);
    expect(sim.stats().collisions).toBe(0);
    expect(segs.length).toBe(4);
  });

  it('U-turns allowed on an arm get used', () => {
    const { net, hub, segs } = busy('street-4', 400);
    for (const s of segs) setArmRule(net, hub, s, 'uturn', true);
    const sim = new Simulation(net, 5);
    const g0 = sim.state.g;
    let uturnLanes = 0;
    for (const i of net.laneGraph.connectorsAt.get(hub)!) if (g0.turn[i] === TURN_UTURN) uturnLanes++;
    expect(uturnLanes).toBe(4);
    run(sim, 180);
    expect(sim.stats().collisions).toBe(0);
  });

  it('trucks never use a lane they are banned from', () => {
    const { net, segs } = busy('street-4', 400);
    net.setTraffic({ defaultMix: { car: 0.3, van: 0.1, truck: 0.6, bus: 0 } });
    setLaneVehicles(net, segs[2], null, ['car', 'van', 'bus', 'bike']);
    const sim = new Simulation(net, 7);
    const banned = new Set(net.laneGraph.roadLanes.get(segs[2])!);
    let trucksOnBanned = 0;
    let trucks = 0;
    let carsOnBanned = 0;
    const each = () => {
      const { veh } = sim.state;
      for (let i = 0; i < veh.liveCount; i++) {
        const k = veh.live[i];
        if (veh.type[k] !== TYPE_TRUCK) {
          if (banned.has(veh.lane[k])) carsOnBanned++;
          continue;
        }
        trucks++;
        if (banned.has(veh.lane[k])) trucksOnBanned++;
      }
    };
    run(sim, 200, each);
    expect(trucks).toBeGreaterThan(100);
    expect(carsOnBanned).toBeGreaterThan(0);
    expect(trucksOnBanned).toBe(0);
    expect(sim.stats().collisions).toBe(0);
  });

  it('turns right on red only where allowed, after stopping', () => {
    const count = (allow: boolean) => {
      const { net, hub, segs } = busy('street-4', 450);
      net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'opposing') });
      if (allow) for (const s of segs) setArmRule(net, hub, s, 'nearTurnOnRed', true);
      const sim = new Simulation(net, 11);
      let rightOnRed = 0;
      let otherOnRed = 0;
      const each = watchEntries(sim, (lane, from) => {
        const { g, sig } = sim.state;
        if (!g.isConn[lane] || g.isConn[from]) return;
        if (sig.state[lane] !== LIGHT_RED) return;
        if (g.turn[lane] === TURN_RIGHT) rightOnRed++;
        else otherOnRed++;
      });
      run(sim, 300, each);
      expect(sim.stats().collisions).toBe(0);
      expectFiniteState(sim);
      return { rightOnRed, otherOnRed };
    };
    const off = count(false);
    const on = count(true);
    expect(off.rightOnRed).toBe(0);
    expect(on.rightOnRed).toBeGreaterThan(0);
    expect(on.otherOnRed).toBe(0);
  });

  it('entering a blocked junction compiles and keeps the no-collision guarantee', () => {
    const { net, hub, segs } = busy('street-2', 900);
    for (const s of segs) setArmRule(net, hub, s, 'enterBlocked', true);
    const sim = new Simulation(net, 13);
    const conns = net.laneGraph.connectorsAt.get(hub)!;
    expect(conns.every((c) => sim.state.jn.boxFree[c] === 1)).toBe(true);
    run(sim, 200);
    expect(sim.stats().collisions).toBe(0);
  });

  it('hand light control holds red and lets a chosen movement go', () => {
    const { net, hub, segs } = busy('street-4', 500);
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'opposing') });
    const sim = new Simulation(net, 17);
    run(sim, 60);
    expect(sim.setManualSignal(hub, true)).toBe(true);
    const moves = sim.signalMovements(hub)!;
    for (const key of Object.keys(moves)) sim.setManualMovement(hub, key, false);
    // After the yellow, nobody enters.
    run(sim, 5);
    let entered = 0;
    let onRed = 0;
    let onChosen = 0;
    const chosen = Object.keys(moves).find((k) => k.startsWith(`${segs[0]}>`))!;
    const each = watchEntries(sim, (lane, from) => {
      const { g, sig } = sim.state;
      if (!g.isConn[lane] || g.isConn[from]) return;
      entered++;
      if (sig.state[lane] === LIGHT_RED) onRed++;
      const key = `${g.graph.lanes[g.fromLane[lane]].segmentId}>${g.graph.lanes[g.toLane[lane]].segmentId}`;
      if (key === chosen) onChosen++;
    });
    run(sim, 30, each);
    expect(entered).toBe(0);
    sim.setManualMovement(hub, chosen, true);
    run(sim, 60, each);
    expect(onChosen).toBeGreaterThan(0);
    expect(onRed).toBe(0);
    expect(sim.signalMovements(hub)![chosen]).toBe(true);
    // Back to automatic: the plan runs again and survives an edit.
    sim.setManualSignal(hub, false);
    expect(sim.isManualSignal(hub)).toBe(false);
    run(sim, 60);
    expect(sim.stats().collisions).toBe(0);
  });

  it('hand control survives a network edit', () => {
    const { net, hub, ends } = busy('street-4', 300);
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'opposing') });
    const sim = new Simulation(net, 19);
    run(sim, 10);
    sim.setManualSignal(hub, true);
    for (const key of Object.keys(sim.signalMovements(hub)!)) sim.setManualMovement(hub, key, false);
    net.moveNode(ends[0] as Id, { x: 310, y: 0, z: 5 });
    run(sim, 10);
    const greens = Object.values(sim.signalMovements(hub)!).filter(Boolean).length;
    expect(greens).toBe(0);
  });

  it('clears all traffic, or only stuck vehicles, and pauses spawning', () => {
    const { net } = busy('street-4', 600);
    const sim = new Simulation(net, 23);
    run(sim, 60);
    expect(sim.stats().active).toBeGreaterThan(10);
    expect(sim.clearTraffic({ stuckOnly: true, stuckSec: 1e9 })).toBe(0);
    sim.setSpawnPaused(true);
    const removed = sim.clearTraffic();
    expect(removed).toBeGreaterThan(10);
    expect(sim.stats().active).toBe(0);
    expect(sim.vehicles.count).toBe(0);
    run(sim, 20);
    expect(sim.stats().active).toBe(0);
    sim.setSpawnPaused(false);
    run(sim, 20);
    expect(sim.stats().active).toBeGreaterThan(0);
    expect(sim.stats().collisions).toBe(0);
  });
});
