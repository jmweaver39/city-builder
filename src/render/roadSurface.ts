/**
 * Road surface textures on the GPU, at the size the road detail level asks for.
 * Generation runs in a worker (roadTexWorker.ts), or a few milliseconds a frame
 * on the main thread where workers are unavailable. Until a texture arrives the
 * nearest size already made stands in, so switching level never shows a blank road.
 */
import * as THREE from 'three';
import { createRoadTextureJob, type RoadTexKind, type RoadTextureJob } from './roadTextures';
import { ROAD_DETAIL, type RoadDetailName } from './roadDetail';

/** One road everywhere: the seed is fixed, so the same stones come back every session. */
export const ROAD_TEX_SEED = 7;

/** Main-thread budget per frame when there is no worker. */
const FALLBACK_MS = 4;

interface Request {
  kind: RoadTexKind;
  size: number;
  id: number;
  started: number;
}

export interface RoadSurfaceStats {
  level: RoadDetailName;
  /** Sizes bound now (0 while a placeholder stands in). */
  asphalt: number;
  concrete: number;
  /** GPU bytes held by every road texture, mipmaps included. */
  bytes: number;
  /** Textures still being generated. */
  pending: number;
  /** Generation milliseconds by 'kind-size'. */
  timings: Record<string, number>;
}

const key = (kind: RoadTexKind, size: number) => `${kind}-${size}`;

function placeholder(): THREE.DataTexture {
  const d = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 128;
    d[i + 3] = 230;
  }
  const t = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export class RoadSurfaces {
  readonly uAsphalt: { value: THREE.Texture };
  readonly uConcrete: { value: THREE.Texture };
  private level: RoadDetailName | null = null;
  private readonly blank = placeholder();
  private readonly made = new Map<string, THREE.DataTexture>();
  private readonly requested = new Map<string, Request>();
  private readonly timings: Record<string, number> = {};
  private worker: Worker | null = null;
  private workerTried = false;
  private nextId = 1;
  private fallback: { job: RoadTextureJob; req: Request }[] = [];
  private disposed = false;
  /** Called when a texture arrives and is bound, so a cached shadow or frame can refresh. */
  onUpdate: () => void = () => {};

  constructor(private readonly maxAnisotropy: number) {
    this.uAsphalt = { value: this.blank };
    this.uConcrete = { value: this.blank };
  }

  get current(): RoadDetailName | null {
    return this.level;
  }

  /** Bind the textures for a level, generating what is missing. */
  setLevel(level: RoadDetailName): void {
    this.level = level;
    const spec = ROAD_DETAIL[level];
    // Stand-ins for both kinds are queued before any full size, smallest first, so
    // concrete never waits on a blank placeholder behind a 4096 asphalt.
    const full: { kind: RoadTexKind; size: number }[] = [];
    this.want('asphalt', spec.asphalt, full);
    // Low draws concrete from the asphalt texture: nothing to make.
    if (spec.concrete) this.want('concrete', spec.concrete, full);
    else this.uConcrete.value = this.blank;
    full.sort((a, b) => a.size - b.size).forEach((r) => this.request(r.kind, r.size));
    this.prune();
  }

  private want(kind: RoadTexKind, size: number, full: { kind: RoadTexKind; size: number }[]): void {
    const uniform = kind === 'asphalt' ? this.uAsphalt : this.uConcrete;
    const have = this.made.get(key(kind, size));
    if (have) {
      uniform.value = have;
      return;
    }
    // Stand in with the closest size already made, else keep what is bound.
    let best: THREE.DataTexture | null = null;
    let bestGap = Infinity;
    for (const [k, t] of this.made) {
      if (!k.startsWith(kind)) continue;
      const gap = Math.abs(Math.log2(t.image.width / size));
      if (gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    if (best) uniform.value = best;
    // Nothing to stand in yet (first load): make a small one first, in a fraction of the time.
    else if (size > 512) this.request(kind, kind === 'asphalt' ? ROAD_DETAIL.low.asphalt : 512);
    full.push({ kind, size });
  }

  private request(kind: RoadTexKind, size: number): void {
    const k = key(kind, size);
    if (this.requested.has(k)) return;
    const req: Request = { kind, size, id: this.nextId++, started: performance.now() };
    this.requested.set(k, req);
    const worker = this.getWorker();
    if (worker) worker.postMessage({ id: req.id, kind, size, seed: ROAD_TEX_SEED });
    else this.fallback.push({ job: createRoadTextureJob(kind, size, ROAD_TEX_SEED), req });
  }

  private getWorker(): Worker | null {
    if (this.workerTried) return this.worker;
    this.workerTried = true;
    if (typeof Worker === 'undefined') return null;
    try {
      const w = new Worker(new URL('./roadTexWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; data: Uint8Array; ms: number }>) => {
        const req = [...this.requested.values()].find((r) => r.id === e.data.id);
        if (req) this.arrive(req, e.data.data, e.data.ms);
      };
      w.onerror = (e) => {
        // A worker that cannot load: make everything on the main thread instead.
        console.warn('Cloverleaf: road texture worker failed, generating on the main thread.', e.message);
        e.preventDefault();
        w.terminate();
        this.worker = null;
        for (const req of this.requested.values()) {
          if (!this.fallback.some((f) => f.req === req)) this.fallback.push({ job: createRoadTextureJob(req.kind, req.size, ROAD_TEX_SEED), req });
        }
      };
      this.worker = w;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /** Main-thread generation, a slice a frame, when there is no worker. */
  update(): void {
    const f = this.fallback[0];
    if (!f) return;
    if (f.job.step(FALLBACK_MS)) {
      this.fallback.shift();
      this.arrive(f.req, f.job.data, performance.now() - f.req.started);
    }
  }

  private arrive(req: Request, data: Uint8Array, ms: number): void {
    const k = key(req.kind, req.size);
    if (this.requested.get(k) !== req) return;
    this.requested.delete(k);
    if (this.disposed) return;
    this.timings[k] = Math.round(ms);
    const n = req.size;
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.name = `road-${k}`;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    const spec = this.level ? ROAD_DETAIL[this.level] : ROAD_DETAIL.medium;
    tex.anisotropy = Math.max(1, Math.min(spec.anisotropy, this.maxAnisotropy));
    // Large textures drop their CPU copy once uploaded; a lost context regenerates them.
    if (n >= 2048) {
      tex.onUpdate = () => {
        (tex.image as { data: Uint8Array | null }).data = null;
      };
    }
    tex.needsUpdate = true;
    this.made.set(k, tex);
    if (this.level) {
      const s = ROAD_DETAIL[this.level];
      const uniform = req.kind === 'asphalt' ? this.uAsphalt : this.uConcrete;
      const want = req.kind === 'asphalt' ? s.asphalt : s.concrete;
      // The wanted size, or a stand-in while the placeholder is all there is.
      if (want === n || (want > 0 && uniform.value === this.blank)) uniform.value = tex;
    }
    this.prune();
    this.onUpdate();
  }

  /** Free textures nothing binds, keeping the small asphalt for an instant drop to Low. */
  private prune(): void {
    for (const [k, t] of this.made) {
      if (t === this.uAsphalt.value || t === this.uConcrete.value) continue;
      if (k === key('asphalt', ROAD_DETAIL.low.asphalt)) continue;
      // Keep stand-ins while their replacement is still on its way.
      if (this.requested.size && [...this.requested.values()].some((r) => k.startsWith(r.kind))) continue;
      t.dispose();
      this.made.delete(k);
    }
  }

  /** After a lost WebGL context: textures without a CPU copy are made again. */
  restore(): void {
    for (const [k, t] of this.made) {
      if ((t.image as { data: Uint8Array | null }).data) t.needsUpdate = true;
      else {
        t.dispose();
        this.made.delete(k);
      }
    }
    this.uAsphalt.value = this.blank;
    this.uConcrete.value = this.blank;
    this.blank.needsUpdate = true;
    if (this.level) this.setLevel(this.level);
  }

  stats(): RoadSurfaceStats {
    let bytes = 0;
    for (const t of this.made.values()) bytes += Math.round((t.image.width * t.image.height * 4 * 4) / 3);
    const size = (t: THREE.Texture) => (t === this.blank ? 0 : (t.image as { width: number }).width);
    return {
      level: this.level ?? 'low',
      asphalt: size(this.uAsphalt.value),
      concrete: size(this.uConcrete.value),
      bytes,
      pending: this.requested.size,
      timings: { ...this.timings },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const t of this.made.values()) t.dispose();
    this.made.clear();
    this.blank.dispose();
  }
}
