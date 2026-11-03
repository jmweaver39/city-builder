/**
 * A uniform hash over plan-view cells. An item sits in every cell its shape
 * touches, so long diagonal roads do not fill their whole bounding box.
 */
import type { Id } from './types';

const OFFSET = 0x8000;

export class SpatialHash {
  private readonly cells = new Map<number, Set<Id>>();
  private readonly keysOf = new Map<Id, number[]>();

  constructor(private readonly cellSize = 64) {}

  private key(ix: number, iz: number): number {
    return (ix + OFFSET) * 0x10000 + (iz + OFFSET);
  }

  remove(id: Id): void {
    const keys = this.keysOf.get(id);
    if (!keys) return;
    for (const k of keys) {
      const cell = this.cells.get(k);
      if (!cell) continue;
      cell.delete(id);
      if (cell.size === 0) this.cells.delete(k);
    }
    this.keysOf.delete(id);
  }

  /** Place an item along a polyline given as flat [x, z, ...]. Replaces any old entry. */
  setPolyline(id: Id, xz: ArrayLike<number>): void {
    this.remove(id);
    const keys = new Set<number>();
    const size = this.cellSize;
    const addBox = (x0: number, z0: number, x1: number, z1: number) => {
      const ix0 = Math.floor(Math.min(x0, x1) / size);
      const ix1 = Math.floor(Math.max(x0, x1) / size);
      const iz0 = Math.floor(Math.min(z0, z1) / size);
      const iz1 = Math.floor(Math.max(z0, z1) / size);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) keys.add(this.key(ix, iz));
      }
    };
    if (xz.length < 4) {
      addBox(xz[0], xz[1], xz[0], xz[1]);
    } else {
      for (let i = 0; i + 3 < xz.length; i += 2) {
        const x0 = xz[i];
        const z0 = xz[i + 1];
        const x1 = xz[i + 2];
        const z1 = xz[i + 3];
        const span = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
        const steps = Math.max(1, Math.ceil(span / (size / 2)));
        for (let k = 0; k < steps; k++) {
          addBox(
            x0 + ((x1 - x0) * k) / steps,
            z0 + ((z1 - z0) * k) / steps,
            x0 + ((x1 - x0) * (k + 1)) / steps,
            z0 + ((z1 - z0) * (k + 1)) / steps,
          );
        }
      }
    }
    const list = [...keys];
    for (const k of list) {
      let cell = this.cells.get(k);
      if (!cell) this.cells.set(k, (cell = new Set()));
      cell.add(id);
    }
    this.keysOf.set(id, list);
  }

  setPoint(id: Id, x: number, z: number): void {
    this.setPolyline(id, [x, z]);
  }

  /** Ids in cells touching the box. A superset of what is really inside it. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): Set<Id> {
    const out = new Set<Id>();
    const size = this.cellSize;
    const ix0 = Math.floor(minX / size);
    const ix1 = Math.floor(maxX / size);
    const iz0 = Math.floor(minZ / size);
    const iz1 = Math.floor(maxZ / size);
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > this.cells.size * 4) {
      // A box this big touches more cells than exist: walk the items instead.
      for (const id of this.keysOf.keys()) out.add(id);
      return out;
    }
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const cell = this.cells.get(this.key(ix, iz));
        if (cell) for (const id of cell) out.add(id);
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
    this.keysOf.clear();
  }
}
