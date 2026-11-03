/**
 * Shared data contract for Cloverleaf. Every module builds on these shapes.
 * See ARCHITECTURE.md for the conventions they rely on. Read it before editing.
 *
 * Persisted data (saved in a project file): Project and everything it reaches.
 * Derived data (rebuilt from persisted data, never saved): SegmentGeom,
 * NodeGeom, LaneGraph, GLane.
 */

import type { RailData } from './railTypes';

export type Id = number;

/** World position in metres. Y is up. Ground level is y = 0. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Road catalogue
// ---------------------------------------------------------------------------

export type LaneKind = 'drive' | 'bus' | 'bike' | 'rail';

export interface LaneDef {
  /**
   * Lateral centre from the road centreline. Positive = right of segment forward.
   * The pavement is centred on the curve, so on a road with more lanes one way
   * than the other the boundary between directions sits off the centreline.
   */
  offset: number;
  width: number;
  /** 1 = travels from segment.a to segment.b. -1 = travels b to a. */
  dir: 1 | -1;
  kind: LaneKind;
  /** This lane's own limit. Absent means the road's speed. */
  speedKmh?: number;
}

/** 'roundabout' is the one-way ring of a roundabout, placed only by the Roundabout tool. */
export type RoadCategory = 'street' | 'avenue' | 'oneway' | 'highway' | 'ramp' | 'custom' | 'rail' | 'roundabout';

export type MedianKind = 'none' | 'paint' | 'grass' | 'barrier';

export type LineStyle = 'none' | 'dashed' | 'solid' | 'double' | 'solidDashed' | 'dashedSolid' | 'dotted';
export type PaintColor = 'white' | 'yellow' | 'blue' | 'red' | 'green';
export type CrosswalkStyle = 'none' | 'zebra' | 'ladder' | 'lines';

export interface MarkingStyle {
  /** Line between opposing directions. Ignored on one-way roads. */
  centerLine: LineStyle;
  centerColor: PaintColor;
  /** Lines between lanes travelling the same way. */
  laneLine: LineStyle;
  laneColor: PaintColor;
  /** Lines along the outer edges of the carriageway. */
  edgeLine: LineStyle;
  edgeColor: PaintColor;
  /** Painted bar at the end of each lane approaching a junction. */
  stopLines: boolean;
  /** Painted turn arrows near the end of each lane, derived from its connectors. */
  turnArrows: boolean;
  /** Crosswalk painted across each end of the segment that meets a junction. */
  crosswalk: CrosswalkStyle;
  /** Per-boundary override of laneLine, keyed by the index of the left-hand lane. */
  boundaries?: Record<number, { style: LineStyle; color: PaintColor }>;
}

export interface RoadTypeDef {
  id: string;
  name: string;
  category: RoadCategory;
  /** Sorted left to right when looking along segment forward. */
  lanes: LaneDef[];
  /** Half the paved carriageway width, centreline to kerb or edge. */
  halfWidth: number;
  /** Sidewalk width, 0 for none. On an uneven road this is the wider side. */
  sidewalk: number;
  /** Set when the two sides differ. Read them with sidewalkOn. */
  sidewalkLeft?: number;
  sidewalkRight?: number;
  /** Paved shoulder width, included in halfWidth. On an uneven road, the wider side. */
  shoulder: number;
  /** `offset` is the median's centre from the road's centreline. Absent means 0. */
  median: { width: number; kind: MedianKind; offset?: number };
  speedKmh: number;
  /** Importance used for junction priority and for picking the main road. */
  rank: number;
  markings: MarkingStyle;
}

// ---------------------------------------------------------------------------
// Network (persisted)
// ---------------------------------------------------------------------------

export type SignKind = 'none' | 'yield' | 'stop' | 'priority';
export type TurnKind = 'left' | 'straight' | 'right' | 'uturn';

/** How a junction resolves right of way. 'auto' lets core pick from road ranks. */
export type JunctionMode = 'auto' | 'priority' | 'allStop' | 'signal';

/** Key of a movement through a junction: `${fromSegmentId}>${toSegmentId}`. */
export type MovementKey = string;

/**
 * 'protected' has right of way. 'permissive' may go but must yield to protected
 * movements it crosses, as with a left turn on a shared green.
 */
export type MovementState = 'protected' | 'permissive';

export interface SignalPhase {
  id: Id;
  name: string;
  greenSec: number;
  yellowSec: number;
  allRedSec: number;
  /** Used in actuated mode only. */
  minGreenSec: number;
  maxGreenSec: number;
  /** Movements not listed are red for this phase. */
  moves: Record<MovementKey, MovementState>;
}

export interface SignalPlan {
  /** 'fixed' runs phases on the clock. 'actuated' extends or skips them on demand. */
  kind: 'fixed' | 'actuated';
  offsetSec: number;
  phases: SignalPhase[];
}

/**
 * A point on the cut line of one arm of a node. The arm's boundaries are the road
 * edges and lane edges in order, left to right along segment a-to-b, so an anchor
 * follows its road when the road moves.
 */
export interface MarkingAnchor {
  segmentId: Id;
  boundary: number;
  /**
   * When set, the anchor is on the junction's outline instead: this fraction of the
   * way along the kerb from this arm's left edge to the next arm's right edge,
   * clockwise, so 0 and 1 are those two road edges. `boundary` is then unused.
   */
  corner?: number;
  /** Metres back along the arm from its cut line, for lines laid across the road. */
  back?: number;
}

export type NodeLineStyle =
  | 'solid'
  | 'dashed'
  | 'double'
  | 'solidDashed'
  | 'dotted'
  | 'stopLine'
  | 'crosswalkZebra'
  | 'crosswalkLadder'
  | 'crosswalkLines';

export type NodeFillStyle = 'solid' | 'hatch' | 'chevron';

/** A painted line between two anchors. */
export interface NodeLineMarking {
  id: Id;
  kind: 'line';
  from: MarkingAnchor;
  to: MarkingAnchor;
  style: NodeLineStyle;
  color: PaintColor;
  /** Line thickness, or the depth of a crosswalk. */
  width: number;
  /** True draws a chord. False draws a curve tangent to the lanes at both ends. */
  straight: boolean;
  /**
   * 'outline' runs along the junction's kerb between two outline anchors. 'lanes'
   * follows the lane paths through the junction between the two arms. Absent uses
   * `straight`.
   */
  path?: 'outline' | 'lanes';
}

/** An area enclosed by three or more anchors. */
export interface NodeFillerMarking {
  id: Id;
  kind: 'filler';
  anchors: MarkingAnchor[];
  fill: NodeFillStyle;
  color: PaintColor;
  /** Stripe thickness of hatch and chevron. */
  width: number;
}

export type NodeMarking = NodeLineMarking | NodeFillerMarking;

/** A user-specified lane link. `${segmentId}:${laneIndex}` on both sides. */
export interface LaneLink {
  from: string;
  to: string;
}

export interface JunctionControl {
  mode: JunctionMode;
  /** Per incoming segment. Absent means 'none'. */
  signs: Record<number, SignKind>;
  signal: SignalPlan | null;
  /** When set, replaces auto-generated connectors at this node entirely. */
  laneLinks: LaneLink[] | null;
  /** Per segment crosswalk override. Absent means use the segment's markings. */
  crosswalks: Record<number, CrosswalkStyle>;
  /** Markings placed by hand at this node. Absent means none. */
  markings?: NodeMarking[];
  /** Hide the automatic stop lines, yield teeth and crosswalks at this node. */
  hideAutoMarkings?: boolean;
}

export interface RoadNode {
  id: Id;
  pos: Vec3;
  /** Kept in sync by RoadNetwork. Do not mutate directly. */
  segments: Id[];
  control: JunctionControl;
}

export interface SegmentOverrides {
  speedKmh?: number;
  markings?: Partial<MarkingStyle>;
  /** Per lane index: restrict to a kind other than the catalogue's. */
  laneKinds?: Record<number, LaneKind>;
  /** Per lane index: a limit in km/h that beats every other speed for that lane. */
  laneSpeeds?: Record<number, number>;
  surface?: 'asphalt' | 'concrete' | 'darkAsphalt' | 'red' | 'gravel';
  name?: string;
  /**
   * The a or b end leaves from, or joins, the side of another road at its node
   * instead of its centreline, as a ramp does on a highway. See core/ramps.ts.
   */
  attachA?: RampAttach;
  attachB?: RampAttach;
}

/**
 * Where a ramp end sits on the road it leaves or joins (the host). The end of the
 * ramp's curve is moved to the outer edge of the host's carriageway on the ramp's
 * side, and the host's outermost `lane + 1` lanes feed (or take) the ramp.
 */
export interface RampAttach {
  /** Lanes counted in from the host's outer edge on the ramp's side: 0 is the outermost. */
  lane: number;
  /** Which side of the ramp the host lies on, looking along the ramp's a to b. */
  hostSide: 1 | -1;
}

/**
 * A cubic Bezier from node a to node b. P0 = nodes[a].pos, P3 = nodes[b].pos,
 * c1 and c2 are absolute world positions.
 */
export interface Segment {
  id: Id;
  a: Id;
  b: Id;
  c1: Vec3;
  c2: Vec3;
  roadType: string;
  overrides: SegmentOverrides;
}

export type EndpointKind = 'gateway' | 'residential' | 'commercial' | 'industrial' | 'office';

export interface VehicleMix {
  car: number;
  van: number;
  truck: number;
  bus: number;
}

/**
 * Where traffic is born and dies. A gateway sits on a dead-end node. The other
 * kinds are zones attached to the side of a segment, drawn as a building block.
 */
export interface TrafficEndpoint {
  id: Id;
  kind: EndpointKind;
  name: string;
  enabled: boolean;
  /** Gateway: the dead-end node. Otherwise null. */
  nodeId: Id | null;
  /** Zone: the segment it fronts, position along it, and side (1 = right). */
  segmentId: Id | null;
  t: number;
  side: 1 | -1;
  /** Vehicles per hour generated at 100% traffic. */
  ratePerHour: number;
  /** Relative pull as a destination. */
  attraction: number;
  mix: VehicleMix;
  /** Set on the access points of a zoned region. The region owns them. */
  regionId?: Id;
}

export type DecalKind =
  | 'line'
  | 'dashedLine'
  | 'doubleLine'
  | 'hatch'
  | 'fill'
  | 'crosswalk'
  | 'stopLine'
  | 'yieldTriangles'
  | 'arrowStraight'
  | 'arrowLeft'
  | 'arrowRight'
  | 'arrowStraightLeft'
  | 'arrowStraightRight'
  | 'text';

/**
 * One stretch of a road. t0 and t1 are curve parameters in walking order, so t0
 * above t1 walks the segment b to a. A value of 0 or 1 means the end of the road's
 * visible span, which is a junction's edge wherever that edge happens to be.
 */
export interface RoadPaintPiece {
  segmentId: Id;
  t0: number;
  t1: number;
}

/** Where paint sits on a road. Nothing here is a world position. */
export interface RoadPaintRef {
  /** In walking order. A stamp has one piece with t0 equal to t1. */
  pieces: RoadPaintPiece[];
  /** Metres right of the walking direction. A stamp measures along a-to-b. */
  offset: number;
  /** The second side of an area, or the far end of a stamp laid across a lane. */
  offset2?: number;
  /** Stamps: 1 faces along a-to-b, -1 faces b-to-a. */
  dir?: 1 | -1;
}

/** Paint on the road surface, placed with the Paint tool. */
export interface Decal {
  id: Id;
  kind: DecalKind;
  /**
   * World points, used when `road` is absent, as in older saves. Lines: the
   * polyline. Fill and hatch: the polygon. Stamps: one point.
   */
  points: Vec3[];
  /** Set on paint that follows a road. Read positions through resolveDecal. */
  road?: RoadPaintRef;
  /** The strokes of a line, beating what `kind` implies. */
  lineStyle?: LineStyle;
  color: PaintColor;
  width: number;
  /** Stamps and text only, radians about +Y. */
  rotation: number;
  text?: string;
}

export interface TrafficSettings {
  /** 1 = 100%. Slider runs 0 to 4. */
  multiplier: number;
  /** Treat dead-end nodes without an endpoint as gateways. */
  autoGateways: boolean;
  autoGatewayRatePerLane: number;
  /** Remove vehicles stuck for this long. 0 disables. */
  despawnStuckSec: number;
  defaultMix: VehicleMix;
}

export interface Project {
  version: 1;
  name: string;
  nextId: Id;
  nodes: RoadNode[];
  segments: Segment[];
  endpoints: TrafficEndpoint[];
  decals: Decal[];
  customRoadTypes: RoadTypeDef[];
  traffic: TrafficSettings;
  /** Stations and train lines. Absent until the first one is placed. */
  rail?: RailData;
  /** Zoned areas, later ones on top. Absent until the first one is placed. */
  zones?: ZoneRegion[];
}

export type ZoneKind = 'residential' | 'commercial' | 'industrial' | 'office';
export type ZoneDensity = 'low' | 'medium' | 'high';

/** A region corner held to a road: a point at a lateral offset from the curve at t. */
export interface ZoneAnchor {
  segmentId: Id;
  t: number;
  /** Metres right of a-to-b, from the centreline. */
  offset: number;
}

export interface ZoneSettings {
  /** Frontage depth from the road edge. */
  depth: number;
  /** Gap kept from the road edge. */
  setback: number;
  snap: boolean;
  snapDistance: number;
  /** Highways, ramps and rail neither front a zone nor give it access. */
  excludeFast: boolean;
}

/**
 * A zoned area. Later regions win where they overlap, and roads, water and the map
 * edge always cut a region, so the area really zoned is worked out, not stored.
 * Kind 'none' is a Dezone eraser.
 */
export interface ZoneRegion {
  id: Id;
  kind: ZoneKind | 'none';
  density: ZoneDensity;
  enabled: boolean;
  name: string;
  /** Plan polygon. Corners with an anchor follow their road; these are fallbacks. */
  polygon: Vec3[];
  /** Same length as polygon when present. */
  anchors?: (ZoneAnchor | null)[];
  source: 'block' | 'frontage' | 'shape';
  settings: ZoneSettings;
}

// ---------------------------------------------------------------------------
// Derived geometry (rebuilt, never saved)
// ---------------------------------------------------------------------------

/** One station along a segment. Tangent always points from a to b. */
export interface Station {
  pos: Vec3;
  tangent: Vec3;
  /** Unit vector right of tangent: (-tangent.z, 0, tangent.x), normalised. */
  right: Vec3;
  /** Arc length from node a along the full untrimmed curve. */
  s: number;
  t: number;
}

export interface SegmentGeom {
  segmentId: Id;
  /** Stations for the visible, trimmed span, ordered a to b. */
  stations: Station[];
  /** Length of the full untrimmed curve. */
  fullLength: number;
  /** Arc length cut off at each end by junctions. */
  trimA: number;
  trimB: number;
  /** Trimmed length, fullLength - trimA - trimB. */
  length: number;
  /** False when the trims leave nothing, or a bend is too tight for the road. */
  valid: boolean;
  /** Tightest plan-view radius within the visible span. Infinity when straight. */
  minRadius: number;
}

/** One road end meeting a node. */
export interface NodeArm {
  segmentId: Id;
  /** True when the segment leaves this node at its a end. */
  atStart: boolean;
  /** Unit horizontal direction pointing away from the node. */
  dir: Vec3;
  /** Road edge points where the arm is cut. Left and right as seen looking at the node. */
  leftEdge: Vec3;
  rightEdge: Vec3;
  centre: Vec3;
  /** Unit horizontal direction away from the node at the cut. Differs from dir on a bend. */
  cutDir: Vec3;
  /** Arc length cut off this end. Same as the SegmentGeom trim. */
  trim: number;
}

export interface NodeGeom {
  nodeId: Id;
  /** Sorted clockwise when viewed from above. */
  arms: NodeArm[];
  /**
   * Outline of the junction surface along the carriageway edges, wound clockwise
   * viewed from above. Empty for a plain joint and a dead end. Y is interpolated
   * between the arms, so the polygon is not planar on a sloped node.
   */
  outline: Vec3[];
  /** Same outline taken along the outer edge of the sidewalks. */
  outerOutline: Vec3[];
  /**
   * True when the curved outline crossed itself, so a convex hull of it is used
   * instead. It happens on extreme layouts. The polygon is still simple, but the
   * rounded corners and gores are gone.
   */
  outlineSimplified: boolean;
  /** True for a smooth two-road joint needing no junction surface. */
  isPlainJoint: boolean;
  /** Arms of the node: 0 orphan, 1 dead end, 2+ joint or junction. */
  kind: 'empty' | 'deadEnd' | 'plain' | 'junction';
}

// ---------------------------------------------------------------------------
// Lane graph (rebuilt, never saved). What the simulation drives on.
// ---------------------------------------------------------------------------

export interface LaneConflict {
  /** Dense lane index of the other connector. */
  lane: number;
  /**
   * Distance along this lane to the conflict point. cross: where the paths cross.
   * merge: where the paths first come within a lane width of each other.
   * diverge: where the paths finish separating, measured from the shared start.
   */
  selfS: number;
  /** Distance along the other lane to the conflict point. */
  otherS: number;
  /** cross = paths cross. merge = same exit. diverge = same entry. */
  kind: 'cross' | 'merge' | 'diverge';
}

export interface GLane {
  /** Dense index into LaneGraph.lanes. Valid for this graph build only. */
  idx: number;
  /**
   * Stable across rebuilds, used to carry vehicles over an edit.
   * Road lane: `r${segmentId}:${laneIndex}`.
   * Connector: `c${nodeId}:${fromSeg}.${fromLane}>${toSeg}.${toLane}`.
   */
  key: string;
  kind: 'road' | 'connector';
  /** Road lanes only, else -1. */
  segmentId: Id;
  laneIndex: number;
  /** Connector only, else -1. */
  nodeId: Id;
  /** Connector only: dense indices of the feeding and receiving road lanes. */
  fromLane: number;
  toLane: number;
  turn: TurnKind | null;
  /** Flat [x, y, z, ...] in direction of travel. */
  pts: Float32Array;
  /** Cumulative arc length at each point, same count as pts / 3. */
  cum: Float32Array;
  length: number;
  /** Metres per second. */
  speed: number;
  vehicleKind: LaneKind;
  width: number;
  next: number[];
  prev: number[];
  /** Adjacent same-direction lane on each side, or -1. Road lanes only. */
  left: number;
  right: number;
  /** Connector only. */
  conflicts: LaneConflict[];
}

export interface LaneGraph {
  lanes: GLane[];
  byKey: Map<string, number>;
  /** Connectors grouped by node. */
  connectorsAt: Map<Id, number[]>;
  /** Road lanes grouped by segment, indexed by lane index. */
  roadLanes: Map<Id, number[]>;
  /** Bumped on every rebuild. */
  version: number;
}
