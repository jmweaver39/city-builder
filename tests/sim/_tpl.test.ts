import { it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { safetyDebug } from '../../src/sim/safety';
import { TEMPLATES, stampTemplate } from '../../src/templates';
import { checkBodies, newBodyCheck } from './helpers';

const ONLY = (globalThis as any).ONLY as string[] | undefined;
it('templates', () => {
  for (const t of TEMPLATES) {
    for (const seed of [1, 2]) {
      const net = new RoadNetwork();
      stampTemplate(net, t.id, {}, { pos: { x: 0, y: 0, z: 0 }, rotation: 0, elevation: 0 });
      net.setTraffic({ multiplier: 0.7 });
      const t0 = performance.now();
      const sim = new Simulation(net, seed);
      const hist: Record<string, number> = {};
      const locs: string[] = [];
      safetyDebug.onStop = (w, a, b, loser) => {
        const { veh, g } = w;
        const nm = (v: number) => { const l = g.graph.lanes[veh.lane[v]]; return `${l.kind === 'connector' ? (l.turn ?? 'c')[0].toUpperCase() : 'r'}${veh.type[v]}`; };
        const key = [nm(a), nm(b)].sort().join('~');
        hist[key] = (hist[key] ?? 0) + 1;
        if (locs.length < 2 && hist[key] === 50) {
          const d = (v: number) => `id${veh.id[v]} t${veh.type[v]} ${g.graph.lanes[veh.lane[v]].key}@${veh.s[v].toFixed(1)}/${g.len[veh.lane[v]].toFixed(0)} prev ${veh.prev1[v] >= 0 ? g.graph.lanes[veh.prev1[v]].key : '-'} v${veh.v[v].toFixed(1)} nx ${veh.nextLane[v] >= 0 ? g.graph.lanes[veh.nextLane[v]].key : '-'} perm ${veh.permit[v] >= 0 ? g.graph.lanes[veh.permit[v]].key : '-'} den${veh.denied[v]} ent${veh.enterTick[v]} lc${veh.lcSec[v].toFixed(1)}`;
          locs.push(`t=${sim.time.toFixed(0)} ${loser === a ? 'A' : 'B'} [${d(a)}] [${d(b)}]`);
        }
      };
      const check = newBodyCheck();
      const arr: number[] = [];
      let last = 0;
      for (let w = 0; w < 4; w++) {
        for (let i = 0; i < 3000; i++) { sim.step(); if (i % 5 === 0) checkBodies(sim, check); }
        console.log(`   window ${w} ${t.id} s${seed} ${((performance.now() - t0) / 1000).toFixed(1)}s active ${sim.stats().active} safety ${sim.stats().safetyStops}`);
        arr.push(sim.stats().arrivedTotal - last); last = sim.stats().arrivedTotal;
      }
      safetyDebug.onStop = null;
      const st = sim.stats();
      const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, b]) => `${a}:${b}`).join(' ');
      console.log(`TPL ${((performance.now() - t0) / 1000).toFixed(1)}s ${t.id.padEnd(18)} s${seed} arr ${arr.join('/')} hits ${check.hits} coll ${st.collisions} safety ${st.safetyStops} stuck ${st.despawnedStuck} | ${top}`);
      for (const l of locs) console.log('     ', l);
    }
  }
}, 600000);
