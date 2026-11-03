import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { CAR_KINDS, makeConsist, RailRng, TRAIN_TYPES, TrainSim, RAIL_DT, trainLength } from '../../src/rail';
import { station, straightLine, v } from './helpers';

describe('consists', () => {
  it('builds each type to its real size', () => {
    const rng = new RailRng(3);
    expect(makeConsist('metro', 8, rng).length).toBeGreaterThan(155);
    expect(makeConsist('metro', 8, rng).count).toBe(8);
    expect(makeConsist('emu', 12, rng).length).toBeGreaterThan(300);
    expect(makeConsist('highspeed', 16, rng).length).toBeGreaterThan(400);
    const ic = makeConsist('intercity', 12, rng);
    expect(CAR_KINDS[ic.kinds[0]].id).toBe('electricLoco');
    expect(CAR_KINDS[ic.kinds[ic.count - 1]].id).toBe('cabCar');
    const f = makeConsist('freight', 124, rng);
    expect(f.length).toBeGreaterThan(2000);
    expect(new Set(f.kinds).size).toBeGreaterThan(3);
    expect([...f.kinds].filter((k) => CAR_KINDS[k].id === 'dieselLoco')).toHaveLength(4);
    expect(makeConsist('freight', 42, rng).length).toBeGreaterThan(700);
    expect(trainLength('freight', 90)).toBeGreaterThan(1200);
  });

  it('clamps to what a type allows', () => {
    const rng = new RailRng(3);
    expect(makeConsist('metro', 99, rng).count).toBe(TRAIN_TYPES.metro.maxCars);
    expect(makeConsist('highspeed', 3, rng).count).toBe(16);
  });
});

/** A train leaving a station and running to a stop far off. */
function run(type: 'emu' | 'freight' | 'highspeed' | 'metro', cars: number, track: string, length: number, rise = 0) {
  const net = new RoadNetwork();
  const a = net.addNode(v(0, 0));
  const b = net.addNode(v(length, 0, rise));
  const seg = net.addSegment(a, b, { roadType: track });
  const len = trainLength(type, cars);
  const from = station(net, seg, (len + 100) / length, 'A', len + 40);
  const to = station(net, seg, 1 - (len + 100) / length, 'B', len + 40);
  net.addLine({ name: 'L', color: '#fff', stops: [from, to], trainType: type, cars, trains: 1 });
  return { net, sim: new TrainSim(net) };
}

interface Trace {
  top: number;
  brakeFrom: number;
  brakeDistance: number;
  stoppedAt: number;
  toSpeed: number[];
}

function trace(sim: TrainSim, steps: number, marks: number[]): Trace {
  const out: Trace = { top: 0, brakeFrom: 0, brakeDistance: 0, stoppedAt: 0, toSpeed: marks.map(() => 0) };
  let braking: number | null = null;
  for (let i = 0; i < steps; i++) {
    sim.step();
    const t = sim.trains[0];
    if (!t) continue;
    if (t.state !== 'run') {
      if (out.top > 5) break;
      continue;
    }
    out.top = Math.max(out.top, t.v);
    marks.forEach((m, k) => {
      if (!out.toSpeed[k] && t.v * 3.6 >= m) out.toSpeed[k] = (i - 0) * RAIL_DT;
    });
    if (t.a < -0.01 && braking === null) {
      braking = t.head;
      out.brakeFrom = t.v;
    }
    if (braking !== null && t.a >= -0.01 && t.v > 1) braking = null;
    if (braking !== null) out.brakeDistance = t.head - braking;
  }
  return out;
}

describe('train physics', () => {
  it('metro accelerates hard, freight slowly', () => {
    const metro = trace(run('metro', 8, 'metro-double', 3000).sim, 6000, [60]);
    const freight = trace(run('freight', 100, 'rail-double', 12000).sim, 30000, [60]);
    expect(metro.toSpeed[0]).toBeGreaterThan(0);
    expect(freight.toSpeed[0] - 30).toBeGreaterThan((metro.toSpeed[0] - 30) * 5);
  });

  it('a high-speed train reaches 300 km/h on a long enough line', () => {
    const r = trace(run('highspeed', 16, 'hsr-double', 40000).sim, 40000, [300]);
    expect(r.top * 3.6).toBeGreaterThan(297);
    expect(r.top * 3.6).toBeLessThan(301);
  });

  it('brakes further on a falling grade and with a heavier train', () => {
    const flat = trace(run('freight', 66, 'rail-double', 5000).sim, 16000, []);
    const falling = trace(run('freight', 66, 'rail-double', 5000, -100).sim, 16000, []);
    const emu = trace(run('emu', 8, 'rail-double', 5000).sim, 16000, []);
    const rate = (r: Trace) => (r.brakeFrom * r.brakeFrom) / (2 * r.brakeDistance);
    expect(rate(flat)).toBeGreaterThan(0.1);
    expect(rate(emu)).toBeGreaterThan(rate(flat) * 1.8);
    expect(rate(falling)).toBeLessThan(rate(flat));
  });

  it('keeps to the limit through a curve', () => {
    const net = new RoadNetwork();
    const a = net.addNode(v(-1500, 0));
    const b = net.addNode(v(-200, 0));
    const c = net.addNode(v(200, 400));
    const d = net.addNode(v(200, 1800));
    const s1 = net.addSegment(a, b, { roadType: 'rail-double' });
    net.addSegment(b, c, { c1: v(20, 0), c2: v(200, 180), roadType: 'rail-double' });
    const s3 = net.addSegment(c, d, { roadType: 'rail-double' });
    const from = station(net, s1, 0.2, 'A');
    const to = station(net, s3, 0.75, 'B');
    net.addLine({ name: 'L', color: '#fff', stops: [from, to], trainType: 'emu', cars: 8, trains: 1 });
    const sim = new TrainSim(net);
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      sim.step();
      const t = sim.trains[0];
      if (!t || t.state !== 'run') continue;
      const tail = t.head - t.consist.length;
      for (let k = t.path.locate(Math.max(tail, 0)); k <= t.path.locate(t.head); k++) {
        const p = sim.graph.pieces[t.path.states[k] >> 1];
        worst = Math.max(worst, t.v - p.speed);
      }
    }
    expect(worst).toBeLessThan(1);
  });
});
