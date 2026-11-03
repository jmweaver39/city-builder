/**
 * Top-down preview of the real game code while the full app is being built.
 * Sim and templates are loaded through globs, so they appear here as soon as
 * their files exist, and this page keeps working until then.
 */
import { RoadNetwork, checkNetworkInvariants, type GLane, type Vec3 } from '../core';
import { VEHICLE_TYPES, type SimApi } from '../sim/api';

const simModules = import.meta.glob('../sim/Simulation.ts');
const templateModules = import.meta.glob('../templates/index.ts');
const present = import.meta.glob(['../render/Renderer.ts', '../render/sandbox.ts', '../app/main.ts', '../ui/*.ts']);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const ctx = canvas.getContext('2d')!;

// --- Scenes ----------------------------------------------------------------

function anchor(net: RoadNetwork, p: Vec3) {
  const node = net.nearestNode(p, 3);
  if (node && Math.abs(net.project.nodes.find((n) => n.id === node.nodeId)!.pos.y - p.y) < 2) {
    return { kind: 'node' as const, id: node.nodeId };
  }
  const seg = net.nearestSegment(p, 3);
  if (seg) return { kind: 'segment' as const, id: seg.segmentId, t: seg.t };
  return { kind: 'free' as const, pos: p };
}

function road(net: RoadNetwork, roadType: string, start: Vec3, end: Vec3, c1?: Vec3, c2?: Vec3) {
  net.drawRoad({ start: anchor(net, start), end: anchor(net, end), c1, c2, roadType });
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function diamond(net: RoadNetwork) {
  road(net, 'highway-3', v(-650, 0, 14), v(650, 0, 14));
  road(net, 'highway-3', v(650, 0, -14), v(-650, 0, -14));
  road(net, 'street-4', v(0, 0, -340), v(0, 8, -110));
  road(net, 'street-4', v(0, 8, -110), v(0, 8, 110));
  road(net, 'street-4', v(0, 8, 110), v(0, 0, 340));
  road(net, 'ramp-1', v(-300, 0, 14), v(0, 8, 110), v(-200, 0, 30), v(-70, 8, 110));
  road(net, 'ramp-1', v(0, 8, 110), v(300, 0, 14), v(70, 8, 110), v(200, 0, 30));
  road(net, 'ramp-1', v(300, 0, -14), v(0, 8, -110), v(200, 0, -30), v(70, 8, -110));
  road(net, 'ramp-1', v(0, 8, -110), v(-300, 0, -14), v(-70, 8, -110), v(-200, 0, -30));
}

function crossing(net: RoadNetwork) {
  road(net, 'avenue-6', v(-420, 0, 0), v(420, 0, 0));
  road(net, 'avenue-4', v(0, 0, -420), v(0, 0, 420));
}

function curves(net: RoadNetwork) {
  road(net, 'street-2', v(-420, 0, -160), v(420, 0, 160), v(-120, 0, -420), v(120, 0, 420));
  road(net, 'street-4', v(-420, 0, 130), v(420, 0, -130), v(-150, 0, -120), v(150, 0, 120));
}

function roundabout(net: RoadNetwork) {
  const r = 48;
  const k = 0.5523 * r;
  const road1 = 'street-2-oneway';
  road(net, road1, v(r, 0, 0), v(0, 0, -r), v(r, 0, -k), v(k, 0, -r));
  road(net, road1, v(0, 0, -r), v(-r, 0, 0), v(-k, 0, -r), v(-r, 0, -k));
  road(net, road1, v(-r, 0, 0), v(0, 0, r), v(-r, 0, k), v(-k, 0, r));
  road(net, road1, v(0, 0, r), v(r, 0, 0), v(k, 0, r), v(r, 0, k));
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    road(net, 'street-2', v(x * 340, 0, z * 340), v(x * r, 0, z * r));
  }
}

interface Scene {
  name: string;
  build(net: RoadNetwork): void;
}

const scenes: Scene[] = [
  { name: 'Diamond interchange', build: diamond },
  { name: 'Avenue crossing with signals', build: crossing },
  { name: 'Curved streets crossing', build: curves },
  { name: 'Roundabout', build: roundabout },
];

// --- State -----------------------------------------------------------------

let net = new RoadNetwork();
let sim: SimApi | null = null;
let SimClass: (new (net: RoadNetwork, seed?: number) => SimApi) | null = null;
let simError = '';
let speed = 1;
let showLanes = false;
let view = { scale: 1, x: 0, y: 0 };

// Stand-in used only until the real sim exists: checks that lanes connect by
// walking them. It has no collisions, signals or car following.
interface Walker { lane: GLane; s: number }
let walkers: Walker[] = [];

function resetWalkers() {
  const roads = net.laneGraph.lanes.filter((l) => l.kind === 'road' && l.vehicleKind !== 'bike');
  const count = Math.round(Math.min(600, roads.length * 2.5) * Number($<HTMLInputElement>('traffic').value));
  walkers = roads.length
    ? Array.from({ length: count }, () => {
        const lane = roads[Math.floor(Math.random() * roads.length)];
        return { lane, s: Math.random() * lane.length };
      })
    : [];
}

function stepWalkers(dt: number) {
  const lanes = net.laneGraph.lanes;
  for (const w of walkers) {
    w.s += w.lane.speed * dt;
    while (w.s >= w.lane.length) {
      const next = w.lane.next;
      if (!next.length) {
        const roads = lanes.filter((l) => l.kind === 'road' && !l.prev.length);
        w.lane = roads.length ? roads[Math.floor(Math.random() * roads.length)] : w.lane;
        w.s = 0;
        break;
      }
      w.s -= w.lane.length;
      w.lane = lanes[next[Math.floor(Math.random() * next.length)]];
    }
  }
}

function pointOnLane(lane: GLane, s: number) {
  let i = 1;
  while (i < lane.cum.length - 1 && lane.cum[i] < s) i++;
  const a = (i - 1) * 3;
  const b = i * 3;
  const f = (s - lane.cum[i - 1]) / Math.max(1e-6, lane.cum[i] - lane.cum[i - 1]);
  const dx = lane.pts[b] - lane.pts[a];
  const dz = lane.pts[b + 2] - lane.pts[a + 2];
  return { x: lane.pts[a] + dx * f, y: lane.pts[a + 1], z: lane.pts[a + 2] + dz * f, angle: Math.atan2(dz, dx) };
}

function loadScene(index: number) {
  net = new RoadNetwork();
  sim = null;
  simError = '';
  try {
    net.batch(() => scenes[index].build(net));
  } catch (e) {
    simError = `Scene failed: ${(e as Error).message}`;
  }
  net.setTraffic({ autoGateways: true, multiplier: Number($<HTMLInputElement>('traffic').value) });
  if (SimClass) {
    try {
      sim = new SimClass(net, 1);
      sim.speed = speed;
    } catch (e) {
      simError = `Traffic sim failed to start: ${(e as Error).message}`;
    }
  }
  resetWalkers();
  fit();
  renderInfo();
}

function fit() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of net.project.nodes) {
    minX = Math.min(minX, n.pos.x);
    maxX = Math.max(maxX, n.pos.x);
    minZ = Math.min(minZ, n.pos.z);
    maxZ = Math.max(maxZ, n.pos.z);
  }
  if (minX > maxX) return;
  const panel = document.querySelector('aside')!.classList.contains('closed') ? 0 : 310;
  const top = panel ? 0 : 60;
  const w = window.innerWidth - panel;
  const h = window.innerHeight - top;
  const scale = Math.min(w / (maxX - minX + 80), h / (maxZ - minZ + 80));
  view = { scale, x: panel + w / 2 - ((minX + maxX) / 2) * scale, y: top + h / 2 - ((minZ + maxZ) / 2) * scale };
}

// --- Drawing ---------------------------------------------------------------

function path(points: { x: number; z: number }[]) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
}

function drawSegment(id: number) {
  const geom = net.segmentGeom(id);
  if (!geom || geom.stations.length < 2) return;
  const def = net.roadTypeOf(id);
  const pts = geom.stations.map((st) => st.pos);
  const raised = pts.some((p) => p.y > 1);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  path(pts);
  if (raised) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = def.halfWidth * 2 + 7;
    ctx.stroke();
  }
  ctx.strokeStyle = def.sidewalk ? '#b9b6ad' : '#6f7276';
  ctx.lineWidth = (def.halfWidth + def.sidewalk) * 2;
  ctx.stroke();
  ctx.strokeStyle = '#43484e';
  ctx.lineWidth = def.halfWidth * 2;
  ctx.stroke();
  if (def.median.width > 0) {
    ctx.strokeStyle = def.median.kind === 'grass' ? '#6d9457' : '#c9c6bd';
    ctx.lineWidth = def.median.width;
    ctx.stroke();
  }
}

function drawNode(id: number) {
  const outline = net.nodeGeom(id)?.outline ?? [];
  if (outline.length < 3) return;
  path(outline);
  ctx.closePath();
  ctx.fillStyle = '#43484e';
  ctx.fill();
}

const turnColor: Record<string, string> = { left: '#f0b64f', right: '#5fd38d', straight: '#4fc3e8', uturn: '#f07167' };

function drawLanes() {
  ctx.lineCap = 'butt';
  for (const lane of net.laneGraph.lanes) {
    const pts = [];
    for (let i = 0; i < lane.pts.length; i += 3) pts.push({ x: lane.pts[i], z: lane.pts[i + 2] });
    path(pts);
    const isConnector = lane.kind === 'connector';
    ctx.strokeStyle = isConnector ? turnColor[lane.turn ?? 'straight'] : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = (isConnector ? 1.1 : 0.8) / Math.max(0.6, view.scale);
    ctx.stroke();
  }
}

function drawCar(x: number, z: number, angle: number, length: number, width: number, color: string, braking: boolean) {
  ctx.save();
  ctx.translate(x, z);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.fillRect(-length / 2, -width / 2, length, width);
  if (braking) {
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(-length / 2, -width / 2, 0.8, width);
  }
  ctx.restore();
}

const palette = ['#e8e6df', '#2f3338', '#b23a3a', '#3a68b2', '#c9a13b', '#8a8f96', '#3f8a5c', '#7d4fa3', '#d9772f', '#57b5c9', '#a8a29a', '#5a4634', '#e2c9a0', '#1f4d6b', '#9c2f55', '#6b7f3a'];
const sizes: Record<string, [number, number]> = { car: [4.5, 2], van: [5.5, 2.1], truck: [12, 2.5], bus: [12, 2.5] };

function drawVehicles(raised: boolean) {
  if (sim) {
    const vehicles = sim.vehicles;
    const alpha = sim.renderAlpha;
    for (let i = 0; i < vehicles.count; i++) {
      if (vehicles.y[i] > 3 !== raised) continue;
      const x = vehicles.prevX[i] + (vehicles.x[i] - vehicles.prevX[i]) * alpha;
      const z = vehicles.prevZ[i] + (vehicles.z[i] - vehicles.prevZ[i]) * alpha;
      const yaw = vehicles.yaw[i];
      const [length, width] = sizes[VEHICLE_TYPES[vehicles.type[i]]];
      drawCar(x, z, Math.atan2(-Math.cos(yaw), -Math.sin(yaw)), length, width, palette[vehicles.color[i] & 15], !!vehicles.braking[i]);
    }
    return;
  }
  for (const w of walkers) {
    const p = pointOnLane(w.lane, w.s);
    if (p.y > 3 === raised) drawCar(p.x, p.z, p.angle, 4.5, 2, '#e8e6df', false);
  }
}

function drawSignals() {
  if (!sim) return;
  const colors = { red: '#ff3b30', yellow: '#ffcc00', green: '#34e26f', off: '#666' };
  for (const head of sim.signalHeads()) {
    ctx.beginPath();
    ctx.arc(head.pos.x, head.pos.z, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = colors[head.state];
    ctx.fill();
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#6d8f5c';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

  const items: { y: number; draw: () => void }[] = [];
  for (const seg of net.project.segments) {
    const geom = net.segmentGeom(seg.id);
    const y = geom?.stations.length ? Math.max(...geom.stations.map((st) => st.pos.y)) : 0;
    items.push({ y, draw: () => drawSegment(seg.id) });
  }
  for (const node of net.project.nodes) items.push({ y: node.pos.y + 0.01, draw: () => drawNode(node.id) });
  items.sort((a, b) => a.y - b.y);

  for (const it of items) if (it.y <= 3) it.draw();
  drawVehicles(false);
  for (const it of items) if (it.y > 3) it.draw();
  drawVehicles(true);
  if (showLanes) drawLanes();
  drawSignals();
}

// --- Panels ----------------------------------------------------------------

function row(label: string, value: string) {
  const r = document.createElement('div');
  r.className = 'row';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = value;
  r.append(a, b);
  return r;
}

function renderInfo() {
  const mode = $('mode');
  if (simError) {
    mode.className = 'banner bad';
    mode.textContent = simError;
  } else if (sim) {
    mode.className = 'banner real';
    mode.textContent = 'Real traffic simulation running.';
  } else {
    mode.className = 'banner';
    mode.textContent = 'Traffic sim is still being built. White dots only test that lanes connect, with no collisions, queues or signals.';
  }

  const graph = net.laneGraph;
  const connectors = graph.lanes.filter((l) => l.kind === 'connector');
  const conflicts = connectors.reduce((n, l) => n + l.conflicts.length, 0) / 2;
  const problems = checkNetworkInvariants(net).length;
  const rows = [
    row('Road segments', String(net.project.segments.length)),
    row('Road lanes', String(graph.lanes.length - connectors.length)),
    row('Junction turn paths', String(connectors.length)),
    row('Conflict points', String(Math.round(conflicts))),
    row('Network problems', String(problems)),
  ];
  if (sim) {
    const s = sim.stats();
    rows.push(
      row('Vehicles', String(s.active)),
      row('Flow', `${Math.round(s.flow * 100)}%`),
      row('Arrived', String(s.arrivedTotal)),
      row('Throughput per hour', String(Math.round(s.throughputPerHour))),
      row('Mean speed', `${Math.round(s.meanSpeedKmh)} km/h`),
      row('Jammed', String(s.jammed)),
    );
  } else {
    rows.push(row('Lane test dots', String(walkers.length)));
  }
  $('stats').replaceChildren(...rows);

  const has = (key: string) => Object.keys(present).some((k) => k.includes(key));
  const caps: [string, boolean][] = [
    ['Curved roads, junctions, lanes', true],
    ['Bridges and ramps', true],
    ['Traffic simulation', !!sim],
    ['Traffic lights and signs', !!sim],
    ['Interchange templates', Object.keys(templateModules).length > 0],
    ['3D world', has('Renderer.ts')],
    ['Editor and interface', has('app/main.ts')],
  ];
  $('caps').replaceChildren(
    ...caps.map(([name, live]) => {
      const c = document.createElement('div');
      c.className = live ? 'cap live' : 'cap';
      c.append(document.createElement('i'), name);
      return c;
    }),
  );

  const links: [string, string][] = [];
  if (has('sandbox.ts')) links.push(['Open 3D render test', '/render-sandbox.html']);
  if (has('app/main.ts')) links.push(['Open the game', '/']);
  $('links').replaceChildren(
    ...links.map(([text, href]) => {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = text;
      a.style.display = 'block';
      a.style.marginTop = '6px';
      return a;
    }),
  );
}

function populateScenes() {
  const select = $<HTMLSelectElement>('scene');
  select.replaceChildren(
    ...scenes.map((s, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = s.name;
      return o;
    }),
  );
}

function setPanelOpen(open: boolean) {
  document.querySelector('aside')!.classList.toggle('closed', !open);
  $('toggle').textContent = open ? 'Hide' : 'Controls';
}

function setupControls() {
  setPanelOpen(window.innerWidth > 700);
  $('toggle').onclick = () => {
    setPanelOpen(document.querySelector('aside')!.classList.contains('closed'));
    fit();
  };
  $<HTMLSelectElement>('scene').onchange = (e) => loadScene(Number((e.target as HTMLSelectElement).value));
  $<HTMLInputElement>('lanes').onchange = (e) => (showLanes = (e.target as HTMLInputElement).checked);
  $<HTMLInputElement>('traffic').oninput = (e) => {
    const value = Number((e.target as HTMLInputElement).value);
    $('trafficValue').textContent = `${Math.round(value * 100)}%`;
    net.setTraffic({ multiplier: value });
    if (!sim) resetWalkers();
  };
  const speeds = $('speeds');
  for (const [label, value] of [['Pause', 0], ['1x', 1], ['2x', 2], ['4x', 4]] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = value === speed ? 'on' : '';
    b.onclick = () => {
      speed = value;
      if (sim) sim.speed = value;
      for (const other of speeds.children) other.className = '';
      b.className = 'on';
    };
    speeds.append(b);
  }

  let drag: { x: number; y: number } | null = null;
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    view.x += e.clientX - drag.x;
    view.y += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
  };
  canvas.onpointerup = () => (drag = null);
  canvas.onwheel = (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    view.x = e.clientX - (e.clientX - view.x) * factor;
    view.y = e.clientY - (e.clientY - view.y) * factor;
    view.scale *= factor;
  };
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  window.addEventListener('resize', resize);
  resize();
}

async function loadOptionalModules() {
  const simLoader = simModules['../sim/Simulation.ts'];
  if (simLoader) {
    try {
      const mod = (await simLoader()) as { Simulation: typeof SimClass };
      SimClass = mod.Simulation;
    } catch (e) {
      simError = `Traffic sim is not loadable yet: ${(e as Error).message}`;
    }
  }
  const templateLoader = templateModules['../templates/index.ts'];
  if (templateLoader) {
    try {
      const mod = (await templateLoader()) as {
        TEMPLATES: { id: string; name: string; params: { key: string; default: number }[] }[];
        stampTemplate(net: RoadNetwork, id: string, params: Record<string, number>, placement: unknown): unknown;
      };
      for (const t of mod.TEMPLATES) {
        const params = Object.fromEntries(t.params.map((p) => [p.key, p.default]));
        scenes.push({
          name: `Template: ${t.name}`,
          build: (n) => void mod.stampTemplate(n, t.id, params, { pos: v(0, 0, 0), rotation: 0, elevation: 0 }),
        });
      }
    } catch {
      // Templates are mid-write. The built-in scenes still work.
    }
  }
}

let last = performance.now();
let infoTimer = 0;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (sim) {
    try {
      sim.advance(dt);
    } catch (e) {
      simError = `Traffic sim crashed: ${(e as Error).message}`;
      sim = null;
    }
  } else if (speed) {
    stepWalkers(dt * speed);
  }
  draw();
  infoTimer += dt;
  if (infoTimer > 0.5) {
    infoTimer = 0;
    renderInfo();
  }
  requestAnimationFrame(loop);
}

setupControls();
await loadOptionalModules();
populateScenes();
loadScene(0);
requestAnimationFrame(loop);
