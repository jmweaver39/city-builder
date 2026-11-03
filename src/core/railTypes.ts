/**
 * Track catalogue and the persisted shapes of stations and lines. Track is a road
 * type of category 'rail', so it gets curves, elevation, snapping, bridges, tunnels,
 * junctions, undo and save from the road system. The trains live in src/rail.
 *
 * A single track is one physical pair of rails used both ways. The lane graph is
 * directional, so it has two coincident lanes, one per direction, a hair either
 * side of the centreline. src/rail folds them back into one track.
 */
import type { Id, MarkingStyle, RoadCategory, RoadTypeDef } from './types';

export type TrainTypeId = 'metro' | 'emu' | 'intercity' | 'highspeed' | 'freight';

export type RailStationKind = 'surface' | 'underground' | 'gateway';

/** A place trains stop. Anchored like a zone: a segment and a position along it. */
export interface RailStation {
  id: Id;
  name: string;
  kind: RailStationKind;
  segmentId: Id;
  /** Bezier parameter of the platform centre on the segment. */
  t: number;
  /** Metres of platform, centred on the anchor. 0 for a gateway. */
  platformLength: number;
}

export interface RailLine {
  id: Id;
  name: string;
  /** CSS hex colour. */
  color: string;
  /** Station ids in running order. Out and back along them. */
  stops: Id[];
  trainType: TrainTypeId;
  /** Vehicles per train. */
  cars: number;
  /** Trains to keep running. */
  trains: number;
  /** Minimum seconds between dispatches. Absent means an even spread. */
  headwaySec?: number;
  /** Hidden lines keep running but drop out of the overlay. */
  hidden?: boolean;
}

export interface RailData {
  stations: RailStation[];
  lines: RailLine[];
}

export const RAIL_CATEGORY: RoadCategory = 'rail';

/** What a track type allows and how it is built. */
export interface TrackSpec {
  /** Smallest plan-view radius in metres. */
  minRadius: number;
  /** Largest grade, as a fraction. */
  maxGrade: number;
  metro: boolean;
  /** Overhead wires. */
  electrified: boolean;
  thirdRail: boolean;
  /** Double track has its tracks this far either side of the centreline. */
  trackOffset: number;
}

const NO_PAINT: MarkingStyle = {
  centerLine: 'none',
  centerColor: 'white',
  laneLine: 'none',
  laneColor: 'white',
  edgeLine: 'none',
  edgeColor: 'white',
  stopLines: false,
  turnArrows: false,
  crosswalk: 'none',
};

/** Half the gap between the coincident lanes of a single track. */
const COINCIDENT = 0.001;
const RAIL_RANK = 0;
/** Lanes on double track are nominal widths, the gauge plus clearance. */
const TRACK_LANE_WIDTH = 3.2;

function singleTrack(id: string, name: string, speedKmh: number, halfWidth: number): RoadTypeDef {
  const w = COINCIDENT * 2;
  return {
    id,
    name,
    category: 'rail',
    lanes: [
      { offset: -COINCIDENT, width: w, dir: -1, kind: 'rail' },
      { offset: COINCIDENT, width: w, dir: 1, kind: 'rail' },
    ],
    halfWidth,
    sidewalk: 0,
    shoulder: halfWidth - w,
    median: { width: 0, kind: 'none' },
    speedKmh,
    rank: RAIL_RANK,
    markings: { ...NO_PAINT },
  };
}

function doubleTrack(id: string, name: string, speedKmh: number, offset: number, halfWidth: number): RoadTypeDef {
  return {
    id,
    name,
    category: 'rail',
    lanes: [
      { offset: -offset, width: TRACK_LANE_WIDTH, dir: -1, kind: 'rail' },
      { offset, width: TRACK_LANE_WIDTH, dir: 1, kind: 'rail' },
    ],
    halfWidth,
    sidewalk: 0,
    shoulder: halfWidth - (offset + TRACK_LANE_WIDTH / 2),
    median: { width: 0, kind: 'none' },
    speedKmh,
    rank: RAIL_RANK,
    markings: { ...NO_PAINT },
  };
}

export const RAIL_ROAD_TYPES: readonly RoadTypeDef[] = [
  singleTrack('rail-single', 'Single track', 120, 2.6),
  doubleTrack('rail-double', 'Double track', 160, 2.25, 4.85),
  singleTrack('metro-single', 'Metro single', 80, 2.3),
  doubleTrack('metro-double', 'Metro double', 80, 2.2, 4.3),
  doubleTrack('hsr-double', 'High-speed double', 300, 2.5, 5.1),
];

const SPECS: Record<string, TrackSpec> = {
  'rail-single': { minRadius: 150, maxGrade: 0.025, metro: false, electrified: true, thirdRail: false, trackOffset: 0 },
  'rail-double': { minRadius: 150, maxGrade: 0.025, metro: false, electrified: true, thirdRail: false, trackOffset: 2.25 },
  'metro-single': { minRadius: 80, maxGrade: 0.04, metro: true, electrified: false, thirdRail: true, trackOffset: 0 },
  'metro-double': { minRadius: 80, maxGrade: 0.04, metro: true, electrified: false, thirdRail: true, trackOffset: 2.2 },
  'hsr-double': { minRadius: 600, maxGrade: 0.025, metro: false, electrified: true, thirdRail: false, trackOffset: 2.5 },
};

export function isRailDef(def: RoadTypeDef): boolean {
  return def.category === 'rail';
}

/** The rules of a track type. Undefined for anything that is not track. */
export function trackSpec(id: string): TrackSpec | undefined {
  return SPECS[id];
}

/** Tracks on a segment of this type, as offsets from the centreline, left to right. */
export function trackOffsets(def: RoadTypeDef): number[] {
  const spec = SPECS[def.id];
  if (!spec) return [];
  return spec.trackOffset > 0 ? [-spec.trackOffset, spec.trackOffset] : [0];
}

/** The track (index into trackOffsets) a rail lane runs on. */
export function trackOfLane(def: RoadTypeDef, laneIndex: number): number {
  return (SPECS[def.id]?.trackOffset ?? 0) > 0 ? laneIndex : 0;
}
