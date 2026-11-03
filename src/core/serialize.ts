/**
 * Project JSON. Parsing accepts a string or a decoded object, migrates old
 * versions, validates everything and returns a fresh Project with node.segments
 * rebuilt. Anything wrong throws ProjectFormatError naming the bad field.
 */
import type {
  JunctionControl,
  NodeMarking,
  Project,
  RoadNode,
  RoadTypeDef,
  Segment,
  TrafficEndpoint,
  TrafficSettings,
  Vec3,
  VehicleMix,
  ZoneRegion,
} from './types';
import type { RailData, RailLine, RailStation } from './railTypes';
import { builtinRoadType, roadTypeProblems } from './roadTypes';

export const PROJECT_VERSION = 1;

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(`Invalid project: ${message}`);
    this.name = 'ProjectFormatError';
  }
}

function fail(message: string): never {
  throw new ProjectFormatError(message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} must be a finite number`);
  return v;
}

function checkId(v: unknown, where: string): number {
  const n = checkNumber(v, where);
  if (!Number.isInteger(n) || n < 0) fail(`${where} must be a non-negative integer`);
  return n;
}

function checkVec(v: unknown, where: string): Vec3 {
  if (!isObject(v)) fail(`${where} must be a position`);
  return {
    x: checkNumber(v.x, `${where}.x`),
    y: checkNumber(v.y, `${where}.y`),
    z: checkNumber(v.z, `${where}.z`),
  };
}

function checkArray(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) fail(`${where} must be a list`);
  return v;
}

function checkMix(v: unknown, where: string): VehicleMix {
  if (!isObject(v)) fail(`${where} must be a vehicle mix`);
  return {
    car: checkNumber(v.car, `${where}.car`),
    van: checkNumber(v.van, `${where}.van`),
    truck: checkNumber(v.truck, `${where}.truck`),
    bus: checkNumber(v.bus, `${where}.bus`),
  };
}

export function defaultJunctionControl(): JunctionControl {
  return { mode: 'auto', signs: {}, signal: null, laneLinks: null, crosswalks: {} };
}

export function defaultVehicleMix(): VehicleMix {
  return { car: 0.8, van: 0.1, truck: 0.08, bus: 0.02 };
}

export function defaultTrafficSettings(): TrafficSettings {
  return {
    multiplier: 1,
    autoGateways: true,
    autoGatewayRatePerLane: 300,
    despawnStuckSec: 120,
    defaultMix: defaultVehicleMix(),
  };
}

export function createEmptyProject(name = 'Untitled'): Project {
  return {
    version: 1,
    name,
    nextId: 1,
    nodes: [],
    segments: [],
    endpoints: [],
    decals: [],
    customRoadTypes: [],
    traffic: defaultTrafficSettings(),
  };
}

function checkControl(raw: unknown, where: string): JunctionControl {
  if (raw === undefined) return defaultJunctionControl();
  if (!isObject(raw)) fail(`${where} must be an object`);
  const c = raw as unknown as Partial<JunctionControl>;
  const mode = c.mode ?? 'auto';
  if (!['auto', 'priority', 'allStop', 'signal'].includes(mode)) fail(`${where}.mode "${String(mode)}" is unknown`);
  if (c.signal !== null && c.signal !== undefined) {
    if (!isObject(c.signal) || !Array.isArray(c.signal.phases)) fail(`${where}.signal must have phases`);
  }
  if (c.laneLinks !== null && c.laneLinks !== undefined && !Array.isArray(c.laneLinks)) {
    fail(`${where}.laneLinks must be a list or null`);
  }
  const out: JunctionControl = {
    mode,
    signs: structuredClone(c.signs ?? {}),
    signal: structuredClone(c.signal ?? null),
    laneLinks: structuredClone(c.laneLinks ?? null),
    crosswalks: structuredClone(c.crosswalks ?? {}),
  };
  // Both stay absent when unused, so files that never had them keep their signature.
  if (c.markings !== undefined) {
    const list = checkArray(c.markings, `${where}.markings`).map((m, i) => checkMarking(m, `${where}.markings[${i}]`));
    if (list.length) out.markings = list;
  }
  if (c.hideAutoMarkings) out.hideAutoMarkings = true;
  return out;
}

function checkAnchor(raw: unknown, where: string): void {
  if (!isObject(raw)) fail(`${where} is not an anchor`);
  checkId(raw.segmentId, `${where}.segmentId`);
  if (!Number.isInteger(raw.boundary) || (raw.boundary as number) < 0) fail(`${where}.boundary must be a whole number`);
  if (raw.corner !== undefined) checkNumber(raw.corner, `${where}.corner`);
  if (raw.back !== undefined) checkNumber(raw.back, `${where}.back`);
}

function checkMarking(raw: unknown, where: string): NodeMarking {
  if (!isObject(raw)) fail(`${where} is not a marking`);
  checkId(raw.id, `${where}.id`);
  checkNumber(raw.width, `${where}.width`);
  if (raw.kind === 'line') {
    checkAnchor(raw.from, `${where}.from`);
    checkAnchor(raw.to, `${where}.to`);
  } else if (raw.kind === 'filler') {
    const anchors = checkArray(raw.anchors, `${where}.anchors`);
    if (anchors.length < 3) fail(`${where} needs three anchors`);
    anchors.forEach((a, i) => checkAnchor(a, `${where}.anchors[${i}]`));
  } else {
    fail(`${where}.kind is unknown`);
  }
  return structuredClone(raw) as unknown as NodeMarking;
}

function checkRoadType(raw: unknown, where: string): RoadTypeDef {
  if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.lanes) || !isObject(raw.markings)) {
    fail(`${where} is not a road type`);
  }
  const def = structuredClone(raw) as unknown as RoadTypeDef;
  for (const [i, lane] of def.lanes.entries()) {
    if (!isObject(lane)) fail(`${where}.lanes[${i}] is not a lane`);
    checkNumber(lane.offset, `${where}.lanes[${i}].offset`);
    checkNumber(lane.width, `${where}.lanes[${i}].width`);
    if (lane.dir !== 1 && lane.dir !== -1) fail(`${where}.lanes[${i}].dir must be 1 or -1`);
    if (!['drive', 'bus', 'bike'].includes(lane.kind)) fail(`${where}.lanes[${i}].kind is unknown`);
  }
  checkNumber(def.halfWidth, `${where}.halfWidth`);
  checkNumber(def.speedKmh, `${where}.speedKmh`);
  checkNumber(def.sidewalk, `${where}.sidewalk`);
  checkNumber(def.shoulder, `${where}.shoulder`);
  checkNumber(def.rank, `${where}.rank`);
  const problems = roadTypeProblems(def);
  if (problems.length) fail(`${where}: ${problems.join(', ')}`);
  return def;
}

function checkEndpoint(raw: unknown, where: string, nodes: Set<number>, segments: Set<number>): TrafficEndpoint {
  if (!isObject(raw)) fail(`${where} is not an endpoint`);
  const ep = raw as unknown as TrafficEndpoint;
  checkId(ep.id, `${where}.id`);
  if (!['gateway', 'residential', 'commercial', 'industrial', 'office'].includes(ep.kind)) {
    fail(`${where}.kind is unknown`);
  }
  checkNumber(ep.t, `${where}.t`);
  checkNumber(ep.ratePerHour, `${where}.ratePerHour`);
  checkNumber(ep.attraction, `${where}.attraction`);
  checkMix(ep.mix, `${where}.mix`);
  if (ep.nodeId !== null && !nodes.has(ep.nodeId)) fail(`${where} refers to missing node ${ep.nodeId}`);
  if (ep.segmentId !== null && !segments.has(ep.segmentId)) fail(`${where} refers to missing segment ${ep.segmentId}`);
  return structuredClone(ep);
}

/** Stations on missing track and stops at missing stations go. A line needs no stops to load. */
function checkRail(raw: unknown, segments: Set<number>, claim: (id: number, where: string) => void): RailData | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) fail('rail must be an object');
  const stations: RailStation[] = [];
  for (const [i, v] of checkArray(raw.stations, 'rail.stations').entries()) {
    const where = `rail.stations[${i}]`;
    if (!isObject(v)) fail(`${where} is not a station`);
    const id = checkId(v.id, `${where}.id`);
    claim(id, where);
    const segmentId = checkId(v.segmentId, `${where}.segmentId`);
    const kind = v.kind;
    if (kind !== 'surface' && kind !== 'underground' && kind !== 'gateway') fail(`${where}.kind is unknown`);
    if (!segments.has(segmentId)) continue;
    stations.push({
      id,
      name: typeof v.name === 'string' ? v.name : `Station ${id}`,
      kind,
      segmentId,
      t: checkNumber(v.t, `${where}.t`),
      platformLength: checkNumber(v.platformLength, `${where}.platformLength`),
    });
  }
  const known = new Set(stations.map((s) => s.id));
  const lines: RailLine[] = [];
  for (const [i, v] of checkArray(raw.lines, 'rail.lines').entries()) {
    const where = `rail.lines[${i}]`;
    if (!isObject(v)) fail(`${where} is not a line`);
    const id = checkId(v.id, `${where}.id`);
    claim(id, where);
    const trainType = v.trainType;
    if (trainType !== 'metro' && trainType !== 'emu' && trainType !== 'intercity' && trainType !== 'highspeed' && trainType !== 'freight') {
      fail(`${where}.trainType is unknown`);
    }
    const line: RailLine = {
      id,
      name: typeof v.name === 'string' ? v.name : `Line ${id}`,
      color: typeof v.color === 'string' ? v.color : '#46d0ff',
      stops: checkArray(v.stops, `${where}.stops`).map((s, k) => checkId(s, `${where}.stops[${k}]`)).filter((s) => known.has(s)),
      trainType,
      cars: checkNumber(v.cars, `${where}.cars`),
      trains: checkNumber(v.trains, `${where}.trains`),
    };
    if (v.headwaySec !== undefined) line.headwaySec = checkNumber(v.headwaySec, `${where}.headwaySec`);
    if (v.hidden) line.hidden = true;
    lines.push(line);
  }
  return { stations, lines };
}

function checkPaintRef(raw: unknown, where: string): void {
  if (!isObject(raw)) fail(`${where} is not a road reference`);
  checkNumber(raw.offset, `${where}.offset`);
  const pieces = checkArray(raw.pieces, `${where}.pieces`);
  if (!pieces.length) fail(`${where} has no pieces`);
  pieces.forEach((p, i) => {
    if (!isObject(p)) fail(`${where}.pieces[${i}] is not a piece`);
    checkId(p.segmentId, `${where}.pieces[${i}].segmentId`);
    checkNumber(p.t0, `${where}.pieces[${i}].t0`);
    checkNumber(p.t1, `${where}.pieces[${i}].t1`);
  });
}

/** Bring an older file up to the current shape. Version 0 is any file without one. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const version = raw.version ?? 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    fail('version must be a number');
  }
  if (version > PROJECT_VERSION) {
    fail(`version ${version} is newer than this game understands (${PROJECT_VERSION})`);
  }
  if (version === 0) {
    // Early saves had no traffic block, endpoints or custom road list.
    return {
      name: 'Untitled',
      endpoints: [],
      decals: [],
      customRoadTypes: [],
      traffic: defaultTrafficSettings(),
      ...raw,
      version: 1,
    };
  }
  return raw;
}

/** Validate and normalise a saved project. The result shares nothing with the input. */
export function parseProject(input: unknown): Project {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      fail(`not valid JSON (${(e as Error).message})`);
    }
  }
  if (!isObject(data)) fail('expected a project object');
  const raw = migrate(data);

  if (typeof raw.name !== 'string') fail('name must be text');
  const nextIdIn = checkId(raw.nextId, 'nextId');

  const customRoadTypes = checkArray(raw.customRoadTypes, 'customRoadTypes').map((t, i) =>
    checkRoadType(t, `customRoadTypes[${i}]`),
  );
  const customIds = new Set(customRoadTypes.map((t) => t.id));
  if (customIds.size !== customRoadTypes.length) fail('customRoadTypes has duplicate ids');

  const nodes: RoadNode[] = [];
  const nodeIndex = new Map<number, RoadNode>();
  let maxId = 0;
  const ids = new Set<number>();
  const claim = (id: number, where: string) => {
    if (ids.has(id)) fail(`${where} reuses id ${id}`);
    ids.add(id);
    maxId = Math.max(maxId, id);
  };
  for (const [i, value] of checkArray(raw.nodes, 'nodes').entries()) {
    const where = `nodes[${i}]`;
    if (!isObject(value)) fail(`${where} is not a node`);
    const id = checkId(value.id, `${where}.id`);
    claim(id, where);
    const node: RoadNode = {
      id,
      pos: checkVec(value.pos, `${where}.pos`),
      segments: [],
      control: checkControl(value.control, `${where}.control`),
    };
    for (const m of node.control.markings ?? []) maxId = Math.max(maxId, m.id);
    nodes.push(node);
    nodeIndex.set(id, node);
  }

  const segments: Segment[] = [];
  for (const [i, value] of checkArray(raw.segments, 'segments').entries()) {
    const where = `segments[${i}]`;
    if (!isObject(value)) fail(`${where} is not a segment`);
    const id = checkId(value.id, `${where}.id`);
    claim(id, where);
    const a = checkId(value.a, `${where}.a`);
    const b = checkId(value.b, `${where}.b`);
    const na = nodeIndex.get(a);
    const nb = nodeIndex.get(b);
    if (!na) fail(`${where} refers to missing node ${a}`);
    if (!nb) fail(`${where} refers to missing node ${b}`);
    if (a === b) fail(`${where} starts and ends at node ${a}`);
    const roadType = value.roadType;
    if (typeof roadType !== 'string' || !(customIds.has(roadType) || builtinRoadType(roadType))) {
      fail(`${where} uses unknown road type "${String(roadType)}"`);
    }
    if (value.overrides !== undefined && !isObject(value.overrides)) fail(`${where}.overrides must be an object`);
    segments.push({
      id,
      a,
      b,
      c1: checkVec(value.c1, `${where}.c1`),
      c2: checkVec(value.c2, `${where}.c2`),
      roadType,
      overrides: structuredClone(value.overrides ?? {}),
    });
    na.segments.push(id);
    nb.segments.push(id);
  }

  // A marking on a road that left the node can only be a hand-edited file.
  for (const node of nodes) {
    const list = node.control.markings;
    if (!list) continue;
    const onNode = (a: { segmentId: number }) => node.segments.includes(a.segmentId);
    const kept = list.filter((m) => (m.kind === 'line' ? [m.from, m.to] : m.anchors).every(onNode));
    if (kept.length) node.control.markings = kept;
    else delete node.control.markings;
  }

  const nodeIds = new Set(nodeIndex.keys());
  const segmentIds = new Set(segments.map((s) => s.id));
  const endpoints = checkArray(raw.endpoints, 'endpoints').map((e, i) => {
    const ep = checkEndpoint(e, `endpoints[${i}]`, nodeIds, segmentIds);
    claim(ep.id, `endpoints[${i}]`);
    return ep;
  });

  const decals = checkArray(raw.decals, 'decals').map((d, i) => {
    const where = `decals[${i}]`;
    if (!isObject(d)) fail(`${where} is not a decal`);
    claim(checkId(d.id, `${where}.id`), where);
    checkArray(d.points, `${where}.points`).forEach((p, k) => checkVec(p, `${where}.points[${k}]`));
    if (d.road !== undefined) checkPaintRef(d.road, `${where}.road`);
    return structuredClone(d) as unknown as Project['decals'][number];
  }).filter((d) => !d.road || d.road.pieces.every((p) => segmentIds.has(p.segmentId)));

  const trafficRaw = raw.traffic;
  if (!isObject(trafficRaw)) fail('traffic must be an object');
  const traffic: TrafficSettings = {
    multiplier: checkNumber(trafficRaw.multiplier, 'traffic.multiplier'),
    autoGateways: !!trafficRaw.autoGateways,
    autoGatewayRatePerLane: checkNumber(trafficRaw.autoGatewayRatePerLane, 'traffic.autoGatewayRatePerLane'),
    despawnStuckSec: checkNumber(trafficRaw.despawnStuckSec, 'traffic.despawnStuckSec'),
    defaultMix: checkMix(trafficRaw.defaultMix, 'traffic.defaultMix'),
  };

  const rail = checkRail(raw.rail, segmentIds, claim);

  const zones = raw.zones === undefined ? [] : checkArray(raw.zones, 'zones').map((z, i) => {
    const where = `zones[${i}]`;
    if (!isObject(z)) fail(`${where} is not a zone`);
    claim(checkId(z.id, `${where}.id`), where);
    if (!['residential', 'commercial', 'industrial', 'office', 'none'].includes(z.kind as string)) fail(`${where}.kind is unknown`);
    const polygon = checkArray(z.polygon, `${where}.polygon`).map((p, k) => checkVec(p, `${where}.polygon[${k}]`));
    if (polygon.length < 3) fail(`${where} needs three corners`);
    const out = structuredClone(z) as unknown as ZoneRegion;
    out.polygon = polygon;
    // A corner held to a road that is gone keeps its last position.
    if (out.anchors) out.anchors = out.anchors.map((a) => (a && segmentIds.has(a.segmentId) ? a : null));
    return out;
  });

  return {
    version: 1,
    name: raw.name,
    nextId: Math.max(nextIdIn, maxId + 1),
    nodes,
    segments,
    endpoints,
    decals,
    customRoadTypes,
    traffic,
    // Stays absent when unused, so files that never had it keep their signature.
    ...(rail ? { rail } : {}),
    ...(zones.length ? { zones } : {}),
  };
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project);
}

/** Short FNV-1a hash of a string. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
