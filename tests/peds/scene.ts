/** Test towns for the pedestrian sim and the street detail placer. */
import { DEFAULT_ZONE_SETTINGS, fillBlock, RoadNetwork, type Id, type RoadAnchor, type Vec3, type ZoneKind } from '../../src/core';

export const v = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });
export const free = (x: number, z: number, y = 0): RoadAnchor => ({ kind: 'free', pos: v(x, z, y) });

/**
 * A 3 by 2 block grid of streets 200 m apart with an avenue through the middle
 * (signalised where it meets the streets), zoned blocks, and a highway well away
 * to the south that nothing walks to.
 */
export function town(): { net: RoadNetwork; signals: Id[]; highway: Id[] } {
  const net = new RoadNetwork();
  for (const z of [0, 200, 400]) net.drawRoad({ start: free(0, z), end: free(600, z), roadType: z === 200 ? 'avenue-4' : 'street-2' });
  for (const x of [0, 200, 400, 600]) net.drawRoad({ start: free(x, 0), end: free(x, 400), roadType: 'street-2' });
  // Through traffic: the avenue runs on out of town both ways to gateways.
  net.drawRoad({ start: { kind: 'node', id: net.nearestNode(v(600, 200), 1)!.nodeId }, end: free(1000, 200), roadType: 'avenue-4' });
  net.drawRoad({ start: free(-400, 200), end: { kind: 'node', id: net.nearestNode(v(0, 200), 1)!.nodeId }, roadType: 'avenue-4' });
  const signals: Id[] = [];
  for (const x of [200, 400]) {
    const n = net.nearestNode(v(x, 200), 1)!.nodeId;
    net.setJunctionControl(n, { mode: 'signal' });
    signals.push(n);
  }
  const zone = (x: number, z: number, kind: ZoneKind, density: 'low' | 'medium' | 'high' = 'low') => {
    const r = fillBlock(net, v(x, z), DEFAULT_ZONE_SETTINGS);
    if ('error' in r) throw new Error(r.error);
    net.addZone({ kind, density, enabled: true, name: kind, polygon: r.polygon, anchors: r.anchors, source: 'block', settings: { ...DEFAULT_ZONE_SETTINGS } });
  };
  zone(100, 100, 'residential');
  zone(300, 100, 'commercial', 'medium');
  zone(500, 100, 'residential', 'medium');
  zone(100, 300, 'office');
  zone(300, 300, 'residential');
  zone(500, 300, 'industrial');
  const hw = net.drawRoad({ start: free(-600, -400), end: free(1200, -400), roadType: 'highway-3' });
  return { net, signals, highway: hw.segments };
}
