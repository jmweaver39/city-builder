/** Placing zoned regions and keeping their access points in step. */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Id, ZoneKind, ZoneRegion } from '../core/types';
import { accessSpots, coverageOf, pointInPolygon, zoneCoverage, zonePolygon, zoneRates } from '../core/zones';

export const ZONE_NAMES: Record<ZoneKind | 'none', string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  industrial: 'Industrial',
  office: 'Office',
  none: 'Dezone',
};

export interface ZoneStats {
  area: number;
  ratePerHour: number;
  attraction: number;
  access: number;
}

export function zoneStats(net: RoadNetwork, id: Id): ZoneStats {
  const region = net.project.zones?.find((z) => z.id === id);
  if (!region || region.kind === 'none') return { area: 0, ratePerHour: 0, attraction: 0, access: 0 };
  const { area } = zoneCoverage(net, id);
  const rates = zoneRates(region.kind, region.density, area);
  return { area, ...rates, access: net.endpoints.filter((e) => e.regionId === id).length };
}

/** Replace a region's access points with fresh ones sharing its traffic. */
export function syncZoneAccess(net: RoadNetwork, id: Id): void {
  net.batch(() => {
    for (const e of net.endpoints.filter((x) => x.regionId === id)) net.removeEndpoint(e.id);
    const region = net.project.zones?.find((z) => z.id === id);
    if (!region || region.kind === 'none') return;
    const { area } = zoneCoverage(net, id);
    if (area <= 0) return;
    const spots = accessSpots(net, region, area);
    if (!spots.length) return;
    const rates = zoneRates(region.kind, region.density, area);
    spots.forEach((spot, i) => {
      net.addEndpoint({
        kind: region.kind as ZoneKind,
        name: `${region.name || ZONE_NAMES[region.kind]}${spots.length > 1 ? ` ${i + 1}` : ''}`,
        enabled: region.enabled,
        segmentId: spot.segmentId,
        t: spot.t,
        side: spot.side,
        ratePerHour: Math.round(rates.ratePerHour / spots.length),
        attraction: Math.round((rates.attraction / spots.length) * 10) / 10,
        regionId: id,
      });
    });
  });
}

export function syncAllZoneAccess(net: RoadNetwork): void {
  net.batch(() => {
    for (const z of [...(net.project.zones ?? [])]) syncZoneAccess(net, z.id);
  });
}

/**
 * Drop regions that nothing shows of any more: covered by later ones, or all road.
 * An eraser goes once nothing below it is left to erase.
 */
export function pruneZones(net: RoadNetwork): Id[] {
  const gone: Id[] = [];
  net.batch(() => {
    const zones = net.project.zones ?? [];
    zones.forEach((z, i) => {
      if (z.kind !== 'none') {
        if (zoneCoverage(net, z.id).area <= 0) gone.push(z.id);
        return;
      }
      const cells = coverageOf(net, zonePolygon(net, z), 0).cells;
      const below = zones.slice(0, i).filter((o) => o.kind !== 'none' && !gone.includes(o.id)).map((o) => zonePolygon(net, o));
      const useful = cells.some((c) => below.some((p) => pointInPolygon(c.x, c.z, p)));
      if (!useful) gone.push(z.id);
    });
    for (const id of gone) net.removeZone(id);
  });
  return gone;
}

/** Add regions, tidy what they cover, and give everything fresh access. One edit. */
export function placeZones(net: RoadNetwork, inits: Omit<ZoneRegion, 'id'>[]): Id[] {
  return net.batch(() => {
    const ids = inits.map((init) => net.addZone(init));
    pruneZones(net);
    syncAllZoneAccess(net);
    return ids.filter((id) => net.project.zones?.some((z) => z.id === id));
  });
}

/** The region on top at a point, ignoring erasers and roads. */
export function zoneAt(net: RoadNetwork, x: number, z: number): Id | null {
  const zones = net.project.zones ?? [];
  for (let i = zones.length - 1; i >= 0; i--) {
    const region = zones[i];
    if (!pointInPolygon(x, z, zonePolygon(net, region))) continue;
    if (region.kind === 'none') return null;
    const cells = zoneCoverage(net, region.id).cells;
    if (cells.some((c) => Math.abs(c.x - x) <= 2.5 && Math.abs(c.z - z) <= 2.5)) return region.id;
    return null;
  }
  return null;
}
