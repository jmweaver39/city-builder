/**
 * Optional per-frame timing, for the benchmark (app/bench.ts). When a profiler is
 * attached to the renderer, each section of a frame adds its CPU milliseconds
 * under a label, and the GPU timer (when the browser has
 * EXT_disjoint_timer_query_webgl2) times the shadow, scene, post and overlay
 * phases. Nothing here runs unless a profiler is attached.
 */
import type * as THREE from 'three';

export type GpuPhase = 'shadow' | 'scene' | 'post' | 'overlay';

export class FrameProfiler {
  /** CPU milliseconds per label for the frame in progress. */
  readonly cpu = new Map<string, number>();
  private t = 0;
  /** Set by the bench; told when the GPU work of the frame moves to a new phase. */
  gpuPhase: ((phase: GpuPhase | null) => void) | null = null;

  start(): void {
    this.t = performance.now();
  }

  /** Charge the time since the last lap (or start) to a label. */
  lap(label: string): void {
    const now = performance.now();
    this.cpu.set(label, (this.cpu.get(label) ?? 0) + now - this.t);
    this.t = now;
  }

  /** Hand back this frame's times and start a fresh frame. */
  take(out: Map<string, number>): void {
    out.clear();
    for (const [k, v] of this.cpu) out.set(k, v);
    this.cpu.clear();
  }
}

interface PendingQuery {
  query: WebGLQuery;
  frame: number;
  phase: GpuPhase;
}

/** GPU time per phase through EXT_disjoint_timer_query_webgl2. Results arrive a few frames late. */
export class GpuTimer {
  readonly available: boolean;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private gl: WebGL2RenderingContext;
  private active: PendingQuery | null = null;
  private pending: PendingQuery[] = [];
  private pool: WebGLQuery[] = [];
  frame = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    this.available = !!this.ext;
  }

  /** End the running query, if any, and start one for the phase. Null just ends; undefined changes nothing. */
  switchTo(phase: GpuPhase | null | undefined): void {
    if (!this.ext || phase === undefined) return;
    const gl = this.gl;
    if (this.active) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    if (!phase) return;
    const query = this.pool.pop() ?? gl.createQuery();
    if (!query) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { query, frame: this.frame, phase };
  }

  /** Collect finished queries: calls back with frame number, phase and milliseconds. */
  poll(fn: (frame: number, phase: GpuPhase, ms: number) => void): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let keep = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
        this.pending[keep++] = p;
        continue;
      }
      const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
      if (!disjoint) fn(p.frame, p.phase, ns / 1e6);
      this.pool.push(p.query);
    }
    this.pending.length = keep;
  }
}
