/**
 * Helpers for making stations and lines: names, colours, which train suits a
 * track, how much platform a place has room for, and autoLine.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import { segmentElectrification, trackSpec, type RailLine, type RailStationKind, type TrainTypeId } from '../core/railTypes';
import type { Id, Vec3 } from '../core/types';
import { closestPointOnCubic, cubicPoint, cubicTangentXZ, curvatureXZ } from '../core/bezier';
import { surfaceLevel, terrainHeight } from '../core/terrain';
import { TRAIN_TYPES, trainLength } from './consists';
import { footprintsClash, ownTrack, placedStationFootprint, segmentFootprint, stationFootprint } from '../core/footprint';
export { stationEntrances, type StationEntrance } from '../core/footprint';
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
  // No wires here: a diesel push-pull, as on an American commuter line.
  const seg = net.getSegment(segmentId);
  if (segmentElectrification(def, seg?.overrides) === 'none') return 'dieselCommuter';
  if (def.id === 'hsr-double') return 'highspeed';
  return 'emu';
}

/** Whether a station is under ground when placed here. */
export function stationKindAt(pos: Vec3): RailStationKind {
  if (pos.y < surfaceLevel(pos.x, pos.z) - 1.5) return 'underground';
  // On a viaduct: well clear of the ground under it.
  return pos.y - terrainHeight(pos.x, pos.z) > 4 ? 'elevated' : 'surface';
}

export interface PlatformCheck {
  problems: string[];
  /** Tightest radius under the platform, metres. */
  radius: number;
}

/** Smallest radius a platform may stand on: straight or gently curved track. */
export const PLATFORM_MIN_RADIUS = 300;

/**
 * Whether a station fits here: gentle track under the platform, room for an island
 * to spread, and nothing else (roads, other track, tunnels) inside its footprint.
 * `reach` is how far the footprint extends either side of the centreline.
 */
export function checkPlatform(
  net: RoadNetwork,
  segmentId: Id,
  t: number,
  length: number,
  reach: { left: number; right: number },
  kind: RailStationKind,
  island: boolean,
  options: { ignoreStation?: Id } = {},
): PlatformCheck {
  const problems: string[] = [];
  const c = net.cubicOf(segmentId);
  const curve = net.curveOf(segmentId);
  const L = curve.length;
  const at = t * L;
  // Radius under the platform from the curvature of the Bezier.
  let radius = Infinity;
  for (let s = at - length / 2; s <= at + length / 2; s += 10) {
    const u = Math.max(0, Math.min(1, s / L));
    const k = Math.abs(curvatureXZ(c, u));
    if (k > 1e-9) radius = Math.min(radius, 1 / k);
  }
  if (radius < PLATFORM_MIN_RADIUS) problems.push(`Platforms need straight or gently curved track: ${Math.round(radius)} m radius here, ${PLATFORM_MIN_RADIUS} m at least`);
  if (island && (at - length / 2 - 82 < 2 || at + length / 2 + 82 > L - 2)) {
    problems.push(`An island needs ${Math.round(length + 164)} m of this track to spread round it`);
  }
  // Footprint against everything else nearby: plan boxes with a height range.
  const mine = stationFootprint(net, segmentId, t, length, reach, kind);
  const own = ownTrack(net, segmentId);
  const what = kind === 'underground' ? 'station box' : kind === 'elevated' ? 'station deck' : 'platform';
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const bx of mine.boxes) {
    const r = bx.hl + bx.hw;
    minX = Math.min(minX, bx.cx - r);
    maxX = Math.max(maxX, bx.cx + r);
    minZ = Math.min(minZ, bx.cz - r);
    maxZ = Math.max(maxZ, bx.cz + r);
  }
  for (const st of net.rail.stations) {
    if (st.id === options.ignoreStation) continue;
    const other = placedStationFootprint(net, st);
    if (other && footprintsClash(mine, other)) {
      problems.push(`The ${what} would overlap ${st.name} station`);
      break;
    }
  }
  for (const id of net.segmentsInRegion({ minX: minX - 20, minZ: minZ - 20, maxX: maxX + 20, maxZ: maxZ + 20 }, true)) {
    if (own.has(id)) continue;
    const def = net.roadTypeOf(id);
    if (footprintsClash(mine, segmentFootprint(net, id))) {
      problems.push(`The ${what} would overlap ${def.category === 'rail' ? 'other track' : 'a road'}`);
      break;
    }
  }
  return { problems, radius };
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

