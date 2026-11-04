/**
 * Junction > Rules: a traffic manager in one tool, with a mode per kind of rule
 * (trafficRuleSettings.ts). Rules show on the map as icons while the tool is on,
 * and most are changed by clicking those icons or the road under them:
 *
 *   arrows    per arriving lane, an arrow per possible turn; click to toggle
 *   speed     click a road to give it the picked sign (Shift: one lane)
 *   vehicles  click a road to ban or allow the picked class (Shift: one lane)
 *   junction  per arm, an icon per restriction; click to toggle
 *   priority  click a road: priority all along it, side roads yield
 *   manual    click a junction with lights, then its lights to switch them
 *   timed     copy and paste a plan, or click junctions in order for a green wave
 *   clear     buttons in the tray remove traffic and pause spawning
 *
 * Network edits go through core/trafficRules.ts and core/signalTools.ts, so they
 * are undoable and saved. Hand light control lives in the sim and is not saved.
 */
import type { NetworkChange } from '../core/RoadNetwork';
import { effectiveLanes, effectiveSpeedKmh, laneSpeedKmh } from '../core/roadTypes';
import { effectiveControl, movementsAt } from '../core/signals';
import {
  applyPriorityRoad,
  ARM_RULE_KEYS,
  ARM_RULE_NAMES,
  armRule,
  armRuleRefusal,
  classUses,
  laneArrowsAt,
  priorityRoadPath,
  setLaneSpeed,
  setRoadSpeed,
  speedLabel,
  toggleArmRule,
  toggleLaneArrow,
  toggleLaneVehicle,
  SPEED_SIGNS,
  VEHICLE_CLASSES,
} from '../core/trafficRules';
import type { ArmRuleKey, VehicleClass } from '../core/trafficRuleTypes';
import { applyGreenWave, copySignalPlan, cycleOf, pasteSignalPlan, planAt, type PlanClip } from '../core/signalTools';
import type { Id, TurnKind, Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { castRay, chooseHit, isJunctionNode, pickRoad } from './pick';
import { Tool } from './Tool';
import { arrowSvg, lightSvg, ruleSvg, signSvg, speedSignSvg, vehicleSvg } from './trafficArt';
import { RULE_MODES, type RuleMode } from './trafficRuleSettings';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

/** A clickable icon on the map. */
interface Hot {
  pos: Vec3;
  /** What a click does. Returns a line for the readout, or null. */
  act: () => string | null;
  tip: string;
}

const ICON_PX = 26;
const HIT_PX = 15;
/** Overlay icons are drawn this far round the cursor, unless "show all" is on. */
const OVERLAY_REACH = 450;
const MAX_ICONS = 500;
/** The junction under work stays chosen while the cursor is this close to it. */
const STICKY_M = 70;

export const VEHICLE_NAMES: Record<VehicleClass, string> = {
  car: 'Cars',
  van: 'Vans',
  truck: 'Trucks',
  bus: 'Buses',
  bike: 'Bikes',
  emergency: 'Emergency',
};

const TURN_NAMES: Record<TurnKind, string> = { left: 'Left', straight: 'Straight', right: 'Right', uturn: 'U-turn' };

export class TrafficRulesTool extends Tool {
  readonly id: ToolId = 'trafficRules';
  /** The junction being edited in the arrows, junction and manual modes. */
  node: Id | null = null;
  private hots: Hot[] = [];
  private hotIndex = -1;
  /** Copied signal plan, for paste. */
  clip: PlanClip | null = null;
  /** Junctions picked for a green wave, in order. */
  wave: Id[] = [];
  private hoverRoad: { segmentId: Id; lane: number | null } | null = null;

  get mode(): RuleMode {
    return this.ctx.settings.trafficRules.mode;
  }

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.node = null;
    this.hots = [];
    this.hotIndex = -1;
    this.hoverRoad = null;
    this.ctx.view.setHighlight(null);
  }

  settingsChanged(): void {
    if (this.mode !== 'timed') this.wave = [];
    if (this.mode !== 'arrows' && this.mode !== 'junction' && this.mode !== 'manual') this.node = null;
    this.refresh();
  }

  networkChanged(change: NetworkChange): void {
    if (change.reset) {
      this.node = null;
      this.wave = [];
    }
    if (this.node !== null && !this.ctx.net.getNode(this.node)) this.node = null;
    this.wave = this.wave.filter((id) => !!this.ctx.net.getNode(id));
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  private ground(e: ToolPointer): Vec3 | null {
    return this.ctx.view.pickPlane(e.x, e.y, 0);
  }

  private junctionAt(e: ToolPointer): Id | null {
    const net = this.ctx.net;
    const hit = chooseHit(castRay(this.ctx, e, 6), (h) => h.kind === 'node' && isJunctionNode(net, h.id));
    if (hit) return hit.id;
    // On an arm near a junction counts too, as when aiming at its lane ends.
    const road = pickRoad(this.ctx, e);
    if (!road) return null;
    const seg = net.getSegment(road.segmentId)!;
    const geom = net.segmentGeom(road.segmentId);
    if (!geom) return null;
    const s = road.t * geom.fullLength;
    const ends = [
      { node: seg.a, d: s - geom.trimA },
      { node: seg.b, d: geom.fullLength - s - geom.trimB },
    ].sort((p, q) => p.d - q.d);
    for (const end of ends) if (end.d < 30 && isJunctionNode(net, end.node)) return end.node;
    return null;
  }

  /** Pixels per metre near a point, for laying icons out at a steady screen size. */
  private metresPerPx(pos: Vec3): number {
    const a = this.ctx.view.project(pos);
    const b = this.ctx.view.project({ x: pos.x + 1, y: pos.y, z: pos.z });
    const c = this.ctx.view.project({ x: pos.x, y: pos.y, z: pos.z + 1 });
    if (!a || !b || !c) return 0.15;
    const px = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y), 0.5);
    return 1 / px;
  }

  private hotAt(e: ToolPointer): number {
    let best = -1;
    let bestD = HIT_PX;
    this.hots.forEach((h, i) => {
      const p = this.ctx.view.project(h.pos);
      if (!p) return;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** The road and, with a lane wanted, the lane nearest the cursor. */
  private roadAt(e: ToolPointer, wantLane: boolean): { segmentId: Id; lane: number | null } | null {
    const road = pickRoad(this.ctx, e, 2);
    if (!road) return null;
    if (this.ctx.net.roadTypeOf(road.segmentId).category === 'rail') return null;
    if (!wantLane) return { segmentId: road.segmentId, lane: null };
    const seg = this.ctx.net.getSegment(road.segmentId)!;
    const lanes = effectiveLanes(this.ctx.net.roadTypeOf(road.segmentId), seg.overrides);
    let best = -1;
    lanes.forEach((l, i) => {
      if (l.kind === 'rail') return;
      if (best < 0 || Math.abs(l.offset - road.lateral) < Math.abs(lanes[best].offset - road.lateral)) best = i;
    });
    return { segmentId: road.segmentId, lane: best >= 0 ? best : null };
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.track(e);
    this.refresh();
  }

  private track(e: ToolPointer): void {
    const mode = this.mode;
    this.hoverRoad = null;
    if (mode === 'arrows' || mode === 'junction' || mode === 'manual') {
      // Over one of the junction's own icons, it stays the junction being edited.
      const id = this.hotAt(e) >= 0 ? this.node : this.junctionAt(e);
      if (id !== null) this.node = id;
      else if (this.node !== null) {
        const g = this.ground(e);
        const n = this.ctx.net.getNode(this.node);
        if (!g || !n || Math.hypot(g.x - n.pos.x, g.z - n.pos.z) > STICKY_M + (this.ctx.net.nodeGeom(this.node)?.arms.length ?? 0) * 4) this.node = null;
      }
    } else if (mode === 'speed' || mode === 'vehicles' || mode === 'priority') {
      this.hoverRoad = this.roadAt(e, e.shift && mode !== 'priority');
    } else if (mode === 'timed') {
      this.node = this.junctionAt(e);
    }
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.track(e);
    this.refresh();
    const i = this.hotAt(e);
    if (i >= 0) {
      const line = this.hots[i].act();
      if (line) this.ctx.toast(line);
      this.refresh();
      return;
    }
    const { net, history, settings } = this.ctx;
    const s = settings.trafficRules;
    const mode = this.mode;
    if (mode === 'speed' && this.hoverRoad) {
      const { segmentId, lane } = this.hoverRoad;
      history.hint(lane === null ? 'Set speed limit' : 'Set lane speed limit');
      if (lane === null) setRoadSpeed(net, segmentId, s.speed);
      else setLaneSpeed(net, segmentId, lane, s.speed);
    } else if (mode === 'vehicles' && this.hoverRoad) {
      const { segmentId, lane } = this.hoverRoad;
      history.hint(`Ban or allow ${VEHICLE_NAMES[s.vehicle].toLowerCase()}`);
      const allowed = toggleLaneVehicle(net, segmentId, lane === null ? null : [lane], s.vehicle);
      this.ctx.toast(`${VEHICLE_NAMES[s.vehicle]} ${allowed ? 'allowed' : 'banned'} on ${lane === null ? 'this road' : 'this lane'}.`);
    } else if (mode === 'priority' && this.hoverRoad) {
      this.priorityClick(this.hoverRoad.segmentId, e.shift);
    } else if (mode === 'manual') {
      this.manualClick();
    } else if (mode === 'timed') {
      this.timedClick();
    } else if (mode === 'clear') {
      this.ctx.toast('Use the buttons in the tray to clear traffic.');
    }
    this.refresh();
  }

  back(): boolean {
    if (this.mode === 'timed' && this.wave.length) {
      this.wave.pop();
      this.refresh();
      return true;
    }
    if (this.node !== null) {
      this.node = null;
      this.refresh();
      return true;
    }
    return false;
  }

  keyDown(e: ToolKey): boolean {
    const s = this.ctx.settings.trafficRules;
    if ((e.key === '[' || e.key === ']') && (this.mode === 'speed' || this.mode === 'vehicles')) {
      const step = e.key === ']' ? 1 : -1;
      if (this.mode === 'speed') {
        const list: (number | null)[] = [...SPEED_CARDS];
        const at = list.indexOf(s.speed);
        s.speed = list[(at + step + list.length) % list.length];
      } else {
        const at = VEHICLE_CLASSES.indexOf(s.vehicle);
        s.vehicle = VEHICLE_CLASSES[(at + step + VEHICLE_CLASSES.length) % VEHICLE_CLASSES.length];
      }
      this.ctx.changed();
      this.refresh();
      return true;
    }
    if (e.key === 'Enter' && this.mode === 'timed' && s.timed === 'wave') {
      this.makeWave();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private priorityClick(segmentId: Id, undo: boolean): void {
    const { net, history } = this.ctx;
    if (undo) {
      const { junctions } = priorityRoadPath(net, segmentId);
      const touched = junctions.filter((id) => net.getNode(id)!.control.mode === 'priority');
      if (!touched.length) {
        this.ctx.toast('Nothing to clear along this road.');
        return;
      }
      history.hint('Clear priority road');
      net.batch(() => {
        for (const id of touched) net.setJunctionControl(id, { mode: 'auto', signs: {} });
      });
      this.ctx.toast(`${touched.length} junction${touched.length === 1 ? '' : 's'} back to auto.`);
      return;
    }
    const plan = applyPriorityRoad(net, segmentId, true);
    if (!plan.signed.length) {
      this.ctx.toast(plan.skipped.length ? 'Every junction along this road has lights or flows freely.' : 'No junctions along this road.', 'warning');
      return;
    }
    history.hint('Priority road');
    const r = applyPriorityRoad(net, segmentId);
    const skipped = r.skipped.length ? `, ${r.skipped.length} with lights left alone` : '';
    this.ctx.toast(`Priority road: ${r.signed.length} junction${r.signed.length === 1 ? '' : 's'} signed${skipped}.`);
  }

  private manualClick(): void {
    const sim = this.ctx.sim;
    if (this.node === null) return;
    if (!sim?.setManualSignal) {
      this.ctx.toast('The simulation is not running.', 'warning');
      return;
    }
    if (sim.isManualSignal?.(this.node)) return;
    if (!planAt(this.ctx.net, this.node)) {
      this.ctx.toast('This junction has no traffic lights. Give it lights with Control first.', 'warning');
      return;
    }
    if (sim.setManualSignal(this.node, true)) this.ctx.toast('Hand control: click a light to switch it. Back to automatic in the tray.');
    this.ctx.changed();
  }

  /** Give every junction under hand control back to its plan. */
  releaseAll(): number {
    const sim = this.ctx.sim;
    let n = 0;
    for (const node of this.ctx.net.nodes) {
      if (sim?.isManualSignal?.(node.id)) {
        sim.setManualSignal?.(node.id, false);
        n++;
      }
    }
    this.refresh();
    this.ctx.changed();
    return n;
  }

  private timedClick(): void {
    const { net, history, settings } = this.ctx;
    const s = settings.trafficRules;
    const id = this.node;
    if (id === null) return;
    const plan = planAt(net, id);
    if (s.timed === 'copy') {
      const clip = copySignalPlan(net, id);
      if (!clip) {
        this.ctx.toast('This junction has no traffic lights to copy.', 'warning');
        return;
      }
      this.clip = clip;
      s.timed = 'paste';
      this.ctx.changed();
      this.ctx.toast(`Copied a ${clip.plan.phases.length}-phase plan. Click junctions to paste it.`);
      return;
    }
    if (s.timed === 'paste') {
      if (!this.clip) {
        this.ctx.toast('Copy a plan first.', 'warning');
        return;
      }
      if (id === this.clip.source) return;
      history.hint('Paste signal plan');
      const r = pasteSignalPlan(net, this.clip, id);
      this.ctx.toast(r.ok ? `Pasted: ${r.matched} movements matched${r.added ? `, ${r.added} added` : ''}.` : r.reason, r.ok ? 'info' : 'warning');
      return;
    }
    if (!plan) {
      this.ctx.toast('Only junctions with traffic lights join a green wave.', 'warning');
      return;
    }
    const at = this.wave.indexOf(id);
    if (at >= 0) this.wave.splice(at, 1);
    else this.wave.push(id);
    this.ctx.changed();
  }

  makeWave(): void {
    const { net, history, settings } = this.ctx;
    history.hint('Green wave');
    const r = applyGreenWave(net, this.wave, settings.trafficRules.waveSpeed);
    if (!r.ok) {
      this.ctx.toast(r.reason, 'warning');
      return;
    }
    this.ctx.toast(`Green wave at ${settings.trafficRules.waveSpeed} km/h over ${this.wave.length} junctions, ${Math.round(r.cycleSec)} s cycle.`);
    this.wave = [];
    this.ctx.changed();
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  private segmentsNear(): Id[] {
    const net = this.ctx.net;
    const s = this.ctx.settings.trafficRules;
    if (s.showAll) return net.segments.map((x) => x.id).slice(0, MAX_ICONS);
    const g = this.pointer ? this.ground(this.pointer) : null;
    if (!g) return [];
    const r = OVERLAY_REACH;
    return net.segmentsInRegion({ minX: g.x - r, minZ: g.z - r, maxX: g.x + r, maxZ: g.z + r }, true).slice(0, MAX_ICONS);
  }

  private nodesNear(): Id[] {
    const net = this.ctx.net;
    if (this.ctx.settings.trafficRules.showAll) return net.nodes.map((n) => n.id).filter((id) => isJunctionNode(net, id));
    const g = this.pointer ? this.ground(this.pointer) : null;
    if (!g) return [];
    const r = OVERLAY_REACH;
    return net.nodesInRegion({ minX: g.x - r, minZ: g.z - r, maxX: g.x + r, maxZ: g.z + r }).filter((id) => isJunctionNode(net, id));
  }

  /** Where a lane is at the middle of a road. */
  private laneMid(segId: Id, lane: number | null): { pos: Vec3; along: Vec3; right: Vec3 } | null {
    const net = this.ctx.net;
    const geom = net.segmentGeom(segId);
    const seg = net.getSegment(segId);
    if (!geom || !seg || geom.stations.length < 2) return null;
    const st = geom.stations[Math.floor(geom.stations.length / 2)];
    const off = lane === null ? 0 : (effectiveLanes(net.roadTypeOf(segId), seg.overrides)[lane]?.offset ?? 0);
    return { pos: { x: st.pos.x + st.right.x * off, y: st.pos.y, z: st.pos.z + st.right.z * off }, along: st.tangent, right: st.right };
  }

  refresh(): void {
    const marks: ToolMark[] = [];
    this.hots = [];
    const mode = this.mode;
    if (mode === 'arrows') this.showArrows(marks);
    else if (mode === 'speed') this.showSpeeds(marks);
    else if (mode === 'vehicles') this.showVehicles(marks);
    else if (mode === 'junction') this.showJunctionRules(marks);
    else if (mode === 'priority') this.showPriority(marks);
    else if (mode === 'manual') this.showManual(marks);
    else if (mode === 'timed') this.showTimed(marks);
    const e = this.pointer;
    this.hotIndex = e ? this.hotAt(e) : -1;
    if (this.hotIndex >= 0) {
      const h = this.hots[this.hotIndex];
      for (const m of marks) if (m.kind === 'icon' && m.pos === h.pos) m.ring = COLORS.snap;
    }
    this.ctx.setMarks(marks);
    this.hud();
  }

  private hud(): void {
    const e = this.pointer;
    if (!e) return;
    const info = RULE_MODES.find((m) => m.mode === this.mode)!;
    const s = this.ctx.settings.trafficRules;
    const lines = [info.name];
    const notes: string[] = [];
    if (this.hotIndex >= 0) notes.push(this.hots[this.hotIndex].tip);
    else if (this.mode === 'speed') {
      lines.push(s.speed === null ? 'Road default' : speedLabel(s.speed));
      notes.push(this.hoverRoad ? (this.hoverRoad.lane === null ? 'Click to set this road (Shift: one lane)' : 'Click to set this lane') : 'Click a road');
    } else if (this.mode === 'vehicles') {
      lines.push(VEHICLE_NAMES[s.vehicle]);
      notes.push(this.hoverRoad ? `Click to ban or allow on ${this.hoverRoad.lane === null ? 'this road (Shift: one lane)' : 'this lane'}` : 'Click a road');
    } else if (this.mode === 'priority') notes.push(this.hoverRoad ? 'Click: priority along this road. Shift+click: back to auto' : 'Click a road');
    else if (this.mode === 'manual') {
      const manual = this.node !== null && this.ctx.sim?.isManualSignal?.(this.node);
      notes.push(this.node === null ? 'Click a junction with lights' : manual ? 'Click a light to switch it' : 'Click to take control of these lights');
    } else if (this.mode === 'timed') {
      notes.push(
        s.timed === 'copy' ? 'Click a junction with lights to copy its plan' : s.timed === 'paste' ? (this.clip ? 'Click junctions to paste the plan' : 'Copy a plan first') : `Click junctions in order (${this.wave.length} picked), Enter to link`,
      );
    } else if (this.mode === 'clear') notes.push('Use the buttons in the tray');
    else notes.push(this.node === null ? 'Point at a junction' : 'Click an icon to switch it');
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: 'ok' });
  }

  private showArrows(marks: ToolMark[]): void {
    const net = this.ctx.net;
    // Junctions nearby with arrows set by hand get a quiet mark, so they can be found.
    for (const id of this.nodesNear()) {
      if (id === this.node) continue;
      if (Object.keys(net.getNode(id)?.control.rules?.laneArrows ?? {}).length) marks.push({ kind: 'icon', pos: net.getNode(id)!.pos, svg: arrowSvg('straight', true), size: 18, dim: true });
    }
    if (this.node === null) return;
    const nodeId = this.node;
    for (const lane of laneArrowsAt(net, nodeId)) {
      if (lane.available.length < 1) continue;
      const mpp = this.metresPerPx(lane.pos);
      const gap = (ICON_PX + 3) * mpp;
      const base = { x: lane.pos.x - lane.dir.x * (gap * 0.7 + 1), y: lane.pos.y, z: lane.pos.z - lane.dir.z * (gap * 0.7 + 1) };
      lane.available.forEach((turn, k) => {
        const pos = { x: base.x - lane.dir.x * gap * k, y: base.y, z: base.z - lane.dir.z * gap * k };
        const on = lane.turns.includes(turn);
        marks.push({ kind: 'icon', pos, svg: arrowSvg(turn, on), size: ICON_PX });
        this.hots.push({
          pos,
          tip: `${TURN_NAMES[turn]}: ${on ? 'click to forbid' : 'click to allow'}`,
          act: () => {
            this.ctx.history.hint('Lane arrows');
            const r = toggleLaneArrow(net, nodeId, lane.ref, turn);
            return r.ok ? null : (r.reason ?? null);
          },
        });
      });
    }
  }

  private showSpeeds(marks: ToolMark[]): void {
    const net = this.ctx.net;
    const hover = this.hoverRoad;
    for (const id of this.segmentsNear()) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      const def = net.roadTypeOf(id);
      if (def.category === 'rail') continue;
      const lanes = effectiveLanes(def, seg.overrides);
      const perLane = !!seg.overrides.laneSpeeds;
      const items: { lane: number | null; kmh: number }[] = perLane
        ? lanes.map((l, i) => ({ lane: i, kmh: laneSpeedKmh(def, seg.overrides, i), kind: l.kind })).filter((x) => x.kind !== 'rail' && x.kind !== 'bike')
        : [{ lane: null, kmh: effectiveSpeedKmh(def, seg.overrides) }];
      for (const it of items) {
        const at = this.laneMid(id, it.lane);
        if (!at) continue;
        const own = seg.overrides.speedKmh !== undefined || perLane;
        marks.push({ kind: 'icon', pos: at.pos, svg: speedSignSvg(it.kmh), size: perLane ? 20 : 24, dim: !own && hover?.segmentId !== id });
      }
    }
    if (hover) {
      this.ctx.view.setHighlight({ segments: [hover.segmentId], color: COLORS.snap });
      const s = this.ctx.settings.trafficRules;
      const at = this.laneMid(hover.segmentId, hover.lane);
      if (at) {
        const mpp = this.metresPerPx(at.pos);
        marks.push({ kind: 'icon', pos: { x: at.pos.x + at.right.x * 34 * mpp, y: at.pos.y, z: at.pos.z + at.right.z * 34 * mpp }, svg: speedSignSvg(s.speed), size: 30, ring: COLORS.ok });
      }
    } else this.ctx.view.setHighlight(null);
  }

  private showVehicles(marks: ToolMark[]): void {
    const net = this.ctx.net;
    const s = this.ctx.settings.trafficRules;
    const hover = this.hoverRoad;
    for (const id of this.segmentsNear()) {
      const seg = net.getSegment(id);
      if (!seg) continue;
      const bans = seg.overrides.laneBans;
      const hovered = hover?.segmentId === id;
      if (!bans && !hovered) continue;
      const lanes = effectiveLanes(net.roadTypeOf(id), seg.overrides);
      // Lanes with the same bans share one row of icons, at the first of them.
      const rows = new Map<string, number[]>();
      lanes.forEach((l, i) => {
        if (l.kind === 'rail') return;
        const list = bans?.[i] ?? [];
        if (!list.length && !hovered) return;
        const key = hovered ? String(i) : list.join(',');
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key)!.push(i);
      });
      for (const group of rows.values()) {
        const at = this.laneMid(id, group.length === 1 ? group[0] : null);
        if (!at) continue;
        const mpp = this.metresPerPx(at.pos);
        const list = bans?.[group[0]] ?? [];
        const shown: { cls: VehicleClass; allowed: boolean }[] = hovered
          ? [{ cls: s.vehicle, allowed: !list.includes(s.vehicle) && classUses(s.vehicle, lanes[group[0]].kind) }]
          : list.map((cls) => ({ cls, allowed: false }));
        shown.forEach((x, k) => {
          const d = (k - (shown.length - 1) / 2) * (22 * mpp);
          marks.push({ kind: 'icon', pos: { x: at.pos.x + at.along.x * d, y: at.pos.y, z: at.pos.z + at.along.z * d }, svg: vehicleSvg(x.cls, x.allowed), size: 20 });
        });
      }
    }
    this.ctx.view.setHighlight(hover ? { segments: [hover.segmentId], color: COLORS.snap } : null);
  }

  private showJunctionRules(marks: ToolMark[]): void {
    const net = this.ctx.net;
    const only = this.ctx.settings.trafficRules.rule;
    for (const id of this.nodesNear()) {
      if (id === this.node) continue;
      const arms = net.getNode(id)?.control.rules?.arms;
      if (arms && Object.keys(arms).length) marks.push({ kind: 'icon', pos: net.getNode(id)!.pos, svg: ruleSvg('uturn', true), size: 18, dim: true });
    }
    if (this.node === null) return;
    const nodeId = this.node;
    const geom = net.nodeGeom(nodeId);
    if (!geom) return;
    const control = net.getNode(nodeId)!.control;
    for (const arm of geom.arms) {
      if (net.roadTypeOf(arm.segmentId).category === 'rail') continue;
      const keys = ARM_RULE_KEYS.filter((k) => (only === null || k === only) && armRuleRefusal(net, nodeId, arm.segmentId, k) === null);
      if (!keys.length) continue;
      const mpp = this.metresPerPx(arm.centre);
      const gap = (ICON_PX + 3) * mpp;
      const right = { x: -arm.cutDir.z, y: 0, z: arm.cutDir.x };
      const base = { x: arm.centre.x + arm.cutDir.x * (gap + 3), y: arm.centre.y, z: arm.centre.z + arm.cutDir.z * (gap + 3) };
      keys.forEach((key, k) => {
        const d = (k - (keys.length - 1) / 2) * gap;
        const pos = { x: base.x + right.x * d, y: base.y, z: base.z + right.z * d };
        const on = armRule(control, arm.segmentId, key);
        marks.push({ kind: 'icon', pos, svg: ruleSvg(key, on), size: ICON_PX });
        this.hots.push({
          pos,
          tip: `${ARM_RULE_NAMES[key]}: ${on ? 'allowed, click to forbid' : 'not allowed, click to allow'}`,
          act: () => {
            this.ctx.history.hint(ARM_RULE_NAMES[key]);
            const now = toggleArmRule(net, nodeId, arm.segmentId, key as ArmRuleKey);
            return `${ARM_RULE_NAMES[key]} ${now ? 'allowed' : 'not allowed'} on this arm.`;
          },
        });
      });
    }
  }

  private showPriority(marks: ToolMark[]): void {
    const net = this.ctx.net;
    const hover = this.hoverRoad;
    const plan = hover ? applyPriorityRoad(net, hover.segmentId, true) : null;
    const path = plan ? new Set(plan.segments) : null;
    const ghost = new Set(plan?.signed ?? []);
    const nodes = new Set([...this.nodesNear(), ...ghost]);
    for (const id of nodes) {
      const geom = net.nodeGeom(id);
      const node = net.getNode(id);
      if (!geom || !node) continue;
      const ec = effectiveControl(net, id);
      if (ec.kind !== 'priority' && !ghost.has(id)) continue;
      for (const arm of geom.arms) {
        let sign = ec.signs[arm.segmentId];
        if (ghost.has(id)) sign = path!.has(arm.segmentId) ? 'priority' : node.control.signs[arm.segmentId] === 'stop' ? 'stop' : 'yield';
        if (!sign || sign === 'none') continue;
        const pos = { x: arm.centre.x + arm.cutDir.x * 6, y: arm.centre.y, z: arm.centre.z + arm.cutDir.z * 6 };
        marks.push({ kind: 'icon', pos, svg: signSvg(sign), size: ghost.has(id) ? 22 : 18, dim: !ghost.has(id) && ec.auto });
      }
    }
    this.ctx.view.setHighlight(plan ? { segments: plan.segments, color: COLORS.ok } : null);
  }

  private showManual(marks: ToolMark[]): void {
    const net = this.ctx.net;
    const sim = this.ctx.sim;
    for (const id of this.nodesNear()) {
      if (id === this.node || !planAt(net, id)) continue;
      const manual = sim?.isManualSignal?.(id);
      marks.push({ kind: 'icon', pos: net.getNode(id)!.pos, svg: lightSvg('straight', true), size: manual ? 22 : 16, dim: !manual, ring: manual ? COLORS.warn : undefined });
    }
    if (this.node === null || !sim?.isManualSignal?.(this.node)) {
      if (this.node !== null && planAt(net, this.node)) marks.push({ kind: 'ring', pos: net.getNode(this.node)!.pos, color: COLORS.snap, radius: 9 });
      return;
    }
    const nodeId = this.node;
    const states = sim.signalMovements?.(nodeId) ?? {};
    const geom = net.nodeGeom(nodeId);
    if (!geom) return;
    const moves = movementsAt(net, nodeId);
    for (const arm of geom.arms) {
      const own = moves.filter((m) => m.fromSegment === arm.segmentId);
      if (!own.length) continue;
      const groups = (['uturn', 'left', 'straight', 'right'] as TurnKind[]).map((t) => ({ turn: t, keys: own.filter((m) => m.turn === t).map((m) => m.key) })).filter((g) => g.keys.length);
      const mpp = this.metresPerPx(arm.centre);
      const gap = (ICON_PX + 3) * mpp;
      // Lights face arriving drivers, laid out as they see them: left on their left.
      const driverRight = { x: arm.cutDir.z, y: 0, z: -arm.cutDir.x };
      const base = { x: arm.centre.x + arm.cutDir.x * (gap + 2), y: arm.centre.y, z: arm.centre.z + arm.cutDir.z * (gap + 2) };
      groups.forEach((g, k) => {
        const d = (k - (groups.length - 1) / 2) * gap;
        const pos = { x: base.x + driverRight.x * d, y: base.y, z: base.z + driverRight.z * d };
        const green = g.keys.some((key) => states[key]);
        marks.push({ kind: 'icon', pos, svg: lightSvg(g.turn, green), size: ICON_PX });
        this.hots.push({
          pos,
          tip: `${TURN_NAMES[g.turn]}: ${green ? 'green, click for red' : 'red, click for green'}`,
          act: () => {
            for (const key of g.keys) sim.setManualMovement?.(nodeId, key, !green);
            return null;
          },
        });
      });
    }
  }

  private showTimed(marks: ToolMark[]): void {
    const net = this.ctx.net;
    for (const id of this.nodesNear()) {
      const plan = planAt(net, id);
      if (!plan) continue;
      const pos = net.getNode(id)!.pos;
      const at = this.wave.indexOf(id);
      const auto = effectiveControl(net, id).auto;
      marks.push({
        kind: 'label',
        pos: { x: pos.x, y: pos.y + 2, z: pos.z },
        text: at >= 0 ? `${at + 1}` : `${Math.round(cycleOf(plan))} s${plan.offsetSec ? ` +${Math.round(plan.offsetSec)}` : ''}${auto ? ' auto' : ''}`,
        color: at >= 0 ? COLORS.ok : this.clip?.source === id ? COLORS.warn : undefined,
      });
    }
    for (let i = 1; i < this.wave.length; i++) {
      const a = net.getNode(this.wave[i - 1])?.pos;
      const b = net.getNode(this.wave[i])?.pos;
      if (a && b) marks.push({ kind: 'line', points: [a, b], color: COLORS.ok, width: 0.8, dashed: true });
    }
    if (this.node !== null) marks.push({ kind: 'ring', pos: net.getNode(this.node)!.pos, color: planAt(net, this.node) ? COLORS.snap : COLORS.bad, radius: 9 });
  }
}

/** Speed sign cards in order; null is the road's own limit. */
export const SPEED_CARDS: readonly (number | null)[] = [...SPEED_SIGNS, null];
