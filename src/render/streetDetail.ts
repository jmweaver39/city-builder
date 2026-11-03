/**
 * Close-up street detail: bins, benches, hydrants, trees in pits, bus shelters,
 * yard and work-yard clutter, highway posts, field fences, hay and animals, and
 * road fittings. Placement lives in streetDetailPlace.ts (pure, tested); this
 * file builds the models and draws them instanced, one mesh per prop type.
 *
 * Only an area round the camera target is generated, only while the camera is
 * close, and everything fades out with distance; zoomed out the layer is hidden
 * and does no work at all. Generated sources are cached by segment, node, lot and
 * ground cell, and an edit drops only the ones near it.
 */
import * as THREE from 'three';
import type { RoadNetwork, NetworkChange } from '../core/RoadNetwork';
import type { Id } from '../core/types';
import type { CameraPose } from './api';
import type { RenderContext, RenderLayer } from './context';
import type { QualitySettings } from './quality';
import { C, PropGeo, propMaterial, type FadeUniforms } from './propKit';
import { BODY_COLOURS, CONTAINER_COLOURS, PALETTE, rgb } from './style';
import { hexRGB, type RGB } from './constants';
import {
  COUNTRY_CELL,
  countryProps,
  lotProps,
  makeContext,
  nodeProps,
  P_BENCH,
  P_BIKE_RACK,
  P_BIN,
  P_BOLLARD,
  P_BUS_SIGN,
  P_CAFE,
  P_CAR,
  P_CONTAINER,
  P_COW,
  P_CRATE,
  P_DEBRIS,
  P_DRAIN,
  P_DRIVEWAY,
  P_DUMPSTER,
  P_FENCE,
  P_FLOWERS,
  P_GARDEN_SET,
  P_GATE,
  P_HAY_BALE,
  P_HYDRANT,
  P_KM_POST,
  P_LEAVES,
  P_LITTER,
  P_MAILBOX,
  P_MANHOLE,
  P_PALLET,
  P_PLANTER,
  P_PUDDLE,
  P_ROCK,
  P_SHEEP,
  P_SHELTER,
  P_SHOP_SIGN,
  P_SOS_PHONE,
  P_SWING,
  P_TREE,
  P_TYRE_MARK,
  P_UTILITY_MARK,
  P_WHEELIE_BIN,
  PROP_TYPES,
  segmentProps,
  type PlaceContext,
  type Prop,
} from './streetDetailPlace';

/** Camera distance (orbit) beyond which the layer switches off. */
export const DETAIL_ON_DISTANCE = 330;

const DECAL_TYPES = new Set([P_MANHOLE, P_DRAIN, P_UTILITY_MARK, P_TYRE_MARK, P_PUDDLE, P_DRIVEWAY, P_LITTER, P_LEAVES]);

// ---------------------------------------------------------------------------
// Models. Local frame: x along the street, +z away from the road, y up, origin on the ground.
// ---------------------------------------------------------------------------

const WHITE: RGB = [1, 1, 1];
const STEEL = rgb('steel');
const DARK = C(0x2c2f33);
const IRON = C(0x3c3f42);
const WOOD = C(0x9a7450);
const WOOD_DARK = C(0x6e5238);
const CONCRETE = rgb('concrete');
const LEAF = rgb('leaf');
const GLASS = C(0x8fb4c8);
const TYRE = C(0x1c1d1f);

function model(type: number): THREE.BufferGeometry {
  const g = new PropGeo();
  switch (type) {
    case P_BIN:
      g.cyl(0, 0, 0, 0.24, 0.88, 0.26, WHITE, 1, 10);
      g.cyl(0, 0.88, 0, 0.28, 0.94, 0.28, DARK, 0, 10);
      break;
    case P_BENCH:
      for (const x of [-0.75, 0.75]) g.box(x, 0.22, 0, 0.04, 0.22, 0.22, IRON);
      g.box(0, 0.46, -0.04, 0.85, 0.035, 0.22, WOOD);
      g.box(0, 0.74, 0.2, 0.85, 0.12, 0.025, WOOD);
      break;
    case P_HYDRANT:
      g.cyl(0, 0, 0, 0.14, 0.08, 0.14, C(0xb02a22), 0, 8);
      g.cyl(0, 0.08, 0, 0.11, 0.58, 0.11, C(0xd23a2c), 0, 8);
      g.blob(0, 0.6, 0, 0.12, 0.08, 0.12, C(0xe8c040));
      g.box(0, 0.42, 0, 0.18, 0.04, 0.04, C(0xd23a2c));
      break;
    case P_MAILBOX:
      g.box(0, 0.5, 0, 0.04, 0.5, 0.04, DARK);
      g.box(0, 1.05, 0, 0.24, 0.16, 0.2, WHITE, 1);
      break;
    case P_BIKE_RACK:
      for (const x of [-0.8, 0, 0.8]) {
        g.box(x, 0.4, -0.25, 0.025, 0.4, 0.025, STEEL);
        g.box(x, 0.4, 0.25, 0.025, 0.4, 0.025, STEEL);
        g.box(x, 0.8, 0, 0.025, 0.025, 0.27, STEEL);
      }
      for (const x of [-0.4, 0.4]) {
        // A parked bike, wheels at either end, frame in the instance colour.
        g.cylX(x - 0.03, x + 0.03, 0.33, -0.55, 0.33, TYRE, 0, 8);
        g.cylX(x - 0.03, x + 0.03, 0.33, 0.5, 0.33, TYRE, 0, 8);
        g.box(x, 0.55, -0.02, 0.025, 0.04, 0.5, WHITE, 1);
        g.box(x, 0.45, 0.2, 0.025, 0.2, 0.025, WHITE, 1);
        g.box(x, 0.86, -0.4, 0.2, 0.02, 0.02, DARK);
      }
      break;
    case P_PLANTER:
      g.box(0, 0.25, 0, 0.5, 0.25, 0.5, CONCRETE);
      g.blob(0, 0.72, 0, 0.45, 0.32, 0.45, WHITE, 1, 3, 7);
      break;
    case P_BOLLARD:
      g.cyl(0, 0, 0, 0.1, 0.9, 0.09, DARK, 0, 8);
      g.cyl(0, 0.72, 0, 0.095, 0.8, 0.095, C(0xe8e4dc), 0, 8, false);
      break;
    case P_TREE:
      g.flat(0, 0.01, 0, 0.6, 0.6, C(0x4a4c4e));
      g.cyl(0, 0, 0, 0.12, 2.6, 0.09, rgb('trunk'), 0, 6);
      g.blob(0, 3.6, 0, 1.6, 1.5, 1.6, WHITE, 1, 4, 8);
      g.blob(0.5, 4.5, 0.3, 1.1, 1.0, 1.1, WHITE, 1, 3, 7);
      break;
    case P_LITTER:
      g.box(0.1, 0.03, 0, 0.09, 0.025, 0.06, WHITE, 1);
      g.box(-0.15, 0.04, 0.1, 0.035, 0.035, 0.06, C(0xc83a30), 0);
      g.flat(0.02, 0.012, -0.14, 0.08, 0.05, C(0xe8e4d8), 0, 0.6);
      break;
    case P_LEAVES:
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4;
        const r = 0.12 + (i % 3) * 0.12;
        g.flat(Math.cos(a) * r, 0.01 + i * 0.001, Math.sin(a) * r, 0.07, 0.045, WHITE, 1, a);
      }
      break;
    case P_DUMPSTER:
      g.box(0, 0.62, 0, 0.95, 0.52, 0.6, WHITE, 1);
      g.box(0, 1.16, 0.02, 0.98, 0.04, 0.62, C(0x2a2c2e));
      for (const x of [-0.75, 0.75]) for (const z of [-0.45, 0.45]) g.cyl(x, 0, z, 0.06, 0.12, 0.06, TYRE, 0, 6);
      break;
    case P_PALLET:
      g.box(0, 0.07, 0, 0.6, 0.07, 0.5, WOOD);
      g.box(0, 0.45, 0, 0.5, 0.3, 0.42, C(0xb88a5a), 1);
      break;
    case P_CAFE:
      g.cyl(0, 0, 0, 0.04, 0.72, 0.04, DARK, 0, 6);
      g.cyl(0, 0.72, 0, 0.38, 0.75, 0.38, WHITE, 0, 10);
      for (const x of [-0.65, 0.65]) {
        g.box(x, 0.45, 0, 0.2, 0.025, 0.2, DARK);
        g.box(x + Math.sign(x) * 0.19, 0.68, 0, 0.02, 0.22, 0.2, DARK);
        g.box(x, 0.22, 0, 0.16, 0.22, 0.16, DARK);
      }
      g.cyl(0, 0.75, 0, 0.03, 2.3, 0.03, DARK, 0, 6);
      g.cyl(0, 1.95, 0, 1.2, 2.35, 0.05, WHITE, 1, 10);
      break;
    case P_SHOP_SIGN:
      g.box(0, 0.45, -0.12, 0.28, 0.45, 0.02, WHITE, 1, 0);
      g.box(0, 0.45, 0.12, 0.28, 0.45, 0.02, WHITE, 1, 0);
      g.box(0, 0.6, -0.125, 0.22, 0.2, 0.01, C(0x24282c));
      break;
    case P_WHEELIE_BIN:
      g.box(0, 0.52, 0, 0.3, 0.48, 0.34, WHITE, 1);
      g.box(0, 1.02, 0.02, 0.31, 0.03, 0.37, DARK);
      g.cylX(-0.3, 0.3, 0.1, 0.3, 0.1, TYRE, 0, 6);
      break;
    case P_GARDEN_SET:
      g.cyl(0, 0, 0, 0.04, 0.7, 0.04, WHITE, 0, 6);
      g.cyl(0, 0.7, 0, 0.5, 0.74, 0.5, WHITE, 1, 10);
      for (let i = 0; i < 4; i++) {
        const a = i * (Math.PI / 2) + 0.4;
        const x = Math.cos(a) * 0.85;
        const z = Math.sin(a) * 0.85;
        g.box(x, 0.42, z, 0.2, 0.025, 0.2, WHITE, 1, a);
        g.box(x * 1.2, 0.65, z * 1.2, 0.2, 0.22, 0.02, WHITE, 1, -a + Math.PI / 2);
        g.box(x, 0.2, z, 0.16, 0.2, 0.16, WHITE, 1, a);
      }
      break;
    case P_SWING:
      for (const x of [-1.2, 1.2]) {
        g.box(x, 1.1, -0.45, 0.04, 1.12, 0.04, WHITE, 1);
        g.box(x, 1.1, 0.45, 0.04, 1.12, 0.04, WHITE, 1);
      }
      g.box(0, 2.2, 0, 1.28, 0.045, 0.045, WHITE, 1);
      for (const x of [-0.5, 0.5]) {
        g.box(x - 0.18, 1.35, 0, 0.008, 0.85, 0.008, DARK);
        g.box(x + 0.18, 1.35, 0, 0.008, 0.85, 0.008, DARK);
        g.box(x, 0.5, 0, 0.22, 0.02, 0.12, C(0x3a3c40));
      }
      break;
    case P_CAR:
      g.box(0, 0.48, 0, 2.15, 0.32, 0.88, WHITE, 1);
      g.box(-0.15, 0.98, 0, 1.25, 0.2, 0.78, C(0x2a3a4a));
      g.box(-0.15, 1.19, 0, 1.15, 0.02, 0.74, WHITE, 1);
      for (const x of [-1.35, 1.35]) for (const z of [-0.82, 0.82]) g.cylX(x - 0.3, x + 0.3, 0.32, z, 0.32, TYRE, 0, 8);
      break;
    case P_CRATE:
      g.box(0, 0.45, 0, 0.45, 0.45, 0.45, WOOD);
      g.box(0, 0.45, -0.452, 0.4, 0.04, 0.005, WOOD_DARK);
      break;
    case P_CONTAINER:
      g.box(0, 1.3, 0, 3.05, 1.3, 1.22, WHITE, 1, 0, true);
      for (let x = -2.7; x <= 2.7; x += 0.6) {
        g.box(x, 1.3, -1.235, 0.04, 1.2, 0.02, WHITE, 1);
        g.box(x, 1.3, 1.235, 0.04, 1.2, 0.02, WHITE, 1);
      }
      break;
    case P_PUDDLE:
      g.disc(0, 0.03, 0, 1.1, C(0x4e5a62), 0, 12, 1.4);
      g.disc(0.3, 0.032, 0.15, 0.6, C(0x5c6a74), 0, 10, 1.2);
      break;
    case P_SOS_PHONE:
      g.box(0, 0.55, 0, 0.05, 0.55, 0.05, C(0x5a6066));
      g.box(0, 1.25, 0, 0.22, 0.32, 0.16, C(0xf07a28));
      g.box(0, 1.3, -0.165, 0.12, 0.12, 0.01, C(0x2a2c2e));
      break;
    case P_KM_POST:
      g.box(0, 0.5, 0, 0.05, 0.5, 0.05, C(0xf2f0ea));
      g.box(0, 0.95, -0.055, 0.1, 0.09, 0.005, C(0x2a7a48));
      break;
    case P_DEBRIS:
      g.box(0, 0.04, 0, 0.32, 0.04, 0.12, WHITE, 1, 0.3);
      g.box(0.25, 0.03, 0.2, 0.12, 0.03, 0.1, C(0x3a3c3e), 0, 1.2);
      g.box(-0.2, 0.025, -0.18, 0.08, 0.025, 0.16, C(0x6a5a4a), 0, -0.7);
      break;
    case P_TYRE_MARK:
      for (const z of [-0.8, 0.8]) g.flat(0, 0.005, z, 0.5, 0.11, C(0x1a1b1d));
      break;
    case P_FENCE:
      g.box(-1.5, 0.6, 0, 0.06, 0.6, 0.06, WOOD_DARK);
      g.box(0, 0.95, 0, 1.5, 0.05, 0.025, WOOD);
      g.box(0, 0.55, 0, 1.5, 0.05, 0.025, WOOD);
      break;
    case P_GATE:
      for (const x of [-1.5, 1.5]) g.box(x, 0.65, 0, 0.07, 0.65, 0.07, WOOD_DARK);
      for (const y of [0.25, 0.6, 0.95]) g.box(0, y, 0, 1.4, 0.03, 0.02, C(0xb8bec2));
      g.box(0, 0.6, 0, 1.4, 0.03, 0.02, C(0xb8bec2), 0, 0);
      g.quad([-1.4, 0.25, 0.01], [1.4, 0.95, 0.01], [1.4, 0.99, 0.01], [-1.4, 0.29, 0.01], C(0xb8bec2));
      break;
    case P_HAY_BALE:
      g.cylX(-0.6, 0.6, 0.68, 0, 0.68, C(0xd2b46a), 0, 12);
      break;
    case P_COW:
      g.box(0, 1.0, 0, 0.95, 0.38, 0.38, WHITE, 1);
      g.box(1.1, 1.15, 0, 0.25, 0.2, 0.17, WHITE, 1);
      g.box(1.32, 1.05, 0, 0.08, 0.1, 0.13, C(0xd8a8a0));
      for (const x of [-0.7, 0.7]) for (const z of [-0.24, 0.24]) g.box(x, 0.32, z, 0.08, 0.32, 0.08, WHITE, 1);
      g.blob(-0.2, 1.15, 0.36, 0.3, 0.22, 0.04, C(0xf2f0ea));
      break;
    case P_SHEEP:
      g.blob(0, 0.62, 0, 0.55, 0.32, 0.32, C(0xeae4d6), 0, 3, 7);
      g.box(0.55, 0.72, 0, 0.13, 0.12, 0.1, C(0x2a2826));
      for (const x of [-0.3, 0.3]) for (const z of [-0.15, 0.15]) g.box(x, 0.18, z, 0.04, 0.18, 0.04, C(0x2a2826));
      break;
    case P_ROCK:
      g.blob(0, 0.15, 0, 0.6, 0.38, 0.5, WHITE, 1, 3, 6);
      break;
    case P_FLOWERS:
      for (let i = 0; i < 7; i++) {
        const a = i * 2.6;
        const r = 0.1 + (i % 3) * 0.13;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        g.blob(x, 0.12, z, 0.12, 0.12, 0.12, LEAF, 0, 2, 5);
        g.blob(x, 0.28, z, 0.06, 0.04, 0.06, WHITE, 1, 2, 5);
      }
      break;
    case P_MANHOLE:
      g.disc(0, 0, 0, 0.36, C(0x3a3a38), 0, 14);
      g.disc(0, 0.002, 0, 0.28, C(0x4a4844), 0, 14);
      break;
    case P_DRAIN:
      g.flat(0, 0, 0, 0.42, 0.2, C(0x2e2f30));
      for (let x = -0.32; x <= 0.33; x += 0.08) g.flat(x, 0.002, 0, 0.015, 0.16, C(0x151617));
      break;
    case P_UTILITY_MARK:
      g.flat(0, 0, 0, 0.5, 0.04, WHITE, 1);
      g.flat(0.5, 0.001, 0, 0.12, 0.12, WHITE, 1, Math.PI / 4);
      break;
    case P_SHELTER:
      for (const x of [-1.45, 1.45]) for (const z of [-0.65, 0.65]) g.box(x, 1.25, z, 0.04, 1.25, 0.04, STEEL);
      g.box(0, 2.52, 0, 1.6, 0.05, 0.8, C(0x50565c));
      g.box(0, 1.35, 0.66, 1.42, 0.95, 0.015, GLASS);
      g.box(-1.46, 1.35, 0, 0.015, 0.95, 0.62, GLASS);
      g.box(0, 0.45, 0.42, 1.1, 0.03, 0.18, WOOD);
      g.box(1.46, 1.45, 0.1, 0.02, 0.75, 0.42, C(0x2a6ac8));
      break;
    case P_BUS_SIGN:
      g.cyl(0, 0, 0, 0.04, 2.7, 0.04, STEEL, 0, 6);
      g.box(0, 2.55, 0, 0.26, 0.26, 0.02, C(0x2a6ac8));
      g.box(0, 2.55, -0.022, 0.16, 0.12, 0.003, C(0xf2c23a));
      break;
    case P_DRIVEWAY:
      g.flat(0, 0.015, 0, 1.4, 2.7, C(0xb4aea2));
      break;
  }
  return g.toGeometry();
}

/** Instance colours per type. Types not listed are untinted. */
const PALETTES: Partial<Record<number, RGB[]>> = {
  [P_BIN]: [C(0x2f5a3e), C(0x3a4a5a), C(0x2a2c30)],
  [P_MAILBOX]: [C(0x2a5aa8), C(0xc23a2c), C(0xe8b830)],
  [P_BIKE_RACK]: BODY_COLOURS,
  [P_PLANTER]: [rgb('leafLight'), C(0x6a8a3a), C(0x8a5a8a), C(0xc86a4a)],
  [P_TREE]: [rgb('leaf'), rgb('leafLight'), C(0x5a7a3a), rgb('leafAutumn')],
  [P_LITTER]: [C(0xe8e4d8), C(0xf2f0ea), C(0x8ab0d8), C(0xd8c890), C(0xe8e4d8), C(0xc8d8b0), C(0xf0d0c0), C(0xe0e0e0)],
  [P_LEAVES]: [C(0xa8763a), C(0xc8943a), C(0x8a6a3a), C(0xb4582e)],
  [P_DUMPSTER]: [C(0x2f6a48), C(0x2a5aa8), C(0x5a5e66), C(0x8a5a3a)],
  [P_PALLET]: [C(0xb88a5a), C(0x9a9aa0)],
  [P_CAFE]: [C(0xe8e0d0), C(0xc8463a), C(0x2a6a8a), C(0x3a7a4a), C(0xe8b830), C(0xf2f0ea), C(0x8a3a5a), C(0x4a4e8a)],
  [P_SHOP_SIGN]: [C(0x2a2c30), C(0x7a2a22), C(0x1f4a6a), C(0x2a5a3a), C(0xe8dcc2), C(0x4a3a2a), C(0x3a3a5a), C(0x5a2a4a)],
  [P_WHEELIE_BIN]: [C(0x3a6a3a), C(0x2a4a8a), C(0x4a4e54), C(0x6a4a2e)],
  [P_GARDEN_SET]: [C(0xf2f0ea), C(0x9a7450), C(0x3a4a3a), C(0x5a6a7a)],
  [P_SWING]: [C(0x9a7450), C(0x3a6aa8), C(0xc84a3a), C(0x4a8a4a)],
  [P_CAR]: BODY_COLOURS,
  [P_CONTAINER]: CONTAINER_COLOURS,
  [P_DEBRIS]: [C(0x2a2b2d), C(0x6a5a4a), C(0x8a8a86), C(0x3a3c3e)],
  [P_COW]: [C(0x3a2a22), C(0x1e1c1c), C(0xe8e2d8), C(0x9a6a46)],
  [P_ROCK]: [hexRGB(PALETTE.rock), hexRGB(PALETTE.rockDark), C(0xa8a49a), C(0x8a8678)],
  [P_FLOWERS]: [C(0xf2e050), C(0xe8e8f0), C(0xd85a8a), C(0x8a6ad8), C(0xf08a3a), C(0xd83a3a)],
  [P_UTILITY_MARK]: [C(0xd8402f), C(0x3e7fd6), C(0xe2b33c), C(0xf07a28)],
};

interface Source {
  props: Prop[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

function boundsOf(props: Prop[], fallback: { x: number; z: number; r: number }): Source {
  let minX = fallback.x - fallback.r;
  let minZ = fallback.z - fallback.r;
  let maxX = fallback.x + fallback.r;
  let maxZ = fallback.z + fallback.r;
  for (const p of props) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { props, minX, minZ, maxX, maxZ };
}

const DENSITY: Record<string, number> = { low: 0.4, medium: 0.7, high: 1, ultra: 1.25 };

export class StreetDetailLayer implements RenderLayer {
  readonly group = new THREE.Group();
  enabled = true;
  private fade: FadeUniforms = { uFadeNear: { value: 170 }, uFadeFar: { value: 250 } };
  private meshes: THREE.InstancedMesh[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private cache = new Map<string, Source>();
  private place: PlaceContext | null = null;
  private placeVersion = -1;
  private density = 1;
  private wantedKey = '';
  private dirtyInstances = true;
  private rebuildTimer = 0;
  private off: () => void;
  /** Milliseconds spent this frame and last instance count, for the readout and tests. */
  readonly stats = { genMs: 0, instances: 0, sources: 0, updateMs: 0 };

  constructor(
    private readonly net: RoadNetwork,
    ctx: RenderContext,
    private readonly pose: () => CameraPose,
  ) {
    const mat = propMaterial(this.fade);
    const decal = propMaterial(this.fade, { decal: true });
    this.mats.push(mat, decal);
    for (let t = 0; t < PROP_TYPES; t++) {
      const geo = model(t);
      this.geos.push(geo);
      const mesh = new THREE.InstancedMesh(geo, DECAL_TYPES.has(t) ? decal : mat, 16);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.receiveShadow = !DECAL_TYPES.has(t);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.name = `detail-${t}`;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.group.name = 'street-detail';
    ctx.scene.add(this.group);
    this.off = net.onChange((e) => this.onChange(e));
  }

  setQuality(q: QualitySettings): void {
    const d = DENSITY[q.name] ?? 1;
    if (d !== this.density) {
      this.density = d;
      this.cache.clear();
      this.place = null;
      this.dirtyInstances = true;
    }
  }

  private onChange(e: NetworkChange): void {
    if (e.reset || e.endpointsChanged || e.settingsChanged) {
      this.cache.clear();
      this.place = null;
      this.dirtyInstances = true;
      return;
    }
    // Drop sources near anything that changed: their props may now be in the way.
    const boxes: [number, number, number, number][] = [];
    const pad = 45;
    for (const id of [...e.dirtySegments, ...e.removedSegments]) {
      const src = this.cache.get(`s${id}`);
      if (src) boxes.push([src.minX - pad, src.minZ - pad, src.maxX + pad, src.maxZ + pad]);
      const c = this.net.getSegment(id) ? this.net.cubicOf(id) : null;
      if (c) {
        const xs = [c.p0.x, c.p1.x, c.p2.x, c.p3.x];
        const zs = [c.p0.z, c.p1.z, c.p2.z, c.p3.z];
        boxes.push([Math.min(...xs) - pad, Math.min(...zs) - pad, Math.max(...xs) + pad, Math.max(...zs) + pad]);
      }
    }
    for (const id of [...e.dirtyNodes, ...e.removedNodes]) {
      const src = this.cache.get(`n${id}`);
      if (src) boxes.push([src.minX - pad, src.minZ - pad, src.maxX + pad, src.maxZ + pad]);
      const n = this.net.getNode(id);
      if (n) boxes.push([n.pos.x - pad - 40, n.pos.z - pad - 40, n.pos.x + pad + 40, n.pos.z + pad + 40]);
    }
    if (!boxes.length) return;
    for (const [key, src] of this.cache) {
      if (boxes.some((b) => src.maxX >= b[0] && src.minX <= b[2] && src.maxZ >= b[1] && src.minZ <= b[3])) this.cache.delete(key);
    }
    this.place = null;
    this.dirtyInstances = true;
  }

  update(dt: number): void {
    const t0 = performance.now();
    const pose = this.pose();
    const on = this.enabled && pose.distance < DETAIL_ON_DISTANCE;
    this.group.visible = on;
    if (!on) {
      this.stats.updateMs = 0;
      return;
    }
    // Fade out over the far part of the populated area.
    const R = Math.min(380, Math.max(200, pose.distance * 1.3 + 120));
    this.fade.uFadeNear.value = R * 0.62;
    this.fade.uFadeFar.value = R * 0.9;
    if (!this.place || this.placeVersion !== this.net.version) {
      this.place = makeContext(this.net, this.density, 1);
      this.placeVersion = this.net.version;
    }
    const ctx = this.place;
    const tx = pose.target.x;
    const tz = pose.target.z;
    const box = { minX: tx - R, minZ: tz - R, maxX: tx + R, maxZ: tz + R };
    const wanted: string[] = [];
    const jobs: (() => Source)[] = [];
    const want = (key: string, make: () => Source) => {
      wanted.push(key);
      if (!this.cache.has(key)) jobs.push(() => {
        const s = make();
        this.cache.set(key, s);
        return s;
      });
    };
    for (const id of this.net.segmentsInRegion(box, true)) {
      want(`s${id}`, () => {
        const c = this.net.cubicOf(id);
        return boundsOf(segmentProps(ctx, id), { x: c.p0.x, z: c.p0.z, r: 1 });
      });
    }
    for (const id of this.net.nodesInRegion(box)) {
      const n = this.net.getNode(id)!;
      want(`n${id}`, () => boundsOf(nodeProps(ctx, id), { x: n.pos.x, z: n.pos.z, r: 1 }));
    }
    for (const lot of ctx.lots.near(tx, tz, R)) {
      const key = `l${lot.owner}:${Math.round(lot.centre.x * 2)},${Math.round(lot.centre.z * 2)}`;
      want(key, () => boundsOf(lotProps(ctx, lot), { x: lot.centre.x, z: lot.centre.z, r: Math.max(lot.w, lot.d) / 2 }));
    }
    const CC = COUNTRY_CELL;
    for (let ix = Math.floor(box.minX / CC); ix <= Math.floor(box.maxX / CC); ix++) {
      for (let iz = Math.floor(box.minZ / CC); iz <= Math.floor(box.maxZ / CC); iz++) {
        want(`c${ix},${iz}`, () => boundsOf(countryProps(ctx, ix, iz), { x: (ix + 0.5) * CC, z: (iz + 0.5) * CC, r: CC / 2 }));
      }
    }
    // Generate what is missing, a few milliseconds a frame.
    let genMs = 0;
    if (jobs.length) {
      const start = performance.now();
      for (const job of jobs) {
        job();
        this.dirtyInstances = true;
        if (performance.now() - start > 6) break;
      }
      genMs = performance.now() - start;
    }
    this.stats.genMs = genMs;
    const key = wanted.join('|');
    if (key !== this.wantedKey) {
      this.wantedKey = key;
      this.dirtyInstances = true;
    }
    this.rebuildTimer -= dt;
    if (this.dirtyInstances && this.rebuildTimer <= 0) {
      this.rebuildTimer = 0.2;
      this.dirtyInstances = false;
      this.fill(wanted);
    }
    // Forget sources far away, so memory stays bounded.
    if (this.cache.size > wanted.length * 3 + 400) {
      const keep = new Set(wanted);
      for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
    }
    this.stats.updateMs = performance.now() - t0;
  }

  private fill(keys: string[]): void {
    const counts = new Array<number>(PROP_TYPES).fill(0);
    const sources: Source[] = [];
    for (const k of keys) {
      const s = this.cache.get(k);
      if (!s) continue;
      sources.push(s);
      for (const p of s.props) counts[p.type]++;
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let total = 0;
    for (let t = 0; t < PROP_TYPES; t++) {
      const n = counts[t];
      let mesh = this.meshes[t];
      if (n > mesh.instanceMatrix.count) {
        const cap = Math.max(n, mesh.instanceMatrix.count * 2);
        const next = new THREE.InstancedMesh(mesh.geometry, mesh.material, cap);
        next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        next.receiveShadow = mesh.receiveShadow;
        next.castShadow = false;
        next.frustumCulled = false;
        next.name = mesh.name;
        this.group.remove(mesh);
        mesh.dispose();
        this.group.add(next);
        this.meshes[t] = mesh = next;
      }
      mesh.count = n;
      total += n;
    }
    const fillAt = new Array<number>(PROP_TYPES).fill(0);
    for (const s of sources) {
      for (const p of s.props) {
        const mesh = this.meshes[p.type];
        const i = fillAt[p.type]++;
        q.setFromAxisAngle(up, p.yaw);
        pos.set(p.x, p.y, p.z);
        scl.set(p.s * p.l, p.s, p.s);
        m4.compose(pos, q, scl);
        mesh.setMatrixAt(i, m4);
        const pal = PALETTES[p.type];
        if (pal) {
          const c = pal[p.c % pal.length];
          col.setRGB(c[0], c[1], c[2]);
          mesh.setColorAt(i, col);
        }
      }
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.stats.instances = total;
    this.stats.sources = sources.length;
  }

  /** Every prop currently placed, for tests and debugging. */
  placed(): Prop[] {
    const out: Prop[] = [];
    for (const k of this.wantedKey.split('|')) for (const p of this.cache.get(k)?.props ?? []) out.push(p);
    return out;
  }

  dispose(): void {
    this.off();
    for (const m of this.meshes) m.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

export type { Id };
