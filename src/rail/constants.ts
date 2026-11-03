/** Shared numbers for the rail simulation. Metres, seconds, kilograms. */

/** Fixed step of the train simulation. */
export const RAIL_DT = 0.1;
/** Top of the rail above the lane height. Render adds it, the sim works on the lane. */
export const RAIL_TOP = 0.24;
/** Target length of a signal block on open track. */
export const BLOCK_LENGTH = 320;
/** A piece of track shorter than this is not worth a block of its own. */
export const MIN_PIECE = 40;
/** Two tracks closer than this cannot both hold a train. Bodies are 3.2 m wide at most. */
export const FOUL_DISTANCE = 4;
/** Height gap above which two tracks do not foul each other. */
export const FOUL_HEADROOM = 4.5;
/** Length of each diagonal of a scissors crossover. */
export const CROSSOVER_LENGTH = 60;
/** Clear track between a platform end and its crossover. */
export const CROSSOVER_GAP = 12;
/** Limit through a turnout or crossover, m/s. */
export const SWITCH_SPEED = 40 / 3.6;
/** Comfortable lateral acceleration on canted plain track. */
export const CURVE_ACCEL = 1.8;
/** Trains stop this far short of the end of their movement authority. */
export const SIGNAL_MARGIN = 14;
/** Trains stop this far short of the end of the track. */
export const BUFFER_GAP = 6;
export const G = 9.81;
