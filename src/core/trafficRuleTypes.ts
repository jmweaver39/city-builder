/**
 * Persisted shapes of the traffic rules (core/trafficRules.ts): lane arrows,
 * junction restrictions per arm, and vehicle bans per lane. Everything is
 * optional and keyed by reference (segment ids and lane indices), so saves
 * without rules load unchanged and rules survive split, reverse and save.
 */
import type { TurnKind } from './types';

/** Who a lane can be closed to. 'emergency' is kept for when emergency vehicles exist; it has no effect yet. */
export type VehicleClass = 'car' | 'van' | 'truck' | 'bus' | 'bike' | 'emergency';

export const VEHICLE_CLASSES: readonly VehicleClass[] = ['car', 'van', 'truck', 'bus', 'bike'];

/**
 * Junction restrictions for traffic arriving on one arm. Absent fields take the
 * default, given beside each, so an empty object changes nothing.
 */
export interface ArmRules {
  /** U-turns from the innermost lane back along this arm. Default: off, except at a dead end. */
  uturn?: boolean;
  /** Going straight, a vehicle may end in a lane next to the one it lines up with. Default off. */
  laneChange?: boolean;
  /** Enter even when the exit is full, overriding don't-block-the-box. Default off. */
  enterBlocked?: boolean;
  /** People cross this arm. False removes the crosswalk and keeps people off it. Default on. */
  pedestrians?: boolean;
  /** At a red light, turn into the near side (right) after stopping. Default off. */
  nearTurnOnRed?: boolean;
  /** At a red light, turn across to the far side (left) after stopping, one-way to one-way. Default off. */
  farTurnOnRed?: boolean;
}

export type ArmRuleKey = keyof ArmRules;

export interface JunctionRules {
  /** Keyed by the arm's segment id. */
  arms?: Record<number, ArmRules>;
  /**
   * Turns allowed from one arriving lane, keyed `${segmentId}:${laneIndex}` as lane
   * links are. A lane not listed keeps its automatic turns. Never empty.
   */
  laneArrows?: Record<string, TurnKind[]>;
}
