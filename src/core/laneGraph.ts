/**
 * Road lanes plus connectors, assembled into the LaneGraph the simulation drives
 * on. Work is split so an edit stays cheap: road lanes are cached per segment,
 * connectors per node, and assembly only hands out dense indices and links.
 */
import type {
  GLane,
  Id,
  LaneConflict,
  LaneDef,
  LaneGraph,
  LaneKind,
  NodeGeom,
  Project,
  RampAttach,
  RoadTypeDef,
  SegmentGeom,
} from './types';
import type { NodeLayout } from './junction';
import {
  autoLaneLinks,
  buildArmLanes,
  buildConnector,
  computeConflicts,
  controlLaneLinks,
  laneRef,
  plainJointLinks,
  possibleConnections,
  type ArmLanes,
  type ConnectorProto,
  type LaneEnd,
  type PossibleConnection,
  type RoadLaneInfo,
} from './connectors';
import { lanePolyline, type PolylineData } from './geometry';
import { roundaboutLaneLinks } from './roundabout';
import { islandBlocker, kerbFitter } from './junctionShape';

/** A road lane before it has a dense index. Immutable once built. */
export interface RoadLaneProto extends RoadLaneInfo {
  key: string;
  segmentId: Id;
  laneIndex: number;
  poly: PolylineData;
}

export function buildRoadLanes(
  segmentId: Id,
  geom: SegmentGeom,
  lanes: readonly LaneDef[],
  /** Metres per second, per lane. */
  speedsMs: readonly number[],
): (RoadLaneProto | null)[] {
  return lanes.map((lane, laneIndex) => {
    const poly = lanePolyline(geom, lane);
    if (!poly) return null;
    const n = poly.cum.length;
    const { pts } = poly;
    return {
      key: `r${segmentId}:${laneIndex}`,
      segmentId,
      laneIndex,
      poly,
      kind: lane.kind,
      offset: lane.offset,
      dir: lane.dir,
      width: lane.width,
      speed: speedsMs[laneIndex],
      start: { x: pts[0], y: pts[1], z: pts[2] },
      end: { x: pts[n * 3 - 3], y: pts[n * 3 - 2], z: pts[n * 3 - 1] },
    };
  });
}

/** What one node contributes to the graph. */
export interface NodeLanes {
  arms: ArmLanes[];
  connectors: ConnectorProto[];
  /** Road lanes joined directly, as at a plain joint. */
  direct: { from: LaneEnd; to: LaneEnd }[];
  /** Identifies `direct`, to tell whether links changed without comparing them. */
  directKey: string;
}

function directKeyOf(direct: NodeLanes['direct']): string {
  return direct.map((d) => `${laneRef(d.from)}>${laneRef(d.to)}`).join(',');
}

export function buildNodeLanes(
  layout: NodeLayout,
  geom: NodeGeom,
  control: Parameters<typeof controlLaneLinks>[0],
  geomOf: (id: Id) => SegmentGeom | undefined,
  defOf: (id: Id) => RoadTypeDef,
  lanesOf: (id: Id) => readonly (RoadLaneProto | null)[],
  attachOf?: (id: Id, atStart: boolean) => RampAttach | undefined,
): NodeLanes {
  const nodeId = layout.nodeId;
  const arms = buildArmLanes(layout, geom, geomOf, defOf, lanesOf, attachOf);
  if (layout.kind === 'empty') return { arms, connectors: [], direct: [], directKey: '' };
  if (layout.kind === 'plain') {
    // No junction space here, so even user links join the road lanes directly.
    const links = control.laneLinks ? controlLaneLinks(control, arms) : plainJointLinks(arms);
    return { arms, connectors: [], direct: links, directKey: directKeyOf(links) };
  }
  // Roundabout ring nodes have their own lane use, see core/roundabout.ts.
  const links = control.laneLinks ? controlLaneLinks(control, arms) : (roundaboutLaneLinks(arms, defOf) ?? autoLaneLinks(arms));
  const connectors: ConnectorProto[] = [];
  // A junction shape's islands split traffic: nothing drives through one.
  const blocked = islandBlocker(geom, control.shape, defOf, geomOf);
  const fit = kerbFitter(geom, control.shape);
  for (const link of links) {
    const c = fit ? fit(link, (cubic) => buildConnector(nodeId, link, cubic)) : buildConnector(nodeId, link);
    if (c && !blocked?.(c)) connectors.push(c);
  }
  // Arm order rotates when an arm crosses heading +-PI. Connector order must not,
  // or a small drag would look like a change of lanes.
  connectors.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  computeConflicts(connectors);
  return { arms, connectors, direct: [], directKey: '' };
}

/** Every lane link possible at a node, marking the ones in use. */
export function connectionsOf(lanes: NodeLanes): PossibleConnection[] {
  const active = new Set<string>();
  for (const c of lanes.connectors) active.add(`${laneRef(c.from)}>${laneRef(c.to)}`);
  for (const d of lanes.direct) active.add(`${laneRef(d.from)}>${laneRef(d.to)}`);
  return possibleConnections(lanes.arms, active);
}

const VEHICLE_ANY = (k: LaneKind) => k !== 'bike';

/** Lanes are neighbours when vehicles could move between them. */
function adjacent(a: RoadLaneProto, b: RoadLaneProto): boolean {
  return a.dir === b.dir && VEHICLE_ANY(a.kind) === VEHICLE_ANY(b.kind);
}

/** Shared by every road lane, which never has conflicts. Do not mutate. */
const NO_CONFLICTS: LaneConflict[] = [];

function roadGLane(p: RoadLaneProto, idx: number, next: number[], prev: number[]): GLane {
  return {
    idx,
    key: p.key,
    kind: 'road',
    segmentId: p.segmentId,
    laneIndex: p.laneIndex,
    nodeId: -1,
    fromLane: -1,
    toLane: -1,
    turn: null,
    pts: p.poly.pts,
    cum: p.poly.cum,
    length: p.poly.length,
    speed: p.speed,
    vehicleKind: p.kind,
    width: p.width,
    next,
    prev,
    left: -1,
    right: -1,
    conflicts: NO_CONFLICTS,
  };
}

function connectorGLane(c: ConnectorProto, idx: number, fromLane: number, toLane: number, base: number): GLane {
  return {
    idx,
    key: c.key,
    kind: 'connector',
    segmentId: -1,
    laneIndex: -1,
    nodeId: c.nodeId,
    fromLane,
    toLane,
    turn: c.turn,
    pts: c.poly.pts,
    cum: c.poly.cum,
    length: c.poly.length,
    speed: c.speed,
    vehicleKind: c.vehicleKind,
    width: c.width,
    next: [toLane],
    prev: [fromLane],
    left: -1,
    right: -1,
    conflicts: c.conflicts.map((k) => ({
      lane: base + k.other,
      selfS: k.selfS,
      otherS: k.otherS,
      kind: k.kind,
    })),
  };
}

/** Set left and right as the driver sees them, on one segment's lanes. */
function linkNeighbours(protos: readonly (RoadLaneProto | null)[], dense: readonly number[], lanes: GLane[]): void {
  for (let i = 0; i < protos.length; i++) {
    const p = protos[i];
    if (!p) continue;
    const lane = lanes[dense[i]];
    const lower = protos[i - 1];
    const upper = protos[i + 1];
    const leftProto = p.dir === 1 ? lower : upper;
    const rightProto = p.dir === 1 ? upper : lower;
    if (leftProto && adjacent(p, leftProto)) lane.left = dense[leftProto.laneIndex];
    if (rightProto && adjacent(p, rightProto)) lane.right = dense[rightProto.laneIndex];
  }
}

/**
 * Hand out dense indices and link everything. Lanes come out in project order,
 * so the same project always yields the same graph.
 */
export function assembleLaneGraph(
  project: Project,
  roadLanes: ReadonlyMap<Id, readonly (RoadLaneProto | null)[]>,
  nodeLanes: ReadonlyMap<Id, NodeLanes>,
  version: number,
): LaneGraph {
  const lanes: GLane[] = [];
  const byKey = new Map<string, number>();
  const roadIndex = new Map<Id, number[]>();
  const connectorsAt = new Map<Id, number[]>();

  for (const seg of project.segments) {
    const protos = roadLanes.get(seg.id);
    const dense: number[] = [];
    if (protos) {
      for (const p of protos) {
        if (!p) {
          dense.push(-1);
          continue;
        }
        const idx = lanes.length;
        dense.push(idx);
        byKey.set(p.key, idx);
        lanes.push(roadGLane(p, idx, [], []));
      }
      linkNeighbours(protos, dense, lanes);
    }
    roadIndex.set(seg.id, dense);
  }

  const denseOf = (end: LaneEnd) => roadIndex.get(end.segmentId)?.[end.laneIndex] ?? -1;

  for (const node of project.nodes) {
    const data = nodeLanes.get(node.id);
    const ids: number[] = [];
    if (data) {
      const base = lanes.length;
      for (const c of data.connectors) {
        const fromLane = denseOf(c.from);
        const toLane = denseOf(c.to);
        const idx = lanes.length;
        ids.push(idx);
        byKey.set(c.key, idx);
        lanes.push(connectorGLane(c, idx, fromLane, toLane, base));
        lanes[fromLane].next.push(idx);
        lanes[toLane].prev.push(idx);
      }
      for (const d of data.direct) {
        const a = denseOf(d.from);
        const b = denseOf(d.to);
        lanes[a].next.push(b);
        lanes[b].prev.push(a);
      }
    }
    connectorsAt.set(node.id, ids);
  }

  return { lanes, byKey, connectorsAt, roadLanes: roadIndex, version };
}

/**
 * The fast path of an edit that kept the exact set of lanes and links, such as
 * dragging a node. Dense indices cannot have moved, so the new graph shares every
 * untouched GLane with `prev`, and only dirty ones are replaced. GLanes are never
 * mutated after creation, so `prev` stays fully valid for anyone still holding it.
 *
 * Returns null when the lanes or links changed, and a full assembly is needed.
 */
export function patchLaneGraph(
  prev: LaneGraph,
  dirtySegments: ReadonlySet<Id>,
  dirtyNodes: ReadonlySet<Id>,
  roadLanes: ReadonlyMap<Id, readonly (RoadLaneProto | null)[]>,
  nodeLanes: ReadonlyMap<Id, NodeLanes>,
  directKeys: ReadonlyMap<Id, string>,
  version: number,
): LaneGraph | null {
  for (const id of dirtySegments) {
    const dense = prev.roadLanes.get(id);
    const protos = roadLanes.get(id);
    if (!dense || !protos || dense.length !== protos.length) return null;
    for (let i = 0; i < dense.length; i++) if ((dense[i] < 0) !== !protos[i]) return null;
  }
  for (const id of dirtyNodes) {
    const ids = prev.connectorsAt.get(id);
    const data = nodeLanes.get(id);
    if (!ids || !data || ids.length !== data.connectors.length) return null;
    if ((directKeys.get(id) ?? '') !== data.directKey) return null;
    for (let i = 0; i < ids.length; i++) if (prev.lanes[ids[i]].key !== data.connectors[i].key) return null;
  }

  const lanes = prev.lanes.slice();
  for (const id of dirtySegments) {
    const dense = prev.roadLanes.get(id)!;
    const protos = roadLanes.get(id)!;
    for (let i = 0; i < protos.length; i++) {
      const p = protos[i];
      if (!p) continue;
      const old = prev.lanes[dense[i]];
      lanes[dense[i]] = roadGLane(p, dense[i], old.next, old.prev);
    }
    linkNeighbours(protos, dense, lanes);
  }
  for (const id of dirtyNodes) {
    const ids = prev.connectorsAt.get(id)!;
    const data = nodeLanes.get(id)!;
    const base = ids.length ? ids[0] : 0;
    for (let i = 0; i < ids.length; i++) {
      const old = prev.lanes[ids[i]];
      lanes[ids[i]] = connectorGLane(data.connectors[i], ids[i], old.fromLane, old.toLane, base);
    }
  }
  return { lanes, byKey: prev.byKey, connectorsAt: prev.connectorsAt, roadLanes: prev.roadLanes, version };
}
