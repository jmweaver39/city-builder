/**
 * Editing the lanes of a road that is already placed.
 *
 * The inspector shows the road's cross section as a lane strip (laneStrip.ts).
 * Applying an edited strip gives the road a road type with that layout, reusing
 * any type with exactly the same layout, built-in or custom, and otherwise adding
 * a custom type made by makeCustomRoadType. One batch, so one undo step.
 *
 * Lanes keep their identity through the edit (strip uids), so whatever hangs off a
 * lane follows it to its new place: lane speeds, lane line styles, hand-set lane
 * connections, junction and segment markings anchored on lane boundaries, hidden
 * turn arrows, raised islands, road paint and zone edges. Anything whose lane was
 * removed, or that can no longer sit where it did, is dropped and named in the
 * report. Pure: runs headless under Vitest.
 */
import { islandIndexOf } from '../core/junctionShape';
import { boundaryOffsets } from '../core/nodeMarkings';
import { attachAt, pickHost } from '../core/ramps';
import type { RoadNetwork } from '../core/RoadNetwork';
import { BUILTIN_ROAD_TYPES, effectiveLanes, effectiveSpeedKmh, isOneWay, makeCustomRoadType, sidewalkOn } from '../core/roadTypes';
import type {
  AutoMarkingRef,
  Id,
  JunctionShape,
  LaneDef,
  LaneLink,
  MarkingAnchor,
  MarkingPointSetting,
  MarkingStyle,
  NodeMarking,
  RoadTypeDef,
  SegmentOverrides,
} from '../core/types';
import { stripFromDef, stripIssues, stripToParams, type LaneItem, type StripItem } from './laneStrip';
import { connectedRoadOriented } from './roadOps';

/** Ids of road types the lane editor adds. Unused ones are tidied away on the next edit. */
export const EDITED_TYPE_PREFIX = 'custom-lanes-';

const isLane = (i: StripItem): i is LaneItem => i.type === 'lane';

/** A placed road's cross section, ready for the lane strip. */
export interface LaneEditSource {
  segmentId: Id;
  items: StripItem[];
  /** Strip uid of each of the road's lanes, by lane index. */
  laneUids: number[];
  /** The road's own limit, for a lane given a limit of its own. */
  roadSpeedKmh: number;
  /** The lanes as they were read, to notice the road changing underneath. */
  signature: string;
}

function laneSignature(lanes: readonly LaneDef[]): string {
  return lanes.map((l) => `${l.kind}${l.dir}@${l.offset.toFixed(3)}/${l.width.toFixed(3)}`).join('|');
}

/** The road's cross section as a strip, lane kinds and lane limits included. Null for track. */
export function stripForSegment(net: RoadNetwork, id: Id): LaneEditSource | null {
  const seg = net.getSegment(id);
  if (!seg) return null;
  const def = net.roadTypeOf(id);
  if (def.category === 'rail') return null;
  const o = seg.overrides;
  const eff = effectiveLanes(def, o);
  // A lane has a limit of its own when set on this road, or on its type unless this road's limit beats it.
  const lanes = eff.map((l, i): LaneDef => {
    const { speedKmh: _drop, ...rest } = l;
    const own = o.laneSpeeds?.[i] ?? (o.speedKmh === undefined ? def.lanes[i]?.speedKmh : undefined);
    return own === undefined ? rest : { ...rest, speedKmh: own };
  });
  const items = stripFromDef({ ...def, lanes });
  return {
    segmentId: id,
    items,
    laneUids: items.filter(isLane).map((l) => l.uid),
    roadSpeedKmh: effectiveSpeedKmh(def, o),
    signature: laneSignature(eff),
  };
}

/** Compare two strips by what they build, ignoring uids. */
export function stripKey(items: readonly StripItem[]): string {
  return items
    .map((i) => (i.type === 'lane' ? `L${i.kind}${i.dir}w${i.width}s${i.speedKmh ?? ''}` : i.type === 'median' ? `M${i.kind}w${i.width}` : `${i.type}w${i.width}`))
    .join(',');
}

/** The strip seen from the other end: order reversed, every lane turned round. */
export function mirrorStrip(items: readonly StripItem[]): StripItem[] {
  return [...items].reverse().map((i) => (i.type === 'lane' ? { ...i, dir: (i.dir === 1 ? -1 : 1) as 1 | -1 } : i));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Everything about a type that a road built from it would show, for reuse. */
function layoutKey(def: RoadTypeDef): string {
  return JSON.stringify([
    def.category,
    def.speedKmh,
    r2(def.halfWidth),
    r2(sidewalkOn(def, -1)),
    r2(sidewalkOn(def, 1)),
    def.median.kind,
    r2(def.median.width),
    r2(def.median.offset ?? 0),
    def.lanes.map((l) => [l.kind, l.dir, r2(l.width), r2(l.offset), l.speedKmh ?? null]),
  ]);
}

function rootName(name: string): string {
  return name.replace(/ \(edited(?: \d+)?\)$/, '');
}

/** A road type with the strip's layout, keeping what it can of the road's own type. */
export function typeFromStrip(base: RoadTypeDef, items: readonly StripItem[], id = 'lanes-preview'): RoadTypeDef {
  const params = stripToParams(items);
  // Lane limits are kept on the road (overrides.laneSpeeds), so types stay shareable.
  const lanes = (params.lanes ?? []).map(({ speedKmh: _s, ...l }) => l);
  const oneWay = lanes.every((l) => l.dir === 1);
  const { boundaries: _b, ...paint } = base.markings;
  const samePaint = oneWay === isOneWay(base) && params.medianKind === base.median.kind;
  return makeCustomRoadType({
    ...params,
    lanes,
    id,
    name: `${rootName(base.name)} (edited)`,
    speedKmh: base.speedKmh,
    category: base.category === 'rail' ? 'custom' : base.category,
    rank: base.rank,
    ...(samePaint ? { markings: paint as Partial<MarkingStyle> } : {}),
  });
}

/** An existing type with this layout, or a new custom one, added to the network. */
function findOrAddType(net: RoadNetwork, def: RoadTypeDef, created: string[]): string {
  const key = layoutKey(def);
  for (const t of [...BUILTIN_ROAD_TYPES, ...net.project.customRoadTypes]) {
    if (t.category !== 'rail' && layoutKey(t) === key) return t.id;
  }
  let n = 1;
  while (net.roadType(`${EDITED_TYPE_PREFIX}${n}`)) n++;
  const id = `${EDITED_TYPE_PREFIX}${n}`;
  const names = new Set(net.project.customRoadTypes.map((t) => t.name));
  let name = def.name;
  for (let k = 2; names.has(name); k++) name = `${rootName(def.name)} (edited ${k})`;
  net.setCustomRoadType({ ...def, id, name });
  created.push(id);
  return id;
}

export interface LaneEditOptions {
  /** Apply along the connected road, not just this piece. */
  whole?: boolean;
  /** Road types not to tidy away even when unused, such as the one picked in the road panel. */
  keepType?: (id: string) => boolean;
}

export interface LaneEditReport {
  ok: boolean;
  error?: string;
  /** The type the selected piece now has. */
  typeId?: string;
  /** Types added for this edit. */
  createdTypes: string[];
  /** Pieces changed. */
  segments: Id[];
  /** Pieces of the whole road left alone because their lanes do not line up with this one. */
  skipped: Id[];
  /** What could not be kept, as "2 lane connections", one entry per kind. */
  lost: string[];
}

// ---------------------------------------------------------------------------
// Per piece mapping
// ---------------------------------------------------------------------------

interface Piece {
  id: Id;
  flipped: boolean;
  oldDef: RoadTypeDef;
  oldOverrides: SegmentOverrides;
  oldLanes: LaneDef[];
  oldBounds: number[];
  /** Old lane index to new lane index, for lanes that survive. */
  laneMap: Map<number, number>;
  /** Old lane indices whose lane still runs the same way. */
  sameWay: Set<number>;
  items: StripItem[];
  newDef: RoadTypeDef;
  newLanes: LaneDef[];
  newBounds: number[];
  newSpeeds: Record<number, number>;
}

const EDGE_EPS = 0.06;

/** Map an a-to-b boundary index of the old layout onto the new one, or null. */
function mapBoundary(p: Piece, b: number): number | null {
  const last = p.oldBounds.length - 1;
  if (b === 0) return 0;
  if (b === last) return p.newBounds.length - 1;
  const x = p.oldBounds[b];
  if (x === undefined) return null;
  const find = (target: number) => {
    const k = p.newBounds.findIndex((v) => Math.abs(v - target) < EDGE_EPS);
    return k >= 0 ? k : null;
  };
  // A lane edge follows its lane. Try every lane that has an edge here, surviving ones first.
  for (let i = 0; i < p.oldLanes.length; i++) {
    const l = p.oldLanes[i];
    const j = p.laneMap.get(i);
    if (j === undefined) continue;
    const n = p.newLanes[j];
    if (Math.abs(l.offset - l.width / 2 - x) < EDGE_EPS) {
      const k = find(n.offset - n.width / 2);
      if (k !== null) return k;
    }
    if (Math.abs(l.offset + l.width / 2 - x) < EDGE_EPS) {
      const k = find(n.offset + n.width / 2);
      if (k !== null) return k;
    }
  }
  return null;
}

/** Where a point `x` metres right of a-to-b goes, or null when it has nowhere to go. */
function mapLateral(p: Piece, x: number): number | null {
  for (let i = 0; i < p.oldLanes.length; i++) {
    const l = p.oldLanes[i];
    if (Math.abs(x - l.offset) > l.width / 2 + 0.05) continue;
    const j = p.laneMap.get(i);
    if (j === undefined) return null;
    const n = p.newLanes[j];
    return n.offset + (x - l.offset) * (n.width / l.width);
  }
  const oldHalf = p.oldDef.halfWidth;
  const newHalf = p.newDef.halfWidth;
  if (Math.abs(x) > oldHalf) {
    // Beyond the kerb: stay the same distance outside it.
    const side = x > 0 ? 1 : -1;
    return x + side * (newHalf - oldHalf);
  }
  // On a median or shoulder: stays put if the road is still there.
  return Math.abs(x) <= newHalf ? x : null;
}

/** Zone edges sit outside the road: keep them the same distance from its outer edge. */
function mapZoneOffset(p: Piece, x: number): number {
  const side: 1 | -1 = x >= 0 ? 1 : -1;
  const oldEdge = p.oldDef.halfWidth + sidewalkOn(p.oldDef, side);
  const newEdge = p.newDef.halfWidth + sidewalkOn(p.newDef, side);
  if (Math.abs(x) < oldEdge - 0.01) return mapLateral(p, x) ?? x;
  return x + side * (newEdge - oldEdge);
}

class Losses {
  private readonly counts = new Map<string, number>();
  add(kind: string, n = 1): void {
    if (n > 0) this.counts.set(kind, (this.counts.get(kind) ?? 0) + n);
  }
  list(): string[] {
    return [...this.counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  }
}

function parseRef(ref: string): { seg: Id; lane: number } | null {
  const m = /^(\d+):(\d+)$/.exec(ref);
  return m ? { seg: Number(m[1]), lane: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Give the road the strip's layout. `src` is what stripForSegment returned when
 * editing began; the strip's lanes are matched to the road's by uid.
 */
export function applyLaneStrip(net: RoadNetwork, src: LaneEditSource, items: readonly StripItem[], opts: LaneEditOptions = {}): LaneEditReport {
  const fail = (error: string): LaneEditReport => ({ ok: false, error, createdTypes: [], segments: [], skipped: [], lost: [] });
  const seg = net.getSegment(src.segmentId);
  if (!seg) return fail('That road is gone.');
  const base = net.roadTypeOf(seg.id);
  if (base.category === 'rail') return fail('Track has no lanes to edit.');
  const selectedOld = effectiveLanes(base, seg.overrides);
  if (laneSignature(selectedOld) !== src.signature) return fail('The road changed while you were editing. Start again from its lanes as they are now.');
  const problems = stripIssues(items);
  if (problems.length) return fail(problems.join('. '));
  const lanesNew = items.filter(isLane);
  if (!lanesNew.some((l) => l.dir === 1)) {
    return fail('Every lane would run against the way this road was drawn. Keep one lane forward, or reverse the road first.');
  }

  let mainDef: RoadTypeDef;
  try {
    mainDef = typeFromStrip(base, items);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'That layout does not make a road.');
  }
  const mirrored = mirrorStrip(items);
  const mirrorUsable = mirrored.some((i) => isLane(i) && i.dir === 1);
  let mirrorDef: RoadTypeDef | null = null;
  if (mirrorUsable) {
    try {
      mirrorDef = typeFromStrip(base, mirrored);
    } catch {
      mirrorDef = null;
    }
  }

  const found = opts.whole ? connectedRoadOriented(net, seg.id) : [{ id: seg.id, flipped: false }];
  const pieces: Piece[] = [];
  const skipped: Id[] = [];
  for (const { id, flipped } of found) {
    const s = net.getSegment(id);
    if (!s) continue;
    const oldDef = net.roadTypeOf(id);
    const oldLanes = effectiveLanes(oldDef, s.overrides);
    const pieceItems = flipped ? mirrored : [...items];
    const newDef = flipped ? mirrorDef : mainDef;
    if (!newDef || oldLanes.length !== selectedOld.length) {
      skipped.push(id);
      continue;
    }
    const newLaneItems = pieceItems.filter(isLane);
    const laneMap = new Map<number, number>();
    const sameWay = new Set<number>();
    let lines = true;
    oldLanes.forEach((l, i) => {
      // The selected piece's lane in the same place on the ground.
      const q = flipped ? selectedOld.findIndex((m) => m.dir === -l.dir && Math.abs(m.offset + l.offset) < 0.01) : i;
      if (q < 0) {
        lines = false;
        return;
      }
      const j = newLaneItems.findIndex((it) => it.uid === src.laneUids[q]);
      if (j < 0) return;
      laneMap.set(i, j);
      if (newLaneItems[j].dir === l.dir) sameWay.add(i);
    });
    if (!lines) {
      skipped.push(id);
      continue;
    }
    const newSpeeds: Record<number, number> = {};
    newLaneItems.forEach((it, j) => {
      if (it.speedKmh !== undefined) newSpeeds[j] = it.speedKmh;
    });
    pieces.push({
      id,
      flipped,
      oldDef,
      oldOverrides: structuredClone(s.overrides),
      oldLanes,
      oldBounds: boundaryOffsets(oldDef, s.overrides),
      laneMap,
      sameWay,
      items: pieceItems,
      newDef,
      newLanes: newDef.lanes,
      newBounds: boundaryOffsets(newDef),
      newSpeeds,
    });
  }
  if (!pieces.some((p) => p.id === seg.id)) return fail('This road could not take that layout.');

  const lost = new Losses();
  const created: string[] = [];
  const byId = new Map(pieces.map((p) => [p.id, p]));
  let typeId = '';

  net.batch(() => {
    const typeFor = new Map<RoadTypeDef, string>();
    const idOf = (def: RoadTypeDef) => {
      let id = typeFor.get(def);
      if (!id) {
        id = findOrAddType(net, def, created);
        typeFor.set(def, id);
      }
      return id;
    };

    // The roads themselves.
    for (const p of pieces) {
      const t = idOf(p.newDef);
      if (p.id === seg.id) typeId = t;
      net.setRoadType(p.id, t);
      const o = p.oldOverrides;
      const patch: SegmentOverrides = {
        laneKinds: undefined,
        laneSpeeds: Object.keys(p.newSpeeds).length ? p.newSpeeds : undefined,
      };
      const styles = o.markings?.boundaries;
      if (styles) {
        const next: NonNullable<MarkingStyle['boundaries']> = {};
        for (const [k, v] of Object.entries(styles)) {
          const i = Number(k);
          const j = p.laneMap.get(i);
          const j2 = p.laneMap.get(i + 1);
          if (j !== undefined && j2 === j + 1) next[j] = v;
          else lost.add('lane line style');
        }
        patch.markings = { ...o.markings, boundaries: Object.keys(next).length ? next : undefined };
        if (!patch.markings.boundaries) delete patch.markings.boundaries;
      }
      net.setSegmentOverrides(p.id, patch);
      p.newBounds = boundaryOffsets(net.roadTypeOf(p.id), net.getSegment(p.id)!.overrides);

      // Markings placed along the road.
      const host = { kind: 'segment' as const, id: p.id };
      const marks = net.markingsOf(host);
      const points = net.pointsOf(host);
      if (marks.length || points.length) {
        const keptMarks = remapMarkings(marks, byId, lost);
        const keptPoints = remapPoints(points, byId);
        net.setMarkings(host, keptMarks, keptPoints);
      }
    }

    // Junctions at either end.
    const nodes = new Set<Id>();
    for (const p of pieces) {
      const s = net.getSegment(p.id)!;
      nodes.add(s.a);
      nodes.add(s.b);
    }
    for (const nodeId of nodes) remapNode(net, nodeId, byId, lost);

    // Ramps attached to an edited road keep within its lanes.
    for (const nodeId of nodes) {
      const node = net.getNode(nodeId);
      if (!node) continue;
      for (const other of node.segments) {
        const os = net.getSegment(other);
        if (!os || byId.has(other)) continue;
        const attach = attachAt(os, nodeId);
        if (!attach) continue;
        const host = pickHost(net.attachAccess, nodeId, other);
        if (!host || !byId.has(host.id)) continue;
        const def = net.roadTypeOf(host.id);
        const drive = def.lanes.filter((l) => l.kind === 'drive' || l.kind === 'bus');
        const perSide = isOneWay(def) ? drive.length : Math.max(drive.filter((l) => l.dir === 1).length, drive.filter((l) => l.dir === -1).length);
        if (perSide > 0 && attach.lane > perSide - 1) {
          const key = os.a === nodeId ? 'attachA' : 'attachB';
          net.setSegmentOverrides(other, { [key]: { ...attach, lane: perSide - 1 } });
          lost.add('ramp lane choice');
        }
      }
    }

    // Paint that follows the road.
    for (const d of net.decals) {
      const ref = d.road;
      if (!ref || !ref.pieces.some((pc) => byId.has(pc.segmentId))) continue;
      const mapField = (value: number | undefined): number | undefined | null => {
        if (value === undefined) return undefined;
        let result: number | null | undefined;
        for (const pc of ref.pieces) {
          const p = byId.get(pc.segmentId);
          const sign = pc.t1 >= pc.t0 ? 1 : -1;
          let next: number | null;
          if (p) {
            const m = mapLateral(p, value * sign);
            next = m === null ? null : m * sign;
          } else next = value;
          if (next === null) return null;
          if (result === undefined) result = next;
          else if (Math.abs((result ?? 0) - next) > 0.02) {
            // Pieces disagree. Keep the paint where it was if the road is still under it.
            const ok = ref.pieces.every((q) => {
              const pp = byId.get(q.segmentId);
              return !pp || Math.abs(value) <= pp.newDef.halfWidth;
            });
            return ok ? value : null;
          }
        }
        return result ?? value;
      };
      const offset = mapField(ref.offset);
      const offset2 = mapField(ref.offset2);
      const offsetEnd = mapField(ref.offsetEnd);
      if (offset === null || offset2 === null || offsetEnd === null) {
        net.removeDecal(d.id);
        lost.add('painted mark');
        continue;
      }
      const next = { ...ref, offset: offset ?? ref.offset };
      if (offset2 !== undefined) next.offset2 = offset2;
      if (offsetEnd !== undefined) next.offsetEnd = offsetEnd;
      if (next.offset !== ref.offset || next.offset2 !== ref.offset2 || next.offsetEnd !== ref.offsetEnd) net.updateDecal(d.id, { road: next });
    }

    // Zones fronting the road keep their distance from its edge.
    for (const z of net.project.zones ?? []) {
      if (!z.anchors?.some((a) => a && byId.has(a.segmentId))) continue;
      const anchors = z.anchors.map((a) => {
        const p = a ? byId.get(a.segmentId) : undefined;
        return a && p ? { ...a, offset: mapZoneOffset(p, a.offset) } : a;
      });
      net.updateZone(z.id, { anchors });
    }

    // Tidy away edited types nothing uses any more.
    const used = new Set(net.segments.map((s) => s.roadType));
    for (const t of [...net.project.customRoadTypes]) {
      if (!t.id.startsWith(EDITED_TYPE_PREFIX) || used.has(t.id) || opts.keepType?.(t.id)) continue;
      net.removeCustomRoadType(t.id);
    }
  });

  return { ok: true, typeId, createdTypes: created.filter((id) => !!net.roadType(id)), segments: pieces.map((p) => p.id), skipped, lost: lost.list() };
}

function remapAnchor(a: MarkingAnchor, byId: ReadonlyMap<Id, Piece>): MarkingAnchor | null {
  const p = byId.get(a.segmentId);
  if (!p || a.corner !== undefined) return a;
  const b = mapBoundary(p, a.boundary);
  return b === null ? null : { ...a, boundary: b };
}

function remapMarkings(list: readonly NodeMarking[], byId: ReadonlyMap<Id, Piece>, lost: Losses): NodeMarking[] {
  const out: NodeMarking[] = [];
  for (const m of list) {
    if (m.kind === 'line') {
      const from = remapAnchor(m.from, byId);
      const to = remapAnchor(m.to, byId);
      if (from && to) out.push({ ...m, from, to });
      else lost.add('marking');
    } else {
      const anchors = m.anchors.map((a) => remapAnchor(a, byId));
      if (anchors.every((a): a is MarkingAnchor => !!a)) out.push({ ...m, anchors });
      else lost.add('marking');
    }
  }
  return out;
}

function remapPoints(list: readonly MarkingPointSetting[], byId: ReadonlyMap<Id, Piece>): MarkingPointSetting[] {
  const out: MarkingPointSetting[] = [];
  for (const pt of list) {
    const p = byId.get(pt.segmentId);
    if (!p) {
      out.push(pt);
      continue;
    }
    const b = mapBoundary(p, pt.boundary);
    // A point setting only nudges a point: one with nowhere to go is let go quietly.
    if (b !== null && !out.some((o) => o.segmentId === pt.segmentId && o.boundary === b && o.end === pt.end)) out.push({ ...pt, boundary: b });
  }
  return out;
}

function remapNode(net: RoadNetwork, nodeId: Id, byId: ReadonlyMap<Id, Piece>, lost: Losses): void {
  const node = net.getNode(nodeId);
  if (!node) return;
  const c = node.control;

  const host = { kind: 'node' as const, id: nodeId };
  if (c.markings?.length || c.markingPoints?.length) {
    const marks = remapMarkings(c.markings ?? [], byId, lost);
    const points = remapPoints(c.markingPoints ?? [], byId);
    net.setMarkings(host, marks, points);
  }

  if (c.autoOff?.length) {
    const next: AutoMarkingRef[] = [];
    for (const ref of c.autoOff) {
      if (ref.kind !== 'arrow' || !byId.has(ref.segmentId)) {
        next.push(ref);
        continue;
      }
      const p = byId.get(ref.segmentId)!;
      const j = p.sameWay.has(ref.lane) ? p.laneMap.get(ref.lane) : undefined;
      if (j !== undefined) next.push({ ...ref, lane: j });
      else lost.add('hidden turn arrow');
    }
    net.setJunctionControl(nodeId, { autoOff: next.length ? next : undefined });
  }

  if (c.shape?.islands?.some((i) => byId.has(i.segmentId))) {
    const islands = [];
    for (const island of c.shape.islands) {
      const p = byId.get(island.segmentId);
      if (!p) {
        islands.push(island);
        continue;
      }
      const atStart = net.getSegment(p.id)!.a === nodeId;
      const oldCount = p.oldBounds.length;
      const newCount = p.newBounds.length;
      const ends = [island.from, island.to].map((k) => {
        const b = mapBoundary(p, islandIndexOf(k, oldCount, atStart));
        return b === null ? null : islandIndexOf(b, newCount, atStart);
      });
      if (ends[0] === null || ends[1] === null || ends[0] === ends[1]) {
        lost.add('island');
        continue;
      }
      islands.push({ ...island, from: Math.min(ends[0], ends[1]), to: Math.max(ends[0], ends[1]) });
    }
    const shape: JunctionShape = { ...c.shape, islands };
    net.setJunctionShape(nodeId, shape);
  }

  if (c.laneLinks) {
    const kept: LaneLink[] = [];
    const mapRef = (ref: string): string | null => {
      const r = parseRef(ref);
      if (!r) return null;
      const p = byId.get(r.seg);
      if (!p) return ref;
      const j = p.sameWay.has(r.lane) ? p.laneMap.get(r.lane) : undefined;
      return j === undefined ? null : `${r.seg}:${j}`;
    };
    let dropped = 0;
    for (const link of c.laneLinks) {
      const from = mapRef(link.from);
      const to = mapRef(link.to);
      if (from && to) kept.push({ from, to });
      else dropped++;
    }
    lost.add('lane connection', dropped);
    // Lanes the edit added have no hand-set links: give them the automatic ones.
    net.setJunctionControl(nodeId, { laneLinks: null });
    const auto = net.connectionsAt(nodeId).filter((x) => x.active);
    const hasOut = new Set(kept.map((l) => l.from));
    const hasIn = new Set(kept.map((l) => l.to));
    const edited = (ref: string) => byId.has(parseRef(ref)?.seg ?? -1);
    const extra = auto.filter((x) => (edited(x.from) && !hasOut.has(x.from)) || (edited(x.to) && !hasIn.has(x.to)));
    const all = [...kept];
    for (const x of extra) if (!all.some((l) => l.from === x.from && l.to === x.to)) all.push({ from: x.from, to: x.to });
    net.setJunctionControl(nodeId, { laneLinks: all });
  }
}
