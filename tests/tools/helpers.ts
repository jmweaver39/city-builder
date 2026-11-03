import { RoadNetwork } from '../../src/core';
import { History } from '../../src/app/History';
import { ToolManager } from '../../src/tools/ToolManager';
import type { TemplateApi, ToolPointer, ToolView } from '../../src/tools/types';
import type { RoadPreview, ToolMark } from '../../src/render/api';

/** A top-down view where client coordinates are world x and z. */
export class FakeView implements ToolView {
  previews: RoadPreview[] = [];
  marks: ToolMark[] = [];
  highlight: unknown = null;
  vehicleAt: number | null = null;
  pickPlane(x: number, y: number, planeY: number) {
    return { x, y: planeY, z: y };
  }
  pickVehicle() {
    return this.vehicleAt;
  }
  project(p: { x: number; z: number }) {
    return { x: p.x, y: p.z };
  }
  setPreview(p: RoadPreview[]) {
    this.previews = p;
  }
  setMarks(m: ToolMark[]) {
    this.marks = m;
  }
  setHighlight(h: unknown) {
    this.highlight = h;
  }
  setLaneDebug() {}
}

export interface Rig {
  net: RoadNetwork;
  view: FakeView;
  history: History;
  tools: ToolManager;
  toasts: string[];
  inspected: unknown[];
  click(x: number, z: number, opts?: Partial<ToolPointer>): void;
  hover(x: number, z: number, opts?: Partial<ToolPointer>): void;
  drag(path: [number, number][], opts?: Partial<ToolPointer>): void;
  rightClick(): void;
  key(key: string, opts?: { ctrl?: boolean; shift?: boolean }): boolean;
}

export function rig(templates: TemplateApi | null = null, net = new RoadNetwork()): Rig {
  const view = new FakeView();
  const history = new History(net);
  const toasts: string[] = [];
  const inspected: unknown[] = [];
  const tools = new ToolManager({
    net,
    sim: null,
    view,
    history,
    templates,
    toast: (m) => toasts.push(m),
    inspect: (t) => inspected.push(t),
  });
  const ptr = (x: number, y: number, opts: Partial<ToolPointer> = {}): ToolPointer => ({
    x,
    y,
    button: 0,
    shift: false,
    ctrl: false,
    alt: false,
    ...opts,
  });
  let last: ToolPointer = ptr(0, 0);
  return {
    net,
    view,
    history,
    tools,
    toasts,
    inspected,
    hover(x, z, opts) {
      last = ptr(x, z, opts);
      tools.pointerMove(last);
    },
    click(x, z, opts) {
      last = ptr(x, z, opts);
      tools.pointerMove(last);
      tools.pointerDown(last);
      tools.pointerUp(last);
    },
    drag(path, opts) {
      const [first, ...rest] = path;
      last = ptr(first[0], first[1], opts);
      tools.pointerMove(last);
      tools.pointerDown(last);
      for (const [x, z] of rest) {
        last = ptr(x, z, opts);
        tools.pointerMove(last);
      }
      tools.pointerUp(last);
    },
    rightClick() {
      const e = { ...last, button: 2 };
      tools.pointerDown(e);
      tools.pointerUp(e);
    },
    key(key, opts = {}) {
      return tools.keyDown({ key, shift: !!opts.shift, ctrl: !!opts.ctrl, alt: false });
    },
  };
}

/** Fake templates that lay one road through the placement. */
export const fakeTemplates: TemplateApi = {
  TEMPLATES: [
    {
      id: 'bar',
      name: 'Bar',
      description: 'A straight road',
      params: [{ key: 'length', label: 'Length', min: 50, max: 400, step: 10, default: 100 }],
    },
  ],
  previewTemplate(_id, params, p) {
    const dx = Math.cos(p.rotation) * params.length;
    const dz = Math.sin(p.rotation) * params.length;
    const p0 = { x: p.pos.x - dx / 2, y: p.elevation, z: p.pos.z - dz / 2 };
    const p3 = { x: p.pos.x + dx / 2, y: p.elevation, z: p.pos.z + dz / 2 };
    return [{ p0, p1: { ...p0 }, p2: { ...p3 }, p3 }];
  },
  stampTemplate(net, id, params, p) {
    const [c] = this.previewTemplate(id, params, p);
    const r = net.drawRoad({ start: { kind: 'free', pos: c.p0 }, end: { kind: 'free', pos: c.p3 }, roadType: p.roadType ?? 'street-2' });
    return { segments: r.segments, problems: [] };
  },
};
