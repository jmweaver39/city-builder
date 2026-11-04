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

/**
 * Grid cell: enough for any pair involving a car, whose bodies reach under 9 m apart.
 * Long vehicles reach further and are checked separately over two rings of cells.
 */
const CELL = 9;
const LONG_RADIUS = 4;
const GRID_BITS = 16;
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

/**
 * Bodies are kept this far apart, metres, not merely not overlapping: published
 * positions are rounded to 32 bits, and two bodies exactly touching here must not read
 * as overlapping there.
 */
const SKIN = 0.01;

// Per-vehicle box, filled once per scan so pair tests need no trigonometry.
let boxFx = new Float64Array(0);
let boxFz = new Float64Array(0);
let boxR = new Float64Array(0);
let boxMoved = new Uint8Array(0);

function prepareBoxes(w: World): void {
  const { veh, tick } = w;
  if (boxFx.length < veh.capacity) {
    boxFx = new Float64Array(veh.capacity);
    boxFz = new Float64Array(veh.capacity);
    boxR = new Float64Array(veh.capacity);
    boxMoved = new Uint8Array(veh.capacity);
  }
  const { live, wyaw, len, halfWidth } = veh;
  for (let i = 0; i < veh.liveCount; i++) {
    const v = live[i];
    boxFx[v] = -Math.sin(wyaw[v]);
    boxFz[v] = -Math.cos(wyaw[v]);
    const hl = len[v] * 0.5 + SKIN;
    const hw = halfWidth[v] + SKIN;
    boxR[v] = Math.sqrt(hl * hl + hw * hw);
    boxMoved[v] = moved(veh, v) || veh.spawnTick[v] === tick ? 1 : 0;
  }
}

function overlapping(veh: VehicleStore, a: number, b: number): boolean {
  const dx = veh.wx[b] - veh.wx[a];
  const dz = veh.wz[b] - veh.wz[a];
  const reach = boxR[a] + boxR[b];
  if (dx * dx + dz * dz > reach * reach) return false;
  if (Math.abs(veh.wy[a] - veh.wy[b]) > OVERLAP_HEADROOM) return false;
  const adx = boxFx[a];
  const adz = boxFz[a];
  const bdx = boxFx[b];
  const bdz = boxFz[b];
  const ahl = veh.len[a] * 0.5 + SKIN;
  const ahw = veh.halfWidth[a] + SKIN;
  const bhl = veh.len[b] * 0.5 + SKIN;
  const bhw = veh.halfWidth[b] + SKIN;
  const c = Math.abs(adx * bdx + adz * bdz);
  const s = Math.abs(adx * bdz - adz * bdx);
  if (Math.abs(dx * adx + dz * adz) > ahl + bhl * c + bhw * s) return false;
  if (Math.abs(dx * -adz + dz * adx) > ahw + bhl * s + bhw * c) return false;
  if (Math.abs(dx * bdx + dz * bdz) > bhl + ahl * c + ahw * s) return false;
  if (Math.abs(dx * -bdz + dz * bdx) > bhw + ahl * s + ahw * c) return false;
  return true;
}

/** Re-place a vehicle's box after it was moved back. */
function refreshBox(veh: VehicleStore, v: number): void {
  boxFx[v] = -Math.sin(veh.wyaw[v]);
  boxFz[v] = -Math.cos(veh.wyaw[v]);
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
  veh.stuckSec0.set(veh.stuckSec);
  veh.stuckProgress0.set(veh.stuckProgress);
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
let keepStuck = 0;
let keepProgress = 0;

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
  keepStuck = veh.stuckSec[v];
  keepProgress = veh.stuckProgress[v];
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
  veh.stuckSec[v] = keepStuck;
  veh.stuckProgress[v] = keepProgress;
  veh.ptIdx[v] = 0;
  placeVehicle(g, veh, v);
  refreshBox(veh, v);
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
  // Ground given back is no progress. Without this, a pair of vehicles put back every
  // step, each trying to move a few millimetres, reset their stuck timers for ever and
  // hold up everyone behind them without being cleared.
  veh.stuckProgress[v] = veh.stuckProgress0[v];
  if (veh.stuckSec[v] < veh.stuckSec0[v]) veh.stuckSec[v] = veh.stuckSec0[v];
  veh.ptIdx[v] = 0;
  placeVehicle(g, veh, v);
  refreshBox(veh, v);
  boxMoved[v] = 1;
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

/**
 * Call fn for each overlapping pair. Returns pairs seen. With onlyMoved, pairs where
 * neither vehicle moved are skipped: if they did not overlap before, they cannot now.
 * Pairs of short vehicles come from half of each cell's neighbourhood, so each is met
 * once; any pair with a long vehicle is met once, from the long one's wider search.
 */
function scan(veh: VehicleStore, fn: (a: number, b: number) => void, onlyMoved = false): number {
  const { live, wx, wz, gridNext, alive } = veh;
  let pairs = 0;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const a = live[i];
    if (!alive[a]) continue;
    const ix = Math.floor(wx[a] / CELL);
    const iz = Math.floor(wz[a] / CELL);
    const am = boxMoved[a];
    if (boxR[a] > LONG_RADIUS) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let b = gridHead[cellOf(ix + dx, iz + dz)]; b >= 0; b = gridNext[b]) {
            if (b === a || !alive[b] || !alive[a]) continue;
            // Long with long: once, from the lower slot.
            if (boxR[b] > LONG_RADIUS && b < a) continue;
            if (onlyMoved && !am && !boxMoved[b]) continue;
            if (Math.floor(wx[b] / CELL) !== ix + dx || Math.floor(wz[b] / CELL) !== iz + dz) continue;
            if (overlapping(veh, a, b)) {
              pairs++;
              fn(a, b);
            }
          }
        }
      }
      continue;
    }
    for (let b = gridNext[a]; b >= 0; b = gridNext[b]) {
      if (boxR[b] > LONG_RADIUS || (onlyMoved && !am && !boxMoved[b])) continue;
      if (Math.floor(wx[b] / CELL) !== ix || Math.floor(wz[b] / CELL) !== iz) continue;
      if (alive[b] && overlapping(veh, a, b)) {
        pairs++;
        fn(a, b);
      }
    }
    for (let k = 0; k < 4; k++) {
      const cx = ix + (k === 0 ? 1 : k - 2);
      const cz = iz + (k === 0 ? 0 : 1);
      for (let b = gridHead[cellOf(cx, cz)]; b >= 0; b = gridNext[b]) {
        if (b === a || boxR[b] > LONG_RADIUS || (onlyMoved && !am && !boxMoved[b])) continue;
        // A hash clash can bring in a vehicle from elsewhere, or from my own cell.
        if (Math.floor(wx[b] / CELL) !== cx || Math.floor(wz[b] / CELL) !== cz) continue;
        if (alive[a] && alive[b] && overlapping(veh, a, b)) {
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
  prepareBoxes(w);
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
    }, true);
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


/** How many vehicle pairs overlap right now. For tests and the debug overlay. */
export function countOverlaps(w: World): number {
  prepareBoxes(w);
  buildGrid(w.veh);
  return scan(w.veh, () => {});
}

/** After an edit: place everyone and remove what overlaps, keeping the older vehicle. */
export function clearEditOverlaps(w: World): void {
  const { veh, g, counters } = w;
  for (let i = 0; i < veh.liveCount; i++) placeVehicle(g, veh, veh.live[i]);
  prepareBoxes(w);
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
