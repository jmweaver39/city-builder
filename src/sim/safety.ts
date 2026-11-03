/**
 * The last line of defence against collisions, and the one that makes "no two
 * vehicles overlap" an invariant rather than a tuning goal.
 *
 * After everyone has moved, each vehicle's real footprint is checked against its
 * neighbours. For an overlapping pair, one vehicle is put back where it was at the
 * start of the step and stopped dead. If the previous step had no overlaps then this
 * always ends with none: at worst every vehicle goes back to a state known to be clean.
 * Motion therefore cannot create an overlap, whatever the driving logic above decided.
 * The other two ways a body can appear are handled too: a spawn with no room is taken
 * back, and an edit removes what it leaves overlapping.
 *
 * Every stop here is a near miss the driving logic should have avoided, and is counted
 * in `safetyStops` so that it stays visible rather than papered over.
 */
import { OVERLAP_HEADROOM } from './constants';
import { placeVehicle } from './view';
import { freeVehicle, type VehicleStore } from './vehicles';
import type { World } from './world';

const CELL = 16;
const GRID_BITS = 12;
const GRID_SIZE = 1 << GRID_BITS;
const GRID_MASK = GRID_SIZE - 1;
/** Sets a limit on rounds; each round resolves at least one vehicle, so this is only a backstop. */
const MAX_ROUNDS = 12;

const gridHead = new Int32Array(GRID_SIZE);

function cellOf(ix: number, iz: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & GRID_MASK;
}

/** Do two oriented boxes overlap? Yaw as in the view: yaw 0 faces -Z. */
export function boxesOverlap(
  ax: number,
  az: number,
  ayaw: number,
  ahl: number,
  ahw: number,
  bx: number,
  bz: number,
  byaw: number,
  bhl: number,
  bhw: number,
): boolean {
  const adx = -Math.sin(ayaw);
  const adz = -Math.cos(ayaw);
  const bdx = -Math.sin(byaw);
  const bdz = -Math.cos(byaw);
  const dx = bx - ax;
  const dz = bz - az;
  const c = Math.abs(adx * bdx + adz * bdz);
  const s = Math.abs(adx * bdz - adz * bdx);
  // Separating axes: both boxes' forward and side directions.
  if (Math.abs(dx * adx + dz * adz) > ahl + bhl * c + bhw * s) return false;
  if (Math.abs(dx * -adz + dz * adx) > ahw + bhl * s + bhw * c) return false;
  if (Math.abs(dx * bdx + dz * bdz) > bhl + ahl * c + ahw * s) return false;
  if (Math.abs(dx * -bdz + dz * bdx) > bhw + ahl * s + ahw * c) return false;
  return true;
}

function overlapping(veh: VehicleStore, a: number, b: number): boolean {
  const dx = veh.wx[a] - veh.wx[b];
  const dz = veh.wz[a] - veh.wz[b];
  const reach = (veh.len[a] + veh.len[b]) * 0.5 + veh.halfWidth[a] + veh.halfWidth[b];
  if (dx * dx + dz * dz > reach * reach) return false;
  if (Math.abs(veh.wy[a] - veh.wy[b]) > OVERLAP_HEADROOM) return false;
  return boxesOverlap(
    veh.wx[a],
    veh.wz[a],
    veh.wyaw[a],
    veh.len[a] * 0.5,
    veh.halfWidth[a],
    veh.wx[b],
    veh.wz[b],
    veh.wyaw[b],
    veh.len[b] * 0.5,
    veh.halfWidth[b],
  );
}

/** Save what a vehicle might need to go back to. Runs before anything moves. */
export function snapshotVehicles(veh: VehicleStore): void {
  veh.s0.set(veh.s);
  veh.lane0.set(veh.lane);
  veh.prev10.set(veh.prev1);
  veh.prev20.set(veh.prev2);
  veh.lcFrom0.set(veh.lcFrom);
  veh.lcSec0.set(veh.lcSec);
  veh.latStart0.set(veh.latStart);
  veh.lcLen0.set(veh.lcLen);
}

function moved(veh: VehicleStore, v: number): boolean {
  return veh.s[v] !== veh.s0[v] || veh.lane[v] !== veh.lane0[v] || veh.lcSec[v] !== veh.lcSec0[v];
}

// Where a vehicle got to this step, kept while trying it back at its old place.
let keepLane = 0;
let keepS = 0;
let keepP1 = 0;
let keepP2 = 0;
let keepFrom = 0;
let keepSec = 0;
let keepLat = 0;
let keepLen = 0;
let keepV = 0;
let keepAcc = 0;

function keep(veh: VehicleStore, v: number): void {
  keepLane = veh.lane[v];
  keepS = veh.s[v];
  keepP1 = veh.prev1[v];
  keepP2 = veh.prev2[v];
  keepFrom = veh.lcFrom[v];
  keepSec = veh.lcSec[v];
  keepLat = veh.latStart[v];
  keepLen = veh.lcLen[v];
  keepV = veh.v[v];
  keepAcc = veh.acc[v];
}

function restore(w: World, v: number): void {
  const { veh, g } = w;
  veh.lane[v] = keepLane;
  veh.s[v] = keepS;
  veh.prev1[v] = keepP1;
  veh.prev2[v] = keepP2;
  veh.lcFrom[v] = keepFrom;
  veh.lcSec[v] = keepSec;
  veh.latStart[v] = keepLat;
  veh.lcLen[v] = keepLen;
  veh.v[v] = keepV;
  veh.acc[v] = keepAcc;
  veh.ptIdx[v] = 0;
  placeVehicle(g, veh, v);
}

function rollBack(w: World, v: number): void {
  const { veh, g } = w;
  if (veh.lane[v] !== veh.lane0[v]) {
    veh.lane[v] = veh.lane0[v];
    veh.prev1[v] = veh.prev10[v];
    veh.prev2[v] = veh.prev20[v];
    veh.nextLane[v] = -1;
    veh.stratTick[v] = 0;
  }
  veh.lcFrom[v] = veh.lcFrom0[v];
  veh.lcSec[v] = veh.lcSec0[v];
  veh.latStart[v] = veh.latStart0[v];
  veh.lcLen[v] = veh.lcLen0[v];
  veh.s[v] = veh.s0[v];
  veh.v[v] = 0;
  veh.acc[v] = 0;
  veh.ptIdx[v] = 0;
  placeVehicle(g, veh, v);
}

/** Which of a moving pair should give way, or -1 if neither moved. */
function loserOf(w: World, a: number, b: number): number {
  const { veh, tick } = w;
  if (veh.spawnTick[a] === tick) return a;
  if (veh.spawnTick[b] === tick) return b;
  const am = moved(veh, a);
  const bm = moved(veh, b);
  if (!am) return bm ? b : -1;
  if (!bm) return a;
  // The one with the other in front of it is the one running into it.
  const dx = veh.wx[b] - veh.wx[a];
  const dz = veh.wz[b] - veh.wz[a];
  const aHits = -Math.sin(veh.wyaw[a]) * dx - Math.cos(veh.wyaw[a]) * dz > 0;
  const bHits = Math.sin(veh.wyaw[b]) * dx + Math.cos(veh.wyaw[b]) * dz > 0;
  if (aHits !== bHits) return aHits ? a : b;
  // Otherwise whoever came into the junction last, as everywhere else.
  if (veh.enterTick[a] !== veh.enterTick[b]) return veh.enterTick[a] > veh.enterTick[b] ? a : b;
  return veh.id[a] > veh.id[b] ? a : b;
}

function buildGrid(veh: VehicleStore): void {
  gridHead.fill(-1);
  const { live, wx, wz, gridNext } = veh;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const v = live[i];
    const c = cellOf(Math.floor(wx[v] / CELL), Math.floor(wz[v] / CELL));
    gridNext[v] = gridHead[c];
    gridHead[c] = v;
  }
}

/** Call fn for each overlapping pair until it asks to stop. Returns pairs seen. */
function scan(veh: VehicleStore, fn: (a: number, b: number) => void): number {
  const { live, wx, wz, gridNext, alive } = veh;
  let pairs = 0;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const a = live[i];
    if (!alive[a]) continue;
    const ix = Math.floor(wx[a] / CELL);
    const iz = Math.floor(wz[a] / CELL);
    // Half the neighbourhood, so each pair is met once. Hash clashes only add a re-check.
    for (let b = gridNext[a]; b >= 0; b = gridNext[b]) {
      if (alive[b] && overlapping(veh, a, b)) {
        pairs++;
        fn(a, b);
      }
    }
    for (let k = 0; k < 4; k++) {
      const c = cellOf(ix + (k === 0 ? 1 : k - 2), iz + (k === 0 ? 0 : 1));
      for (let b = gridHead[c]; b >= 0; b = gridNext[b]) {
        if (b !== a && alive[a] && alive[b] && overlapping(veh, a, b)) {
          pairs++;
          fn(a, b);
        }
      }
    }
  }
  return pairs;
}

/** Vehicles to take back after a scan: spawns with no room. */
const dropped: number[] = [];

function dropVehicle(w: World, v: number, onDrop: (v: number) => void): void {
  const { veh } = w;
  if (!veh.alive[v]) return;
  onDrop(v);
  freeVehicle(veh, v);
}

/** Debug hook: hears each near miss before it is resolved. */
export const safetyDebug: { onStop: ((w: World, a: number, b: number, loser: number) => void) | null } = { onStop: null };

/** Enforce the invariant for this step. onDrop hears of spawns that had no room. */
export function enforceNoOverlap(w: World, onDrop: (v: number) => void): void {
  const { veh, counters, tick } = w;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    buildGrid(veh);
    let fixes = 0;
    let unresolved = 0;
    const pairs = scan(veh, (a, b) => {
      const loser = loserOf(w, a, b);
      if (loser < 0) {
        unresolved++;
      } else if (veh.spawnTick[loser] === tick) {
        dropped.push(loser);
        fixes++;
      } else {
        safetyDebug.onStop?.(w, a, b, loser);
        // Stop as few as possible, so whoever can still move does. Put the loser back;
        // if that is not enough and the other one moved, try the other way round;
        // only if neither alone works do both stop.
        const other = loser === a ? b : a;
        keep(veh, loser);
        rollBack(w, loser);
        counters.safetyStops++;
        fixes++;
        if (overlapping(veh, a, b) && moved(veh, other) && veh.spawnTick[other] !== tick) {
          restore(w, loser);
          keep(veh, other);
          rollBack(w, other);
          if (overlapping(veh, a, b)) rollBack(w, loser);
        }
      }
    });
    if (dropped.length) {
      for (const v of dropped) dropVehicle(w, v, onDrop);
      dropped.length = 0;
    }
    if (pairs === 0) return;
    if (fixes === 0) {
      counters.collisions += unresolved;
      return;
    }
  }
  buildGrid(veh);
  counters.collisions += scan(veh, () => {});
}

/** After an edit: place everyone and remove what overlaps, keeping the older vehicle. */
export function clearEditOverlaps(w: World): void {
  const { veh, g, counters } = w;
  for (let i = 0; i < veh.liveCount; i++) placeVehicle(g, veh, veh.live[i]);
  buildGrid(veh);
  scan(veh, (a, b) => {
    const v = veh.id[a] > veh.id[b] ? a : b;
    if (dropped.indexOf(v) < 0) dropped.push(v);
  });
  for (const v of dropped) {
    if (veh.alive[v]) {
      freeVehicle(veh, v);
      counters.removedByEdit++;
    }
  }
  dropped.length = 0;
}
