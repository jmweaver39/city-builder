/**
 * RoadNetwork owns the Project. All edits go through its methods.
 *
 * Reads of derived data (geometry, lane graph) are always valid. Edits mark
 * segments and nodes dirty; derived data is recomputed incrementally the next
 * time anything reads it, and at the latest on commit. A method called outside
 * beginBatch() commits by itself. Inside a batch, one change event fires on the
 * matching commit() and carries everything dirtied since beginBatch().
 */
import type {
  AutoMarkingRef,
  CrosswalkStyle,
  Decal,
  Id,
  JunctionControl,
  JunctionShape,
  LaneGraph,
  MarkingAnchor,
  MarkingHost,
  MarkingLibrary,
  MarkingPointSetting,
  MarkingPreset,
  MarkingTemplate,
  NodeFillerMarking,
  NodeGeom,
  NodeLineMarking,
  NodeMarking,
  Project,
  RampAttach,
  LaneAlign,
  LaneDef,
  RoadNode,
  RoadTypeDef,
  Segment,
  SegmentGeom,
  SegmentOverrides,
  SignKind,
  TerrainData,
  TrafficEndpoint,
  TrafficSettings,
  Vec3,
  ZoneRegion,
} from './types';
import type { Quay } from './wallTypes';
import { mirrorBarriers, mirrorStructure } from './walls';
import { mirrorUpgrades } from './roadUpgrades';
import { quaySamples } from './quays';
import {
  closestPointOnCubic,
  cubicPoint,
  cubicTangentXZ,
  curvatureXZ,
  intersectCubicsXZ,
  isStraightCubic,
  splitCubic,
  straightCubic,
  subCubic,
  type Cubic,
} from './bezier';
import { buildSegmentCurve, buildSegmentGeom, maxGrade, type SegmentCurve } from './geometry';
import { buildNodeGeom, computeNodeLayout, finalizeTrims, type ArmSource, type NodeLayout } from './junction';
import { normaliseShape, renameShapeSegment, stripShapeSegment } from './junctionShape';
import type { PossibleConnection } from './connectors';
import { crossingClearance, railDraftIssues } from './railValidate';
import { mirrorSide, type RailData, type RailLine, type RailStation } from './railTypes';
import {
  assembleLaneGraph,
  buildNodeLanes,
  buildRoadLanes,
  connectionsOf,
  patchLaneGraph,
  type NodeLanes,
  type RoadLaneProto,
} from './laneGraph';
import { add, clamp, copy, dist, distXZ, dotXZ, isFiniteVec, lerp, normalizeXZ, rightOf, sub } from './math';
import {
  builtinRoadType,
  effectiveLanes,
  laneSpeedKmh,
  roadTypeProblems,
  totalHalfWidth,
} from './roadTypes';
import {
  createEmptyProject,
  defaultJunctionControl,
  defaultVehicleMix,
  hashString,
  parseProject,
  serializeProject,
} from './serialize';
import { piecesWithout, splitPaintPieces } from './roadPaint';
import { zonePolygon } from './zones';
import { boundaryOffsets } from './nodeMarkings';
import { cleanStacked, mirrorPaintOff, stackedWith, type PaintItem, type PaintRef } from './paintCoherence';
import {
  flipPaintOn,
  flipT,
  isSymmetricRoad,
  mirrorLaneLinks,
  mirrorMarkings,
  mirrorSegmentMarkings,
  reconcileLaneLinks,
  reconcileSignal,
  strandedNodes,
  type ReverseReport,
} from './reverse';
import { mirrorRulesOnReverse, renameRulesSegment, stripRulesSegment } from './trafficRules';
import { autoRefSegments, renameAutoRef, sameAutoRef } from './autoMarkings';
import { SpatialHash } from './spatial';
import { attachAt, attachedCubic, attachPointFrom, edgeAttachPoint, hostDirection, pickHost, rampEndIssues, type AttachAccess } from './ramps';
import { crossingShaped, tagNewCrossings } from './highwayCrossing';
import { alignAt, alignedCubic, endShift } from './laneAlign';
import { planEdgeMerge } from './edgeMerge';
import { draftOverlapIssues } from './overlap';
import { GRADE_CLEARANCE, MAP_HALF_SIZE, MAX_ELEVATION, MIN_ELEVATION } from './terrain';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Where a drawn road starts or ends. */
export type RoadAnchor =
  | { kind: 'node'; id: Id }
  /** A point along a segment. The segment is split there. */
  | { kind: 'segment'; id: Id; t: number }
  | { kind: 'free'; pos: Vec3 };

export interface DrawRoadParams {
  start: RoadAnchor;
  end: RoadAnchor;
  /** Absolute control positions. Omit both for a straight road. */
  c1?: Vec3;
  c2?: Vec3;
  roadType: string;
  overrides?: SegmentOverrides;
  /**
   * Leave from, or join, a lane of the road at a segment or node anchor, as a ramp
   * does. The end sits on that road's carriageway edge. See core/ramps.ts.
   */
  startAttach?: RampAttach;
  endAttach?: RampAttach;
}

export interface DrawRoadResult {
  /** New segments, in the direction drawn. */
  segments: Id[];
  /** Nodes along the road, start to end. */
  nodes: Id[];
  /** Nodes where the new road crossed an existing one at grade. */
  junctions: Id[];
}

/** An existing road a proposed curve passes over, under or through. */
export interface CrossingInfo {
  segmentId: Id;
  /** Parameter on the proposed curve. */
  t: number;
  /** Parameter on the existing segment. */
  segmentT: number;
  point: Vec3;
  /** Height gap between the two surfaces. */
  clearance: number;
  /** True when the clearance is under what is needed, so a junction is needed. */
  atGrade: boolean;
  /**
   * Clearance this pair needs to pass without meeting: GRADE_CLEARANCE for two roads,
   * less or more where track is involved (see crossingClearance).
   */
  required: number;
  /** The other surface is track. */
  overRail?: boolean;
}

export type DraftIssueCode =
  | 'zeroLength'
  | 'tooShort'
  | 'tooSteep'
  | 'tightCurve'
  | 'tooClose'
  | 'insufficientClearance'
  | 'outOfBounds'
  | 'elevationRange'
  | 'selfCrossing'
  /** Track meeting a road other than by crossing it, or metro crossing at grade. */
  | 'railCrossing'
  /** A one-way road joining a highway against its traffic. */
  | 'wrongWay'
  /** A two-way road joining a highway at grade: right in, right out only. */
  | 'atGradeHighway'
  /** An embankment, wall or cut beside the road reaching another road. See core/walls.ts. */
  | 'structureFootprint';

export interface DraftIssue {
  code: DraftIssueCode;
  /** 'error' means the draft should be refused. 'warning' is advice. */
  severity: 'error' | 'warning';
  message: string;
  at?: Vec3;
  /** The stretch of the draft the issue covers, for drawing it, as for an overlap. */
  stretch?: Vec3[];
}

export interface NearestSegment {
  segmentId: Id;
  t: number;
  point: Vec3;
  distance: number;
  /** Signed distance from the centreline, positive right of a-to-b. */
  lateral: number;
}

export interface Region {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * Why a project was replaced. 'undo' and 'redo' restore an earlier state of the same
 * project, so the simulation keeps its traffic. 'replace' is a different project,
 * such as New or an import. Unset is treated as restoring.
 */
export type ResetReason = 'undo' | 'redo' | 'replace';

export interface NetworkChange {
  /** Network version after this change. */
  version: number;
  /** Nodes whose NodeGeom or connectors were rebuilt. Excludes removed ones. */
  dirtyNodes: Id[];
  /** Segments whose SegmentGeom was rebuilt. Excludes removed ones. */
  dirtySegments: Id[];
  removedNodes: Id[];
  removedSegments: Id[];
  endpointsChanged: boolean;
  decalsChanged: boolean;
  /** Traffic settings, name or the custom road list changed. */
  settingsChanged: boolean;
  /** Stations or train lines changed. */
  railChanged?: boolean;
  /** Quay walls changed. */
  quaysChanged?: boolean;
  /** Landscaping (Project.terrain) changed. Roads over the edited area are in dirtySegments. */
  terrainChanged?: boolean;
  /** The whole project was replaced by load(). Rebuild everything. */
  reset: boolean;
  /** Set on a reset when the caller said why. See ResetReason. */
  reason?: ResetReason;
  /** Segments whose a and b swapped. Same ids, but every lane on them changed meaning. */
  reversedSegments: Id[];
  /**
   * Segments given a road type with a different lane layout (lanes added, removed,
   * moved or turned round). Same ids, but a lane index may now mean another lane.
   */
  relaidSegments?: Id[];
}

export type ChangeListener = (change: NetworkChange) => void;

export type EndpointInit = Partial<Omit<TrafficEndpoint, 'id'>> & Pick<TrafficEndpoint, 'kind'>;
export type DecalInit = Omit<Decal, 'id'>;
export type NodeMarkingInit = NodeMarking extends infer M ? (M extends NodeMarking ? Omit<M, 'id'> : never) : never;

/** A crossing closer than this to an existing node uses that node. */
const NODE_SNAP = 2;
const MIN_SEGMENT_LENGTH = 0.05;
/** Length under which a draft is refused. */
const MIN_DRAFT_LENGTH = 5;
const STEEP_HARD = 0.15;
const STEEP_WARN_RAMP = 0.12;
const STEEP_WARN_HIGHWAY = 0.08;
const STEEP_WARN_OTHER = 0.12;
/** Clearance under which two crossing roads count as level and may simply join. */
const LEVEL_TOLERANCE = 1.5;
/** How far from a shared node a nearly parallel road is expected. */
const PARALLEL_GRACE = 80;
const PARALLEL_ANGLE = (15 * Math.PI) / 180;

const EMPTY_RAIL: Readonly<RailData> = { stations: [], lines: [] };

function assertVec(v: Vec3 | undefined, what: string): asserts v is Vec3 {
  if (!isFiniteVec(v)) throw new NetworkError(`${what} must be a finite position`);
}

function renameKey<T>(rec: Record<number, T>, from: number, to: number): void {
  if (from in rec) {
    rec[to] = rec[from];
    delete rec[from];
  }
}

function moveKey(key: string, seg: Id, to: Id): string {
  const [a, b] = key.split('>').map(Number);
  return `${a === seg ? to : a}>${b === seg ? to : b}`;
}

// ---------------------------------------------------------------------------

export class RoadNetwork {
  private p: Project;
  private readonly nodeIndex = new Map<Id, RoadNode>();
  private readonly segIndex = new Map<Id, Segment>();
  private readonly customTypes = new Map<string, RoadTypeDef>();

  private readonly listeners = new Set<ChangeListener>();
  private batchDepth = 0;
  private _version = 0;

  // Inputs waiting for refreshDerived().
  private readonly dirtySegs = new Set<Id>();
  private readonly dirtyNodes = new Set<Id>();
  private readonly hashDirtySegs = new Set<Id>();
  private readonly hashDirtyNodes = new Set<Id>();
  private pendingEdit = false;

  // What the next change event will report.
  private readonly evtNodes = new Set<Id>();
  private readonly evtSegs = new Set<Id>();
  private readonly evtRemovedNodes = new Set<Id>();
  private readonly evtRemovedSegs = new Set<Id>();
  private evtEndpoints = false;
  private evtDecals = false;
  private evtSettings = false;
  private evtRail = false;
  private evtQuays = false;
  private evtTerrain = false;
  private readonly evtReversed = new Set<Id>();
  private readonly evtRelaid = new Set<Id>();
  private evtReset = false;
  private evtReason: ResetReason | undefined = undefined;

  // Derived caches.
  private readonly curves = new Map<Id, SegmentCurve>();
  private readonly layouts = new Map<Id, NodeLayout>();
  private readonly trims = new Map<Id, { trimA: number; trimB: number; rightA: Vec3 | null; rightB: Vec3 | null }>();
  private readonly geoms = new Map<Id, SegmentGeom>();
  private readonly nodeGeoms = new Map<Id, NodeGeom>();
  private readonly roadLanes = new Map<Id, (RoadLaneProto | null)[]>();
  private readonly nodeLanes = new Map<Id, NodeLanes>();
  private graph: LaneGraph | null = null;
  private graphVersion = 0;
  // What the fast lane graph patch needs: the last graph and what changed since.
  private lastGraph: LaneGraph | null = null;
  private readonly graphSegs = new Set<Id>();
  private readonly graphNodes = new Set<Id>();
  private readonly graphDirectKeys = new Map<Id, string>();
  private graphTopologyChanged = true;

  private readonly segHash = new SpatialHash(64);
  private readonly nodeHash = new SpatialHash(64);

  constructor(project?: Project | string) {
    this.p = project === undefined ? createEmptyProject() : parseProject(project);
    this.reindex();
    this.refreshDerived();
    this.cleanStackedPaint();
    this.clearEvent();
    this.pendingEdit = false;
    this.buildGraph();
  }

  // -------------------------------------------------------------------------
  // Change plumbing
  // -------------------------------------------------------------------------

  /** Monotonic edit counter. Unchanged version means unchanged project. */
  get version(): number {
    return this._version;
  }

  /** Subscribe to change events. Returns the function that unsubscribes. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a compound edit. Nest freely; the outermost commit() finishes it. */
  beginBatch(): void {
    this.batchDepth++;
  }

  /** End a compound edit. Does nothing if no edit is pending. */
  commit(): void {
    if (this.batchDepth > 0) this.batchDepth--;
    if (this.batchDepth === 0) this.finishEdit();
  }

  /** Run `fn` as a batch, committing even if it throws. */
  batch<T>(fn: () => T): T {
    this.beginBatch();
    try {
      return fn();
    } finally {
      this.commit();
    }
  }

  private touchSeg(id: Id): void {
    this.dirtySegs.add(id);
    this.hashDirtySegs.add(id);
    this.curves.delete(id);
    this.pendingEdit = true;
    this.graph = null;
    const seg = this.segIndex.get(id);
    if (seg) {
      this.touchAttachedAt(seg.a, id);
      this.touchAttachedAt(seg.b, id);
    }
  }

  /** A ramp end attached at a node follows its host road, so its curve changes with it. */
  private touchAttachedAt(nodeId: Id, except?: Id): void {
    const node = this.nodeIndex.get(nodeId);
    if (!node) return;
    for (const other of node.segments) {
      if (other === except) continue;
      const s = this.segIndex.get(other);
      // A lane-aligned end follows the road it continues the same way (core/laneAlign.ts).
      if (!s || (!attachAt(s, nodeId) && !alignAt(s, nodeId))) continue;
      this.dirtySegs.add(other);
      this.hashDirtySegs.add(other);
      this.curves.delete(other);
    }
  }

  private touchNode(id: Id): void {
    this.dirtyNodes.add(id);
    this.pendingEdit = true;
    this.graph = null;
  }

  private markEdit(): void {
    this.pendingEdit = true;
  }

  private finishEdit(): void {
    if (!this.pendingEdit) return;
    this.pendingEdit = false;
    this._version++;
    this.refreshDerived();
    this.buildGraph();
    const change: NetworkChange = {
      version: this._version,
      dirtyNodes: [...this.evtNodes].filter((id) => this.nodeIndex.has(id)),
      dirtySegments: [...this.evtSegs].filter((id) => this.segIndex.has(id)),
      removedNodes: [...this.evtRemovedNodes],
      removedSegments: [...this.evtRemovedSegs],
      endpointsChanged: this.evtEndpoints,
      decalsChanged: this.evtDecals,
      settingsChanged: this.evtSettings,
      railChanged: this.evtRail,
      quaysChanged: this.evtQuays,
      terrainChanged: this.evtTerrain,
      reversedSegments: [...this.evtReversed],
      ...(this.evtRelaid.size ? { relaidSegments: [...this.evtRelaid].filter((id) => this.segIndex.has(id)) } : {}),
      reset: this.evtReset,
      reason: this.evtReason,
    };
    this.clearEvent();
    for (const fn of [...this.listeners]) fn(change);
  }

  private clearEvent(): void {
    this.evtNodes.clear();
    this.evtSegs.clear();
    this.evtRemovedNodes.clear();
    this.evtRemovedSegs.clear();
    this.evtEndpoints = false;
    this.evtDecals = false;
    this.evtSettings = false;
    this.evtRail = false;
    this.evtQuays = false;
    this.evtTerrain = false;
    this.evtReversed.clear();
    this.evtRelaid.clear();
    this.evtReset = false;
    this.evtReason = undefined;
  }

  // -------------------------------------------------------------------------
  // Reads of persisted data
  // -------------------------------------------------------------------------

  /** The live project. Read it freely. Change it only through this class. */
  get project(): Readonly<Project> {
    return this.p;
  }

  get nodes(): readonly RoadNode[] {
    return this.p.nodes;
  }

  get segments(): readonly Segment[] {
    return this.p.segments;
  }

  get endpoints(): readonly TrafficEndpoint[] {
    return this.p.endpoints;
  }

  get decals(): readonly Decal[] {
    return this.p.decals;
  }

  get traffic(): Readonly<TrafficSettings> {
    return this.p.traffic;
  }

  getNode(id: Id): RoadNode | undefined {
    return this.nodeIndex.get(id);
  }

  getSegment(id: Id): Segment | undefined {
    return this.segIndex.get(id);
  }

  private requireNode(id: Id): RoadNode {
    const n = this.nodeIndex.get(id);
    if (!n) throw new NetworkError(`No node ${id}`);
    return n;
  }

  private requireSegment(id: Id): Segment {
    const s = this.segIndex.get(id);
    if (!s) throw new NetworkError(`No segment ${id}`);
    return s;
  }

  /** A built-in or custom road type, or undefined. */
  roadType(id: string): RoadTypeDef | undefined {
    return this.customTypes.get(id) ?? builtinRoadType(id);
  }

  private requireRoadType(id: string): RoadTypeDef {
    const def = this.roadType(id);
    if (!def) throw new NetworkError(`Unknown road type "${id}"`);
    return def;
  }

  /** The road type of a segment. */
  roadTypeOf(segmentId: Id): RoadTypeDef {
    return this.requireRoadType(this.requireSegment(segmentId).roadType);
  }

  /** The Bezier of a segment, end points included. */
  cubicOf(segmentId: Id): Cubic {
    const s = this.requireSegment(segmentId);
    const raw = { p0: this.requireNode(s.a).pos, p1: s.c1, p2: s.c2, p3: this.requireNode(s.b).pos };
    // A ramp end attached to a lane starts at that lane's edge, not at the node.
    const c = s.overrides.attachA || s.overrides.attachB ? attachedCubic(this.attachAccess, s, raw) : raw;
    // A narrower road lined up with one side of the road it continues (core/laneAlign.ts).
    return s.overrides.alignA || s.overrides.alignB ? alignedCubic(this.attachAccess, s, c) : c;
  }

  /** The cubic between the node positions, ignoring any lane attach. */
  nodeCubicOf(segmentId: Id): Cubic {
    const s = this.requireSegment(segmentId);
    return { p0: this.requireNode(s.a).pos, p1: s.c1, p2: s.c2, p3: this.requireNode(s.b).pos };
  }

  /** What core/ramps.ts needs to place attached ramp ends. */
  readonly attachAccess: AttachAccess = {
    node: (id) => this.nodeIndex.get(id),
    segment: (id) => this.segIndex.get(id),
    def: (seg) => this.requireRoadType(seg.roadType),
  };

  // -------------------------------------------------------------------------
  // Reads of derived data
  // -------------------------------------------------------------------------

  /** Geometry of a segment, or undefined if there is no such segment. */
  segmentGeom(id: Id): SegmentGeom | undefined {
    this.refreshDerived();
    return this.geoms.get(id);
  }

  nodeGeom(id: Id): NodeGeom | undefined {
    this.refreshDerived();
    return this.nodeGeoms.get(id);
  }

  /**
   * Why a ramp asking for an edge merge at this node got a full junction instead, or
   * null when it is an edge merge or nothing asks for one (core/edgeMerge.ts).
   */
  edgeMergeProblem(id: Id): string | null {
    this.refreshDerived();
    const layout = this.layouts.get(id);
    const plan = layout ? planEdgeMerge(layout.arms) : null;
    if (layout && layout.arms.length !== 3 && layout.arms.some((a) => a.source.attach?.edge)) return 'Another road joins here too: full junction.';
    return plan && 'problem' in plan ? plan.problem : null;
  }

  /** The current lane graph. A new object whenever the network changes. */
  get laneGraph(): LaneGraph {
    this.refreshDerived();
    this.buildGraph();
    return this.graph!;
  }

  /** Every lane link possible at a node, with `active` set on those in use. */
  connectionsAt(nodeId: Id): PossibleConnection[] {
    this.refreshDerived();
    const lanes = this.nodeLanes.get(nodeId);
    return lanes ? connectionsOf(lanes) : [];
  }

  /** The curve cache for a segment. */
  curveOf(id: Id): SegmentCurve {
    let c = this.curves.get(id);
    if (!c) {
      c = buildSegmentCurve(this.cubicOf(id));
      this.curves.set(id, c);
    }
    return c;
  }

  private armSources(node: RoadNode): ArmSource[] {
    const out: ArmSource[] = [];
    for (const id of node.segments) {
      const seg = this.requireSegment(id);
      const def = this.requireRoadType(seg.roadType);
      const laneSig = seg.overrides.laneKinds
        ? effectiveLanes(def, seg.overrides).map((l) => l.kind[0] + (l.kind === 'bus' ? 'u' : '')).join('')
        : '';
      const atStart = seg.a === node.id;
      const attach = atStart ? seg.overrides.attachA : seg.overrides.attachB;
      const shift = endShift(this.attachAccess, seg, node.id);
      out.push({ segmentId: id, atStart, curve: this.curveOf(id), def, laneSig, ...(attach ? { attach } : {}), ...(shift ? { shift } : {}) });
    }
    return out;
  }

  private refreshDerived(): void {
    if (this.dirtySegs.size === 0 && this.dirtyNodes.size === 0) return;

    const forced = new Set(this.dirtySegs);
    this.dirtySegs.clear();
    const layoutNodes = new Set(this.dirtyNodes);
    this.dirtyNodes.clear();
    for (const id of forced) {
      const seg = this.segIndex.get(id);
      if (!seg) continue;
      this.curveOf(id);
      layoutNodes.add(seg.a);
      layoutNodes.add(seg.b);
    }

    const check = new Set(forced);
    const rebuildNodes = new Set<Id>();
    for (const id of layoutNodes) {
      const node = this.nodeIndex.get(id);
      if (!node) continue;
      const layout = computeNodeLayout(id, this.armSources(node), node.control.shape);
      this.layouts.set(id, layout);
      rebuildNodes.add(id);
      for (const seg of node.segments) check.add(seg);
    }

    for (const id of check) {
      const seg = this.segIndex.get(id);
      if (!seg) continue;
      const curve = this.curveOf(id);
      const armA = this.layouts.get(seg.a)?.arms.find((x) => x.segmentId === id);
      const armB = this.layouts.get(seg.b)?.arms.find((x) => x.segmentId === id);
      const next = finalizeTrims(curve.length, armA?.rawTrim ?? 0, armB?.rawTrim ?? 0);
      // A plain joint shares its right vector with the neighbour, which may have moved.
      const rightA = armA?.jointRight ?? null;
      const rightB = armB?.jointRight ?? null;
      const prev = this.trims.get(id);
      const changedA = !prev || prev.trimA !== next.trimA || !sameVec(prev.rightA, rightA);
      const changedB = !prev || prev.trimB !== next.trimB || !sameVec(prev.rightB, rightB);
      const whole = forced.has(id) || !prev;
      if (!whole && !changedA && !changedB) continue;
      const def = this.requireRoadType(seg.roadType);
      this.trims.set(id, { ...next, rightA, rightB });
      const geom = buildSegmentGeom(id, curve, next.trimA, next.trimB, { rightA, rightB, halfWidth: def.halfWidth });
      this.geoms.set(id, geom);
      const laneDefs = effectiveLanes(def, seg.overrides);
      const speeds = laneDefs.map((_, i) => laneSpeedKmh(def, seg.overrides, i) / 3.6);
      const lanes = buildRoadLanes(id, geom, laneDefs, speeds);
      const lanesWere = this.roadLanes.get(id);
      this.roadLanes.set(id, lanes);
      this.evtSegs.add(id);
      this.graphSegs.add(id);
      this.graph = null;
      // A node only cares about the end of the road that meets it, unless a lane
      // appeared or vanished, because connectors hold on to lanes by index.
      const laneSetChanged = !lanesWere || lanesWere.some((l, i) => !l !== !lanes[i]);
      if (whole || changedA || laneSetChanged) rebuildNodes.add(seg.a);
      if (whole || changedB || laneSetChanged) rebuildNodes.add(seg.b);
    }

    for (const id of rebuildNodes) {
      const node = this.nodeIndex.get(id);
      if (!node) continue;
      if (!this.layouts.has(id)) {
        this.layouts.set(id, computeNodeLayout(id, this.armSources(node), node.control.shape));
      }
      const layout = this.layouts.get(id)!;
      const geom = buildNodeGeom(layout, node.pos, (s) => this.geoms.get(s), node.control.shape);
      this.nodeGeoms.set(id, geom);
      this.nodeLanes.set(
        id,
        buildNodeLanes(
          layout,
          geom,
          node.control,
          (s) => this.geoms.get(s),
          (s) => this.roadTypeOf(s),
          (s) => this.roadLanes.get(s) ?? [],
          (s, atStart) => {
            const seg = this.segIndex.get(s);
            return atStart ? seg?.overrides.attachA : seg?.overrides.attachB;
          },
          (s, atStart) => {
            const seg = this.segIndex.get(s);
            return seg ? endShift(this.attachAccess, seg, atStart ? seg.a : seg.b) : 0;
          },
        ),
      );
      this.evtNodes.add(id);
      this.graphNodes.add(id);
      this.graph = null;
    }
  }

  private buildGraph(): void {
    if (this.graph) return;
    const version = ++this.graphVersion;
    let next: LaneGraph | null = null;
    if (this.lastGraph && !this.graphTopologyChanged) {
      next = patchLaneGraph(
        this.lastGraph,
        this.graphSegs,
        this.graphNodes,
        this.roadLanes,
        this.nodeLanes,
        this.graphDirectKeys,
        version,
      );
    }
    if (next) {
      for (const id of this.graphNodes) this.graphDirectKeys.set(id, this.nodeLanes.get(id)!.directKey);
    } else {
      next = assembleLaneGraph(this.p, this.roadLanes, this.nodeLanes, version);
      this.graphDirectKeys.clear();
      for (const [id, data] of this.nodeLanes) this.graphDirectKeys.set(id, data.directKey);
    }
    this.graphSegs.clear();
    this.graphNodes.clear();
    this.graphTopologyChanged = false;
    this.lastGraph = next;
    this.graph = next;
  }

  // -------------------------------------------------------------------------
  // Whole-project operations
  // -------------------------------------------------------------------------

  private reindex(): void {
    this.nodeIndex.clear();
    this.segIndex.clear();
    this.customTypes.clear();
    this.curves.clear();
    this.layouts.clear();
    this.trims.clear();
    this.geoms.clear();
    this.nodeGeoms.clear();
    this.roadLanes.clear();
    this.nodeLanes.clear();
    this.segHash.clear();
    this.nodeHash.clear();
    this.hashDirtyNodes.clear();
    this.hashDirtySegs.clear();
    this.dirtySegs.clear();
    this.dirtyNodes.clear();
    this.graph = null;
    this.graphTopologyChanged = true;
    for (const t of this.p.customRoadTypes) this.customTypes.set(t.id, t);
    for (const n of this.p.nodes) {
      this.nodeIndex.set(n.id, n);
      this.dirtyNodes.add(n.id);
      this.hashDirtyNodes.add(n.id);
    }
    for (const s of this.p.segments) {
      this.segIndex.set(s.id, s);
      this.dirtySegs.add(s.id);
      this.hashDirtySegs.add(s.id);
    }
  }

  /** The project as JSON text. */
  serialize(): string {
    return serializeProject(this.p);
  }

  /** A deep copy of the project, for undo. Hand it back to load(). */
  snapshot(): Project {
    return structuredClone(this.p);
  }

  /** A hash of the whole saved state. Slower than `version`, but stable across loads. */
  signature(): string {
    return hashString(this.serialize());
  }

  /**
   * Replace the project. Throws ProjectFormatError and changes nothing when the
   * data is bad. Fires a change event with `reset: true` and the given reason.
   */
  load(data: Project | string, reason?: ResetReason): void {
    const next = parseProject(data);
    this.p = next;
    this.reindex();
    this.evtReset = true;
    this.evtReason = reason;
    this.pendingEdit = true;
    if (this.batchDepth === 0) this.finishEdit();
    this.cleanStackedPaint();
  }

  /** Old saves could stack markings in one place: keep the newest of each (core/paintCoherence.ts). */
  private cleanStackedPaint(): void {
    const any = this.p.decals.length || this.p.nodes.some((n) => n.control.markings) || this.p.segments.some((s) => s.overrides.handMarkings);
    if (any) cleanStacked(this, this.p);
  }

  /**
   * What the last placed marking replaced, by name ('lane line', 'crosswalk'...),
   * automatic ones included: one marking per place. Tools read it for a toast.
   */
  lastReplaced: string[] = [];

  /** Remove placed markings in the slots `item` takes, inside the caller's batch. */
  private replaceStacked(item: PaintItem, self: PaintRef): void {
    const { refs, labels } = stackedWith(this, item, self);
    this.lastReplaced = labels;
    for (const r of refs) {
      if (r.kind === 'decal') {
        this.p.decals = this.p.decals.filter((d) => d.id !== r.id);
        this.evtDecals = true;
      } else if (this.markingsOf(r.host).some((m) => m.id === r.id)) {
        this.writeHost(r.host, this.markingsOf(r.host).filter((m) => m.id !== r.id));
      }
    }
    if (refs.length) this.markEdit();
  }

  /** Empty the project. */
  clear(name = 'Untitled'): void {
    this.load(createEmptyProject(name), 'replace');
  }

  setProjectName(name: string): void {
    this.p.name = name;
    this.evtSettings = true;
    this.markEdit();
    if (this.batchDepth === 0) this.finishEdit();
  }

  setTraffic(patch: Partial<TrafficSettings>): void {
    this.p.traffic = { ...this.p.traffic, ...patch };
    this.evtSettings = true;
    this.markEdit();
    if (this.batchDepth === 0) this.finishEdit();
  }

  // -------------------------------------------------------------------------
  // Custom road types
  // -------------------------------------------------------------------------

  /** Add a road type, or replace the custom one with the same id. */
  setCustomRoadType(def: RoadTypeDef): void {
    const problems = roadTypeProblems(def);
    if (problems.length) throw new NetworkError(`Road type "${def.id}" ${problems.join(', ')}`);
    if (builtinRoadType(def.id)) throw new NetworkError(`"${def.id}" is a built-in road type`);
    this.batch(() => {
      const copyOf = structuredClone(def);
      const i = this.p.customRoadTypes.findIndex((t) => t.id === def.id);
      const before = i >= 0 ? this.p.customRoadTypes[i].lanes : null;
      const relaid = !!before && (before.length !== copyOf.lanes.length || before.some((l, k) => l.dir !== copyOf.lanes[k].dir || Math.abs(l.offset - copyOf.lanes[k].offset) > 1e-6));
      if (i >= 0) this.p.customRoadTypes[i] = copyOf;
      else this.p.customRoadTypes.push(copyOf);
      this.customTypes.set(def.id, copyOf);
      if (relaid) this.graphTopologyChanged = true;
      for (const s of this.p.segments) {
        if (s.roadType !== def.id) continue;
        if (relaid) this.evtRelaid.add(s.id);
        this.touchSeg(s.id);
      }
      this.evtSettings = true;
      this.markEdit();
    });
  }

  /** Remove a custom road type. Throws while any segment uses it. */
  removeCustomRoadType(id: string): void {
    if (this.p.segments.some((s) => s.roadType === id)) {
      throw new NetworkError(`Road type "${id}" is still in use`);
    }
    this.batch(() => {
      this.p.customRoadTypes = this.p.customRoadTypes.filter((t) => t.id !== id);
      this.customTypes.delete(id);
      this.evtSettings = true;
      this.markEdit();
    });
  }

  // -------------------------------------------------------------------------
  // Nodes and segments
  // -------------------------------------------------------------------------

  /** Add a free-standing node and return its id. */
  addNode(pos: Vec3): Id {
    assertVec(pos, 'Node position');
    return this.batch(() => this.createNode(pos));
  }

  private createNode(pos: Vec3): Id {
    const id = this.p.nextId++;
    const node: RoadNode = { id, pos: copy(pos), segments: [], control: defaultJunctionControl() };
    this.p.nodes.push(node);
    this.nodeIndex.set(id, node);
    this.graphTopologyChanged = true;
    this.hashDirtyNodes.add(id);
    this.touchNode(id);
    return id;
  }

  /**
   * Add a segment with explicit Bezier controls, without any crossing handling.
   * Controls default to a straight road. Use drawRoad for player-drawn roads.
   */
  addSegment(
    a: Id,
    b: Id,
    opts: { c1?: Vec3; c2?: Vec3; roadType: string; overrides?: SegmentOverrides },
  ): Id {
    const na = this.requireNode(a);
    const nb = this.requireNode(b);
    if (a === b) throw new NetworkError('A segment needs two different nodes');
    this.requireRoadType(opts.roadType);
    const fallback = straightCubic(na.pos, nb.pos);
    const c1 = opts.c1 ?? fallback.p1;
    const c2 = opts.c2 ?? fallback.p2;
    assertVec(c1, 'Control c1');
    assertVec(c2, 'Control c2');
    return this.batch(() =>
      this.createSegment(a, b, c1, c2, opts.roadType, structuredClone(opts.overrides ?? {})),
    );
  }

  private createSegment(a: Id, b: Id, c1: Vec3, c2: Vec3, roadType: string, overrides: SegmentOverrides): Id {
    const id = this.p.nextId++;
    const seg: Segment = { id, a, b, c1: copy(c1), c2: copy(c2), roadType, overrides };
    this.p.segments.push(seg);
    this.segIndex.set(id, seg);
    this.graphTopologyChanged = true;
    this.requireNode(a).segments.push(id);
    this.requireNode(b).segments.push(id);
    this.touchSeg(id);
    return id;
  }

  /**
   * Split a segment at parameter t with the exact same curve. The original id
   * keeps the a side, a new segment takes the b side, and both keep the overrides.
   * A t within a few centimetres of an end returns that end's node and no new
   * segment.
   */
  splitSegment(id: Id, t: number): { node: Id; left: Id; right: Id | null } {
    return this.batch(() => this.splitInternal(id, t));
  }

  private splitInternal(id: Id, t: number): { node: Id; left: Id; right: Id | null } {
    const seg = this.requireSegment(id);
    if (!(t >= 0 && t <= 1)) throw new NetworkError(`Split position ${t} is outside the segment`);
    const cubic = this.cubicOf(id);
    const curve = this.curveOf(id);
    const s = curve.table.ss.length ? tToLength(curve, t) : 0;
    if (s < MIN_SEGMENT_LENGTH) return { node: seg.a, left: id, right: null };
    if (curve.length - s < MIN_SEGMENT_LENGTH) return { node: seg.b, left: id, right: null };

    const [left, right] = splitCubic(cubic, t);
    const nodeId = this.createNode(left.p3);
    const farNode = this.requireNode(seg.b);

    farNode.segments = farNode.segments.filter((x) => x !== id);
    // A lane attach stays with the end it belongs to.
    const rightOverrides = structuredClone(seg.overrides);
    delete rightOverrides.attachA;
    delete seg.overrides.attachB;
    // So does a lane alignment.
    delete rightOverrides.alignA;
    delete seg.overrides.alignB;
    // Markings along the segment carry on along both halves, each with ids of its own.
    if (rightOverrides.handMarkings) rightOverrides.handMarkings = this.freshMarkingIds(rightOverrides.handMarkings);
    const rightId = this.createSegment(nodeId, seg.b, right.p1, right.p2, seg.roadType, rightOverrides);
    // The copied segment markings now belong to the new half.
    const ro = this.requireSegment(rightId).overrides;
    if (ro.handMarkings) {
      const own = (a: MarkingAnchor): MarkingAnchor => ({ ...a, segmentId: rightId });
      ro.handMarkings = ro.handMarkings.map((m) => (m.kind === 'line' ? { ...m, from: own(m.from), to: own(m.to) } : { ...m, anchors: m.anchors.map(own) }));
    }
    if (ro.markingPoints) ro.markingPoints = ro.markingPoints.map((p) => ({ ...p, segmentId: rightId }));
    this.renameInControl(farNode, id, rightId);

    seg.b = nodeId;
    seg.c1 = left.p1;
    seg.c2 = left.p2;
    this.requireNode(nodeId).segments.unshift(id);
    this.touchSeg(id);
    this.touchNode(seg.a);
    this.touchNode(farNode.id);

    let touched = false;
    for (const ep of this.p.endpoints) {
      if (ep.segmentId !== id) continue;
      touched = true;
      if (ep.t > t) {
        ep.segmentId = rightId;
        ep.t = (ep.t - t) / (1 - t);
      } else {
        ep.t = ep.t / t;
      }
    }
    if (touched) this.evtEndpoints = true;
    for (const st of this.p.rail?.stations ?? []) {
      if (st.segmentId !== id) continue;
      if (st.t > t) {
        st.segmentId = rightId;
        st.t = (st.t - t) / (1 - t);
      } else {
        st.t = st.t / t;
      }
      this.evtRail = true;
    }
    for (const d of this.p.decals) {
      if (!d.road?.pieces.some((p) => p.segmentId === id)) continue;
      d.road.pieces = splitPaintPieces(d.road.pieces, id, t, rightId);
      this.evtDecals = true;
    }
    for (const z of this.p.zones ?? []) {
      for (const a of z.anchors ?? []) {
        if (!a || a.segmentId !== id) continue;
        if (a.t > t) {
          a.segmentId = rightId;
          a.t = (a.t - t) / (1 - t);
        } else {
          a.t = a.t / t;
        }
        this.evtEndpoints = true;
      }
    }
    return { node: nodeId, left: id, right: rightId };
  }

  private renameInControl(node: RoadNode, from: Id, to: Id): void {
    const c = node.control;
    renameKey(c.signs, from, to);
    renameKey(c.crosswalks, from, to);
    renameShapeSegment(c, from, to);
    renameRulesSegment(c, from, to);
    if (c.markings) {
      const rename = (a: MarkingAnchor): MarkingAnchor => (a.segmentId === from ? { ...a, segmentId: to } : a);
      c.markings = c.markings.map((m) =>
        m.kind === 'line' ? { ...m, from: rename(m.from), to: rename(m.to) } : { ...m, anchors: m.anchors.map(rename) },
      );
    }
    if (c.markingPoints) c.markingPoints = c.markingPoints.map((p) => (p.segmentId === from ? { ...p, segmentId: to } : p));
    if (c.autoOff) c.autoOff = c.autoOff.map((r) => renameAutoRef(r, from, to));
    if (c.laneLinks) {
      c.laneLinks = c.laneLinks.map((l) => ({
        from: renameLaneRef(l.from, from, to),
        to: renameLaneRef(l.to, from, to),
      }));
    }
    if (c.signal) {
      for (const phase of c.signal.phases) {
        const moves: typeof phase.moves = {};
        for (const [key, state] of Object.entries(phase.moves)) moves[moveKey(key, from, to)] = state;
        phase.moves = moves;
      }
    }
  }

  private stripFromControl(node: RoadNode, id: Id): void {
    const c = node.control;
    delete c.signs[id];
    delete c.crosswalks[id];
    stripShapeSegment(c, id);
    stripRulesSegment(c, id);
    if (c.markings) {
      c.markings = c.markings.filter((m) =>
        (m.kind === 'line' ? [m.from, m.to] : m.anchors).every((a) => a.segmentId !== id),
      );
    }
    if (c.markingPoints) {
      c.markingPoints = c.markingPoints.filter((p) => p.segmentId !== id);
      if (!c.markingPoints.length) delete c.markingPoints;
    }
    if (c.autoOff) {
      c.autoOff = c.autoOff.filter((r) => !autoRefSegments(r).includes(id));
      if (!c.autoOff.length) delete c.autoOff;
    }
    if (c.laneLinks) {
      const prefix = `${id}:`;
      c.laneLinks = c.laneLinks.filter((l) => !l.from.startsWith(prefix) && !l.to.startsWith(prefix));
    }
    if (c.signal) {
      for (const phase of c.signal.phases) {
        for (const key of Object.keys(phase.moves)) {
          if (key.split('>').some((part) => Number(part) === id)) delete phase.moves[key];
        }
      }
    }
  }

  /** Remove a segment, any node left with no roads, and anything attached to those. */
  removeSegment(id: Id): void {
    this.requireSegment(id);
    this.batch(() => this.removeSegmentInternal(id));
  }

  private removeSegmentInternal(id: Id): void {
    const seg = this.requireSegment(id);
    this.p.segments.splice(this.p.segments.indexOf(seg), 1);
    this.segIndex.delete(id);
    this.dirtySegs.delete(id);
    this.hashDirtySegs.delete(id);
    this.segHash.remove(id);
    this.curves.delete(id);
    this.trims.delete(id);
    this.geoms.delete(id);
    this.roadLanes.delete(id);
    this.evtRemovedSegs.add(id);
    this.graph = null;
    this.graphTopologyChanged = true;
    this.pendingEdit = true;

    const before = this.p.endpoints.length;
    this.p.endpoints = this.p.endpoints.filter((e) => e.segmentId !== id);
    if (this.p.endpoints.length !== before) this.evtEndpoints = true;
    this.dropStations((st) => st.segmentId === id);
    this.dropPaintOn(id);
    this.releaseZonesFrom(id);

    for (const nodeId of [seg.a, seg.b]) {
      const node = this.requireNode(nodeId);
      node.segments = node.segments.filter((x) => x !== id);
      this.touchAttachedAt(nodeId);
      this.stripFromControl(node, id);
      if (node.segments.length === 0) this.removeNodeInternal(nodeId);
      else this.touchNode(nodeId);
    }
  }

  /**
   * A road going takes the frontage zoned along it. Any other region keeps its
   * shape: corners held to the road stay where they last were.
   */
  private releaseZonesFrom(id: Id): void {
    const zones = this.p.zones;
    if (!zones) return;
    const kept: ZoneRegion[] = [];
    for (const z of zones) {
      const held = z.anchors?.some((a) => a?.segmentId === id);
      if (!held) {
        kept.push(z);
        continue;
      }
      this.evtEndpoints = true;
      if (z.source === 'frontage' && z.anchors!.every((a) => !a || a.segmentId === id)) {
        this.p.endpoints = this.p.endpoints.filter((e) => e.regionId !== z.id);
        continue;
      }
      z.polygon = zonePolygon(this, z);
      z.anchors = z.anchors!.map((a) => (a && a.segmentId === id ? null : a));
      kept.push(z);
    }
    if (kept.length) this.p.zones = kept;
    else delete this.p.zones;
  }

  // -------------------------------------------------------------------------
  // Quay walls
  // -------------------------------------------------------------------------

  get quays(): readonly Quay[] {
    return this.p.quays ?? [];
  }

  /** Roads over the land a quay holds up stand on new ground, so they rebuild. */
  private touchRoadsByQuay(q: Pick<Quay, 'bank' | 'x0' | 'x1'>): void {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of quaySamples(q, 8)) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    const pad = 24;
    for (const id of this.segmentsInRegion({ minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad }, true)) {
      this.touchSeg(id);
    }
  }

  /** Build a quay wall along the river bank. See core/quays.ts. */
  addQuay(init: Omit<Quay, 'id'>): Id {
    if (!(init.x1 > init.x0)) throw new NetworkError('A quay needs two different ends');
    return this.batch(() => {
      const id = this.p.nextId++;
      this.p.quays = [...(this.p.quays ?? []), { ...structuredClone(init), id }];
      this.touchRoadsByQuay(init);
      this.evtQuays = true;
      this.markEdit();
      return id;
    });
  }

  updateQuay(id: Id, patch: Partial<Omit<Quay, 'id'>>): void {
    const quays = this.p.quays ?? [];
    const i = quays.findIndex((q) => q.id === id);
    if (i < 0) throw new NetworkError(`No quay ${id}`);
    this.batch(() => {
      this.touchRoadsByQuay(quays[i]);
      quays[i] = { ...quays[i], ...structuredClone(patch), id };
      this.touchRoadsByQuay(quays[i]);
      this.evtQuays = true;
      this.markEdit();
    });
  }

  removeQuay(id: Id): void {
    const quays = this.p.quays ?? [];
    if (!quays.some((q) => q.id === id)) throw new NetworkError(`No quay ${id}`);
    this.batch(() => {
      const kept = quays.filter((q) => q.id !== id);
      this.touchRoadsByQuay(quays.find((q) => q.id === id)!);
      if (kept.length) this.p.quays = kept;
      else delete this.p.quays;
      this.evtQuays = true;
      this.markEdit();
    });
  }

  // -------------------------------------------------------------------------
  // Landscaping
  // -------------------------------------------------------------------------

  /**
   * Store packed landscaping (core/terrainEdit.ts owns the format). Roads in `box`
   * are touched so everything built on the ground under them rebuilds; their
   * curves never move. Undefined removes it.
   */
  setTerrain(data: TerrainData | undefined, box?: { minX: number; minZ: number; maxX: number; maxZ: number }): void {
    this.batch(() => {
      if (data) this.p.terrain = structuredClone(data);
      else delete this.p.terrain;
      if (box) for (const id of this.segmentsInRegion(box, true)) this.touchSeg(id);
      this.evtTerrain = true;
      this.markEdit();
    });
  }

  // -------------------------------------------------------------------------
  // Zoned regions
  // -------------------------------------------------------------------------

  /** Add a region on top of the others. */
  addZone(init: Omit<ZoneRegion, 'id'>): Id {
    if (init.polygon.length < 3) throw new NetworkError('A zone needs three corners');
    return this.batch(() => {
      const id = this.p.nextId++;
      this.p.zones = [...(this.p.zones ?? []), { ...structuredClone(init), id }];
      this.evtEndpoints = true;
      this.markEdit();
      return id;
    });
  }

  updateZone(id: Id, patch: Partial<Omit<ZoneRegion, 'id'>>): void {
    const zones = this.p.zones ?? [];
    const i = zones.findIndex((z) => z.id === id);
    if (i < 0) throw new NetworkError(`No zone ${id}`);
    this.batch(() => {
      zones[i] = { ...zones[i], ...structuredClone(patch), id };
      this.evtEndpoints = true;
      this.markEdit();
    });
  }

  /** Remove a region and the access points it owns. */
  removeZone(id: Id): void {
    const zones = this.p.zones ?? [];
    if (!zones.some((z) => z.id === id)) throw new NetworkError(`No zone ${id}`);
    this.batch(() => {
      const kept = zones.filter((z) => z.id !== id);
      if (kept.length) this.p.zones = kept;
      else delete this.p.zones;
      this.p.endpoints = this.p.endpoints.filter((e) => e.regionId !== id);
      this.evtEndpoints = true;
      this.markEdit();
    });
  }

  /** Paint leaves with its road. A line that ran past it carries on as two lines. */
  private dropPaintOn(id: Id): void {
    const keep: Decal[] = [];
    for (const d of this.p.decals) {
      const ref = d.road;
      if (!ref?.pieces.some((p) => p.segmentId === id)) {
        keep.push(d);
        continue;
      }
      this.evtDecals = true;
      piecesWithout(ref.pieces, id).forEach((pieces, i) => {
        keep.push({ ...d, id: i === 0 ? d.id : this.p.nextId++, road: { ...ref, pieces } });
      });
    }
    this.p.decals = keep;
  }

  /**
   * Turn a road round in place: swap its ends and handles, keeping its id. Its
   * cross section rotates half a turn, so lanes stay as they are relative to travel
   * and overrides by lane index stay right. Anything measured across or along the
   * road is mirrored to stay where it is in the world. Signals and manual lane links
   * are regenerated for the new direction, and the report names what could not be.
   */
  reverseSegment(id: Id): ReverseReport {
    const seg = this.requireSegment(id);
    return this.batch(() => {
      const report: ReverseReport = { segmentId: id, changes: [], stranded: [], looksTheSame: isSymmetricRoad(this.roadTypeOf(id), seg.overrides) };
      const ends = [seg.a, seg.b];
      const count = boundaryOffsets(this.roadTypeOf(id), seg.overrides).length;
      const lanesNow = effectiveLanes(this.roadTypeOf(id), seg.overrides);
      for (const nodeId of ends) mirrorMarkings(this.requireNode(nodeId), id, count, lanesNow);
      mirrorSegmentMarkings(seg.overrides, id, count);
      if (seg.overrides.paintOff) seg.overrides.paintOff = mirrorPaintOff(seg.overrides.paintOff, lanesNow.length);
      const links = ends.map((nodeId) => mirrorLaneLinks(this, nodeId, id));
      for (const nodeId of ends) mirrorRulesOnReverse(this, nodeId, id);

      [seg.a, seg.b] = [seg.b, seg.a];
      [seg.c1, seg.c2] = [seg.c2, seg.c1];
      // A lane attach belongs to the node, and the host flips sides as the road turns round.
      const { attachA, attachB } = seg.overrides;
      if (attachA || attachB) {
        delete seg.overrides.attachA;
        delete seg.overrides.attachB;
        if (attachB) seg.overrides.attachA = { ...attachB, hostSide: attachB.hostSide === 1 ? -1 : 1 };
        if (attachA) seg.overrides.attachB = { ...attachA, hostSide: attachA.hostSide === 1 ? -1 : 1 };
      }
      // A lane alignment stays with its node; left and right swap as the road turns round.
      const { alignA, alignB } = seg.overrides;
      if (alignA || alignB) {
        const flip = (x: LaneAlign): LaneAlign => (x === 'left' ? 'right' : x === 'right' ? 'left' : 'centre');
        delete seg.overrides.alignA;
        delete seg.overrides.alignB;
        if (alignB) seg.overrides.alignA = flip(alignB);
        if (alignA) seg.overrides.alignB = flip(alignA);
      }
      // Walls and barriers stay on the same side in the world, so they swap sides of the road.
      if (seg.overrides.structure) seg.overrides.structure = mirrorStructure(seg.overrides.structure);
      if (seg.overrides.barriers) seg.overrides.barriers = mirrorBarriers(seg.overrides.barriers);
      if (seg.overrides.upgrades) seg.overrides.upgrades = mirrorUpgrades(seg.overrides.upgrades);
      this.touchSeg(id);
      for (const nodeId of ends) this.touchNode(nodeId);
      this.graphTopologyChanged = true;
      this.evtReversed.add(id);

      for (const ep of this.p.endpoints) {
        if (ep.segmentId !== id) continue;
        ep.t = flipT(ep.t);
        ep.side = ep.side === 1 ? -1 : 1;
        this.evtEndpoints = true;
      }
      for (const st of this.p.rail?.stations ?? []) {
        if (st.segmentId !== id) continue;
        st.t = flipT(st.t);
        // Left and right are seen from a to b, so they swap with the ends.
        if (st.layout) st.layout = mirrorSide(st.layout);
        if (st.building) st.building = mirrorSide(st.building);
        this.evtRail = true;
      }
      for (const d of this.p.decals) {
        if (d.road && flipPaintOn(d.road, id)) this.evtDecals = true;
      }
      for (const z of this.p.zones ?? []) {
        for (const a of z.anchors ?? []) {
          if (!a || a.segmentId !== id) continue;
          a.t = flipT(a.t);
          a.offset = -a.offset;
          this.evtEndpoints = true;
        }
      }

      ends.forEach((nodeId, i) => {
        reconcileLaneLinks(this, nodeId, id, links[i], report);
        reconcileSignal(this, nodeId, id, report);
      });
      report.stranded = strandedNodes(this, id);
      return report;
    });
  }

  private removeNodeInternal(id: Id): void {
    const node = this.requireNode(id);
    this.p.nodes.splice(this.p.nodes.indexOf(node), 1);
    this.nodeIndex.delete(id);
    this.dirtyNodes.delete(id);
    this.hashDirtyNodes.delete(id);
    this.nodeHash.remove(id);
    this.layouts.delete(id);
    this.nodeGeoms.delete(id);
    this.nodeLanes.delete(id);
    this.evtRemovedNodes.add(id);
    this.graph = null;
    this.graphTopologyChanged = true;
    this.pendingEdit = true;
    const before = this.p.endpoints.length;
    this.p.endpoints = this.p.endpoints.filter((e) => e.nodeId !== id);
    if (this.p.endpoints.length !== before) this.evtEndpoints = true;
  }

  /** Remove a node and every segment on it. */
  removeNode(id: Id): void {
    const node = this.requireNode(id);
    this.batch(() => {
      for (const seg of [...node.segments]) this.removeSegmentInternal(seg);
      if (this.nodeIndex.has(id)) this.removeNodeInternal(id);
    });
  }

  /**
   * Move a node. A straight road stays straight. A curved road keeps the direction
   * of its handles at both ends, so a smooth joint here stays smooth and the far
   * end is not disturbed. Handle lengths follow the change in chord length.
   */
  moveNode(id: Id, pos: Vec3): void {
    assertVec(pos, 'Node position');
    const node = this.requireNode(id);
    this.batch(() => {
      const oldPos = node.pos;
      const newPos = copy(pos);
      for (const segId of node.segments) {
        const seg = this.requireSegment(segId);
        const atA = seg.a === id;
        const far = this.requireNode(atA ? seg.b : seg.a).pos;
        const near = atA ? seg.c1 : seg.c2;
        const other = atA ? seg.c2 : seg.c1;
        const cubic: Cubic = { p0: oldPos, p1: near, p2: other, p3: far };
        let newNear: Vec3;
        let newOther: Vec3;
        if (isStraightCubic(cubic, 0.01)) {
          newNear = lerp(newPos, far, 1 / 3);
          newOther = lerp(newPos, far, 2 / 3);
        } else {
          const before = distXZ(oldPos, far);
          const after = distXZ(newPos, far);
          const k = before > 1e-6 ? clamp(after / before, 0.2, 5) : 1;
          const nearHandle = sub(near, oldPos);
          const otherHandle = sub(other, far);
          newNear = { x: newPos.x + nearHandle.x * k, y: newPos.y + nearHandle.y * k, z: newPos.z + nearHandle.z * k };
          newOther = { x: far.x + otherHandle.x * k, y: far.y + otherHandle.y * k, z: far.z + otherHandle.z * k };
        }
        seg.c1 = atA ? newNear : newOther;
        seg.c2 = atA ? newOther : newNear;
        this.touchSeg(segId);
      }
      node.pos = newPos;
      this.hashDirtyNodes.add(id);
      this.touchNode(id);
    });
  }

  /** Replace a segment's two Bezier controls. */
  setSegmentControls(id: Id, c1: Vec3, c2: Vec3): void {
    assertVec(c1, 'Control c1');
    assertVec(c2, 'Control c2');
    const seg = this.requireSegment(id);
    this.batch(() => {
      seg.c1 = copy(c1);
      seg.c2 = copy(c2);
      this.touchSeg(id);
    });
  }

  /** Change the road type of a segment, keeping its curve and direction. */
  setRoadType(id: Id, roadType: string): void {
    this.requireRoadType(roadType);
    const seg = this.requireSegment(id);
    this.batch(() => {
      const before = this.roadTypeOf(id).lanes;
      seg.roadType = roadType;
      const after = this.roadTypeOf(id).lanes;
      const same =
        before.length === after.length &&
        before.every((l, i) => l.dir === after[i].dir && l.kind === after[i].kind && Math.abs(l.offset - after[i].offset) < 1e-6 && Math.abs(l.width - after[i].width) < 1e-6);
      if (!same) {
        // Lane indices change meaning: the sim re-seats vehicles by position (sim/remap.ts).
        this.evtRelaid.add(id);
        this.graphTopologyChanged = true;
      }
      this.touchSeg(id);
    });
  }

  /** Merge fields into a segment's overrides. Set a field to undefined to clear it. */
  setSegmentOverrides(id: Id, patch: SegmentOverrides): void {
    const seg = this.requireSegment(id);
    this.batch(() => {
      const next: SegmentOverrides = { ...seg.overrides, ...structuredClone(patch) };
      for (const key of Object.keys(next) as (keyof SegmentOverrides)[]) {
        if (next[key] === undefined) delete next[key];
      }
      seg.overrides = next;
      this.touchSeg(id);
    });
  }

  /**
   * Merge fields into a node's junction control. Setting `laneLinks` replaces the
   * automatic connectors there; set it to null to go back to automatic.
   */
  /**
   * Set or clear (null) a junction's hand-edited shape. Trims, outline and
   * connectors follow. Unchecked: junctionShape.applyJunctionShape validates first.
   */
  setJunctionShape(id: Id, shape: JunctionShape | null): void {
    const node = this.requireNode(id);
    this.batch(() => {
      const next = normaliseShape(shape);
      if (next) node.control = { ...node.control, shape: next };
      else {
        const { shape: _drop, ...rest } = node.control;
        node.control = rest;
      }
      this.touchNode(id);
      // Kerbs moved at an arm end show on the road too, even when no trim changes.
      for (const s of node.segments) this.evtSegs.add(s);
    });
  }

  setJunctionControl(id: Id, patch: Partial<JunctionControl>): void {
    const node = this.requireNode(id);
    this.batch(() => {
      node.control = { ...node.control, ...structuredClone(patch) };
      this.touchNode(id);
    });
  }

  /** Set the sign on one incoming road. */
  setSign(nodeId: Id, segmentId: Id, sign: SignKind): void {
    const node = this.requireNode(nodeId);
    this.setJunctionControl(nodeId, { signs: { ...node.control.signs, [segmentId]: sign } });
  }

  /** Override the crosswalk on one arm. */
  setCrosswalk(nodeId: Id, segmentId: Id, style: CrosswalkStyle): void {
    const node = this.requireNode(nodeId);
    this.setJunctionControl(nodeId, { crosswalks: { ...node.control.crosswalks, [segmentId]: style } });
  }

  // -------------------------------------------------------------------------
  // Hand-placed markings at nodes
  // -------------------------------------------------------------------------

  /** Paint changes nothing a vehicle can see, so the lane graph is left alone. */
  private touchNodePaint(id: Id): void {
    this.evtNodes.add(id);
    this.markEdit();
  }

  private findMarking(nodeId: Id, id: Id): { node: RoadNode; index: number } {
    const node = this.requireNode(nodeId);
    const index = node.control.markings?.findIndex((m) => m.id === id) ?? -1;
    if (index < 0) throw new NetworkError(`No marking ${id} at node ${nodeId}`);
    return { node, index };
  }

  addNodeMarking(nodeId: Id, init: NodeMarkingInit): Id {
    const node = this.requireNode(nodeId);
    const anchors = init.kind === 'line' ? [init.from, init.to] : init.anchors;
    for (const a of anchors) {
      if (!node.segments.includes(a.segmentId)) throw new NetworkError(`Segment ${a.segmentId} is not at node ${nodeId}`);
    }
    return this.batch(() => {
      const id = this.p.nextId++;
      node.control.markings = [...(node.control.markings ?? []), { ...structuredClone(init), id } as NodeMarking];
      this.touchNodePaint(nodeId);
      const host: MarkingHost = { kind: 'node', id: nodeId };
      this.replaceStacked({ kind: 'marking', host, marking: { ...init, id } }, { kind: 'marking', host, id });
      return id;
    });
  }

  /** Merge fields into a marking. A marking's kind cannot change. */
  updateNodeMarking(
    nodeId: Id,
    id: Id,
    patch: Partial<Omit<NodeLineMarking, 'id' | 'kind'>> | Partial<Omit<NodeFillerMarking, 'id' | 'kind'>>,
  ): void {
    const { node, index } = this.findMarking(nodeId, id);
    this.batch(() => {
      const next = [...node.control.markings!];
      next[index] = dropUndefined({ ...next[index], ...structuredClone(patch), id, kind: next[index].kind }) as NodeMarking;
      node.control.markings = next;
      this.touchNodePaint(nodeId);
    });
  }

  removeNodeMarking(nodeId: Id, id: Id): void {
    const { node } = this.findMarking(nodeId, id);
    this.batch(() => {
      node.control.markings = node.control.markings!.filter((m) => m.id !== id);
      if (node.control.markings.length === 0) delete node.control.markings;
      this.touchNodePaint(nodeId);
    });
  }

  clearNodeMarkings(nodeId: Id): void {
    const node = this.requireNode(nodeId);
    if (!node.control.markings) return;
    this.batch(() => {
      delete node.control.markings;
      this.touchNodePaint(nodeId);
    });
  }

  /** Hide or restore the automatic stop lines and crosswalks at a node. */
  setHideAutoMarkings(nodeId: Id, hide: boolean): void {
    const node = this.requireNode(nodeId);
    this.batch(() => {
      if (hide) node.control.hideAutoMarkings = true;
      else delete node.control.hideAutoMarkings;
      this.touchNodePaint(nodeId);
    });
  }

  /**
   * Take one automatic marking away (`on` false) or bring it back. Arrows and stop
   * lines are painted with the road, so its ends repaint too.
   */
  setAutoMarking(nodeId: Id, ref: AutoMarkingRef, on: boolean): void {
    const node = this.requireNode(nodeId);
    for (const s of autoRefSegments(ref)) if (!node.segments.includes(s)) throw new NetworkError(`Segment ${s} is not at node ${nodeId}`);
    this.batch(() => {
      const list = (node.control.autoOff ?? []).filter((r) => !sameAutoRef(r, ref));
      if (!on) list.push(structuredClone(ref));
      if (list.length) node.control.autoOff = list;
      else delete node.control.autoOff;
      this.touchNodePaint(nodeId);
      for (const s of node.segments) this.evtSegs.add(s);
    });
  }

  /** Bring back every automatic marking taken away at a node, crosswalks too. */
  restoreAutoMarkings(nodeId: Id): void {
    const node = this.requireNode(nodeId);
    this.batch(() => {
      delete node.control.autoOff;
      for (const [seg, style] of Object.entries(node.control.crosswalks)) if (style === 'none') delete node.control.crosswalks[Number(seg)];
      delete node.control.hideAutoMarkings;
      this.touchNode(nodeId);
      for (const s of node.segments) this.evtSegs.add(s);
    });
  }

  // -------------------------------------------------------------------------
  // Markings along a segment, and either kind through one interface
  // -------------------------------------------------------------------------

  /** New ids for a copied list, with parts that name a crossing line following it. */
  freshMarkingIds(list: readonly NodeMarking[]): NodeMarking[] {
    const ids = new Map<Id, Id>();
    for (const m of list) ids.set(m.id, this.p.nextId++);
    return list.map((m) => {
      const copy = structuredClone(m);
      copy.id = ids.get(m.id)!;
      if (copy.kind === 'line' && copy.rules) {
        copy.rules = copy.rules.map((r) => ({
          ...r,
          from: 'cross' in r.from && ids.has(r.from.cross) ? { cross: ids.get(r.from.cross)! } : r.from,
          to: 'cross' in r.to && ids.has(r.to.cross) ? { cross: ids.get(r.to.cross)! } : r.to,
        }));
      }
      return copy;
    });
  }

  /** The markings of a node or a segment. */
  markingsOf(host: MarkingHost): readonly NodeMarking[] {
    if (host.kind === 'node') return this.getNode(host.id)?.control.markings ?? [];
    return this.getSegment(host.id)?.overrides.handMarkings ?? [];
  }

  pointsOf(host: MarkingHost): readonly MarkingPointSetting[] {
    if (host.kind === 'node') return this.getNode(host.id)?.control.markingPoints ?? [];
    return this.getSegment(host.id)?.overrides.markingPoints ?? [];
  }

  private touchHost(host: MarkingHost): void {
    if (host.kind === 'node') this.touchNodePaint(host.id);
    else {
      this.evtSegs.add(host.id);
      this.markEdit();
    }
  }

  private writeHost(host: MarkingHost, markings: NodeMarking[] | undefined, points?: MarkingPointSetting[]): void {
    if (host.kind === 'node') {
      const c = this.requireNode(host.id).control;
      if (markings) {
        if (markings.length) c.markings = markings;
        else delete c.markings;
      }
      if (points) {
        if (points.length) c.markingPoints = points;
        else delete c.markingPoints;
      }
    } else {
      const o = this.requireSegment(host.id).overrides;
      if (markings) {
        if (markings.length) o.handMarkings = markings;
        else delete o.handMarkings;
      }
      if (points) {
        if (points.length) o.markingPoints = points;
        else delete o.markingPoints;
      }
    }
    this.touchHost(host);
  }

  private checkHostAnchors(host: MarkingHost, anchors: readonly MarkingAnchor[]): void {
    if (host.kind === 'node') {
      const node = this.requireNode(host.id);
      for (const a of anchors) if (!node.segments.includes(a.segmentId)) throw new NetworkError(`Segment ${a.segmentId} is not at node ${host.id}`);
    } else {
      this.requireSegment(host.id);
      for (const a of anchors) {
        if (a.segmentId !== host.id || (a.end !== 'a' && a.end !== 'b')) throw new NetworkError(`Anchor is not on an end of segment ${host.id}`);
      }
    }
  }

  addMarking(host: MarkingHost, init: NodeMarkingInit): Id {
    if (host.kind === 'node') return this.addNodeMarking(host.id, init);
    this.checkHostAnchors(host, init.kind === 'line' ? [init.from, init.to] : init.anchors);
    return this.batch(() => {
      const id = this.p.nextId++;
      this.writeHost(host, [...this.markingsOf(host), { ...structuredClone(init), id } as NodeMarking]);
      this.replaceStacked({ kind: 'marking', host, marking: { ...init, id } }, { kind: 'marking', host, id });
      return id;
    });
  }

  updateMarking(
    host: MarkingHost,
    id: Id,
    patch: Partial<Omit<NodeLineMarking, 'id' | 'kind'>> | Partial<Omit<NodeFillerMarking, 'id' | 'kind'>>,
  ): void {
    if (host.kind === 'node') {
      this.updateNodeMarking(host.id, id, patch);
      return;
    }
    const list = this.markingsOf(host);
    const index = list.findIndex((m) => m.id === id);
    if (index < 0) throw new NetworkError(`No marking ${id} on segment ${host.id}`);
    const p = patch as Partial<NodeLineMarking>;
    const anchors = [p.from, p.to, ...((patch as Partial<NodeFillerMarking>).anchors ?? [])].filter((a): a is MarkingAnchor => !!a);
    this.checkHostAnchors(host, anchors);
    this.batch(() => {
      const next = [...list];
      next[index] = dropUndefined({ ...next[index], ...structuredClone(patch), id, kind: next[index].kind }) as NodeMarking;
      this.writeHost(host, next);
    });
  }

  removeMarking(host: MarkingHost, id: Id): void {
    if (host.kind === 'node') {
      this.removeNodeMarking(host.id, id);
      return;
    }
    const list = this.markingsOf(host);
    if (!list.some((m) => m.id === id)) throw new NetworkError(`No marking ${id} on segment ${host.id}`);
    this.batch(() => this.writeHost(host, list.filter((m) => m.id !== id)));
  }

  /** Replace all markings of a node or segment, and optionally its point settings, in one go. */
  setMarkings(host: MarkingHost, markings: readonly NodeMarking[], points?: readonly MarkingPointSetting[]): void {
    const anchors = markings.flatMap((m) => (m.kind === 'line' ? [m.from, m.to] : m.anchors));
    this.checkHostAnchors(host, anchors);
    this.batch(() => this.writeHost(host, structuredClone([...markings]), points ? structuredClone([...points]) : undefined));
  }

  /** Change one point's offset, side or switch. A setting with nothing left in it is dropped. */
  setMarkingPoint(host: MarkingHost, setting: MarkingPointSetting): void {
    this.checkHostAnchors(host, [{ segmentId: setting.segmentId, boundary: setting.boundary, ...(setting.end ? { end: setting.end } : {}) }]);
    this.batch(() => {
      const same = (p: MarkingPointSetting) => p.segmentId === setting.segmentId && p.boundary === setting.boundary && p.end === setting.end;
      const list = this.pointsOf(host).filter((p) => !same(p));
      const clean = dropUndefined({ ...structuredClone(setting) }) as MarkingPointSetting;
      if (!clean.offset) delete clean.offset;
      if (clean.offset !== undefined || clean.place || clean.off) list.push(clean);
      this.writeHost(host, undefined, list);
    });
  }

  /** Keep a preset or template in the map, so it travels with it. Same id replaces. */
  saveToLibrary(item: { preset: MarkingPreset } | { template: MarkingTemplate }): void {
    this.batch(() => {
      const lib: MarkingLibrary = structuredClone(this.p.markingLibrary ?? {});
      if ('preset' in item) lib.presets = [...(lib.presets ?? []).filter((p) => p.id !== item.preset.id), structuredClone(item.preset)];
      else lib.templates = [...(lib.templates ?? []).filter((t) => t.id !== item.template.id), structuredClone(item.template)];
      this.p.markingLibrary = lib;
      this.evtSettings = true;
      this.markEdit();
    });
  }

  get markingLibrary(): Readonly<MarkingLibrary> {
    return this.p.markingLibrary ?? {};
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private anchorPosition(anchor: RoadAnchor): Vec3 {
    switch (anchor.kind) {
      case 'node':
        return this.requireNode(anchor.id).pos;
      case 'segment':
        if (!Number.isFinite(anchor.t)) throw new NetworkError('Road end needs a position along the segment');
        return cubicPoint(this.cubicOf(anchor.id), clamp(anchor.t, 0, 1));
      case 'free':
        assertVec(anchor.pos, 'Road end');
        return anchor.pos;
    }
  }

  private draftCubic(start: RoadAnchor, end: RoadAnchor, c1?: Vec3, c2?: Vec3, startAttach?: RampAttach, endAttach?: RampAttach, roadType?: string): Cubic {
    let p0 = this.anchorPosition(start);
    let p3 = this.anchorPosition(end);
    const lanes = roadType ? this.requireRoadType(roadType).lanes : undefined;
    if (startAttach) {
      const dir = normalizeXZ(sub(c1 && distXZ(c1, p0) > 1e-3 ? c1 : p3, p0));
      p0 = this.anchorAttachPoint(start, startAttach, dir, lanes) ?? p0;
    }
    if (endAttach) {
      const dir = normalizeXZ(sub(p3, c2 && distXZ(c2, p3) > 1e-3 ? c2 : p0));
      p3 = this.anchorAttachPoint(end, endAttach, dir, lanes) ?? p3;
    }
    const fallback = straightCubic(p0, p3);
    return { p0, p1: c1 ?? fallback.p1, p2: c2 ?? fallback.p2, p3 };
  }

  /** Where a road end attached to a lane at an anchor lands, or null when there is no host. */
  anchorAttachPoint(anchor: RoadAnchor, attach: RampAttach, rampDir: Vec3, rampLanes?: readonly LaneDef[]): Vec3 | null {
    // An edge merge at an existing node sits beside the narrower host road there.
    if (anchor.kind === 'node' && attach.edge && !attach.lanes && rampLanes) return edgeAttachPoint(this.attachAccess, null, anchor.id, attach, rampDir, rampLanes);
    let host: Segment | null = null;
    let hostDir: Vec3 | null = null;
    let pos: Vec3;
    if (anchor.kind === 'segment') {
      host = this.getSegment(anchor.id) ?? null;
      if (!host) return null;
      const c = this.cubicOf(anchor.id);
      const t = clamp(anchor.t, 0, 1);
      pos = cubicPoint(c, t);
      hostDir = cubicTangentXZ(c, t);
    } else if (anchor.kind === 'node') {
      const node = this.getNode(anchor.id);
      host = pickHost(this.attachAccess, anchor.id, -1);
      if (!node || !host) return null;
      pos = node.pos;
      hostDir = hostDirection(this.attachAccess, host, anchor.id);
      if (!hostDir) return null;
    } else {
      return null;
    }
    return attachPointFrom(pos, hostDir, effectiveLanes(this.requireRoadType(host.roadType), host.overrides), attach, rampDir, rampLanes);
  }

  /**
   * Existing roads a proposed curve crosses, ordered along it. A crossing within
   * 0.5 m of a node in `ignoreAt` is left out when the existing road is attached
   * to that node, since that is just where the curve joins it.
   */
  findCrossings(cubic: Cubic, ignoreAt: readonly Id[] = [], roadType?: string): CrossingInfo[] {
    const draftDef = roadType ? this.roadType(roadType) : undefined;
    const out: CrossingInfo[] = [];
    const xs = [cubic.p0.x, cubic.p1.x, cubic.p2.x, cubic.p3.x];
    const zs = [cubic.p0.z, cubic.p1.z, cubic.p2.z, cubic.p3.z];
    const box: Region = {
      minX: Math.min(...xs),
      minZ: Math.min(...zs),
      maxX: Math.max(...xs),
      maxZ: Math.max(...zs),
    };
    for (const id of this.segmentsInRegion(box, true)) {
      const seg = this.requireSegment(id);
      for (const hit of intersectCubicsXZ(cubic, this.cubicOf(id))) {
        let attached = false;
        for (const nodeId of ignoreAt) {
          if ((seg.a === nodeId || seg.b === nodeId) && distXZ(this.requireNode(nodeId).pos, hit.point) < 0.5) {
            attached = true;
          }
        }
        if (attached) continue;
        const onSeg = cubicPoint(this.cubicOf(id), hit.tb);
        const clearance = Math.abs(hit.point.y - onSeg.y);
        const required = draftDef ? crossingClearance(this, draftDef, hit.point.y, id, onSeg.y) : GRADE_CLEARANCE;
        out.push({
          segmentId: id,
          t: hit.ta,
          segmentT: hit.tb,
          point: { x: onSeg.x, y: onSeg.y, z: onSeg.z },
          clearance,
          // The tolerance keeps a crossing at exactly the limit on the separated side.
          atGrade: clearance < required - 1e-6,
          required,
          ...(this.roadTypeOf(id).category === 'rail' ? { overRail: true } : {}),
        });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * Draw a road. Each end may be an existing node, a point on a segment (which is
   * split there) or free space. Every same-grade crossing splits both roads at a
   * new junction node; a crossing with GRADE_CLEARANCE or more is left alone.
   *
   * Throws NetworkError for a road with no length. Check validateDraft first.
   */
  drawRoad(params: DrawRoadParams): DrawRoadResult {
    const { start, end, roadType, overrides } = params;
    this.requireRoadType(roadType);
    if (params.c1) assertVec(params.c1, 'Control c1');
    if (params.c2) assertVec(params.c2, 'Control c2');
    const startAttach = start.kind === 'free' ? undefined : params.startAttach;
    const endAttach = end.kind === 'free' ? undefined : params.endAttach;
    const draft = this.draftCubic(start, end, params.c1, params.c2, startAttach, endAttach, params.roadType);
    const polygon = dist(draft.p0, draft.p1) + dist(draft.p1, draft.p2) + dist(draft.p2, draft.p3);
    if (polygon < MIN_SEGMENT_LENGTH) throw new NetworkError('A road needs some length');
    // Crossings of a highway that were there before keep how they work (core/highwayCrossing.ts).
    const xs = [draft.p0.x, draft.p1.x, draft.p2.x, draft.p3.x];
    const zs = [draft.p0.z, draft.p1.z, draft.p2.z, draft.p3.z];
    const reach = NODE_SNAP + 1;
    const crossingsBefore = new Set(
      this.nodesInRegion({ minX: Math.min(...xs) - reach, minZ: Math.min(...zs) - reach, maxX: Math.max(...xs) + reach, maxZ: Math.max(...zs) + reach }).filter((id) =>
        crossingShaped(this, id),
      ),
    );

    return this.batch(() => {
      const freeNodes = new Set<Id>();
      const { startNode, endNode } = this.resolveAnchors(start, end, freeNodes);
      // An attached end starts on its lane's edge, which is where the drawn curve starts.
      const p0 = startAttach ? draft.p0 : this.requireNode(startNode).pos;
      const p3 = endAttach ? draft.p3 : this.requireNode(endNode).pos;
      const cubic: Cubic = { p0, p1: draft.p1, p2: draft.p2, p3 };
      const attachFor = (from: { node: Id; t: number }, to: { node: Id; t: number }) => ({
        a: from.t === 0 && from.node === startNode ? startAttach : undefined,
        b: to.t === 1 && to.node === endNode ? endAttach : undefined,
      });

      const hits = this.findCrossings(cubic, [startNode, endNode], roadType).filter((h) => h.atGrade);
      const stops = this.cutCrossedSegments(hits);

      // Assemble the chain of nodes along the new road.
      const chain: { node: Id; t: number }[] = [{ node: startNode, t: 0 }];
      for (const stop of stops.sort((a, b) => a.t - b.t)) {
        const last = chain[chain.length - 1];
        if (stop.node === last.node) continue;
        const pos = cubicPoint(cubic, stop.t);
        const tooClose = distXZ(pos, this.requireNode(last.node).pos) < NODE_SNAP;
        if (tooClose && chain.length === 1 && freeNodes.has(last.node)) {
          // A free end landing just past an existing road starts from that road.
          last.node = stop.node;
          last.t = stop.t;
          continue;
        }
        chain.push({ node: stop.node, t: stop.t });
      }
      const tail = chain[chain.length - 1];
      const endPos = this.requireNode(endNode).pos;
      const landsOnTail = distXZ(this.requireNode(tail.node).pos, endPos) < NODE_SNAP && freeNodes.has(endNode);
      if (chain.length > 1 && (tail.node === endNode || landsOnTail)) {
        tail.t = 1;
      } else {
        chain.push({ node: endNode, t: 1 });
      }

      const result: DrawRoadResult = { segments: [], nodes: [], junctions: stops.map((s) => s.node) };
      const seen = new Set<Id>();
      result.junctions = result.junctions.filter((id) => !seen.has(id) && !!seen.add(id));
      const pieceOverrides = overrides ?? {};
      for (let i = 0; i + 1 < chain.length; i++) {
        const from = chain[i];
        const to = chain[i + 1];
        if (from.node === to.node) {
          // A closed loop needs a node of its own, because a segment has two ends.
          if (to.t - from.t < 1e-3) continue;
          const mt = (from.t + to.t) / 2;
          const mid = this.createNode(cubicPoint(cubic, mt));
          const ends = attachFor(from, to);
          this.addPiece(cubic, from.t, mt, from.node, mid, roadType, pieceOverrides, result, { a: ends.a });
          this.addPiece(cubic, mt, to.t, mid, to.node, roadType, pieceOverrides, result, { b: ends.b });
        } else {
          this.addPiece(cubic, from.t, to.t, from.node, to.node, roadType, pieceOverrides, result, attachFor(from, to));
        }
      }

      for (const id of freeNodes) {
        const node = this.nodeIndex.get(id);
        if (node && node.segments.length === 0) this.removeNodeInternal(id);
      }
      const nodes: Id[] = [];
      for (const segId of result.segments) {
        const seg = this.requireSegment(segId);
        if (!nodes.length) nodes.push(seg.a);
        nodes.push(seg.b);
      }
      result.nodes = nodes;
      // A road drawn across a highway at grade makes a crossing, not a right-in, right-out junction.
      tagNewCrossings(this, new Set([...nodes, ...result.junctions]), crossingsBefore);
      return result;
    });
  }

  private resolveAnchors(start: RoadAnchor, end: RoadAnchor, freeNodes: Set<Id>): { startNode: Id; endNode: Id } {
    const resolve = (anchor: RoadAnchor): Id => {
      if (anchor.kind === 'node') return anchor.id;
      if (anchor.kind === 'segment') return this.splitInternal(anchor.id, clamp(anchor.t, 0, 1)).node;
      const id = this.createNode(anchor.pos);
      freeNodes.add(id);
      return id;
    };
    if (start.kind === 'segment' && end.kind === 'segment' && start.id === end.id) {
      // Both ends on one road: split the later point first so the earlier t still holds.
      if (start.t === end.t) {
        const node = resolve(start);
        return { startNode: node, endNode: node };
      }
      const later = start.t > end.t ? start : end;
      const earlier = later === start ? end : start;
      const laterNode = resolve(later);
      const earlierNode = this.splitInternal(earlier.id, clamp(earlier.t / later.t, 0, 1)).node;
      return later === start
        ? { startNode: laterNode, endNode: earlierNode }
        : { startNode: earlierNode, endNode: laterNode };
    }
    const startNode = resolve(start);
    if (start.kind === 'free' && end.kind === 'free' && dist(start.pos, end.pos) < MIN_SEGMENT_LENGTH) {
      return { startNode, endNode: startNode }; // A loop drawn in free space.
    }
    return { startNode, endNode: resolve(end) };
  }

  /** Split existing roads at the given crossings. Returns where the new road stops. */
  private cutCrossedSegments(hits: CrossingInfo[]): { node: Id; t: number }[] {
    const stops: { node: Id; t: number }[] = [];
    const bySeg = new Map<Id, CrossingInfo[]>();
    for (const h of hits) {
      const list = bySeg.get(h.segmentId);
      if (list) list.push(h);
      else bySeg.set(h.segmentId, [h]);
    }
    for (const [segId, list] of bySeg) {
      list.sort((a, b) => b.segmentT - a.segmentT);
      // Work from the far end: the original id keeps the a side, so the
      // remaining parameters only need rescaling by the last split.
      let upper = 1;
      for (const hit of list) {
        const seg = this.requireSegment(segId);
        const curve = this.curveOf(segId);
        const localT = hit.segmentT / upper;
        const s = tToLength(curve, localT);
        let nodeId: Id;
        if (s < NODE_SNAP) {
          nodeId = seg.a;
        } else if (curve.length - s < NODE_SNAP) {
          nodeId = seg.b;
        } else {
          nodeId = this.splitInternal(segId, localT).node;
          upper = hit.segmentT;
        }
        stops.push({ node: nodeId, t: hit.t });
      }
    }
    return stops;
  }

  /** Add the part of the drawn curve between two nodes, bent to meet them exactly. */
  private addPiece(
    cubic: Cubic,
    t0: number,
    t1: number,
    a: Id,
    b: Id,
    roadType: string,
    overrides: SegmentOverrides,
    result: DrawRoadResult,
    attach: { a?: RampAttach; b?: RampAttach } = {},
  ): void {
    if (t1 - t0 < 1e-6) return;
    const piece = subCubic(cubic, t0, t1);
    const pa = this.requireNode(a).pos;
    const pb = this.requireNode(b).pos;
    if (dist(pa, pb) < MIN_SEGMENT_LENGTH && dist(piece.p1, piece.p0) + dist(piece.p2, piece.p3) < MIN_SEGMENT_LENGTH) {
      return;
    }
    const own = structuredClone(overrides);
    delete own.attachA;
    delete own.attachB;
    if (attach.a) own.attachA = { ...attach.a };
    if (attach.b) own.attachB = { ...attach.b };
    // An attached end is already where the curve starts, so its handle stays put.
    const c1 = attach.a ? { ...piece.p1 } : add(piece.p1, sub(pa, piece.p0));
    const c2 = attach.b ? { ...piece.p2 } : add(piece.p2, sub(pb, piece.p3));
    const id = this.createSegment(a, b, c1, c2, roadType, own);
    if (attach.a || attach.b) {
      // Close any rounding between the drawn end and where the attach puts it.
      const real = this.cubicOf(id);
      const seg = this.requireSegment(id);
      if (attach.a) seg.c1 = add(c1, sub(real.p0, piece.p0));
      if (attach.b) seg.c2 = add(c2, sub(real.p3, piece.p3));
      this.touchSeg(id);
    }
    result.segments.push(id);
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Problems with a proposed road, without changing anything. An empty list means
   * good to go. `severity: 'error'` should block the placement.
   */
  validateDraft(draft: Omit<DrawRoadParams, 'overrides'>): DraftIssue[] {
    const issues: DraftIssue[] = [];
    const def = this.requireRoadType(draft.roadType);
    const startAttach = draft.start.kind === 'free' ? undefined : draft.startAttach;
    const endAttach = draft.end.kind === 'free' ? undefined : draft.endAttach;
    const cubic = this.draftCubic(draft.start, draft.end, draft.c1, draft.c2, startAttach, endAttach, draft.roadType);
    const curve = buildSegmentCurve(cubic);
    const L = curve.length;

    if (L < MIN_SEGMENT_LENGTH) {
      issues.push({ code: 'zeroLength', severity: 'error', message: 'The road has no length.', at: cubic.p0 });
      return issues;
    }
    const minLength = Math.max(MIN_DRAFT_LENGTH, def.halfWidth);
    if (L < minLength) {
      issues.push({
        code: 'tooShort',
        severity: 'error',
        message: `Too short: ${L.toFixed(1)} m, needs at least ${minLength.toFixed(1)} m.`,
        at: cubic.p0,
      });
    }

    const grade = maxGrade(cubic);
    const warnAt =
      def.category === 'ramp' ? STEEP_WARN_RAMP : def.category === 'highway' ? STEEP_WARN_HIGHWAY : STEEP_WARN_OTHER;
    if (grade > STEEP_HARD) {
      issues.push({
        code: 'tooSteep',
        severity: 'error',
        message: `Too steep: ${pct(grade)} grade, the limit is ${pct(STEEP_HARD)}.`,
      });
    } else if (grade > warnAt) {
      issues.push({
        code: 'tooSteep',
        severity: 'warning',
        message: `Steep: ${pct(grade)} grade, over the ${pct(warnAt)} advised for this road.`,
      });
    }

    let kappa = 0;
    let tightT = 0;
    for (let i = 0; i <= 64; i++) {
      const k = Math.abs(curvatureXZ(cubic, i / 64));
      if (k > kappa) {
        kappa = k;
        tightT = i / 64;
      }
    }
    const radius = kappa > 1e-9 ? 1 / kappa : Infinity;
    const tightest = cubicPoint(cubic, tightT);
    const minRadius = totalHalfWidth(def) * 1.25;
    if (radius < minRadius) {
      issues.push({
        code: 'tightCurve',
        severity: 'error',
        message: `Curve too tight: ${radius.toFixed(1)} m radius, this road needs ${minRadius.toFixed(1)} m.`,
        at: tightest,
      });
    } else if (def.category === 'highway' || def.category === 'ramp') {
      const v = def.speedKmh;
      const comfortable = (v * v) / (127 * 0.35);
      if (radius < comfortable) {
        issues.push({
          code: 'tightCurve',
          severity: 'warning',
          message: `Tight for ${v} km/h: ${radius.toFixed(0)} m radius, ${comfortable.toFixed(0)} m advised.`,
          at: tightest,
        });
      }
    }

    let outside = false;
    let badElevation = false;
    const samples: Vec3[] = [];
    const steps = clamp(Math.ceil(L / 5), 16, 200);
    for (let i = 0; i <= steps; i++) {
      const p = cubicPoint(cubic, i / steps);
      samples.push(p);
      if (Math.abs(p.x) > MAP_HALF_SIZE || Math.abs(p.z) > MAP_HALF_SIZE) outside = true;
      if (p.y < MIN_ELEVATION || p.y > MAX_ELEVATION) badElevation = true;
    }
    if (outside) {
      issues.push({ code: 'outOfBounds', severity: 'error', message: 'The road leaves the map.' });
    }
    if (badElevation) {
      issues.push({
        code: 'elevationRange',
        severity: 'error',
        message: `Elevation must stay between ${MIN_ELEVATION} m and ${MAX_ELEVATION} m.`,
      });
    }

    if (selfCrosses(cubic)) {
      issues.push({ code: 'selfCrossing', severity: 'error', message: 'The road crosses itself.' });
    }

    const anchorNodes = [draft.start, draft.end].flatMap((a) => (a.kind === 'node' ? [a.id] : []));
    const anchorSegs = [draft.start, draft.end].flatMap((a) => (a.kind === 'segment' ? [a.id] : []));
    for (const hit of this.findCrossings(cubic, anchorNodes, draft.roadType)) {
      const nearEnd = Math.min(hit.t, 1 - hit.t) * L < 0.5;
      if (anchorSegs.includes(hit.segmentId) && nearEnd) continue;
      if (hit.atGrade && hit.clearance > LEVEL_TOLERANCE) {
        const what = hit.overRail ? 'track' : 'a road';
        issues.push({
          code: 'insufficientClearance',
          severity: 'error',
          message: `Only ${hit.clearance.toFixed(1)} m clearance ${hit.point.y < cubicPoint(cubic, hit.t).y ? 'over' : 'under'} ${what}, ${hit.required} m is needed.`,
          at: hit.point,
        });
      } else if (hit.atGrade && !nearEnd && !hit.overRail && def.category !== 'rail' && !issues.some((i) => i.code === 'atGradeHighway')) {
        // Crossing a highway at grade works (core/highwayCrossing.ts), but it stops the highway.
        const other = this.roadTypeOf(hit.segmentId).category;
        if ((other === 'highway') !== (def.category === 'highway')) {
          issues.push({
            code: 'atGradeHighway',
            severity: 'warning',
            message: `Crosses a highway at grade: traffic lights will stop the highway here. Raise or lower the road ${GRADE_CLEARANCE} m to bridge it instead.`,
            at: hit.point,
          });
        }
      }
    }

    // Surfaces lying on top of each other, which crossings alone miss.
    const overlaps = draftOverlapIssues(this, def, cubic, draft.start, draft.end);
    issues.push(...overlaps);
    if (!overlaps.length) this.checkParallel(def, cubic, samples, draft.start, draft.end, issues);
    issues.push(...this.rampIssues(def, cubic, draft.start, draft.end, startAttach, endAttach));
    issues.push(...railDraftIssues(this, def, cubic, curve.length, draft.start, draft.end, radius));
    return issues;
  }

  /** How each end of a draft meets a highway: against its traffic, or at grade. */
  private rampIssues(def: RoadTypeDef, cubic: Cubic, start: RoadAnchor, end: RoadAnchor, startAttach?: RampAttach, endAttach?: RampAttach): DraftIssue[] {
    const out: DraftIssue[] = [];
    for (const [anchor, leaving] of [[start, true], [end, false]] as const) {
      const attach = leaving ? startAttach : endAttach;
      let host: Segment | null = null;
      let hostDir: Vec3 | null = null;
      if (anchor.kind === 'segment') {
        host = this.getSegment(anchor.id) ?? null;
        if (host) hostDir = cubicTangentXZ(this.nodeCubicOf(host.id), clamp(anchor.t, 0, 1));
      } else if (anchor.kind === 'node') {
        const node = this.getNode(anchor.id);
        // Carrying on from a road's dead end is not joining it.
        if (!node || node.segments.length < 2) continue;
        host = pickHost(this.attachAccess, anchor.id, -1);
        if (host) hostDir = hostDirection(this.attachAccess, host, anchor.id);
      }
      if (!host || !hostDir) continue;
      const pos = leaving ? cubic.p0 : cubic.p3;
      for (const issue of rampEndIssues(def, cubic, { hostDef: this.requireRoadType(host.roadType), hostDir, pos, leaving, attach })) {
        // Both ends joining a highway at grade is one piece of advice, not two.
        if (!out.some((o) => o.message === issue.message)) out.push(issue);
      }
    }
    return out;
  }

  private checkParallel(
    def: RoadTypeDef,
    cubic: Cubic,
    samples: Vec3[],
    start: RoadAnchor,
    end: RoadAnchor,
    issues: DraftIssue[],
  ): void {
    const ownNodes = new Set<Id>();
    const ownSegs = new Set<Id>();
    for (const a of [start, end]) {
      if (a.kind === 'node') ownNodes.add(a.id);
      if (a.kind === 'segment') {
        ownSegs.add(a.id);
        const seg = this.getSegment(a.id);
        if (seg) {
          ownNodes.add(seg.a);
          ownNodes.add(seg.b);
        }
      }
    }
    const reach = def.halfWidth + 30;
    const seen = new Set<Id>();
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const nearby = this.segmentsInRegion(
        { minX: p.x - reach, minZ: p.z - reach, maxX: p.x + reach, maxZ: p.z + reach },
        true,
      );
      for (const id of nearby) {
        if (seen.has(id) || ownSegs.has(id)) continue;
        const seg = this.requireSegment(id);
        const other = this.cubicOf(id);
        const hit = closestPointOnCubic(other, p);
        const otherDef = this.requireRoadType(seg.roadType);
        const sum = def.halfWidth + otherDef.halfWidth;
        if (hit.distance >= sum + 1) continue;
        const onDraft = i / (samples.length - 1);
        const tangent = cubicTangentXZ(cubic, onDraft);
        const otherTangent = cubicTangentXZ(other, hit.t);
        const angle = Math.acos(clamp(Math.abs(dotXZ(tangent, otherTangent)), 0, 1));
        if (angle > PARALLEL_ANGLE) continue;
        if (Math.abs(hit.point.y - p.y) >= crossingClearance(this, def, p.y, id, hit.point.y)) continue;
        // Roads leaving a shared node are side by side for a while by design.
        const sharesNode = [seg.a, seg.b].find((n) => ownNodes.has(n));
        if (sharesNode !== undefined && distXZ(this.requireNode(sharesNode).pos, p) < PARALLEL_GRACE) continue;
        seen.add(id);
        // Real overlaps are draftOverlapIssues' to report.
        if (hit.distance < sum) continue;
        issues.push({
          code: 'tooClose',
          severity: 'warning',
          message: `Only ${(hit.distance - sum).toFixed(1)} m from a nearly parallel road.`,
          at: p,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private flushHash(): void {
    for (const id of this.hashDirtySegs) {
      if (!this.segIndex.has(id)) continue;
      const st = this.curveOf(id).stations;
      const xz = new Float64Array(st.length * 2);
      for (let i = 0; i < st.length; i++) {
        xz[i * 2] = st[i].pos.x;
        xz[i * 2 + 1] = st[i].pos.z;
      }
      this.segHash.setPolyline(id, xz);
    }
    this.hashDirtySegs.clear();
    for (const id of this.hashDirtyNodes) {
      const n = this.nodeIndex.get(id);
      if (n) this.nodeHash.setPoint(id, n.pos.x, n.pos.z);
    }
    this.hashDirtyNodes.clear();
  }

  /**
   * Segments touching a plan-view box. `loose` skips the exact check and returns
   * the hash cells' contents, which is a superset; use it for candidate lists.
   */
  segmentsInRegion(region: Region, loose = false): Id[] {
    this.flushHash();
    const found = this.segHash.query(region.minX, region.minZ, region.maxX, region.maxZ);
    if (loose) return [...found];
    const out: Id[] = [];
    for (const id of found) {
      const st = this.curveOf(id).stations;
      for (let i = 0; i + 1 < st.length; i++) {
        if (chordTouchesBox(st[i].pos, st[i + 1].pos, region)) {
          out.push(id);
          break;
        }
      }
    }
    return out;
  }

  nodesInRegion(region: Region): Id[] {
    this.flushHash();
    const out: Id[] = [];
    for (const id of this.nodeHash.query(region.minX, region.minZ, region.maxX, region.maxZ)) {
      const p = this.requireNode(id).pos;
      if (p.x >= region.minX && p.x <= region.maxX && p.z >= region.minZ && p.z <= region.maxZ) out.push(id);
    }
    return out;
  }

  /** Nearest node in plan view, or null if none lies within maxDistance. */
  nearestNode(pos: Vec3, maxDistance = Infinity): { nodeId: Id; distance: number } | null {
    this.flushHash();
    let best: { nodeId: Id; distance: number } | null = null;
    const search = (reach: number) => {
      const ids = this.nodeHash.query(pos.x - reach, pos.z - reach, pos.x + reach, pos.z + reach);
      for (const id of ids) {
        const d = distXZ(this.requireNode(id).pos, pos);
        if (d <= maxDistance && (!best || d < best.distance)) best = { nodeId: id, distance: d };
      }
    };
    expandingSearch(maxDistance, () => best?.distance ?? null, search);
    return best;
  }

  /** Nearest road centreline in plan view, or null if none lies within maxDistance. */
  nearestSegment(pos: Vec3, maxDistance = Infinity): NearestSegment | null {
    this.flushHash();
    let best: NearestSegment | null = null;
    const tested = new Set<Id>();
    const search = (reach: number) => {
      const ids = this.segHash.query(pos.x - reach, pos.z - reach, pos.x + reach, pos.z + reach);
      for (const id of ids) {
        if (tested.has(id)) continue;
        tested.add(id);
        const c = this.cubicOf(id);
        const hit = closestPointOnCubic(c, pos);
        if (hit.distance > maxDistance) continue;
        if (best && hit.distance >= best.distance) continue;
        const right = rightOf(cubicTangentXZ(c, hit.t));
        best = {
          segmentId: id,
          t: hit.t,
          point: hit.point,
          distance: hit.distance,
          lateral: (pos.x - hit.point.x) * right.x + (pos.z - hit.point.z) * right.z,
        };
      }
    };
    expandingSearch(maxDistance, () => best?.distance ?? null, search);
    return best;
  }

  /** Nodes with exactly one road, where a gateway can sit. The end of a track is not one. */
  deadEnds(): Id[] {
    return this.p.nodes
      .filter((n) => n.segments.length === 1 && this.roadTypeOf(n.segments[0]).category !== 'rail')
      .map((n) => n.id);
  }

  // -------------------------------------------------------------------------
  // Endpoints and decals
  // -------------------------------------------------------------------------

  addEndpoint(init: EndpointInit): Id {
    return this.batch(() => {
      const id = this.p.nextId++;
      const ep: TrafficEndpoint = {
        id,
        kind: init.kind,
        name: init.name ?? '',
        enabled: init.enabled ?? true,
        nodeId: init.nodeId ?? null,
        segmentId: init.segmentId ?? null,
        t: init.t ?? 0.5,
        side: init.side ?? 1,
        ratePerHour: init.ratePerHour ?? 300,
        attraction: init.attraction ?? 1,
        mix: init.mix ?? defaultVehicleMix(),
        ...(init.regionId !== undefined ? { regionId: init.regionId } : {}),
      };
      this.assertEndpointRefs(ep);
      this.p.endpoints.push(ep);
      this.evtEndpoints = true;
      this.markEdit();
      return id;
    });
  }

  private assertEndpointRefs(ep: TrafficEndpoint): void {
    if (ep.nodeId !== null) this.requireNode(ep.nodeId);
    if (ep.segmentId !== null) this.requireSegment(ep.segmentId);
  }

  updateEndpoint(id: Id, patch: Partial<Omit<TrafficEndpoint, 'id'>>): void {
    const i = this.p.endpoints.findIndex((e) => e.id === id);
    if (i < 0) throw new NetworkError(`No endpoint ${id}`);
    const next = { ...this.p.endpoints[i], ...patch, id };
    this.assertEndpointRefs(next);
    this.batch(() => {
      this.p.endpoints[i] = next;
      this.evtEndpoints = true;
      this.markEdit();
    });
  }

  removeEndpoint(id: Id): void {
    if (!this.p.endpoints.some((e) => e.id === id)) throw new NetworkError(`No endpoint ${id}`);
    this.batch(() => {
      this.p.endpoints = this.p.endpoints.filter((e) => e.id !== id);
      this.evtEndpoints = true;
      this.markEdit();
    });
  }

  // -------------------------------------------------------------------------
  // Stations and train lines
  // -------------------------------------------------------------------------

  /** The stations and lines. Empty lists until something is placed. */
  get rail(): Readonly<RailData> {
    return this.p.rail ?? EMPTY_RAIL;
  }

  private railData(): RailData {
    this.p.rail ??= { stations: [], lines: [] };
    return this.p.rail;
  }

  /** Removes matching stations and takes them out of every line. */
  private dropStations(match: (st: RailStation) => boolean): void {
    const rail = this.p.rail;
    if (!rail) return;
    const gone = rail.stations.filter(match).map((s) => s.id);
    if (!gone.length) return;
    rail.stations = rail.stations.filter((s) => !gone.includes(s.id));
    for (const line of rail.lines) line.stops = line.stops.filter((s) => !gone.includes(s));
    this.evtRail = true;
    this.markEdit();
  }

  addStation(init: Omit<RailStation, 'id'>): Id {
    const seg = this.requireSegment(init.segmentId);
    if (this.requireRoadType(seg.roadType).category !== 'rail') throw new NetworkError('A station needs track');
    return this.batch(() => {
      const id = this.p.nextId++;
      this.railData().stations.push({ id, ...structuredClone(init) });
      this.evtRail = true;
      this.markEdit();
      return id;
    });
  }

  updateStation(id: Id, patch: Partial<Omit<RailStation, 'id'>>): void {
    const st = this.p.rail?.stations.find((s) => s.id === id);
    if (!st) throw new NetworkError(`No station ${id}`);
    this.batch(() => {
      Object.assign(st, patch);
      // Setting a field to undefined clears it, so old-shaped stations stay old-shaped.
      for (const key of Object.keys(st) as (keyof RailStation)[]) if (st[key] === undefined) delete st[key];
      this.evtRail = true;
      this.markEdit();
    });
  }

  removeStation(id: Id): void {
    if (!this.p.rail?.stations.some((s) => s.id === id)) throw new NetworkError(`No station ${id}`);
    this.batch(() => this.dropStations((s) => s.id === id));
  }

  addLine(init: Omit<RailLine, 'id'>): Id {
    return this.batch(() => {
      const id = this.p.nextId++;
      this.railData().lines.push({ id, ...structuredClone(init) });
      this.evtRail = true;
      this.markEdit();
      return id;
    });
  }

  /** Merge fields into a line. Set a field to undefined to clear it. */
  updateLine(id: Id, patch: Partial<Omit<RailLine, 'id'>>): void {
    const rail = this.p.rail;
    const i = rail?.lines.findIndex((l) => l.id === id) ?? -1;
    if (!rail || i < 0) throw new NetworkError(`No line ${id}`);
    this.batch(() => {
      const next = { ...rail.lines[i], ...structuredClone(patch), id };
      for (const key of Object.keys(next) as (keyof RailLine)[]) {
        if (next[key] === undefined) delete next[key];
      }
      rail.lines[i] = next;
      this.evtRail = true;
      this.markEdit();
    });
  }

  removeLine(id: Id): void {
    const rail = this.p.rail;
    if (!rail?.lines.some((l) => l.id === id)) throw new NetworkError(`No line ${id}`);
    this.batch(() => {
      rail.lines = rail.lines.filter((l) => l.id !== id);
      this.evtRail = true;
      this.markEdit();
    });
  }

  addDecal(init: DecalInit): Id {
    return this.batch(() => {
      const id = this.p.nextId++;
      this.p.decals.push({ ...structuredClone(init), id });
      this.evtDecals = true;
      this.markEdit();
      this.replaceStacked({ kind: 'decal', decal: { ...init, id } }, { kind: 'decal', id });
      return id;
    });
  }

  updateDecal(id: Id, patch: Partial<DecalInit>): void {
    const i = this.p.decals.findIndex((d) => d.id === id);
    if (i < 0) throw new NetworkError(`No decal ${id}`);
    this.batch(() => {
      this.p.decals[i] = { ...this.p.decals[i], ...structuredClone(patch), id };
      this.evtDecals = true;
      this.markEdit();
    });
  }

  removeDecal(id: Id): void {
    if (!this.p.decals.some((d) => d.id === id)) throw new NetworkError(`No decal ${id}`);
    this.batch(() => {
      this.p.decals = this.p.decals.filter((d) => d.id !== id);
      this.evtDecals = true;
      this.markEdit();
    });
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sameVec(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function pct(grade: number): string {
  return `${(grade * 100).toFixed(1)}%`;
}

function renameLaneRef(ref: string, from: Id, to: Id): string {
  const [seg, lane] = ref.split(':');
  return Number(seg) === from ? `${to}:${lane}` : ref;
}

/** A copy without keys whose value is undefined, so clearing a field leaves no trace. */
function dropUndefined<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

function tToLength(curve: SegmentCurve, t: number): number {
  const { ts, ss } = curve.table;
  const n = ts.length - 1;
  const x = clamp(t, 0, 1) * n;
  const i = Math.min(Math.floor(x), n - 1);
  return ss[i] + (ss[i + 1] - ss[i]) * (x - i);
}

function chordTouchesBox(a: Vec3, b: Vec3, r: Region): boolean {
  // Slab test in plan view.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const slab = (p: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return p >= lo && p <= hi;
    let u0 = (lo - p) / d;
    let u1 = (hi - p) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0);
    t1 = Math.min(t1, u1);
    return t0 <= t1;
  };
  return slab(a.x, dx, r.minX, r.maxX) && slab(a.z, dz, r.minZ, r.maxZ);
}

/**
 * Run a growing square search until something is found and the square covers it,
 * or the search limit is reached.
 */
function expandingSearch(maxDistance: number, found: () => number | null, search: (reach: number) => void): void {
  const hardLimit = Number.isFinite(maxDistance) ? maxDistance : 2 * 16000;
  let reach = Math.min(64, hardLimit);
  for (;;) {
    search(reach);
    const d = found();
    if (d !== null && d <= reach) return;
    if (reach >= hardLimit) return;
    reach = Math.min(d !== null ? d : reach * 2, hardLimit);
  }
}

function selfCrosses(c: Cubic): boolean {
  const n = 48;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(cubicPoint(c, i / n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (segmentsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  // Points on a straight road are collinear to within rounding, which must not count
  // as being on opposite sides. The cut-off is square metres, far below any real bend.
  const side = (p: Vec3, q: Vec3, r: Vec3) => {
    const area = (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    return Math.abs(area) < 1e-6 ? 0 : area;
  };
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}
