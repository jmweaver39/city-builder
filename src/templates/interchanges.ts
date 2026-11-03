/**
 * Service interchanges: a highway meeting a surface road, with at-grade ramp
 * terminals or free-flowing loops. The highway runs along x at the base level, the
 * cross road along z, one level up and back down to the base at its stubs.
 *
 * Right-hand traffic means eastbound lies on the +z side and southbound on the -x
 * side, so a quarter turn of the plan carries each movement to the next.
 */
import { Blueprint, arriving, leaving, type BpPhase, type Pose3, type Road } from './blueprint';
import {
  LEVEL,
  MAIN_GRADE,
  RAMP_RUN,
  STUB,
  addLoop,
  addRamp,
  addRightTurn,
  carriagewayOffset,
  clearAngle,
  crossType,
  eastWest,
  halfWidth,
  hump,
  humpHalf,
  mainType,
  northSouth,
  pathGap,
  rampPath,
  rampProfile,
  rampType,
  rightTurnReach,
  type BuildContext,
} from './kit';
import { Path, Profile, deg, type Pose } from './path';
import { makeCustomRoadType } from '../core';

/** A two-way road along z through the origin, travelling +z from a to b. */
function crossRoad(bp: Blueprint, type: string, half: number, profile: (len: number) => Profile): Road {
  const road = bp.road({
    name: 'Cross road',
    path: new Path({ x: 0, z: -half, h: Math.PI / 2 }).line(half * 2),
    profile: profile(half * 2),
    type,
  });
  bp.port('N', road, 'start', 'both');
  bp.port('S', road, 'end', 'both');
  return road;
}

/** The same pose seen from the far side of the template. */
const rot180 = (p: Pose3): Pose3 => ({ x: -p.x, z: -p.z, y: p.y, h: p.h + Math.PI });

// ---------------------------------------------------------------------------
// Diamond
// ---------------------------------------------------------------------------

export function diamond(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const cross = crossType(p.crossLanes);
  const ramp = rampType(p.rampLanes);
  const m = carriagewayOffset(bp, main);
  const T = Math.max(p.terminalSpacing / 2, m + halfWidth(bp, main) + halfWidth(bp, ramp) + 26);
  const flat = T + RAMP_RUN;
  const { eb, wb } = eastWest(bp, main, m, p.rampLength + RAMP_RUN + STUB + 60, () => Profile.flat(0));
  crossRoad(bp, cross, humpHalf(LEVEL, flat), hump(LEVEL, flat));
  const theta = clearAngle(bp, main, ramp);
  const quadrants: [Road, number, string][] = [
    [eb, 1, 'Eastbound'],
    [wb, -1, 'Westbound'],
  ];
  for (const [road, sign, name] of quadrants) {
    const term: Pose3 = sign > 0 ? { x: 0, z: T, h: 0, y: LEVEL } : { x: 0, z: -T, h: Math.PI, y: LEVEL };
    addRamp(bp, `${name} off-ramp`, ramp, { from: road.before(p.rampLength), to: term, exitAngle: theta, mergeRun: 50, r1: 90 });
    addRamp(bp, `${name} on-ramp`, ramp, { from: term, to: road.after(p.rampLength), mergeAngle: theta, exitRun: 50, r1: 90 });
    bp.control(bp.pin(term), { kind: 'signal', preset: 'protectedLefts' });
  }
}

// ---------------------------------------------------------------------------
// Single-point urban interchange
// ---------------------------------------------------------------------------

export function spui(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const cross = crossType(p.crossLanes);
  const ramp = rampType(p.rampLanes);
  const m = carriagewayOffset(bp, main);
  const { eb, wb } = eastWest(bp, main, m, p.rampLength + RAMP_RUN + STUB + 60, () => Profile.flat(0));
  const flat = 110;
  const half = humpHalf(LEVEL, flat);
  const armProfile = new Profile([
    [0, LEVEL],
    [flat, LEVEL],
    [flat + LEVEL / MAIN_GRADE, 0],
    [half, 0],
  ], 40);
  const north = bp.road({ name: 'Cross road north', path: new Path({ x: 0, z: 0, h: -Math.PI / 2 }).line(half), profile: armProfile, type: cross });
  const south = bp.road({ name: 'Cross road south', path: new Path({ x: 0, z: 0, h: Math.PI / 2 }).line(half), profile: armProfile, type: cross });
  bp.port('N', north, 'end', 'both');
  bp.port('S', south, 'end', 'both');
  const centre: Pose3 = { x: 0, z: 0, h: 0, y: LEVEL };
  const theta = clearAngle(bp, main, ramp);
  const flare = deg(30);
  const r1 = 110;
  // Six arms evenly round the node. Ramps climb on the outside of the carriageway
  // and turn in over it at full height.
  const offRamp = (road: Road, name: string, h: number) =>
    addRamp(bp, name, ramp, { from: road.before(p.rampLength), to: { ...centre, h }, exitAngle: theta, mergeRun: 70, r1 });
  const onRamp = (road: Road, name: string, h: number) =>
    addRamp(bp, name, ramp, { from: { ...centre, h }, to: road.after(p.rampLength), mergeAngle: theta, exitRun: 70, r1 });
  const ebOff = offRamp(eb, 'Eastbound off-ramp', -flare);
  const ebOn = onRamp(eb, 'Eastbound on-ramp', flare);
  const wbOff = offRamp(wb, 'Westbound off-ramp', Math.PI - flare);
  const wbOn = onRamp(wb, 'Westbound on-ramp', Math.PI + flare);
  bp.finish();
  const node = bp.pin(centre);
  const nIn = leaving(north);
  const sIn = leaving(south);
  const lanes = bp.armLanes(node, nIn, 'in').length;
  const outLanes = bp.armLanes(node, sIn, 'out').length;
  const rightOut = (arm: typeof ebOn) => bp.armLanes(node, leaving(arm), 'out').length - 1;
  const links = [];
  for (const [from, ahead, left, right] of [
    [nIn, sIn, ebOn, wbOn],
    [sIn, nIn, wbOn, ebOn],
  ] as const) {
    links.push({ from, fromLane: 0, to: leaving(left), toLane: 0 });
    for (let i = lanes > 1 ? 1 : 0; i < lanes; i++) links.push({ from, fromLane: i, to: ahead, toLane: Math.min(i, outLanes - 1) });
    links.push({ from, fromLane: lanes - 1, to: leaving(right), toLane: rightOut(right) });
  }
  for (const [off, left, right] of [
    [ebOff, nIn, sIn],
    [wbOff, sIn, nIn],
  ] as const) {
    const from = arriving(off);
    const count = bp.armLanes(node, from, 'in').length;
    links.push({ from, fromLane: 0, to: left, toLane: 0 });
    links.push({ from, fromLane: count - 1, to: right, toLane: bp.armLanes(node, right, 'out').length - 1 });
  }
  bp.addLinks(node, links);
  const move = (from: BpPhase['moves'][number]['from'], to: BpPhase['moves'][number]['to']) => ({ from, to, state: 'protected' as const });
  bp.control(node, {
    kind: 'phases',
    phases: [
      {
        name: 'Cross road through',
        greenSec: 24,
        moves: [move(nIn, sIn), move(sIn, nIn), move(nIn, leaving(wbOn)), move(sIn, leaving(ebOn))],
      },
      { name: 'Cross road lefts', greenSec: 14, moves: [move(nIn, leaving(ebOn)), move(sIn, leaving(wbOn))] },
      {
        name: 'Ramps',
        greenSec: 18,
        moves: [
          move(arriving(ebOff), nIn),
          move(arriving(wbOff), sIn),
          move(arriving(ebOff), sIn),
          move(arriving(wbOff), nIn),
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Partial cloverleaf
// ---------------------------------------------------------------------------

/**
 * Parclo A2: an exit ramp and an entrance loop share a quadrant on each side of the
 * highway. The left turn on to the highway uses the loop, so the terminal has no
 * left turn across the cross road, and the highway sees exit, then loop, then ramp.
 */
export function parclo(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const cross = crossType(p.crossLanes);
  const ramp = rampType(p.rampLanes);
  const m = carriagewayOffset(bp, main);
  const R = p.loopRadius;
  const reach = p.rampLength;
  const half = reach + RAMP_RUN + STUB + 60;
  const { eb, wb } = eastWest(bp, main, m, half, () => Profile.flat(0));
  const theta = clearAngle(bp, main, ramp);

  // The cross road has to exist before a loop can be fitted to it, but its length
  // depends on where the terminal lands, so fit the loop on a stand-in first.
  const standIn = new Blueprint();
  const standRoad = standIn.road({ name: 'x', path: new Path({ x: 0, z: -2000, h: Math.PI / 2 }).line(4000), profile: Profile.flat(LEVEL), type: cross });
  const standEb = standIn.road({ name: 'x', path: new Path({ x: -2000, z: m, h: 0 }).line(4000), profile: Profile.flat(0), type: main });
  const loopPlan = addLoop(standIn, 'x', 'ramp-1', standRoad, standEb, R);
  // The terminal sits past the loop, on the far side of it from the highway.
  const gapNeeded = halfWidth(bp, ramp) * 2 + 8;
  const minT = m + loopPlan.fit.t + 90;
  let T = minT;
  for (; T < minT + 600; T += 10) {
    const off = rampPath({
      from: eb.before(reach),
      to: { x: 0, z: T, h: 0, y: LEVEL },
      exitAngle: theta,
      mergeRun: 60,
      r1: 120,
    });
    if (pathGap(off, loopPlan.road.path) >= gapNeeded) break;
  }
  const flat = T + RAMP_RUN;
  const road = crossRoad(bp, cross, humpHalf(LEVEL, flat), hump(LEVEL, flat));

  // Southbound lanes run down the road's direction, so the road itself is the
  // southbound in-road of one loop. The other loop is the same thing turned round.
  const { road: loopEb } = addLoop(bp, 'Loop on to eastbound', 'ramp-1', road, eb, R);
  const terminal = (sign: number): Pose3 => (sign > 0 ? { x: 0, z: T, h: 0, y: LEVEL } : { x: 0, z: -T, h: Math.PI, y: LEVEL });
  const fromLoop = loopEb.path.start;
  const leg = loopEb.path.prims[0].len;
  const loopWb = bp.road({
    name: 'Loop on to westbound',
    path: new Path({ x: -fromLoop.x, z: -fromLoop.z, h: fromLoop.h + Math.PI })
      .line(leg)
      .right(R, deg(270) - 2 * loopPlan.fit.theta)
      .line(leg),
    profile: rampProfile(loopEb.length, LEVEL, 0, leg, leg),
    type: 'ramp-1',
    overrides: loopEb.overrides,
  });

  for (const [carriage, sign, name] of [
    [eb, 1, 'Eastbound'],
    [wb, -1, 'Westbound'],
  ] as const) {
    const term = terminal(sign);
    addRamp(bp, `${name} off-ramp`, ramp, { from: carriage.before(reach), to: term, exitAngle: theta, mergeRun: 60, r1: 120 });
    addRamp(bp, `${name} on-ramp`, ramp, { from: term, to: carriage.after(reach), mergeAngle: theta, exitRun: 60, r1: 120 });
    bp.control(bp.pin(term), { kind: 'signal', preset: 'opposing' });
  }
  bp.finish();

  // The loop is the only way to turn left on to the highway: no left across the
  // road at either the terminal or the loop's own junction.
  for (const [sign, loop] of [
    [1, loopEb],
    [-1, loopWb],
  ] as const) {
    const term = bp.pin(terminal(sign));
    const off = bp.roads.find((r) => r.name === (sign > 0 ? 'Eastbound off-ramp' : 'Westbound off-ramp'))!;
    const on = bp.roads.find((r) => r.name === (sign > 0 ? 'Eastbound on-ramp' : 'Westbound on-ramp'))!;
    // `near` is the arm towards the highway, `far` the arm away from it.
    const near = sign > 0 ? arriving(road) : leaving(road);
    const far = sign > 0 ? leaving(road) : arriving(road);
    const nearLanes = bp.armLanes(term, near, 'in').length;
    const farLanes = bp.armLanes(term, far, 'in').length;
    const links = [];
    for (let i = 0; i < nearLanes; i++) links.push({ from: near, fromLane: i, to: far, toLane: Math.min(i, bp.armLanes(term, far, 'out').length - 1) });
    for (let i = 0; i < farLanes; i++) links.push({ from: far, fromLane: i, to: near, toLane: Math.min(i, bp.armLanes(term, near, 'out').length - 1) });
    links.push({ from: far, fromLane: farLanes - 1, to: leaving(on), toLane: bp.armLanes(term, leaving(on), 'out').length - 1 });
    const offLanes = bp.armLanes(term, arriving(off), 'in').length;
    links.push({ from: arriving(off), fromLane: 0, to: near, toLane: 0 });
    links.push({ from: arriving(off), fromLane: offLanes - 1, to: far, toLane: bp.armLanes(term, far, 'out').length - 1 });
    bp.addLinks(term, links);

    const loopNode = bp.pin(loop.start);
    const inA = sign > 0 ? arriving(road) : leaving(road);
    const inB = sign > 0 ? leaving(road) : arriving(road);
    const aLanes = bp.armLanes(loopNode, inA, 'in').length;
    const bLanes = bp.armLanes(loopNode, inB, 'in').length;
    const loopLinks = [];
    for (let i = 0; i < aLanes; i++) loopLinks.push({ from: inA, fromLane: i, to: inB, toLane: Math.min(i, bp.armLanes(loopNode, inB, 'out').length - 1) });
    for (let i = 0; i < bLanes; i++) loopLinks.push({ from: inB, fromLane: i, to: inA, toLane: Math.min(i, bp.armLanes(loopNode, inA, 'out').length - 1) });
    loopLinks.push({ from: inA, fromLane: aLanes - 1, to: leaving(loop), toLane: 0 });
    bp.addLinks(loopNode, loopLinks);
  }
}

// ---------------------------------------------------------------------------
// Full cloverleaf
// ---------------------------------------------------------------------------

export function cloverleaf(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const crossMain = `highway-${p.crossLanes}`;
  const ramp = rampType(p.rampLanes);
  const R = p.loopRadius;
  const m = carriagewayOffset(bp, main);
  const mc = carriagewayOffset(bp, crossMain);
  const useCd = p.collector >= 1;

  // Fit on long stand-ins first: ramp reach decides how long the real roads are.
  const reachFor = (cdOffset: number): number => {
    const s = new Blueprint();
    const eb = s.road({ name: 'x', path: new Path({ x: -2000, z: m + cdOffset, h: 0 }).line(4000), profile: Profile.flat(0), type: useCd ? 'ramp-2' : main });
    const nb = s.road({ name: 'x', path: new Path({ x: mc, z: 2000, h: -Math.PI / 2 }).line(4000), profile: Profile.flat(LEVEL), type: crossMain });
    const loop = addLoop(s, 'x', 'ramp-1', eb, nb, R);
    const minReach = loop.fit.t + 200;
    return rightTurnReach(s, ramp, nb, eb, p.rampRadius, minReach, [loop.road.path], halfWidth(bp, ramp) * 2 + 8);
  };

  const cdTheta = clearAngle(bp, main, 'ramp-2');
  const cdRadius = 200;
  const cdOffset = useCd ? RAMP_RUN * Math.sin(cdTheta) + cdRadius * (1 - Math.cos(cdTheta)) : 0;
  const reach = reachFor(cdOffset);
  const cdReach = reach + 230;
  const span = (useCd ? cdReach : reach) + RAMP_RUN + STUB;
  const { eb, wb } = eastWest(bp, main, m, span, () => Profile.flat(0));
  const flat = reach + RAMP_RUN + 10;
  const half = humpHalf(LEVEL, flat);
  const { sb, nb } = northSouth(bp, crossMain, mc, half, hump(LEVEL, flat));

  const collector = (road: Road, name: string): Road => {
    const from = road.before(cdReach);
    const path = new Path({ x: from.x, z: from.z, h: from.h + cdTheta })
      .line(RAMP_RUN)
      .left(cdRadius, cdTheta)
      .line(2 * cdReach - 2 * (RAMP_RUN * Math.cos(cdTheta) + cdRadius * Math.sin(cdTheta)))
      .left(cdRadius, cdTheta)
      .line(RAMP_RUN);
    return bp.road({ name, path, profile: Profile.flat(0), type: 'ramp-2', centre: path.length / 2 });
  };
  const ebSide = useCd ? collector(eb, 'Eastbound collector') : eb;
  const wbSide = useCd ? collector(wb, 'Westbound collector') : wb;

  // Each quadrant holds one loop and, round the outside of it, one right turn.
  const mkLoop = (name: string, a: Road, b: Road) => addLoop(bp, name, 'ramp-1', a, b, R).road;
  mkLoop('Loop eastbound to northbound', ebSide, nb);
  mkLoop('Loop northbound to westbound', nb, wbSide);
  mkLoop('Loop westbound to southbound', wbSide, sb);
  mkLoop('Loop southbound to eastbound', sb, ebSide);
  const mkTurn = (name: string, a: Road, b: Road) => addRightTurn(bp, name, ramp, a, b, reach, p.rampRadius);
  mkTurn('Eastbound to southbound', ebSide, sb);
  mkTurn('Southbound to westbound', sb, wbSide);
  mkTurn('Westbound to northbound', wbSide, nb);
  mkTurn('Northbound to eastbound', nb, ebSide);
}

// ---------------------------------------------------------------------------
// Diverging diamond
// ---------------------------------------------------------------------------

/**
 * Between the two crossovers the cross road's directions swap sides, so left turns
 * on to and off the highway flow freely with no opposing traffic. Two-way stubs
 * split into a one-way pair; each one-way runs the whole width of the interchange.
 */
export function divergingDiamond(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const stubType = crossType(4);
  const oneWay = bp.customType(
    makeCustomRoadType({
      id: 'tpl-ddi-oneway',
      name: 'Diverging diamond one-way',
      category: 'oneway',
      rank: 2,
      forwardLanes: 2,
      backwardLanes: 0,
      laneWidth: 3.5,
      shoulder: 0.5,
      speedKmh: 50,
    }),
  );
  const trunk = 'ramp-2';
  const branch = 'ramp-1';
  const m = carriagewayOffset(bp, main);
  const reach = p.rampLength;
  const { eb, wb } = eastWest(bp, main, m, reach + RAMP_RUN + STUB + 60, () => Profile.flat(0));

  const c = halfWidth(bp, oneWay) + 2.5; // Half the spacing of the pair on the bridge.
  const beta = deg(28);
  const R = 45;
  // Sideways shift from one side of the bridge to the centre line: an arc, then straight.
  const shiftRun = Math.max(0, (c - R * (1 - Math.cos(beta))) / Math.sin(beta));
  const D = R * Math.sin(beta) + shiftRun * Math.cos(beta);
  const zB = m + halfWidth(bp, main) + 34; // Left-turn junctions, just off the highway.
  const zX = zB + p.crossoverSpacing; // Crossover.
  const zR = zX + D + 56; // Right-turn junctions.
  const zJ = zR + D + 66; // Where the two-way stub splits.
  const y = LEVEL;
  const descent = LEVEL / MAIN_GRADE;

  // One road runs the whole way, weaving across at each crossover. It starts at the
  // south stub heading north, keeps right, swaps left over the highway, swaps back.
  const north = -Math.PI / 2;
  const pose = (x: number, z: number, h: number): Pose => ({ x, z, h });
  const sinuous = (from: Pose): Path =>
    new Path(from)
      .line(shiftRun)
      .left(R, beta)
      .line(zJ - zX - 2 * D)
      .left(R, beta)
      .line(2 * shiftRun)
      .right(R, beta)
      .line(2 * (zX - D))
      .right(R, beta)
      .line(2 * shiftRun)
      .left(R, beta)
      .line(zJ - zX - 2 * D)
      .left(R, beta)
      .line(shiftRun);
  const r1 = bp.road({ name: 'Northbound through', path: sinuous(pose(0, zJ, north + beta)), profile: Profile.flat(y), type: oneWay });
  const r2 = bp.road({ name: 'Southbound through', path: sinuous(pose(0, -zJ, north + beta + Math.PI)), profile: Profile.flat(y), type: oneWay });

  // Crossover nodes, signalised in two phases.
  const south = bp.pin({ x: 0, y, z: zX });
  const northX = bp.pin({ x: 0, y, z: -zX });

  // Two-way stubs at each end.
  const stubLen = descent + STUB + 40;
  const stubProfile = new Profile([
    [0, y],
    [40, y],
    [40 + descent, 0],
    [stubLen, 0],
  ], 30);
  const stubS = bp.road({ name: 'Cross road south', path: new Path(pose(0, zJ, Math.PI / 2)).line(stubLen), profile: stubProfile, type: stubType });
  const stubN = bp.road({ name: 'Cross road north', path: new Path(pose(0, -zJ, -Math.PI / 2)).line(stubLen), profile: stubProfile, type: stubType });
  bp.port('S', stubS, 'end', 'both');
  bp.port('N', stubN, 'end', 'both');

  // Ramps on the eastbound side; the westbound side is the same plan turned round.
  const theta = clearAngle(bp, main, trunk);
  const psi = deg(30);
  const xF = reach - 300;
  const zF = (zB + zR) / 2;
  const split = deg(16);
  const sides: { road: Road; turn: (q: Pose3) => Pose3; name: string }[] = [
    { road: eb, turn: (q) => q, name: 'Eastbound' },
    { road: wb, turn: rot180, name: 'Westbound' },
  ];
  for (const { road, turn, name } of sides) {
    const F = turn({ x: -xF, z: zF, h: 0, y });
    const G = turn({ x: xF, z: zF, h: 0, y });
    addRamp(bp, `${name} off-ramp`, trunk, { from: road.before(reach), to: F, exitAngle: theta, mergeRun: 40, r1: 90 });
    addRamp(bp, `${name} on-ramp`, trunk, { from: G, to: road.after(reach), mergeAngle: theta, exitRun: 40, r1: 90 });
    const flatProfile = () => Profile.flat(y);
    // Off-ramp left branch: joins the northbound road from its left, no conflict.
    addRamp(bp, `${name} off left`, branch, {
      from: { ...F, h: F.h - split },
      to: turn({ x: -c, z: zB, h: north + psi, y }),
      exitRun: 40,
      mergeRun: 40,
      r1: 70,
    }, flatProfile);
    // Off-ramp right branch: joins the southbound road below the crossover.
    addRamp(bp, `${name} off right`, branch, {
      from: { ...F, h: F.h + split },
      to: turn({ x: -c, z: zR, h: Math.PI / 2 - psi, y }),
      exitRun: 40,
      mergeRun: 40,
      r1: 70,
    }, flatProfile);
    // On-ramp left branch: leaves the southbound road on its left, no conflict.
    addRamp(bp, `${name} on left`, branch, {
      from: turn({ x: c, z: zB, h: Math.PI / 2 - psi, y }),
      to: { ...G, h: G.h + split },
      exitRun: 40,
      mergeRun: 40,
      r1: 70,
    }, flatProfile);
    // On-ramp right branch: leaves the northbound road before the crossover.
    addRamp(bp, `${name} on right`, branch, {
      from: turn({ x: c, z: zR, h: north + psi, y }),
      to: { ...G, h: G.h - split },
      exitRun: 40,
      mergeRun: 40,
      r1: 70,
    }, flatProfile);
  }

  bp.finish();
  for (const node of [south, northX]) {
    const twoLanes = [0, 1];
    bp.addLinks(node, [
      ...twoLanes.map((i) => ({ from: arriving(r1), fromLane: i, to: leaving(r1), toLane: i })),
      ...twoLanes.map((i) => ({ from: arriving(r2), fromLane: i, to: leaving(r2), toLane: i })),
    ]);
    bp.control(node, {
      kind: 'phases',
      phases: [
        { name: 'Northbound', greenSec: 22, moves: [{ from: arriving(r1), to: leaving(r1), state: 'protected' }] },
        { name: 'Southbound', greenSec: 22, moves: [{ from: arriving(r2), to: leaving(r2), state: 'protected' }] },
      ],
    });
  }
}
