import { it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { Simulation } from '../../src/sim';
import { stampTemplate } from '../../src/templates';

it('dbg', () => {
  const net = new RoadNetwork();
  stampTemplate(net, 'diamond', {}, { pos: { x: 0, y: 0, z: 0 }, rotation: 0, elevation: 0 });
  net.setTraffic({ multiplier: 0.7 });
  const sim = new Simulation(net, 1);
  let shown = 0;
  for (let i = 0; i < 12000 && shown < 1; i++) {
    sim.step();
    const { veh, g } = sim.state;
    for (let j = 0; j < veh.liveCount && shown < 1; j++) {
      const k = veh.live[j];
      if (veh.stuckSec[k] < 100) continue;
      shown++;
      console.log('t', sim.time.toFixed(0));
      const d = (v: number) => `id${veh.id[v]} t${veh.type[v]} ${g.graph.lanes[veh.lane[v]].key}@${veh.s[v].toFixed(1)}/${g.len[veh.lane[v]].toFixed(0)} v${veh.v[v].toFixed(1)} nx ${veh.nextLane[v] >= 0 ? g.graph.lanes[veh.nextLane[v]].key : '-'} perm ${veh.permit[v] >= 0 ? 'Y' : '-'} den${veh.denied[v]} ent${veh.enterTick[v]} stuck${veh.stuckSec[v].toFixed(0)} hard${veh.gapHard[v].toFixed(1)} held${veh.held[v]}`;
      for (let q = 0; q < veh.liveCount; q++) {
        const u = veh.live[q];
        if (veh.stuckSec[u] > 30 && (g.isConn[veh.lane[u]] || g.len[veh.lane[u]] - veh.s[u] < 15)) console.log('  ', d(u));
      }
    }
  }
});
