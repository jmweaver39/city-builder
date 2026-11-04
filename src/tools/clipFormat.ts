/**
 * What the middle-click copy holds, and its JSON form for the system clipboard.
 *
 * A clip describes a look, never a place: a road's type and settings, a marking's
 * style, or a junction's control and shape with its arms counted clockwise rather
 * than named by segment id, so it can be pasted anywhere, in this map or another.
 *
 * Text from the system clipboard is untrusted: parseClip accepts only the exact
 * shape written by serializeClip, every field checked for type and range, and
 * unknown keys refused. Pure: no DOM, runs headless.
 */
import { roadTypeProblems } from '../core/roadTypes';
import type { ArmRules, VehicleClass } from '../core/trafficRuleTypes';
import type {
  CrosswalkStyle,
  DecalKind,
  Electrification,
  JunctionMode,
  LaneDef,
  LaneKind,
  LineStyle,
  LineStyleSpec,
  MarkingStyle,
  NodeFillStyle,
  NodeLineStyle,
  PaintColor,
  RoadCategory,
  RoadTypeDef,
  SegmentOverrides,
  ShapeArm,
  ShapeCorner,
  SignalPhase,
  SignalPlan,
  SignKind,
  TurnKind,
} from '../core/types';
import type { FillStyleSpec } from '../core/markingStyle';
import type { BarrierSide, BarrierSpec, StructureSpec, WallSide } from '../core/wallTypes';
import type { MedianUpgrades, RoadUpgrades, SideUpgrades } from '../core/upgradeTypes';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The settings of a road a copy carries: everything but its place, name and hand markings. */
export type RoadStyle = Pick<
  SegmentOverrides,
  'speedKmh' | 'laneKinds' | 'laneSpeeds' | 'laneBans' | 'surface' | 'structure' | 'barriers' | 'upgrades' | 'markings' | 'paintOff' | 'electrification'
>;

export const ROAD_STYLE_KEYS: readonly (keyof RoadStyle)[] = [
  'speedKmh',
  'laneKinds',
  'laneSpeeds',
  'laneBans',
  'surface',
  'structure',
  'barriers',
  'upgrades',
  'markings',
  'paintOff',
  'electrification',
];

export interface RoadClip {
  kind: 'road';
  /** Shown in the toast and the chip. */
  name: string;
  roadType: string;
  /** A custom road type travels with the copy, so it can be pasted into another map. */
  typeDef?: RoadTypeDef;
  style: RoadStyle;
}

/** A line part between the line's own ends. Parts bounded by crossings stay with their line. */
export interface LinePart {
  from: 0 | 1;
  to: 0 | 1;
  style: LineStyleSpec;
}

export type MarkingLook =
  | { shape: 'line'; spec: LineStyleSpec; parts?: LinePart[] }
  | { shape: 'fill'; fill: FillStyleSpec }
  | { shape: 'stamp'; stamp: DecalKind; color: PaintColor; width: number; text?: string };

export interface MarkingClip {
  kind: 'marking';
  name: string;
  look: MarkingLook;
}

/** An island, its arm by position. */
export interface ClipIsland {
  arm: number;
  from: number;
  to: number;
  back: number;
  reach: number;
}

/**
 * A junction's control and shape. Arms are numbered clockwise from the first road
 * arm (rail arms left out); keys are 'i' for an arm, 'i>j' for a movement or a
 * corner, 'i:lane' for a lane.
 */
export interface JunctionClip {
  kind: 'junction';
  name: string;
  arms: number;
  /** The turn of each movement, for lining the arms up with another junction's. */
  turns: Record<string, TurnKind>;
  mode: JunctionMode;
  signs: Record<string, SignKind>;
  /** Phase moves keyed 'i>j'. Null with mode 'signal' runs the automatic plan. */
  signal: SignalPlan | null;
  rules?: { arms?: Record<string, ArmRules>; laneArrows?: Record<string, TurnKind[]> };
  shape?: { corners?: Record<string, ShapeCorner>; arms?: Record<string, ShapeArm>; islands?: ClipIsland[]; scale?: number };
}

export type Clip = RoadClip | MarkingClip | JunctionClip;

/** The system clipboard's form. `at` (ms since 1970) says which of two copies is newer. */
export interface ClipEnvelope {
  cloverleaf: 'clipboard';
  version: 1;
  at: number;
  clip: Clip;
}

export function serializeClip(clip: Clip, at = Date.now()): string {
  const env: ClipEnvelope = { cloverleaf: 'clipboard', version: 1, at, clip };
  return JSON.stringify(env);
}

// ---------------------------------------------------------------------------
// Strict checking
// ---------------------------------------------------------------------------

export class ClipFormatError extends Error {}

function fail(where: string, what: string): never {
  throw new ClipFormatError(`${where} ${what}`);
}

/** Longest text accepted, so a huge paste is refused before parsing. */
export const MAX_CLIP_CHARS = 200_000;

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string, allowed: readonly string[], required: readonly string[] = []): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where, 'must be an object');
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, `has an unknown field "${k}"`);
  for (const k of required) if (!(k in o)) fail(where, `is missing "${k}"`);
  return o;
}

function num(v: unknown, where: string, min: number, max: number, int = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(where, 'must be a number');
  if (v < min || v > max) fail(where, `must be between ${min} and ${max}`);
  if (int && !Number.isInteger(v)) fail(where, 'must be a whole number');
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(where, 'must be true or false');
  return v;
}

function str(v: unknown, where: string, max = 120): string {
  if (typeof v !== 'string') fail(where, 'must be text');
  if (v.length > max) fail(where, 'is too long');
  return v;
}

function oneOf<T extends string>(v: unknown, where: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail(where, `must be one of ${values.join(', ')}`);
  return v as T;
}

function arr(v: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(where, 'must be a list');
  if (v.length > max) fail(where, 'is too long');
  return v;
}

/** A record whose keys match `key`, each value checked by `val`. */
function rec<T>(v: unknown, where: string, key: RegExp, val: (x: unknown, w: string) => T, max = 64): Record<string, T> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where, 'must be an object');
  const entries = Object.entries(v as Obj);
  if (entries.length > max) fail(where, 'has too many entries');
  const out: Record<string, T> = {};
  for (const [k, x] of entries) {
    if (!key.test(k)) fail(where, `has a bad key "${k}"`);
    out[k] = val(x, `${where}.${k}`);
  }
  return out;
}

/** Copy only the keys present, checked. */
function opt<T>(o: Obj, key: string, where: string, check: (x: unknown, w: string) => T, out: Record<string, unknown>): void {
  if (o[key] !== undefined) out[key] = check(o[key], `${where}.${key}`);
}

const COLORS: readonly PaintColor[] = ['white', 'yellow', 'blue', 'red', 'green'];
const LINE_STYLES: readonly LineStyle[] = ['none', 'dashed', 'solid', 'double', 'solidDashed', 'dashedSolid', 'dotted'];
const CROSSWALKS: readonly CrosswalkStyle[] = ['none', 'zebra', 'ladder', 'lines'];
const LANE_KINDS: readonly LaneKind[] = ['drive', 'bus', 'bike', 'rail'];
const VEHICLES: readonly VehicleClass[] = ['car', 'van', 'truck', 'bus', 'bike', 'emergency'];
const SURFACES = ['asphalt', 'concrete', 'darkAsphalt', 'red', 'gravel'] as const;
const ELECTRIFICATION: readonly Electrification[] = ['overhead', 'thirdRail', 'none'];
const STRUCTURE_MODES = ['auto', 'embankment', 'retaining', 'trench', 'cut', 'pillars', 'tunnel'] as const;
const WALL_STYLES = ['concrete', 'brick', 'stone', 'gabion', 'precast'] as const;
const WALL_TOPS = ['coping', 'railing', 'fence'] as const;
const BARRIER_KINDS = ['none', 'concrete', 'acrylic', 'timber', 'metal', 'berm'] as const;
const LIGHTS = ['none', 'standard', 'double', 'decorative', 'highmast'] as const;
const TREES = ['trees', 'grass', 'hedge'] as const;
const RAILS = ['wbeam', 'jersey', 'cable'] as const;
const CATEGORIES: readonly RoadCategory[] = ['street', 'avenue', 'oneway', 'highway', 'ramp', 'custom', 'rail', 'roundabout'];
const MEDIANS = ['none', 'paint', 'grass', 'barrier'] as const;
export const NODE_LINE_STYLES: readonly NodeLineStyle[] = [
  'solid', 'dashed', 'double', 'doubleDashed', 'solidDashed', 'dashedSolid', 'dotted', 'zigzag', 'sharkTeeth', 'stopLine', 'stopLineDashed',
  'stopLineDouble', 'stopLineSolidDashed', 'lane', 'crosswalkZebra', 'crosswalkDoubleZebra', 'crosswalkLadder', 'crosswalkLines',
  'crosswalkDashedLines', 'crosswalkSolid', 'crosswalkChessboard', 'empty',
];
const FILL_STYLES: readonly NodeFillStyle[] = ['solid', 'hatch', 'stripes', 'grid', 'chevron', 'triangle'];
const STAMP_KINDS: readonly DecalKind[] = ['arrowStraight', 'arrowLeft', 'arrowRight', 'arrowStraightLeft', 'arrowStraightRight', 'text'];
const JUNCTION_MODES: readonly JunctionMode[] = ['auto', 'priority', 'allStop', 'signal'];
const SIGNS: readonly SignKind[] = ['none', 'yield', 'stop', 'priority'];
const TURNS: readonly TurnKind[] = ['left', 'straight', 'right', 'uturn'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const LANE_KEY = /^(?:[0-9]|[12][0-9]|3[01])$/;
const ARM_KEY = /^(?:[0-9]|1[0-5])$/;
const PAIR_KEY = /^(?:[0-9]|1[0-5])>(?:[0-9]|1[0-5])$/;
const ARM_LANE_KEY = /^(?:[0-9]|1[0-5]):(?:[0-9]|[12][0-9]|3[01])$/;
const PAINT_OFF_KEY = /^(?:L|R|b(?:[0-9]|[12][0-9]|3[01])[LR]?)$/;
const ROAD_TYPE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const hex = (v: unknown, w: string): string => {
  const s = str(v, w, 7);
  if (!HEX.test(s)) fail(w, 'must be a colour like #aabbcc');
  return s;
};
const kmh = (v: unknown, w: string) => num(v, w, 1, 300);

function checkSpec(v: unknown, where: string): LineStyleSpec {
  const keys = ['style', 'color', 'hex', 'width', 'dash', 'space', 'gap', 'offset', 'align', 'border', 'color2', 'hex2'];
  const o = obj(v, where, keys, ['style', 'color', 'width']);
  const out: Record<string, unknown> = {
    style: oneOf(o.style, `${where}.style`, NODE_LINE_STYLES),
    color: oneOf(o.color, `${where}.color`, COLORS),
    width: num(o.width, `${where}.width`, 0.01, 20),
  };
  opt(o, 'hex', where, hex, out);
  opt(o, 'dash', where, (x, w) => num(x, w, 0, 50), out);
  opt(o, 'space', where, (x, w) => num(x, w, 0, 50), out);
  opt(o, 'gap', where, (x, w) => num(x, w, -5, 10), out);
  opt(o, 'offset', where, (x, w) => num(x, w, -20, 20), out);
  opt(o, 'align', where, (x, w) => oneOf(x, w, ['left', 'right'] as const), out);
  opt(o, 'border', where, (x, w) => oneOf(x, w, ['solid', 'dashed'] as const), out);
  opt(o, 'color2', where, (x, w) => oneOf(x, w, COLORS), out);
  opt(o, 'hex2', where, hex, out);
  return out as unknown as LineStyleSpec;
}

function checkFill(v: unknown, where: string): FillStyleSpec {
  const o = obj(v, where, ['fill', 'color', 'hex', 'width', 'angle', 'step', 'offset', 'noOutline', 'invert'], ['fill', 'color', 'width']);
  const out: Record<string, unknown> = {
    fill: oneOf(o.fill, `${where}.fill`, FILL_STYLES),
    color: oneOf(o.color, `${where}.color`, COLORS),
    width: num(o.width, `${where}.width`, 0.01, 10),
  };
  opt(o, 'hex', where, hex, out);
  opt(o, 'angle', where, (x, w) => num(x, w, -360, 360), out);
  opt(o, 'step', where, (x, w) => num(x, w, 0.05, 50), out);
  opt(o, 'offset', where, (x, w) => num(x, w, -20, 20), out);
  // These two are `true` or absent in saves.
  opt(o, 'noOutline', where, (x, w) => (bool(x, w) ? true : fail(w, 'must be true when set')), out);
  opt(o, 'invert', where, (x, w) => (bool(x, w) ? true : fail(w, 'must be true when set')), out);
  return out as unknown as FillStyleSpec;
}

function checkLook(v: unknown, where: string): MarkingLook {
  const head = obj(v, where, ['shape', 'spec', 'parts', 'fill', 'stamp', 'color', 'width', 'text'], ['shape']);
  const shape = oneOf(head.shape, `${where}.shape`, ['line', 'fill', 'stamp'] as const);
  if (shape === 'line') {
    const o = obj(v, where, ['shape', 'spec', 'parts'], ['spec']);
    const out: MarkingLook = { shape, spec: checkSpec(o.spec, `${where}.spec`) };
    if (o.parts !== undefined) {
      out.parts = arr(o.parts, `${where}.parts`, 32).map((p, i) => {
        const w = `${where}.parts[${i}]`;
        const po = obj(p, w, ['from', 'to', 'style'], ['from', 'to', 'style']);
        return { from: num(po.from, `${w}.from`, 0, 1, true) as 0 | 1, to: num(po.to, `${w}.to`, 0, 1, true) as 0 | 1, style: checkSpec(po.style, `${w}.style`) };
      });
    }
    return out;
  }
  if (shape === 'fill') {
    const o = obj(v, where, ['shape', 'fill'], ['fill']);
    return { shape, fill: checkFill(o.fill, `${where}.fill`) };
  }
  const o = obj(v, where, ['shape', 'stamp', 'color', 'width', 'text'], ['stamp', 'color', 'width']);
  const out: MarkingLook = { shape, stamp: oneOf(o.stamp, `${where}.stamp`, STAMP_KINDS), color: oneOf(o.color, `${where}.color`, COLORS), width: num(o.width, `${where}.width`, 0.05, 20) };
  if (o.text !== undefined) out.text = str(o.text, `${where}.text`, 40);
  return out;
}

function checkWallSide(v: unknown, where: string): WallSide {
  const o = obj(v, where, ['on', 'style', 'top', 'height'], ['style', 'top']);
  const out: Record<string, unknown> = { style: oneOf(o.style, `${where}.style`, WALL_STYLES), top: oneOf(o.top, `${where}.top`, WALL_TOPS) };
  opt(o, 'on', where, bool, out);
  opt(o, 'height', where, (x, w) => num(x, w, 0, 60), out);
  return out as unknown as WallSide;
}

function checkStructure(v: unknown, where: string): StructureSpec {
  const o = obj(v, where, ['mode', 'left', 'right'], ['mode']);
  const out: Record<string, unknown> = { mode: oneOf(o.mode, `${where}.mode`, STRUCTURE_MODES) };
  opt(o, 'left', where, checkWallSide, out);
  opt(o, 'right', where, checkWallSide, out);
  return out as unknown as StructureSpec;
}

function checkBarrierSide(v: unknown, where: string): BarrierSide {
  const o = obj(v, where, ['kind', 'height'], ['kind', 'height']);
  return { kind: oneOf(o.kind, `${where}.kind`, BARRIER_KINDS), height: num(o.height, `${where}.height`, 0, 12) };
}

function checkBarriers(v: unknown, where: string): BarrierSpec {
  const o = obj(v, where, ['left', 'right']);
  const out: Record<string, unknown> = {};
  opt(o, 'left', where, checkBarrierSide, out);
  opt(o, 'right', where, checkBarrierSide, out);
  return out as BarrierSpec;
}

function checkSideUpgrades(v: unknown, where: string, median: boolean): SideUpgrades | MedianUpgrades {
  const o = obj(v, where, median ? ['lights', 'trees', 'rail'] : ['lights', 'trees', 'rail', 'busStop', 'bikeRacks']);
  const out: Record<string, unknown> = {};
  opt(o, 'lights', where, (x, w) => oneOf(x, w, LIGHTS), out);
  opt(o, 'trees', where, (x, w) => oneOf(x, w, TREES), out);
  opt(o, 'rail', where, (x, w) => oneOf(x, w, RAILS), out);
  opt(o, 'busStop', where, bool, out);
  opt(o, 'bikeRacks', where, bool, out);
  return out;
}

function checkUpgrades(v: unknown, where: string): RoadUpgrades {
  const o = obj(v, where, ['left', 'right', 'median']);
  const out: Record<string, unknown> = {};
  opt(o, 'left', where, (x, w) => checkSideUpgrades(x, w, false), out);
  opt(o, 'right', where, (x, w) => checkSideUpgrades(x, w, false), out);
  opt(o, 'median', where, (x, w) => checkSideUpgrades(x, w, true), out);
  return out as RoadUpgrades;
}

function checkRoadMarkings(v: unknown, where: string): Partial<MarkingStyle> {
  const keys = ['centerLine', 'centerColor', 'laneLine', 'laneColor', 'edgeLine', 'edgeColor', 'stopLines', 'turnArrows', 'crosswalk', 'boundaries'];
  const o = obj(v, where, keys);
  const out: Record<string, unknown> = {};
  for (const k of ['centerLine', 'laneLine', 'edgeLine']) opt(o, k, where, (x, w) => oneOf(x, w, LINE_STYLES), out);
  for (const k of ['centerColor', 'laneColor', 'edgeColor']) opt(o, k, where, (x, w) => oneOf(x, w, COLORS), out);
  opt(o, 'stopLines', where, bool, out);
  opt(o, 'turnArrows', where, bool, out);
  opt(o, 'crosswalk', where, (x, w) => oneOf(x, w, CROSSWALKS), out);
  opt(o, 'boundaries', where, (x, w) => rec(x, w, LANE_KEY, (b, bw) => {
    const bo = obj(b, bw, ['style', 'color'], ['style', 'color']);
    return { style: oneOf(bo.style, `${bw}.style`, LINE_STYLES), color: oneOf(bo.color, `${bw}.color`, COLORS) };
  }), out);
  return out as Partial<MarkingStyle>;
}

export function checkRoadStyle(v: unknown, where: string): RoadStyle {
  const o = obj(v, where, ROAD_STYLE_KEYS as readonly string[]);
  const out: Record<string, unknown> = {};
  opt(o, 'speedKmh', where, kmh, out);
  opt(o, 'laneKinds', where, (x, w) => rec(x, w, LANE_KEY, (k, kw) => oneOf(k, kw, LANE_KINDS)), out);
  opt(o, 'laneSpeeds', where, (x, w) => rec(x, w, LANE_KEY, kmh), out);
  opt(o, 'laneBans', where, (x, w) => rec(x, w, LANE_KEY, (b, bw) => arr(b, bw, VEHICLES.length).map((c, i) => oneOf(c, `${bw}[${i}]`, VEHICLES))), out);
  opt(o, 'surface', where, (x, w) => oneOf(x, w, SURFACES), out);
  opt(o, 'structure', where, checkStructure, out);
  opt(o, 'barriers', where, checkBarriers, out);
  opt(o, 'upgrades', where, checkUpgrades, out);
  opt(o, 'markings', where, checkRoadMarkings, out);
  opt(o, 'paintOff', where, (x, w) => arr(x, w, 80).map((k, i) => {
    const s = str(k, `${w}[${i}]`, 8);
    if (!PAINT_OFF_KEY.test(s)) fail(`${w}[${i}]`, 'is not a line key');
    return s;
  }), out);
  opt(o, 'electrification', where, (x, w) => oneOf(x, w, ELECTRIFICATION), out);
  return out as RoadStyle;
}

function checkLane(v: unknown, where: string): LaneDef {
  const o = obj(v, where, ['offset', 'width', 'dir', 'kind', 'speedKmh'], ['offset', 'width', 'dir', 'kind']);
  const dir = num(o.dir, `${where}.dir`, -1, 1, true);
  if (dir === 0) fail(`${where}.dir`, 'must be 1 or -1');
  const out: LaneDef = { offset: num(o.offset, `${where}.offset`, -60, 60), width: num(o.width, `${where}.width`, 0.5, 10), dir: dir as 1 | -1, kind: oneOf(o.kind, `${where}.kind`, LANE_KINDS) };
  if (o.speedKmh !== undefined) out.speedKmh = kmh(o.speedKmh, `${where}.speedKmh`);
  return out;
}

export function checkRoadTypeDef(v: unknown, where: string): RoadTypeDef {
  const keys = ['id', 'name', 'category', 'lanes', 'halfWidth', 'sidewalk', 'sidewalkLeft', 'sidewalkRight', 'shoulder', 'median', 'speedKmh', 'rank', 'markings'];
  const o = obj(v, where, keys, ['id', 'name', 'category', 'lanes', 'halfWidth', 'sidewalk', 'shoulder', 'median', 'speedKmh', 'rank', 'markings']);
  const id = str(o.id, `${where}.id`, 64);
  if (!ROAD_TYPE_ID.test(id)) fail(`${where}.id`, 'is not a road type id');
  const mo = obj(o.median, `${where}.median`, ['width', 'kind', 'offset'], ['width', 'kind']);
  const median: RoadTypeDef['median'] = { width: num(mo.width, `${where}.median.width`, 0, 40), kind: oneOf(mo.kind, `${where}.median.kind`, MEDIANS) };
  if (mo.offset !== undefined) median.offset = num(mo.offset, `${where}.median.offset`, -40, 40);
  const markings = checkRoadMarkings(o.markings, `${where}.markings`);
  for (const k of ['centerLine', 'centerColor', 'laneLine', 'laneColor', 'edgeLine', 'edgeColor', 'stopLines', 'turnArrows', 'crosswalk'] as const) {
    if (markings[k] === undefined) fail(`${where}.markings`, `is missing "${k}"`);
  }
  const def: RoadTypeDef = {
    id,
    name: str(o.name, `${where}.name`, 80),
    category: oneOf(o.category, `${where}.category`, CATEGORIES),
    lanes: arr(o.lanes, `${where}.lanes`, 32).map((l, i) => checkLane(l, `${where}.lanes[${i}]`)),
    halfWidth: num(o.halfWidth, `${where}.halfWidth`, 0.5, 80),
    sidewalk: num(o.sidewalk, `${where}.sidewalk`, 0, 20),
    shoulder: num(o.shoulder, `${where}.shoulder`, 0, 20),
    median,
    speedKmh: kmh(o.speedKmh, `${where}.speedKmh`),
    rank: num(o.rank, `${where}.rank`, 0, 100),
    markings: markings as MarkingStyle,
  };
  if (o.sidewalkLeft !== undefined) def.sidewalkLeft = num(o.sidewalkLeft, `${where}.sidewalkLeft`, 0, 20);
  if (o.sidewalkRight !== undefined) def.sidewalkRight = num(o.sidewalkRight, `${where}.sidewalkRight`, 0, 20);
  const problems = roadTypeProblems(def);
  if (problems.length) fail(where, problems.join(', '));
  return def;
}

function checkPhase(v: unknown, where: string): SignalPhase {
  const o = obj(v, where, ['id', 'name', 'greenSec', 'yellowSec', 'allRedSec', 'minGreenSec', 'maxGreenSec', 'moves'], ['id', 'name', 'greenSec', 'yellowSec', 'allRedSec', 'minGreenSec', 'maxGreenSec', 'moves']);
  return {
    id: num(o.id, `${where}.id`, 0, 1e9, true),
    name: str(o.name, `${where}.name`, 60),
    greenSec: num(o.greenSec, `${where}.greenSec`, 0, 600),
    yellowSec: num(o.yellowSec, `${where}.yellowSec`, 0, 60),
    allRedSec: num(o.allRedSec, `${where}.allRedSec`, 0, 60),
    minGreenSec: num(o.minGreenSec, `${where}.minGreenSec`, 0, 600),
    maxGreenSec: num(o.maxGreenSec, `${where}.maxGreenSec`, 0, 600),
    moves: rec(o.moves, `${where}.moves`, PAIR_KEY, (m, w) => oneOf(m, w, ['protected', 'permissive'] as const), 256),
  };
}

function checkPlan(v: unknown, where: string): SignalPlan {
  const o = obj(v, where, ['kind', 'offsetSec', 'phases'], ['kind', 'offsetSec', 'phases']);
  return {
    kind: oneOf(o.kind, `${where}.kind`, ['fixed', 'actuated'] as const),
    offsetSec: num(o.offsetSec, `${where}.offsetSec`, -3600, 3600),
    phases: arr(o.phases, `${where}.phases`, 16).map((p, i) => checkPhase(p, `${where}.phases[${i}]`)),
  };
}

function checkArmRules(v: unknown, where: string): ArmRules {
  const keys = ['uturn', 'laneChange', 'enterBlocked', 'pedestrians', 'nearTurnOnRed', 'farTurnOnRed'];
  const o = obj(v, where, keys);
  const out: Record<string, unknown> = {};
  for (const k of keys) opt(o, k, where, bool, out);
  return out as ArmRules;
}

function checkJunction(o: Obj, where: string): JunctionClip {
  const arms = num(o.arms, `${where}.arms`, 1, 16, true);
  const inRange = (key: string, w: string) => {
    for (const part of key.split(/[>:]/).slice(0, key.includes(':') ? 1 : 2)) if (Number(part) >= arms) fail(w, `names arm ${part} of ${arms}`);
  };
  const keyed = <T>(v: unknown, w: string, re: RegExp, val: (x: unknown, w: string) => T, max = 64) => {
    const r = rec(v, w, re, val, max);
    for (const k of Object.keys(r)) inRange(k, `${w}.${k}`);
    return r;
  };
  const clip: JunctionClip = {
    kind: 'junction',
    name: str(o.name, `${where}.name`),
    arms,
    turns: keyed(o.turns, `${where}.turns`, PAIR_KEY, (t, w) => oneOf(t, w, TURNS), 256),
    mode: oneOf(o.mode, `${where}.mode`, JUNCTION_MODES),
    signs: keyed(o.signs, `${where}.signs`, ARM_KEY, (s, w) => oneOf(s, w, SIGNS)),
    signal: o.signal === null ? null : checkPlan(o.signal, `${where}.signal`),
  };
  if (clip.signal) for (const [i, p] of clip.signal.phases.entries()) for (const k of Object.keys(p.moves)) inRange(k, `${where}.signal.phases[${i}].moves.${k}`);
  if (o.rules !== undefined) {
    const ro = obj(o.rules, `${where}.rules`, ['arms', 'laneArrows']);
    const rules: NonNullable<JunctionClip['rules']> = {};
    if (ro.arms !== undefined) rules.arms = keyed(ro.arms, `${where}.rules.arms`, ARM_KEY, checkArmRules);
    if (ro.laneArrows !== undefined) {
      rules.laneArrows = keyed(ro.laneArrows, `${where}.rules.laneArrows`, ARM_LANE_KEY, (t, w) => {
        const list = arr(t, w, 4).map((x, i) => oneOf(x, `${w}[${i}]`, TURNS));
        if (!list.length) fail(w, 'must not be empty');
        return list;
      }, 256);
    }
    clip.rules = rules;
  }
  if (o.shape !== undefined) {
    const so = obj(o.shape, `${where}.shape`, ['corners', 'arms', 'islands', 'scale']);
    const shape: NonNullable<JunctionClip['shape']> = {};
    if (so.corners !== undefined) {
      shape.corners = keyed(so.corners, `${where}.shape.corners`, PAIR_KEY, (c, w) => {
        const co = obj(c, w, ['radius', 'kerb', 'sidewalk']);
        const out: Record<string, unknown> = {};
        opt(co, 'radius', w, (x, xw) => num(x, xw, 0, 200), out);
        opt(co, 'kerb', w, (x, xw) => num(x, xw, -20, 20), out);
        opt(co, 'sidewalk', w, bool, out);
        return out as ShapeCorner;
      });
    }
    if (so.arms !== undefined) {
      shape.arms = keyed(so.arms, `${where}.shape.arms`, ARM_KEY, (a, w) => {
        const ao = obj(a, w, ['trim', 'edgeLeft', 'edgeRight']);
        const out: Record<string, unknown> = {};
        opt(ao, 'trim', w, (x, xw) => num(x, xw, -100, 200), out);
        opt(ao, 'edgeLeft', w, (x, xw) => num(x, xw, -20, 20), out);
        opt(ao, 'edgeRight', w, (x, xw) => num(x, xw, -20, 20), out);
        return out as ShapeArm;
      });
    }
    if (so.islands !== undefined) {
      shape.islands = arr(so.islands, `${where}.shape.islands`, 32).map((v, i) => {
        const w = `${where}.shape.islands[${i}]`;
        const io = obj(v, w, ['arm', 'from', 'to', 'back', 'reach'], ['arm', 'from', 'to', 'back', 'reach']);
        const isl: ClipIsland = {
          arm: num(io.arm, `${w}.arm`, 0, arms - 1, true),
          from: num(io.from, `${w}.from`, 0, 64, true),
          to: num(io.to, `${w}.to`, 0, 64, true),
          back: num(io.back, `${w}.back`, 0, 500),
          reach: num(io.reach, `${w}.reach`, 0, 500),
        };
        if (isl.to <= isl.from) fail(w, 'must have from below to');
        return isl;
      });
    }
    if (so.scale !== undefined) shape.scale = num(so.scale, `${where}.shape.scale`, 0.05, 5);
    clip.shape = shape;
  }
  return clip;
}

/** Check a clip object, as found inside an envelope. Throws ClipFormatError. */
export function checkClip(v: unknown, where = 'clip'): Clip {
  const head = obj(v, where, ['kind', 'name', 'roadType', 'typeDef', 'style', 'look', 'arms', 'turns', 'mode', 'signs', 'signal', 'rules', 'shape'], ['kind', 'name']);
  const kind = oneOf(head.kind, `${where}.kind`, ['road', 'marking', 'junction'] as const);
  if (kind === 'road') {
    const o = obj(v, where, ['kind', 'name', 'roadType', 'typeDef', 'style'], ['roadType', 'style']);
    const roadType = str(o.roadType, `${where}.roadType`, 64);
    if (!ROAD_TYPE_ID.test(roadType)) fail(`${where}.roadType`, 'is not a road type id');
    const clip: RoadClip = { kind, name: str(o.name, `${where}.name`), roadType, style: checkRoadStyle(o.style, `${where}.style`) };
    if (o.typeDef !== undefined) {
      clip.typeDef = checkRoadTypeDef(o.typeDef, `${where}.typeDef`);
      if (clip.typeDef.id !== roadType) fail(`${where}.typeDef.id`, 'must match roadType');
    }
    return clip;
  }
  if (kind === 'marking') {
    const o = obj(v, where, ['kind', 'name', 'look'], ['look']);
    return { kind, name: str(o.name, `${where}.name`), look: checkLook(o.look, `${where}.look`) };
  }
  const o = obj(v, where, ['kind', 'name', 'arms', 'turns', 'mode', 'signs', 'signal', 'rules', 'shape'], ['arms', 'turns', 'mode', 'signs', 'signal']);
  return checkJunction(o, where);
}

/**
 * Read clipboard text. Null when it is not a Cloverleaf clip at all (someone's
 * ordinary text); throws ClipFormatError when it claims to be one but is malformed.
 */
export function parseClip(text: string): { clip: Clip; at: number } | null {
  if (typeof text !== 'string' || text.length > MAX_CLIP_CHARS) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"cloverleaf"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || (raw as Obj).cloverleaf !== 'clipboard') return null;
  const env = obj(raw, 'clipboard', ['cloverleaf', 'version', 'at', 'clip'], ['cloverleaf', 'version', 'at', 'clip']);
  if (env.version !== 1) fail('clipboard.version', 'is not one this game reads');
  const at = num(env.at, 'clipboard.at', 0, 1e14);
  return { clip: checkClip(env.clip), at };
}
