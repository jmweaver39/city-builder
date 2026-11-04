/** Procedural card art: road cross sections from RoadTypeDef, and decal samples. */
import type { DecalKind, LaneDef, LineStyle, PaintColor, RoadTypeDef } from '../core/types';
import { sidewalkOn, totalHalfWidth } from '../core/roadTypes';
import { PAINT_HEX } from '../core/paintStandard';

/** The one paint palette (core/paintStandard.ts), for swatches and sketches. */
export const PAINT_CSS: Record<PaintColor, string> = PAINT_HEX;

const ASPHALT = '#3c4148';
const SIDEWALK = '#a7abac';
const GRASS = '#5f8f55';
const SKY = '#4c7a4a';

function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, up: boolean, size: number): void {
  const d = up ? -1 : 1;
  ctx.beginPath();
  ctx.moveTo(x, y + d * size);
  ctx.lineTo(x - size * 0.6, y - d * size * 0.1);
  ctx.lineTo(x - size * 0.2, y - d * size * 0.1);
  ctx.lineTo(x - size * 0.2, y - d * size);
  ctx.lineTo(x + size * 0.2, y - d * size);
  ctx.lineTo(x + size * 0.2, y - d * size * 0.1);
  ctx.lineTo(x + size * 0.6, y - d * size * 0.1);
  ctx.closePath();
  ctx.fill();
}

function laneLine(ctx: CanvasRenderingContext2D, x: number, h: number, style: LineStyle, color: string): void {
  if (style === 'none') return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  const one = (px: number, dash: number[]) => {
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  };
  switch (style) {
    case 'solid':
      one(x, []);
      break;
    case 'dashed':
      one(x, [6, 5]);
      break;
    case 'dotted':
      one(x, [2, 4]);
      break;
    case 'double':
      one(x - 1.2, []);
      one(x + 1.2, []);
      break;
    case 'solidDashed':
      one(x - 1.2, []);
      one(x + 1.2, [6, 5]);
      break;
    case 'dashedSolid':
      one(x - 1.2, [6, 5]);
      one(x + 1.2, []);
      break;
  }
  ctx.setLineDash([]);
}

function laneFill(lane: LaneDef): string {
  if (lane.kind === 'bus') return '#6d3f3b';
  if (lane.kind === 'bike') return '#3f6b58';
  return ASPHALT;
}

/** Draw a road type looking down its length, in CSS pixels. */
export function drawRoadThumb(canvas: HTMLCanvasElement, def: RoadTypeDef, width: number, height: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, width, height);

  const half = totalHalfWidth(def);
  const k = Math.min((width * 0.46) / half, 6);
  const cx = width / 2;
  const X = (offset: number) => cx + offset * k;

  ctx.fillStyle = SIDEWALK;
  const walkLeft = sidewalkOn(def, -1);
  const walkRight = sidewalkOn(def, 1);
  if (walkLeft > 0) ctx.fillRect(X(-def.halfWidth - walkLeft), 0, walkLeft * k, height);
  if (walkRight > 0) ctx.fillRect(X(def.halfWidth), 0, walkRight * k, height);
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(X(-def.halfWidth), 0, def.halfWidth * 2 * k, height);

  for (const lane of def.lanes) {
    if (lane.kind === 'drive') continue;
    ctx.fillStyle = laneFill(lane);
    ctx.fillRect(X(lane.offset - lane.width / 2), 0, lane.width * k, height);
  }

  const m = def.median;
  const medianAt = m.offset ?? 0;
  if (m.kind !== 'none' && m.width > 0) {
    ctx.fillStyle = m.kind === 'grass' ? GRASS : m.kind === 'barrier' ? '#b9bcc0' : ASPHALT;
    if (m.kind === 'paint') {
      ctx.strokeStyle = PAINT_CSS.white;
      ctx.lineWidth = 1;
      ctx.strokeRect(X(medianAt - m.width / 2), -2, m.width * k, height + 4);
    } else {
      ctx.fillRect(X(medianAt - m.width / 2), 0, Math.max(1.5, m.width * k), height);
    }
  }

  const marks = def.markings;
  for (let i = 0; i + 1 < def.lanes.length; i++) {
    const a = def.lanes[i];
    const b = def.lanes[i + 1];
    const left = a.offset + a.width / 2;
    const right = b.offset - b.width / 2;
    const x = X((left + right) / 2);
    const hasMedian = m.kind !== 'none' && m.width > 0 && medianAt > left - 0.01 && medianAt < right + 0.01;
    if (hasMedian) continue;
    if (a.dir !== b.dir) {
      laneLine(ctx, x, height, marks.centerLine, PAINT_CSS[marks.centerColor]);
    } else {
      laneLine(ctx, x, height, marks.laneLine, PAINT_CSS[marks.laneColor]);
    }
  }
  laneLine(ctx, X(-def.halfWidth + 0.15), height, marks.edgeLine, PAINT_CSS[marks.edgeColor]);
  laneLine(ctx, X(def.halfWidth - 0.15), height, marks.edgeLine, PAINT_CSS[marks.edgeColor]);

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (const lane of def.lanes) {
    if (lane.kind === 'drive') {
      arrow(ctx, X(lane.offset), height / 2, lane.dir === 1, Math.max(4, lane.width * k * 0.3));
    }
  }
}

function drawLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function bentArrow(ctx: CanvasRenderingContext2D, w: number, h: number, side: -1 | 0 | 1, straight: boolean): void {
  const cx = w / 2 - side * 6;
  ctx.lineWidth = 3;
  ctx.strokeStyle = PAINT_CSS.white;
  ctx.fillStyle = PAINT_CSS.white;
  const head = (x: number, y: number, dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * 7, y + dy * 7);
    ctx.lineTo(x - dy * 5, y + dx * 5);
    ctx.lineTo(x + dy * 5, y - dx * 5);
    ctx.fill();
  };
  drawLine(ctx, cx, h - 8, cx, h / 2 - (straight ? 10 : 0));
  if (straight) head(cx, h / 2 - 10, 0, -1);
  if (side !== 0) {
    drawLine(ctx, cx, h / 2, cx + side * 12, h / 2);
    head(cx + side * 12, h / 2, side, 0);
  }
}

/** Draw a sample of a decal kind on a card. */
export function drawDecalThumb(canvas: HTMLCanvasElement, kind: DecalKind, width: number, height: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = PAINT_CSS.white;
  ctx.fillStyle = PAINT_CSS.white;
  ctx.lineWidth = 2.5;
  const w = width;
  const h = height;
  switch (kind) {
    case 'line':
      drawLine(ctx, 10, h - 10, w - 10, 10);
      break;
    case 'dashedLine':
      ctx.setLineDash([8, 6]);
      drawLine(ctx, 10, h - 10, w - 10, 10);
      ctx.setLineDash([]);
      break;
    case 'doubleLine':
      drawLine(ctx, 10, h - 15, w - 15, 10);
      drawLine(ctx, 15, h - 10, w - 10, 15);
      break;
    case 'hatch': {
      ctx.lineWidth = 1.5;
      ctx.strokeRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
      ctx.clip();
      for (let x = -h; x < w; x += 8) drawLine(ctx, x, h, x + h, 0);
      ctx.restore();
      break;
    }
    case 'fill':
      ctx.fillStyle = PAINT_CSS.red;
      ctx.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
      break;
    case 'crosswalk':
      for (let i = 0; i < 6; i++) ctx.fillRect(w * 0.14 + i * (w * 0.13), h * 0.2, w * 0.07, h * 0.6);
      break;
    case 'stopLine':
      ctx.fillRect(w * 0.14, h / 2 - 3, w * 0.72, 6);
      break;
    case 'yieldTriangles':
      for (let i = 0; i < 4; i++) {
        const x = w * 0.16 + i * (w * 0.19);
        ctx.beginPath();
        ctx.moveTo(x, h * 0.36);
        ctx.lineTo(x + 12, h * 0.36);
        ctx.lineTo(x + 6, h * 0.64);
        ctx.fill();
      }
      break;
    case 'arrowStraight':
      bentArrow(ctx, w, h, 0, true);
      break;
    case 'arrowLeft':
      bentArrow(ctx, w, h, -1, false);
      break;
    case 'arrowRight':
      bentArrow(ctx, w, h, 1, false);
      break;
    case 'arrowStraightLeft':
      bentArrow(ctx, w, h, -1, true);
      break;
    case 'arrowStraightRight':
      bentArrow(ctx, w, h, 1, true);
      break;
    case 'text':
      ctx.font = '700 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TEXT', w / 2, h / 2);
      break;
  }
}

/** A sample of a line style on a card. */
export function drawLineThumb(canvas: HTMLCanvasElement, style: LineStyle, width: number, height: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, 0);
  laneLine(ctx, 0, height, style, PAINT_CSS.white);
  ctx.restore();
}

/** SVG sample of a line style, for dropdowns. */
export function lineStyleArt(style: LineStyle, color = '#f2f4f5'): string {
  const line = (y: number, dash = '') =>
    `<line x1="2" y1="${y}" x2="46" y2="${y}" stroke="${color}" stroke-width="1.6"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  const body: Record<LineStyle, string> = {
    none: '<line x1="4" y1="12" x2="44" y2="12" stroke="#5c6b80" stroke-width="1" stroke-dasharray="1 4"/>',
    solid: line(9),
    dashed: line(9, '8 6'),
    dotted: line(9, '2 4'),
    double: line(7) + line(11),
    solidDashed: line(7) + line(11, '8 6'),
    dashedSolid: line(7, '8 6') + line(11),
  };
  return `<svg width="48" height="18" viewBox="0 0 48 18"><rect width="48" height="18" rx="3" fill="#3c4148"/>${body[style]}</svg>`;
}

export function colorArt(color: PaintColor): string {
  return `<svg width="48" height="18" viewBox="0 0 48 18"><rect width="48" height="18" rx="3" fill="#3c4148"/><rect x="4" y="7" width="40" height="4" rx="1" fill="${PAINT_CSS[color]}"/></svg>`;
}

export function crosswalkArt(style: 'none' | 'zebra' | 'ladder' | 'lines'): string {
  let body = '';
  if (style === 'zebra') for (let i = 0; i < 6; i++) body += `<rect x="${5 + i * 7}" y="3" width="4" height="12" fill="#f2f4f5"/>`;
  if (style === 'ladder') {
    body += '<rect x="4" y="3" width="40" height="1.500" fill="#f2f4f5"/><rect x="4" y="13.500" width="40" height="1.500" fill="#f2f4f5"/>';
    for (let i = 0; i < 6; i++) body += `<rect x="${5 + i * 7}" y="3" width="3" height="12" fill="#f2f4f5"/>`;
  }
  if (style === 'lines') body += '<rect x="4" y="3" width="40" height="1.500" fill="#f2f4f5"/><rect x="4" y="13.500" width="40" height="1.500" fill="#f2f4f5"/>';
  if (style === 'none') body = '<line x1="4" y1="9" x2="44" y2="9" stroke="#5c6b80" stroke-dasharray="1 4"/>';
  return `<svg width="48" height="18" viewBox="0 0 48 18"><rect width="48" height="18" rx="3" fill="#3c4148"/>${body}</svg>`;
}

const SURFACE_CSS = { asphalt: '#44494f', concrete: '#a5a7a4', darkAsphalt: '#2b2e33', red: '#8a4238', gravel: '#8d8069' } as const;

export function surfaceArt(surface: keyof typeof SURFACE_CSS): string {
  return `<svg width="48" height="18" viewBox="0 0 48 18"><rect width="48" height="18" rx="3" fill="${SURFACE_CSS[surface]}"/></svg>`;
}
