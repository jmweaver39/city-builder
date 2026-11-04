/**
 * Landscaping: Shift (left raises, right or Option lowers), Level (flatten to a
 * sampled or typed height; right click or Option+click samples again), Soften and
 * Slope (click a start and an end, then paint an even slope between them).
 * Held to apply continuously. [ and ] or Shift+wheel size the brush, Shift+[ and
 * Shift+] set its strength. Every stroke is one undo step (core/terrainEdit.ts).
 */
import { BRUSH_MAX_RADIUS, BRUSH_MIN_RADIUS, terrainEditor, type BrushOp, type BrushShape, type ClampKind } from '../core/terrainEdit';
import { isWater, MAX_ELEVATION, MIN_ELEVATION, terrainHeight, WATER_LEVEL } from '../core/terrain';
import type { Vec3 } from '../core/types';
import type { ToolMark } from '../render/api';
import { Tool } from './Tool';
import { pickGround } from './terrainFollow';
import { COLORS, type ToolId, type ToolKey, type ToolPointer } from './types';

export type TerrainMode = 'shift' | 'level' | 'soften' | 'slope';

export interface TerrainBrush {
  mode: TerrainMode;
  /** Metres. */
  radius: number;
  /** 0.05 to 1. */
  strength: number;
  shape: BrushShape;
  /** Level's target height, absolute. Null until sampled or typed. */
  target: number | null;
  /** Slope's two ends. */
  from: Vec3 | null;
  to: Vec3 | null;
  /** "Let water in": painted ground floods below the water level even if it does not reach the river. */
  letWater: boolean;
}

export const TERRAIN_MODES: readonly { value: TerrainMode; label: string; key: string; desc: string }[] = [
  { value: 'shift', label: 'Shift', key: 'Z', desc: 'Left click raises, right click or Option+click lowers' },
  { value: 'level', label: 'Level', key: 'X', desc: 'Flattens to the height sampled at the first click, or typed. Right click samples again' },
  { value: 'soften', label: 'Soften', key: 'C', desc: 'Smooths bumps and sharp edges' },
  { value: 'slope', label: 'Slope', key: 'Y', desc: 'Click a start and an end, then paint an even slope between them' },
];

const CLAMP_NOTE: Record<ClampKind, string> = {
  road: 'Held at the road: the ground slopes up or down to its edge',
  bridge: 'Held under the bridge deck: it needs clearance',
  tunnel: 'Held over the tunnel: it keeps its cover',
};

export class TerrainTool extends Tool {
  readonly id: ToolId = 'terrain';
  readonly brush: TerrainBrush = { mode: 'shift', radius: 40, strength: 0.5, shape: 'soft', target: null, from: null, to: null, letWater: false };
  /** Plan point under the cursor, on the ground. */
  private cursor: Vec3 | null = null;
  private painting: BrushOp | null = null;
  private clamped: ClampKind | null = null;
  private frame: number | null = null;
  private lastTime = 0;
  /** Brush tick cost, for the stats readout and tests. */
  readonly timing = { ticks: 0, totalMs: 0, worstMs: 0 };

  usesRightButton(): boolean {
    return true;
  }

  activate(): void {
    this.refresh();
  }

  deactivate(): void {
    this.finish();
    this.ctx.setMarks([]);
    this.ctx.setHud(null);
  }

  setMode(mode: TerrainMode): void {
    this.brush.mode = mode;
    if (mode !== 'slope') {
      this.brush.from = null;
      this.brush.to = null;
    }
    this.refresh();
    this.ctx.changed();
  }

  settingsChanged(): void {
    this.refresh();
  }

  private pick(e: ToolPointer): Vec3 | null {
    return pickGround(this.ctx, e);
  }

  private ground(p: Vec3): Vec3 {
    return { x: p.x, y: terrainHeight(p.x, p.z), z: p.z };
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.cursor = this.pick(e);
    this.refresh();
  }

  pointerDown(e: ToolPointer): void {
    this.pointer = e;
    this.cursor = this.pick(e);
    if (!this.cursor) return;
    const b = this.brush;
    const alt = e.button === 2 || e.alt;
    let op: BrushOp | null = null;
    switch (b.mode) {
      case 'shift':
        op = alt ? 'lower' : 'raise';
        break;
      case 'level':
        if (alt) {
          b.target = terrainHeight(this.cursor.x, this.cursor.z);
          this.ctx.changed();
        } else {
          if (b.target === null) b.target = terrainHeight(this.cursor.x, this.cursor.z);
          op = 'level';
        }
        break;
      case 'soften':
        if (!alt) op = 'soften';
        break;
      case 'slope':
        if (alt) {
          b.from = null;
          b.to = null;
        } else if (!b.from) b.from = this.ground(this.cursor);
        else if (!b.to) b.to = this.ground(this.cursor);
        else op = 'slope';
        this.ctx.changed();
        break;
    }
    if (op) this.start(op);
    this.refresh();
  }

  pointerUp(_e: ToolPointer): void {
    this.finish();
    this.refresh();
  }

  private start(op: BrushOp): void {
    const ed = terrainEditor();
    if (!ed) {
      this.ctx.toast('Landscaping is not available.', 'error');
      return;
    }
    this.painting = op;
    this.clamped = null;
    ed.beginStroke();
    this.tick(1 / 60);
    if (typeof requestAnimationFrame === 'function') {
      this.lastTime = performance.now();
      const loop = (t: number) => {
        if (!this.painting) return;
        const dt = Math.min(0.05, Math.max(0, (t - this.lastTime) / 1000));
        this.lastTime = t;
        this.tick(dt);
        this.frame = requestAnimationFrame(loop);
      };
      this.frame = requestAnimationFrame(loop);
    }
  }

  /** One brush application at the cursor. The animation loop calls it; tests call it directly. */
  tick(dt: number): void {
    const ed = terrainEditor();
    const op = this.painting;
    const c = this.cursor;
    if (!ed || !op || !c || dt <= 0) return;
    const b = this.brush;
    const t0 = performance.now();
    const res = ed.tick({
      op,
      x: c.x,
      z: c.z,
      radius: b.radius,
      strength: b.strength,
      dt,
      shape: b.shape,
      target: b.target ?? undefined,
      from: b.from ?? undefined,
      to: b.to ?? undefined,
      letWater: b.letWater,
    });
    const ms = performance.now() - t0;
    this.timing.ticks++;
    this.timing.totalMs += ms;
    this.timing.worstMs = Math.max(this.timing.worstMs, ms);
    if (res.clamped) this.clamped = res.clamped;
    this.refresh();
  }

  private finish(): void {
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    this.frame = null;
    const op = this.painting;
    if (!op) return;
    this.painting = null;
    const ed = terrainEditor();
    if (!ed) return;
    const label = { raise: 'Raise land', lower: 'Lower land', level: 'Level land', soften: 'Soften land', slope: 'Slope land' }[op];
    this.ctx.history.hint(label);
    ed.endStroke();
    if (this.clamped) this.ctx.toast(CLAMP_NOTE[this.clamped], 'warning');
  }

  back(): boolean {
    const b = this.brush;
    if (this.painting) {
      this.finish();
      return true;
    }
    if (b.mode === 'slope' && (b.from || b.to)) {
      b.from = null;
      b.to = null;
      this.refresh();
      this.ctx.changed();
      return true;
    }
    return false;
  }

  /** Grow or shrink the brush by steps, as [ and ] do. */
  resize(steps: number): void {
    const b = this.brush;
    b.radius = Math.round(Math.min(BRUSH_MAX_RADIUS, Math.max(BRUSH_MIN_RADIUS, b.radius * Math.pow(1.15, steps))));
    this.refresh();
    this.ctx.changed();
  }

  strengthen(steps: number): void {
    const b = this.brush;
    b.strength = Math.round(Math.min(1, Math.max(0.05, b.strength + steps * 0.05)) * 100) / 100;
    this.refresh();
    this.ctx.changed();
  }

  /** Level to a typed height. */
  setTarget(y: number | null): void {
    this.brush.target = y === null ? null : Math.min(MAX_ELEVATION, Math.max(MIN_ELEVATION, y));
    this.refresh();
    this.ctx.changed();
  }

  wheel(delta: number, e: ToolPointer): boolean {
    if (!e.shift || delta === 0) return false;
    this.resize(delta < 0 ? 1 : -1);
    return true;
  }

  keyDown(e: ToolKey): boolean {
    if (e.ctrl) return false;
    // Shift+[ arrives as '{' on most layouts, as '[' with Shift on some.
    const key = e.shift && e.key === '[' ? '{' : e.shift && e.key === ']' ? '}' : e.key;
    switch (key) {
      case '[':
        this.resize(-1);
        return true;
      case ']':
        this.resize(1);
        return true;
      case '{':
        this.strengthen(-1);
        return true;
      case '}':
        this.strengthen(1);
        return true;
      case 'Alt':
        this.refresh();
        return false;
    }
    if (e.alt || e.shift) return false;
    const mode = TERRAIN_MODES.find((m) => m.key.toLowerCase() === e.key.toLowerCase());
    if (mode) {
      this.setMode(mode.value);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  /** A circle draped over the ground. */
  private ring(c: Vec3, r: number): Vec3[] {
    const pts: Vec3[] = [];
    const n = Math.max(24, Math.min(96, Math.round(r)));
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      pts.push({ x, y: terrainHeight(x, z) + 0.35, z });
    }
    return pts;
  }

  refresh(): void {
    const e = this.pointer;
    const c = this.cursor;
    const b = this.brush;
    const marks: ToolMark[] = [];
    if (b.mode === 'slope') {
      for (const p of [b.from, b.to]) if (p) marks.push({ kind: 'point', pos: { ...p, y: p.y + 0.4 }, color: COLORS.snap, radius: 1.6 });
      if (b.from) {
        const end = b.to ?? (c ? this.ground(c) : null);
        if (end) marks.push({ kind: 'line', points: [{ ...b.from, y: b.from.y + 0.4 }, { ...end, y: end.y + 0.4 }], color: COLORS.guide, width: 0.5, dashed: !b.to });
      }
    }
    if (!c || !e) {
      this.ctx.setMarks(marks);
      this.ctx.setHud(null);
      return;
    }
    const color = this.clamped && this.painting ? COLORS.warn : COLORS.snap;
    marks.push({ kind: 'line', points: this.ring(c, b.radius), color, width: 0.6 });
    // Where the brush works at half strength, so the falloff shows.
    const half = b.shape === 'hard' ? 0.91 : 0.5;
    marks.push({ kind: 'line', points: this.ring(c, b.radius * half), color: COLORS.guide, width: 0.35, dashed: true });
    const h = terrainHeight(c.x, c.z);
    marks.push({ kind: 'point', pos: { x: c.x, y: h + 0.35, z: c.z }, color, radius: 0.8 });
    if (b.mode === 'level' && b.target !== null) marks.push({ kind: 'label', pos: { x: c.x, y: h + 2, z: c.z }, text: `Level to ${b.target.toFixed(1)} m`, color: COLORS.guide });
    this.ctx.setMarks(marks);
    const mode = TERRAIN_MODES.find((m) => m.value === b.mode)!;
    const lines = [
      `Landscaping: ${mode.label}`,
      `Brush ${b.radius} m, ${Math.round(b.strength * 100)}%, ${b.shape}`,
      `Ground ${h.toFixed(1)} m${isWater(c.x, c.z) ? ', under water' : h < WATER_LEVEL ? ', below the river, dry' : ''}`,
    ];
    if (b.mode === 'level') lines.push(b.target === null ? 'Target: first click samples it' : `Target ${b.target.toFixed(1)} m`);
    if (b.letWater) lines.push('Let water in: on');
    const notes: string[] = [];
    if (b.mode === 'slope') notes.push(!b.from ? 'Click the start of the slope' : !b.to ? 'Click the end of the slope' : 'Paint along it. Right click starts again');
    else notes.push(mode.desc);
    if (this.clamped && this.painting) notes.unshift(CLAMP_NOTE[this.clamped]);
    this.ctx.setHud({ x: e.x, y: e.y, lines, notes, tone: this.clamped && this.painting ? 'warning' : 'ok' });
  }
}
