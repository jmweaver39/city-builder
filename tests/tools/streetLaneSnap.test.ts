import { describe, expect, it } from 'vitest';
import { RoadNetwork, type Vec3 } from '../../src/core';
import { laneChoiceAt, streetEndFor } from '../../src/tools/laneSnap';

const v = (x: number, z: number): Vec3 => ({ x, y: 0, z });

/** street-4 along +x: its +x lanes sit at +z, kerb lane at about z = 5.25. */
function street(type = 'street-4') {
  const net = new RoadNetwork();
  const seg = net.drawRoad({ start: { kind: 'free', pos: v(-300, 0) }, end: { kind: 'free', pos: v(300, 0) }, roadType: type }).segments[0];
  return { net, seg };
}

describe('lane snap on streets', () => {
  it('offers a snap point on every driving lane of a street', () => {
    const { net, seg } = street();
    const choice = laneChoiceAt(net, { kind: 'segment', id: seg, t: 0.5 }, v(0, 5))!;
    expect(choice.street).toBe(true);
    expect(choice.lanes).toHaveLength(4);
    expect(choice.chosen.fromEdge).toBe(0);
    expect(choice.chosen.travel.x).toBeGreaterThan(0.9);
  });

  it('a road arriving square from the kerb side is a terminal on the lanes counted from its side', () => {
    const { net, seg } = street();
    const kerb = laneChoiceAt(net, { kind: 'segment', id: seg, t: 0.5 }, v(0, 5))!;
    const end = streetEndFor(kerb, v(0, 200), true);
    expect(end.side).toBe(false);
    expect(end.attach.lanes).toEqual([0]);
    expect(end.lanes[0].turn).toBe('right');
    // Picking the far inside lane as well gives a left turn, counted after the two near lanes.
    const farInside = kerb.lanes.find((s) => s.side === -1 && s.fromEdge === 1)!;
    const both = streetEndFor({ ...kerb, picked: [kerb.chosen, farInside] }, v(0, 200), true);
    expect(both.attach.lanes).toEqual([0, 2]);
    expect(both.lanes.map((l) => l.turn)).toEqual(['right', 'left']);
    // Seen from the other side of the street the same kerb lane is the far one.
    expect(streetEndFor(kerb, v(0, -200), true).attach.lanes).toEqual([3]);
  });

  it('a one-way road arriving along the kerb merges there; a two-way road never does', () => {
    const { net, seg } = street();
    const kerb = laneChoiceAt(net, { kind: 'segment', id: seg, t: 0.5 }, v(0, 5))!;
    const merge = streetEndFor(kerb, v(-200, 40), true);
    expect(merge.side).toBe(true);
    expect(merge.attach.lanes).toBeUndefined();
    expect(merge.attach.lane).toBe(0);
    expect(merge.pos.z).toBeGreaterThan(6);
    expect(streetEndFor(kerb, v(-200, 40), false).side).toBe(false);
  });

  it('a highway keeps its own lane snap rules', () => {
    const net = new RoadNetwork();
    const seg = net.drawRoad({ start: { kind: 'free', pos: v(-300, 0) }, end: { kind: 'free', pos: v(300, 0) }, roadType: 'highway-3' }).segments[0];
    const choice = laneChoiceAt(net, { kind: 'segment', id: seg, t: 0.5 }, v(0, 5))!;
    expect(choice.street).toBe(false);
  });
});
