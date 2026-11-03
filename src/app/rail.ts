/** Wires trains into the app: the sim, its render layer, the tools and the panels. */
import type { RoadNetwork } from '../core/RoadNetwork';
import { buildRailDemo, RAIL_DEMO_CAMERA } from '../rail/demo';
import { TrainSim } from '../rail/TrainSim';
import { RailLayer } from '../render/rail';
import type { Renderer } from '../render/Renderer';
import type { Simulation } from '../sim/Simulation';
import type { ToolManager } from '../tools/ToolManager';
import { registerKeys } from '../ui/keymap';
import { LinesPanel } from '../ui/RailPanels';
import { confirmDialog } from '../ui/Panel';
import type { UI } from '../ui/UI';
import type { History } from './History';

/** Seconds of train running before a fresh scene is shown, so trains are out on the line. */
const WARM_SEC = 40;
const PANEL_TICK = 0.25;

export interface RailApp {
  trains: TrainSim;
  layer: RailLayer;
  /** Real seconds of frame; follows the road sim's speed and pause. */
  advance(dt: number): void;
  reset(): void;
  warm(): void;
}

export function installRail(opts: { net: RoadNetwork; sim: Simulation; renderer: Renderer; tools: ToolManager; history: History; ui: UI; warmRoads: () => void }): RailApp {
  const { net, sim, renderer, tools, history, ui } = opts;
  const trains = new TrainSim(net, 7);
  trains.onCrossing = (lanes, closed) => {
    for (const l of lanes) sim.blockConflict?.(l, closed);
  };
  const layer = new RailLayer(net, renderer.context, () => renderer.getCamera().distance, (target) => renderer.setCamera({ target: { ...target } }));
  layer.trains = trains;
  renderer.context.addLayer(layer);
  tools.setRail({
    trains,
    pickTrain: (x, y) => {
      const ray = renderer.pickRay(x, y);
      return ray ? layer.pick(ray.origin, ray.dir) : null;
    },
  });
  const lines = new LinesPanel(ui.context);
  const app: RailApp = {
    trains,
    layer,
    advance(dt) {
      trains.advance(Math.min(dt, 0.1) * sim.speed);
    },
    reset() {
      trains.reset();
    },
    warm() {
      trains.warm(WARM_SEC);
    },
  };
  ui.context.rail = {
    trains,
    layer,
    openLines: () => lines.toggle(),
    loadDemo: (how?: { confirmed?: boolean }) => {
      const go = (): void => {
      // One undo step, so the map it replaces comes back with Undo. Clear first and let
      // the road sim settle on the empty map before building: its reset reads places
      // against the graph it had, which must not be the old one.
      history.replaceUndoable('Load rail demo', () => {
        net.clear('Rail demo');
        sim.step();
        buildRailDemo(net);
      });
      trains.reset();
      opts.warmRoads();
      // Long enough for every line to have its whole fleet out.
      trains.warm(300);
      renderer.setCamera(RAIL_DEMO_CAMERA, true);
      ui.toolbar.openTab('rail');
      ui.context.toast('Rail demo: a main line with commuter and freight trains, and a subway. Press U for the underground view. Undo brings back your map.');
      };
      if (how?.confirmed) {
        go();
        return;
      }
      void confirmDialog(ui.context.host, {
        title: 'Load the rail demo?',
        message: 'Replace the current map with the rail demo? Unsaved changes will be lost, though Undo brings the map back.',
        confirm: 'Replace',
        danger: true,
      }).then((ok) => {
        if (ok) go();
      });
    },
  };
  // Shortcuts and palette commands live in the shared keymap. O itself is handled by
  // the tool manager while the cursor is over track; the binding documents it.
  const wires = (on: boolean) => () => {
    tools.electrify.electrify = on;
    tools.setTool('electrify');
    ui.toolbar.openTab('rail');
  };
  registerKeys([
    {
      id: 'rail.wires',
      label: 'Overhead wires',
      group: 'Trains',
      keys: ['O', 'Shift+O'],
      scope: 'hover:track',
      shadows: ['tool.roundabout'],
      desc: 'Over a track: toggle its overhead wires (third rail on metro). Shift does the whole line',
      noPalette: true,
    },
    { id: 'station.layout', label: 'Next platform layout', group: 'Trains', keys: [']'], scope: 'tool:station', desc: 'Side, both sides or island', noPalette: true },
    { id: 'station.flip', label: 'Flip platform side', group: 'Trains', keys: ['['], scope: 'tool:station', desc: 'Put the side platform, or the building, on the other side', noPalette: true },
    { id: 'rail.electrify', label: 'Electrify track', group: 'Trains', keys: [], scope: 'global', desc: 'Sweep along track to put up overhead wires', run: wires(true) },
    { id: 'rail.deElectrify', label: 'Remove overhead wires', group: 'Trains', keys: [], scope: 'global', desc: 'Sweep along track to make it diesel only', run: wires(false) },
    { id: 'rail.lines', label: 'Train lines', group: 'Trains', keys: [], scope: 'global', desc: 'Every line with its trains and stats', run: () => lines.toggle() },
    { id: 'rail.demo', label: 'Load the rail demo', group: 'Trains', keys: [], scope: 'global', desc: 'Replace the map with a sample railway', run: () => ui.context.rail?.loadDemo() },
  ]);
  let tick = 0;
  const origUpdate = ui.update.bind(ui);
  ui.update = (dt: number) => {
    origUpdate(dt);
    tick += dt;
    if (tick >= PANEL_TICK) {
      tick = 0;
      lines.tick();
    }
  };
  return app;
}
