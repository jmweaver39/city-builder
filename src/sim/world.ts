/** The state shared by the simulation's subsystems. */
import type { RoadNetwork } from '../core';
import type { Buckets } from './buckets';
import type { CompiledGraph } from './compiled';
import type { JunctionSystem } from './junctions';
import type { Rng } from './rng';
import type { Routing } from './routing';
import type { SignalSystem } from './signals';
import type { VehicleStore } from './vehicles';

export interface Counters {
  spawned: number;
  arrived: number;
  despawnedStuck: number;
  /** Removed because an edit took their lane away. */
  removedByEdit: number;
  /** Removed at a dead end with nowhere left to go. */
  removedUnroutable: number;
  /** Destination changed because it stopped being reachable. */
  retargeted: number;
  /** Gave up on a must-take lane change and continued elsewhere. */
  missedExits: number;
  /**
   * Times a vehicle was stopped dead at a line it had no permit for: a last resort
   * that should almost never happen, because braking for the line normally does it.
   */
  forcedStops: number;
  /** Footprint overlaps left after the safety pass. Must stay 0. */
  collisions: number;
  /** Vehicles the safety pass stopped to prevent an overlap. */
  safetyStops: number;
  tripSecSum: number;
}

export function emptyCounters(): Counters {
  return {
    spawned: 0,
    arrived: 0,
    despawnedStuck: 0,
    removedByEdit: 0,
    removedUnroutable: 0,
    retargeted: 0,
    missedExits: 0,
    forcedStops: 0,
    collisions: 0,
    safetyStops: 0,
    tripSecSum: 0,
  };
}

export interface World {
  net: RoadNetwork;
  g: CompiledGraph;
  veh: VehicleStore;
  bk: Buckets;
  routes: Routing;
  jn: JunctionSystem;
  sig: SignalSystem;
  rng: Rng;
  /** 1 for lanes closed from outside, as by a level crossing. */
  blocked: Uint8Array;
  /** Metres short of a road lane's end to stop, as before a crosswalk. See SimApi.setStopBack. */
  stopBack?: Float32Array;
  tick: number;
  time: number;
  counters: Counters;
}
