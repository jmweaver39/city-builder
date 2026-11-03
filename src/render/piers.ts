/**
 * Where bridge supports may stand. Everything passing under a deck gets a plan
 * footprint: road and track widths, plus room for catenary masts beside wired
 * track, and station platforms. A column may stand only clear of all of them.
 */
import { boxesOverlap, placedStationFootprint, segmentFootprint, type PlanBox } from '../core/footprint';
import { segmentElectrification } from '../core/railTypes';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id } from '../core/types';

/** Room either side of wired track for its masts. */
const MAST_ZONE = 1.8;
/** Gap kept between a column and anything beneath. */
const MARGIN = 0.6;

export interface Below {
  boxes: PlanBox[];
}

/** Plan boxes of everything lower than `deckY - 2` near a region. */
export function belowDeck(net: RoadNetwork, selfId: Id, region: { minX: number; minZ: number; maxX: number; maxZ: number }, deckY: number): Below {
  const boxes: PlanBox[] = [];
  const self = net.getSegment(selfId);
  for (const id of net.segmentsInRegion({ minX: region.minX - 30, minZ: region.minZ - 30, maxX: region.maxX + 30, maxZ: region.maxZ + 30 }, true)) {
    if (id === selfId) continue;
    const seg = net.getSegment(id);
    if (!seg) continue;
    // Roads joined to this one at a node are its own approach, not something below it.
    if (self && (seg.a === self.a || seg.a === self.b || seg.b === self.a || seg.b === self.b)) {
      const c = net.cubicOf(id);
      if (Math.max(c.p0.y, c.p3.y) > deckY - 2) continue;
    }
    const def = net.roadTypeOf(id);
    let hw = def.halfWidth + def.sidewalk + MARGIN;
    if (def.category === 'rail' && segmentElectrification(def, seg.overrides) === 'overhead') hw += MAST_ZONE;
    const fp = segmentFootprint(net, id, hw);
    const c = net.cubicOf(id);
    if (Math.min(c.p0.y, c.p3.y, c.p1.y, c.p2.y) > deckY - 2) continue;
    boxes.push(...fp.boxes);
  }
  for (const st of net.rail.stations) {
    const fp = placedStationFootprint(net, st);
    if (!fp || fp.y1 > deckY + 1) continue;
    for (const b of fp.boxes) boxes.push({ ...b, hw: b.hw + MARGIN });
  }
  return { boxes };
}

/** True when a round column of radius r at (x, z) stands clear of everything below. */
export function columnClear(below: Below, x: number, z: number, r: number): boolean {
  const probe: PlanBox = { cx: x, cz: z, ax: 1, az: 0, hl: r, hw: r };
  for (const b of below.boxes) if (boxesOverlap(probe, b)) return false;
  return true;
}
