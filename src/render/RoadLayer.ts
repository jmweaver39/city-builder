/**
 * Keeps road meshes in step with the network. Listens to net.onChange, collects
 * dirty ids, and rebuilds only those on the next frame. Pieces are merged per
 * chunk in batch.ts, so geometry for one road costs one small rebuild.
 */
import * as THREE from 'three';
import type { Id } from '../core/types';
import type { NetworkChange, RoadNetwork } from '../core/RoadNetwork';
import { ChunkBatch, HOLE_SCHEMA, HoleBuf, PAINT_SCHEMA, PaintBuf, SURF_SCHEMA, SurfBuf } from './batch';
import { BIAS_MARKING, MARK_LIFT } from './constants';
import { buildJunction } from './junctions';
import { buildJunctionGuides, buildSegmentPaint } from './markings';
import { buildRampJunctionPaint, isRampJunction } from './gore';
import { buildEdgeMergePaint, isEdgeMerge } from './edgeMerge';
import { makeHoleMaterial, makePaintMaterial, makeSurfaceMaterial, setSurfaceDetail, type Shared } from './materials';
import type { RoadDetailName } from './roadDetail';
import { buildLaneArrows, type SlotOwner } from './overlays';
import { buildSegment, type RoadOutputs } from './roads';
import { PaintBatches, markingMaterial } from './paint';
import { MIN_PIER_CLEARANCE, PORTAL_REACH } from './piers';
import { placedStationFootprint } from '../core/footprint';
import { terrainHeight } from '../core/terrain';
import type { Station } from '../core/types';

/** Plan bounds of a run of stations. */
function stationBox(st: readonly Station[]): [number, number, number, number] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const s of st) {
    minX = Math.min(minX, s.pos.x);
    minZ = Math.min(minZ, s.pos.z);
    maxX = Math.max(maxX, s.pos.x);
    maxZ = Math.max(maxZ, s.pos.z);
  }
  return [minX, minZ, maxX, maxZ];
}

interface Dirty {
  segments: Set<Id>;
  nodes: Set<Id>;
}

/** Keys into the shared batches. Segments and nodes draw from separate ranges. */
const NODE_KEY_BASE = 1 << 28;

export interface ChangeSummary {
  /** Plan-view boxes of what changed, for tree refresh. */
  boxes: [number, number, number, number][];
  decals: boolean;
  endpoints: boolean;
  structural: boolean;
  /** The whole network was replaced. */
  reset: boolean;
}

export class RoadLayer implements SlotOwner {
  readonly group = new THREE.Group();
  readonly surfaceMaterial: THREE.MeshStandardMaterial;
  private paintMaterial: THREE.Material;
  private arrowMaterial: THREE.Material;
  private holeMaterial: THREE.MeshBasicMaterial;
  private surf: ChunkBatch;
  private tube: ChunkBatch;
  private plug: ChunkBatch;
  private hole: ChunkBatch;
  /** Automatic paint, in the shared stacking layers (paint.ts). */
  private paint: PaintBatches;
  private arrows: ChunkBatch;
  /** What each decal covered last time, so a decal edit repaints the roads under it. */
  private decalSigs = new Map<Id, { sig: string; segs: Id[] }>();
  /** Small structure parts (bearings, railing posts), drawn only near the camera. */
  private detail: ChunkBatch;
  /** Metres from the camera within which `detail` is drawn; 0 hides it (quality.ts). */
  detailRange = 900;
  /** Station footprints last seen, so an edited station re-plans the piers over it. */
  private stationKeys = new Map<Id, { key: string; box: [number, number, number, number] | null }>();
  private railDirty = true;

  private dirty: Dirty = { segments: new Set(), nodes: new Set() };
  private pendingAll = true;
  private pendingDecals = true;
  private pendingEndpoints = true;
  private pendingBoxes: [number, number, number, number][] = [];
  private segBounds = new Map<Id, [number, number, number, number]>();
  private segSlot = new Map<Id, number>();
  private nodeSlot = new Map<Id, number>();
  private freeSlots: number[] = [];
  private nextSlot = 1;
  private unsubscribe: () => void;
  private lanesOn = false;
  private structuralChange = true;

  /** Called on the first frame after slots change, so overlays can repaint. */
  onSlotsChanged: () => void = () => {};

  constructor(
    private readonly net: RoadNetwork,
    shared: Shared,
  ) {
    this.surfaceMaterial = makeSurfaceMaterial(shared);
    this.paintMaterial = markingMaterial(shared);
    this.arrowMaterial = makePaintMaterial(shared, { bias: BIAS_MARKING * 1.2, lift: MARK_LIFT + 0.01, fade: false });
    this.holeMaterial = makeHoleMaterial();
    const shadow = { castShadow: true, receiveShadow: true };
    this.surf = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, shadow);
    this.tube = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, { receiveShadow: false });
    this.plug = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, {});
    this.hole = new ChunkBatch(HOLE_SCHEMA, this.holeMaterial, { renderOrder: -10 });
    this.paint = new PaintBatches(this.paintMaterial);
    this.arrows = new ChunkBatch(PAINT_SCHEMA, this.arrowMaterial, { renderOrder: 6 });
    this.tube.group.visible = false;
    this.arrows.group.visible = false;
    this.detail = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, { castShadow: true, receiveShadow: true });
    for (const b of [this.hole, this.surf, this.tube, this.plug, this.paint, this.arrows, this.detail]) this.group.add(b.group);
    this.unsubscribe = net.onChange((e) => this.onNetworkChange(e));
  }

  private slotFrom(map: Map<Id, number>, id: Id): number {
    let slot = map.get(id);
    if (slot === undefined) {
      slot = this.freeSlots.pop() ?? this.nextSlot++;
      map.set(id, slot);
    }
    return slot;
  }

  slotOfSegment(id: Id): number {
    return this.slotFrom(this.segSlot, id);
  }

  slotOfNode(id: Id): number {
    return this.slotFrom(this.nodeSlot, id);
  }

  private releaseSlot(map: Map<Id, number>, id: Id): void {
    const slot = map.get(id);
    if (slot !== undefined) {
      map.delete(id);
      this.freeSlots.push(slot);
    }
  }

  private onNetworkChange(e: NetworkChange): void {
    if (e.reset) {
      this.pendingAll = true;
      this.pendingDecals = true;
      this.pendingEndpoints = true;
      return;
    }
    if (e.decalsChanged) this.pendingDecals = true;
    if (e.endpointsChanged) this.pendingEndpoints = true;
    for (const id of e.dirtySegments) this.dirty.segments.add(id);
    for (const id of e.dirtyNodes) this.dirty.nodes.add(id);
    for (const id of e.removedSegments) {
      this.dirty.segments.add(id);
      this.pendingEndpoints = true;
    }
    for (const id of e.removedNodes) this.dirty.nodes.add(id);
    // A station placed, moved or removed under a deck: flush works out which decks.
    if (e.railChanged) this.railDirty = true;
    if (e.dirtySegments.length || e.removedSegments.length || e.dirtyNodes.length || e.removedNodes.length) this.structuralChange = true;
  }

  private rebuildSegment(id: Id, footprintChanged: boolean): void {
    const seg = this.net.getSegment(id);
    const out: RoadOutputs = { surf: new SurfBuf(), tube: new SurfBuf(), plug: new SurfBuf(), hole: new HoleBuf(), detail: new SurfBuf() };
    const old = this.segBounds.get(id);
    if (old && footprintChanged) this.pendingBoxes.push(old);
    if (!seg) {
      this.detail.set(id, null);
      this.surf.set(id, null);
      this.tube.set(id, null);
      this.plug.set(id, null);
      this.hole.set(id, null);
      this.paint.set(id, null);
      this.arrows.set(id, null);
      this.segBounds.delete(id);
      this.releaseSlot(this.segSlot, id);
      return;
    }
    const slot = this.slotOfSegment(id);
    buildSegment(this.net, id, slot, out);
    this.detail.set(id, out.detail!.toPiece());
    this.surf.set(id, out.surf.toPiece());
    this.tube.set(id, out.tube.toPiece());
    this.plug.set(id, out.plug.toPiece());
    this.hole.set(id, out.hole.toPiece());
    const paint = new PaintBuf();
    buildSegmentPaint(this.net, id, paint);
    this.paint.set(id, paint);
    if (this.lanesOn) {
      const arrows = new PaintBuf();
      buildLaneArrows(this.net, id, arrows);
      this.arrows.set(id, arrows.toPiece());
    }
    const stations = this.net.curveOf(id).stations;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of stations) {
      minX = Math.min(minX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z);
      maxX = Math.max(maxX, s.pos.x);
      maxZ = Math.max(maxZ, s.pos.z);
    }
    const box: [number, number, number, number] = [minX, minZ, maxX, maxZ];
    this.segBounds.set(id, box);
    if (footprintChanged) this.pendingBoxes.push(box);
  }

  /** Rebuild only the automatic paint of a segment. */
  private repaintSegment(id: Id): void {
    if (!this.net.getSegment(id)) return;
    const paint = new PaintBuf();
    buildSegmentPaint(this.net, id, paint);
    this.paint.set(id, paint);
  }

  /** Rebuild only the paint of a node. */
  private repaintNode(id: Id): void {
    if (!this.net.getNode(id)) return;
    const guides = new PaintBuf();
    if (isRampJunction(this.net, id)) buildRampJunctionPaint(this.net, id, guides);
    else buildJunctionGuides(this.net, id, guides);
    this.paint.set(NODE_KEY_BASE + id, guides);
  }

  /** Segments under decals added, moved, restyled or removed since last asked. */
  private decalTouched(): Set<Id> {
    const out = new Set<Id>();
    const seen = new Set<Id>();
    for (const d of this.net.decals) {
      seen.add(d.id);
      const segs = d.road ? [...new Set(d.road.pieces.map((p) => p.segmentId))] : [];
      const sig = JSON.stringify([d.kind, d.road, d.style, d.width]);
      const old = this.decalSigs.get(d.id);
      if (old?.sig === sig) continue;
      for (const s of old?.segs ?? []) out.add(s);
      for (const s of segs) out.add(s);
      this.decalSigs.set(d.id, { sig, segs });
    }
    for (const [id, old] of this.decalSigs) {
      if (seen.has(id)) continue;
      for (const s of old.segs) out.add(s);
      this.decalSigs.delete(id);
    }
    return out;
  }

  private rebuildNode(id: Id): void {
    const key = NODE_KEY_BASE + id;
    const node = this.net.getNode(id);
    if (!node) {
      this.surf.set(key, null);
      this.hole.set(key, null);
      this.paint.set(key, null);
      this.releaseSlot(this.nodeSlot, id);
      return;
    }
    const out: RoadOutputs = { surf: new SurfBuf(), tube: new SurfBuf(), plug: new SurfBuf(), hole: new HoleBuf() };
    buildJunction(this.net, id, this.slotOfNode(id), out);
    this.surf.set(key, out.surf.toPiece());
    this.hole.set(key, out.hole.toPiece());
    const guides = new PaintBuf();
    // Highway diverges and merges get full lane, edge and gore paint (gore.ts) instead.
    if (isRampJunction(this.net, id)) buildRampJunctionPaint(this.net, id, guides);
    // An edge merge paints its taper and gore only; the highway's lines run on (edgeMerge.ts).
    else if (isEdgeMerge(this.net, id)) buildEdgeMergePaint(this.net, id, guides);
    else buildJunctionGuides(this.net, id, guides);
    this.paint.set(key, guides);
  }

  /** Apply what changed since last frame. Null when nothing did. */
  flush(): ChangeSummary | null {
    const net = this.net;
    const any = this.pendingAll || this.dirty.segments.size || this.dirty.nodes.size || this.pendingDecals || this.pendingEndpoints || this.railDirty;
    if (!any) return null;
    const segs = this.dirty.segments;
    const nodes = this.dirty.nodes;
    const piersOnly = new Set<Id>();
    if (this.pendingAll) {
      this.detail.clear();
      this.stationChanges();
      this.surf.clear();
      this.tube.clear();
      this.plug.clear();
      this.hole.clear();
      this.paint.clear();
      this.arrows.clear();
      this.segSlot.clear();
      this.nodeSlot.clear();
      this.freeSlots.length = 0;
      this.nextSlot = 1;
      this.segBounds.clear();
      segs.clear();
      nodes.clear();
      for (const s of net.segments) segs.add(s.id);
      for (const n of net.nodes) nodes.add(n.id);
    } else {
      // Paint at a road's ends depends on its nodes, and a junction's mesh on its arms.
      for (const id of [...segs]) {
        const s = net.getSegment(id);
        if (s) {
          nodes.add(s.a);
          nodes.add(s.b);
        }
      }
      for (const id of [...nodes]) {
        const n = net.getNode(id);
        if (n) for (const s of n.segments) segs.add(s);
      }
      // Anything added, moved or removed below an elevated road or junction moves its
      // piers: re-plan every deck within a portal's reach of where it was or is now.
      const changed: [number, number, number, number][] = [...this.stationChanges()];
      for (const id of segs) {
        const old = this.segBounds.get(id);
        if (old) changed.push(old);
        if (net.getSegment(id)) changed.push(stationBox(net.curveOf(id).stations));
      }
      const reach = PORTAL_REACH + 20;
      const raised = (x: number, y: number, z: number) => y - terrainHeight(x, z) > MIN_PIER_CLEARANCE - 0.5;
      for (const [x0, z0, x1, z1] of changed) {
        const region = { minX: x0 - reach, minZ: z0 - reach, maxX: x1 + reach, maxZ: z1 + reach };
        for (const other of net.segmentsInRegion(region, true)) {
          if (segs.has(other)) continue;
          const g = net.segmentGeom(other);
          if (g?.stations.some((st) => raised(st.pos.x, st.pos.y, st.pos.z))) {
            segs.add(other);
            piersOnly.add(other);
          }
        }
        for (const n of net.nodesInRegion(region)) {
          const node = net.getNode(n);
          if (node && !nodes.has(n) && raised(node.pos.x, node.pos.y, node.pos.z)) nodes.add(n);
        }
      }
    }
    for (const id of segs) this.rebuildSegment(id, !piersOnly.has(id));
    for (const id of nodes) this.rebuildNode(id);
    // A decal holding a line, crosswalk, stop line or arrow leaves the automatic one
    // off under it: repaint just the paint of the roads whose decals changed.
    if (this.pendingDecals) {
      for (const id of this.decalTouched()) {
        if (!segs.has(id)) this.repaintSegment(id);
        // A line crossing a transition leaves the automatic line there off too.
        const s = net.getSegment(id);
        if (s) for (const n of [s.a, s.b]) if (!nodes.has(n) && (net.nodeGeom(n)?.arms.length ?? 0) === 2) this.repaintNode(n);
      }
    }
    const hadGeometry = segs.size > 0 || nodes.size > 0;
    for (const b of [this.surf, this.tube, this.plug, this.hole, this.paint, this.arrows, this.detail]) b.flush();
    if (hadGeometry) this.onSlotsChanged();
    const summary: ChangeSummary = {
      boxes: this.pendingBoxes,
      decals: this.pendingDecals,
      endpoints: this.pendingEndpoints,
      structural: this.structuralChange || this.pendingAll,
      reset: this.pendingAll,
    };
    this.pendingBoxes = [];
    this.pendingAll = false;
    this.pendingDecals = false;
    this.pendingEndpoints = false;
    this.structuralChange = false;
    segs.clear();
    nodes.clear();
    return summary;
  }

  /** Plan boxes of stations placed, moved or removed since last asked. */
  private stationChanges(): [number, number, number, number][] {
    if (!this.railDirty) return [];
    this.railDirty = false;
    const out: [number, number, number, number][] = [];
    const seen = new Set<Id>();
    for (const st of this.net.rail.stations) {
      seen.add(st.id);
      // Moving its track moves it too, but that segment is dirty and handled with the rest.
      const key = `${st.segmentId}:${st.t}:${st.platformLength}:${st.kind}:${st.layout ?? ''}:${st.building ?? ''}`;
      const prev = this.stationKeys.get(st.id);
      if (prev && prev.key === key) continue;
      const fp = placedStationFootprint(this.net, st);
      let box: [number, number, number, number] | null = null;
      if (fp) {
        box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const b of fp.boxes) {
          const r = b.hl + b.hw;
          box = [Math.min(box[0], b.cx - r), Math.min(box[1], b.cz - r), Math.max(box[2], b.cx + r), Math.max(box[3], b.cz + r)];
        }
        out.push(box);
      }
      if (prev?.box) out.push(prev.box);
      this.stationKeys.set(st.id, { key, box });
    }
    for (const [id, prev] of this.stationKeys) {
      if (seen.has(id)) continue;
      if (prev.box) out.push(prev.box);
      this.stationKeys.delete(id);
    }
    return out;
  }

  /** Show small structure parts only near the camera. One distance test per chunk. */
  updateDetail(camera: THREE.Vector3): boolean {
    const r2 = this.detailRange * this.detailRange;
    let changed = false;
    for (const child of this.detail.group.children) {
      const mesh = child as THREE.Mesh;
      const s = mesh.geometry.boundingSphere;
      if (!s) continue;
      const d = Math.max(0, camera.distanceTo(s.center) - s.radius);
      const show = this.detailRange > 0 && d * d < r2;
      if (mesh.visible !== show) {
        mesh.visible = show;
        changed = true;
      }
    }
    return changed;
  }

  /** Road surface shader level; the textures themselves live in Shared.roadTex. */
  setRoadDetail(detail: RoadDetailName): void {
    setSurfaceDetail(this.surfaceMaterial, detail);
  }

  setUnderground(on: boolean): void {
    this.tube.group.visible = on;
    this.plug.group.visible = !on;
  }

  /** Show lane direction arrows, building them on first use. */
  setLaneArrows(on: boolean): void {
    this.lanesOn = on;
    this.arrows.group.visible = on;
    if (!on) {
      this.arrows.clear();
      this.arrows.flush();
      return;
    }
    for (const s of this.net.segments) {
      const buf = new PaintBuf();
      buildLaneArrows(this.net, s.id, buf);
      this.arrows.set(s.id, buf.toPiece());
    }
    this.arrows.flush();
  }

  dispose(): void {
    this.unsubscribe();
    for (const b of [this.surf, this.tube, this.plug, this.hole, this.paint, this.arrows, this.detail]) b.dispose();
    this.surfaceMaterial.dispose();
    this.arrowMaterial.dispose();
    this.holeMaterial.dispose();
    this.group.clear();
  }
}
