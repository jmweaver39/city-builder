/**
 * Built-in road catalogue and the custom road builder. All lane layouts come
 * from one function, so built-in and custom roads obey the same conventions:
 * lanes sorted by offset ascending, dir 1 lanes right of a two-way road's centre,
 * one-way roads all dir 1 and centred on the segment.
 */
import type {
  CrosswalkStyle,
  LaneDef,
  LaneKind,
  LineStyle,
  MarkingStyle,
  MedianKind,
  PaintColor,
  RoadCategory,
  RoadTypeDef,
  SegmentOverrides,
} from './types';
import { clamp } from './math';
import { RAIL_ROAD_TYPES } from './railTypes';

/** Rank from which a road counts as avenue-or-larger for automatic signals. */
export const RANK_AVENUE = 3;

/** One lane of a road built lane by lane. */
export interface CustomLane {
  kind: LaneKind;
  dir: 1 | -1;
  width: number;
  speedKmh?: number;
  /** Fixes the lane's position. Set it on every lane or on none. */
  offset?: number;
}

export interface CustomRoadParams {
  id?: string;
  name?: string;
  /**
   * The lanes left to right looking along segment forward. When given it replaces
   * the lane counts and the lane width, and bad layouts are refused, not clamped.
   */
  lanes?: readonly CustomLane[];
  /** Half the carriageway. Defaults to whatever fits the lanes. Needs `lanes`. */
  halfWidth?: number;
  /** The median sits before this lane. Defaults to between the directions. Needs `lanes`. */
  medianIndex?: number;
  /** Per-side widths, beating sidewalkWidth and shoulder. Needs `lanes`. */
  sidewalkLeft?: number;
  sidewalkRight?: number;
  shoulderLeft?: number;
  shoulderRight?: number;
  /** Drive lanes travelling a to b. */
  forwardLanes?: number;
  /** Drive lanes travelling b to a. 0 makes the road one-way. */
  backwardLanes?: number;
  laneWidth?: number;
  /** Width between opposing directions. Ignored on one-way roads. */
  medianWidth?: number;
  medianKind?: MedianKind;
  sidewalkWidth?: number;
  /** Paved shoulder each side. */
  shoulder?: number;
  /** Adds a bike lane on the right of each direction. */
  bikeLanes?: boolean;
  /** Adds a kerbside bus lane per direction, on top of the drive lanes. */
  busLanes?: boolean;
  speedKmh?: number;
  /** Defaults to 'custom'. */
  category?: RoadCategory;
  /** Junction priority. Defaults from the drive lane count. */
  rank?: number;
  /** Merged over the markings the layout would get by default. */
  markings?: Partial<MarkingStyle>;
}

const BIKE_WIDTH = 1.8;
const BUS_WIDTH = 3.5;
const LANE_WIDTH_MIN = 1;
const LANE_WIDTH_MAX = 6;
const LANE_SPEED_MIN = 5;
const LANE_SPEED_MAX = 160;
/** Lanes may touch. Rounding must not make touching lanes look like an overlap. */
const LAYOUT_EPS = 1e-6;

/** Default paint for a layout. */
function defaultMarkings(opts: {
  oneWay: boolean;
  median: MedianKind;
  multiLane: boolean;
  shoulder: number;
  sidewalk: number;
  fast: boolean;
}): MarkingStyle {
  const { oneWay, median, shoulder, sidewalk, fast } = opts;
  const physicalMedian = median === 'grass' || median === 'barrier';
  const center: LineStyle = oneWay || physicalMedian ? 'none' : 'double';
  const edge: LineStyle = shoulder > 0 ? 'solid' : physicalMedian ? 'solid' : 'none';
  const crosswalk: CrosswalkStyle = sidewalk > 0 ? 'zebra' : 'none';
  const edgeColor: PaintColor = 'white';
  return {
    centerLine: center,
    centerColor: 'yellow',
    laneLine: 'dashed',
    laneColor: 'white',
    edgeLine: edge,
    edgeColor,
    stopLines: !fast,
    turnArrows: !fast,
    crosswalk,
  };
}

function buildLanes(
  forward: number,
  backward: number,
  laneWidth: number,
  medianWidth: number,
  bus: boolean,
  bike: boolean,
): { lanes: LaneDef[]; carriageHalf: number } {
  // One direction described from the inside out.
  const sideLanes = (count: number): { kind: LaneKind; width: number }[] => {
    const out: { kind: LaneKind; width: number }[] = [];
    for (let i = 0; i < count; i++) out.push({ kind: 'drive', width: laneWidth });
    if (bus) out.push({ kind: 'bus', width: BUS_WIDTH });
    if (bike) out.push({ kind: 'bike', width: BIKE_WIDTH });
    return out;
  };

  const lanes: LaneDef[] = [];
  if (backward === 0) {
    const side = sideLanes(forward);
    const total = side.reduce((sum, l) => sum + l.width, 0);
    let edge = -total / 2;
    for (const l of side) {
      lanes.push({ offset: edge + l.width / 2, width: l.width, dir: 1, kind: l.kind });
      edge += l.width;
    }
    return { lanes, carriageHalf: total / 2 };
  }

  let edge = medianWidth / 2;
  for (const l of sideLanes(forward)) {
    lanes.push({ offset: edge + l.width / 2, width: l.width, dir: 1, kind: l.kind });
    edge += l.width;
  }
  const rightHalf = edge;
  edge = medianWidth / 2;
  const left: LaneDef[] = [];
  for (const l of sideLanes(backward)) {
    left.push({ offset: -(edge + l.width / 2), width: l.width, dir: -1, kind: l.kind });
    edge += l.width;
  }
  lanes.unshift(...left.reverse());
  return { lanes, carriageHalf: Math.max(rightHalf, edge) };
}

interface StripOptions {
  medianWidth: number;
  /** The median sits before this lane. */
  medianIndex: number;
  shoulderLeft: number;
  shoulderRight: number;
}

/**
 * Place lanes left to right across a pavement centred on the curve. Junction
 * geometry only ever needs the half width this way, however uneven the road is.
 */
function layoutStrip(list: readonly CustomLane[], o: StripOptions): { lanes: LaneDef[]; half: number; medianOffset: number } {
  const lane = (l: CustomLane, offset: number): LaneDef => {
    const out: LaneDef = { offset, width: l.width, dir: l.dir, kind: l.kind };
    if (l.speedKmh !== undefined) out.speedKmh = l.speedKmh;
    return out;
  };
  if (list.every((l) => l.offset !== undefined)) {
    const lanes = list.map((l) => lane(l, l.offset as number));
    return { lanes, half: Math.max(...lanes.map((l) => Math.abs(l.offset) + l.width / 2)) + Math.max(o.shoulderLeft, o.shoulderRight), medianOffset: 0 };
  }
  const total = list.reduce((sum, l) => sum + l.width, 0) + o.medianWidth + o.shoulderLeft + o.shoulderRight;
  let edge = -total / 2 + o.shoulderLeft;
  let medianOffset = 0;
  const lanes: LaneDef[] = [];
  const placeMedian = (): void => {
    medianOffset = edge + o.medianWidth / 2;
    edge += o.medianWidth;
  };
  list.forEach((l, i) => {
    if (i === o.medianIndex) placeMedian();
    lanes.push(lane(l, edge + l.width / 2));
    edge += l.width;
  });
  if (o.medianIndex >= list.length) placeMedian();
  return { lanes, half: total / 2, medianOffset };
}

/** Lanes running b to a must stay left of lanes running a to b. */
function directionsOrdered(list: readonly CustomLane[]): boolean {
  let seenForward = false;
  for (const l of list) {
    if (l.dir === 1) seenForward = true;
    else if (seenForward) return false;
  }
  return true;
}

/** A lane list driven only b to a is the same road drawn the other way. */
function asForward(list: readonly CustomLane[]): readonly CustomLane[] {
  if (!list.length || list.some((l) => l.dir === 1)) return list;
  return [...list].reverse().map((l) => ({ ...l, dir: 1 as const, offset: l.offset === undefined ? undefined : -l.offset }));
}

function defaultMedianIndex(list: readonly CustomLane[]): number {
  const first = list.findIndex((l) => l.dir === 1);
  return first < 0 ? list.length : first;
}

type LaneCheck = Pick<
  CustomRoadParams,
  'lanes' | 'halfWidth' | 'medianWidth' | 'medianKind' | 'medianIndex' | 'shoulder' | 'shoulderLeft' | 'shoulderRight'
>;

/** Reasons a lane list cannot make a road. Empty when it can. For live checks in a form. */
export function customLaneProblems(params: LaneCheck): string[] {
  const list = asForward(params.lanes ?? []);
  if (!list.length) return ['A road type needs at least one lane'];
  const problems: string[] = [];
  if (list.some((l) => !(l.width > 0))) problems.push('Every lane needs a width');
  const fixed = list.filter((l) => l.offset !== undefined).length;
  if (fixed !== 0 && fixed !== list.length) problems.push('Set an offset on every lane or on none');
  if (fixed === 0 && !directionsOrdered(list)) {
    problems.push('Lanes running against the road direction must sit left of the others');
  }
  if (problems.length) return problems;
  const medianKind = params.medianKind ?? 'none';
  const { lanes, half } = layoutStrip(list, {
    medianWidth: medianKind === 'none' ? 0 : (params.medianWidth ?? 2),
    medianIndex: params.medianIndex ?? defaultMedianIndex(list),
    shoulderLeft: params.shoulderLeft ?? params.shoulder ?? 0,
    shoulderRight: params.shoulderRight ?? params.shoulder ?? 0,
  });
  return lanesProblems(lanes, params.halfWidth ?? half);
}

/** Overlap and fit, for any set of lanes sorted left to right. */
function lanesProblems(lanes: readonly LaneDef[], halfWidth: number): string[] {
  const problems: string[] = [];
  for (let i = 1; i < lanes.length; i++) {
    const a = lanes[i - 1];
    const b = lanes[i];
    if (a.offset + a.width / 2 > b.offset - b.width / 2 + LAYOUT_EPS) problems.push(`lanes ${i} and ${i + 1} overlap`);
  }
  for (const [i, l] of lanes.entries()) {
    if (Math.abs(l.offset) + l.width / 2 > halfWidth + LAYOUT_EPS) problems.push(`lane ${i + 1} does not fit the road width`);
  }
  return problems;
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Build a valid RoadTypeDef from designer parameters. With lane counts, values
 * outside sensible ranges are clamped so a slider can never produce a broken road,
 * and it throws only when there are no lanes at all. A road with lanes only
 * backward is flipped to forward, because one-way roads must be all dir 1.
 *
 * With `lanes`, widths and speeds are clamped the same way but a layout that does
 * not work throws a RangeError. customLaneProblems gives the same reasons without
 * throwing.
 */
export function makeCustomRoadType(params: CustomRoadParams): RoadTypeDef {
  const laneWidth = clamp(numberOr(params.laneWidth, 3.5), 2.5, 5);
  const sideOf = (one: number | undefined, both: number | undefined, top: number): number =>
    clamp(numberOr(params.lanes ? one : undefined, numberOr(both, 0)), 0, top);
  const walkLeft = sideOf(params.sidewalkLeft, params.sidewalkWidth, 10);
  const walkRight = sideOf(params.sidewalkRight, params.sidewalkWidth, 10);
  const shoulderLeft = sideOf(params.shoulderLeft, params.shoulder, 5);
  const shoulderRight = sideOf(params.shoulderRight, params.shoulder, 5);
  const sidewalk = Math.max(walkLeft, walkRight);
  const shoulder = Math.max(shoulderLeft, shoulderRight);
  const speedKmh = clamp(numberOr(params.speedKmh, 50), 10, 160);
  const bus = !!params.busLanes;
  const bike = !!params.bikeLanes;

  const medianFor = (noMedian: boolean): { kind: MedianKind; width: number } => {
    const kind: MedianKind = noMedian ? 'none' : (params.medianKind ?? 'none');
    return { kind, width: kind === 'none' ? 0 : clamp(numberOr(params.medianWidth, 2), 0.2, 30) };
  };

  let lanes: LaneDef[];
  let halfWidth: number;
  let medianOffset = 0;
  let oneWay: boolean;
  let medianParts: { kind: MedianKind; width: number };
  let tag: string;
  if (params.lanes) {
    const list = asForward(params.lanes).map((l) => ({
      ...l,
      width: clamp(numberOr(l.width, 3.5), LANE_WIDTH_MIN, LANE_WIDTH_MAX),
      ...(l.speedKmh === undefined ? {} : { speedKmh: clamp(numberOr(l.speedKmh, speedKmh), LANE_SPEED_MIN, LANE_SPEED_MAX) }),
    }));
    oneWay = list.every((l) => l.dir === 1);
    // A one-way only has a median when one was placed among its lanes.
    medianParts = medianFor(oneWay && params.medianIndex === undefined);
    const medianIndex = params.medianIndex ?? defaultMedianIndex(list);
    const problems = customLaneProblems({
      lanes: list,
      halfWidth: params.halfWidth,
      medianKind: medianParts.kind,
      medianWidth: medianParts.width,
      medianIndex,
      shoulderLeft,
      shoulderRight,
    });
    if (problems.length) throw new RangeError(problems.join('; '));
    const strip = layoutStrip(list, { medianWidth: medianParts.width, medianIndex, shoulderLeft, shoulderRight });
    lanes = strip.lanes;
    halfWidth = params.halfWidth ?? strip.half;
    medianOffset = strip.medianOffset;
    tag = list.map((l) => `${l.kind[0]}${l.dir > 0 ? 'f' : 'b'}${l.width}${l.speedKmh ? `s${l.speedKmh}` : ''}`).join('.');
  } else {
    let forward = Math.round(clamp(numberOr(params.forwardLanes, 0), 0, 8));
    let backward = Math.round(clamp(numberOr(params.backwardLanes, 0), 0, 8));
    if (forward + backward === 0) {
      throw new RangeError('A road type needs at least one lane');
    }
    if (forward === 0) {
      forward = backward;
      backward = 0;
    }
    oneWay = backward === 0;
    medianParts = medianFor(oneWay);
    const built = buildLanes(forward, backward, laneWidth, medianParts.width, bus, bike);
    lanes = built.lanes;
    halfWidth = built.carriageHalf + shoulder;
    tag = `${forward}-${backward}-${laneWidth}`;
  }
  const medianKind = medianParts.kind;
  const medianWidth = medianParts.width;

  const drive = lanes.filter((l) => l.kind === 'drive').length;
  const forwardDrive = lanes.filter((l) => l.kind === 'drive' && l.dir === 1).length;
  const markings: MarkingStyle = {
    ...defaultMarkings({
      oneWay,
      median: medianKind,
      multiLane: drive > 2,
      shoulder,
      sidewalk,
      fast: speedKmh >= 80,
    }),
    ...(params.markings ?? {}),
  };
  const id =
    params.id ??
    `custom-${tag}-${medianKind}${medianWidth}` +
      `-${sidewalk}-${shoulder}${bike ? '-bike' : ''}${bus ? '-bus' : ''}-${speedKmh}`;
  return {
    id,
    name: params.name ?? `Custom ${forwardDrive}+${drive - forwardDrive}`,
    category: params.category ?? 'custom',
    lanes,
    halfWidth,
    sidewalk,
    ...(walkLeft === walkRight ? {} : { sidewalkLeft: walkLeft, sidewalkRight: walkRight }),
    shoulder,
    median: { width: medianWidth, kind: medianKind, ...(Math.abs(medianOffset) > 1e-9 ? { offset: medianOffset } : {}) },
    speedKmh,
    rank: params.rank ?? Math.max(1, Math.ceil(drive / 2)),
    markings,
  };
}

function preset(params: CustomRoadParams & { id: string; name: string; category: RoadCategory; rank: number }): RoadTypeDef {
  return makeCustomRoadType(params);
}

function highwayOneWay(lanes: number): RoadTypeDef {
  return preset({
    id: `highway-${lanes}`,
    name: `Highway ${lanes}-lane`,
    category: 'highway',
    rank: 5 + lanes,
    forwardLanes: lanes,
    backwardLanes: 0,
    laneWidth: 3.75,
    shoulder: 2.5,
    speedKmh: lanes >= 4 ? 120 : 110,
  });
}

function dualCarriageway(lanes: number): RoadTypeDef {
  return preset({
    id: `dual-${lanes}`,
    name: `Dual carriageway ${lanes}-lane`,
    category: 'highway',
    rank: 5 + lanes / 2,
    forwardLanes: lanes / 2,
    backwardLanes: lanes / 2,
    laneWidth: 3.75,
    medianWidth: 1.2,
    medianKind: 'barrier',
    shoulder: 2.5,
    speedKmh: 100,
  });
}

function buildCatalogue(): RoadTypeDef[] {
  return [
    preset({
      id: 'street-2',
      name: 'Street 2-lane',
      category: 'street',
      rank: 1,
      forwardLanes: 1,
      backwardLanes: 1,
      laneWidth: 3.5,
      sidewalkWidth: 2,
      speedKmh: 50,
    }),
    preset({
      id: 'street-2-bike',
      name: 'Street 2-lane with bike lanes',
      category: 'street',
      rank: 1,
      forwardLanes: 1,
      backwardLanes: 1,
      laneWidth: 3.5,
      sidewalkWidth: 2,
      bikeLanes: true,
      speedKmh: 50,
    }),
    preset({
      id: 'street-2-oneway',
      name: 'Street 2-lane one-way',
      category: 'oneway',
      rank: 1,
      forwardLanes: 2,
      backwardLanes: 0,
      laneWidth: 3.5,
      sidewalkWidth: 2,
      speedKmh: 50,
    }),
    preset({
      id: 'street-4',
      name: 'Street 4-lane',
      category: 'street',
      rank: 2,
      forwardLanes: 2,
      backwardLanes: 2,
      laneWidth: 3.5,
      sidewalkWidth: 2.5,
      speedKmh: 50,
    }),
    preset({
      id: 'avenue-4',
      name: 'Avenue 4-lane with grass median',
      category: 'avenue',
      rank: RANK_AVENUE,
      forwardLanes: 2,
      backwardLanes: 2,
      laneWidth: 3.5,
      medianWidth: 3,
      medianKind: 'grass',
      sidewalkWidth: 3,
      speedKmh: 60,
    }),
    preset({
      id: 'avenue-6',
      name: 'Avenue 6-lane with grass median',
      category: 'avenue',
      rank: 4,
      forwardLanes: 3,
      backwardLanes: 3,
      laneWidth: 3.5,
      medianWidth: 4,
      medianKind: 'grass',
      sidewalkWidth: 3,
      speedKmh: 60,
    }),
    preset({
      id: 'avenue-4-bus',
      name: 'Avenue 4-lane with bus lanes',
      category: 'avenue',
      rank: RANK_AVENUE,
      forwardLanes: 2,
      backwardLanes: 2,
      laneWidth: 3.5,
      medianWidth: 3,
      medianKind: 'grass',
      sidewalkWidth: 3,
      busLanes: true,
      speedKmh: 60,
    }),
    preset({
      id: 'boulevard-8',
      name: 'Boulevard 8-lane',
      category: 'avenue',
      rank: 5,
      forwardLanes: 4,
      backwardLanes: 4,
      laneWidth: 3.5,
      medianWidth: 6,
      medianKind: 'grass',
      sidewalkWidth: 4,
      speedKmh: 70,
    }),
    highwayOneWay(2),
    highwayOneWay(3),
    highwayOneWay(4),
    highwayOneWay(5),
    dualCarriageway(4),
    dualCarriageway(6),
    preset({
      id: 'ramp-1',
      name: 'Ramp 1-lane',
      category: 'ramp',
      rank: 2,
      forwardLanes: 1,
      backwardLanes: 0,
      laneWidth: 4,
      shoulder: 1.5,
      speedKmh: 60,
    }),
    preset({
      id: 'ramp-2',
      name: 'Ramp 2-lane',
      category: 'ramp',
      rank: 2,
      forwardLanes: 2,
      backwardLanes: 0,
      laneWidth: 3.75,
      shoulder: 1.5,
      speedKmh: 60,
    }),
  ];
}

export const BUILTIN_ROAD_TYPES: readonly RoadTypeDef[] = [...buildCatalogue(), ...RAIL_ROAD_TYPES];

const builtinById = new Map(BUILTIN_ROAD_TYPES.map((t) => [t.id, t]));

/** Look up a built-in road type. Use RoadNetwork.roadType to include custom ones. */
export function builtinRoadType(id: string): RoadTypeDef | undefined {
  return builtinById.get(id);
}

export function isOneWay(def: RoadTypeDef): boolean {
  return def.lanes.every((l) => l.dir === 1);
}

export function driveLaneCount(def: RoadTypeDef, dir?: 1 | -1): number {
  return def.lanes.filter((l) => l.kind === 'drive' && (dir === undefined || l.dir === dir)).length;
}

/** Sidewalk width on one side, -1 left and 1 right of a-to-b. */
export function sidewalkOn(def: RoadTypeDef, side: -1 | 1): number {
  return (side < 0 ? def.sidewalkLeft : def.sidewalkRight) ?? def.sidewalk;
}

/** True when a road reads the same from both ends, so it can join itself head on. */
export function lanesMirror(def: RoadTypeDef): boolean {
  const lanes = def.lanes;
  const n = lanes.length;
  for (let i = 0; i < n; i++) {
    const a = lanes[i];
    const b = lanes[n - 1 - i];
    if (Math.abs(a.offset + b.offset) > 0.01 || a.dir === b.dir || a.kind !== b.kind) return false;
    if (Math.abs(a.width - b.width) > 0.01) return false;
  }
  return true;
}

/** Centreline to outside of the sidewalk, on the wider side. */
export function totalHalfWidth(def: RoadTypeDef): number {
  return def.halfWidth + def.sidewalk;
}

/** The catalogue lanes with `overrides.laneKinds` applied. */
export function effectiveLanes(def: RoadTypeDef, overrides?: SegmentOverrides): LaneDef[] {
  const kinds = overrides?.laneKinds;
  const speeds = overrides?.laneSpeeds;
  if (!kinds && !speeds) return def.lanes;
  return def.lanes.map((l, i) => {
    const kind = kinds?.[i];
    const speedKmh = speeds?.[i];
    if (!kind && speedKmh === undefined) return l;
    return { ...l, ...(kind ? { kind } : {}), ...(speedKmh === undefined ? {} : { speedKmh }) };
  });
}

/**
 * The limit of one lane. A placed road's settings beat its type's, and a setting
 * for one lane beats a setting for the whole road at the same level.
 */
export function laneSpeedKmh(def: RoadTypeDef, overrides: SegmentOverrides | undefined, index: number): number {
  return overrides?.laneSpeeds?.[index] ?? overrides?.speedKmh ?? def.lanes[index]?.speedKmh ?? def.speedKmh;
}

export function effectiveMarkings(def: RoadTypeDef, overrides?: SegmentOverrides): MarkingStyle {
  return overrides?.markings ? { ...def.markings, ...overrides.markings } : def.markings;
}

export function effectiveSpeedKmh(def: RoadTypeDef, overrides?: SegmentOverrides): number {
  return overrides?.speedKmh ?? def.speedKmh;
}

/** Problems with a road type definition, for load validation. Empty when good. */
export function roadTypeProblems(def: RoadTypeDef): string[] {
  const problems: string[] = [];
  if (!def.lanes.length) problems.push('has no lanes');
  for (let i = 1; i < def.lanes.length; i++) {
    if (def.lanes[i].offset < def.lanes[i - 1].offset) problems.push('lanes are not sorted by offset');
  }
  if (!(def.halfWidth > 0)) problems.push('halfWidth must be positive');
  if (!(def.speedKmh > 0)) problems.push('speedKmh must be positive');
  if (problems.length === 0) problems.push(...lanesProblems(def.lanes, def.halfWidth));
  // Traffic keeps right, wherever the boundary between directions falls.
  if (!directionsOrdered(def.lanes)) problems.push('lanes running b to a must sit left of lanes running a to b');
  return problems;
}
