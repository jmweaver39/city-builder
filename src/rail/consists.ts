/**
 * Rolling stock: real dimensions and masses per vehicle kind, the behaviour of each
 * train type, and how a consist is made up. Offsets run from the consist front.
 */
import type { TrainTypeId } from '../core/railTypes';
import { RailRng } from './rng';

export interface CarKindDef {
  id: string;
  /** Over the body, metres. */
  length: number;
  width: number;
  height: number;
  /** Distance between bogie centres. */
  bogieSpacing: number;
  /** Mass in tonnes, empty. */
  tare: number;
  /** Added mass in tonnes when loaded. */
  payload: number;
  /** Seats or standing room. */
  capacity: number;
}

export const CAR = {
  metroCab: 0,
  metroCar: 1,
  emuCab: 2,
  emuCar: 3,
  electricLoco: 4,
  coach: 5,
  cabCar: 6,
  hsNose: 7,
  hsCar: 8,
  dieselLoco: 9,
  boxcar: 10,
  tanker: 11,
  hopper: 12,
  flatcar: 13,
  doubleStack: 14,
  autorack: 15,
  bilevel: 16,
  bilevelCab: 17,
} as const;

export const CAR_KINDS: readonly CarKindDef[] = [
  { id: 'metroCab', length: 20.5, width: 2.95, height: 3.65, bogieSpacing: 13.5, tare: 36, payload: 16, capacity: 210 },
  { id: 'metroCar', length: 19.8, width: 2.95, height: 3.65, bogieSpacing: 13.5, tare: 33, payload: 18, capacity: 240 },
  { id: 'emuCab', length: 25.5, width: 3.0, height: 4.05, bogieSpacing: 18, tare: 44, payload: 14, capacity: 200 },
  { id: 'emuCar', length: 25, width: 3.0, height: 4.05, bogieSpacing: 18, tare: 40, payload: 16, capacity: 230 },
  { id: 'electricLoco', length: 19.6, width: 3.0, height: 4.2, bogieSpacing: 11, tare: 84, payload: 0, capacity: 0 },
  { id: 'coach', length: 26.4, width: 2.85, height: 4.05, bogieSpacing: 19, tare: 48, payload: 7, capacity: 80 },
  { id: 'cabCar', length: 26.4, width: 2.85, height: 4.05, bogieSpacing: 19, tare: 50, payload: 6, capacity: 64 },
  { id: 'hsNose', length: 27.2, width: 3.1, height: 3.9, bogieSpacing: 17.5, tare: 68, payload: 3, capacity: 40 },
  { id: 'hsCar', length: 24.8, width: 3.1, height: 3.9, bogieSpacing: 17.5, tare: 44, payload: 7, capacity: 80 },
  { id: 'dieselLoco', length: 22.4, width: 3.0, height: 4.7, bogieSpacing: 13.9, tare: 180, payload: 0, capacity: 0 },
  { id: 'boxcar', length: 17.8, width: 3.05, height: 4.5, bogieSpacing: 12.5, tare: 30, payload: 70, capacity: 0 },
  { id: 'tanker', length: 18.6, width: 3.0, height: 4.5, bogieSpacing: 13, tare: 32, payload: 78, capacity: 0 },
  { id: 'hopper', length: 16.2, width: 3.15, height: 4.2, bogieSpacing: 11.2, tare: 26, payload: 92, capacity: 0 },
  { id: 'flatcar', length: 20.4, width: 2.9, height: 3.9, bogieSpacing: 14.6, tare: 24, payload: 50, capacity: 0 },
  { id: 'doubleStack', length: 21.8, width: 2.9, height: 6.1, bogieSpacing: 15.8, tare: 30, payload: 60, capacity: 0 },
  { id: 'autorack', length: 27.6, width: 3.1, height: 5.5, bogieSpacing: 20.5, tare: 50, payload: 28, capacity: 0 },
  // American bilevel commuter coach and its cab car, 85 ft over the body.
  { id: 'bilevel', length: 25.9, width: 3.2, height: 4.85, bogieSpacing: 18.3, tare: 52, payload: 12, capacity: 150 },
  { id: 'bilevelCab', length: 25.9, width: 3.2, height: 4.85, bogieSpacing: 18.3, tare: 54, payload: 11, capacity: 140 },
];

export interface TrainTypeDef {
  id: TrainTypeId;
  name: string;
  minCars: number;
  maxCars: number;
  defaultCars: number;
  /** Top speed, km/h. */
  maxKmh: number;
  /** Power of one powered vehicle, watts. */
  unitPower: number;
  /** Starting tractive effort of one powered vehicle, newtons. */
  unitTraction: number;
  /** Service braking, m/s^2, on the level. */
  brake: number;
  /** Emergency braking, m/s^2, on the level. */
  emergency: number;
  /** Largest change of acceleration, m/s^3. */
  jerk: number;
  /** Rolling resistance, as a fraction of weight. */
  rolling: number;
  /** Aerodynamic drag area CdA of the front, m^2, plus this per metre of train. */
  dragFront: number;
  dragPerMetre: number;
  /** Seconds doors stay open at a stop. */
  dwell: number;
  /** Seconds to change ends at a terminus. */
  changeEnds: number;
  /** Runs on metro track, or on main line track. */
  metro: boolean;
  /** Passengers or freight. */
  passengers: boolean;
  /** What it draws power from. Diesels go anywhere; the rest need their kind of electrification. */
  power: 'overhead' | 'thirdRail' | 'diesel';
  /** The diesel type to offer when its track is not electrified, if any. */
  diesel: TrainTypeId | null;
  /** Shown in the line panel. */
  blurb: string;
}

export const TRAIN_TYPES: Record<TrainTypeId, TrainTypeDef> = {
  metro: {
    id: 'metro',
    name: 'Metro',
    minCars: 6,
    maxCars: 10,
    defaultCars: 8,
    maxKmh: 90,
    unitPower: 420e3,
    unitTraction: 58e3,
    brake: 1.1,
    emergency: 1.4,
    jerk: 1,
    rolling: 0.0016,
    dragFront: 5,
    dragPerMetre: 0.1,
    dwell: 22,
    changeEnds: 30,
    metro: true,
    passengers: true,
    power: 'thirdRail',
    diesel: null,
    blurb: '6 to 10 cars of 20 m, third rail',
  },
  emu: {
    id: 'emu',
    name: 'Commuter EMU',
    minCars: 8,
    maxCars: 12,
    defaultCars: 8,
    maxKmh: 140,
    unitPower: 480e3,
    unitTraction: 52e3,
    brake: 0.9,
    emergency: 1.2,
    jerk: 0.8,
    rolling: 0.0015,
    dragFront: 6,
    dragPerMetre: 0.1,
    dwell: 32,
    changeEnds: 50,
    metro: false,
    passengers: true,
    power: 'overhead',
    diesel: 'dieselCommuter',
    blurb: '8 to 12 cars of 25 m, overhead wire',
  },
  intercity: {
    id: 'intercity',
    name: 'Intercity',
    minCars: 11,
    maxCars: 15,
    defaultCars: 12,
    maxKmh: 200,
    unitPower: 6400e3,
    unitTraction: 300e3,
    brake: 0.65,
    emergency: 1,
    jerk: 0.5,
    rolling: 0.0014,
    dragFront: 7,
    dragPerMetre: 0.09,
    dwell: 60,
    changeEnds: 90,
    metro: false,
    passengers: true,
    power: 'overhead',
    diesel: 'dieselIntercity',
    blurb: 'Locomotive, 10 to 14 coaches and a cab car',
  },
  highspeed: {
    id: 'highspeed',
    name: 'High-speed',
    minCars: 16,
    maxCars: 16,
    defaultCars: 16,
    maxKmh: 300,
    unitPower: 900e3,
    unitTraction: 36e3,
    brake: 0.7,
    emergency: 1.15,
    jerk: 0.5,
    rolling: 0.0012,
    dragFront: 3.6,
    dragPerMetre: 0.055,
    dwell: 90,
    changeEnds: 120,
    metro: false,
    passengers: true,
    power: 'overhead',
    diesel: 'dieselIntercity',
    blurb: '16 cars with streamlined noses, 300 km/h',
  },
  freight: {
    id: 'freight',
    name: 'Freight',
    minCars: 42,
    maxCars: 124,
    defaultCars: 66,
    maxKmh: 100,
    unitPower: 3200e3,
    unitTraction: 450e3,
    brake: 0.32,
    emergency: 0.5,
    jerk: 0.15,
    rolling: 0.0018,
    dragFront: 11,
    dragPerMetre: 0.3,
    dwell: 40,
    changeEnds: 240,
    metro: false,
    passengers: false,
    power: 'diesel',
    diesel: null,
    blurb: '2 to 4 road-switcher diesels and 40 to 120 mixed wagons',
  },
  dieselCommuter: {
    id: 'dieselCommuter',
    name: 'Diesel commuter',
    minCars: 4,
    maxCars: 9,
    defaultCars: 6,
    maxKmh: 130,
    unitPower: 2400e3,
    unitTraction: 270e3,
    brake: 0.8,
    emergency: 1.1,
    jerk: 0.6,
    rolling: 0.0015,
    dragFront: 8,
    dragPerMetre: 0.1,
    dwell: 40,
    changeEnds: 60,
    metro: false,
    passengers: true,
    power: 'diesel',
    diesel: null,
    blurb: 'Push-pull: a diesel, bilevel coaches and a cab car',
  },
  dieselIntercity: {
    id: 'dieselIntercity',
    name: 'Diesel intercity',
    minCars: 7,
    maxCars: 14,
    defaultCars: 10,
    maxKmh: 177,
    unitPower: 3200e3,
    unitTraction: 300e3,
    brake: 0.65,
    emergency: 1,
    jerk: 0.5,
    rolling: 0.0014,
    dragFront: 8,
    dragPerMetre: 0.09,
    dwell: 60,
    changeEnds: 90,
    metro: false,
    passengers: true,
    power: 'diesel',
    diesel: null,
    blurb: 'Two diesels, coaches and a cab car, runs anywhere',
  },
};

/** A made-up train. Everything is indexed from the consist front. */
export interface Consist {
  type: TrainTypeDef;
  count: number;
  kinds: Uint8Array;
  /** 1 when the vehicle faces the consist rear, as a rear cab does. */
  flip: Uint8Array;
  /** Index into the render palette. */
  tint: Uint8Array;
  /** Distance from the consist front to the front of each body. */
  front: Float32Array;
  /** Length of the whole train over the bodies. */
  length: number;
  mass: number;
  power: number;
  traction: number;
  seats: number;
}

/** Gap between the bodies of two coupled vehicles. */
const COUPLER_GAP = 1.1;

function assemble(type: TrainTypeDef, kinds: number[], flip: number[], tint: number[], load: number): Consist {
  const count = kinds.length;
  const front = new Float32Array(count);
  let at = 0;
  let mass = 0;
  let seats = 0;
  for (let i = 0; i < count; i++) {
    const k = CAR_KINDS[kinds[i]];
    front[i] = at;
    at += k.length + (i + 1 < count ? COUPLER_GAP : 0);
    mass += (k.tare + k.payload * load) * 1000;
    seats += k.capacity;
  }
  const powered = kinds.filter((k) => isPowered(type, k)).length;
  return {
    type,
    count,
    kinds: Uint8Array.from(kinds),
    flip: Uint8Array.from(flip),
    tint: Uint8Array.from(tint),
    front,
    length: at,
    mass,
    power: powered * type.unitPower,
    traction: powered * type.unitTraction,
    seats,
  };
}

function isPowered(type: TrainTypeDef, kind: number): boolean {
  if (type.id === 'intercity') return kind === CAR.electricLoco;
  if (type.id === 'freight' || type.id === 'dieselCommuter' || type.id === 'dieselIntercity') return kind === CAR.dieselLoco;
  if (type.id === 'highspeed') return true;
  return kind === CAR.metroCab || kind === CAR.metroCar || kind === CAR.emuCar || kind === CAR.emuCab;
}

function passengerConsist(type: TrainTypeDef, cars: number, cab: number, mid: number): Consist {
  const kinds: number[] = [cab];
  for (let i = 0; i + 2 < cars; i++) kinds.push(mid);
  kinds.push(cab);
  const flip = kinds.map((_, i) => (i === cars - 1 ? 1 : 0));
  return assemble(type, kinds, flip, kinds.map(() => 0), 0.5);
}

/** A run of like wagons, as yards tend to make up. */
function freightConsist(type: TrainTypeDef, cars: number, rng: RailRng): Consist {
  const locos = cars >= 100 ? 4 : cars >= 76 ? 3 : 2;
  const kinds: number[] = [];
  const flip: number[] = [];
  const tint: number[] = [];
  const road = rng.int(0, 3);
  for (let i = 0; i < locos; i++) {
    kinds.push(CAR.dieselLoco);
    flip.push(0);
    tint.push(road);
  }
  const wagons = [CAR.boxcar, CAR.tanker, CAR.hopper, CAR.flatcar, CAR.doubleStack, CAR.autorack];
  while (kinds.length < cars) {
    const kind = rng.pick(wagons);
    const run = Math.min(rng.int(3, 14), cars - kinds.length);
    const shade = rng.int(0, 15);
    for (let i = 0; i < run; i++) {
      kinds.push(kind);
      flip.push(rng.next() < 0.5 ? 1 : 0);
      tint.push((shade + (rng.next() < 0.3 ? rng.int(0, 3) : 0)) & 15);
    }
  }
  return assemble(type, kinds, flip, tint, 1);
}

export function clampCars(id: TrainTypeId, cars: number): number {
  const t = TRAIN_TYPES[id];
  return Math.max(t.minCars, Math.min(t.maxCars, Math.round(cars)));
}

/** Make up a train of a type with this many vehicles, clamped to what the type allows. */
export function makeConsist(id: TrainTypeId, cars: number, rng: RailRng): Consist {
  const type = TRAIN_TYPES[id];
  const n = clampCars(id, cars);
  switch (id) {
    case 'metro':
      return passengerConsist(type, n, CAR.metroCab, CAR.metroCar);
    case 'emu':
      return passengerConsist(type, n, CAR.emuCab, CAR.emuCar);
    case 'highspeed':
      return passengerConsist(type, n, CAR.hsNose, CAR.hsCar);
    case 'intercity': {
      const kinds: number[] = [CAR.electricLoco];
      while (kinds.length + 1 < n) kinds.push(CAR.coach);
      kinds.push(CAR.cabCar);
      return assemble(type, kinds, kinds.map((_, i) => (i === n - 1 ? 1 : 0)), kinds.map(() => 0), 0.5);
    }
    case 'freight':
      return freightConsist(type, n, rng);
    case 'dieselCommuter': {
      // Locomotive pushing on the way out, pulling back, with a cab car at the far end.
      const kinds: number[] = [CAR.dieselLoco];
      while (kinds.length + 1 < n) kinds.push(CAR.bilevel);
      kinds.push(CAR.bilevelCab);
      return assemble(type, kinds, kinds.map((_, i) => (i === n - 1 ? 1 : 0)), kinds.map((_, i) => (i === 0 ? 4 : 0)), 0.5);
    }
    case 'dieselIntercity': {
      const kinds: number[] = [CAR.dieselLoco, CAR.dieselLoco];
      while (kinds.length + 1 < n) kinds.push(CAR.coach);
      kinds.push(CAR.cabCar);
      return assemble(type, kinds, kinds.map((_, i) => (i === n - 1 ? 1 : 0)), kinds.map((_, i) => (i < 2 ? 5 : 0)), 0.5);
    }
  }
}

/** Length of a train of this type and size, for platform checks. Freight is an estimate. */
export function trainLength(id: TrainTypeId, cars: number): number {
  return makeConsist(id, cars, new RailRng(1)).length;
}

/** Tractive force and resistance at a speed on a grade. Positive grade climbs. */
export function acceleration(c: Consist, v: number, grade: number): number {
  const t = c.type;
  const pull = Math.min(c.traction, c.power / Math.max(v, 0.5));
  const drag = 0.6 * (t.dragFront + t.dragPerMetre * c.length) * v * v;
  const rolling = c.mass * 9.81 * t.rolling;
  return (pull - drag - rolling) / c.mass - 9.81 * grade;
}
