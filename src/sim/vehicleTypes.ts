import type { VehicleType } from './api';

export interface VehicleParams {
  length: number;
  /** Body width, for the real footprint. */
  width: number;
  /** Comfortable acceleration. */
  accel: number;
  /** Comfortable deceleration. */
  decel: number;
  /** Desired time headway. */
  headway: number;
  /** Bumper-to-bumper gap at rest. */
  minGap: number;
  /** Top speed, whatever the limit. */
  maxSpeed: number;
}

/** Indexed by VEHICLE_TYPES. */
export const VEHICLE_PARAMS: readonly VehicleParams[] = [
  { length: 4.5, width: 1.8, accel: 2.2, decel: 3.0, headway: 1.15, minGap: 2, maxSpeed: 50 },
  { length: 5.5, width: 2, accel: 1.9, decel: 2.9, headway: 1.25, minGap: 2, maxSpeed: 42 },
  { length: 12, width: 2.4, accel: 1.1, decel: 2.6, headway: 1.5, minGap: 2.5, maxSpeed: 25 },
  { length: 12, width: 2.4, accel: 1.3, decel: 2.6, headway: 1.4, minGap: 2.5, maxSpeed: 27 },
  { length: 1.8, width: 0.7, accel: 1, decel: 2, headway: 1, minGap: 1, maxSpeed: 5.6 },
];

export const TYPE_CAR = 0;
export const TYPE_VAN = 1;
export const TYPE_TRUCK = 2;
export const TYPE_BUS = 3;
export const TYPE_BIKE = 4;

export type { VehicleType };
