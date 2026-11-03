/** The template list the UI shows, and how to build each entry. */
import { Blueprint, type Placement } from './blueprint';
import type { BuildContext, Params } from './kit';
import * as interchanges from './interchanges';
import * as simple from './simple';
import * as system from './system';

export type TemplateCategory = 'roundabout' | 'interchange' | 'intersection';

export interface TemplateParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  params: TemplateParam[];
}

interface Entry extends TemplateDef {
  build(bp: Blueprint, ctx: BuildContext): void;
}

const param = (key: string, label: string, min: number, max: number, step: number, def: number): TemplateParam => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
});

const armLength = param('armLength', 'Arm length (m)', 80, 300, 10, 150);
const mainLanes = param('mainLanes', 'Mainline lanes', 2, 4, 1, 3);
const rampLanes = param('rampLanes', 'Ramp lanes', 1, 2, 1, 1);
/** Ramps ending at a signal need the storage and the second turn lane. */
const terminalRampLanes = param('rampLanes', 'Ramp lanes', 1, 2, 1, 2);
const crossLanes = (def: number) => param('crossLanes', 'Cross road lanes', 2, 6, 2, def);

const ENTRIES: Entry[] = [
  {
    id: 'roundabout-small',
    name: 'Roundabout, small',
    description: 'Single-lane roundabout for streets. Traffic on the ring has priority.',
    category: 'roundabout',
    params: [param('radius', 'Ring radius (m)', 18, 40, 1, 24), armLength],
    build: simple.roundaboutSmall,
  },
  {
    id: 'roundabout-large',
    name: 'Roundabout, large two-lane',
    description: 'Two-lane ring for avenues, with the right lane leaving and the left lane carrying on.',
    category: 'roundabout',
    params: [param('radius', 'Ring radius (m)', 34, 70, 1, 42), armLength],
    build: simple.roundaboutLarge,
  },
  {
    id: 'roundabout-turbo',
    name: 'Turbo roundabout',
    description: 'Two-lane ring where lanes are chosen before entry and spiral out, so nobody weaves on the ring.',
    category: 'roundabout',
    params: [param('radius', 'Ring radius (m)', 34, 70, 1, 42), armLength],
    build: simple.roundaboutTurbo,
  },
  {
    id: 'signal-crossing',
    name: 'Signalised avenue crossing',
    description: 'Two avenues at a four-phase signal, with a dedicated left lane and protected left phases.',
    category: 'intersection',
    params: [param('lanesPerDirection', 'Lanes per direction', 2, 4, 1, 3), param('armLength', 'Arm length (m)', 100, 400, 10, 200)],
    build: simple.signalisedCrossing,
  },
  {
    id: 'on-off-ramps',
    name: 'Highway on-ramp and off-ramp',
    description: 'An exit then an entry on one carriageway, with stubs for local roads.',
    category: 'interchange',
    params: [
      mainLanes,
      rampLanes,
      param('spacing', 'Gore spacing (m)', 300, 800, 10, 400),
      param('rampRadius', 'Ramp radius (m)', 60, 200, 10, 100),
      param('rampLength', 'Ramp stub length (m)', 80, 300, 10, 120),
    ],
    build: simple.onOffRamps,
  },
  {
    id: 'lane-add-drop',
    name: 'Highway lane add and drop',
    description: 'A carriageway widens by one lane, then narrows back.',
    category: 'interchange',
    params: [mainLanes, param('addedLength', 'Added lane length (m)', 200, 1000, 20, 400), param('stubLength', 'Stub length (m)', 150, 400, 10, 250)],
    build: simple.laneAddDrop,
  },
  {
    id: 'diamond',
    name: 'Diamond interchange',
    description: 'Four ramps meeting a cross road at two signalised terminals. The cross road bridges the highway.',
    category: 'interchange',
    params: [
      mainLanes,
      crossLanes(6),
      terminalRampLanes,
      param('rampLength', 'Ramp length (m)', 300, 600, 10, 360),
      param('terminalSpacing', 'Terminal spacing (m)', 120, 320, 10, 240),
    ],
    build: interchanges.diamond,
  },
  {
    id: 'spui',
    name: 'Single-point urban interchange',
    description: 'All four ramps meet the cross road at one three-phase signal on the bridge over the highway.',
    category: 'interchange',
    params: [mainLanes, crossLanes(6), terminalRampLanes, param('rampLength', 'Ramp length (m)', 320, 600, 10, 380)],
    build: interchanges.spui,
  },
  {
    id: 'parclo',
    name: 'Partial cloverleaf',
    description: 'An exit ramp and an entrance loop on each side of the highway, so nobody turns left across the cross road.',
    category: 'interchange',
    params: [
      mainLanes,
      crossLanes(4),
      terminalRampLanes,
      param('loopRadius', 'Loop radius (m)', 50, 90, 5, 65),
      param('rampLength', 'Ramp length (m)', 420, 700, 10, 500),
    ],
    build: interchanges.parclo,
  },
  {
    id: 'cloverleaf',
    name: 'Full cloverleaf',
    description: 'Four loops and four right-turn ramps. The collector option moves the weaving off the mainline.',
    category: 'interchange',
    params: [
      mainLanes,
      param('crossLanes', 'Cross highway lanes', 2, 4, 1, 2),
      rampLanes,
      param('loopRadius', 'Loop radius (m)', 50, 90, 5, 65),
      param('rampRadius', 'Outer ramp radius (m)', 120, 240, 10, 160),
      param('collector', 'Collector-distributor roads', 0, 1, 1, 0),
    ],
    build: interchanges.cloverleaf,
  },
  {
    id: 'diverging-diamond',
    name: 'Diverging diamond',
    description: 'The cross road swaps sides between two signalised crossovers, so left turns flow with no opposing traffic.',
    category: 'interchange',
    params: [mainLanes, param('rampLength', 'Ramp length (m)', 420, 700, 10, 480), param('crossoverSpacing', 'Bridge half-length (m)', 110, 200, 10, 130)],
    build: interchanges.divergingDiamond,
  },
  {
    id: 'trumpet',
    name: 'Trumpet',
    description: 'A spur joins a through highway with one loop and one flyover. All movements flow freely.',
    category: 'interchange',
    params: [
      mainLanes,
      param('stemLanes', 'Spur lanes', 2, 3, 1, 2),
      rampLanes,
      param('loopRadius', 'Loop radius (m)', 50, 90, 5, 65),
      param('flyoverRadius', 'Flyover radius (m)', 350, 460, 10, 380),
    ],
    build: system.trumpet,
  },
  {
    id: 'stack-3',
    name: 'Three-level stack',
    description: 'One pair of left turns on flyovers over the two highways, the other pair on loops underneath.',
    category: 'interchange',
    params: [
      mainLanes,
      param('crossLanes', 'Cross highway lanes', 2, 4, 1, 3),
      rampLanes,
      param('rampRadius', 'Flyover radius (m)', 280, 360, 10, 300),
      param('loopRadius', 'Loop radius (m)', 50, 90, 5, 65),
    ],
    build: system.stackThreeLevel,
  },
  {
    id: 'stack-4',
    name: 'Four-level stack',
    description: 'Two highways and two levels of left-turn flyovers, with no loops and no weaving.',
    category: 'interchange',
    params: [
      mainLanes,
      param('crossLanes', 'Cross highway lanes', 2, 4, 1, 3),
      rampLanes,
      param('rampRadius', 'Flyover radius (m)', 260, 360, 10, 300),
    ],
    build: system.stackFourLevel,
  },
  {
    id: 'turbine',
    name: 'Turbine',
    description: 'Left turns sweep round the centre on a single middle level, over one highway and under the other.',
    category: 'interchange',
    params: [
      mainLanes,
      param('crossLanes', 'Cross highway lanes', 2, 4, 1, 3),
      rampLanes,
      param('rampRadius', 'Blade radius (m)', 150, 220, 10, 170),
      param('reach', 'Blade reach (m)', 620, 780, 10, 660),
    ],
    build: system.turbine,
  },
];

export const TEMPLATES: TemplateDef[] = ENTRIES.map(({ build: _build, ...def }) => def);

/** Every param with a value in range, on its step. */
export function resolveParams(def: TemplateDef, given: Partial<Params> | undefined): Params {
  const out: Params = {};
  for (const p of def.params) {
    const raw = given?.[p.key];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.default;
    const stepped = p.min + Math.round((Math.min(p.max, Math.max(p.min, v)) - p.min) / p.step) * p.step;
    out[p.key] = Math.min(p.max, stepped);
  }
  return out;
}

export function findEntry(id: string): Entry | undefined {
  return ENTRIES.find((e) => e.id === id);
}

/** Build a template's finished blueprint. Throws for an unknown id. */
export function buildBlueprint(id: string, params: Partial<Params> | undefined, placement: Pick<Placement, 'roadType'>): Blueprint {
  const entry = findEntry(id);
  if (!entry) throw new Error(`Unknown template "${id}"`);
  const bp = new Blueprint();
  entry.build(bp, { p: resolveParams(entry, params), roadType: placement.roadType });
  return bp.finish();
}
