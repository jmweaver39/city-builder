/**
 * Roundabout islands: a raised, kerbed central island with grass, and a raised
 * splitter island between the entry and exit of each two-way arm. Built from
 * core/roundabout.ts and rebuilt when a ring changes. Yield lines come from the
 * ordinary junction markings, since every entry has a yield sign.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import { findRoundabouts, roundaboutIslands } from '../core/roundabout';
import type { RenderContext, RenderLayer } from './context';

const KERB_HEIGHT = 0.15;
/** Lift above the road surface, so the island base never fights the asphalt. */
const LIFT = 0.02;

export class RoundaboutLayer implements RenderLayer {
  private readonly group = new THREE.Group();
  private readonly kerb = new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.9 });
  private readonly grass = new THREE.MeshStandardMaterial({ color: 0x566b3d, roughness: 1 });
  private readonly paved = new THREE.MeshStandardMaterial({ color: 0xcfcbc0, roughness: 0.85 });
  private signature = '';
  private readonly off: () => void;
  private dirty = true;

  constructor(private readonly net: RoadNetwork, ctx: RenderContext) {
    this.group.name = 'roundabouts';
    ctx.scene.add(this.group);
    this.off = net.onChange(() => {
      this.dirty = true;
    });
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const list = findRoundabouts(this.net);
    const sig = list.map((r) => `${r.segments.join(',')}:${r.radius.toFixed(2)}:${r.centre.x.toFixed(1)},${r.centre.z.toFixed(1)}:${r.arms.map((a) => a.segmentId).join(',')}:${r.lanes}`).join('|');
    if (sig === this.signature) return;
    this.signature = sig;
    this.clear();
    for (const rb of list) {
      const islands = roundaboutIslands(this.net, rb);
      const { centre, radius } = islands.central;
      if (radius > 1) {
        // Sides are kerb, the top grass, the bottom unseen.
        const geo = new THREE.CylinderGeometry(radius, radius, KERB_HEIGHT, Math.max(32, Math.round(radius * 3)), 1, false);
        const mesh = new THREE.Mesh(geo, [this.kerb, this.grass, this.kerb]);
        mesh.position.set(centre.x, centre.y + KERB_HEIGHT / 2 + LIFT, centre.z);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        this.group.add(mesh);
        // A paved apron ring inside the kerb, as a truck overrun strip.
        const apron = new THREE.RingGeometry(Math.max(0, radius - 1.2), radius, Math.max(32, Math.round(radius * 3)));
        apron.rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(apron, this.paved);
        ring.position.set(centre.x, centre.y + KERB_HEIGHT + LIFT + 0.005, centre.z);
        ring.receiveShadow = true;
        this.group.add(ring);
      }
      for (const poly of islands.splitters) {
        if (poly.length < 3) continue;
        // Plan polygon to a shape in x and -z, extruded up by the kerb height.
        const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: KERB_HEIGHT, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const y = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        const mesh = new THREE.Mesh(geo, this.paved);
        mesh.position.y = y + LIFT;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
  }

  dispose(): void {
    this.off();
    this.clear();
    this.group.removeFromParent();
    this.kerb.dispose();
    this.grass.dispose();
    this.paved.dispose();
  }
}
