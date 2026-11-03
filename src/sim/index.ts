/** Public surface of the simulation. */
export * from './api';
export { Simulation } from './Simulation';
export { DT as SIM_STEP } from './constants';
export { VEHICLE_PARAMS, type VehicleParams } from './vehicleTypes';
export { boxesOverlap } from './safety';
