/**
 * Helpers for making stations and lines: names, colours, which train suits a
 * track, how much platform a place has room for, and autoLine.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import { trackSpec, type RailLine, type RailStationKind, type TrainTypeId } from '../core/railTypes';
import type { Id, Vec3 } from '../core/types';
import { TRAIN_TYPES, trainLength } from './consists';
import { FOUL_DISTANCE } from './constants';
import type { TrackGraph } from './TrackGraph';
import type { TrainSim } from './TrainSim';

export const LINE_COLORS = ['#e8423a', '#2f8fe0', '#f2b21c', '#34b36b', '#9b59d0', '#ef7d2a', '#1fb5b0', '#d6487e', '#7a8a99', '#8bc34a'];

const NAMES = [
  'Central', 'Harbour', 'Elm Park', 'Riverside', 'Market Street', 'Northgate', 'Old Town', 'Mill Lane', 'Station Square', 'Westfield',
  'Eastbank', 'Hillcrest', 'Kings Cross Road', 'Parkway', 'University', 'Docklands', 'Ashford', 'Bridge Street', 'Fairview', 'Southend',
];

export function nextStationName(net: RoadNetwork): string {
  const used = new Set(net.rail.stations.map((s) => s.name));
  for (const n of NAMES) if (!used.has(n)) return n;
  return `Station ${net.rail.stations.length + 1}`;
}

export function nextLineColor(net: RoadNetwork): string {
  const used = new Set(net.rail.lines.map((l) => l.color));
  return LINE_COLORS.find((c) => !used.has(c)) ?? LINE_COLORS[net.rail.lines.length % LINE_COLORS.length];
}

/** The train a track suits best. */
export function suggestTrainType(net: RoadNetwork, segmentId: Id): TrainTypeId {
  const def = net.roadTypeOf(segmentId);
  const spec = trackSpec(def.id);
  if (spec?.metro) return 'metro';
  if (def.id === 'hsr-double') return 'highspeed';
  return 'emu';
}

/** Whether a station is under ground when placed here. */
export function stationKindAt(pos: Vec3): RailStationKind {
  return pos.y < -1.5 ? 'underground' : 'surface';
}

/**
 * Plain track either side of a point, in metres, stopping at a junction, a level
 * crossing or the end of the track. A platform must fit inside it.
 */
export function platformRoom(graph: TrackGraph, pos: Vec3): { back: number; ahead: number } | null {
  const hit = graph.nearest(pos, FOUL_DISTANCE * 2);
  if (!hit) return null;
  const walk = (forward: boolean): number => {
    let total = 0;
    let piece = graph.pieces[hit.piece];
    let dir = forward;
    let room = forward ? piece.length - hit.s : hit.s;
    for (let guard = 0; guard < 60; guard++) {
      total += room;
      if (total > 2000) return total;
      const state = piece.id * 2 + (dir ? 0 : 1);
      const next = graph.next[state];
      if (next.length !== 1) return total;
      const n = next[0];
      const q = graph.pieces[n >> 1];
      if (q.kind !== 'run' || graph.prev[n].length !== 1 || !graph.blocks[q.block].plain) return total;
      piece = q;
      dir = (n & 1) === 0;
      room = piece.length;
    }
    return total;
  };
  return { back: walk(false), ahead: walk(true) };
}

/** What each train type would need of this platform, for the station tool readout. */
export function platformFits(length: number): { type: TrainTypeId; cars: number; length: number; fits: boolean }[] {
  return (Object.keys(TRAIN_TYPES) as TrainTypeId[])
    .filter((id) => id !== 'freight')
    .map((id) => {
      const cars = TRAIN_TYPES[id].defaultCars;
      const l = trainLength(id, cars);
      return { type: id, cars, length: l, fits: l <= length + 1 };
    });
}

export interface LineDraft {
  stops: Id[];
  trainType?: TrainTypeId;
  cars?: number;
  trains?: number;
  name?: string;
}

/** Fill in what a line needs that the player has not chosen. */
export function completeLine(net: RoadNetwork, draft: LineDraft): Omit<RailLine, 'id'> {
  const first = net.rail.stations.find((s) => s.id === draft.stops[0]);
  const gateways = draft.stops.every((id) => net.rail.stations.find((s) => s.id === id)?.kind === 'gateway');
  const trainType: TrainTypeId = draft.trainType ?? (gateways ? 'freight' : first ? suggestTrainType(net, first.segmentId) : 'emu');
  const type = TRAIN_TYPES[trainType];
  return {
    name: draft.name ?? `Line ${net.rail.lines.length + 1}`,
    color: nextLineColor(net),
    stops: [...draft.stops],
    trainType,
    cars: draft.cars ?? type.defaultCars,
    trains: draft.trains ?? (gateways ? 2 : 3),
  };
}

/**
 * Make a line between two stations, choosing a train that suits the track and a
 * sensible fleet. Returns the new id, or the reason it cannot run.
 */
export function autoLine(net: RoadNetwork, trains: TrainSim, a: Id, b: Id, draft: Partial<LineDraft> = {}): { id: Id | null; problem: string | null; warning: string | null } {
  if (a === b) return { id: null, problem: 'Pick two different stations', warning: null };
  const init = completeLine(net, { ...draft, stops: [a, b] });
  const check = trains.checkLine(init);
  if (check.problem) return { id: null, problem: check.problem, warning: null };
  return { id: net.addLine(init), problem: null, warning: check.warning };
}
