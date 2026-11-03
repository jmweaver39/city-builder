/**
 * Render sandbox. Builds a sample town through the real RoadNetwork and drives
 * it with FakeSim. Open /render-sandbox.html. Query options: n (vehicle count),
 * stress=1 (adds a street grid to reach 500 segments), hours (time of day).
 */
import { RoadNetwork, type RoadAnchor } from '../core/RoadNetwork';
import type { Id, Vec3 } from '../core/types';
import { FakeSim } from './fakeSim';
import { Renderer } from './Renderer';
import type { CameraPose, OverlayMode, RoadPreview, ToolMark } from './api';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const free = (pos: Vec3): RoadAnchor => ({ kind: 'free', pos });
const at = (id: Id): RoadAnchor => ({ kind: 'node', id });

function buildTown(net: RoadNetwork): void {
  // Main 4-way: avenue north to south, 4-lane street east to west. Long enough to signal.
  const av = net.drawRoad({ start: free(v(0, 0, -240)), end: free(v(0, 0, 200)), roadType: 'avenue-4' });
  net.drawRoad({ start: free(v(-420, 0, -40)), end: free(v(0, 0, -40)), roadType: 'street-4' });
  net.drawRoad({
    start: { kind: 'segment', id: av.segments[0], t: 200 / 440 },
    end: free(v(460, 0, 30)),
    c1: v(120, 0, -40),
    c2: v(300, 0, 40),
    roadType: 'street-4',
  });

  // Curved side streets and a T with a stop sign.
  const side = net.drawRoad({
    start: { kind: 'segment', id: net.nearestSegment(v(-220, 0, -40), 5)!.segmentId, t: 0.5 },
    end: free(v(-310, 0, 190)),
    c1: v(-210, 0, 40),
    c2: v(-240, 0, 130),
    roadType: 'street-2',
  });
  const sideNode = side.nodes[0];
  net.setJunctionControl(sideNode, { mode: 'priority' });
  net.setSign(sideNode, side.segments[0], 'stop');
  const loop = net.drawRoad({
    start: free(v(-120, 0, 200)),
    end: { kind: 'segment', id: side.segments[0], t: 0.6 },
    c1: v(-150, 0, 170),
    c2: v(-180, 0, 110),
    roadType: 'street-2-oneway',
  });
  const yieldNode = loop.nodes[loop.nodes.length - 1];
  net.setJunctionControl(yieldNode, { mode: 'priority' });
  net.setSign(yieldNode, loop.segments[loop.segments.length - 1], 'yield');
  net.drawRoad({
    start: { kind: 'segment', id: net.nearestSegment(v(0, 0, 120), 5)!.segmentId, t: 0.5 },
    end: free(v(240, 0, 210)),
    c1: v(80, 0, 120),
    c2: v(180, 0, 150),
    roadType: 'street-2-bike',
  });

  // Painted edits, to exercise overrides.
  const seg = net.drawRoad({ start: free(v(-420, 0, 200)), end: free(v(-420, 0, 330)), roadType: 'street-2' }).segments[0];
  net.setSegmentOverrides(seg, { surface: 'red', markings: { centerLine: 'solidDashed', centerColor: 'white', crosswalk: 'ladder' } });
  const seg2 = net.drawRoad({ start: free(v(-340, 0, 200)), end: free(v(-340, 0, 330)), roadType: 'street-2' }).segments[0];
  net.setSegmentOverrides(seg2, { surface: 'darkAsphalt', markings: { centerLine: 'dotted', centerColor: 'blue', edgeLine: 'solid', edgeColor: 'red' } });
  const seg3 = net.drawRoad({ start: free(v(-260, 0, 240)), end: free(v(-260, 0, 340)), roadType: 'street-4' }).segments[0];
  net.setSegmentOverrides(seg3, {
    surface: 'concrete',
    markings: { laneLine: 'double', laneColor: 'yellow', centerLine: 'dashedSolid', boundaries: { 0: { style: 'dashed', color: 'green' } } },
  });

  // 8-lane boulevard crossing a 6-lane avenue.
  net.drawRoad({ start: free(v(-1000, 0, -300)), end: free(v(-1000, 0, 260)), roadType: 'avenue-6' });
  const blvd = net.drawRoad({ start: free(v(-1500, 0, -40)), end: free(v(-520, 0, -40)), roadType: 'boulevard-8' });
  const blvdEnd = blvd.nodes[blvd.nodes.length - 1];
  net.drawRoad({ start: at(blvdEnd), end: free(v(-420, 0, -120)), c1: v(-480, 0, -40), c2: v(-430, 0, -80), roadType: 'avenue-4' });

  // Highway on a viaduct, both directions, passing over the avenue.
  const hwyZ = -320;
  const hwyW = net.drawRoad({
    start: free(v(-1400, 0, hwyZ)),
    end: free(v(-500, 8, hwyZ)),
    c1: v(-1100, 0, hwyZ),
    c2: v(-800, 8, hwyZ),
    roadType: 'highway-3',
  });
  const elevEast = net.drawRoad({ start: at(hwyW.nodes[1]), end: free(v(500, 8, hwyZ)), c1: v(-200, 8, hwyZ), c2: v(200, 8, hwyZ), roadType: 'highway-3' });
  net.drawRoad({
    start: at(elevEast.nodes[1]),
    end: free(v(1400, 0, hwyZ)),
    c1: v(800, 8, hwyZ),
    c2: v(1100, 0, hwyZ),
    roadType: 'highway-3',
  });
  const backE = net.drawRoad({
    start: free(v(1400, 0, hwyZ - 34)),
    end: free(v(500, 8, hwyZ - 34)),
    c1: v(1100, 0, hwyZ - 34),
    c2: v(800, 8, hwyZ - 34),
    roadType: 'highway-3',
  });
  const backMid = net.drawRoad({ start: at(backE.nodes[1]), end: free(v(-500, 8, hwyZ - 34)), c1: v(200, 8, hwyZ - 34), c2: v(-200, 8, hwyZ - 34), roadType: 'highway-3' });
  net.drawRoad({
    start: at(backMid.nodes[1]),
    end: free(v(-1400, 0, hwyZ - 34)),
    c1: v(-800, 8, hwyZ - 34),
    c2: v(-1100, 0, hwyZ - 34),
    roadType: 'highway-3',
  });

  // Off-ramp from the eastbound carriageway down to the avenue, and an on-ramp back.
  const mainSeg = elevEast.segments[0];
  net.drawRoad({
    start: { kind: 'segment', id: mainSeg, t: 0.18 },
    end: { kind: 'segment', id: net.nearestSegment(v(0, 0, -190), 5)!.segmentId, t: 0.25 },
    c1: v(-180, 8, hwyZ + 2),
    c2: v(0, 2, hwyZ + 70),
    roadType: 'ramp-1',
  });
  const mainSeg2 = net.nearestSegment(v(360, 8, hwyZ), 8)!.segmentId;
  net.drawRoad({
    start: { kind: 'segment', id: net.nearestSegment(v(0, 0, -140), 5)!.segmentId, t: 0.6 },
    end: { kind: 'segment', id: mainSeg2, t: 0.7 },
    c1: v(40, 2, -240),
    c2: v(240, 8, hwyZ + 8),
    roadType: 'ramp-1',
  });

  // Bridge over the river, then a dead end with a gateway.
  const bridgeStart = net.nearestNode(v(0, 0, 200), 2)!.nodeId;
  const bridge = net.drawRoad({
    start: at(bridgeStart),
    end: free(v(30, 0, 900)),
    c1: v(0, 12, 450),
    c2: v(30, 12, 700),
    roadType: 'avenue-4',
  });
  const gate = bridge.nodes[bridge.nodes.length - 1];
  net.addEndpoint({ kind: 'gateway', nodeId: gate, ratePerHour: 600, name: 'South' });

  // A second river crossing, lower and two lanes, on a street deck.
  net.drawRoad({
    start: free(v(-700, 0, 280)),
    end: free(v(-720, 0, 880)),
    c1: v(-700, 7, 500),
    c2: v(-720, 7, 700),
    roadType: 'street-2',
  });

  // Tunnel: a street that dips under a low hill of nothing and back up.
  const tunnelA = net.drawRoad({
    start: free(v(460, 0, 30)),
    end: free(v(1200, 0, 40)),
    c1: v(650, -19, 34),
    c2: v(1010, -19, 40),
    roadType: 'street-4',
  });
  const tunnelEnd = tunnelA.nodes[tunnelA.nodes.length - 1];
  net.addEndpoint({ kind: 'gateway', nodeId: tunnelEnd, ratePerHour: 400, name: 'East' });

  // A ramp hugging a highway at a very shallow angle: the overlap core cannot trim away.
  const hug = net.drawRoad({ start: free(v(-1300, 0, -700)), end: free(v(-500, 0, -700)), roadType: 'highway-3' });
  net.drawRoad({
    start: { kind: 'segment', id: hug.segments[0], t: 0.3 },
    end: free(v(-560, 0, -650)),
    c1: v(-840, 0, -699),
    c2: v(-700, 0, -668),
    roadType: 'ramp-1',
  });

  // Sloped junction: two roads climbing through a raised crossing, on a deck.
  net.drawRoad({ start: free(v(-1300, 0, -1000)), end: free(v(-700, 12, -1000)), roadType: 'avenue-4' });
  net.drawRoad({
    start: free(v(-1000, 0, -1200)),
    end: free(v(-1000, 0, -800)),
    c1: v(-1000, 12, -1100),
    c2: v(-1000, 12, -900),
    roadType: 'street-4',
  });

  // Zones along the streets.
  const zones: [Vec3, 'residential' | 'commercial' | 'industrial' | 'office', 1 | -1, number][] = [
    [v(-300, 0, 90), 'residential', -1, 200],
    [v(280, 0, 170), 'commercial', 1, 500],
    [v(180, 0, -10), 'office', -1, 900],
    [v(-120, 0, -40), 'residential', -1, 150],
    [v(-900, 0, -40), 'commercial', 1, 800],
    [v(-1000, 0, 180), 'industrial', 1, 600],
    [v(300, 0, 10), 'industrial', 1, 300],
  ];
  for (const [p, kind, side, rate] of zones) {
    const near = net.nearestSegment(p, 80);
    if (near) net.addEndpoint({ kind, segmentId: near.segmentId, t: near.t, side, ratePerHour: rate, name: kind });
  }

  // Decals: every kind, on a wide apron with no median.
  net.drawRoad({ start: free(v(420, 0, 200)), end: free(v(420, 0, 340)), roadType: 'highway-5' });
  const x = 420;
  const z = 215;
  const y = 0;
  net.addDecal({ kind: 'line', points: [v(x - 12, y, z), v(x - 12, y, z + 18), v(x - 8, y, z + 28)], color: 'yellow', width: 0.2, rotation: 0 });
  net.addDecal({ kind: 'dashedLine', points: [v(x - 9, y, z), v(x - 9, y, z + 20)], color: 'white', width: 0.2, rotation: 0 });
  net.addDecal({ kind: 'doubleLine', points: [v(x - 6, y, z), v(x - 6, y, z + 20)], color: 'blue', width: 0.15, rotation: 0 });
  net.addDecal({ kind: 'hatch', points: [v(x - 3, y, z), v(x + 2, y, z), v(x + 2, y, z + 12), v(x - 3, y, z + 14)], color: 'yellow', width: 0.15, rotation: 0 });
  net.addDecal({ kind: 'fill', points: [v(x + 4, y, z), v(x + 10, y, z), v(x + 10, y, z + 8), v(x + 4, y, z + 10)], color: 'green', width: 0, rotation: 0 });
  net.addDecal({ kind: 'crosswalk', points: [v(x - 12, y, z + 34), v(x + 12, y, z + 34)], color: 'white', width: 3, rotation: 0 });
  net.addDecal({ kind: 'stopLine', points: [v(x - 12, y, z + 40), v(x, y, z + 40)], color: 'white', width: 0.5, rotation: 0 });
  net.addDecal({ kind: 'yieldTriangles', points: [v(x + 1, y, z + 40), v(x + 12, y, z + 40)], color: 'white', width: 0.7, rotation: 0 });
  const stamps = ['arrowStraight', 'arrowLeft', 'arrowRight', 'arrowStraightLeft', 'arrowStraightRight'] as const;
  stamps.forEach((kind, i) => net.addDecal({ kind, points: [v(x - 10 + i * 5, y, z + 50)], color: i % 2 ? 'yellow' : 'white', width: 1, rotation: Math.PI }));
  net.addDecal({ kind: 'text', points: [v(x, y, z + 66)], color: 'white', width: 2, rotation: Math.PI / 2, text: 'SLOW' });
  net.addDecal({ kind: 'text', points: [v(x - 6, y, z + 66)], color: 'yellow', width: 1.6, rotation: 0, text: 'BUS STOP' });
}

function buildStress(net: RoadNetwork): void {
  // A wavy street grid in the empty north-east, cut into segments by auto junctions.
  const x0 = 200;
  const z0 = -1900;
  const step = 92;
  const n = 15;
  for (let i = 0; i <= n; i++) {
    const a = x0 + i * step;
    net.drawRoad({
      start: free(v(a, 0, z0)),
      end: free(v(a + 20, 0, z0 + n * step)),
      c1: v(a + 40, 0, z0 + (n * step) / 3),
      c2: v(a - 30, 0, z0 + (2 * n * step) / 3),
      roadType: i % 4 === 0 ? 'avenue-4' : 'street-2',
    });
  }
  for (let j = 0; j <= n; j++) {
    const b = z0 + j * step;
    net.drawRoad({
      start: free(v(x0 - 30, 0, b)),
      end: free(v(x0 + n * step + 30, 0, b + 20)),
      c1: v(x0 + (n * step) / 3, 0, b + 40),
      c2: v(x0 + (2 * n * step) / 3, 0, b - 30),
      roadType: j % 4 === 0 ? 'avenue-4' : 'street-2',
    });
  }
}

function main(): void {
  const q = new URLSearchParams(location.search);
  // The dev server is shared, so other people's edits would reload the page mid-measurement.
  if (q.get('hold') === '1' && import.meta.hot) {
    import.meta.hot.on('vite:beforeFullReload', () => {
      throw new Error('Sandbox holding: reload skipped');
    });
  }
  const count = Number(q.get('n') ?? 400);
  const stress = q.get('stress') === '1';
  const net = new RoadNetwork();
  const t0 = performance.now();
  net.batch(() => {
    buildTown(net);
    if (stress) buildStress(net);
  });
  const t1 = performance.now();
  const sim = new FakeSim(net, count);
  const stage = document.getElementById('stage')!;
  let renderer: Renderer;
  try {
    renderer = new Renderer(stage, net, sim);
  } catch (err) {
    document.getElementById('hud')!.textContent = String(err);
    throw err;
  }
  renderer.setTimeOfDay(Number(q.get('hours') ?? 10.5));
  const level = q.get('quality');
  if (level) renderer.setQuality(level as 'low' | 'medium' | 'high' | 'ultra');
  renderer.setCamera({ target: v(0, 0, -60), distance: 520, yaw: 0.55, pitch: 0.7 });
  (document.getElementById('time') as HTMLInputElement).value = String(renderer.getTimeOfDay());
  const startView = q.get('view');
  const t2 = performance.now();

  const hud = document.getElementById('hud')!;
  let last = performance.now();
  let hudTimer = 0;
  // Frame timings for the measurement hook, in ms.
  const frames: number[] = [];
  let paused = false;
  const loop = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    if (!paused) {
      sim.advance(Math.min(dt, 0.1));
      const s0 = performance.now();
      renderer.frame(dt);
      frames.push(performance.now() - s0);
      if (frames.length > 600) frames.shift();
    }
    hudTimer += dt;
    if (hudTimer > 0.4) {
      hudTimer = 0;
      const s = renderer.stats();
      hud.textContent = `${s.fps.toFixed(0)} fps · ${s.drawCalls} calls · ${(s.triangles / 1000).toFixed(0)}k tris · ${renderer.getQuality()} · ${sim.vehicles.count} vehicles · ${net.segments.length} segs · build ${(t1 - t0).toFixed(0)} + ${(t2 - t1).toFixed(0)} ms`;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const bind = (id: string, fn: (el: HTMLInputElement) => void) => {
    const el = document.getElementById(id) as HTMLInputElement;
    el.addEventListener('input', () => fn(el));
    return el;
  };
  bind('time', (el) => renderer.setTimeOfDay(Number(el.value)));
  bind('overlay', (el) => renderer.setOverlay(el.value as OverlayMode));
  bind('under', (el) => renderer.setUnderground(el.checked));
  bind('debug', (el) => renderer.setLaneDebug(el.checked));
  bind('shadows', (el) => renderer.setShadows(el.checked));

  const views: Record<string, Partial<CameraPose>> = {
    town: { target: v(0, 0, -60), distance: 520, yaw: 0.55, pitch: 0.7 },
    fourway: { target: v(0, 0, -40), distance: 70, yaw: 0.6, pitch: 0.6 },
    street: { target: v(-5, 0, -20), distance: 16, yaw: 2.8, pitch: 0.12 },
    ramp: { target: v(-60, 4, -300), distance: 240, yaw: -0.5, pitch: 0.55 },
    boulevard: { target: v(-1000, 0, -40), distance: 110, yaw: 0.5, pitch: 0.75 },
    bridge: { target: v(10, 0, 560), distance: 200, yaw: 1.2, pitch: 0.3 },
    tunnel: { target: v(490, -2, 31), distance: 60, yaw: -1.2, pitch: 0.45 },
    decals: { target: v(420, 0, 258), distance: 70, yaw: 0, pitch: 1.2 },
    split: { target: v(-210, 8, -310), distance: 170, yaw: 1.0, pitch: 0.6 },
    merge: { target: v(290, 8, -310), distance: 170, yaw: 1.0, pitch: 0.6 },
    overhead: { target: v(0, 0, 0), distance: 1800, yaw: 0.3, pitch: 0.9 },
    signals: { target: v(-16, 0, -14), distance: 26, yaw: 2.4, pitch: 0.2 },
    hug: { target: v(-760, 0, -685), distance: 130, yaw: 0.7, pitch: 0.65 },
    slope: { target: v(-1000, 6, -1000), distance: 120, yaw: 0.8, pitch: 0.42 },
    map: { target: v(0, 0, 0), distance: 5200, yaw: 0, pitch: 1.1 },
  };

  const demoPreview = (): RoadPreview[] => [
    { curves: [{ p0: v(40, 0, 60), p1: v(90, 0, 40), p2: v(120, 0, 90), p3: v(170, 0, 80) }], roadType: 'avenue-4', state: 'ok' },
    { curves: [{ p0: v(40, 0, 100), p1: v(90, 0, 100), p2: v(120, 0, 120), p3: v(170, 0, 120) }], roadType: 'street-2', state: 'warning' },
    { curves: [{ p0: v(-160, 0, 40), p1: v(-120, 0, 50), p2: v(-90, 0, 70), p3: v(-60, 0, 60) }], roadType: 'highway-3', state: 'error' },
  ];
  const demoMarks = (): ToolMark[] => [
    { kind: 'point', pos: v(40, 0, 60), color: '#3ec8ff', radius: 2 },
    { kind: 'ring', pos: v(170, 0, 80), color: '#ffffff', radius: 7 },
    { kind: 'line', points: [v(40, 0, 60), v(170, 0, 80)], color: '#ffffff', width: 0.5, dashed: true },
    { kind: 'label', pos: v(105, 0, 70), text: 'Length 131 m' },
  ];

  (window as unknown as { __sandbox: unknown }).__sandbox = {
    net,
    sim,
    renderer,
    views,
    show(name: string) {
      renderer.setCamera(views[name]);
    },
    preview(on: boolean) {
      renderer.setPreview(on ? demoPreview() : []);
      renderer.setMarks(on ? demoMarks() : []);
    },
    /** Look at a vehicle of a type from close by, and freeze the sim. */
    lookAtVehicle(type: number, yawOffset: number, distance: number, pitch: number) {
      const w = sim.vehicles;
      for (let i = 0; i < w.count; i++) {
        if (w.type[i] !== type || Math.abs(w.x[i]) > 900 || w.y[i] > 1) continue;
        sim.speed = 0;
        renderer.setCamera({ target: v(w.x[i], w.y[i], w.z[i]), distance, yaw: w.yaw[i] + yawOffset, pitch });
        return i;
      }
      return -1;
    },
    frameTimes: () => frames.slice(),
    pause(on: boolean) {
      paused = on;
    },
  };
  if (startView && views[startView]) renderer.setCamera(views[startView]);
}

main();
