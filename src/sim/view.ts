/** Writes the packed, render-ready view from vehicle state. */
import { LANE_CHANGE_SEC } from './constants';
import type { CompiledGraph } from './compiled';
import type { VehicleStore } from './vehicles';

/** Most a lane change may turn a body, as this over its length: 0.5 m of swing at each end. */
const MAX_NUDGE_LENGTH = 1;

let px = 0;
let py = 0;
let pz = 0;

/** Point at distance s along a lane, walking from point index `hint`. Returns the index. */
function sampleLane(g: CompiledGraph, lane: number, s: number, hint: number): number {
  const { ptStart, cum, pts } = g;
  const base = ptStart[lane];
  const last = ptStart[lane + 1] - base - 2;
  if (last < 0) {
    px = pts[base * 3];
    py = pts[base * 3 + 1];
    pz = pts[base * 3 + 2];
    return 0;
  }
  let i = hint < last ? hint : last;
  if (i < 0) i = 0;
  while (i < last && cum[base + i + 1] < s) i++;
  while (i > 0 && cum[base + i] > s) i--;
  const c0 = cum[base + i];
  const span = cum[base + i + 1] - c0;
  let f = span > 0 ? (s - c0) / span : 0;
  if (f < 0) f = 0;
  else if (f > 1) f = 1;
  const k = (base + i) * 3;
  px = pts[k] + (pts[k + 3] - pts[k]) * f;
  py = pts[k + 1] + (pts[k + 4] - pts[k + 1]) * f;
  pz = pts[k + 2] + (pts[k + 5] - pts[k + 2]) * f;
  return i;
}

/**
 * Work out where a vehicle's body is. The result depends only on lane, position, the
 * previous lanes and the lane-change state, all of which the safety pass snapshots, so
 * putting a vehicle back reproduces its previous footprint exactly.
 */
export function placeVehicle(g: CompiledGraph, veh: VehicleStore, k: number): void {
  const { ptStart } = g;
  const l = veh.lane[k];
  const pos = veh.s[k];
  const hint = sampleLane(g, l, pos, veh.ptIdx[k]);
  veh.ptIdx[k] = hint;
  const fx = px;
  const fy = py;
  const fz = pz;
  const rearS = pos - veh.len[k];
  const p1 = veh.prev1[k];
  if (rearS >= 0 || p1 < 0) {
    sampleLane(g, l, rearS > 0 ? rearS : 0, hint);
  } else {
    sampleLane(g, p1, g.len[p1] + rearS, ptStart[p1 + 1] - ptStart[p1]);
  }
  const dx = fx - px;
  const dy = fy - py;
  const dz = fz - pz;
  const flat = Math.sqrt(dx * dx + dz * dz);
  let cx = (fx + px) * 0.5;
  const cy = (fy + py) * 0.5;
  let cz = (fz + pz) * 0.5;
  let h = veh.wyaw[k];
  let pitch = 0;
  if (flat > 0.01) {
    const ux = dx / flat;
    const uz = dz / flat;
    h = Math.atan2(-dx, -dz);
    pitch = Math.atan2(dy, flat);
    const left = veh.lcSec[k];
    if (left > 0) {
      const t = left / LANE_CHANGE_SEC;
      const ease = t * t * (3 - 2 * t);
      const off = veh.latStart[k] * ease;
      cx += -uz * off;
      cz += ux * off;
      // Nose towards the target lane: the slope of the path across it. This must depend
      // only on state the safety pass restores, never on speed.
      // Capped by body length: on a tight change a long body's ends would otherwise swing
      // into the next lane. Then it slides across more than it turns.
      let nudge = (veh.latStart[k] * 6 * t * (1 - t)) / veh.lcLen[k];
      const cap = MAX_NUDGE_LENGTH / veh.len[k];
      if (nudge > cap) nudge = cap;
      else if (nudge < -cap) nudge = -cap;
      h += nudge;
    }
  }
  veh.wx[k] = cx;
  veh.wy[k] = cy;
  veh.wz[k] = cz;
  veh.wyaw[k] = h;
  veh.wpitch[k] = pitch;
}

/** Remember where everyone was and place them for this step. */
export function placeAll(g: CompiledGraph, veh: VehicleStore): void {
  const { live, wx, wy, wz, wyaw, pwx, pwy, pwz, pwyaw } = veh;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const k = live[i];
    pwx[k] = wx[k];
    pwy[k] = wy[k];
    pwz[k] = wz[k];
    pwyaw[k] = wyaw[k];
    placeVehicle(g, veh, k);
  }
}

/** Publish the packed view. */
export function writeView(veh: VehicleStore): void {
  const view = veh.view;
  const { id, x, y, z, yaw, pitch, prevX, prevY, prevZ, prevYaw, type, color, braking, blinker, speed } = view;
  const { live, v, acc, wx, wy, wz, wyaw, wpitch, pwx, pwy, pwz, pwyaw, needDir, blink } = veh;
  const count = veh.liveCount;
  for (let i = 0; i < count; i++) {
    const k = live[i];
    const fresh = pwx[k] !== pwx[k];
    prevX[i] = fresh ? wx[k] : pwx[k];
    prevY[i] = fresh ? wy[k] : pwy[k];
    prevZ[i] = fresh ? wz[k] : pwz[k];
    prevYaw[i] = fresh ? wyaw[k] : pwyaw[k];
    x[i] = wx[k];
    y[i] = wy[k];
    z[i] = wz[k];
    yaw[i] = wyaw[k];
    pitch[i] = wpitch[k];
    id[i] = veh.id[k];
    type[i] = veh.type[k];
    color[i] = veh.color[k];
    braking[i] = acc[k] < -1.2 ? 1 : 0;
    blinker[i] = needDir[k] !== 0 ? needDir[k] : blink[k];
    speed[i] = v[k];
  }
  view.count = count;
}
