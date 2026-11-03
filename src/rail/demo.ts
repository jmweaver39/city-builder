/**
 * The rail demo: a double-track main line across the map with a level crossing,
 * a commuter line and through freight on it, and a three-station subway line
 * under the town. Trains are visible within seconds of loading it.
 */
import { cubicPoint } from '../core/bezier';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, Vec3 } from '../core/types';
import { closestPointOnCubic } from '../core/bezier';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

/** Where the camera should look first. */
export const RAIL_DEMO_CAMERA = { target: { x: -520, y: 0, z: -560 }, distance: 1250, yaw: 0.25, pitch: 0.8 };

/** The rail segment nearest a point. */
function railNear(net: RoadNetwork, p: Vec3): Id {
  let best: Id = -1;
  let bestD = Infinity;
  for (const s of net.segments) {
    if (net.roadTypeOf(s.id).category !== 'rail') continue;
    const hit = closestPointOnCubic(net.cubicOf(s.id), p);
    if (Math.abs(hit.point.y - p.y) > 3) continue;
    if (hit.distance < bestD) {
      bestD = hit.distance;
      best = s.id;
    }
  }
  return best;
}

export function buildRailDemo(net: RoadNetwork): void {
  net.batch(() => {
    net.setProjectName('Rail demo');

    // Main line, double track, a long gentle S from edge to edge.
    const west = net.addNode(v(-1990, -720));
    const east = net.addNode(v(1990, -680));
    const main = net.addSegment(west, east, { c1: v(-700, -830), c2: v(700, -570), roadType: 'rail-double' });

    // A street crossing it at grade, with traffic at both ends.
    const road = net.drawRoad({ start: { kind: 'free', pos: v(-620, -1150) }, end: { kind: 'free', pos: v(-560, -250) }, roadType: 'street-2' });
    const ends = road.nodes.length ? [road.nodes[0], road.nodes[road.nodes.length - 1]] : [];
    for (const [i, n] of ends.entries()) net.addEndpoint({ kind: 'gateway', name: i ? 'North road' : 'South road', nodeId: n, ratePerHour: 420, attraction: 1 });
    void main;

    const station = (name: string, x: number, length: number, kind: 'surface' | 'gateway' = 'surface'): Id => {
      const seg = railNear(net, v(x, -700));
      const cubic = net.cubicOf(seg);
      // Gateways sit at the track end; stations where the line passes x.
      let at = x < 0 ? 0.0005 : 0.9995;
      if (kind !== 'gateway') {
        let lo = 0;
        let hi = 1;
        const rising = cubicPoint(cubic, 1).x > cubicPoint(cubic, 0).x;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2;
          if ((cubicPoint(cubic, mid).x < x) === rising) lo = mid;
          else hi = mid;
        }
        at = (lo + hi) / 2;
      } else {
        const p = cubicPoint(cubic, 0);
        at = Math.abs(p.x - x) < 20 ? 0.0005 : 0.9995;
      }
      return net.addStation({ name, kind, segmentId: seg, t: at, platformLength: length });
    };
    const westYard = station('West yard', -1990, 0, 'gateway');
    const eastYard = station('East yard', 1990, 0, 'gateway');
    const westgate = station('Westgate', -1250, 260);
    const central = station('Central', 80, 300);
    const eastbank = station('Eastbank', 1250, 260);

    net.addLine({ name: 'Commuter', color: '#2f8fe0', stops: [westgate, central, eastbank], trainType: 'emu', cars: 8, trains: 3 });
    net.addLine({ name: 'Freight', color: '#ef7d2a', stops: [westYard, eastYard], trainType: 'freight', cars: 72, trains: 2, headwaySec: 200 });

    // Subway under the town, 12 m down, north of the main line.
    const m0 = net.addNode(v(-1000, -180, -12));
    const m1 = net.addNode(v(1000, -140, -12));
    const metro = net.addSegment(m0, m1, { c1: v(-350, -260, -12), c2: v(350, -60, -12), roadType: 'metro-double' });
    const sub = (name: string, t: number) => net.addStation({ name, kind: 'underground', segmentId: metro, t, platformLength: 180 });
    const s1 = sub('Library', 0.13);
    const s2 = sub('Town Hall', 0.5);
    const s3 = sub('Hospital', 0.87);
    net.addLine({ name: 'M1', color: '#e8423a', stops: [s1, s2, s3], trainType: 'metro', cars: 8, trains: 3 });
  });
}
