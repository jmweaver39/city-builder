/**
 * A blueprint is a template in local coordinates, independent of any network.
 * Local +x is the mainline's travel direction, +z is its right-hand side, and
 * y = 0 is the placement elevation. Roads are declared as Path plus Profile; nodes
 * are found where road ends land on other roads. Everything that needs segment ids
 * (lane links, signal phases, signs) is recorded against "arms" and resolved once
 * the network ids exist.
 */
import type { Cubic, LaneDef, RoadTypeDef, SegmentOverrides, SignKind, Vec3 } from '../core';
import { builtinRoadType } from '../core';
import type { Path, Profile, Pose } from './path';

export type PortFlow = 'in' | 'out' | 'both';

/** A pose on a road, with height. */
export interface Pose3 extends Pose {
  y: number;
}

export interface RoadOpts {
  name: string;
  path: Path;
  profile: Profile;
  type: string;
  overrides?: SegmentOverrides;
  /** Station of the template centre along this road, for before() and after(). */
  centre?: number;
}

/** One road of a template: several segments once it is cut at its junctions. */
export class Road {
  readonly name: string;
  readonly path: Path;
  readonly profile: Profile;
  readonly type: string;
  readonly overrides: SegmentOverrides;
  readonly centre: number;

  constructor(opts: RoadOpts) {
    this.name = opts.name;
    this.path = opts.path;
    this.profile = opts.profile;
    this.type = opts.type;
    this.overrides = opts.overrides ?? {};
    this.centre = opts.centre ?? opts.path.length / 2;
  }

  get length(): number {
    return this.path.length;
  }

  at(s: number): Pose3 {
    const p = this.path.poseAt(s);
    return { ...p, y: this.profile.at(s).y };
  }

  /** Pose `d` metres upstream of the template centre. */
  before(d: number): Pose3 {
    return this.at(this.centre - d);
  }

  /** Pose `d` metres downstream of the template centre. */
  after(d: number): Pose3 {
    return this.at(this.centre + d);
  }

  get start(): Pose3 {
    return this.at(0);
  }

  get end(): Pose3 {
    return this.at(this.length);
  }
}

/** A road meeting a node: the part arriving there or the part leaving it. */
export interface Arm {
  road: Road;
  side: 'before' | 'after';
}

export const arriving = (road: Road): Arm => ({ road, side: 'before' });
export const leaving = (road: Road): Arm => ({ road, side: 'after' });

export interface BpNode {
  key: number;
  pos: Vec3;
}

export interface BpSegment {
  index: number;
  road: Road;
  a: number;
  b: number;
  c1: Vec3;
  c2: Vec3;
}

export interface BpPort {
  name: string;
  node: number;
  /** 'in' means traffic enters the template here. */
  flow: PortFlow;
  /** Unit plan direction pointing out of the template. */
  outward: Vec3;
  road: Road;
}

export interface BpLaneLink {
  from: Arm;
  /** Index among lanes arriving at the node, left to right as the driver sees them. */
  fromLane: number;
  to: Arm;
  /** Index among lanes leaving the node, left to right as the driver sees them. */
  toLane: number;
}

export interface BpPhase {
  name: string;
  greenSec: number;
  moves: { from: Arm; to: Arm; state: 'protected' | 'permissive' }[];
}

export type BpControl =
  | { kind: 'signal'; preset: 'opposing' | 'protectedLefts' | 'split' }
  | { kind: 'phases'; phases: BpPhase[] }
  | { kind: 'priority'; signs: { arm: Arm; sign: SignKind }[] };

export class Blueprint {
  readonly roads: Road[] = [];
  readonly nodes: BpNode[] = [];
  readonly segments: BpSegment[] = [];
  readonly ports: BpPort[] = [];
  readonly customTypes = new Map<string, RoadTypeDef>();
  readonly links = new Map<number, BpLaneLink[]>();
  readonly controls = new Map<number, BpControl>();
  private finished = false;

  road(opts: RoadOpts): Road {
    const r = new Road(opts);
    this.roads.push(r);
    return r;
  }

  customType(def: RoadTypeDef): string {
    this.customTypes.set(def.id, def);
    return def.id;
  }

  typeDef(id: string): RoadTypeDef {
    const def = this.customTypes.get(id) ?? builtinRoadType(id);
    if (!def) throw new Error(`Unknown road type ${id}`);
    return def;
  }

  /** The node at a position, created if there is none. */
  pin(p: { x: number; y: number; z: number }): number {
    for (const n of this.nodes) {
      if (Math.abs(n.pos.x - p.x) < 0.02 && Math.abs(n.pos.z - p.z) < 0.02 && Math.abs(n.pos.y - p.y) < 0.05) {
        return n.key;
      }
    }
    const key = this.nodes.length;
    this.nodes.push({ key, pos: { x: p.x, y: p.y, z: p.z } });
    return key;
  }

  /** Declare a stub end as a place traffic comes and goes. */
  port(name: string, road: Road, end: 'start' | 'end', flow: PortFlow): void {
    const pose = end === 'start' ? road.start : road.end;
    const sign = end === 'start' ? -1 : 1;
    this.ports.push({
      name,
      node: this.pin(pose),
      flow,
      outward: { x: Math.cos(pose.h) * sign, y: 0, z: Math.sin(pose.h) * sign },
      road,
    });
  }

  addLinks(node: number, links: BpLaneLink[]): void {
    this.links.set(node, [...(this.links.get(node) ?? []), ...links]);
  }

  control(node: number, control: BpControl): void {
    this.controls.set(node, control);
  }

  /** Cut every road at the nodes on it and produce the segments. */
  finish(): this {
    if (this.finished) return this;
    this.finished = true;
    for (const r of this.roads) {
      this.pin(r.start);
      this.pin(r.end);
    }
    for (const r of this.roads) {
      const hard: number[] = [];
      for (const n of this.nodes) {
        const hit = r.path.project(n.pos.x, n.pos.z);
        if (hit.distance < 0.05 && Math.abs(r.profile.at(hit.s).y - n.pos.y) < 0.2) hard.push(hit.s);
      }
      for (const piece of r.path.pieces(hard, r.profile.breaks())) {
        const y0 = r.profile.at(piece.s0);
        const y1 = r.profile.at(piece.s1);
        const span = piece.s1 - piece.s0;
        const a = this.pin({ ...piece.p0, y: y0.y });
        const b = this.pin({ ...piece.p3, y: y1.y });
        this.segments.push({
          index: this.segments.length,
          road: r,
          a,
          b,
          c1: { x: piece.p1.x, y: y0.y + (y0.slope * span) / 3, z: piece.p1.z },
          c2: { x: piece.p2.x, y: y1.y - (y1.slope * span) / 3, z: piece.p2.z },
        });
      }
    }
    return this;
  }

  /** The segment an arm refers to at a node. */
  armSegment(node: number, arm: Arm): BpSegment {
    const seg = this.segments.find(
      (s) => s.road === arm.road && (arm.side === 'before' ? s.b === node : s.a === node),
    );
    if (!seg) throw new Error(`Road ${arm.road.name} does not meet node ${node}`);
    return seg;
  }

  /**
   * Lane indices of an arm at a node, left to right as the driver sees them.
   * 'in' lists lanes travelling towards the node, 'out' lanes travelling away.
   */
  armLanes(node: number, arm: Arm, way: 'in' | 'out'): number[] {
    const def = this.typeDef(arm.road.type);
    return drivingLaneOrder(def.lanes, arm.side, way);
  }
}

function drivingLaneOrder(lanes: readonly LaneDef[], side: 'before' | 'after', way: 'in' | 'out'): number[] {
  // Before a node, dir 1 lanes arrive. After it, dir 1 lanes leave.
  const dir: 1 | -1 = (side === 'before') === (way === 'in') ? 1 : -1;
  const list: { index: number; lat: number }[] = [];
  lanes.forEach((l, index) => {
    if (l.dir === dir && l.kind === 'drive') list.push({ index, lat: l.dir === 1 ? l.offset : -l.offset });
  });
  list.sort((a, b) => a.lat - b.lat);
  return list.map((l) => l.index);
}

// ---------------------------------------------------------------------------
// Placing a blueprint in the world
// ---------------------------------------------------------------------------

export interface Placement {
  /** Where the template centre goes. Only x and z are used. */
  pos: Vec3;
  /** Radians about +Y, the same sense as headings: positive turns clockwise from above. */
  rotation: number;
  /** Absolute height of the template's base level. */
  elevation: number;
  /** Overrides the main road's type where that makes sense. */
  roadType?: string;
}

export interface WorldFrame {
  point(p: Vec3): Vec3;
  direction(d: Vec3): Vec3;
}

export function worldFrame(placement: Placement): WorldFrame {
  const c = Math.cos(placement.rotation);
  const s = Math.sin(placement.rotation);
  const { x, z } = placement.pos;
  const e = placement.elevation;
  return {
    point: (p) => ({ x: x + p.x * c - p.z * s, y: p.y + e, z: z + p.x * s + p.z * c }),
    direction: (d) => ({ x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c }),
  };
}

/** The cubics of a finished blueprint, in world space. */
export function worldCubics(bp: Blueprint, frame: WorldFrame): Cubic[] {
  return bp.segments.map((s) => ({
    p0: frame.point(bp.nodes[s.a].pos),
    p1: frame.point(s.c1),
    p2: frame.point(s.c2),
    p3: frame.point(bp.nodes[s.b].pos),
  }));
}
