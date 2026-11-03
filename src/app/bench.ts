/**
 * Repeatable performance benchmark. Open the game with `?bench=1`.
 *
 * It loads a fixed heavy scene (two street grids, the rail demo with its trains,
 * zones, thousands of vehicles), then flies a scripted camera through map, mid,
 * close, low-angle and rail views at each quality level, and prints a table of
 * per-frame CPU time (sim, trains, each render layer, render submit), GPU time per
 * phase (EXT_disjoint_timer_query_webgl2 where the browser has it), draw calls,
 * triangles and estimated texture memory. Nothing is saved: autosave is off.
 *
 * Query options (all optional):
 *   q=low,medium,high,ultra  quality levels to run, in order
 *   views=map,mid,close,low,rail
 *   dur=4        seconds recorded per view (after a short settle)
 *   runs=1       repeat the whole schedule and keep the best of each figure
 *   res=1        resolution scale, up to 2, to stand in for a bigger screen or weaker GPU
 *   speed=1      sim speed (4 = the 4x button)
 *   traffic=3    traffic multiplier for the scene
 *   night=0      1 runs at 22:00, with lamps and bloom
 *   shadows=1    0 turns sun shadows off, to price them
 *   size=1440x900  canvas size in CSS pixels (times the device pixel ratio, capped by quality)
 *
 * Results: an on-screen table, the console, and `window.__bench`.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, Vec3 } from '../core/types';
import { DEFAULT_ZONE_SETTINGS, fillBlock } from '../core/zones';
import { buildRailDemo } from '../rail/demo';
import type { CameraPose } from '../render/api';
import { FrameProfiler, GpuTimer, type GpuPhase } from '../render/profile';
import type { QualityName } from '../render/quality';
import type { Renderer } from '../render/Renderer';
import type { Simulation } from '../sim/Simulation';
import * as THREE from 'three';

export interface BenchParams {
  qualities: QualityName[];
  views: string[];
  dur: number;
  runs: number;
  res: number;
  speed: number;
  traffic: number;
  night: boolean;
  shadows: boolean;
  warmSteps: number;
  /** Canvas size in CSS pixels, fixed so runs compare whatever the window does. */
  width: number;
  height: number;
}

const ALL_Q: QualityName[] = ['low', 'medium', 'high', 'ultra'];

export function benchParams(): BenchParams | null {
  const q = new URLSearchParams(location.search);
  if (!q.has('bench')) return null;
  const list = (key: string, all: string[]) => (q.get(key)?.split(',').filter((s) => all.includes(s)) ?? all);
  const num = (key: string, d: number) => {
    const v = Number(q.get(key));
    return q.has(key) && Number.isFinite(v) ? v : d;
  };
  return {
    qualities: list('q', ALL_Q) as QualityName[],
    views: list('views', Object.keys(VIEWS)),
    dur: num('dur', 4),
    runs: Math.max(1, Math.round(num('runs', 1))),
    res: num('res', 1),
    speed: num('speed', 1),
    traffic: num('traffic', 3),
    night: q.get('night') === '1',
    shadows: q.get('shadows') !== '0',
    warmSteps: Math.round(num('warm', 2400)),
    width: Number(q.get('size')?.split('x')[0]) || 1440,
    height: Number(q.get('size')?.split('x')[1]) || 900,
  };
}

const v3 = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

/** The fixed heavy scene: the rail demo plus a big street grid each side of the river. */
export function buildBenchScene(net: RoadNetwork, traffic: number): void {
  buildRailDemo(net);
  net.batch(() => {
    net.setProjectName('Benchmark');
    const grid = (xs: number[], zs: number[], avenueRow: (j: number) => boolean, avenueCol: (i: number) => boolean, stub: number) => {
      const ids: Id[][] = [];
      for (let j = 0; j < zs.length; j++) {
        ids.push(xs.map((x) => net.addNode(v3(x, zs[j]))));
      }
      for (let j = 0; j < zs.length; j++) {
        for (let i = 0; i + 1 < xs.length; i++) net.addSegment(ids[j][i], ids[j][i + 1], { roadType: avenueRow(j) ? 'avenue-4' : 'street-2' });
      }
      for (let i = 0; i < xs.length; i++) {
        for (let j = 0; j + 1 < zs.length; j++) net.addSegment(ids[j][i], ids[j + 1][i], { roadType: avenueCol(i) ? 'avenue-4' : 'street-2' });
      }
      const gate = (from: Id, at: Vec3, name: string, type: string) => {
        const n = net.addNode(at);
        net.addSegment(from, n, { roadType: type });
        net.addEndpoint({ kind: 'gateway', name, nodeId: n, ratePerHour: 700, attraction: 1 });
      };
      for (let j = 0; j < zs.length; j++) {
        const type = avenueRow(j) ? 'avenue-4' : 'street-2';
        gate(ids[j][0], v3(xs[0] - stub, zs[j]), `W${j}`, type);
        gate(ids[j][xs.length - 1], v3(xs[xs.length - 1] + stub, zs[j]), `E${j}`, type);
      }
      for (let i = 0; i < xs.length; i++) {
        const type = avenueCol(i) ? 'avenue-4' : 'street-2';
        gate(ids[0][i], v3(xs[i], zs[0] - stub), `S${i}`, type);
        gate(ids[zs.length - 1][i], v3(xs[i], zs[zs.length - 1] + stub), `N${i}`, type);
      }
      // Homes, shops and offices along the streets, so trips cross the grid.
      const kinds = ['residential', 'commercial', 'office'] as const;
      let k = 0;
      for (let j = 0; j < zs.length; j += 2) {
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const hit = net.nearestSegment(v3((xs[i] + xs[i + 1]) / 2, zs[j]), 20);
          if (hit) net.addEndpoint({ kind: kinds[k % 3], name: `Z${k}`, segmentId: hit.segmentId, t: hit.t, side: 1, ratePerHour: 260, attraction: 2 });
          k++;
        }
      }
    };
    const range = (a: number, b: number, step: number) => {
      const out: number[] = [];
      for (let x = a; x <= b + 1e-6; x += step) out.push(x);
      return out;
    };
    // North of the river: 17 by 6.
    grid(range(-1800, 1800, 225), range(900, 1800, 180), (j) => j % 2 === 0, (i) => i % 4 === 0, 120);
    // South, between the river and the main line: 11 by 5.
    grid(range(-300, 1700, 200), range(-450, -10, 110), (j) => j === 2, (i) => i % 3 === 0, 60);
    net.setTraffic({ multiplier: traffic });
  });
  // Zoned blocks in the north grid, for the zone layer.
  const kinds = ['residential', 'commercial', 'industrial', 'office'] as const;
  let n = 0;
  for (const x of [-1687, -1012, -337, 337, 1012, 1687]) {
    for (const z of [990, 1350, 1710]) {
      const shape = fillBlock(net, v3(x, z), DEFAULT_ZONE_SETTINGS);
      if ('error' in shape) continue;
      net.addZone({ kind: kinds[n % 4], density: 'medium', enabled: true, name: `Block ${n}`, polygon: shape.polygon, anchors: shape.anchors, source: 'block', settings: { ...DEFAULT_ZONE_SETTINGS } });
      n++;
    }
  }
}

type View = (t: number) => CameraPose;

/** Camera paths, t from 0 to 1 over the recorded seconds. */
const VIEWS: Record<string, View> = {
  // Whole map from high up.
  map: (t) => ({ target: v3(0, 300), distance: 3600, yaw: 0.3 + t * 0.5, pitch: 1.15 }),
  // A district: panning along the north grid.
  mid: (t) => ({ target: v3(-700 + t * 1400, 1300), distance: 750, yaw: 0.5, pitch: 0.8 }),
  // Street level from above: orbiting a busy junction.
  close: (t) => ({ target: v3(0, 1260), distance: 120, yaw: 0.4 + t * 1.6, pitch: 0.62 }),
  // Low angle looking out over the woods past the grid edge: worst case for foliage.
  low: (t) => ({ target: v3(1800, 1350 + t * 200), distance: 55, yaw: -1.2 - t * 0.7, pitch: 0.14 }),
  // Trains at Central, with the level crossing street in view.
  rail: (t) => ({ target: v3(-200 + t * 500, -680), distance: 300, yaw: 0.35, pitch: 0.55 }),
};

interface FrameRec {
  frame: number;
  wall: number;
  cpu: Record<string, number>;
  cpuTotal: number;
  gpu: Partial<Record<GpuPhase, number>>;
  calls: number;
  tris: number;
}

interface Cell {
  quality: QualityName;
  view: string;
  frames: FrameRec[];
  vehicles: number;
  pixels: string;
  texMB: number;
}

export interface BenchSummaryRow {
  quality: QualityName;
  view: string;
  frameMs: number;
  frameP95: number;
  cpuMs: number;
  gpuMs: number | null;
  gpu: Partial<Record<GpuPhase, number>>;
  cpu: Record<string, number>;
  calls: number;
  tris: number;
  vehicles: number;
  pixels: string;
  texMB: number;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pct = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

/** Rough bytes held by textures and render targets in use. */
function textureMemoryMB(renderer: Renderer): number {
  const seen = new Set<THREE.Texture>();
  const add = (t: unknown) => {
    if (t && (t as THREE.Texture).isTexture) seen.add(t as THREE.Texture);
  };
  const visitMat = (m: THREE.Material) => {
    for (const val of Object.values(m)) add(val);
    const u = (m as THREE.ShaderMaterial).uniforms;
    if (u) for (const val of Object.values(u)) add(val?.value);
  };
  const ctx = renderer.context;
  ctx.scene.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach(visitMat);
    else if (mat) visitMat(mat);
  });
  for (const val of Object.values(ctx.shared)) add((val as { value?: unknown })?.value);
  let bytes = 0;
  for (const t of seen) {
    const img = t.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    const bpp = t.type === THREE.FloatType ? 16 : t.type === THREE.HalfFloatType ? 8 : t.format === THREE.RedFormat ? 1 : 4;
    bytes += w * h * bpp * (t.generateMipmaps && t.minFilter !== THREE.LinearFilter && t.minFilter !== THREE.NearestFilter ? 1.333 : 1);
  }
  // Render targets: the HDR scene target (MSAA renderbuffer plus resolve), AO, bloom and the shadow map.
  const size = ctx.gl.getDrawingBufferSize(new THREE.Vector2());
  const q = ctx.quality;
  const px = size.x * size.y;
  if (q.post) {
    bytes += px * (8 + 4); // resolved colour and depth
    if (q.msaa) bytes += px * (8 + 4) * q.msaa;
    if (q.ao) bytes += px * q.ao * q.ao * 4 * 2;
    if (q.bloom) bytes += px * 8 * 2 * (1 / 4) * 1.33;
  }
  const sun = ctx.scene.children.find((c) => (c as THREE.DirectionalLight).isDirectionalLight) as THREE.DirectionalLight | undefined;
  if (sun?.castShadow) bytes += sun.shadow.mapSize.x * sun.shadow.mapSize.y * 4 * 2;
  return bytes / (1024 * 1024);
}

export interface BenchApp {
  sim: Simulation;
  renderer: Renderer;
}

export class BenchRunner {
  private profiler = new FrameProfiler();
  private gpu: GpuTimer;
  private schedule: { quality: QualityName; view: string | null; settle: number; dur: number; run: number }[] = [];
  private step = -1;
  private stepTime = 0;
  private frameNo = 0;
  private cells = new Map<string, Cell[]>();
  private current: Cell | null = null;
  private byFrame = new Map<number, FrameRec>();
  private cpuScratch = new Map<string, number>();
  private box: HTMLPreElement;
  done = false;

  constructor(
    private readonly app: BenchApp,
    private readonly params: BenchParams,
  ) {
    const r = app.renderer;
    this.gpu = new GpuTimer(r.context.gl);
    r.profiler = this.profiler;
    this.profiler.gpuPhase = (p) => this.gpu.switchTo(p);
    // Splits the shadow pass from the main pass: the first thing drawn after shadows.
    const marker = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    marker.frustumCulled = false;
    marker.renderOrder = -1e9;
    marker.onBeforeRender = () => this.gpu.switchTo('scene');
    r.context.scene.add(marker);
    app.sim.speed = params.speed;
    r.setTimeOfDay(params.night ? 22 : 11);
    r.setShadows(params.shadows);
    if (params.res !== 1) r.setResolutionScale(params.res);
    for (let run = 0; run < params.runs; run++) {
      for (const quality of params.qualities) {
        this.schedule.push({ quality, view: null, settle: 1.5, dur: 0, run });
        for (const view of params.views) this.schedule.push({ quality, view, settle: 0.8, dur: params.dur, run });
      }
    }
    this.box = document.createElement('pre');
    this.box.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:99999;margin:0;padding:8px 10px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;' +
      'background:rgba(8,14,26,0.86);color:#cfe6ff;font:11px/1.35 ui-monospace,Menlo,monospace;border-radius:6px;pointer-events:auto;white-space:pre';
    document.body.append(this.box);
    this.box.textContent = `Benchmark: ${this.schedule.length} steps. GPU timer: ${this.gpu.available ? 'yes' : 'not available'}.`;
    (window as unknown as { __bench: unknown }).__bench = { done: false };
  }

  /** Before the frame: move the camera along the path. */
  beforeFrame(dt: number): void {
    if (this.done) return;
    this.gpu.frame = this.frameNo;
    this.stepTime += dt;
    let s = this.schedule[this.step];
    if (!s || this.stepTime >= s.settle + s.dur) {
      this.step++;
      this.stepTime = 0;
      s = this.schedule[this.step];
      if (!s) {
        this.finish();
        return;
      }
      if (this.app.renderer.getQuality() !== s.quality || !s.view) this.app.renderer.setQuality(s.quality);
      this.current = null;
      if (s.view) {
        const cell: Cell = { quality: s.quality, view: s.view, frames: [], vehicles: 0, pixels: '', texMB: 0 };
        const key = `${s.quality}/${s.view}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key)!.push(cell);
        this.current = cell;
      }
      this.box.textContent = `Benchmark run ${s.run + 1}/${this.params.runs}: ${s.quality} ${s.view ?? '(settling)'} — step ${this.step + 1}/${this.schedule.length}`;
    }
    if (s.view) {
      const t = Math.max(0, this.stepTime - s.settle) / Math.max(s.dur, 1e-3);
      this.app.renderer.setCamera(VIEWS[s.view](Math.min(1, t)), false);
    }
  }

  /** After the frame: file this frame's numbers. */
  afterFrame(wallMs: number): void {
    if (this.done) return;
    this.profiler.take(this.cpuScratch);
    this.gpu.poll((frame, phase, ms) => {
      const rec = this.byFrame.get(frame);
      if (rec) rec.gpu[phase] = (rec.gpu[phase] ?? 0) + ms;
    });
    const s = this.schedule[this.step];
    const cell = this.current;
    const no = this.frameNo++;
    if (!s || !cell || this.stepTime < s.settle) return;
    const cpu: Record<string, number> = {};
    let total = 0;
    for (const [k, val] of this.cpuScratch) {
      cpu[k] = val;
      total += val;
    }
    const stats = this.app.renderer.stats();
    const rec: FrameRec = { frame: no, wall: wallMs, cpu, cpuTotal: total, gpu: {}, calls: stats.drawCalls, tris: stats.triangles };
    cell.frames.push(rec);
    this.byFrame.set(no, rec);
    if (!cell.pixels) {
      const size = this.app.renderer.context.gl.getDrawingBufferSize(new THREE.Vector2());
      cell.pixels = `${size.x}x${size.y}`;
      cell.texMB = textureMemoryMB(this.app.renderer);
    }
    cell.vehicles = this.app.sim.vehicles.count;
  }

  private summarise(cell: Cell): BenchSummaryRow {
    const f = cell.frames;
    const gpuFrames = f.filter((r) => r.gpu.shadow !== undefined && r.gpu.overlay !== undefined);
    const gpu: Partial<Record<GpuPhase, number>> = {};
    for (const p of ['shadow', 'scene', 'post', 'overlay'] as GpuPhase[]) {
      const vals = gpuFrames.map((r) => r.gpu[p] ?? 0);
      if (vals.length) gpu[p] = median(vals);
    }
    const cpu: Record<string, number> = {};
    const keys = new Set<string>();
    for (const r of f) for (const k of Object.keys(r.cpu)) keys.add(k);
    for (const k of keys) cpu[k] = mean(f.map((r) => r.cpu[k] ?? 0));
    return {
      quality: cell.quality,
      view: cell.view,
      frameMs: median(f.map((r) => r.wall)),
      frameP95: pct(f.map((r) => r.wall), 0.95),
      cpuMs: median(f.map((r) => r.cpuTotal)),
      gpuMs: gpuFrames.length ? median(gpuFrames.map((r) => (r.gpu.shadow ?? 0) + (r.gpu.scene ?? 0) + (r.gpu.post ?? 0) + (r.gpu.overlay ?? 0))) : null,
      gpu,
      cpu,
      calls: Math.round(mean(f.map((r) => r.calls))),
      tris: Math.round(mean(f.map((r) => r.tris))),
      vehicles: cell.vehicles,
      pixels: cell.pixels,
      texMB: cell.texMB,
    };
  }

  /** Best of the runs, figure by figure, since other tabs share the GPU. */
  private best(rows: BenchSummaryRow[]): BenchSummaryRow {
    const minOf = (get: (r: BenchSummaryRow) => number | null) => {
      const vals = rows.map(get).filter((x): x is number => x !== null && Number.isFinite(x));
      return vals.length ? Math.min(...vals) : null;
    };
    const byGpu = [...rows].sort((a, b) => (a.gpuMs ?? 1e9) - (b.gpuMs ?? 1e9))[0];
    const byCpu = [...rows].sort((a, b) => a.cpuMs - b.cpuMs)[0];
    return {
      ...rows[0],
      frameMs: minOf((r) => r.frameMs)!,
      frameP95: minOf((r) => r.frameP95)!,
      cpuMs: byCpu.cpuMs,
      cpu: byCpu.cpu,
      gpuMs: byGpu.gpuMs,
      gpu: byGpu.gpu,
      calls: minOf((r) => r.calls)!,
      tris: minOf((r) => r.tris)!,
    };
  }

  private finish(): void {
    this.done = true;
    const r = this.app.renderer;
    r.profiler = null;
    const rows: BenchSummaryRow[] = [];
    for (const list of this.cells.values()) rows.push(this.best(list.map((c) => this.summarise(c))));
    const f1 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '  -  ' : x.toFixed(1).padStart(5));
    const f2 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? '  -  ' : x.toFixed(2).padStart(5));
    const lines: string[] = [];
    const p = this.params;
    lines.push(`Cloverleaf benchmark — ${navigator.userAgent.match(/Chrome\/[\d.]+|Firefox\/[\d.]+|Version\/[\d.]+ Safari/)?.[0] ?? ''}, dpr ${window.devicePixelRatio}, res ${p.res}, speed ${p.speed}x, runs ${p.runs} (best of), ${p.night ? 'night' : 'day'}${p.shadows ? '' : ', shadows off'}`);
    lines.push(`GPU timer ${this.gpu.available ? 'on' : 'unavailable'}. Times in ms; frame = median wall time (vsync-capped), cpu = median JS per frame, gpu = median GPU per frame.`);
    lines.push('');
    lines.push('quality view    pixels      frame  p95   cpu   gpu  | shadow scene  post  ovl | calls   ktris  veh   texMB');
    for (const row of rows) {
      lines.push(
        `${row.quality.padEnd(7)} ${row.view.padEnd(6)} ${row.pixels.padEnd(10)} ${f1(row.frameMs)} ${f1(row.frameP95)} ${f1(row.cpuMs)} ${f1(row.gpuMs)} | ${f2(row.gpu.shadow)} ${f2(row.gpu.scene)} ${f2(row.gpu.post)} ${f2(row.gpu.overlay)} | ${String(row.calls).padStart(5)} ${String(Math.round(row.tris / 1000)).padStart(6)} ${String(row.vehicles).padStart(5)} ${row.texMB.toFixed(0).padStart(6)}`,
      );
    }
    lines.push('');
    lines.push('CPU per frame by section (mean ms):');
    const labels = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row.cpu)) labels.add(k);
    const order = [...labels].sort();
    lines.push(`${'quality/view'.padEnd(14)} ${order.map((l) => l.replace(/^L\./, '').slice(0, 11).padStart(11)).join(' ')}`);
    for (const row of rows) lines.push(`${`${row.quality}/${row.view}`.padEnd(14)} ${order.map((l) => f2(row.cpu[l]).padStart(11)).join(' ')}`);
    const text = lines.join('\n');
    this.box.textContent = text;
    console.log(text);
    (window as unknown as { __bench: unknown }).__bench = { done: true, text, rows, params: p };
  }
}

/**
 * A 60 Hz clock from a worker: post it the frame's duration when the frame is
 * done, and it calls back when the next frame is due. Worker timers are not
 * throttled in a hidden page the way requestAnimationFrame is.
 */
export function benchPacer(tick: (now: number) => void): Worker {
  // The message is how long the frame took; the clocks of page and worker differ.
  const src = `onmessage = (e) => { setTimeout(() => postMessage(0), Math.max(0, 1000 / 60 - e.data)); };`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = () => tick(performance.now());
  return worker;
}
