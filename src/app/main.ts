/** Bootstrap: build the network, the sim, the renderer, the tools and the UI, then run the loop. */
import { ProjectFormatError } from '../core/serialize';
import { RoadNetwork } from '../core/RoadNetwork';
import { Renderer, WebGLUnavailableError } from '../render/Renderer';
import { Simulation } from '../sim/Simulation';
import * as templates from '../templates';
import { ToolManager } from '../tools/ToolManager';
import { UI } from '../ui/UI';
import { History } from './History';
import { installRail, type RailApp } from './rail';
import { buildStarterScene } from './starter';
import { debounce, SaveStore, type KeyValueStore, type SaveRecord } from './storage';

declare global {
  interface Window {
    __cloverleaf?: {
      net: RoadNetwork;
      sim: Simulation;
      renderer: Renderer;
      tools: ToolManager;
      history: History;
      ui: UI;
      trains?: import('../rail/TrainSim').TrainSim;
      rail?: import('../render/rail').RailLayer;
    };
  }
}

const AUTOSAVE_MS = 1500;
/** Fixed sim steps run before the first frame of the starter, so roads are not empty. */
const STARTER_WARM_STEPS = 400;
/** Frames the starter scene. */
const STARTER_CAMERA = { target: { x: -40, y: 0, z: -90 }, distance: 1050, yaw: 0, pitch: 1.3 };
/** Longest step fed to the sim, so a stalled tab does not run a burst of steps. */
const MAX_DT = 0.1;

function fatal(root: HTMLElement, title: string, detail: string): void {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = '<div><h1></h1><p></p></div>';
  box.querySelector('h1')!.textContent = title;
  box.querySelector('p')!.textContent = detail;
  root.append(box);
}

function safeStorage(): KeyValueStore {
  try {
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    };
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;

  const saves = new SaveStore(safeStorage());
  const net = new RoadNetwork();
  const saved = saves.loadAutosave();
  let restored: SaveRecord | null = null;
  if (saved) {
    try {
      net.load(saved.project);
      restored = saved;
    } catch (err) {
      console.warn('Autosave could not be read, starting fresh.', err);
    }
  }
  if (!restored) buildStarterScene(net);

  const viewport = document.createElement('div');
  viewport.id = 'viewport';
  root.append(viewport);

  const sim = new Simulation(net);
  let renderer: Renderer;
  try {
    renderer = new Renderer(viewport, net, sim);
  } catch (err) {
    viewport.remove();
    if (err instanceof WebGLUnavailableError) {
      fatal(root, 'WebGL2 is required', `${err.message} Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration on.`);
      return;
    }
    throw err;
  }

  const resize = (): void => renderer.resize(window.innerWidth, window.innerHeight);
  resize();
  window.addEventListener('resize', resize);
  renderer.setCamera(restored?.camera ?? STARTER_CAMERA);

  const warmUp = (): void => {
    for (let i = 0; i < STARTER_WARM_STEPS; i++) sim.step();
  };
  if (!restored) warmUp();

  const history = new History(net);
  const tools = new ToolManager({ net, sim, view: renderer, history, templates });

  let rail: RailApp | null = null;
  // Replacing the map is one undo step, so a map replaced by mistake comes back.
  const load = (fn: () => void, label = 'Replace map'): void => {
    history.replaceUndoable(label, fn);
    sim.reset();
    rail?.reset();
  };
  const ui = new UI({
    root,
    net,
    sim,
    renderer,
    tools,
    history,
    saves,
    templates,
    actions: {
      newProject(name, starter) {
        load(() => {
          net.clear(name);
          if (starter) buildStarterScene(net);
        }, 'New map');
        if (starter) warmUp();
        renderer.setCamera(starter ? STARTER_CAMERA : { target: { x: 0, y: 0, z: 0 } }, true);
      },
      loadRecord(record) {
        try {
          load(() => net.load(record.project, 'replace'), 'Load map');
          if (record.camera) renderer.setCamera(record.camera);
          ui.context.toast(`Loaded ${net.project.name}. Undo brings back the previous map.`);
        } catch (err) {
          ui.context.toast(`Could not load: ${(err as Error).message}`, 'error');
        }
      },
      importJson(text) {
        try {
          load(() => net.load(text, 'replace'), 'Import map');
          ui.context.toast(`Imported ${net.project.name}. Undo brings back the previous map.`);
        } catch (err) {
          const reason = err instanceof ProjectFormatError || err instanceof SyntaxError ? err.message : 'the file is not a Cloverleaf project';
          ui.context.toast(`Could not import: ${reason}`, 'error');
        }
      },
      exportJson() {
        const url = URL.createObjectURL(new Blob([net.serialize()], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${net.project.name.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'cloverleaf'}.json`;
        a.click();
        URL.revokeObjectURL(url);
      },
    },
  });

  rail = installRail({ net, sim, renderer, tools, history, ui, warmRoads: warmUp });
  // Trains go out on the line before the first frame, on a restored map too.
  rail.warm();

  const autosave = debounce(() => saves.autosave(net, renderer.getCamera()), AUTOSAVE_MS);
  net.onChange(autosave);
  window.addEventListener('beforeunload', () => autosave.flush());

  window.__cloverleaf = { net, sim, renderer, tools, history, ui, trains: rail.trains, rail: rail.layer };

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    sim.advance(dt);
    rail?.advance(dt);
    renderer.frame(dt);
    ui.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  fatal(document.getElementById('app')!, 'Cloverleaf could not start', err instanceof Error ? err.message : String(err));
});
