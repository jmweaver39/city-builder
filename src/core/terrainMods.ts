/**
 * Terrain modifiers: the ground as roads and quays have reshaped it.
 *
 * terrainHeight() stays the untouched land. Embankments raise the ground under and
 * beside a road, cuts and trenches lower it, junctions on raised or sunk roads sit
 * on a flat pad, and quays hold the bank up at road level. All of it is derived
 * from the project (segments' structure settings and Project.quays), never saved,
 * and rebuilt whenever the network's version changes.
 *
 * groundHeight(net, x, z) is what anything standing on the ground should use:
 * frames under roads (so a road on an embankment is not a bridge), trees, zones.
 */
import type { RoadNetwork } from './RoadNetwork';
import { quayGround } from './quays';
import { terrainEditVersion, terrainHeight } from './terrain';
import type { Id } from './types';
import { isEarthwork, isRaisedEarth, profileHeight, segmentSections, SLOPE_RUN, structureOf, type Pt, type SectionSample, type SideSection } from './walls';
import type { Quay } from './wallTypes';

const CELL = 32;

/** A flat pad under a junction on raised or sunk road, sloping out to the land. */
export interface DiscMod {
  nodeId: Id;
  x: number;
  z: number;
  /** Pad height (road curve height at the node). */
  y: number;
  /** Flat radius, and where the slope meets the land. */
  r0: number;
  r1: number;
  raised: boolean;
}

interface PairRef {
  id: Id;
  i: number;
}

export interface ModHit {
  height: number;
  /** What changed the ground here. */
  source: 'segment' | 'node' | 'quay';
  id: Id;
}

export class TerrainMods {
  /** Sections of every segment with earthworks. */
  readonly segments = new Map<Id, SectionSample[]>();
  readonly discs: DiscMod[] = [];
  readonly quays: Quay[] = [];
  private cells = new Map<number, PairRef[]>();
  private discCells = new Map<number, number[]>();

  get empty(): boolean {
    return this.segments.size === 0 && this.discs.length === 0 && this.quays.length === 0;
  }

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  addSegment(id: Id, samples: SectionSample[]): void {
    if (samples.length < 2) return;
    if (!samples.some((s) => s.left || s.right)) return;
    this.segments.set(id, samples);
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const reach = Math.max(a.left?.extent ?? 0, a.right?.extent ?? 0, b.left?.extent ?? 0, b.right?.extent ?? 0, 2) + 1;
      if (!a.left && !a.right && !b.left && !b.right) continue;
      const i0 = Math.floor((Math.min(a.x, b.x) - reach) / CELL);
      const i1 = Math.floor((Math.max(a.x, b.x) + reach) / CELL);
      const j0 = Math.floor((Math.min(a.z, b.z) - reach) / CELL);
      const j1 = Math.floor((Math.max(a.z, b.z) + reach) / CELL);
      for (let ci = i0; ci <= i1; ci++) {
        for (let cj = j0; cj <= j1; cj++) {
          const k = this.key(ci, cj);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push({ id, i });
        }
      }
    }
  }

  addDisc(d: DiscMod): void {
    const idx = this.discs.length;
    this.discs.push(d);
    for (let ci = Math.floor((d.x - d.r1) / CELL); ci <= Math.floor((d.x + d.r1) / CELL); ci++) {
      for (let cj = Math.floor((d.z - d.r1) / CELL); cj <= Math.floor((d.z + d.r1) / CELL); cj++) {
        const k = this.key(ci, cj);
        let list = this.discCells.get(k);
        if (!list) this.discCells.set(k, (list = []));
        list.push(idx);
      }
    }
  }

  /**
   * Height of a segment's earthwork at (x, z), or null when outside it. With
   * `withRoad` false, points on the road itself count as outside.
   */
  private segmentHeight(ref: PairRef, x: number, z: number, withRoad = true): { h: number; raised: boolean; onRoad: boolean } | null {
    const samples = this.segments.get(ref.id)!;
    const a = samples[ref.i];
    const b = samples[ref.i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-9) return null;
    let f = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    // Only the pair that owns this point answers, so neighbours do not double up.
    const first = ref.i === 0;
    const last = ref.i + 2 === samples.length;
    if (f < (first ? -0.02 : 0) || f > (last ? 1.02 : 1)) return null;
    f = Math.min(1, Math.max(0, f));
    const cx = a.x + dx * f;
    const cz = a.z + dz * f;
    let rx = a.rx + (b.rx - a.rx) * f;
    let rz = a.rz + (b.rz - a.rz) * f;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    const lateral = (x - cx) * rx + (z - cz) * rz;
    const side = lateral < 0 ? -1 : 1;
    const sa = side < 0 ? a.left : a.right;
    const sb = side < 0 ? b.left : b.right;
    const o = Math.abs(lateral);
    const y = a.y + (b.y - a.y) * f;
    const sec = blendSections(sa, sb, f);
    if (!sec) return null;
    if (o <= sec.edge) return withRoad ? { h: y, raised: sec.kind === 'raised', onRoad: true } : null;
    const h = profileHeight(sec.profile, o);
    if (h === null) return null;
    return { h, raised: sec.kind === 'raised', onRoad: false };
  }

  private discHeight(d: DiscMod, x: number, z: number): number | null {
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist > d.r1) return null;
    if (dist <= d.r0) return d.y;
    const nat = terrainHeight(x, z);
    const t = (dist - d.r0) / Math.max(d.r1 - d.r0, 1e-6);
    const h = d.y + (nat - d.y) * t;
    return d.raised ? Math.max(h, nat) : Math.min(h, nat);
  }

  /** The reshaped ground at (x, z), or null where nothing changed it. */
  modAt(x: number, z: number): ModHit | null {
    if (this.empty) return null;
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
    let up: ModHit | null = null;
    let down: ModHit | null = null;
    const take = (h: number, raised: boolean, source: ModHit['source'], id: Id) => {
      if (raised) {
        if (!up || h > up.height) up = { height: h, source, id };
      } else if (!down || h < down.height) {
        down = { height: h, source, id };
      }
    };
    for (const ref of this.cells.get(k) ?? []) {
      const r = this.segmentHeight(ref, x, z);
      if (!r) continue;
      // Under a road the road's own height wins over pads and neighbours' slopes.
      if (r.onRoad) return { height: r.h, source: 'segment', id: ref.id };
      take(r.h, r.raised, 'segment', ref.id);
    }
    for (const i of this.discCells.get(k) ?? []) {
      const d = this.discs[i];
      const h = this.discHeight(d, x, z);
      if (h !== null) take(h, d.raised, 'node', d.nodeId);
    }
    for (const q of this.quays) {
      const h = quayGround(q, x, z);
      if (h !== null) take(h, true, 'quay', q.id);
    }
    return up ?? down;
  }

  groundAt(x: number, z: number): number {
    const m = this.modAt(x, z);
    return m ? m.height : terrainHeight(x, z);
  }

  /** True inside an earthwork's footprint, road included, widened by margin. */
  inFootprint(x: number, z: number, margin = 0): boolean {
    if (this.segments.size === 0 && this.discs.length === 0) return false;
    const probes = margin > 0 ? [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]] : [[0, 0]];
    for (const [ox, oz] of probes) {
      const px = x + ox;
      const pz = z + oz;
      const k = this.key(Math.floor(px / CELL), Math.floor(pz / CELL));
      for (const ref of this.cells.get(k) ?? []) {
        if (this.segmentHeight(ref, px, pz, true)) return true;
      }
      for (const i of this.discCells.get(k) ?? []) {
        if (this.discHeight(this.discs[i], px, pz) !== null) return true;
      }
    }
    return false;
  }
}

/** Mix two sections component-wise. A missing one means the road meets grade there. */
function blendSections(a: SideSection | null, b: SideSection | null, f: number): SideSection | null {
  if (!a && !b) return null;
  if (!a || !b) {
    const s = (a ?? b)!;
    const w = a ? 1 - f : f;
    // Shrink toward the road edge as the road comes back to grade.
    const flat = (p: Pt): Pt => ({ o: s.edge + (p.o - s.edge) * w, y: s.edgeY + (p.y - s.edgeY) * w });
    const profile = s.profile.map(flat) as SideSection['profile'];
    return { ...s, profile, extent: s.edge + (s.extent - s.edge) * w };
  }
  if (f <= 0) return a;
  if (f >= 1) return b;
  const mix = (p: number, q: number) => p + (q - p) * f;
  const profile = a.profile.map((p, i) => ({ o: mix(p.o, b.profile[i].o), y: mix(p.y, b.profile[i].y) })) as SideSection['profile'];
  return { ...a, edge: mix(a.edge, b.edge), edgeY: mix(a.edgeY, b.edgeY), profile, extent: mix(a.extent, b.extent) };
}

/** Pads under junctions where an arm is raised or sunk on earthworks, and under raised dead ends. */
function nodeDiscs(net: RoadNetwork, mods: TerrainMods): void {
  for (const node of net.nodes) {
    let raised: boolean | null = null;
    for (const id of node.segments) {
      const mode = structureOf(net.getSegment(id)?.overrides).mode;
      if (isEarthwork(mode)) raised = isRaisedEarth(mode);
    }
    if (raised === null) continue;
    const g = net.nodeGeom(node.id);
    // A raised dead end gets a pad and end slope; a sunk one ends at its walls.
    if (!g || !(g.kind === 'junction' || (g.kind === 'deadEnd' && raised))) continue;
    const nat = terrainHeight(node.pos.x, node.pos.z);
    const rise = node.pos.y - nat;
    if (raised ? rise < 0.3 : rise > -0.3) continue;
    let r0 = 0;
    const outline = g.outerOutline.length ? g.outerOutline : g.arms.flatMap((a) => [a.leftEdge, a.rightEdge]);
    for (const p of outline) r0 = Math.max(r0, Math.hypot(p.x - node.pos.x, p.z - node.pos.z));
    if (g.kind === 'deadEnd') {
      const def = net.roadTypeOf(g.arms[0].segmentId);
      r0 = Math.max(r0, def.halfWidth + def.sidewalk + 1);
    }
    r0 += 1;
    mods.addDisc({ nodeId: node.id, x: node.pos.x, z: node.pos.z, y: node.pos.y, r0, r1: r0 + Math.abs(rise) * SLOPE_RUN, raised });
  }
}

export function buildTerrainMods(net: RoadNetwork): TerrainMods {
  const mods = new TerrainMods();
  for (const seg of net.segments) {
    if (!isEarthwork(structureOf(seg.overrides).mode)) continue;
    mods.addSegment(seg.id, segmentSections(net, seg.id));
  }
  nodeDiscs(net, mods);
  for (const q of net.project.quays ?? []) mods.quays.push(q);
  return mods;
}

const cache = new WeakMap<RoadNetwork, { version: number; land: number; mods: TerrainMods }>();

/** The network's terrain modifiers, rebuilt when it changes. */
export function terrainModsFor(net: RoadNetwork): TerrainMods {
  const c = cache.get(net);
  // Landscaping changes the land the earthworks meet (core/terrainEdit.ts).
  if (c && c.version === net.version && c.land === terrainEditVersion()) return c.mods;
  const mods = buildTerrainMods(net);
  cache.set(net, { version: net.version, land: terrainEditVersion(), mods });
  return mods;
}

/** Ground height with roads' earthworks and quays applied. */
export function groundHeight(net: RoadNetwork, x: number, z: number): number {
  return terrainModsFor(net).groundAt(x, z);
}

/** A ground-height function bound to the network as it is now. */
export function groundFn(net: RoadNetwork): (x: number, z: number) => number {
  const mods = terrainModsFor(net);
  return mods.empty ? terrainHeight : (x, z) => mods.groundAt(x, z);
}
