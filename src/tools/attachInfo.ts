/**
 * What a road's lane attaches do, in words, for the inspectors: which host lanes
 * each attached end turns into or out of. Read from the live connectors, so it
 * also shows hand-set lane links.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import { attachAt, isStreetHost, pickHost } from '../core/ramps';
import type { Id } from '../core/types';

export interface AttachSummary {
  end: 'start' | 'end';
  nodeId: Id;
  /** 'Terminal', 'Slip lane' or 'Ramp'. */
  kind: string;
  /** One entry per link, e.g. "Lane 1 left into Avenue 4-lane, lane 2 from the kerb". */
  links: string[];
}

/** Lane number counted from the kerb of its own direction, 1 being the kerb lane. */
function fromKerb(net: RoadNetwork, seg: Id, laneIndex: number): number {
  const lanes = net.roadTypeOf(seg).lanes;
  const own = lanes[laneIndex];
  if (!own) return laneIndex + 1;
  const same = lanes.filter((l) => l.dir === own.dir && l.kind !== 'bike' && l.kind !== 'rail');
  // The kerb is right of the travel: the highest offset for dir 1, the lowest for dir -1.
  return same.filter((l) => (own.dir === 1 ? l.offset > own.offset : l.offset < own.offset)).length + 1;
}

export function attachSummaries(net: RoadNetwork, segId: Id): AttachSummary[] {
  const seg = net.getSegment(segId);
  if (!seg) return [];
  const g = net.laneGraph;
  const out: AttachSummary[] = [];
  for (const [end, nodeId] of [['start', seg.a], ['end', seg.b]] as const) {
    const attach = attachAt(seg, nodeId);
    if (!attach) continue;
    const host = pickHost(net.attachAccess, nodeId, segId);
    const street = host ? isStreetHost(net.roadTypeOf(host.id).category) : false;
    const kind = attach.lanes ? 'Terminal' : street ? 'Slip lane' : 'Ramp';
    const links: string[] = [];
    for (const idx of g.connectorsAt.get(nodeId) ?? []) {
      const c = g.lanes[idx];
      const from = g.lanes[c.fromLane];
      const to = g.lanes[c.toLane];
      const mine = from.segmentId === segId ? from : to.segmentId === segId ? to : null;
      if (!mine) continue;
      const other = mine === from ? to : from;
      const otherName = net.getSegment(other.segmentId)?.overrides.name || net.roadTypeOf(other.segmentId).name;
      const n = fromKerb(net, other.segmentId, other.laneIndex);
      const which = n === 1 ? 'kerb lane' : `lane ${n} from the kerb`;
      const turn = c.turn ?? 'straight';
      links.push(mine === from ? `Lane ${mine.laneIndex + 1} ${turn} into ${otherName}, ${which}` : `${otherName}, ${which}, ${turn} into lane ${mine.laneIndex + 1}`);
    }
    out.push({ end, nodeId, kind, links: links.sort() });
  }
  return out;
}
