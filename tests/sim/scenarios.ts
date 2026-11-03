import { defaultSignalPlan, RoadNetwork, type DrawRoadParams, type Vec3 } from '../../src/core';
import { atNode, crossroads, free, onSeg, v } from './helpers';

export function roundabout(R = 45, spokeLength = 350, ring = 'street-2-oneway') {
  const net = new RoadNetwork();
  const k = 0.5523 * R;
  const nodes = [v(R, 0), v(0, R), v(-R, 0), v(0, -R)].map((p) => net.addNode(p));
  // Right-hand traffic circulates counter-clockwise from above: +x, -z, -x, +z.
  const order = [0, 3, 2, 1];
  for (let i = 0; i < 4; i++) {
    const a = net.getNode(nodes[order[i]])!.pos;
    const b = net.getNode(nodes[order[(i + 1) % 4]])!.pos;
    const tanA = v(a.z / R, -a.x / R);
    const tanB = v(b.z / R, -b.x / R);
    net.addSegment(nodes[order[i]], nodes[order[(i + 1) % 4]], {
      roadType: ring,
      c1: v(a.x + tanA.x * k, a.z + tanA.z * k),
      c2: v(b.x - tanB.x * k, b.z - tanB.z * k),
    });
  }
  for (const n of nodes) {
    const p = net.getNode(n)!.pos;
    const l = Math.hypot(p.x, p.z);
    const spoke = net.addNode(v((p.x / l) * spokeLength, (p.z / l) * spokeLength));
    net.addSegment(n, spoke, { roadType: 'street-2' });
  }
  return net;
}

export function diamond() {
  const net = new RoadNetwork();
  const Y = 8;
  const east = net.drawRoad({ start: free(-900, 20), end: free(900, 20), roadType: 'highway-3' }).segments[0];
  const west = net.drawRoad({ start: free(900, -20), end: free(-900, -20), roadType: 'highway-3' }).segments[0];
  const bridge = net.drawRoad({ start: free(0, -400, Y), end: free(0, 400, Y), roadType: 'street-4' });
  const main = bridge.segments[0];
  const south = net.splitSegment(main, 460 / 800).node;
  const north = net.splitSegment(main, 340 / 460).node;
  const ramp = (start: DrawRoadParams['start'], end: DrawRoadParams['end'], c1: Vec3, c2: Vec3) =>
    net.drawRoad({ start, end, c1, c2, roadType: 'ramp-1' });
  ramp(onSeg(east, 0.3), atNode(south), v(-330, 20), v(-120, 60, Y));
  const eastAfter = net.nearestSegment(v(400, 20))!.segmentId;
  ramp(atNode(south), onSeg(eastAfter, 0.4), v(120, 60, Y), v(300, 20));
  ramp(onSeg(west, 0.3), atNode(north), v(330, -20), v(120, -60, Y));
  const westAfter = net.nearestSegment(v(-400, -20))!.segmentId;
  ramp(atNode(north), onSeg(westAfter, 0.4), v(-120, -60, Y), v(-300, -20));
  return net;
}

/** One-way highway with a right-hand on-ramp at x = 0. */
export function onRamp(type = 'highway-2') {
  const net = new RoadNetwork();
  const a = net.addNode(v(-1000, 0));
  const n = net.addNode(v(0, 0));
  const b = net.addNode(v(1200, 0));
  const r = net.addNode(v(-420, 260));
  const mainIn = net.addSegment(a, n, { roadType: type });
  const mainOut = net.addSegment(n, b, { roadType: type });
  const ramp = net.addSegment(r, n, { roadType: 'ramp-1', c1: v(-300, 150), c2: v(-150, 0) });
  return { net, a, n, b, r, mainIn, mainOut, ramp };
}

/** An on-ramp, then an off-ramp 400 m on, so entering and leaving traffic cross over. */
export function weave() {
  const net = new RoadNetwork();
  const a = net.addNode(v(-1100, 0));
  const n1 = net.addNode(v(0, 0));
  const n2 = net.addNode(v(400, 0));
  const b = net.addNode(v(1500, 0));
  const inRamp = net.addNode(v(-420, 260));
  const outRamp = net.addNode(v(820, 260));
  net.addSegment(a, n1, { roadType: 'highway-3' });
  net.addSegment(n1, n2, { roadType: 'highway-3' });
  net.addSegment(n2, b, { roadType: 'highway-3' });
  net.addSegment(inRamp, n1, { roadType: 'ramp-1', c1: v(-300, 150), c2: v(-150, 0) });
  net.addSegment(n2, outRamp, { roadType: 'ramp-1', c1: v(550, 0), c2: v(700, 150) });
  net.setTraffic({ autoGateways: false });
  net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 3600, attraction: 0 });
  net.addEndpoint({ kind: 'gateway', nodeId: inRamp, ratePerHour: 1000, attraction: 0 });
  net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 3 });
  const exit = net.addEndpoint({ kind: 'gateway', nodeId: outRamp, ratePerHour: 0, attraction: 1 });
  return { net, exit };
}

/** A three-lane highway narrowing to two. */
export function laneDrop() {
  const net = new RoadNetwork();
  const a = net.addNode(v(-1000, 0));
  const n = net.addNode(v(0, 0));
  const b = net.addNode(v(1000, 0));
  net.addSegment(a, n, { roadType: 'highway-3' });
  net.addSegment(n, b, { roadType: 'highway-2' });
  net.setTraffic({ autoGateways: false });
  net.addEndpoint({ kind: 'gateway', nodeId: a, ratePerHour: 3400, attraction: 0 });
  net.addEndpoint({ kind: 'gateway', nodeId: b, ratePerHour: 0, attraction: 1 });
  return net;
}

export function controlled(type: string, mode: 'stop' | 'allStop' | 'priority' | 'signal' | 'lefts' | 'auto', rate: number) {
  const c = crossroads(type);
  const { net, hub, segs } = c;
  if (mode === 'stop') {
    net.setJunctionControl(hub, { mode: 'priority' });
    for (const s of segs) net.setSign(hub, s, 'stop');
  } else if (mode === 'allStop') {
    net.setJunctionControl(hub, { mode: 'allStop' });
  } else if (mode === 'priority') {
    net.setJunctionControl(hub, { mode: 'priority' });
    net.setSign(hub, segs[0], 'priority');
    net.setSign(hub, segs[1], 'priority');
    net.setSign(hub, segs[2], 'yield');
    net.setSign(hub, segs[3], 'yield');
  } else if (mode === 'signal') {
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'opposing') });
  } else if (mode === 'lefts') {
    net.setJunctionControl(hub, { mode: 'signal', signal: defaultSignalPlan(net, hub, 'protectedLefts') });
  }
  net.setTraffic({ autoGatewayRatePerLane: rate });
  return net;
}
