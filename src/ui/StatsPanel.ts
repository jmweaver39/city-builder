/**
 * Live graphs from sim.history(). Throughput and flow have different units, so
 * each has its own chart and axis. Hovering shows the value under the cursor.
 */
import type { UiContext } from './context';
import { el, hiDpiCanvas } from './dom';
import { Panel } from './Panel';

const WIDTH = 300;
const HEIGHT = 92;
const LINE = '#3fcfc6';
const GRID = 'rgba(188, 202, 218, 0.14)';
const AXIS_INK = '#93a8bf';

type HistoryPoint = { time: number; throughput: number; flow: number; active: number };

class Chart {
  readonly root: HTMLElement;
  private readonly canvas = hiDpiCanvas(WIDTH, HEIGHT);
  private readonly tip = el('div', { class: 'chart-tip' });
  private readonly current = el('span');
  private data: HistoryPoint[] = [];
  private hoverX: number | null = null;

  constructor(
    title: string,
    private readonly value: (p: HistoryPoint) => number,
    private readonly format: (v: number) => string,
    private readonly fixedMax: number | null,
  ) {
    this.root = el(
      'div',
      {},
      el('div', { class: 'chart-title' }, title, this.current),
      el('div', { class: 'chart-wrap' }, this.canvas, this.tip),
    );
    this.canvas.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tip.style.display = 'none';
      this.draw();
    });
  }

  update(data: HistoryPoint[]): void {
    this.data = data;
    const last = data[data.length - 1];
    this.current.textContent = last ? this.format(this.value(last)) : '';
    this.draw();
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const pad = { left: 40, right: 6, top: 6, bottom: 16 };
    const w = WIDTH - pad.left - pad.right;
    const h = HEIGHT - pad.top - pad.bottom;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const values = this.data.map(this.value);
    const peak = this.fixedMax ?? niceMax(Math.max(10, ...values));
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = AXIS_INK;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const k of [0, 0.5, 1]) {
      const y = pad.top + h * (1 - k);
      ctx.beginPath();
      ctx.moveTo(pad.left, y + 0.5);
      ctx.lineTo(pad.left + w, y + 0.5);
      ctx.stroke();
      ctx.fillText(this.format(peak * k), pad.left - 5, y);
    }
    const n = this.data.length;
    if (n === 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = AXIS_INK;
      ctx.fillText('Collecting the first samples', pad.left + w / 2, pad.top + h / 2);
      return;
    }
    const t0 = this.data[0].time;
    const t1 = this.data[n - 1].time;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(minutes(t0), pad.left, HEIGHT - 3);
    ctx.textAlign = 'right';
    ctx.fillText(minutes(t1), pad.left + w, HEIGHT - 3);
    const X = (t: number) => pad.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : w);
    const Y = (v: number) => pad.top + h * (1 - Math.min(v / peak, 1));
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    this.data.forEach((p, i) => (i ? ctx.lineTo(X(p.time), Y(this.value(p))) : ctx.moveTo(X(p.time), Y(this.value(p)))));
    ctx.stroke();

    if (this.hoverX === null) return;
    let best = this.data[0];
    for (const p of this.data) if (Math.abs(X(p.time) - this.hoverX) < Math.abs(X(best.time) - this.hoverX)) best = p;
    const hx = X(best.time);
    ctx.strokeStyle = 'rgba(238, 244, 250, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, pad.top);
    ctx.lineTo(hx + 0.5, pad.top + h);
    ctx.stroke();
    ctx.fillStyle = LINE;
    ctx.strokeStyle = '#21324a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, Y(this.value(best)), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    this.tip.textContent = `${minutes(best.time)}: ${this.format(this.value(best))}`;
    this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(WIDTH - this.tip.offsetWidth - 2, Math.max(pad.left, hx - this.tip.offsetWidth / 2))}px`;
  }
}

function niceMax(v: number): number {
  const mag = 10 ** Math.floor(Math.log10(v));
  const r = v / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
}

function minutes(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class StatsPanel {
  private panel: Panel | null = null;
  private charts: Chart[] = [];
  private note = el('div', { class: 'small muted' });

  constructor(private readonly ui: UiContext) {}

  toggle(): void {
    if (this.panel) {
      this.panel.close();
      return;
    }
    const panel = new Panel(this.ui.host, 'Traffic statistics', { wide: true, left: 64, top: 72 });
    panel.onClose = () => {
      this.panel = null;
      this.charts = [];
    };
    this.charts = [
      new Chart('Throughput per hour', (p) => p.throughput, (v) => Math.round(v).toLocaleString(), null),
      new Chart('Flow', (p) => p.flow * 100, (v) => `${Math.round(v)}%`, 100),
      new Chart('Active vehicles', (p) => p.active, (v) => Math.round(v).toLocaleString(), null),
    ];
    panel.body.append(...this.charts.map((c) => c.root), this.note);
    this.panel = panel;
    this.tick();
  }

  tick(): void {
    if (!this.panel) return;
    const { sim } = this.ui;
    const data = [...sim.history()];
    for (const c of this.charts) c.update(data);
    const s = sim.stats();
    this.note.textContent = `Spawned ${s.spawnedTotal.toLocaleString()}, arrived ${s.arrivedTotal.toLocaleString()}, removed stuck ${s.despawnedStuck.toLocaleString()}. Mean trip ${Math.round(s.meanTripSec)} s.`;
    const peds = this.ui.peds;
    if (peds) this.note.textContent += ` Pedestrians in view ${peds.count.toLocaleString()}, crossings ${peds.counts.crossed.toLocaleString()}, times traffic held ${peds.counts.held.toLocaleString()}.`;
  }
}
