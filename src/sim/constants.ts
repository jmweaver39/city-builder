/** Tunables of the simulation. Metres, seconds, m/s. */

export const DT = 0.1;
/** Longest real time handed to one advance(), so a stalled tab cannot spiral. */
export const MAX_FRAME_DT = 0.25;

/** Hardest braking ever applied. */
export const MAX_DECEL = 9;
/** Comfortable deceleration used when planning for speed limits ahead. */
export const PLAN_DECEL = 2;
/** Lateral acceleration a driver accepts on a bend. */
export const CURVE_LATERAL_ACCEL = 2.6;
export const MIN_CURVE_SPEED = 3;
/** Junction turns are taken a little harder than road bends. */
export const CONNECTOR_LATERAL_ACCEL = 3.5;
/** Arc over which a bend is measured, on roads and through junctions. */
export const ROAD_CHORD = 3;
export const CONNECTOR_CHORD = 5;
/** Spacing of the per-lane speed profile. */
export const PROFILE_STEP = 4;

/** Rest position in front of a stop line: IDM stops about this far before it. */
export const STOP_GAP_BONUS = 1.5;
export const CLEAR_MARGIN = 0.05;

// Routing
export const LANE_CHANGE_COST_SEC = 3;
export const TABLE_REFRESH_SEC = 30;
export const SIGNAL_DELAY_SEC = 7;
export const STOP_DELAY_SEC = 6;
export const YIELD_DELAY_SEC = 2;
/** Upper bound of the per-vehicle route noise, as a fraction of the cost. */
export const ROUTE_NOISE = 0.08;
export const STRATEGIC_PERIOD_STEPS = 10;
export const STRATEGIC_MAX_HOPS = 14;
export const STRATEGIC_MAX_DIST = 1500;
/** A next lane stays locked this close to the end of a lane. */
export const NEXT_LOCK_DIST = 70;

// Lane changes
/**
 * A lane change takes road, not time: at least this many seconds of it at speed, and
 * at least this much distance when slow, so a truck cannot slide sideways in a queue.
 */
export const LANE_CHANGE_SEC = 2.5;
export const LANE_CHANGE_BASE_DIST = 16;
export const LANE_CHANGE_BODY_DISTS = 3;
export const LANE_CHANGE_COOLDOWN = 4;
export const DISCRETIONARY_PERIOD_STEPS = 20;
export const MANDATORY_PERIOD_STEPS = 2;
/** Stuck behind a must-take lane change this long, the vehicle gives up on it. */
export const MUST_TAKE_PATIENCE_SEC = 6;
export const MUST_TAKE_LAST_STRETCH = 30;

// Junctions
/** Half length of the zone around a crossing point. */
export const CROSS_MARGIN = 3;
/** Time between one vehicle clearing a crossing and the next reaching it. */
export const CROSS_HEADWAY = 0.7;
/** The same when merging in front of a vehicle with priority. */
export const MERGE_HEADWAY = 1.2;
/** Waiting this long at a give-way line earns a courtesy gap from the main road. */
export const COURTESY_WAIT_SEC = 15;
/** The same with a long queue behind: in heavy traffic drivers take turns. */
export const COURTESY_WAIT_QUEUED_SEC = 8;
export const COURTESY_QUEUE_LENGTH = 5;
export const STOP_SIGN_HOLD_SEC = 0.6;
/** Vehicles within this distance of the line and slower than this count as stopped. */
export const STOPPED_DIST = 6;
export const STOPPED_SPEED = 1.5;
/** Exit lanes moving faster than this are not a reason to wait at a line. */
export const EXIT_MOVING_SPEED = 2.5;
export const FREE_MERGE_HORIZON = 140;

// Stats
export const EMA_PERIOD_STEPS = 20;
export const HISTORY_PERIOD_SEC = 60;
export const HISTORY_MAX = 240;
export const FLOW_WINDOW_SEC = 60;
export const THROUGHPUT_WINDOW_SEC = 300;

/** Waiting vehicles a source remembers. */
export const SOURCE_QUEUE_CAP = 400;

/** Share of a source's traffic that rides, where a bike lane leads anywhere. */
export const BIKE_SHARE = 0.05;
/** Seconds a stopped driver will hold back for someone asking to change lanes. */
export const YIELD_PATIENCE_SEC = 6;
/** Overlaps only matter between vehicles this close in height, metres. */
export const OVERLAP_HEADROOM = 2.5;
/** Vehicles at least this long swing their bodies wide enough for sweep conflicts. */
export const LONG_BODY = 8;
