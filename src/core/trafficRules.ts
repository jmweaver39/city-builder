/**
 * Traffic rules, as in a traffic manager: lane arrows, junction restrictions per
 * arm, vehicle bans per lane, speed limits and priority roads. All of it is data
 * on the project, by reference (types in trafficRuleTypes.ts):
 *
 *   JunctionControl.rules.laneArrows   turns allowed per arriving lane
 *   JunctionControl.rules.arms         U-turns, lane changing straight through,
 *                                      entering a blocked junction, pedestrians,
 *                                      turn on red (near and far)
 *   SegmentOverrides.laneBans          vehicle classes kept off a lane
 *   SegmentOverrides.speedKmh / laneSpeeds   speed limits (existing fields)
 *
 * Connectors follow the arrows and rules here (applyTrafficRules, called from
 * laneGraph.ts when a node's lanes are built), so painted turn arrows, signals and
 * the sim follow them too. The sim reads bans and the per-arm switches itself.
 */
import type { RoadNetwork } from './RoadNetwork';
import { canLink, laneRef, turnBetween, type ArmLanes, type LaneEnd, type LaneLinkSpec } from './connectors';
import { effectiveLanes, isOneWay } from './roadTypes';
import { headingOf, wrapAngle } from './math';
import { effectiveControl } from './signals';
import type { Id, JunctionControl, SignKind, TurnKind, Vec3 } from './types';
import type { ArmRuleKey, ArmRules, JunctionRules, VehicleClass } from './trafficRuleTypes';
import { VEHICLE_CLASSES } from './trafficRuleTypes';

export type { ArmRuleKey, ArmRules, JunctionRules, VehicleClass } from './trafficRuleTypes';
export { VEHICLE_CLASSES } from './trafficRuleTypes';

export const TURN_ORDER: readonly TurnKind[] = ['uturn', 'left', 'straight', 'right'];

/** Speed-limit sign values in km/h. UNLIMITED_KMH stands for no limit: vehicles run at their own top speed. */
export const UNLIMITED_KMH = 250;
export const SPEED_SIGNS: readonly number[] = [30, 50, 60, 80, 100, 120, UNLIMITED_KMH];

export function isUnlimited(kmh: number): boolean {
  return kmh >= UNLIMITED_KMH;
}

export function speedLabel(kmh: number): string {
  return isUnlimited(kmh) ? 'No limit' : `${Math.round(kmh)} km/h`;
}

/** Defaults of each arm switch. */
export const ARM_RULE_DEFAULTS: Required<ArmRules> = {
  uturn: false,
  laneChange: false,
  enterBlocked: false,
  pedestrians: true,
  nearTurnOnRed: false,
  farTurnOnRed: false,
};

export const ARM_RULE_KEYS: readonly ArmRuleKey[] = ['uturn', 'laneChange', 'enterBlocked', 'pedestrians', 'nearTurnOnRed', 'farTurnOnRed'];

export const ARM_RULE_NAMES: Record<ArmRuleKey, string> = {
  uturn: 'U-turns',
  laneChange: 'Lane changing straight through',
  enterBlocked: 'Enter a blocked junction',
  pedestrians: 'Pedestrian crossing',
  nearTurnOnRed: 'Right turn on red',
  farTurnOnRed: 'Left turn on red',
};

const isMotor = (l: LaneEnd) => l.kind === 'drive' || l.kind === 'bus';

// ---------------------------------------------------------------------------
// Connectors: lane arrows, U-turns and lane changing straight through
// ---------------------------------------------------------------------------

function hasRules(rules: JunctionRules | undefined): rules is JunctionRules {
  if (!rules) return false;
  return Object.keys(rules.laneArrows ?? {}).length > 0 || Object.keys(rules.arms ?? {}).length > 0;
}

/** Link lanes I to lanes O, sorted left to right, lining up on the side the turn goes. */
function align(out: Map<string, LaneLinkSpec>, I: LaneEnd[], O: LaneEnd[], turn: TurnKind): void {
  if (!I.length || !O.length) return;
  const add = (from: LaneEnd, to: LaneEnd) => {
    const key = `${laneRef(from)}>${laneRef(to)}`;
    if (!out.has(key)) out.set(key, { from, to, turn });
  };
  if (I.length === O.length) {
    I.forEach((l, k) => add(l, O[k]));
    return;
  }
  if (turn === 'left' || turn === 'uturn') {
    I.forEach((l, k) => add(l, O[Math.min(k, O.length - 1)]));
    return;
  }
  if (turn === 'right') {
    I.forEach((_, k) => add(I[I.length - 1 - k], O[Math.max(O.length - 1 - k, 0)]));
    return;
  }
  // Straight: nearest lane across, and lanes left over fan out from the nearest.
  const fed = new Array<boolean>(O.length).fill(false);
  for (const lane of I) {
    let best = 0;
    for (let o = 1; o < O.length; o++) if (Math.abs(O[o].lat - lane.lat) < Math.abs(O[best].lat - lane.lat) - 1e-6) best = o;
    fed[best] = true;
    add(lane, O[best]);
  }
  O.forEach((o, j) => {
    if (fed[j]) return;
    let best = 0;
    for (let k = 1; k < I.length; k++) if (Math.abs(I[k].lat - o.lat) < Math.abs(I[best].lat - o.lat)) best = k;
    add(I[best], o);
  });
}

/** The arms a driver arriving on `from` can leave by, by turn kind. U-turns go back along `from`. */
function exitsByTurn(arms: ArmLanes[], from: number): Map<TurnKind, number[]> {
  const out = new Map<TurnKind, number[]>();
  arms.forEach((arm, i) => {
    if (!arm.outgoing.some(isMotor)) return;
    const turn = i === from ? 'uturn' : turnBetween(arms, from, i);
    if (!out.has(turn)) out.set(turn, []);
    out.get(turn)!.push(i);
  });
  return out;
}

/**
 * The node's links with its traffic rules applied. Without rules this returns
 * `links` itself. Bike lanes are left alone.
 */
export function applyTrafficRules(links: LaneLinkSpec[], arms: ArmLanes[], control: Pick<JunctionControl, 'rules'>): LaneLinkSpec[] {
  const rules = control.rules;
  if (!hasRules(rules) || arms.length < 2) return links;
  const out = new Map<string, LaneLinkSpec>();
  for (const l of links) out.set(`${laneRef(l.from)}>${laneRef(l.to)}`, l);
  const arrows = rules.laneArrows ?? {};

  arms.forEach((arm, ai) => {
    const lanes = arm.incoming.filter(isMotor);
    if (!lanes.length) return;
    const exits = exitsByTurn(arms, ai);
    const armRules = rules.arms?.[arm.segmentId] ?? {};

    // Lane arrows. Once one lane of an arm has arrows, the arm's motor lanes are
    // laid out again from arrows, the others keeping the turns they had.
    const explicit = lanes.some((l) => arrows[laneRef(l)]?.length);
    if (explicit) {
      const turnsOf = new Map<LaneEnd, Set<TurnKind>>();
      for (const l of lanes) {
        const want = (arrows[laneRef(l)] ?? []).filter((t) => exits.has(t));
        const had = new Set<TurnKind>();
        for (const link of out.values()) if (link.from === l) had.add(link.turn);
        turnsOf.set(l, want.length ? new Set(want) : had);
      }
      for (const [key, link] of out) if (lanes.includes(link.from)) out.delete(key);
      for (const [turn, targets] of exits) {
        const I = lanes.filter((l) => turnsOf.get(l)!.has(turn));
        if (!I.length) continue;
        for (const t of targets) {
          const outs = arms[t].outgoing.filter(isMotor);
          const drive = outs.filter((o) => o.kind === 'drive');
          align(out, I, drive.length ? drive : outs, turn);
          const busIn = I.filter((l) => l.kind === 'bus');
          const busOut = outs.filter((o) => o.kind === 'bus');
          if (busIn.length && busOut.length) align(out, busIn, busOut, turn);
        }
      }
    }

    // U-turns from the innermost lane back along the same road.
    if (armRules.uturn && exits.has('uturn') && ![...out.values()].some((l) => lanes.includes(l.from) && l.turn === 'uturn')) {
      const inner = lanes.find((l) => l.kind === 'drive') ?? lanes[0];
      const back = arm.outgoing.filter((o) => o.kind === 'drive' && canLink(inner.kind, o.kind));
      if (back.length) align(out, [inner], back, 'uturn');
    }

    // Lane changing while going straight: a straight lane may also end next door.
    if (armRules.laneChange) {
      for (const link of [...out.values()]) {
        if (link.turn !== 'straight' || !lanes.includes(link.from)) continue;
        const target = arms.find((a) => a.segmentId === link.to.segmentId && a.outgoing.includes(link.to));
        if (!target) continue;
        const outs = target.outgoing.filter((o) => o.kind === link.to.kind);
        const j = outs.indexOf(link.to);
        for (const o of [outs[j - 1], outs[j + 1]]) {
          if (!o) continue;
          const key = `${laneRef(link.from)}>${laneRef(o)}`;
          if (!out.has(key)) out.set(key, { from: link.from, to: o, turn: 'straight' });
        }
      }
    }
  });
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Reading arrows and arm rules
// ---------------------------------------------------------------------------

export interface LaneArrowInfo {
  ref: string;
  segmentId: Id;
  laneIndex: number;
  /** Turns the lane takes now, from its connectors. */
  turns: TurnKind[];
  /** Turns it could be given here. */
  available: TurnKind[];
  /** True when the lane's arrows were set by hand. */
  explicit: boolean;
  /** End of the lane at the stop line, and its direction of travel. */
  pos: Vec3;
  dir: Vec3;
}

/** Does this arm's road carry traffic away from the node? */
function leaves(net: RoadNetwork, nodeId: Id, segId: Id): boolean {
  const seg = net.getSegment(segId);
  if (!seg) return false;
  const lanes = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  const dir = seg.a === nodeId ? 1 : -1;
  return lanes.some((l) => l.dir === dir && (l.kind === 'drive' || l.kind === 'bus'));
}

/** Every arriving motor lane at a node with its turns, for the lane arrow tool. */
export function laneArrowsAt(net: RoadNetwork, nodeId: Id): LaneArrowInfo[] {
  const graph = net.laneGraph;
  const node = net.getNode(nodeId);
  const geom = net.nodeGeom(nodeId);
  if (!node || !geom || geom.kind !== 'junction') return [];
  const arrows = node.control.rules?.laneArrows ?? {};
  const possible = net.connectionsAt(nodeId);
  const turnsFrom = new Map<Id, Set<TurnKind>>();
  for (const c of possible) {
    if (c.turn === 'uturn') continue;
    if (!turnsFrom.has(c.fromSegment)) turnsFrom.set(c.fromSegment, new Set());
    turnsFrom.get(c.fromSegment)!.add(c.turn);
  }
  const current = new Map<number, Set<TurnKind>>();
  for (const idx of graph.connectorsAt.get(nodeId) ?? []) {
    const c = graph.lanes[idx];
    if (!current.has(c.fromLane)) current.set(c.fromLane, new Set());
    current.get(c.fromLane)!.add(c.turn ?? 'straight');
  }
  const out: LaneArrowInfo[] = [];
  for (const arm of geom.arms) {
    const seg = net.getSegment(arm.segmentId);
    if (!seg) continue;
    const lanes = effectiveLanes(net.roadTypeOf(arm.segmentId), seg.overrides);
    const dense = graph.roadLanes.get(arm.segmentId) ?? [];
    const arriveDir = arm.atStart ? -1 : 1;
    const avail = new Set(turnsFrom.get(arm.segmentId) ?? []);
    if (leaves(net, nodeId, arm.segmentId)) avail.add('uturn');
    lanes.forEach((l, i) => {
      if (l.dir !== arriveDir || (l.kind !== 'drive' && l.kind !== 'bus')) return;
      const idx = dense[i];
      if (idx === undefined || idx < 0) return;
      const gl = graph.lanes[idx];
      const n = gl.cum.length;
      if (n < 2) return;
      const pos = { x: gl.pts[n * 3 - 3], y: gl.pts[n * 3 - 2], z: gl.pts[n * 3 - 1] };
      const dx = pos.x - gl.pts[n * 3 - 6];
      const dz = pos.z - gl.pts[n * 3 - 4];
      const len = Math.hypot(dx, dz) || 1;
      const ref = `${arm.segmentId}:${i}`;
      out.push({
        ref,
        segmentId: arm.segmentId,
        laneIndex: i,
        turns: TURN_ORDER.filter((t) => current.get(idx)?.has(t)),
        available: TURN_ORDER.filter((t) => avail.has(t)),
        explicit: !!arrows[ref]?.length,
        pos,
        dir: { x: dx / len, y: 0, z: dz / len },
      });
    });
  }
  return out;
}

function withRules(net: RoadNetwork, nodeId: Id, edit: (rules: JunctionRules) => void): void {
  const node = net.getNode(nodeId);
  if (!node) return;
  const rules: JunctionRules = structuredClone(node.control.rules ?? {});
  edit(rules);
  net.setJunctionControl(nodeId, { rules: tidyRules(rules) });
}

/** Drop empty parts so a junction with nothing set has no `rules` at all. */
export function tidyRules(rules: JunctionRules | undefined): JunctionRules | undefined {
  if (!rules) return undefined;
  const out: JunctionRules = {};
  if (rules.laneArrows) {
    const arrows: Record<string, TurnKind[]> = {};
    for (const [k, v] of Object.entries(rules.laneArrows)) if (v.length) arrows[k] = TURN_ORDER.filter((t) => v.includes(t));
    if (Object.keys(arrows).length) out.laneArrows = arrows;
  }
  if (rules.arms) {
    const arms: Record<number, ArmRules> = {};
    for (const [k, v] of Object.entries(rules.arms)) {
      const kept: ArmRules = {};
      for (const key of ARM_RULE_KEYS) if (v[key] !== undefined && v[key] !== ARM_RULE_DEFAULTS[key]) kept[key] = v[key];
      if (Object.keys(kept).length) arms[Number(k)] = kept;
    }
    if (Object.keys(arms).length) out.arms = arms;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Set the turns one arriving lane may take, or null to go back to automatic.
 * Turns the lane cannot take here are dropped; nothing left means automatic.
 */
export function setLaneArrows(net: RoadNetwork, nodeId: Id, ref: string, turns: TurnKind[] | null): void {
  const info = laneArrowsAt(net, nodeId).find((l) => l.ref === ref);
  const allowed = info ? (turns ?? []).filter((t) => info.available.includes(t)) : [];
  withRules(net, nodeId, (r) => {
    r.laneArrows = { ...(r.laneArrows ?? {}) };
    if (allowed.length) r.laneArrows[ref] = allowed;
    else delete r.laneArrows[ref];
  });
}

/**
 * Turn one arrow of a lane on or off. The last arrow of a lane cannot go: every
 * lane needs a way out. Returns what happened, for the tool to say.
 */
export function toggleLaneArrow(net: RoadNetwork, nodeId: Id, ref: string, turn: TurnKind): { ok: boolean; reason?: string; turns?: TurnKind[] } {
  const info = laneArrowsAt(net, nodeId).find((l) => l.ref === ref);
  if (!info) return { ok: false, reason: 'No lane arrives there.' };
  if (!info.available.includes(turn)) return { ok: false, reason: 'There is no way to go that way from this lane.' };
  const now = new Set(info.turns);
  if (now.has(turn)) {
    if (now.size === 1) return { ok: false, reason: 'A lane needs at least one way out.' };
    now.delete(turn);
  } else now.add(turn);
  const turns = TURN_ORDER.filter((t) => now.has(t));
  setLaneArrows(net, nodeId, ref, turns);
  return { ok: true, turns };
}

/** Clear every lane arrow at a node. */
export function resetLaneArrows(net: RoadNetwork, nodeId: Id): void {
  withRules(net, nodeId, (r) => delete r.laneArrows);
}

export function armRule(control: Pick<JunctionControl, 'rules'> | undefined, segId: Id, key: ArmRuleKey): boolean {
  return control?.rules?.arms?.[segId]?.[key] ?? ARM_RULE_DEFAULTS[key];
}

/** Why a switch does nothing on this arm, or null when it applies. */
export function armRuleRefusal(net: RoadNetwork, nodeId: Id, segId: Id, key: ArmRuleKey): string | null {
  const geom = net.nodeGeom(nodeId);
  const def = net.roadTypeOf(segId);
  const seg = net.getSegment(segId);
  if (!geom || geom.kind !== 'junction' || !seg) return 'Not a junction.';
  const arm = geom.arms.find((a) => a.segmentId === segId);
  if (!arm) return 'Not an arm of this junction.';
  const arriving = effectiveLanes(def, seg.overrides).some((l) => l.dir === (arm.atStart ? -1 : 1) && (l.kind === 'drive' || l.kind === 'bus'));
  if (key === 'pedestrians') return null;
  if (!arriving) return 'No traffic arrives on this road.';
  if (key === 'uturn' && !leaves(net, nodeId, segId)) return 'One-way: there is nowhere to turn back to.';
  if (key === 'nearTurnOnRed' || key === 'farTurnOnRed') {
    if (effectiveControl(net, nodeId).kind !== 'signal') return 'Only at traffic lights.';
    if (key === 'farTurnOnRed' && !isOneWay(def)) return 'Left on red is only from a one-way road.';
  }
  return null;
}

/** Set one switch on one arm. Setting the default clears it. */
export function setArmRule(net: RoadNetwork, nodeId: Id, segId: Id, key: ArmRuleKey, value: boolean): void {
  withRules(net, nodeId, (r) => {
    r.arms = { ...(r.arms ?? {}) };
    r.arms[segId] = { ...(r.arms[segId] ?? {}), [key]: value };
  });
  if (key === 'pedestrians') {
    // No crossing: no crosswalk painted, so nobody is routed across.
    const node = net.getNode(nodeId)!;
    const crosswalks = { ...node.control.crosswalks };
    if (value) {
      if (crosswalks[segId] === 'none') delete crosswalks[segId];
    } else crosswalks[segId] = 'none';
    net.setJunctionControl(nodeId, { crosswalks });
  }
}

/** Turn a switch the other way. Returns the new value. */
export function toggleArmRule(net: RoadNetwork, nodeId: Id, segId: Id, key: ArmRuleKey): boolean {
  const next = !armRule(net.getNode(nodeId)?.control, segId, key);
  setArmRule(net, nodeId, segId, key, next);
  return next;
}

// ---------------------------------------------------------------------------
// Keeping rules attached through edits (called by RoadNetwork)
// ---------------------------------------------------------------------------

/** A road at this node was split and its end here renamed. */
export function renameRulesSegment(control: JunctionControl, from: Id, to: Id): void {
  const r = control.rules;
  if (!r) return;
  if (r.arms && r.arms[from]) {
    r.arms[to] = r.arms[from];
    delete r.arms[from];
  }
  if (r.laneArrows) {
    const next: Record<string, TurnKind[]> = {};
    for (const [ref, turns] of Object.entries(r.laneArrows)) {
      const [seg, lane] = ref.split(':');
      next[Number(seg) === from ? `${to}:${lane}` : ref] = turns;
    }
    r.laneArrows = next;
  }
}

/** A road left this node. */
export function stripRulesSegment(control: JunctionControl, id: Id): void {
  const r = control.rules;
  if (!r) return;
  if (r.arms) delete r.arms[id];
  if (r.laneArrows) for (const ref of Object.keys(r.laneArrows)) if (ref.startsWith(`${id}:`)) delete r.laneArrows[ref];
  const tidy = tidyRules(r);
  if (tidy) control.rules = tidy;
  else delete control.rules;
}

/**
 * Before a road is turned round: lane arrows keyed by its lanes move to the lane
 * that will sit in the same place running the same way, or go when there is none.
 * Arm switches belong to the arm and stay.
 */
export function mirrorRulesOnReverse(net: RoadNetwork, nodeId: Id, id: Id): void {
  const node = net.getNode(nodeId);
  const arrows = node?.control.rules?.laneArrows;
  if (!node || !arrows) return;
  const def = net.roadTypeOf(id);
  const next: Record<string, TurnKind[]> = {};
  for (const [ref, turns] of Object.entries(arrows)) {
    const [seg, lane] = ref.split(':').map(Number);
    if (seg !== id) {
      next[ref] = turns;
      continue;
    }
    const here = def.lanes[lane];
    const j = here ? def.lanes.findIndex((l) => l.dir === -here.dir && Math.abs(l.offset + here.offset) < 0.01) : -1;
    if (j >= 0) next[`${id}:${j}`] = turns;
  }
  node.control.rules = tidyRules({ ...node.control.rules, laneArrows: next });
  if (!node.control.rules) delete node.control.rules;
}

// ---------------------------------------------------------------------------
// Vehicle restrictions
// ---------------------------------------------------------------------------

/** Classes kept off one lane. */
export function laneBans(net: RoadNetwork, segId: Id, laneIndex: number): VehicleClass[] {
  return net.getSegment(segId)?.overrides.laneBans?.[laneIndex] ?? [];
}

/**
 * Ban or allow classes on lanes of a road. `lanes` null means every driving lane.
 * `allowed` lists who may use them; everyone else is banned.
 */
export function setLaneVehicles(net: RoadNetwork, segId: Id, lanes: number[] | null, allowed: VehicleClass[]): void {
  const seg = net.getSegment(segId);
  if (!seg) return;
  const defs = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  const which = lanes ?? defs.map((_, i) => i).filter((i) => defs[i].kind !== 'rail');
  const bans: Record<number, VehicleClass[]> = { ...(seg.overrides.laneBans ?? {}) };
  for (const i of which) {
    if (!defs[i] || defs[i].kind === 'rail') continue;
    const banned = VEHICLE_CLASSES.filter((c) => !allowed.includes(c) && classUses(c, defs[i].kind));
    if (banned.length) bans[i] = banned;
    else delete bans[i];
  }
  net.setSegmentOverrides(segId, { laneBans: Object.keys(bans).length ? bans : undefined });
}

/** Toggle one class on lanes of a road (null: all lanes). Returns whether it is now allowed. */
export function toggleLaneVehicle(net: RoadNetwork, segId: Id, lanes: number[] | null, cls: VehicleClass): boolean {
  const seg = net.getSegment(segId);
  if (!seg) return false;
  const defs = effectiveLanes(net.roadTypeOf(segId), seg.overrides);
  const which = (lanes ?? defs.map((_, i) => i)).filter((i) => defs[i] && classUses(cls, defs[i].kind));
  if (!which.length) return false;
  const nowAllowed = which.some((i) => !(seg.overrides.laneBans?.[i] ?? []).includes(cls));
  const bans: Record<number, VehicleClass[]> = { ...(seg.overrides.laneBans ?? {}) };
  for (const i of which) {
    const set = new Set(bans[i] ?? []);
    if (nowAllowed) set.add(cls);
    else set.delete(cls);
    const list = VEHICLE_CLASSES.filter((c) => set.has(c));
    if (list.length) bans[i] = list;
    else delete bans[i];
  }
  net.setSegmentOverrides(segId, { laneBans: Object.keys(bans).length ? bans : undefined });
  return !nowAllowed;
}

/** Could this class use a lane of this kind at all, bans aside? */
export function classUses(cls: VehicleClass, kind: string): boolean {
  if (kind === 'bike') return cls === 'bike';
  if (kind === 'bus') return cls === 'bus' || cls === 'emergency';
  if (kind === 'drive') return cls !== 'bike';
  return false;
}

// ---------------------------------------------------------------------------
// Speed limits
// ---------------------------------------------------------------------------

/** Set a road's limit (null: back to its type's), clearing per-lane limits. */
export function setRoadSpeed(net: RoadNetwork, segId: Id, kmh: number | null): void {
  net.setSegmentOverrides(segId, { speedKmh: kmh ?? undefined, laneSpeeds: undefined });
}

/** Set one lane's limit (null clears it). */
export function setLaneSpeed(net: RoadNetwork, segId: Id, laneIndex: number, kmh: number | null): void {
  const seg = net.getSegment(segId);
  if (!seg) return;
  const speeds = { ...(seg.overrides.laneSpeeds ?? {}) };
  if (kmh === null) delete speeds[laneIndex];
  else speeds[laneIndex] = kmh;
  net.setSegmentOverrides(segId, { laneSpeeds: Object.keys(speeds).length ? speeds : undefined });
}

// ---------------------------------------------------------------------------
// Priority roads
// ---------------------------------------------------------------------------

/** Most a road may bend through a junction and still be the same road. */
const CONTINUE_LIMIT = 0.7;

/**
 * The road a segment belongs to, followed through plain joints and on through
 * junctions along the straightest arm, stopping at roundabouts and where no arm
 * carries on. Segments in order along the road, and the junctions passed.
 */
export function priorityRoadPath(net: RoadNetwork, segmentId: Id): { segments: Id[]; junctions: Id[] } {
  const start = net.getSegment(segmentId);
  if (!start) return { segments: [], junctions: [] };
  const used = new Set<Id>([segmentId]);
  const junctions: Id[] = [];
  const walk = (seg: Id, node: Id, out: Id[]) => {
    for (let guard = 0; guard < 400; guard++) {
      const geom = net.nodeGeom(node);
      if (!geom || geom.arms.length < 2) return;
      if (geom.arms.some((a) => net.roadTypeOf(a.segmentId).category === 'roundabout')) return;
      const here = geom.arms.find((a) => a.segmentId === seg);
      if (!here) return;
      let best: Id | null = null;
      let bestGap = CONTINUE_LIMIT;
      for (const a of geom.arms) {
        if (a.segmentId === seg || used.has(a.segmentId)) continue;
        if (net.roadTypeOf(a.segmentId).category === 'rail') continue;
        const gap = Math.abs(wrapAngle(headingOf(a.dir) - headingOf(here.dir) - Math.PI));
        if (gap < bestGap) {
          bestGap = gap;
          best = a.segmentId;
        }
      }
      if (best === null) return;
      if (geom.kind === 'junction') junctions.push(node);
      used.add(best);
      out.push(best);
      const s = net.getSegment(best)!;
      seg = best;
      node = s.a === node ? s.b : s.a;
    }
  };
  const back: Id[] = [];
  const ahead: Id[] = [];
  walk(segmentId, start.a, back);
  walk(segmentId, start.b, ahead);
  return { segments: [...back.reverse(), segmentId, ...ahead], junctions };
}

export interface PriorityRoadResult {
  segments: Id[];
  /** Junctions given signs. */
  signed: Id[];
  /** Junctions left alone: lights, or free-flowing. */
  skipped: Id[];
}

/**
 * Make a whole road a priority road: at every junction along it, its two arms get
 * priority and every side road yields. Junctions with lights keep them.
 */
export function applyPriorityRoad(net: RoadNetwork, segmentId: Id, plan = false): PriorityRoadResult {
  const { segments, junctions } = priorityRoadPath(net, segmentId);
  const onRoad = new Set(segments);
  const result: PriorityRoadResult = { segments, signed: [], skipped: [] };
  const edits: { node: Id; signs: Record<number, SignKind> }[] = [];
  for (const nodeId of junctions) {
    const node = net.getNode(nodeId)!;
    const geom = net.nodeGeom(nodeId)!;
    if (node.control.mode === 'signal' || (node.control.mode === 'auto' && effectiveKind(net, nodeId) !== 'priority')) {
      result.skipped.push(nodeId);
      continue;
    }
    const signs: Record<number, SignKind> = {};
    for (const arm of geom.arms) {
      if (net.roadTypeOf(arm.segmentId).category === 'rail') continue;
      signs[arm.segmentId] = onRoad.has(arm.segmentId) ? 'priority' : node.control.signs[arm.segmentId] === 'stop' ? 'stop' : 'yield';
    }
    edits.push({ node: nodeId, signs });
    result.signed.push(nodeId);
  }
  if (!plan && edits.length) {
    net.batch(() => {
      for (const e of edits) net.setJunctionControl(e.node, { mode: 'priority', signs: e.signs });
    });
  }
  return result;
}

function effectiveKind(net: RoadNetwork, nodeId: Id): string {
  return effectiveControl(net, nodeId).kind;
}
