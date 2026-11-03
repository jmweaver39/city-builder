/**
 * The bottom bar's eight broad tools. Each tool has modes, and every mode is one
 * of the editor's tool implementations (ToolId) with optional settings, so no
 * tool is lost: they are grouped, not removed. Pure, so it runs headless.
 *
 *   Build      draw roads and track: straight, curved, freeform, parallel
 *   Modify     select, move, and sweep changes: upgrade, reverse, electrify, align
 *   Junction   control, roundabout, lanes, shape, markings
 *   Paint      road paint: lines, areas, arrows, text
 *   Zones      zoning and traffic gateways
 *   Terrain    landscaping and quays
 *   Transit    stations, lines and trains
 *   Bulldoze   removes whatever is under the cursor
 */
import type { RoadCategory } from '../core/types';
import type { DrawMode, ToolId } from '../tools/types';

export type GroupId = 'build' | 'modify' | 'junction' | 'paint' | 'zones' | 'terrain' | 'transit' | 'bulldoze';

export interface ToolMode {
  id: string;
  label: string;
  /** Icon name from icons.ts. */
  icon: string;
  tool: ToolId;
  /** For the road tool: which draw mode. */
  drawMode?: DrawMode;
  desc: string;
  /** Keymap binding that picks this mode, if any. */
  binding?: string;
}

export interface ToolGroup {
  id: GroupId;
  label: string;
  icon: string;
  desc: string;
  /** Keymap binding that opens it. */
  binding: string;
  modes: ToolMode[];
}

export const GROUPS: readonly ToolGroup[] = [
  {
    id: 'build',
    label: 'Build',
    icon: 'toolBuild',
    desc: 'Draw roads and track',
    binding: 'tool.road',
    modes: [
      { id: 'straight', label: 'Straight', icon: 'straight', tool: 'road', drawMode: 'straight', desc: 'Click a start and an end', binding: 'draw.straight' },
      { id: 'curved', label: 'Curved', icon: 'curved', tool: 'road', drawMode: 'curved', desc: 'Start, a control point, then the end', binding: 'draw.curved' },
      { id: 'freeform', label: 'Freeform', icon: 'freeform', tool: 'road', drawMode: 'freeform', desc: 'Carries on from the last road', binding: 'draw.freeform' },
      { id: 'parallel', label: 'Parallel', icon: 'parallel', tool: 'parallel', desc: 'Draw alongside an existing road', binding: 'tool.parallel' },
    ],
  },
  {
    id: 'modify',
    label: 'Modify',
    icon: 'toolModify',
    desc: 'Select, move and change what is built',
    binding: 'tool.select',
    modes: [
      { id: 'select', label: 'Select', icon: 'select', tool: 'select', desc: 'Click anything to inspect it', binding: 'tool.select' },
      { id: 'move', label: 'Move', icon: 'move', tool: 'move', desc: 'Drag nodes and curve handles', binding: 'tool.move' },
      { id: 'upgrade', label: 'Upgrade', icon: 'upgrade', tool: 'road', drawMode: 'upgrade', desc: 'Sweep over roads to change their type, structure or barriers', binding: 'draw.upgrade' },
      { id: 'reverse', label: 'Reverse', icon: 'reverse', tool: 'reverse', desc: 'Sweep over one-way roads to turn them round', binding: 'tool.reverse' },
      { id: 'electrify', label: 'Electrify', icon: 'electrify', tool: 'electrify', desc: 'Sweep over track to add or remove overhead wires', binding: 'tool.electrify' },
      { id: 'align', label: 'Align', icon: 'grid', tool: 'gridAlign', desc: 'Line the drawing grid up with a road', binding: 'tool.gridAlign' },
    ],
  },
  {
    id: 'junction',
    label: 'Junction',
    icon: 'toolJunction',
    desc: 'Control, roundabouts, lanes, shape and markings',
    binding: 'tool.junction',
    modes: [
      { id: 'control', label: 'Control', icon: 'signalLight', tool: 'junction', desc: 'Lights, signs and priority with one click', binding: 'tool.junction' },
      { id: 'roundabout', label: 'Roundabout', icon: 'roundabout', tool: 'roundabout', desc: 'Build, resize or remove a roundabout', binding: 'tool.roundabout' },
      { id: 'lanes', label: 'Lanes', icon: 'lanes', tool: 'lanes', desc: 'Link lanes through a junction by hand', binding: 'tool.lanes' },
      { id: 'shape', label: 'Shape', icon: 'junctionShape', tool: 'junctionShape', desc: 'Drag kerbs, sidewalks, cut lines and islands', binding: 'tool.junctionShape' },
      { id: 'markings', label: 'Markings', icon: 'intersections', tool: 'nodeMarkings', desc: 'Paint lines and fillers inside a junction', binding: 'tool.nodeMarkings' },
    ],
  },
  {
    id: 'paint',
    label: 'Paint',
    icon: 'toolPaint',
    desc: 'Lines, areas, arrows and text on the road',
    binding: 'tool.paint',
    modes: [{ id: 'paint', label: 'Paint', icon: 'paint', tool: 'paint', desc: 'Pick a marking, then click on the road', binding: 'tool.paint' }],
  },
  {
    id: 'zones',
    label: 'Zones',
    icon: 'toolZones',
    desc: 'Zoning and traffic gateways',
    binding: 'tool.traffic',
    modes: [
      { id: 'zone', label: 'Zone', icon: 'home', tool: 'zone', desc: 'Fill a block, drag along roads, or draw a shape' },
      { id: 'gateway', label: 'Gateway', icon: 'gateway', tool: 'traffic', desc: 'Where traffic enters and leaves the map', binding: 'tool.traffic' },
    ],
  },
  {
    id: 'terrain',
    label: 'Terrain',
    icon: 'toolTerrain',
    desc: 'Landscaping and quays',
    binding: 'tool.terrain',
    modes: [
      // Landscaping first, so opening Terrain picks the brushes (TerrainControls.ts).
      { id: 'landscape', label: 'Landscape', icon: 'quay', tool: 'terrain', desc: 'Shift, level, soften and slope the ground', binding: 'tool.terrain' },
      { id: 'quay', label: 'Quay', icon: 'quay', tool: 'quay', desc: 'A wall along the water' },
    ],
  },
  {
    id: 'transit',
    label: 'Transit',
    icon: 'toolTransit',
    desc: 'Stations, lines and trains',
    binding: 'group.transit',
    modes: [
      { id: 'station', label: 'Station', icon: 'station', tool: 'station', desc: 'Place a station on track' },
      { id: 'line', label: 'Line', icon: 'trainLine', tool: 'line', desc: 'Click stations in order to make a line' },
    ],
  },
  {
    id: 'bulldoze',
    label: 'Bulldoze',
    icon: 'bulldoze',
    desc: 'Remove whatever is under the cursor',
    binding: 'tool.bulldoze',
    modes: [{ id: 'bulldoze', label: 'Bulldoze', icon: 'bulldoze', tool: 'bulldoze', desc: 'Click or drag', binding: 'tool.bulldoze' }],
  },
];

export function group(id: GroupId): ToolGroup {
  return GROUPS.find((g) => g.id === id)!;
}

/** The tool a tool implementation belongs to now. The road tool depends on its draw mode. */
export function groupOf(tool: string, drawMode: DrawMode): GroupId | null {
  if (tool === 'road') return drawMode === 'upgrade' ? 'modify' : 'build';
  if (tool === 'template') return 'build';
  for (const g of GROUPS) if (g.modes.some((m) => m.tool === tool)) return g.id;
  return null;
}

/** The mode the editor is in, within its tool. */
export function modeOf(tool: string, drawMode: DrawMode): ToolMode | null {
  for (const g of GROUPS) {
    const m = g.modes.find((x) => x.tool === tool && (x.drawMode === undefined || x.drawMode === drawMode));
    if (m) return m;
  }
  return null;
}

/** Road-type filter chips in Build and Upgrade. */
export const ROAD_CHIPS: readonly { id: RoadCategory; label: string }[] = [
  { id: 'street', label: 'Streets' },
  { id: 'avenue', label: 'Avenues' },
  { id: 'oneway', label: 'One-ways' },
  { id: 'highway', label: 'Highways' },
  { id: 'ramp', label: 'Ramps' },
  { id: 'rail', label: 'Rail' },
  { id: 'custom', label: 'Custom' },
];

/** Where an old tab id opens now. */
export function legacyTab(id: string): { group: GroupId; chip?: RoadCategory } | null {
  if (ROAD_CHIPS.some((c) => c.id === id && c.id !== 'rail')) return { group: 'build', chip: id as RoadCategory };
  switch (id) {
    case 'control':
      return { group: 'junction' };
    case 'paint':
      return { group: 'paint' };
    case 'traffic':
      return { group: 'zones' };
    case 'rail':
      return { group: 'transit' };
    case 'landscape':
      return { group: 'terrain' };
    default:
      return GROUPS.some((g) => g.id === id) ? { group: id as GroupId } : null;
  }
}

/** Old control, then where it lives now. Kept here so the report, help and tests agree. */
export const MIGRATION: readonly [string, string][] = [
  ['Streets, Avenues, One-ways, Highways, Ramps, Custom tabs', 'Build: road-type chips'],
  ['Trains tab: track cards', 'Build: Rail chip'],
  ['Trains tab: stations, lines, trains', 'Transit'],
  ['Draw modes Straight, Curved, Freeform', 'Build modes (Z X C)'],
  ['Parallel road button', 'Build: Parallel mode (I)'],
  ['Upgrade draw mode', 'Modify: Upgrade mode (Y); structure and barriers in its options'],
  ['Reverse button and tool', 'Modify: Reverse mode (H), whole-road option'],
  ['Electrify tool', 'Modify: Electrify mode; O over track still works'],
  ['Move tool', 'Modify: Move mode (M)'],
  ['Inspect tool', 'Modify: Select mode (V)'],
  ['Grid align tool', 'Modify: Align mode'],
  ['Snapping, guides, elevation', 'Build options; guides under Advanced'],
  ['Structure and walls', 'Build options, Advanced; Upgrade options'],
  ['Traffic Control tab', 'Junction: Control mode (J), cards 1 to 6'],
  ['Roundabout card', 'Junction: Roundabout mode (O)'],
  ['Lane connector', 'Junction: Lanes mode (L)'],
  ['Node markings card (Paint tab)', 'Junction: Markings mode (K)'],
  ['Junction shape card (Paint tab)', 'Junction: Shape mode (Shift+K)'],
  ['Paint tab', 'Paint (P)'],
  ['Traffic tab: gateways and zones', 'Zones (T)'],
  ['Landscaping tab', 'Terrain'],
  ['Bulldoze button', 'Bulldoze (B)'],
  ['Interchange templates (hidden)', 'Command palette'],
];
