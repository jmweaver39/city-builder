/**
 * Middle-click copy (an eyedropper) and paste.
 *
 * copyAt takes the top-most thing under the cursor, by the same ray picking the
 * tools use: a painted mark, a hand-placed or automatic marking, a junction, or a
 * road. It returns a Clip (clipFormat.ts), a description of the look that can be
 * pasted anywhere. pasteAt applies a clip to the matching thing under the cursor
 * as one undo step. useClip readies the tools to build with it: the Build tool
 * takes a copied road type and its settings, the Markings tool a copied style.
 *
 * Headless: the app layer (app/clipboard.ts) wires mouse, keys, the system
 * clipboard and the on-screen feedback to these.
 */
import { autoLineSpec, crosswalkSpec, DOUBLE_SPACING, FILL_STANDARDS, lineStandard, matchFillStandard, matchStandard } from '../core/paintStandard';
import { autoLinesOf, decalFill, decalLook, isArrowDecal, roadSpeed } from '../core/paintCoherence';
import { fillOf, fillPatch, fillStyleInfo, lineStyleInfo, styleOf, stylePatch, type FillStyleSpec } from '../core/markingStyle';
import type { RoadNetwork } from '../core/RoadNetwork';
import { builtinRoadType, totalHalfWidth } from '../core/roadTypes';
import { movementsAt } from '../core/signals';
import { fitSignalPlan, type PlanClip } from '../core/signalTools';
import { applyJunctionShape } from '../core/junctionShape';
import { segmentFootprintIssues } from '../core/walls';
import { STRUCTURE_MODES } from '../core/wallTypes';
import type { JunctionRules } from '../core/trafficRuleTypes';
import type { DecalKind, Id, JunctionShape, LineRule, LineStyleSpec, MovementKey, MovementState, SignalPlan, TurnKind, Vec3 } from '../core/types';
import type { DecalInit } from '../core/RoadNetwork';
import { canConvert, convertAutoItem, decalOutline, hitOutline, markingAt, removeAutoLine, type MarkingHit } from './markingOps';
import { castRay, chooseHit, pickDecal, pickRoad } from './pick';
import { upgradeSegment } from './roadOps';
import type { ToolManager } from './ToolManager';
import { ROAD_STYLE_KEYS, type Clip, type JunctionClip, type MarkingClip, type MarkingLook, type RoadClip, type RoadStyle } from './clipFormat';
import type { MarkingDraw, ToolContext, ToolPointer } from './types';

export * from './clipFormat';

// ---------------------------------------------------------------------------
// What is under the cursor
// ---------------------------------------------------------------------------

export type ClipTarget =
  | { kind: 'road'; segmentId: Id }
  | { kind: 'junction'; nodeId: Id }
  | { kind: 'decal'; id: Id }
  | { kind: 'marking'; hit: MarkingHit };

type At = Pick<ToolPointer, 'x' | 'y'>;

/**
 * A few pixels round an automatic road line, when zoomed in enough to aim at one
 * (as the Markings tool does). Pasting a marking style is aimed at a line anyway,
 * so `always` takes the line from further out, up to 0.8 m.
 */
function lineReach(ctx: ToolContext, p: Vec3, always = false): number | undefined {
  const a = ctx.view.project(p);
  const b = ctx.view.project({ x: p.x + 1, y: p.y, z: p.z });
  if (!a || !b) return undefined;
  const pxPerMetre = Math.hypot(b.x - a.x, b.y - a.y);
  if (always) return Math.min(0.8, 5 / Math.max(pxPerMetre, 1e-6));
  return pxPerMetre < 18 ? undefined : 5 / pxPerMetre;
}

export function isJunction(net: RoadNetwork, id: Id): boolean {
  return net.nodeGeom(id)?.kind === 'junction';
}

/**
 * The top-most thing under the cursor: paint sits on top of the surface it is on,
 * a bridge on top of the road below it. `want` limits the answer to one kind (for
 * pasting), in which case a marking or junction may give way to the road it is on.
 */
export function targetAt(ctx: ToolContext, e: At, want?: 'road' | 'junction' | 'marking'): ClipTarget | null {
  const { net } = ctx;
  const top = chooseHit(castRay(ctx, e), () => true);
  if (!want || want === 'marking') {
    const decal = pickDecal(ctx, e);
    if (decal !== null) return { kind: 'decal', id: decal };
    if (top) {
      const hit = markingAt(net, top.point, { lineReach: lineReach(ctx, top.point, want === 'marking') });
      if (hit) return { kind: 'marking', hit };
    }
    if (want) return null;
  }
  if (want === 'junction') {
    if (top?.kind === 'node' && isJunction(net, top.id)) return { kind: 'junction', nodeId: top.id };
    const node = chooseHit(castRay(ctx, e), (h) => h.kind === 'node' && isJunction(net, h.id));
    return node ? { kind: 'junction', nodeId: node.id } : null;
  }
  if (!want && top?.kind === 'node' && isJunction(net, top.id)) return { kind: 'junction', nodeId: top.id };
  if (!want && top?.kind === 'segment') return { kind: 'road', segmentId: top.id };
  // A plain joint or dead end: the road it belongs to.
  const road = pickRoad(ctx, e);
  return road ? { kind: 'road', segmentId: road.segmentId } : null;
}

/** World lines to flash round a target. */
export function targetOutline(net: RoadNetwork, t: ClipTarget): Vec3[][] {
  if (t.kind === 'decal') return [decalOutline(net, t.id)].filter((l) => l.length > 1);
  if (t.kind === 'marking') return [hitOutline(net, t.hit)].filter((l) => l.length > 1);
  if (t.kind === 'junction') {
    const o = net.nodeGeom(t.nodeId)?.outline ?? [];
    return o.length > 2 ? [[...o, o[0]].map((p) => ({ ...p, y: p.y + 0.15 }))] : [];
  }
  const st = net.segmentGeom(t.segmentId)?.stations ?? [];
  if (st.length < 2 || !net.getSegment(t.segmentId)) return [];
  const half = totalHalfWidth(net.roadTypeOf(t.segmentId));
  const edge = (s: number) => st.map((p) => ({ x: p.pos.x + p.right.x * half * s, y: p.pos.y + 0.15, z: p.pos.z + p.right.z * half * s }));
  return [edge(-1), edge(1)];
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/** "Avenue 4-lane with grass median with trees and lights": the road type, then what was added to it. */
export function roadClipName(typeName: string, style: RoadStyle): string {
  const extras: string[] = [];
  const u = style.upgrades;
  const sides = [u?.left, u?.right, u?.median];
  if (sides.some((s) => s?.trees === 'trees' || s?.trees === 'grass')) extras.push('trees');
  if (sides.some((s) => s?.trees === 'hedge')) extras.push('hedges');
  if (sides.some((s) => s?.lights && s.lights !== 'none')) extras.push('lights');
  if (sides.some((s) => s?.rail)) extras.push('guard rails');
  if ([u?.left, u?.right].some((s) => s?.busStop)) extras.push('bus stops');
  if ([u?.left, u?.right].some((s) => s?.bikeRacks)) extras.push('bike racks');
  const b = style.barriers;
  if ((b?.left && b.left.kind !== 'none') || (b?.right && b.right.kind !== 'none')) extras.push('sound barriers');
  if (style.structure && style.structure.mode !== 'auto') {
    extras.push((STRUCTURE_MODES.find((m) => m.value === style.structure!.mode)?.label ?? style.structure.mode).toLowerCase());
  }
  if (style.surface && style.surface !== 'asphalt') extras.push(`${style.surface === 'darkAsphalt' ? 'dark asphalt' : style.surface} surface`);
  if (style.speedKmh !== undefined) extras.push(`${style.speedKmh} km/h`);
  if (style.laneKinds || style.laneSpeeds || style.laneBans) extras.push('lane edits');
  if (!extras.length) return typeName;
  const last = extras.pop()!;
  return `${typeName} with ${extras.length ? `${extras.join(', ')} and ${last}` : last}`;
}

export function copyRoad(net: RoadNetwork, segmentId: Id): RoadClip | null {
  const seg = net.getSegment(segmentId);
  if (!seg) return null;
  const def = net.roadTypeOf(segmentId);
  const style: RoadStyle = {};
  for (const k of ROAD_STYLE_KEYS) {
    const v = seg.overrides[k];
    if (v !== undefined) (style as Record<string, unknown>)[k] = structuredClone(v);
  }
  const clip: RoadClip = { kind: 'road', name: roadClipName(def.name, style), roadType: def.id, style };
  if (!builtinRoadType(def.id)) clip.typeDef = structuredClone(def);
  return clip;
}

const COLOUR_WORD: Record<string, string> = { white: 'white', yellow: 'yellow', blue: 'blue', red: 'red', green: 'green' };

export function lookName(look: MarkingLook): string {
  if (look.shape === 'line') {
    const std = matchStandard(look.spec);
    if (std) return std.name;
    const label = lineStyleInfo(look.spec.style).label;
    return look.spec.hex ? `${label}, own colour` : `${label} ${COLOUR_WORD[look.spec.color] ?? look.spec.color}`;
  }
  if (look.shape === 'fill') return matchFillStandard(look.fill)?.name ?? `${fillStyleInfo(look.fill.fill).label} area`;
  if (look.stamp === 'text') return `Text "${look.text ?? ''}"`;
  const arrow: Record<string, string> = {
    arrowStraight: 'Arrow, straight on',
    arrowLeft: 'Arrow, left',
    arrowRight: 'Arrow, right',
    arrowStraightLeft: 'Arrow, straight or left',
    arrowStraightRight: 'Arrow, straight or right',
  };
  return arrow[look.stamp] ?? 'Stamp';
}

function markingClip(look: MarkingLook): MarkingClip {
  return { kind: 'marking', name: lookName(look), look };
}

/** The look of a hand-placed line, with its parts that run between its own ends. */
function lineLook(spec: LineStyleSpec, rules: readonly LineRule[] | undefined): MarkingLook {
  const look: MarkingLook = { shape: 'line', spec: styleOf(spec) };
  const parts = (rules ?? []).flatMap((r) => ('end' in r.from && 'end' in r.to ? [{ from: r.from.end, to: r.to.end, style: styleOf(r.style) }] : []));
  if (parts.length) look.parts = parts;
  return look;
}

function turnsOfLane(net: RoadNetwork, segId: Id, lane: number): Set<TurnKind> {
  const g = net.laneGraph;
  const idx = g.roadLanes.get(segId)?.[lane];
  const out = new Set<TurnKind>();
  if (idx === undefined) return out;
  for (const nx of g.lanes[idx].next) {
    const t = g.lanes[nx]?.turn;
    if (t) out.add(t);
  }
  return out;
}

function arrowKindOf(turns: Set<TurnKind>): DecalKind {
  const s = turns.has('straight');
  const l = turns.has('left');
  const r = turns.has('right');
  if (s && l && !r) return 'arrowStraightLeft';
  if (s && r && !l) return 'arrowStraightRight';
  if (l && !s && !r) return 'arrowLeft';
  if (r && !s && !l) return 'arrowRight';
  return 'arrowStraight';
}

export function copyMarking(net: RoadNetwork, t: ClipTarget): MarkingClip | null {
  if (t.kind === 'decal') {
    const d = net.decals.find((x) => x.id === t.id);
    if (!d) return null;
    if (d.kind === 'fill' || d.kind === 'hatch') {
      const f = decalFill(d);
      return f ? markingClip({ shape: 'fill', fill: fillOf(f as FillStyleSpec) }) : null;
    }
    if (isArrowDecal(d) || d.kind === 'text') {
      const look: MarkingLook = { shape: 'stamp', stamp: d.kind, color: d.color, width: d.width };
      if (d.kind === 'text') look.text = d.text ?? '';
      return markingClip(look);
    }
    const spec = decalLook(d);
    return spec ? markingClip({ shape: 'line', spec: styleOf(spec) }) : null;
  }
  if (t.kind !== 'marking') return null;
  const hit = t.hit;
  if (hit.kind === 'user') {
    const m = net.markingsOf(hit.host).find((x) => x.id === hit.id);
    if (!m) return null;
    return markingClip(m.kind === 'filler' ? { shape: 'fill', fill: fillOf(m) } : lineLook(m, m.rules));
  }
  if (hit.kind === 'autoLine') {
    const line = autoLinesOf(net, hit.segmentId).find((l) => l.key === hit.key);
    if (!line || line.style === 'none') return null;
    const r = autoLineSpec(line.style, line.color, line.width, roadSpeed(net, hit.segmentId));
    const spec: LineStyleSpec = { style: line.style, color: line.color, width: r?.width ?? line.width };
    if (line.hex) spec.hex = line.hex;
    // Doubles keep the standard spacing; dashes are left to follow the road's speed.
    if (line.style === 'double' && r) spec.gap = DOUBLE_SPACING - r.width;
    return markingClip({ shape: 'line', spec });
  }
  const ref = hit.item.ref;
  switch (ref.kind) {
    case 'crosswalk': {
      const node = net.getNode(hit.nodeId);
      const seg = net.getSegment(ref.segmentId);
      const own = node?.control.crosswalks[ref.segmentId];
      const style = own && own !== 'none' ? own : (seg?.overrides.markings?.crosswalk ?? (seg ? net.roadTypeOf(ref.segmentId).markings.crosswalk : 'zebra'));
      return markingClip({ shape: 'line', spec: { ...(crosswalkSpec(style) ?? lineStandard('zebra').spec) } });
    }
    case 'stop':
      return markingClip({ shape: 'line', spec: { ...lineStandard(hit.item.label.startsWith('Yield') ? 'giveWay' : 'stop').spec } });
    case 'guide':
      return markingClip({ shape: 'line', spec: { ...lineStandard('guide').spec } });
    case 'gore':
      return markingClip({ shape: 'fill', fill: { ...FILL_STANDARDS.find((f) => f.id === 'gore')!.spec } });
    case 'arrow':
      return markingClip({ shape: 'stamp', stamp: arrowKindOf(turnsOfLane(net, ref.segmentId, ref.lane)), color: 'white', width: 1 });
  }
  return null;
}

/** Road arms of a node, clockwise, rail left out (as the signal copy counts them). */
export function roadArms(net: RoadNetwork, nodeId: Id): Id[] {
  return (net.nodeGeom(nodeId)?.arms ?? []).filter((a) => net.roadTypeOf(a.segmentId).category !== 'rail').map((a) => a.segmentId);
}

const MODE_NAMES: Record<string, string> = { auto: 'Automatic', priority: 'Priority signs', allStop: 'All-way stop', signal: 'Traffic lights' };

export function copyJunction(net: RoadNetwork, nodeId: Id): JunctionClip | null {
  const node = net.getNode(nodeId);
  if (!node || !isJunction(net, nodeId)) return null;
  const arms = roadArms(net, nodeId);
  if (!arms.length) return null;
  const pos = new Map(arms.map((id, i) => [id, i]));
  const pairKey = (key: string): string | null => {
    const [a, b] = key.split('>').map(Number);
    const i = pos.get(a);
    const j = pos.get(b);
    return i === undefined || j === undefined ? null : `${i}>${j}`;
  };
  const c = node.control;
  const turns: Record<string, TurnKind> = {};
  for (const m of movementsAt(net, nodeId)) {
    const k = pairKey(m.key);
    if (k) turns[k] = m.turn;
  }
  const signs: Record<string, JunctionClip['signs'][string]> = {};
  for (const [seg, sign] of Object.entries(c.signs)) {
    const i = pos.get(Number(seg));
    if (i !== undefined && sign !== 'none') signs[String(i)] = sign;
  }
  let signal: SignalPlan | null = null;
  if (c.signal) {
    signal = {
      ...structuredClone(c.signal),
      phases: c.signal.phases.map((p) => {
        const moves: Record<MovementKey, MovementState> = {};
        for (const [k, s] of Object.entries(p.moves)) {
          const pk = pairKey(k);
          if (pk) moves[pk] = s;
        }
        return { ...structuredClone(p), moves };
      }),
    };
  }
  const name = `${arms.length}-way junction, ${MODE_NAMES[c.mode] ?? c.mode}${c.shape ? ', shaped' : ''}`;
  const clip: JunctionClip = { kind: 'junction', name, arms: arms.length, turns, mode: c.mode, signs, signal };
  const r = c.rules;
  if (r && (r.arms || r.laneArrows)) {
    const rules: NonNullable<JunctionClip['rules']> = {};
    if (r.arms) {
      rules.arms = {};
      for (const [seg, ar] of Object.entries(r.arms)) {
        const i = pos.get(Number(seg));
        if (i !== undefined) rules.arms[String(i)] = structuredClone(ar);
      }
    }
    if (r.laneArrows) {
      rules.laneArrows = {};
      for (const [ref, t] of Object.entries(r.laneArrows)) {
        const [seg, lane] = ref.split(':').map(Number);
        const i = pos.get(seg);
        if (i !== undefined) rules.laneArrows[`${i}:${lane}`] = [...t];
      }
    }
    clip.rules = rules;
  }
  const s = c.shape;
  if (s) {
    const shape: NonNullable<JunctionClip['shape']> = {};
    if (s.corners) {
      shape.corners = {};
      for (const [k, v] of Object.entries(s.corners)) {
        const pk = pairKey(k);
        if (pk) shape.corners[pk] = { ...v };
      }
    }
    if (s.arms) {
      shape.arms = {};
      for (const [seg, v] of Object.entries(s.arms)) {
        const i = pos.get(Number(seg));
        if (i !== undefined) shape.arms[String(i)] = { ...v };
      }
    }
    if (s.islands?.length) {
      shape.islands = s.islands.flatMap((isl) => {
        const i = pos.get(isl.segmentId);
        return i === undefined ? [] : [{ arm: i, from: isl.from, to: isl.to, back: isl.back, reach: isl.reach }];
      });
    }
    if (s.scale !== undefined) shape.scale = s.scale;
    clip.shape = shape;
  }
  return clip;
}

export function copyTarget(net: RoadNetwork, t: ClipTarget): Clip | null {
  if (t.kind === 'road') return copyRoad(net, t.segmentId);
  if (t.kind === 'junction') return copyJunction(net, t.nodeId);
  return copyMarking(net, t);
}

/** Copy what is under the cursor. */
export function copyAt(ctx: ToolContext, e: At): { clip: Clip; target: ClipTarget } | null {
  const target = targetAt(ctx, e);
  if (!target) return null;
  const clip = copyTarget(ctx.net, target);
  return clip ? { clip, target } : null;
}

// ---------------------------------------------------------------------------
// Pasting
// ---------------------------------------------------------------------------

export type PasteResult = { ok: true; message: string; target: ClipTarget; warning?: string } | { ok: false; message: string };

/** Make sure a clip's road type exists here, adding a custom one that came with it. Null when it can't. */
export function ensureRoadType(net: RoadNetwork, clip: RoadClip): string | null {
  if (net.roadType(clip.roadType)) return clip.roadType;
  if (!clip.typeDef) return null;
  try {
    net.setCustomRoadType(clip.typeDef);
  } catch {
    return null;
  }
  return clip.roadType;
}

/** Give a road the copied type and settings. Inside a batch; returns a warning or null. */
function applyRoadStyle(net: RoadNetwork, id: Id, clip: RoadClip): string | null {
  upgradeSegment(net, id, clip.roadType, false);
  const patch: Record<string, unknown> = {};
  for (const k of ROAD_STYLE_KEYS) patch[k] = clip.style[k] === undefined ? undefined : structuredClone(clip.style[k]);
  let warning: string | null = null;
  const structure = clip.style.structure;
  if (structure && structure.mode !== 'auto') {
    const bad = segmentFootprintIssues(net, id, structure).find((i) => i.severity === 'error');
    if (bad) {
      delete patch.structure;
      warning = `Structure left as it was: ${bad.message}`;
    }
  }
  net.setSegmentOverrides(id, patch);
  return warning;
}

/** Paste a road clip onto one segment, as one undo step. */
export function pasteRoad(ctx: ToolContext, clip: RoadClip, segmentId: Id): PasteResult {
  const { net } = ctx;
  const seg = net.getSegment(segmentId);
  if (!seg) return { ok: false, message: 'That road is gone.' };
  const isRail = (type: string | undefined) => (type ? net.roadType(type)?.category === 'rail' : false);
  const typeRail = clip.typeDef ? clip.typeDef.category === 'rail' : isRail(clip.roadType);
  if (typeRail !== isRail(seg.roadType)) return { ok: false, message: typeRail ? 'Track style only pastes onto track.' : 'A road style does not paste onto track.' };
  if (!net.roadType(clip.roadType) && !clip.typeDef) return { ok: false, message: `This map has no road type "${clip.roadType}".` };
  ctx.history.hint('Paste road style');
  let warning: string | null = null;
  let failed = false;
  net.batch(() => {
    if (!ensureRoadType(net, clip)) {
      failed = true;
      return;
    }
    warning = applyRoadStyle(net, segmentId, clip);
  });
  if (failed) return { ok: false, message: `Could not add the road type "${clip.roadType}".` };
  return { ok: true, message: `Pasted ${clip.name}`, target: { kind: 'road', segmentId }, ...(warning ? { warning } : {}) };
}

/** Upgrade's Paste style: one road of a sweep, inside the sweep's undo step. */
export function pasteRoadInStroke(net: RoadNetwork, clip: RoadClip, segmentId: Id): string | null {
  if (!ensureRoadType(net, clip)) return `This map has no road type "${clip.roadType}".`;
  const seg = net.getSegment(segmentId);
  if (!seg) return null;
  const isRail = (type: string) => net.roadType(type)?.category === 'rail';
  if (isRail(seg.roadType) !== isRail(clip.roadType)) return null;
  return applyRoadStyle(net, segmentId, clip);
}

function partsToRules(look: Extract<MarkingLook, { shape: 'line' }>): LineRule[] | undefined {
  return look.parts?.length ? look.parts.map((p) => ({ from: { end: p.from }, to: { end: p.to }, style: { ...p.style } })) : undefined;
}

const MISMATCH: Record<MarkingLook['shape'], string> = { line: 'a line', fill: 'an area', stamp: 'an arrow or text' };

/** Give a decal a look, or say why it can't take it. Inside a batch. */
function restyleDecal(net: RoadNetwork, id: Id, look: MarkingLook): string | null {
  const d = net.decals.find((x) => x.id === id);
  if (!d) return 'That mark is gone.';
  const isFill = d.kind === 'fill' || d.kind === 'hatch';
  const isStamp = isArrowDecal(d) || d.kind === 'text';
  const shape: MarkingLook['shape'] = isFill ? 'fill' : isStamp ? 'stamp' : 'line';
  if (shape !== look.shape) return `The copied style is ${MISMATCH[look.shape]}; this is ${MISMATCH[shape]}.`;
  let patch: Partial<DecalInit>;
  if (look.shape === 'line') patch = { style: { ...look.spec }, color: look.spec.color, width: look.spec.width };
  else if (look.shape === 'fill') patch = { kind: look.fill.fill === 'solid' ? 'fill' : 'hatch', fill: { ...look.fill }, color: look.fill.color };
  else {
    if (look.stamp === 'text' && !(look.text ?? '').trim()) return 'The copied text is empty.';
    patch = { kind: look.stamp, color: look.color, width: look.width, text: look.stamp === 'text' ? look.text : undefined };
  }
  net.updateDecal(id, patch);
  return null;
}

/** Give a hand-placed marking a look. Inside a batch. */
function restyleMarking(net: RoadNetwork, host: { kind: 'node' | 'segment'; id: Id }, id: Id, look: MarkingLook): string | null {
  const m = net.markingsOf(host).find((x) => x.id === id);
  if (!m) return 'That marking is gone.';
  const shape: MarkingLook['shape'] = m.kind === 'filler' ? 'fill' : 'line';
  if (look.shape !== shape) return `The copied style is ${MISMATCH[look.shape]}; this is ${MISMATCH[shape]}.`;
  if (look.shape === 'fill') net.updateMarking(host, id, fillPatch(look.fill));
  else if (look.shape === 'line') net.updateMarking(host, id, { ...stylePatch(look.spec), rules: partsToRules(look) });
  return null;
}

/** What shape of look a slot takes, or why it takes none. */
function slotShape(net: RoadNetwork, t: ClipTarget): MarkingLook['shape'] | string {
  if (t.kind === 'decal') {
    const d = net.decals.find((x) => x.id === t.id);
    if (!d) return 'That mark is gone.';
    return d.kind === 'fill' || d.kind === 'hatch' ? 'fill' : isArrowDecal(d) || d.kind === 'text' ? 'stamp' : 'line';
  }
  if (t.kind !== 'marking') return 'Hover a marking to paste a marking style.';
  const hit = t.hit;
  if (hit.kind === 'user') {
    const m = net.markingsOf(hit.host).find((x) => x.id === hit.id);
    if (!m) return 'That marking is gone.';
    return m.kind === 'filler' ? 'fill' : 'line';
  }
  if (hit.kind === 'autoLine') return 'line';
  if (!canConvert(hit.item)) return 'This automatic marking cannot take a style.';
  return hit.item.ref.kind === 'arrow' ? 'stamp' : 'line';
}

/** Paste a marking style onto the marking under the cursor (its slot), as one undo step. */
export function pasteMarking(ctx: ToolContext, clip: MarkingClip, t: ClipTarget): PasteResult {
  const { net } = ctx;
  const look = clip.look;
  // Checked first, so a style that does not fit changes nothing.
  const shape = slotShape(net, t);
  if (shape !== 'line' && shape !== 'fill' && shape !== 'stamp') return { ok: false, message: shape };
  if (shape !== look.shape) return { ok: false, message: `The copied style is ${MISMATCH[look.shape]}; this is ${MISMATCH[shape]}.` };
  if (look.shape === 'stamp' && look.stamp === 'text' && !(look.text ?? '').trim()) return { ok: false, message: 'The copied text is empty.' };
  ctx.history.hint('Paste marking style');
  net.batch(() => {
    if (t.kind === 'decal') {
      restyleDecal(net, t.id, look);
      return;
    }
    if (t.kind !== 'marking') return;
    const hit = t.hit;
    if (hit.kind === 'user') {
      restyleMarking(net, hit.host, hit.id, look);
      return;
    }
    if (hit.kind === 'autoLine') {
      // An automatic line becomes a painted one in its place, with the copied look.
      const line = autoLinesOf(net, hit.segmentId).find((l) => l.key === hit.key);
      if (!line || look.shape !== 'line') return;
      removeAutoLine(net, hit.segmentId, hit.key);
      net.addDecal({
        kind: 'line',
        points: [],
        road: { pieces: [{ segmentId: hit.segmentId, t0: 0, t1: 1 }], offset: line.offset },
        style: { ...look.spec },
        color: look.spec.color,
        width: look.spec.width,
        rotation: 0,
      });
      return;
    }
    // An automatic marking at a junction: turned into an editable one, then restyled.
    const made = convertAutoItem(net, hit.nodeId, hit.item);
    if (made?.decal !== undefined) restyleDecal(net, made.decal, look);
    else if (made?.marking !== undefined) restyleMarking(net, { kind: 'node', id: hit.nodeId }, made.marking, look);
  });
  return { ok: true, message: `Pasted ${clip.name}`, target: t };
}

/** The rotation of the copy's arms onto the target's that keeps the most turns alike (as signal paste does). */
function bestRotation(clip: JunctionClip, arms: Id[], turnsAt: Map<string, TurnKind>): number {
  let best = 0;
  let bestScore = -1;
  for (let r = 0; r < arms.length; r++) {
    let score = 0;
    for (const [k, turn] of Object.entries(clip.turns)) {
      const [i, j] = k.split('>').map(Number);
      const t = turnsAt.get(`${arms[(i + r) % arms.length]}>${arms[(j + r) % arms.length]}`);
      if (t) score += t === turn ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Paste a junction's control and shape onto another junction, as one undo step. */
export function pasteJunction(ctx: ToolContext, clip: JunctionClip, nodeId: Id): PasteResult {
  const { net } = ctx;
  const node = net.getNode(nodeId);
  if (!node || !isJunction(net, nodeId)) return { ok: false, message: 'Hover a junction to paste a junction.' };
  const arms = roadArms(net, nodeId);
  const sameArms = arms.length === clip.arms;
  const moves = movementsAt(net, nodeId);
  const turnsAt = new Map(moves.map((m) => [m.key, m.turn]));
  const r = sameArms ? bestRotation(clip, arms, turnsAt) : 0;
  const armOf = (i: number): Id | undefined => (sameArms ? arms[(i + r) % arms.length] : undefined);
  const notes: string[] = [];
  ctx.history.hint('Paste junction');
  net.batch(() => {
    const signs: Record<number, (typeof clip.signs)[string]> = {};
    for (const [i, sign] of Object.entries(clip.signs)) {
      const seg = armOf(Number(i));
      if (seg !== undefined) signs[seg] = sign;
    }
    let signal: SignalPlan | null = null;
    if (clip.signal && sameArms) {
      // The existing signal paste fits the plan, adding any movement the copy lacks.
      const planClip: PlanClip = { plan: clip.signal, arms: clip.arms, moves: {}, source: -1 };
      for (const [k, turn] of Object.entries(clip.turns)) {
        const [from, to] = k.split('>').map(Number);
        planClip.moves[k] = { from, to, turn };
      }
      const fit = fitSignalPlan(net, planClip, nodeId);
      if (fit.ok) signal = fit.plan;
      else notes.push(fit.reason);
    }
    let rules: JunctionRules | undefined;
    if (clip.rules && sameArms) {
      rules = {};
      if (clip.rules.arms) {
        rules.arms = {};
        for (const [i, ar] of Object.entries(clip.rules.arms)) {
          const seg = armOf(Number(i));
          if (seg !== undefined) rules.arms[seg] = { ...ar };
        }
      }
      if (clip.rules.laneArrows) {
        const laneCount = (seg: Id) => net.roadTypeOf(seg).lanes.length;
        rules.laneArrows = {};
        for (const [k, turns] of Object.entries(clip.rules.laneArrows)) {
          const [i, lane] = k.split(':').map(Number);
          const seg = armOf(i);
          if (seg !== undefined && lane < laneCount(seg)) rules.laneArrows[`${seg}:${lane}`] = [...turns];
        }
      }
    }
    net.setJunctionControl(nodeId, { mode: clip.mode, signs, signal, rules });
    let shape: JunctionShape | null = null;
    if (clip.shape) {
      shape = {};
      if (clip.shape.scale !== undefined) shape.scale = clip.shape.scale;
      if (sameArms) {
        if (clip.shape.corners) {
          shape.corners = {};
          for (const [k, v] of Object.entries(clip.shape.corners)) {
            const [i, j] = k.split('>').map(Number);
            const a = armOf(i);
            const b = armOf(j);
            if (a !== undefined && b !== undefined) shape.corners[`${a}>${b}`] = { ...v };
          }
        }
        if (clip.shape.arms) {
          shape.arms = {};
          for (const [i, v] of Object.entries(clip.shape.arms)) {
            const seg = armOf(Number(i));
            if (seg !== undefined) shape.arms[seg] = { ...v };
          }
        }
        if (clip.shape.islands) {
          shape.islands = clip.shape.islands.flatMap((isl, n) => {
            const seg = armOf(isl.arm);
            return seg === undefined ? [] : [{ id: n + 1, segmentId: seg, from: isl.from, to: isl.to, back: isl.back, reach: isl.reach }];
          });
        }
      }
    }
    const attempt = applyJunctionShape(net, nodeId, shape);
    if (!attempt.ok) notes.push(`Shape left as it was: ${attempt.problems[0]?.message ?? 'it does not fit here'}`);
  });
  if (!sameArms) notes.unshift(`This junction has ${arms.length} arms and the copy ${clip.arms}, so only the control type was pasted`);
  return { ok: true, message: `Pasted ${clip.name}`, target: { kind: 'junction', nodeId }, ...(notes.length ? { warning: notes.join('. ') } : {}) };
}

/** Paste a clip onto the matching thing under the cursor. */
export function pasteAt(ctx: ToolContext, clip: Clip, e: At): PasteResult {
  if (clip.kind === 'road') {
    const t = targetAt(ctx, e, 'road');
    if (!t || t.kind !== 'road') return { ok: false, message: 'Hover a road to paste its style.' };
    return pasteRoad(ctx, clip, t.segmentId);
  }
  if (clip.kind === 'junction') {
    const t = targetAt(ctx, e, 'junction');
    if (!t || t.kind !== 'junction') return { ok: false, message: 'Hover a junction to paste its control and shape.' };
    return pasteJunction(ctx, clip, t.nodeId);
  }
  const t = targetAt(ctx, e, 'marking');
  if (!t) return { ok: false, message: 'Hover a marking to paste the style onto it.' };
  return pasteMarking(ctx, clip, t);
}

// ---------------------------------------------------------------------------
// Readying the tools
// ---------------------------------------------------------------------------

/**
 * Make a marking style the one the Markings tool draws next, leaving any
 * selection alone (MarkingTool.applyLook would restyle it). The small interface
 * the clipboard keeps to the Markings tool: settings plus setDraw.
 */
export function setCurrentStyle(tools: ToolManager, look: MarkingLook): MarkingDraw {
  const s = tools.settings;
  const nm = s.nodeMarking;
  let draw: MarkingDraw;
  if (look.shape === 'line') {
    const fam = lineStyleInfo(look.spec.style).family;
    if (fam === 'crosswalk') {
      nm.crosswalk = { ...look.spec };
      draw = 'crosswalk';
    } else if (fam === 'stop' || fam === 'teeth') {
      nm.stop = { ...look.spec };
      draw = 'stop';
    } else {
      const { style, color, width, ...extra } = look.spec;
      nm.style = style;
      nm.color = color;
      nm.width = width;
      nm.lineExtra = extra;
      draw = 'line';
    }
    s.paint.standard = matchStandard(look.spec)?.id;
  } else if (look.shape === 'fill') {
    const { fill, color, width, ...extra } = look.fill;
    nm.fill = fill;
    nm.color = color;
    nm.fillWidth = width;
    nm.fillExtra = extra;
    draw = 'filler';
  } else {
    s.paint.kind = look.stamp;
    s.paint.color = look.color;
    s.paint.width = look.width;
    if (look.stamp === 'text' && look.text) s.paint.text = look.text;
    draw = 'stamp';
  }
  tools.markings.setDraw(draw);
  if (look.shape === 'stamp') {
    // setDraw keeps a stamp kind it already had; the copied one wins.
    s.paint.kind = look.stamp;
    tools.paint.settingsChanged();
  }
  return draw;
}

/** What useClip switched to, for the app to open the right tray. */
export type ClipUse = { tool: 'road'; category: string; upgrade: boolean } | { tool: 'paint' } | { tool: null };

/**
 * Ready the tools for a copy: a road's type and settings for the Build tool (or,
 * already upgrading, for Upgrade's Paste style), a marking's style for the Markings
 * tool. A junction is pasted with Cmd+V, so it leaves the tools as they are.
 */
export function useClip(tools: ToolManager, clip: Clip): ClipUse {
  const s = tools.settings;
  if (clip.kind === 'road') {
    const net = tools.ctx.net;
    if (!net.roadType(clip.roadType) && clip.typeDef) {
      tools.ctx.history.hint('Add road type');
      ensureRoadType(net, clip);
    }
    const def = net.roadType(clip.roadType);
    if (!def) return { tool: null };
    s.roadStyle = clip;
    s.roadType = clip.roadType;
    const upgrading = tools.active.id === 'road' && s.drawMode === 'upgrade';
    if (upgrading) {
      s.upgradeCards.card = null;
      s.walls.upgrade = 'style';
    } else {
      s.upgradeCards.card = null;
      if (s.walls.upgrade === 'style') s.walls.upgrade = 'road';
    }
    tools.setTool('road');
    tools.settingsChanged();
    return { tool: 'road', category: def.category, upgrade: upgrading };
  }
  if (clip.kind === 'marking') {
    tools.setTool('paint');
    setCurrentStyle(tools, clip.look);
    tools.settingsChanged();
    return { tool: 'paint' };
  }
  return { tool: null };
}

/** The overrides a new road gets from a copied style, when it is being drawn in the copied type. */
export function drawStyleFor(roadStyle: RoadClip | null | undefined, roadType: string): RoadStyle | null {
  if (!roadStyle || roadStyle.roadType !== roadType) return null;
  return structuredClone(roadStyle.style);
}
