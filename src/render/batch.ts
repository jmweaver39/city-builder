/**
 * Mesh building blocks. Every road, junction and marking is kept on the CPU as a
 * small keyed piece. Pieces are merged into one BufferGeometry per map chunk, so
 * a whole-map view costs tens of draw calls rather than thousands. Editing a road
 * replaces its piece and re-merges only the chunks that piece touches.
 */
import * as THREE from 'three';

export interface AttrSpec {
  name: string;
  size: number;
}

/** One keyed mesh in CPU memory. */
export interface Piece {
  attrs: Float32Array[];
  index: Uint32Array;
  vertexCount: number;
  cx: number;
  cz: number;
}

export interface BatchOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
  chunkSize?: number;
}

interface Chunk {
  key: string;
  ids: Set<number>;
  mesh: THREE.Mesh | null;
}

export class ChunkBatch {
  readonly group = new THREE.Group();
  private pieces = new Map<number, { piece: Piece; chunk: Chunk }>();
  private chunks = new Map<string, Chunk>();
  private dirty = new Set<Chunk>();
  private readonly chunkSize: number;

  constructor(
    private readonly schema: AttrSpec[],
    private readonly material: THREE.Material,
    private readonly opts: BatchOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? 250;
  }

  private chunkFor(x: number, z: number): Chunk {
    const key = `${Math.floor(x / this.chunkSize)},${Math.floor(z / this.chunkSize)}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { key, ids: new Set(), mesh: null };
      this.chunks.set(key, c);
    }
    return c;
  }

  /** Add, replace or (with null) remove a piece. Takes effect at the next flush. */
  set(id: number, piece: Piece | null): void {
    const old = this.pieces.get(id);
    if (old) {
      old.chunk.ids.delete(id);
      this.dirty.add(old.chunk);
      this.pieces.delete(id);
    }
    if (!piece || piece.vertexCount === 0) return;
    const chunk = this.chunkFor(piece.cx, piece.cz);
    chunk.ids.add(id);
    this.pieces.set(id, { piece, chunk });
    this.dirty.add(chunk);
  }

  has(id: number): boolean {
    return this.pieces.has(id);
  }

  clear(): void {
    for (const c of this.chunks.values()) {
      c.ids.clear();
      this.dirty.add(c);
    }
    this.pieces.clear();
  }

  flush(): void {
    for (const chunk of this.dirty) this.merge(chunk);
    this.dirty.clear();
  }

  private merge(chunk: Chunk): void {
    if (chunk.mesh) {
      chunk.mesh.geometry.dispose();
      this.group.remove(chunk.mesh);
      chunk.mesh = null;
    }
    if (chunk.ids.size === 0) {
      this.chunks.delete(chunk.key);
      return;
    }
    let verts = 0;
    let indices = 0;
    for (const id of chunk.ids) {
      const p = this.pieces.get(id)!.piece;
      verts += p.vertexCount;
      indices += p.index.length;
    }
    const geo = new THREE.BufferGeometry();
    const arrays = this.schema.map((s) => new Float32Array(verts * s.size));
    const index = new Uint32Array(indices);
    let v = 0;
    let i = 0;
    for (const id of chunk.ids) {
      const p = this.pieces.get(id)!.piece;
      for (let a = 0; a < arrays.length; a++) arrays[a].set(p.attrs[a], v * this.schema[a].size);
      for (let k = 0; k < p.index.length; k++) index[i + k] = p.index[k] + v;
      i += p.index.length;
      v += p.vertexCount;
    }
    this.schema.forEach((s, a) => geo.setAttribute(s.name, new THREE.BufferAttribute(arrays[a], s.size)));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = !!this.opts.castShadow;
    mesh.receiveShadow = !!this.opts.receiveShadow;
    mesh.renderOrder = this.opts.renderOrder ?? 0;
    mesh.matrixAutoUpdate = false;
    chunk.mesh = mesh;
    this.group.add(mesh);
  }

  dispose(): void {
    for (const c of this.chunks.values()) c.mesh?.geometry.dispose();
    this.chunks.clear();
    this.pieces.clear();
    this.dirty.clear();
    this.group.clear();
  }
}

// ---------------------------------------------------------------------------
// Surface buffers: lit opaque geometry shared by roads, junctions and structures.
// ---------------------------------------------------------------------------

export const SURF_SCHEMA: AttrSpec[] = [
  { name: 'position', size: 3 },
  { name: 'normal', size: 3 },
  { name: 'color', size: 3 },
  // kind, overlay slot, depth bias
  { name: 'aExt', size: 3 },
  // Across and along the road in metres. For asphalt, across is from the lane centre.
  { name: 'aRoad', size: 2 },
];

type RGBLike = readonly [number, number, number];

export interface SurfStyle {
  color: RGBLike;
  kind: number;
  slot: number;
  bias: number;
}

/** Growable geometry for one piece. */
export class SurfBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  ext: number[] = [];
  road: number[] = [];
  idx: number[] = [];
  /** Road coordinates given to the next vertices. */
  ru = 0;
  rv = 0;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, s: SurfStyle): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(s.color[0], s.color[1], s.color[2]);
    this.ext.push(s.kind, s.slot, s.bias);
    this.road.push(this.ru, this.rv);
    return i;
  }

  /** Counter-clockwise seen from the normal side. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Flat quad from four points, normal from its winding. */
  flatQuad(a: number[], b: number[], c: number[], d: number[], s: SurfStyle): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i0 = this.vert(a[0], a[1], a[2], nx, ny, nz, s);
    const i1 = this.vert(b[0], b[1], b[2], nx, ny, nz, s);
    const i2 = this.vert(c[0], c[1], c[2], nx, ny, nz, s);
    const i3 = this.vert(d[0], d[1], d[2], nx, ny, nz, s);
    this.quad(i0, i1, i2, i3);
  }

  /**
   * Oriented box. Centre, half extents along its right, up and forward axes.
   * Right and forward are horizontal unit vectors given as (x, z).
   */
  box(
    cx: number,
    cy: number,
    cz: number,
    hr: number,
    hu: number,
    hf: number,
    rx: number,
    rz: number,
    fx: number,
    fz: number,
    s: SurfStyle,
    faces: { bottom?: boolean } = {},
  ): void {
    const p = (sr: number, su: number, sf: number): number[] => [
      cx + rx * sr * hr + fx * sf * hf,
      cy + su * hu,
      cz + rz * sr * hr + fz * sf * hf,
    ];
    // Handedness of (right, forward) decides the winding.
    const flip = rx * fz - rz * fx < 0;
    const face = (a: number[], b: number[], c: number[], d: number[]) =>
      flip ? this.flatQuad(a, b, c, d, s) : this.flatQuad(d, c, b, a, s);
    face(p(-1, 1, -1), p(1, 1, -1), p(1, 1, 1), p(-1, 1, 1)); // top
    face(p(1, 1, -1), p(1, -1, -1), p(1, -1, 1), p(1, 1, 1)); // right
    face(p(-1, -1, -1), p(-1, 1, -1), p(-1, 1, 1), p(-1, -1, 1)); // left
    face(p(-1, -1, 1), p(-1, 1, 1), p(1, 1, 1), p(1, -1, 1)); // front
    face(p(1, -1, -1), p(1, 1, -1), p(-1, 1, -1), p(-1, -1, -1)); // back
    if (faces.bottom) face(p(-1, -1, 1), p(1, -1, 1), p(1, -1, -1), p(-1, -1, -1));
  }

  /** Beam whose bottom is narrower than its top, across right. For pier caps. */
  taperBeam(cx: number, y0: number, y1: number, cz: number, hrTop: number, hrBottom: number, hf: number, rx: number, rz: number, fx: number, fz: number, s: SurfStyle): void {
    const p = (hr: number, sr: number, y: number, sf: number): number[] => [cx + rx * sr * hr + fx * sf * hf, y, cz + rz * sr * hr + fz * sf * hf];
    const a = p(hrBottom, -1, y0, -1);
    const b = p(hrBottom, 1, y0, -1);
    const c = p(hrBottom, 1, y0, 1);
    const d = p(hrBottom, -1, y0, 1);
    const e = p(hrTop, -1, y1, -1);
    const f = p(hrTop, 1, y1, -1);
    const g = p(hrTop, 1, y1, 1);
    const h = p(hrTop, -1, y1, 1);
    this.flatQuad(f, b, c, g, s);
    this.flatQuad(a, e, h, d, s);
    this.flatQuad(d, h, g, c, s);
    this.flatQuad(b, f, e, a, s);
    this.flatQuad(d, c, b, a, s);
    this.flatQuad(e, f, g, h, s);
  }

  /** Vertical prism with n sides from y0 to y1. */
  prism(cx: number, cz: number, y0: number, y1: number, radius: number, n: number, s: SurfStyle, ang0 = 0): void {
    const base = this.vertexCount;
    for (let i = 0; i <= n; i++) {
      const a = ang0 + ((i + 0.5) / n) * Math.PI * 2;
      const c = Math.cos(a);
      const q = Math.sin(a);
      this.vert(cx + c * radius, y0, cz + q * radius, c, 0, q, s);
      this.vert(cx + c * radius, y1, cz + q * radius, c, 0, q, s);
    }
    for (let i = 0; i < n; i++) {
      const a = base + i * 2;
      this.quad(a, a + 1, a + 3, a + 2);
    }
  }

  toPiece(): Piece | null {
    const n = this.vertexCount;
    if (n === 0) return null;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i += Math.max(1, n >> 6)) {
      sx += this.pos[i * 3];
      sz += this.pos[i * 3 + 2];
    }
    const m = Math.ceil(n / Math.max(1, n >> 6));
    return {
      attrs: [new Float32Array(this.pos), new Float32Array(this.nor), new Float32Array(this.col), new Float32Array(this.ext), new Float32Array(this.road)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: sx / m,
      cz: sz / m,
    };
  }
}

// ---------------------------------------------------------------------------
// Paint buffers: ribbons and stamps drawn with analytic coverage.
// ---------------------------------------------------------------------------

export const PAINT_SCHEMA: AttrSpec[] = [
  { name: 'position', size: 3 },
  // Unit side vector in plan, expanded in the vertex shader for thin lines.
  { name: 'aSide', size: 2 },
  // side sign (-1, 1), half width, u along the line in metres
  { name: 'aLine', size: 3 },
  // dash period (0 solid, -1 stamp), duty
  { name: 'aDash', size: 2 },
  { name: 'color', size: 3 },
];

export interface LinePoint {
  x: number;
  y: number;
  z: number;
  /** Unit side vector in plan. */
  rx: number;
  rz: number;
  /** Distance along the line. */
  u: number;
}

export class PaintBuf {
  pos: number[] = [];
  side: number[] = [];
  line: number[] = [];
  dash: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** A ribbon along pts. */
  ribbon(pts: readonly LinePoint[], width: number, color: RGBLike, period: number, duty: number): void {
    if (pts.length < 2) return;
    const base = this.vertexCount;
    const hw = width / 2;
    for (const p of pts) {
      for (const sign of [-1, 1]) {
        this.pos.push(p.x, p.y, p.z);
        this.side.push(p.rx, p.rz);
        this.line.push(sign, hw, p.u);
        this.dash.push(period, duty);
        this.col.push(color[0], color[1], color[2]);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = base + i * 2;
      // Side +1 is right of travel, so this is counter-clockwise from above.
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  /** Straight bar between two points. */
  bar(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, color: RGBLike, period = 0, duty = 1): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const rx = -dz / len;
    const rz = dx / len;
    this.ribbon(
      [
        { x: ax, y: ay, z: az, rx, rz, u: 0 },
        { x: bx, y: by, z: bz, rx, rz, u: len },
      ],
      width,
      color,
      period,
      duty,
    );
  }

  /** Solid triangles in plan, at height y. coords are flat x, z pairs. */
  stamp(coords: ArrayLike<number>, y: number, color: RGBLike): void {
    const base = this.vertexCount;
    const n = coords.length / 2;
    for (let i = 0; i < n; i++) {
      this.pos.push(coords[i * 2], y, coords[i * 2 + 1]);
      this.side.push(1, 0);
      this.line.push(0, 1e3, 0);
      this.dash.push(-1, 1);
      this.col.push(color[0], color[1], color[2]);
    }
    for (let i = 0; i < n; i += 3) {
      // Keep front faces up whatever order the caller gave.
      const ax = coords[i * 2];
      const az = coords[i * 2 + 1];
      const bx = coords[(i + 1) * 2];
      const bz = coords[(i + 1) * 2 + 1];
      const cx = coords[(i + 2) * 2];
      const cz = coords[(i + 2) * 2 + 1];
      const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (area < 0) this.idx.push(base + i, base + i + 1, base + i + 2);
      else this.idx.push(base + i, base + i + 2, base + i + 1);
    }
  }

  toPiece(): Piece | null {
    const n = this.vertexCount;
    if (n === 0) return null;
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += this.pos[i * 3];
      sz += this.pos[i * 3 + 2];
    }
    return {
      attrs: [
        new Float32Array(this.pos),
        new Float32Array(this.side),
        new Float32Array(this.line),
        new Float32Array(this.dash),
        new Float32Array(this.col),
      ],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: sx / n,
      cz: sz / n,
    };
  }
}

// ---------------------------------------------------------------------------
// Position-only strips for the terrain cutout.
// ---------------------------------------------------------------------------

export const HOLE_SCHEMA: AttrSpec[] = [{ name: 'position', size: 3 }];

export class HoleBuf {
  pos: number[] = [];
  idx: number[] = [];

  /** Two points per cross section, in order. */
  strip(leftRight: number[]): void {
    const base = this.pos.length / 3;
    for (const v of leftRight) this.pos.push(v);
    const n = leftRight.length / 6;
    for (let i = 0; i + 1 < n; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  polygon(points: readonly number[], index: readonly number[]): void {
    const base = this.pos.length / 3;
    for (const v of points) this.pos.push(v);
    for (const i of index) this.idx.push(base + i);
  }

  toPiece(): Piece | null {
    const n = this.pos.length / 3;
    if (n === 0) return null;
    return {
      attrs: [new Float32Array(this.pos)],
      index: new Uint32Array(this.idx),
      vertexCount: n,
      cx: this.pos[0],
      cz: this.pos[2],
    };
  }
}
