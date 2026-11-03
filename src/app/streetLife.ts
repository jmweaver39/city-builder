/**
 * Wires close-up street life into the app: the pedestrian sim (src/peds), its
 * render layer, and the static street detail layer, all added through the
 * renderer's RenderContext. Both layers switch themselves off when the camera is
 * far away, so this costs nothing zoomed out.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id } from '../core/types';
import { PedSim } from '../peds/PedSim';
import { FLAG_DOORS, FLAG_DOORS_R, type TrainSim } from '../rail/TrainSim';
import { PedLayer } from '../render/peds';
import type { Renderer } from '../render/Renderer';
import { StreetDetailLayer } from '../render/streetDetail';
import type { Simulation } from '../sim/Simulation';
import { registerKeys } from '../ui/keymap';
import type { UiContext } from '../ui/context';
import type { History } from './History';

export interface StreetLife {
  peds: PedSim;
  pedLayer: PedLayer;
  detail: StreetDetailLayer;
  /** Turn people and props on or off together. */
  setEnabled(on: boolean): void;
}

export function installStreetLife(opts: { net: RoadNetwork; sim: Simulation; renderer: Renderer; trains?: TrainSim | null; history?: History; ui?: UiContext }): StreetLife {
  const { net, sim, renderer, trains, history, ui } = opts;
  const peds = new PedSim(net, sim, { seed: 7, hook: true });
  const pose = () => renderer.getCamera();
  if (trains) {
    // A train standing at a station with its doors open lets people on and off.
    peds.stationDoors = (stationId: Id) => {
      const st = trains.graph.stations.get(stationId);
      if (!st) return false;
      const v = trains.view;
      const reach = st.platformLength / 2 + 12;
      for (let i = 0; i < v.count; i++) {
        if (!(v.flags[i] & (FLAG_DOORS | FLAG_DOORS_R))) continue;
        const dx = v.x[i] - st.center.x;
        const dz = v.z[i] - st.center.z;
        if (dx * dx + dz * dz < reach * reach) return true;
      }
      return false;
    };
  }
  const pedLayer = new PedLayer(peds, renderer.context, pose, (dt) => {
    peds.hour = renderer.getTimeOfDay();
    peds.step(Math.min(dt, 0.1) * sim.speed);
  });
  renderer.context.addLayer(pedLayer);
  const detail = new StreetDetailLayer(net, renderer.context, pose);
  renderer.context.addLayer(detail);
  if (ui) ui.peds = peds;
  // A palette command for the crosswalk setting, which costs some throughput at rush hour.
  registerKeys([
    {
      id: 'traffic.pedestriansStopTraffic',
      label: 'Pedestrians stop traffic at crosswalks',
      group: 'Simulation',
      keys: [],
      scope: 'global',
      desc: 'On: cars stop for people on crosswalks. Off: people cross only in gaps, and traffic flows a little better.',
      run: () => {
        const on = net.traffic.pedestriansStopTraffic === false;
        history?.hint('Pedestrians stop traffic');
        net.setTraffic({ pedestriansStopTraffic: on });
        ui?.toast(on ? 'Pedestrians stop traffic at crosswalks.' : 'Pedestrians cross only in gaps in the traffic.');
      },
    },
  ]);
  return {
    peds,
    pedLayer,
    detail,
    setEnabled(on) {
      pedLayer.enabled = on;
      detail.enabled = on;
    },
  };
}
