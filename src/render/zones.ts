/**
 * Zoned regions on the ground: a tint over what is really zoned, shown while a
 * zoning tool is active, and the ghost of a region being selected.
 */
import * as THREE from 'three';
import type { RoadNetwork } from '../core/RoadNetwork';
import { terrainHeight } from '../core/terrain';
import type { ZoneKind } from '../core/types';
import { ZONE_STEP, zoneCoverage } from '../core/zones';
import type { ZoneGhost } from './api';

const TINT: Record<ZoneKind, number> = { residential: 0x58c86a, commercial: 0x4f9cff, industrial: 0xf2b33d, office: 0xb48cff };
const LIFT = 0.12;

function material(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });
}

export class ZoneLayer {
  readonly group = new THREE.Group();
  private tint: THREE.Mesh | null = null;
  private ghost: THREE.Mesh | null = null;
  private tintMat = material(0.28);
  private ghostMat = material(0.42);
  private stale = true;
  private visible = false;

  constructor(private readonly net: RoadNetwork) {}

  /** The network changed. The tint is rebuilt the next time it is shown. */
  markStale(): void {
    this.stale = true;
    if (this.visible) this.rebuildTint();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (on && this.stale) this.rebuildTint();
    if (this.tint) this.tint.visible = on;
  }

  private rebuildTint(): void {
    this.stale = false;
    if (this.tint) {
      this.group.remove(this.tint);
      this.tint.geometry.dispose();
      this.tint = null;
    }
    const pos: number[] = [];
    const col: number[] = [];
    const h = ZONE_STEP / 2;
    for (const z of this.net.project.zones ?? []) {
      if (z.kind === 'none') continue;
      const c = new THREE.Color(TINT[z.kind]);
      if (!z.enabled) c.multiplyScalar(0.5);
      for (const cell of zoneCoverage(this.net, z.id).cells) {
        const y = Math.max(terrainHeight(cell.x, cell.z), 0) + LIFT;
        const corners = [
          [cell.x - h, cell.z - h],
          [cell.x + h, cell.z - h],
          [cell.x + h, cell.z + h],
          [cell.x - h, cell.z - h],
          [cell.x + h, cell.z + h],
          [cell.x - h, cell.z + h],
        ];
        for (const [x, zz] of corners) {
          pos.push(x, y, zz);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.tint = new THREE.Mesh(geo, this.tintMat);
    this.tint.renderOrder = 4;
    this.tint.visible = this.visible;
    this.group.add(this.tint);
  }

  setGhost(ghosts: ZoneGhost[]): void {
    if (this.ghost) {
      this.group.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghost = null;
    }
    const pos: number[] = [];
    const col: number[] = [];
    for (const g of ghosts) {
      if (g.points.length < 3) continue;
      const c = new THREE.Color(g.color);
      const contour = g.points.map((p) => new THREE.Vector2(p.x, p.z));
      for (const face of THREE.ShapeUtils.triangulateShape(contour, [])) {
        for (const i of face) {
          const p = g.points[i];
          pos.push(p.x, Math.max(terrainHeight(p.x, p.z), 0) + LIFT + 0.05, p.z);
          col.push(c.r, c.g, c.b);
        }
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.ghost = new THREE.Mesh(geo, this.ghostMat);
    this.ghost.renderOrder = 5;
    this.group.add(this.ghost);
  }

  dispose(): void {
    this.setGhost([]);
    if (this.tint) this.tint.geometry.dispose();
    this.tintMat.dispose();
    this.ghostMat.dispose();
  }
}
