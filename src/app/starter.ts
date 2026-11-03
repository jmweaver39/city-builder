/**
 * The first-run scene: a curved highway with an off-ramp and an on-ramp to a small
 * street network, with gateways and zones, so traffic is visible at once.
 *
 * Traffic drives on the right, and +z is right of a road heading +x, so the ramps
 * and streets lie on the +z side of the highway.
 */
import { cubicPoint, cubicTangentXZ } from '../core/bezier';
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, Vec3 } from '../core/types';

const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

export function buildStarterScene(net: RoadNetwork): void {
  net.batch(() => {
    net.setProjectName('Starter town');

    // The highway, one-way west to east.
    const west = net.addNode(v(-900, -260));
    const east = net.addNode(v(900, -180));
    const highway = net.addSegment(west, east, {
      c1: v(-420, -420),
      c2: v(320, -400),
      roadType: 'highway-3',
    });

    // The street grid, with stubs that end in gateways.
    const grid = new Map<string, Id>();
    const xs = [-260, -60, 140];
    const zs = [40, 190];
    for (const z of zs) {
      let prev: Id | null = null;
      for (const x of xs) {
        const id = net.addNode(v(x, z));
        grid.set(`${x},${z}`, id);
        if (prev !== null) net.addSegment(prev, id, { roadType: z === 40 ? 'avenue-4' : 'street-2' });
        prev = id;
      }
    }
    for (const x of xs) {
      net.addSegment(grid.get(`${x},40`)!, grid.get(`${x},190`)!, { roadType: 'street-2' });
    }
    const westStub = net.addNode(v(-480, 190));
    net.addSegment(westStub, grid.get('-260,190')!, { roadType: 'street-2' });
    const eastStub = net.addNode(v(380, 190));
    net.addSegment(grid.get('140,190')!, eastStub, { roadType: 'street-2' });

    // Off-ramp, leaving the highway on the right and easing round to the grid.
    const off = rampEnd(net, highway, 0.34);
    const offLanding = grid.get('-260,40')!;
    const offRoad = net.drawRoad({
      start: { kind: 'segment', id: highway, t: 0.34 },
      end: { kind: 'node', id: offLanding },
      c1: { x: off.point.x + off.dir.x * 150 + 30 * -off.dir.z, y: 0, z: off.point.z + off.dir.z * 150 + 30 * off.dir.x },
      c2: v(-260, -120),
      roadType: 'ramp-1',
    });

    // On-ramp, from the grid up to the highway. The highway id kept its a side, so
    // the second half is the segment leaving the off-ramp node.
    const offNode = offRoad.nodes[0];
    const mainline = net.getNode(offNode)!.segments.find((id) => net.getSegment(id)!.a === offNode && net.getSegment(id)!.roadType === 'highway-3')!;
    const on = rampEnd(net, mainline, 0.5);
    net.drawRoad({
      start: { kind: 'node', id: grid.get('140,40')! },
      end: { kind: 'segment', id: mainline, t: 0.5 },
      c1: v(140, -120),
      c2: { x: on.point.x - on.dir.x * 150 + 30 * -on.dir.z, y: 0, z: on.point.z - on.dir.z * 150 + 30 * on.dir.x },
      roadType: 'ramp-1',
    });

    // Gateways at every dead end, so the flows are explicit and easy to edit.
    net.addEndpoint({ kind: 'gateway', name: 'Highway west', nodeId: west, ratePerHour: 900, attraction: 1 });
    net.addEndpoint({ kind: 'gateway', name: 'Highway east', nodeId: east, ratePerHour: 0, attraction: 3 });
    net.addEndpoint({ kind: 'gateway', name: 'West road', nodeId: westStub, ratePerHour: 240, attraction: 1 });
    net.addEndpoint({ kind: 'gateway', name: 'East road', nodeId: eastStub, ratePerHour: 240, attraction: 1 });

    const zone = (x: number, z: number, kind: 'residential' | 'commercial' | 'office', name: string) => {
      const hit = net.nearestSegment(v(x, z), 30);
      if (hit) net.addEndpoint({ kind, name, segmentId: hit.segmentId, t: hit.t, side: 1, ratePerHour: 180, attraction: 2 });
    };
    zone(-160, 190, 'residential', 'Elm Street homes');
    zone(40, 40, 'commercial', 'Main Street shops');
    zone(40, 190, 'office', 'Riverside offices');
  });
}

function rampEnd(net: RoadNetwork, id: Id, t: number): { point: Vec3; dir: Vec3 } {
  const c = net.cubicOf(id);
  return { point: cubicPoint(c, t), dir: cubicTangentXZ(c, t) };
}
