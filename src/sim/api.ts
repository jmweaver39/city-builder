/**
 * Public contract of the simulation, used by render, tools and ui.
 * The sim team implements this. Add to it freely, but do not rename or change
 * what is here without updating every consumer.
 */
import type { Id, Vec3 } from '../core/types';

export const VEHICLE_TYPES = ['car', 'van', 'truck', 'bus', 'bike'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/**
 * Render-ready vehicle state, in slots 0..count-1 packed with no gaps. Written
 * once per sim step, so read it freely without allocating. Slots move when
 * vehicles leave, so use `id` to track one vehicle across frames.
 */
export interface VehicleView {
  count: number;
  capacity: number;
  /** Stable for the vehicle's lifetime. */
  id: Int32Array;
  /** VEHICLE_TYPES index. */
  type: Uint8Array;
  /** Index into a body colour palette, 0 to 15. */
  color: Uint8Array;
  /** 1 while decelerating hard enough to show brake lights. */
  braking: Uint8Array;
  /** -1 left, 0 off, 1 right. */
  blinker: Int8Array;
  /** Metres per second. */
  speed: Float32Array;
  /** Previous and current step, for interpolation by renderAlpha. */
  prevX: Float32Array;
  prevY: Float32Array;
  prevZ: Float32Array;
  prevYaw: Float32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Radians about +Y. A vehicle at yaw 0 faces -Z, the Three.js default forward. */
  yaw: Float32Array;
  /** Radians, positive nose up. */
  pitch: Float32Array;
}

export type LightState = 'red' | 'yellow' | 'green' | 'off';

/** One signal head to draw, at the stop line of one incoming lane. */
export interface SignalHead {
  nodeId: Id;
  segmentId: Id;
  laneIndex: number;
  /** World position of the stop line centre for this lane. */
  pos: Vec3;
  /** Unit horizontal direction drivers are facing. */
  facing: Vec3;
  state: LightState;
}

export interface SegmentTraffic {
  /** Smoothed mean speed as a fraction of the limit, 0 to 1. 1 if empty. */
  speedRatio: number;
  /** Vehicles per hour over the recent window, both directions. */
  flowPerHour: number;
  count: number;
}

export interface SimStats {
  active: number;
  spawnedTotal: number;
  arrivedTotal: number;
  despawnedStuck: number;
  /** Arrivals per hour over the recent window. */
  throughputPerHour: number;
  /** Mean speed as a fraction of the limit, 0 to 1. Skylines-style flow score. */
  flow: number;
  meanSpeedKmh: number;
  meanTripSec: number;
  /** Count of vehicles below 15% of the limit. */
  jammed: number;
  /** Per-step wall time, for the performance readout. */
  stepMs: number;
  /** Removed because an edit took away the lane under them. */
  removedByEdit?: number;
  /** Removed at a dead end with no destination left to reach. */
  removedUnroutable?: number;
  /** Given a new destination because theirs became unreachable. */
  retargeted?: number;
  /** Gave up on a must-take lane change and went somewhere else. */
  missedExits?: number;
  /** Vehicles stopped dead at a line they could not brake for. Should stay near 0. */
  forcedStops?: number;
  /**
   * Vehicle pairs whose real footprints overlapped after the safety pass, counted each
   * step. Always measured. It must be 0: anything else is a bug.
   */
  collisions?: number;
  /**
   * Times the safety pass had to stop a vehicle to prevent an overlap. Each is a near
   * miss the normal driving logic did not avoid, so this should stay low.
   */
  safetyStops?: number;
  /** Waiting to spawn because the road at their source is full. */
  queuedAtSources?: number;
}

/** Counts for one traffic endpoint since the last reset. */
export interface EndpointStats {
  spawned: number;
  arrived: number;
  /** Vehicles that set out for this endpoint. */
  destined: number;
  /** Waiting to spawn here now. */
  queued: number;
}

export interface VehicleDetail {
  id: number;
  type: VehicleType;
  speedKmh: number;
  from: string;
  to: string;
  ageSec: number;
  /** Road ahead to the destination as a polyline. Allocates, call on demand. */
  route: Vec3[];
}

export interface SignalPhaseStatus {
  phaseIndex: number;
  /** 'green', 'yellow', 'allRed'. */
  stage: string;
  remainingSec: number;
}

export interface SimApi {
  /** 0 pauses. Otherwise 1, 2 or 4. */
  speed: number;
  /** Simulated seconds since start. */
  readonly time: number;
  /** 0 to 1 between the last two steps. Renderer uses it to interpolate. */
  readonly renderAlpha: number;
  readonly vehicles: VehicleView;
  /** Call each frame with real seconds. Runs zero or more fixed steps. */
  advance(realDt: number): void;
  /** Run exactly one fixed step, for headless tests. */
  step(): void;
  reset(): void;
  stats(): SimStats;
  segmentTraffic(id: Id): SegmentTraffic;
  /** Reused array, valid until the next call. */
  signalHeads(): readonly SignalHead[];
  signalStatus(nodeId: Id): SignalPhaseStatus | null;
  vehicleDetail(id: number): VehicleDetail | null;
  /** Unit-per-hour hourly history of throughput for the stats graph. */
  history(): readonly { time: number; throughput: number; flow: number; active: number }[];
  /** Counts for one endpoint, or null if it has seen no traffic. */
  endpointStats?(id: Id): EndpointStats | null;
  /** The light governing a connector (dense lane index), 'off' when unsignalled. */
  connectorLight?(lane: number): LightState;
  /**
   * Close or reopen a road lane or connector (dense lane index), as for a level
   * crossing. Vehicles stop before it as at a red light and may not enter; those
   * already on it drive off. A closure survives graph rebuilds, tracked by lane key.
   */
  blockConflict?(lane: number, blocked: boolean): void;
  /**
   * Make vehicles that stop at the end of this road lane (dense lane index), for a red
   * light, a sign or a closure, stop this many metres short of it, as before a
   * crosswalk. Only applied when the driver can still stop comfortably short of it;
   * 0 clears. Survives graph rebuilds, tracked by lane key. Used by src/peds.
   */
  setStopBack?(lane: number, metres: number): void;
}
