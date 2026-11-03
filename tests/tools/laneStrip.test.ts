import { describe, expect, it } from 'vitest';
import { builtinRoadType, makeCustomRoadType, roadTypeProblems, sidewalkOn } from '../../src/core';
import {
  addElement,
  addLane,
  makeLane,
  moveItem,
  removeItem,
  setDirection,
  stripFromDef,
  stripIssues,
  stripToParams,
  stripWidth,
  updateItem,
  type LaneItem,
  type StripItem,
} from '../../src/tools/laneStrip';

const shape = (items: readonly StripItem[]) => items.map((i) => (i.type === 'lane' ? `${i.kind[0]}${i.dir > 0 ? '+' : '-'}` : i.type));
const def = (items: readonly StripItem[]) => makeCustomRoadType({ ...stripToParams(items), id: 'x' });

describe('stripFromDef', () => {
  it('reads a built-in road left to right', () => {
    const items = stripFromDef(builtinRoadType('avenue-4')!);
    expect(shape(items)).toEqual(['sidewalk', 'd-', 'd-', 'median', 'd+', 'd+', 'sidewalk']);
    expect(stripIssues(items)).toEqual([]);
    expect(stripWidth(items)).toBeCloseTo(23, 6);
  });

  it('round trips through the road type for every symmetric built-in', () => {
    for (const id of ['street-2', 'street-2-bike', 'street-4', 'avenue-6', 'avenue-4-bus', 'dual-4', 'highway-3', 'ramp-1']) {
      const original = builtinRoadType(id)!;
      const again = def(stripFromDef(original));
      expect(again.lanes.map((l) => [l.kind, l.dir])).toEqual(original.lanes.map((l) => [l.kind, l.dir]));
      again.lanes.forEach((l, i) => expect(l.offset).toBeCloseTo(original.lanes[i].offset, 6));
      expect(again.halfWidth).toBeCloseTo(original.halfWidth, 6);
    }
  });

  it('round trips an uneven road', () => {
    const items = [
      { uid: 901, type: 'sidewalk', width: 3 } as StripItem,
      makeLane('bus', -1),
      makeLane('drive', -1),
      { uid: 902, type: 'median', kind: 'grass', width: 2 } as StripItem,
      makeLane('drive', 1),
      makeLane('bus', 1),
      makeLane('bus', 1),
    ];
    const made = def(items);
    expect(roadTypeProblems(made)).toEqual([]);
    expect(sidewalkOn(made, -1)).toBe(3);
    expect(sidewalkOn(made, 1)).toBe(0);
    expect(shape(stripFromDef(made))).toEqual(shape(items));
  });
});

describe('Dragging', () => {
  const base = () => stripFromDef(builtinRoadType('street-4')!); // sidewalk d- d- d+ d+ sidewalk

  it('moves a lane to a gap, either way along the strip', () => {
    const items = addLane(base(), 'bus', 1); // sidewalk d- d- d+ d+ b+ sidewalk
    const bus = items[5];
    const moved = moveItem(items, bus.uid, 3);
    expect(shape(moved)).toEqual(['sidewalk', 'd-', 'd-', 'b+', 'd+', 'd+', 'sidewalk']);
    const back = moveItem(moved, bus.uid, 6);
    expect(shape(back)).toEqual(['sidewalk', 'd-', 'd-', 'd+', 'd+', 'b+', 'sidewalk']);
  });

  it('a lane dropped among lanes running the other way turns round', () => {
    const items = addLane(base(), 'bus', 1);
    const bus = items[5];
    const moved = moveItem(items, bus.uid, 1);
    expect(shape(moved)).toEqual(['sidewalk', 'b-', 'd-', 'd-', 'd+', 'd+', 'sidewalk']);
    expect(stripIssues(moved)).toEqual([]);
  });

  it('builds two bus lanes one way and one the other by dragging', () => {
    let items = base();
    items = addLane(items, 'bus', 1);
    items = addLane(items, 'bus', 1);
    items = addLane(items, 'bus', 1);
    const b = items.filter((i) => i.type === 'lane' && i.kind === 'bus');
    items = moveItem(items, b[2].uid, 1);
    expect(shape(items)).toEqual(['sidewalk', 'b-', 'd-', 'd-', 'd+', 'd+', 'b+', 'b+', 'sidewalk']);
    const made = def(items);
    expect(made.lanes.filter((l) => l.kind === 'bus' && l.dir === 1)).toHaveLength(2);
    expect(made.lanes.filter((l) => l.kind === 'bus' && l.dir === -1)).toHaveLength(1);
    expect(roadTypeProblems(made)).toEqual([]);
  });

  it('never leaves a lane outside the sidewalks', () => {
    const items = base();
    const lane = items[1];
    expect(shape(moveItem(items, lane.uid, 0))[0]).toBe('sidewalk');
    expect(shape(moveItem(items, lane.uid, items.length)).at(-1)).toBe('sidewalk');
  });

  it('drags a median off-centre, between lanes of the same direction', () => {
    const items = addElement(base(), 'median');
    expect(shape(items)).toEqual(['sidewalk', 'd-', 'd-', 'median', 'd+', 'd+', 'sidewalk']);
    const m = items[3];
    const moved = moveItem(items, m.uid, 5);
    expect(shape(moved)).toEqual(['sidewalk', 'd-', 'd-', 'd+', 'median', 'd+', 'sidewalk']);
    const made = def(moved);
    expect(made.median.offset).toBeGreaterThan(3);
    expect(roadTypeProblems(made)).toEqual([]);
  });

  it('moves a lone sidewalk to the other side', () => {
    const items = removeItem(base(), base().at(-1)!.uid);
    const fresh = stripFromDef(builtinRoadType('street-4')!);
    const one = removeItem(fresh, fresh[fresh.length - 1].uid);
    const walk = one[0];
    expect(items).toBeDefined();
    const moved = moveItem(one, walk.uid, one.length);
    expect(shape(moved)).toEqual(['d-', 'd-', 'd+', 'd+', 'sidewalk']);
    const made = def(moved);
    expect(sidewalkOn(made, -1)).toBe(0);
    expect(sidewalkOn(made, 1)).toBe(walk.width);
  });

  it('swaps two sidewalks of different widths', () => {
    const items = updateItem(base(), base()[0].uid, {});
    const left = items[0];
    const widened = updateItem(items, left.uid, { width: 4 });
    const moved = moveItem(widened, left.uid, widened.length);
    expect(moved[0].width).toBe(2.5);
    expect(moved.at(-1)!.width).toBe(4);
  });

  it('a drop that changes nothing changes nothing', () => {
    const items = base();
    expect(shape(moveItem(items, items[2].uid, 2))).toEqual(shape(items));
    expect(shape(moveItem(items, items[2].uid, 3))).toEqual(shape(items));
  });
});

describe('Editing the strip', () => {
  it('carries different widths and lane speeds through', () => {
    let items: StripItem[] = [makeLane('drive', -1), makeLane('bike', 1)];
    items = updateItem(items, items[0].uid, { width: 4.5, speedKmh: 30 });
    const made = def(items);
    expect(made.lanes[0]).toMatchObject({ width: 4.5, speedKmh: 30 });
    expect(made.lanes[1].speedKmh).toBeUndefined();
  });

  it('carries a lane across when its direction is switched', () => {
    let items: StripItem[] = stripFromDef(builtinRoadType('street-4')!);
    const left = items[1] as LaneItem;
    items = setDirection(items, left.uid, 1);
    expect(shape(items)).toEqual(['sidewalk', 'd-', 'd+', 'd+', 'd+', 'sidewalk']);
    expect(stripIssues(items)).toEqual([]);
  });

  it('adds lanes on the outside of their own direction, inside the edges', () => {
    const items = addLane(addLane(stripFromDef(builtinRoadType('street-2')!), 'bike', -1), 'bike', 1);
    expect(shape(items)).toEqual(['sidewalk', 'b-', 'd-', 'd+', 'b+', 'sidewalk']);
  });

  it('adds a sidewalk on one side only, and not twice', () => {
    let items: StripItem[] = [makeLane('drive', 1)];
    items = addElement(items, 'sidewalk', false);
    items = addElement(items, 'sidewalk', false);
    expect(shape(items)).toEqual(['d+', 'sidewalk']);
  });

  it('reports a road with no lanes', () => {
    expect(stripIssues([{ uid: 950, type: 'sidewalk', width: 2 }])[0]).toMatch(/at least one lane/);
  });
});
