/**
 * Puts a finished blueprint into a RoadNetwork as one batch.
 *
 * Template roads go in with addSegment, because the blueprint already knows every
 * junction and passes every grade separation; drawRoad would only hide mistakes.
 * Existing roads are the exception. A stub end landing on an existing node or road
 * joins it, and an existing road running along a stub into the template is cut out
 * between the stubs, which is what dropping a template on a highway means. A
 * template road crossing some other existing road at grade gets a junction there.
 */
import {
  MAP_HALF_SIZE,
  MAX_ELEVATION,
  MIN_ELEVATION,
  cubicPoint,
  cubicTangentXZ,
  defaultSignalPlan,
  distXZ,
  type Cubic,
  type Id,
  type RoadNetwork,
  type SignalPlan,
  type Vec3,
} from '../core';
import { segmentOverlapIssues } from '../core/overlap';
import { worldCubics, type Blueprint, type BpLaneLink, type BpPort, type Placement, type WorldFrame, worldFrame } from './blueprint';

export interface StampedPort {
  name: string;
  nodeId: Id;
  flow: BpPort['flow'];
}

export interface StampResult {
  segments: Id[];
  nodes: Id[];
  problems: string[];
  /** Stub ends by name, for tests and for the UI to highlight. */
  ports: StampedPort[];
}

/** How far a stub end may be from an existing road and still join it. */
const PORT_SNAP = 8;
/** Largest height gap across which a stub end joins an existing road. */
const PORT_LEVEL = 1.5;
/** Directions this close to parallel count as the same road. */
const PARALLEL = 0.85;

/** Reasons a blueprint cannot be placed here at all. */
export function placementErrors(bp: Blueprint, frame: WorldFrame): string[] {
  const problems = new Set<string>();
  for (const c of worldCubics(bp, frame)) {
    for (let i = 0; i <= 8; i++) {
      const p = cubicPoint(c, i / 8);
      if (Math.abs(p.x) > MAP_HALF_SIZE || Math.abs(p.z) > MAP_HALF_SIZE) problems.add('The template leaves the map.');
      if (p.y < MIN_ELEVATION || p.y > MAX_ELEVATION) {
        problems.add(`Elevation must stay between ${MIN_ELEVATION} m and ${MAX_ELEVATION} m.`);
      }
    }
  }
  return [...problems];
}

interface Attachment {
  nodeId: Id;
  port: BpPort;
}

/** Whether lanes at this existing node can feed or take a stub's traffic. */
function nodeSuits(net: RoadNetwork, nodeId: Id, port: BpPort, outward: Vec3): boolean {
  const node = net.getNode(nodeId)!;
  if (port.flow === 'both') return true;
  for (const segId of node.segments) {
    const seg = net.getSegment(segId)!;
    const def = net.roadTypeOf(segId);
    const atStart = seg.a === nodeId;
    const c = net.cubicOf(segId);
    const tan = cubicTangentXZ(c, atStart ? 0 : 1);
    const away = atStart ? tan : { x: -tan.x, y: 0, z: -tan.z };
    // A road carrying on inward is about to be replaced, so it does not count.
    if (away.x * outward.x + away.z * outward.z < -PARALLEL) continue;
    const arrives = def.lanes.some((l) => (atStart ? l.dir === -1 : l.dir === 1));
    const leaves = def.lanes.some((l) => (atStart ? l.dir === 1 : l.dir === -1));
    if (port.flow === 'in' ? arrives : leaves) return true;
  }
  return false;
}

function attachPort(
  net: RoadNetwork,
  port: BpPort,
  pos: Vec3,
  outward: Vec3,
  problems: string[],
): Attachment | null {
  const near = net.nearestNode(pos, PORT_SNAP);
  if (near) {
    const node = net.getNode(near.nodeId)!;
    if (Math.abs(node.pos.y - pos.y) <= PORT_LEVEL) {
      if (nodeSuits(net, near.nodeId, port, outward)) return { nodeId: near.nodeId, port };
      problems.push(`Stub ${port.name} meets a one-way road running the wrong way, so it was left unconnected.`);
      return null;
    }
  }
  const seg = net.nearestSegment(pos, PORT_SNAP);
  if (!seg || Math.abs(seg.point.y - pos.y) > PORT_LEVEL) return null;
  const def = net.roadTypeOf(seg.segmentId);
  const tan = cubicTangentXZ(net.cubicOf(seg.segmentId), seg.t);
  const along = tan.x * outward.x + tan.z * outward.z;
  const oneWay = def.lanes.every((l) => l.dir === 1);
  if (oneWay && Math.abs(along) > PARALLEL) {
    // Travel towards the template for an entry, away from it for an exit.
    const fits = port.flow === 'both' || (port.flow === 'in' ? along < 0 : along > 0);
    if (!fits) {
      problems.push(`Stub ${port.name} meets a one-way road running the wrong way, so it was left unconnected.`);
      return null;
    }
  }
  const split = net.splitSegment(seg.segmentId, seg.t);
  return { nodeId: split.node, port };
}

/** The existing road running inward from a joined stub, up to the next joined stub. */
function inwardChain(
  net: RoadNetwork,
  from: Attachment,
  outward: Vec3,
  joined: ReadonlySet<Id>,
  centre: Vec3,
  reach: number,
): Id[] | null {
  const start = net.getNode(from.nodeId)!;
  for (const first of start.segments) {
    const seg = net.getSegment(first)!;
    const atStart = seg.a === from.nodeId;
    const tan = cubicTangentXZ(net.cubicOf(first), atStart ? 0 : 1);
    const away = atStart ? tan : { x: -tan.x, y: 0, z: -tan.z };
    if (away.x * outward.x + away.z * outward.z > -PARALLEL) continue;
    const chain: Id[] = [];
    let cur = from.nodeId;
    let id = first;
    for (;;) {
      chain.push(id);
      const s = net.getSegment(id)!;
      const next = s.a === cur ? s.b : s.a;
      if (joined.has(next)) return chain;
      const node = net.getNode(next)!;
      if (distXZ(node.pos, centre) > reach) return null;
      if (node.segments.length === 1) return chain;
      if (node.segments.length !== 2) return null;
      id = node.segments[0] === id ? node.segments[1] : node.segments[0];
      cur = next;
    }
  }
  return [];
}

/**
 * Demand-responsive timing, kept short enough that a red never outlasts the
 * patience of whoever is waiting at it.
 */
function actuated(plan: SignalPlan): SignalPlan {
  return {
    ...plan,
    kind: 'actuated',
    phases: plan.phases.map((ph) => ({ ...ph, minGreenSec: 6, maxGreenSec: Math.round(ph.greenSec * 1.25) })),
  };
}

function offsetCubic(c: Cubic, pa: Vec3, pb: Vec3): Cubic {
  // Moved end points carry their handles, so a stub keeps its tangent.
  const da = { x: pa.x - c.p0.x, y: pa.y - c.p0.y, z: pa.z - c.p0.z };
  const db = { x: pb.x - c.p3.x, y: pb.y - c.p3.y, z: pb.z - c.p3.z };
  return {
    p0: pa,
    p1: { x: c.p1.x + da.x, y: c.p1.y + da.y, z: c.p1.z + da.z },
    p2: { x: c.p2.x + db.x, y: c.p2.y + db.y, z: c.p2.z + db.z },
    p3: pb,
  };
}

export function stampBlueprint(net: RoadNetwork, bp: Blueprint, placement: Placement): StampResult {
  const frame = worldFrame(placement);
  const errors = placementErrors(bp, frame);
  if (errors.length) return { segments: [], nodes: [], problems: errors, ports: [] };

  const problems: string[] = [];
  const result: StampResult = { segments: [], nodes: [], problems, ports: [] };
  const cubics = worldCubics(bp, frame);

  net.batch(() => {
    for (const def of bp.customTypes.values()) {
      if (!net.roadType(def.id)) net.setCustomRoadType(def);
    }

    // Join stub ends to whatever is already there.
    const attachments = new Map<number, Attachment>();
    if (net.segments.length) {
      for (const port of bp.ports) {
        const att = attachPort(net, port, frame.point(bp.nodes[port.node].pos), frame.direction(port.outward), problems);
        if (att) attachments.set(port.node, att);
      }
      const joined = new Set([...attachments.values()].map((a) => a.nodeId));
      let reach = 0;
      for (const n of bp.nodes) reach = Math.max(reach, distXZ(n.pos, { x: 0, y: 0, z: 0 }));
      for (const att of attachments.values()) {
        const chain = inwardChain(net, att, frame.direction(att.port.outward), joined, placement.pos, reach + PORT_SNAP);
        if (chain === null) {
          problems.push(`The road at stub ${att.port.name} runs on through the template and was left in place.`);
          continue;
        }
        for (const id of chain) if (net.getSegment(id)) net.removeSegment(id);
      }
    }

    // Nodes. A join that lost its only road to the cut gets a fresh node.
    const nodeOf = new Map<number, Id>();
    for (const n of bp.nodes) {
      const att = attachments.get(n.key);
      nodeOf.set(n.key, att && net.getNode(att.nodeId) ? att.nodeId : net.addNode(frame.point(n.pos)));
    }
    result.nodes = [...nodeOf.values()];

    const existing = new Set(net.segments.map((s) => s.id));
    const piecesOf = new Map<number, Id[]>();
    bp.segments.forEach((seg, i) => {
      const a = nodeOf.get(seg.a)!;
      const b = nodeOf.get(seg.b)!;
      const cubic = offsetCubic(cubics[i], net.getNode(a)!.pos, net.getNode(b)!.pos);
      const crossing = existing.size
        ? net.findCrossings(cubic, [a, b]).filter((h) => h.atGrade && existing.has(h.segmentId))
        : [];
      if (crossing.length) {
        const drawn = net.drawRoad({
          start: { kind: 'node', id: a },
          end: { kind: 'node', id: b },
          c1: cubic.p1,
          c2: cubic.p2,
          roadType: seg.road.type,
          overrides: seg.road.overrides,
        });
        piecesOf.set(i, drawn.segments);
        result.segments.push(...drawn.segments);
        problems.push(`${seg.road.name} crosses an existing road at grade, so a junction was added.`);
        return;
      }
      if (existing.size) {
        for (const issue of net.validateDraft({
          start: { kind: 'node', id: a },
          end: { kind: 'node', id: b },
          c1: cubic.p1,
          c2: cubic.p2,
          roadType: seg.road.type,
        })) {
          // Overlap is checked below against the roads that were here, not the template's own.
          if (issue.severity === 'error' && issue.code !== 'tooClose') problems.push(`${seg.road.name}: ${issue.message}`);
        }
      }
      const id = net.addSegment(a, b, { c1: cubic.p1, c2: cubic.p2, roadType: seg.road.type, overrides: seg.road.overrides });
      piecesOf.set(i, [id]);
      result.segments.push(id);
      if (existing.size) {
        for (const issue of segmentOverlapIssues(net, id, existing)) problems.push(`${seg.road.name}: ${issue.message}`);
      }
    });

    const armSegment = (key: number, arm: BpLaneLink['from']): Id => {
      const seg = bp.armSegment(key, arm);
      const pieces = piecesOf.get(seg.index)!;
      return arm.side === 'before' ? pieces[pieces.length - 1] : pieces[0];
    };

    for (const [key, links] of bp.links) {
      net.setJunctionControl(nodeOf.get(key)!, {
        laneLinks: links.map((l) => ({
          from: `${armSegment(key, l.from)}:${bp.armLanes(key, l.from, 'in')[l.fromLane]}`,
          to: `${armSegment(key, l.to)}:${bp.armLanes(key, l.to, 'out')[l.toLane]}`,
        })),
      });
    }

    for (const [key, control] of bp.controls) {
      const nodeId = nodeOf.get(key)!;
      if (control.kind === 'signal') {
        net.setJunctionControl(nodeId, { mode: 'signal', signal: actuated(defaultSignalPlan(net, nodeId, control.preset)) });
      } else if (control.kind === 'phases') {
        const plan: SignalPlan = {
          kind: 'fixed',
          offsetSec: 0,
          phases: control.phases.map((ph, i) => ({
            id: i + 1,
            name: ph.name,
            greenSec: ph.greenSec,
            yellowSec: 3,
            allRedSec: 1.5,
            minGreenSec: 6,
            maxGreenSec: 60,
            moves: Object.fromEntries(
              ph.moves.map((m) => [`${armSegment(key, m.from)}>${armSegment(key, m.to)}`, m.state]),
            ),
          })),
        };
        net.setJunctionControl(nodeId, { mode: 'signal', signal: actuated(plan) });
      } else {
        const signs: Record<number, (typeof control.signs)[number]['sign']> = {};
        for (const s of control.signs) signs[armSegment(key, s.arm)] = s.sign;
        net.setJunctionControl(nodeId, { mode: 'priority', signs });
      }
    }

    result.ports = bp.ports.map((p) => ({ name: p.name, nodeId: nodeOf.get(p.node)!, flow: p.flow }));
  });

  // Dropping on a road can repeat one message per piece.
  result.problems = [...new Set(problems)];
  return result;
}
