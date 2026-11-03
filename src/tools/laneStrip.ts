/**
 * The Road Designer's cross section, as an ordered list of elements left to right.
 * Pure data and rules, so the drag behaviour can be tested without a DOM. Nothing
 * here assumes the two sides of a road match.
 */
import type { CustomLane, CustomRoadParams } from '../core/roadTypes';
import { customLaneProblems } from '../core/roadTypes';
import type { LaneKind, MedianKind, RoadTypeDef } from '../core/types';

export interface LaneItem {
  uid: number;
  type: 'lane';
  kind: LaneKind;
  dir: 1 | -1;
  width: number;
  /** Absent means the road's speed. */
  speedKmh?: number;
}

export interface MedianItem {
  uid: number;
  type: 'median';
  kind: Exclude<MedianKind, 'none'>;
  width: number;
}

export interface SideItem {
  uid: number;
  type: 'sidewalk' | 'shoulder';
  width: number;
}

export type StripItem = LaneItem | MedianItem | SideItem;

let nextUid = 1;
const uid = (): number => nextUid++;

const DEFAULT_WIDTH: Record<LaneKind, number> = { drive: 3.5, bus: 3.5, bike: 1.8, rail: 3.5 };

export function makeLane(kind: LaneKind, dir: 1 | -1): LaneItem {
  return { uid: uid(), type: 'lane', kind, dir, width: DEFAULT_WIDTH[kind] };
}

const isEdge = (i: StripItem): i is SideItem => i.type === 'sidewalk' || i.type === 'shoulder';
const isLane = (i: StripItem): i is LaneItem => i.type === 'lane';

/** A road type as a strip. */
export function stripFromDef(def: RoadTypeDef): StripItem[] {
  const out: StripItem[] = [];
  const walkLeft = def.sidewalkLeft ?? def.sidewalk;
  const walkRight = def.sidewalkRight ?? def.sidewalk;
  const side = (type: SideItem['type'], width: number) => {
    if (width > 0.01) out.push({ uid: uid(), type, width });
  };
  const lanes = def.lanes;
  const first = lanes[0];
  const last = lanes[lanes.length - 1];
  side('sidewalk', walkLeft);
  side('shoulder', first.offset - first.width / 2 + def.halfWidth);
  const m = def.median;
  const medianAt = m.offset ?? 0;
  let medianDone = m.kind === 'none' || m.width <= 0;
  for (const l of lanes) {
    if (!medianDone && medianAt < l.offset) {
      out.push({ uid: uid(), type: 'median', kind: m.kind as MedianItem['kind'], width: m.width });
      medianDone = true;
    }
    const item: LaneItem = { uid: uid(), type: 'lane', kind: l.kind, dir: l.dir, width: l.width };
    if (l.speedKmh !== undefined) item.speedKmh = l.speedKmh;
    out.push(item);
  }
  if (!medianDone) out.push({ uid: uid(), type: 'median', kind: m.kind as MedianItem['kind'], width: m.width });
  side('shoulder', def.halfWidth - (last.offset + last.width / 2));
  side('sidewalk', walkRight);
  return out;
}

/** The fields of CustomRoadParams a strip decides. */
export function stripToParams(items: readonly StripItem[]): Pick<
  CustomRoadParams,
  'lanes' | 'medianKind' | 'medianWidth' | 'medianIndex' | 'sidewalkLeft' | 'sidewalkRight' | 'shoulderLeft' | 'shoulderRight'
> {
  const firstLane = items.findIndex(isLane);
  const lanes: CustomLane[] = items.filter(isLane).map((l) => ({
    kind: l.kind,
    dir: l.dir,
    width: l.width,
    ...(l.speedKmh === undefined ? {} : { speedKmh: l.speedKmh }),
  }));
  const sideWidth = (type: SideItem['type'], left: boolean) => {
    const found = items.find((i, n) => i.type === type && (firstLane < 0 ? left : n < firstLane === left));
    return found?.width ?? 0;
  };
  const medianPos = items.findIndex((i) => i.type === 'median');
  const median = medianPos >= 0 ? (items[medianPos] as MedianItem) : null;
  return {
    lanes,
    medianKind: median?.kind ?? 'none',
    medianWidth: median?.width ?? 0,
    ...(median ? { medianIndex: items.slice(0, medianPos).filter(isLane).length } : {}),
    sidewalkLeft: sideWidth('sidewalk', true),
    sidewalkRight: sideWidth('sidewalk', false),
    shoulderLeft: sideWidth('shoulder', true),
    shoulderRight: sideWidth('shoulder', false),
  };
}

/** Keep edge elements outermost: sidewalk, then shoulder, on each side. */
function normalise(items: StripItem[]): StripItem[] {
  const inner = items.filter((i) => !isEdge(i));
  const mid = items.findIndex((i) => !isEdge(i));
  if (mid < 0) return items;
  const pick = (type: SideItem['type'], left: boolean) => items.filter((i, n) => i.type === type && n < mid === left);
  return [...pick('sidewalk', true), ...pick('shoulder', true), ...inner, ...pick('shoulder', false), ...pick('sidewalk', false)];
}

/** A lane dropped among lanes running the other way takes their direction. */
function settleDirection(items: StripItem[], id: number): StripItem[] {
  const i = items.findIndex((x) => x.uid === id);
  const lane = items[i];
  if (!lane || !isLane(lane)) return items;
  const before = items.slice(0, i).filter(isLane);
  const after = items.slice(i + 1).filter(isLane);
  let dir = lane.dir;
  if (before.some((l) => l.dir === 1)) dir = 1;
  else if (after.some((l) => l.dir === -1)) dir = -1;
  return dir === lane.dir ? items : items.map((x) => (x.uid === id ? { ...lane, dir } : x));
}

/**
 * Move an element to a gap, where gap k sits before items[k] as they are now. Lanes
 * and medians go anywhere between the edges. Sidewalks and shoulders go to whichever
 * end is nearer, swapping with their counterpart if that side already has one.
 */
export function moveItem(items: readonly StripItem[], id: number, gap: number): StripItem[] {
  const from = items.findIndex((i) => i.uid === id);
  if (from < 0) return [...items];
  const item = items[from];
  if (isEdge(item)) {
    const left = gap <= items.length / 2;
    const mid = items.findIndex((i) => !isEdge(i));
    const wasLeft = from < mid;
    if (left === wasLeft) return [...items];
    const rest = items.filter((i) => i.uid !== id);
    const other = rest.find((i) => i.type === item.type);
    if (other) {
      // Both sides have one, so they trade places.
      return items.map((i) => (i.uid === id ? other : i.uid === other.uid ? item : i));
    }
    return normalise(left ? [item, ...rest] : [...rest, item]);
  }
  const without = items.filter((i) => i.uid !== id);
  const target = gap > from ? gap - 1 : gap;
  const at = Math.max(firstInnerGap(without), Math.min(target, lastInnerGap(without)));
  const next = [...without.slice(0, at), item, ...without.slice(at)];
  return settleDirection(next, id);
}

/** Add a lane on the outside of its direction's lanes. */
export function addLane(items: readonly StripItem[], kind: LaneKind, dir: 1 | -1): StripItem[] {
  const lane = makeLane(kind, dir);
  const out = [...items];
  const lanes = out.map((x, i) => (isLane(x) ? i : -1)).filter((i) => i >= 0);
  if (dir === -1) {
    out.splice(lanes.length ? lanes[0] : firstInnerGap(out), 0, lane);
  } else {
    const last = lanes.length ? lanes[lanes.length - 1] + 1 : lastInnerGap(out);
    out.splice(last, 0, lane);
  }
  return out;
}

/** The gap after the elements at the left edge. */
function firstInnerGap(items: readonly StripItem[]): number {
  const mid = items.findIndex((i) => !isEdge(i));
  return mid < 0 ? Math.ceil(items.length / 2) : mid;
}

/** The gap before the elements at the right edge. */
function lastInnerGap(items: readonly StripItem[]): number {
  let i = items.length;
  while (i > 0 && isEdge(items[i - 1])) i--;
  return i === 0 ? Math.ceil(items.length / 2) : i;
}

/** Add a median between the directions, or a sidewalk or shoulder on one side. */
export function addElement(items: readonly StripItem[], type: 'median' | SideItem['type'], left = true): StripItem[] {
  if (type === 'median') {
    if (items.some((i) => i.type === 'median')) return [...items];
    const firstForward = items.findIndex((i) => isLane(i) && i.dir === 1);
    const at = firstForward < 0 ? lastInnerGap(items) : firstForward;
    const out = [...items];
    out.splice(at, 0, { uid: uid(), type: 'median', kind: 'grass', width: 2 });
    return out;
  }
  const mid = items.findIndex((i) => !isEdge(i));
  if (items.some((i, n) => i.type === type && n < mid === left)) return [...items];
  const item: SideItem = { uid: uid(), type, width: type === 'sidewalk' ? 2 : 1.5 };
  return normalise(left ? [item, ...items] : [...items, item]);
}

export function removeItem(items: readonly StripItem[], id: number): StripItem[] {
  return items.filter((i) => i.uid !== id);
}

export function updateItem(items: readonly StripItem[], id: number, patch: { kind?: LaneKind | MedianItem['kind']; dir?: 1 | -1; width?: number; speedKmh?: number }): StripItem[] {
  return items.map((i) => (i.uid === id ? ({ ...i, ...patch } as StripItem) : i));
}

/** Flip a lane by carrying it across to the boundary between the directions. */
export function setDirection(items: readonly StripItem[], id: number, dir: 1 | -1): StripItem[] {
  const lane = items.find((i) => i.uid === id);
  if (!lane || !isLane(lane) || lane.dir === dir) return [...items];
  const flipped: LaneItem = { ...lane, dir };
  const rest = items.filter((i) => i.uid !== id);
  const firstForward = rest.findIndex((i) => isLane(i) && i.dir === 1);
  let at: number;
  if (firstForward >= 0) {
    at = firstForward;
    // Stay on this side of a median between the directions.
    if (dir === -1 && rest[at - 1]?.type === 'median') at -= 1;
  } else {
    at = lastInnerGap(rest);
  }
  return [...rest.slice(0, at), flipped, ...rest.slice(at)];
}

export function stripIssues(items: readonly StripItem[]): string[] {
  return customLaneProblems(stripToParams(items));
}

/** Width across everything, sidewalks included. */
export function stripWidth(items: readonly StripItem[]): number {
  return items.reduce((sum, i) => sum + i.width, 0);
}
