/**
 * Vehicle state as a struct of arrays. Slots are stable while a vehicle lives,
 * which keeps cross references simple. `live` lists the slots in use. The packed
 * VehicleView handed to the renderer is written from these once per step.
 */
import type { VehicleView } from './api';

const FLOAT_FIELDS = [
  's', 'v', 'acc', 'gapHard',
  'len', 'accel', 'decel', 'headway', 'minGap', 'maxSpeed', 'speedFactor',
  'permitDist', 'stopHold', 'waitSec', 'arriveTime', 'stuckSec', 'stuckProgress', 'spawnTime',
  'lcSec', 'lcCool', 'latStart',
  'needDist', 'limitV', 'limitD', 'mustWait', 'seekV',
  'vlGap', 'vlV', 'vlFloor',
  'wx', 'wy', 'wz', 'wyaw', 'wpitch', 'pwx', 'pwy', 'pwz', 'pwyaw',
  'yieldSec', 'halfWidth',
  's0', 'lcSec0', 'latStart0', 'lcLen', 'lcLen0',
] as const;

const INT_FIELDS = [
  'id', 'lane', 'prev1', 'prev2', 'ptIdx', 'dest', 'source', 'nextLane', 'permit',
  'claimNext', 'claimPrev', 'lcFrom', 'reqLane', 'noiseSeed', 'vlTick', 'readyTick', 'stratTick', 'seen', 'enterTick',
  'spawnTick', 'lane0', 'prev10', 'prev20', 'lcFrom0', 'gridNext', 'guardFor',
] as const;

const BYTE_FIELDS = ['alive', 'type', 'color', 'needMust', 'needCount', 'denied', 'held', 'claimWait', 'lcPause'] as const;
const SBYTE_FIELDS = ['needDir', 'blink'] as const;

type FloatField = (typeof FLOAT_FIELDS)[number];
type IntField = (typeof INT_FIELDS)[number];
type ByteField = (typeof BYTE_FIELDS)[number];
type SByteField = (typeof SBYTE_FIELDS)[number];

export type VehicleStore = VehicleArrays & VehicleStoreMethods;

type VehicleArrays = { [K in FloatField]: Float64Array } & { [K in IntField]: Int32Array } & {
  [K in ByteField]: Uint8Array;
} & { [K in SByteField]: Int8Array };

interface VehicleStoreMethods {
  capacity: number;
  liveCount: number;
  live: Int32Array;
  liveIndex: Int32Array;
  freeTop: number;
  free: Int32Array;
  nextId: number;
  view: VehicleView;
}

function grown<T extends Float64Array | Int32Array | Uint8Array | Int8Array>(old: T, size: number, fill = 0): T {
  const ctor = old.constructor as new (n: number) => T;
  const out = new ctor(size);
  out.set(old as never);
  if (fill !== 0) out.fill(fill as never, old.length);
  return out;
}

export function createVehicleStore(capacity: number): VehicleStore {
  const store = {} as Record<string, unknown>;
  for (const f of FLOAT_FIELDS) store[f] = new Float64Array(capacity);
  for (const f of INT_FIELDS) store[f] = new Int32Array(capacity);
  for (const f of BYTE_FIELDS) store[f] = new Uint8Array(capacity);
  for (const f of SBYTE_FIELDS) store[f] = new Int8Array(capacity);
  store.capacity = capacity;
  store.liveCount = 0;
  store.live = new Int32Array(capacity);
  store.liveIndex = new Int32Array(capacity);
  store.free = new Int32Array(capacity);
  store.freeTop = capacity;
  const free = store.free as Int32Array;
  for (let i = 0; i < capacity; i++) free[i] = capacity - 1 - i;
  store.nextId = 1;
  store.view = {
    count: 0,
    capacity,
    id: new Int32Array(capacity),
    type: new Uint8Array(capacity),
    color: new Uint8Array(capacity),
    braking: new Uint8Array(capacity),
    blinker: new Int8Array(capacity),
    speed: new Float32Array(capacity),
    prevX: new Float32Array(capacity),
    prevY: new Float32Array(capacity),
    prevZ: new Float32Array(capacity),
    prevYaw: new Float32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    z: new Float32Array(capacity),
    yaw: new Float32Array(capacity),
    pitch: new Float32Array(capacity),
  };
  return store as unknown as VehicleStore;
}

/** Double the capacity. Array identities change; the view object does not. */
export function growVehicleStore(store: VehicleStore): void {
  const old = store.capacity;
  const size = old * 2;
  const rec = store as unknown as Record<string, Float64Array | Int32Array | Uint8Array | Int8Array>;
  for (const f of [...FLOAT_FIELDS, ...INT_FIELDS, ...BYTE_FIELDS, ...SBYTE_FIELDS]) rec[f] = grown(rec[f], size);
  store.live = grown(store.live, size);
  store.liveIndex = grown(store.liveIndex, size);
  const free = new Int32Array(size);
  free.set(store.free.subarray(0, store.freeTop));
  let top = store.freeTop;
  for (let i = size - 1; i >= old; i--) free[top++] = i;
  store.free = free;
  store.freeTop = top;
  store.capacity = size;
  const v = store.view;
  v.capacity = size;
  v.id = grown(v.id, size);
  v.type = grown(v.type, size);
  v.color = grown(v.color, size);
  v.braking = grown(v.braking, size);
  v.blinker = grown(v.blinker, size);
  const f32 = (a: Float32Array) => {
    const out = new Float32Array(size);
    out.set(a);
    return out;
  };
  v.speed = f32(v.speed);
  v.prevX = f32(v.prevX);
  v.prevY = f32(v.prevY);
  v.prevZ = f32(v.prevZ);
  v.prevYaw = f32(v.prevYaw);
  v.x = f32(v.x);
  v.y = f32(v.y);
  v.z = f32(v.z);
  v.yaw = f32(v.yaw);
  v.pitch = f32(v.pitch);
}

/** Take a free slot, growing if needed. The caller fills it in. */
export function allocVehicle(store: VehicleStore): number {
  if (store.freeTop === 0) growVehicleStore(store);
  const slot = store.free[--store.freeTop];
  store.alive[slot] = 1;
  store.liveIndex[slot] = store.liveCount;
  store.live[store.liveCount++] = slot;
  store.id[slot] = store.nextId++;
  return slot;
}

export function freeVehicle(store: VehicleStore, slot: number): void {
  store.alive[slot] = 0;
  const i = store.liveIndex[slot];
  const last = store.live[--store.liveCount];
  store.live[i] = last;
  store.liveIndex[last] = i;
  store.free[store.freeTop++] = slot;
}

export function clearVehicles(store: VehicleStore): void {
  store.alive.fill(0);
  store.liveCount = 0;
  const cap = store.capacity;
  for (let i = 0; i < cap; i++) store.free[i] = cap - 1 - i;
  store.freeTop = cap;
  store.nextId = 1;
  store.view.count = 0;
}
