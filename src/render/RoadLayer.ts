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
import { makeHoleMaterial, makePaintMaterial, makeSurfaceMaterial, type Shared } from './materials';
import { buildLaneArrows, type SlotOwner } from './overlays';
import { buildSegment, type RoadOutputs } from './roads';

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
  private paint: ChunkBatch;
  private arrows: ChunkBatch;

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
    this.paintMaterial = makePaintMaterial(shared, { bias: BIAS_MARKING, lift: MARK_LIFT });
    this.arrowMaterial = makePaintMaterial(shared, { bias: BIAS_MARKING * 1.2, lift: MARK_LIFT + 0.01, fade: false });
    this.holeMaterial = makeHoleMaterial();
    const shadow = { castShadow: true, receiveShadow: true };
    this.surf = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, shadow);
    this.tube = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, { receiveShadow: false });
    this.plug = new ChunkBatch(SURF_SCHEMA, this.surfaceMaterial, {});
    this.hole = new ChunkBatch(HOLE_SCHEMA, this.holeMaterial, { renderOrder: -10 });
    this.paint = new ChunkBatch(PAINT_SCHEMA, this.paintMaterial, { renderOrder: 5, receiveShadow: true });
    this.arrows = new ChunkBatch(PAINT_SCHEMA, this.arrowMaterial, { renderOrder: 6 });
    this.tube.group.visible = false;
    this.arrows.group.visible = false;
    for (const b of [this.hole, this.surf, this.tube, this.plug, this.paint, this.arrows]) this.group.add(b.group);
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
    if (e.dirtySegments.length || e.removedSegments.length || e.dirtyNodes.length || e.removedNodes.length) this.structuralChange = true;
  }

  private rebuildSegment(id: Id, footprintChanged: boolean): void {
    const seg = this.net.getSegment(id);
    const out: RoadOutputs = { surf: new SurfBuf(), tube: new SurfBuf(), plug: new SurfBuf(), hole: new HoleBuf() };
    const old = this.segBounds.get(id);
    if (old && footprintChanged) this.pendingBoxes.push(old);
    if (!seg) {
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
    this.surf.set(id, out.surf.toPiece());
    this.tube.set(id, out.tube.toPiece());
    this.plug.set(id, out.plug.toPiece());
    this.hole.set(id, out.hole.toPiece());
    const paint = new PaintBuf();
    buildSegmentPaint(this.net, id, paint);
    this.paint.set(id, paint.toPiece());
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
    else buildJunctionGuides(this.net, id, guides);
    this.paint.set(key, guides.toPiece());
  }

  /** Apply what changed since last frame. Null when nothing did. */
  flush(): ChangeSummary | null {
    const net = this.net;
    const any = this.pendingAll || this.dirty.segments.size || this.dirty.nodes.size || this.pendingDecals || this.pendingEndpoints;
    if (!any) return null;
    const segs = this.dirty.segments;
    const nodes = this.dirty.nodes;
    const piersOnly = new Set<Id>();
    if (this.pendingAll) {
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
      // A new low road can stand under an elevated one, whose piers must then move.
      for (const id of [...segs]) {
        const box = this.segBounds.get(id);
        if (!box || !net.getSegment(id)) continue;
        for (const other of net.segmentsInRegion({ minX: box[0], minZ: box[1], maxX: box[2], maxZ: box[3] }, true)) {
          if (segs.has(other)) continue;
          const g = net.segmentGeom(other);
          if (g?.stations.some((st) => st.pos.y > 4)) {
            segs.add(other);
            piersOnly.add(other);
          }
        }
      }
    }
    for (const id of segs) this.rebuildSegment(id, !piersOnly.has(id));
    for (const id of nodes) this.rebuildNode(id);
    const hadGeometry = segs.size > 0 || nodes.size > 0;
    for (const b of [this.surf, this.tube, this.plug, this.hole, this.paint, this.arrows]) b.flush();
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
    for (const b of [this.surf, this.tube, this.plug, this.hole, this.paint, this.arrows]) b.dispose();
    this.surfaceMaterial.dispose();
    this.paintMaterial.dispose();
    this.arrowMaterial.dispose();
    this.holeMaterial.dispose();
    this.group.clear();
  }
}
