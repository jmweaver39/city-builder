/**
 * Landscaping on the GPU. The effective edit layer (core/terrainEdit.ts) is
 * uploaded tile by tile into one float texture, and TERRAIN_EDIT_GLSL samples it
 * with the same bilinear lookup as the CPU, so the displaced ground matches
 * terrainHeight exactly.
 *
 * - The camera patch adds tEdit() inside tHeight() (render/terrain.ts), so it
 *   follows edits wherever it is.
 * - Edited tiles get their own 2 m grid (`tiles` geometry), displaced the same
 *   way, and the coarse base mesh discards its fragments there (`uEditMask`).
 * - Ground dug below the water table gets flat water quads (`flood` geometry).
 * Only changed tiles are uploaded or re-meshed; a brush tick costs its own area.
 */
import * as THREE from 'three';
import {
  EDIT_CELL,
  EDIT_ORIGIN,
  EDIT_POINTS,
  EDIT_TILE,
  EDIT_TILES,
  terrainEditor,
  type TerrainEditEvent,
  type TerrainEditor,
} from '../core/terrainEdit';
import { riverDistance, WATER_LEVEL } from '../core/terrain';
import type { RenderContext, RenderLayer } from './context';

function placeholder(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Tiles holding edits. */
const mask = new Uint8Array(EDIT_TILES * EDIT_TILES);
/** Tiles the edit mesh draws, so the base mesh leaves them out (uEditMask). */
const drawMask = new Uint8Array(EDIT_TILES * EDIT_TILES);
const maskTexture = new THREE.DataTexture(drawMask, EDIT_TILES, EDIT_TILES, THREE.RedFormat, THREE.UnsignedByteType);
maskTexture.minFilter = THREE.NearestFilter;
maskTexture.magFilter = THREE.NearestFilter;
maskTexture.generateMipmaps = false;
maskTexture.needsUpdate = true;

/** Shared by every material that reads landscaping. */
export const terrainEditUniforms = {
  uEditTex: { value: placeholder() as THREE.Texture },
  uEditMask: { value: maskTexture as THREE.Texture },
  uEditOn: { value: 0 },
};

/** Add the landscaping uniforms to a material's shader in onBeforeCompile. */
export function useTerrainEditUniforms(s: { uniforms: Record<string, THREE.IUniform> }): void {
  s.uniforms.uEditTex = terrainEditUniforms.uEditTex;
  s.uniforms.uEditMask = terrainEditUniforms.uEditMask;
  s.uniforms.uEditOn = terrainEditUniforms.uEditOn;
}

const f = (v: number) => v.toFixed(1);

/**
 * tEdit(p): the landscaping offset at plan point p (x, z), bilinear over the grid,
 * in the same order of operations as TerrainEditGrid.sample. tEditTile(p): 1 in a
 * tile drawn by the edit tiles mesh.
 */
export const TERRAIN_EDIT_GLSL = /* glsl */ `
uniform highp sampler2D uEditTex;
uniform sampler2D uEditMask;
uniform float uEditOn;
float tEditPt(ivec2 q) { return texelFetch(uEditTex, q, 0).r; }
float tEdit(vec2 p) {
  if (uEditOn < 0.5) return 0.0;
  vec2 g = (p - vec2(${f(EDIT_ORIGIN)})) / ${f(EDIT_CELL)};
  if (g.x < 0.0 || g.y < 0.0 || g.x >= ${f(EDIT_POINTS - 1)} || g.y >= ${f(EDIT_POINTS - 1)}) return 0.0;
  vec2 c = floor(g);
  vec2 fr = g - c;
  ivec2 q = ivec2(c);
  float a = tEditPt(q);
  float b = tEditPt(q + ivec2(1, 0));
  float cc = tEditPt(q + ivec2(0, 1));
  float d = tEditPt(q + ivec2(1, 1));
  float top = a + (b - a) * fr.x;
  float bot = cc + (d - cc) * fr.x;
  return top + (bot - top) * fr.y;
}
float tEditTile(vec2 p) {
  if (uEditOn < 0.5) return 0.0;
  vec2 t = floor((p - vec2(${f(EDIT_ORIGIN)})) / ${f(EDIT_TILE * EDIT_CELL)});
  if (t.x < 0.0 || t.y < 0.0 || t.x >= ${f(EDIT_TILES)} || t.y >= ${f(EDIT_TILES)}) return 0.0;
  return texelFetch(uEditMask, ivec2(t), 0).r;
}
`;

/** The surfaces render/terrain.ts gives landscaping to draw into. */
export interface EditSurfaces {
  setEditTiles(geo: THREE.BufferGeometry | null): void;
  setFlood(geo: THREE.BufferGeometry | null): void;
}

/** One tile's 33 x 33 grid, in world x and z, displaced in the shader. */
function tilesGeometry(keys: number[]): THREE.BufferGeometry | null {
  if (!keys.length) return null;
  const n = EDIT_TILE + 1;
  const pos = new Float32Array(keys.length * n * n * 3);
  const nor = new Float32Array(keys.length * n * n * 3);
  const idx = new Uint32Array(keys.length * EDIT_TILE * EDIT_TILE * 6);
  let v = 0;
  let t = 0;
  for (const k of keys) {
    const ti = k % EDIT_TILES;
    const tj = Math.floor(k / EDIT_TILES);
    const x0 = EDIT_ORIGIN + ti * EDIT_TILE * EDIT_CELL;
    const z0 = EDIT_ORIGIN + tj * EDIT_TILE * EDIT_CELL;
    const first = v;
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        pos[v * 3] = x0 + a * EDIT_CELL;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = z0 + b * EDIT_CELL;
        nor[v * 3 + 1] = 1;
        v++;
      }
    }
    for (let b = 0; b < EDIT_TILE; b++) {
      for (let a = 0; a < EDIT_TILE; a++) {
        const p = first + a + b * n;
        idx[t++] = p;
        idx[t++] = p + n;
        idx[t++] = p + 1;
        idx[t++] = p + 1;
        idx[t++] = p + n;
        idx[t++] = p + n + 1;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geo;
}

interface FloodPiece {
  pos: number[];
  edge: number[];
}

/**
 * Cells of a tile with ground under the water table, away from the river's own
 * strip. Read straight from the grid (cached land plus offsets), so it is cheap.
 */
function floodCells(grid: TerrainEditor['grid'], key: number): FloodPiece | null {
  const ti = key % EDIT_TILES;
  const tj = Math.floor(key / EDIT_TILES);
  const i0 = ti * EDIT_TILE;
  const j0 = tj * EDIT_TILE;
  const n = EDIT_TILE + 1;
  const h = new Float32Array(n * n);
  let any = false;
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const i = Math.min(EDIT_POINTS - 1, i0 + a);
      const j = Math.min(EDIT_POINTS - 1, j0 + b);
      const y = grid.base(i, j) + grid.getEff(i, j);
      h[a + b * n] = y;
      if (y < WATER_LEVEL) any = true;
    }
  }
  if (!any) return null;
  const out: FloodPiece = { pos: [], edge: [] };
  const edge = (y: number) => 0.28 + 0.72 * Math.min(1, Math.max(0, (WATER_LEVEL - y) / 6));
  for (let b = 0; b < EDIT_TILE; b++) {
    for (let a = 0; a < EDIT_TILE; a++) {
      const c0 = h[a + b * n];
      const c1 = h[a + 1 + b * n];
      const c2 = h[a + (b + 1) * n];
      const c3 = h[a + 1 + (b + 1) * n];
      if (Math.min(c0, c1, c2, c3) >= WATER_LEVEL) continue;
      const x = EDIT_ORIGIN + (i0 + a) * EDIT_CELL;
      const z = EDIT_ORIGIN + (j0 + b) * EDIT_CELL;
      // The river's own water mesh covers its strip.
      if (riverDistance(x + EDIT_CELL / 2, z + EDIT_CELL / 2) < 39) continue;
      out.pos.push(x, WATER_LEVEL, z, x + EDIT_CELL, WATER_LEVEL, z, x, WATER_LEVEL, z + EDIT_CELL, x + EDIT_CELL, WATER_LEVEL, z + EDIT_CELL);
      out.edge.push(edge(c0), edge(c1), edge(c2), edge(c3));
    }
  }
  return out.pos.length ? out : null;
}

/** Keeps the GPU copy of the landscaping in step with the editor. */
export class TerrainEditLayer implements RenderLayer {
  private texture: THREE.DataTexture | null = null;
  private pending = new Set<number>();
  private meshDirty = false;
  private floodDirty = false;
  /** Flooded cells per tile, rebuilt only where the land changed. */
  private floodTiles = new Map<number, FloodPiece>();
  private floodPending = new Set<number>();
  private floodTimer = 0;
  private off: (() => void) | null = null;
  private bound: TerrainEditor | null = null;
  /** Milliseconds spent on the last flush, for the stats readout. */
  lastFlushMs = 0;

  constructor(
    private readonly gl: THREE.WebGLRenderer,
    private readonly surfaces: EditSurfaces,
    /** The land changed in a box (null: everywhere), for layers standing on it such as trees. */
    private readonly onLand?: (box: { minX: number; minZ: number; maxX: number; maxZ: number } | null) => void,
  ) {}

  /** Add the layer to a render context; it binds to the active TerrainEditor each frame. */
  static install(ctx: RenderContext, surfaces: EditSurfaces, onLand?: TerrainEditLayer['onLand']): TerrainEditLayer {
    const layer = new TerrainEditLayer(ctx.gl, surfaces, onLand);
    ctx.addLayer(layer);
    return layer;
  }

  private bind(ed: TerrainEditor | null): void {
    if (ed === this.bound) return;
    this.off?.();
    this.off = null;
    this.bound = ed;
    if (!ed) return;
    this.off = ed.onEdit((e) => this.onEdit(e));
    this.onEdit({ tiles: ed.grid.effTiles(), box: null, full: true, live: false });
  }

  private onEdit(e: TerrainEditEvent): void {
    if (e.full) for (let k = 0; k < mask.length; k++) if (mask[k]) this.pending.add(k);
    for (const k of e.tiles) this.pending.add(k);
    this.floodDirty = true;
    if (e.full) {
      this.floodTiles.clear();
      for (let k = 0; k < mask.length; k++) this.floodPending.add(k);
    }
    for (const k of e.tiles) {
      // A tile's cells also read the first points of the tiles after it.
      this.floodPending.add(k);
      if (k % EDIT_TILES > 0) this.floodPending.add(k - 1);
      if (k >= EDIT_TILES) this.floodPending.add(k - EDIT_TILES);
      if (k % EDIT_TILES > 0 && k >= EDIT_TILES) this.floodPending.add(k - EDIT_TILES - 1);
    }
    if (!e.live) this.floodTimer = 1;
    if (e.full) this.onLand?.(null);
    else if (e.box) this.onLand?.(e.box);
  }

  private ensureTexture(): THREE.DataTexture {
    if (this.texture) return this.texture;
    const t = new THREE.DataTexture(null as unknown as Float32Array, EDIT_POINTS, EDIT_POINTS, THREE.RedFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    // Allocated by three, filled here a tile at a time.
    t.source.dataReady = false;
    t.needsUpdate = true;
    this.gl.initTexture(t);
    this.texture = t;
    terrainEditUniforms.uEditTex.value = t;
    // Zero the whole thing once: storage from texStorage2D starts undefined on some drivers.
    const zeros = new Float32Array(EDIT_TILE * EDIT_TILE);
    this.upload(() => {
      const ctx = this.gl.getContext() as WebGL2RenderingContext;
      for (let tj = 0; tj < EDIT_TILES; tj++) {
        for (let ti = 0; ti < EDIT_TILES; ti++) ctx.texSubImage2D(ctx.TEXTURE_2D, 0, ti * EDIT_TILE, tj * EDIT_TILE, EDIT_TILE, EDIT_TILE, ctx.RED, ctx.FLOAT, zeros);
      }
    });
    return t;
  }

  private upload(fn: () => void): void {
    const t = this.texture!;
    const ctx = this.gl.getContext() as WebGL2RenderingContext;
    const handle = (this.gl.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!handle) return;
    this.gl.state.bindTexture(ctx.TEXTURE_2D, handle);
    ctx.pixelStorei(ctx.UNPACK_ALIGNMENT, 4);
    ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false);
    ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    ctx.pixelStorei(ctx.UNPACK_ROW_LENGTH, 0);
    ctx.pixelStorei(ctx.UNPACK_SKIP_ROWS, 0);
    ctx.pixelStorei(ctx.UNPACK_SKIP_PIXELS, 0);
    fn();
  }

  update(dt: number): void {
    this.bind(terrainEditor());
    const ed = this.bound;
    if (!ed) return;
    this.floodTimer += dt;
    if (!this.pending.size && !(this.floodDirty && this.floodTimer > 0.25)) return;
    const t0 = performance.now();
    const grid = ed.grid;
    if (this.pending.size && (grid.effCount > 0 || this.texture)) {
      this.ensureTexture();
      const zeros = new Float32Array(EDIT_TILE * EDIT_TILE);
      const keys = [...this.pending];
      this.upload(() => {
        const ctx = this.gl.getContext() as WebGL2RenderingContext;
        for (const k of keys) {
          const data = grid.eff[k] ?? zeros;
          ctx.texSubImage2D(ctx.TEXTURE_2D, 0, (k % EDIT_TILES) * EDIT_TILE, Math.floor(k / EDIT_TILES) * EDIT_TILE, EDIT_TILE, EDIT_TILE, ctx.RED, ctx.FLOAT, data);
        }
      });
      for (const k of keys) {
        const on = grid.eff[k] ? 1 : 0;
        // A tile's mesh also covers the first row and column of the next tile, so
        // the tile before an edited one is drawn by the mesh too.
        if (mask[k] !== on) this.meshDirty = true;
        mask[k] = on;
      }
      this.pending.clear();
    }
    if (this.meshDirty) {
      this.meshDirty = false;
      // Tiles whose own points or whose far edge (the next tile's first points) are edited.
      const draw = new Set<number>();
      for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue;
        const ti = k % EDIT_TILES;
        const tj = Math.floor(k / EDIT_TILES);
        draw.add(k);
        if (ti > 0) draw.add(k - 1);
        if (tj > 0) draw.add(k - EDIT_TILES);
        if (ti > 0 && tj > 0) draw.add(k - EDIT_TILES - 1);
      }
      drawMask.fill(0);
      for (const k of draw) drawMask[k] = 255;
      maskTexture.needsUpdate = true;
      this.surfaces.setEditTiles(tilesGeometry([...draw].sort((a, b) => a - b)));
    }
    terrainEditUniforms.uEditOn.value = this.texture && grid.effCount > 0 ? 1 : 0;
    if (this.floodDirty && this.floodTimer > 0.25) {
      this.floodDirty = false;
      this.floodTimer = 0;
      for (const k of this.floodPending) {
        // Only tiles with edits in them or at their far edges can hold new water.
        const e = grid.eff;
        const near = !!(e[k] || (k % EDIT_TILES < EDIT_TILES - 1 && e[k + 1]) || e[k + EDIT_TILES] || (k % EDIT_TILES < EDIT_TILES - 1 && e[k + EDIT_TILES + 1]));
        const piece = near ? floodCells(grid, k) : null;
        if (piece) this.floodTiles.set(k, piece);
        else this.floodTiles.delete(k);
      }
      this.floodPending.clear();
      const out = { pos: [] as number[], edge: [] as number[], idx: [] as number[] };
      for (const piece of this.floodTiles.values()) {
        const v0 = out.pos.length / 3;
        for (let q = 0; q < piece.pos.length / 12; q++) {
          const v = v0 + q * 4;
          out.idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        }
        for (const p of piece.pos) out.pos.push(p);
        for (const e of piece.edge) out.edge.push(e);
      }
      if (!out.idx.length) this.surfaces.setFlood(null);
      else {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
        geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(out.edge, 1));
        geo.setIndex(out.idx);
        geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
        this.surfaces.setFlood(geo);
      }
    }
    this.lastFlushMs = performance.now() - t0;
  }

  dispose(): void {
    this.off?.();
    this.texture?.dispose();
  }
}
