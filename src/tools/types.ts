/**
 * Shared shapes of the editor tools. Tools see the world only through a
 * ToolContext, so all of their logic runs headless under Vitest with a fake view.
 */
import type { Cubic } from '../core/bezier';
import type { CrosswalkStyle, DecalKind, EndpointKind, Id, LineStyle, LineStyleSpec, NodeFillStyle, NodeFillerMarking, NodeLineStyle, PaintColor, Vec3, ZoneDensity, ZoneKind } from '../core/types';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { RendererApi, RendererExtras, ToolMark } from '../render/api';
import { defaultGrid, type GridSettings } from './grid';
import { defaultGuideToggles, type GuideToggles } from './guides';
import { defaultParallelSettings, type ParallelSettings } from './parallel';
import type { ControlKind } from './junctionControl';
import { DEFAULT_ROUNDABOUT, type RoundaboutParams } from '../core/roundabout';
import type { SimApi } from '../sim/api';
import { defaultWallSettings, type WallToolSettings } from './wallOps';
import { defaultUpgradeCardSettings, type UpgradeCardSettings } from './upgradeSettings';
import { defaultTrafficRuleSettings, type TrafficRuleSettings } from './trafficRuleSettings';
import type { RoadClip } from './clipFormat';

export type ToolId =
  | 'select'
  | 'road'
  | 'bulldoze'
  | 'move'
  | 'junction'
  | 'lanes'
  | 'paint'
  | 'traffic'
  | 'template'
  | 'nodeMarkings'
  | 'junctionShape'
  | 'reverse'
  | 'parallel'
  | 'gridAlign'
  | 'zone'
  | 'roundabout'
  | 'station'
  | 'line'
  | 'electrify'
  | 'quay'
  | 'terrain'
  | 'trafficRules';

export type DrawMode = 'straight' | 'curved' | 'freeform' | 'upgrade';

/** The part of the renderer tools use. */
export type ToolView = Pick<
  RendererApi,
  | 'pickPlane'
  | 'pickRay'
  | 'getUnderground'
  | 'pickVehicle'
  | 'project'
  | 'setPreview'
  | 'setMarks'
  | 'setHighlight'
  | 'setLaneDebug'
  | 'setZoneOverlay'
  | 'setZoneGhost'
> &
  Partial<Pick<RendererExtras, 'setGrid'>>;

/** A pointer event with the DOM stripped away. Ctrl means Ctrl or Cmd. */
export interface ToolPointer {
  x: number;
  y: number;
  /** 0 left, 1 middle, 2 right. */
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface ToolKey {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type InspectTarget =
  | { kind: 'segment'; id: Id }
  /** Any node. The panel shows the signal editor when the node is a junction. */
  | { kind: 'junction'; id: Id }
  | { kind: 'endpoint'; id: Id }
  | { kind: 'vehicle'; id: number }
  | { kind: 'nodeMarkings'; id: Id }
  /** Hand-placed markings along one segment, between its ends. */
  | { kind: 'segmentMarkings'; id: Id }
  | { kind: 'zone'; id: Id }
  | { kind: 'train'; id: number }
  | { kind: 'station'; id: Id }
  | { kind: 'junctionShape'; id: Id };

export type Tone = 'ok' | 'warning' | 'error';

/** The floating readout beside the cursor. */
export interface CursorHud {
  x: number;
  y: number;
  lines: string[];
  /** Reason text, shown under the readout. */
  notes: string[];
  tone: Tone;
}

export type ToastKind = 'info' | 'warning' | 'error';

export interface PaintSettings {
  kind: DecalKind;
  lineStyle: LineStyle;
  color: PaintColor;
  width: number;
  text: string;
  /**
   * The look of lines, crosswalks, stop lines and teeth, in the shared marking
   * vocabulary (core/paintStandard.ts). Starts as a named standard; colour and width
   * above are written into it when placed. Absent: the standard for `kind`.
   */
  look?: LineStyleSpec;
  /** Which named standard `look` started as, for the panel. */
  standard?: string;
}

export interface ZoneToolSettings {
  kind: ZoneKind | 'none';
  mode: 'block' | 'frontage' | 'rect' | 'polygon';
  density: ZoneDensity;
  depth: number;
  setback: number;
  snap: boolean;
  snapDistance: number;
  /** Highways, ramps and rail neither front a zone nor give it access. */
  excludeFast: boolean;
}

/** The junction marking editor's draw tools. 'line' is armed by default; 'select' only picks. */
export type MarkingDraw = 'select' | 'line' | 'crosswalk' | 'stop' | 'filler' | 'stamp' | 'erase';

export interface NodeMarkingSettings {
  /** Kept in step with `draw`: 'filler' when drawing an area, 'line' otherwise. */
  mode: 'line' | 'filler';
  draw: MarkingDraw;
  /** Look of new lines beyond style, colour and width: dashes, gap, offset, side, own colour. */
  lineExtra: Omit<Partial<LineStyleSpec>, 'style' | 'color' | 'width'>;
  /** Look of crosswalks and of stop lines or teeth laid with their draw tools. */
  crosswalk: LineStyleSpec;
  stop: LineStyleSpec;
  /** Look of new areas beyond fill, colour and stripe width. */
  fillExtra: Pick<NodeFillerMarking, 'hex' | 'angle' | 'step' | 'offset' | 'noOutline'>;
  style: NodeLineStyle;
  fill: NodeFillStyle;
  color: PaintColor;
  width: number;
  /** Stripe thickness of a filler. */
  fillWidth: number;
  /** Lines between arms curve with the lanes. Off draws them straight. */
  curved: boolean;
  /** Lines between arms follow the lane paths through the junction. */
  followLanes: boolean;
}

export interface TemplateSettings {
  id: string | null;
  /** Per template id. */
  params: Record<string, Record<string, number>>;
  rotation: number;
  elevation: number;
  roadType: string | null;
}

export interface EditorSettings {
  roadType: string;
  drawMode: DrawMode;
  snapNodes: boolean;
  snapSegments: boolean;
  snapAngle: boolean;
  snapLength: boolean;
  /** Target height of the next road end. Steps by ELEVATION_STEP. */
  elevation: number;
  /** The Reverse tool turns all of a connected road, not just one piece. */
  reverseWholeRoad: boolean;
  paint: PaintSettings;
  nodeMarking: NodeMarkingSettings;
  zone: ZoneToolSettings;
  trafficKind: EndpointKind;
  template: TemplateSettings;
  /** Optional drawing grid. Off by default, so roads stay free. */
  grid: GridSettings;
  /** Smart guide types the road tool snaps to (guides.ts). */
  guides: GuideToggles;
  /** Parallel Road tool options. */
  parallel: ParallelSettings;
  /** The Traffic Control card a click applies. 'inspect' opens the detailed editor instead. */
  junctionControl: ControlKind | 'inspect';
  roundabout: RoundaboutParams;
  /** Structure, walls, sound barriers and quays (wallOps.ts). */
  walls: WallToolSettings;
  /** Modify > Upgrade cards: lights, barriers, trees and so on (UpgradeCardTool.ts). */
  upgradeCards: UpgradeCardSettings;
  /** Ramps meeting a highway lane: edge merge or full junction, lane add or drop. */
  rampJoin: RampJoinSettings;
  /** Junction > Rules: lane arrows, speed limits, vehicle bans and more (TrafficRulesTool.ts). */
  trafficRules: TrafficRuleSettings;
  /**
   * The last road copied with a middle click (clipboard.ts). New roads drawn in its
   * type get its settings, and Upgrade's Paste style sweeps it over roads. Absent: none.
   */
  roadStyle?: RoadClip | null;
}

export function defaultSettings(): EditorSettings {
  return {
    roadType: 'street-2',
    drawMode: 'straight',
    snapNodes: true,
    snapSegments: true,
    snapAngle: true,
    snapLength: true,
    elevation: 0,
    reverseWholeRoad: false,
    paint: { kind: 'line', lineStyle: 'dashed', color: 'white', width: 0.14, text: 'SLOW', look: { style: 'dashed', color: 'white', width: 0.14 }, standard: 'lane' },
    zone: { kind: 'residential', mode: 'block', density: 'medium', depth: 40, setback: 2, snap: true, snapDistance: 8, excludeFast: true },
    nodeMarking: {
      mode: 'line',
      draw: 'line',
      // New markings start as the marking standard (core/paintStandard.ts): a lane line, a zebra, a stop line.
      style: 'dashed',
      fill: 'hatch',
      color: 'white',
      width: 0.14,
      fillWidth: 0.3,
      curved: true,
      followLanes: false,
      lineExtra: {},
      crosswalk: { style: 'crosswalkZebra', color: 'white', width: 3, dash: 0.6, space: 0.6 },
      stop: { style: 'stopLine', color: 'white', width: 0.45 },
      fillExtra: {},
    },
    trafficKind: 'gateway',
    template: { id: null, params: {}, rotation: 0, elevation: 0, roadType: null },
    grid: defaultGrid(),
    guides: defaultGuideToggles(),
    parallel: defaultParallelSettings(),
    junctionControl: 'inspect',
    roundabout: { ...DEFAULT_ROUNDABOUT },
    walls: defaultWallSettings(),
    upgradeCards: defaultUpgradeCardSettings(),
    trafficRules: defaultTrafficRuleSettings(),
    rampJoin: defaultRampJoinSettings(),
  };
}

/** How the road tool joins a ramp to a highway lane (core/edgeMerge.ts). */
export interface RampJoinSettings {
  /** Blend into the edge lane (true) or make a full junction (false). Alt swaps it while held. */
  edge: boolean;
  /** An on-ramp: a taper, an added lane for `addLength` metres, or an added lane for good. */
  onRamp: 'taper' | 'add' | 'addFull';
  addLength: number;
  /** An off-ramp: a taper, or the edge lane exit only (the highway loses it). */
  offRamp: 'taper' | 'drop';
}

export function defaultRampJoinSettings(): RampJoinSettings {
  return { edge: true, onRamp: 'taper', addLength: 300, offRamp: 'taper' };
}

/** Undo history as tools see it. Edits are captured automatically. */
export interface EditRecorder {
  /** Group every edit until end() into one undo step, as in a drag. */
  begin(label: string): void;
  end(): void;
  /** Throw away everything since begin(), restoring the network. */
  abort(): void;
  /** Name the next edit. Same key soon after a previous step merges into it. */
  hint(label: string, coalesceKey?: string): void;
}

export interface TemplateParamDef {
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
  category?: string;
  params: TemplateParamDef[];
}

export interface TemplatePlacement {
  pos: Vec3;
  rotation: number;
  elevation: number;
  roadType?: string;
}

/** What `src/templates/index.ts` exports. */
export interface TemplateApi {
  TEMPLATES: TemplateDef[];
  /** With nothing in `segments`, `problems` says why it could not be placed. */
  stampTemplate(
    net: RoadNetwork,
    id: string,
    params: Record<string, number>,
    placement: TemplatePlacement,
  ): { segments: Id[]; problems: string[] };
  previewTemplate(id: string, params: Record<string, number>, placement: TemplatePlacement): Cubic[];
  /** Why it cannot go here. Empty when it can. */
  placementProblems?(id: string, params: Record<string, number>, placement: TemplatePlacement): string[];
}

export interface ToolContext {
  readonly net: RoadNetwork;
  readonly sim: SimApi | null;
  readonly view: ToolView;
  readonly history: EditRecorder;
  readonly settings: EditorSettings;
  readonly templates: TemplateApi | null;
  /** Replace this tool's marks. */
  setMarks(marks: ToolMark[]): void;
  setHud(hud: CursorHud | null): void;
  toast(message: string, kind?: ToastKind): void;
  inspect(target: InspectTarget | null): void;
  /** A tool's state or a setting changed, so panels should refresh. */
  changed(): void;
}

/** Crosswalk values in display order, used by more than one panel. */
export const CROSSWALK_STYLES: readonly CrosswalkStyle[] = ['none', 'zebra', 'ladder', 'lines'];

export const COLORS = {
  snap: '#4fd1ff',
  guide: '#8fe3ff',
  ok: '#58e6a9',
  warn: '#ffc857',
  bad: '#ff5d5d',
  neutral: '#ffffff',
} as const;
