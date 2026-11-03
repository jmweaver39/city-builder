/**
 * Stamps with no grade separation: roundabouts, the signalised crossing, and the
 * small highway pieces.
 */
import { Blueprint, arriving, leaving, type BpLaneLink, type BpPhase, type Road } from './blueprint';
import { RAMP_RUN, clearAngle, halfWidth, mainType, rampType, twoWayType, type BuildContext } from './kit';
import { Path, Profile } from './path';
import { makeCustomRoadType } from '../core';

// ---------------------------------------------------------------------------
// Roundabouts
// ---------------------------------------------------------------------------

interface Ring {
  /** Quarter arcs, each leaving the node of the same index. */
  quarters: Road[];
  arms: Road[];
  nodes: number[];
}

const ARM_NAMES = ['E', 'N', 'W', 'S'];

/**
 * Four arms and a one-way ring. Right-hand traffic circulates anticlockwise from
 * above, which is a left-hand circle, so headings fall as you go round.
 */
function buildRing(bp: Blueprint, radius: number, ringType: string, armTypes: string[], armLength: number, speed: number): Ring {
  const overrides = { speedKmh: speed };
  const quarters: Road[] = [];
  const arms: Road[] = [];
  for (let k = 0; k < 4; k++) {
    const phi = (-k * Math.PI) / 2;
    const at = { x: radius * Math.cos(phi), z: radius * Math.sin(phi) };
    quarters.push(
      bp.road({
        name: `Ring ${ARM_NAMES[k]}`,
        path: new Path({ ...at, h: phi - Math.PI / 2 }).left(radius, Math.PI / 2),
        profile: Profile.flat(0),
        type: ringType,
        overrides,
      }),
    );
    const arm = bp.road({
      name: `Arm ${ARM_NAMES[k]}`,
      path: new Path({ ...at, h: phi }).line(armLength),
      profile: Profile.flat(0),
      type: armTypes[k],
    });
    arms.push(arm);
    bp.port(ARM_NAMES[k], arm, 'end', 'both');
  }
  const nodes = quarters.map((q) => bp.pin(q.start));
  // Whoever is on the ring has priority; arms give way.
  nodes.forEach((node, k) => {
    bp.control(node, {
      kind: 'priority',
      signs: [
        { arm: arriving(quarters[(k + 3) % 4]), sign: 'priority' },
        { arm: leaving(arms[k]), sign: 'yield' },
      ],
    });
  });
  return { quarters, arms, nodes };
}

/** Radius below which junction trims would eat a ring quarter between wide arms. */
function ringFloor(bp: Blueprint, armType: string, ringType: string): number {
  const need = 2 * (halfWidth(bp, armType) + halfWidth(bp, ringType) + 3) + 8;
  return Math.ceil((need * 2) / Math.PI);
}

export function roundaboutSmall(bp: Blueprint, ctx: BuildContext): void {
  const arm = twoWayType(ctx, 'street-2');
  const radius = Math.max(ctx.p.radius, ringFloor(bp, arm, 'ramp-1'));
  buildRing(bp, radius, 'ramp-1', [arm, arm, arm, arm], ctx.p.armLength, 30);
}

export function roundaboutLarge(bp: Blueprint, ctx: BuildContext): void {
  const arm = twoWayType(ctx, 'avenue-4');
  const radius = Math.max(ctx.p.radius, ringFloor(bp, arm, 'ramp-2'));
  buildRing(bp, radius, 'ramp-2', [arm, arm, arm, arm], ctx.p.armLength, 35);
}

/**
 * Turbo roundabout. Each major approach feeds both ring lanes, the outer lane must
 * leave at the next major exit, and the inner lane spirals out to become the outer
 * lane there, so nobody weaves. Minor approaches feed both lanes as well.
 */
export function roundaboutTurbo(bp: Blueprint, ctx: BuildContext): void {
  const major = twoWayType(ctx, 'avenue-4');
  const minor = 'street-2';
  const ringType = bp.customType(
    makeCustomRoadType({
      id: 'tpl-turbo-ring',
      name: 'Turbo ring',
      category: 'ramp',
      rank: 2,
      forwardLanes: 2,
      backwardLanes: 0,
      laneWidth: 3.75,
      shoulder: 1.5,
      speedKmh: 35,
      markings: { laneLine: 'solid' },
    }),
  );
  const radius = Math.max(ctx.p.radius, ringFloor(bp, major, ringType));
  const armTypes = [major, minor, major, minor];
  const ring = buildRing(bp, radius, ringType, armTypes, ctx.p.armLength, 35);
  bp.finish();
  ring.nodes.forEach((node, k) => {
    const ringIn = arriving(ring.quarters[(k + 3) % 4]);
    const ringOut = leaving(ring.quarters[k]);
    const arm = leaving(ring.arms[k]);
    const armIn = bp.armLanes(node, arm, 'in').length;
    const armOut = bp.armLanes(node, arm, 'out').length;
    const links: BpLaneLink[] = [];
    const add = (from: BpLaneLink['from'], fromLane: number, to: BpLaneLink['to'], toLane: number) =>
      links.push({ from, fromLane, to, toLane });
    const isMajor = k % 2 === 0 && armIn >= 2;
    if (isMajor) {
      add(ringIn, 1, arm, armOut - 1); // Outer lane must leave.
      add(ringIn, 0, arm, 0);
      add(ringIn, 0, ringOut, 1); // Inner lane spirals out.
      add(arm, 0, ringOut, 0);
      for (let i = 1; i < armIn; i++) add(arm, i, ringOut, 1);
    } else {
      add(ringIn, 1, arm, armOut - 1);
      add(ringIn, 1, ringOut, 1);
      add(ringIn, 0, ringOut, 0);
      add(arm, 0, ringOut, 0);
      add(arm, armIn - 1, ringOut, 1);
    }
    bp.addLinks(node, links);
  });
}

// ---------------------------------------------------------------------------
// Signalised crossing
// ---------------------------------------------------------------------------

/**
 * Two avenues crossing at a signal. The left lane of every approach is a dedicated
 * turn lane with its own protected phase; the rest go straight and the kerb lane
 * also turns right.
 */
export function signalisedCrossing(bp: Blueprint, ctx: BuildContext): void {
  const lanes = ctx.p.lanesPerDirection;
  const type = twoWayType(ctx, lanes <= 2 ? 'avenue-4' : lanes === 3 ? 'avenue-6' : 'boulevard-8');
  const len = ctx.p.armLength;
  const headings = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const names = ['E', 'S', 'W', 'N'];
  const arms = headings.map((h, k) => {
    const arm = bp.road({
      name: `Avenue ${names[k]}`,
      path: new Path({ x: 0, z: 0, h }).line(len),
      profile: Profile.flat(0),
      type,
    });
    bp.port(names[k], arm, 'end', 'both');
    return arm;
  });
  const centre = bp.pin({ x: 0, y: 0, z: 0 });
  bp.finish();
  const links: BpLaneLink[] = [];
  for (let k = 0; k < 4; k++) {
    const from = leaving(arms[k]);
    const ahead = leaving(arms[(k + 2) % 4]);
    // Travelling towards the centre from arm k: its right is arm k-1 round the
    // clock order E, S, W, N, its left is arm k+1.
    const right = leaving(arms[(k + 3) % 4]);
    const left = leaving(arms[(k + 1) % 4]);
    const inLanes = bp.armLanes(centre, from, 'in').length;
    const out = bp.armLanes(centre, ahead, 'out').length;
    links.push({ from, fromLane: 0, to: left, toLane: 0 });
    for (let i = 1; i < inLanes; i++) links.push({ from, fromLane: i, to: ahead, toLane: Math.min(i, out - 1) });
    if (inLanes === 1) links.push({ from, fromLane: 0, to: ahead, toLane: 0 });
    links.push({ from, fromLane: inLanes - 1, to: right, toLane: bp.armLanes(centre, right, 'out').length - 1 });
  }
  bp.addLinks(centre, links);
  // A protected left phase then a through phase, for each avenue in turn. The left
  // phase gets more than the usual share because it has one lane to the others' two.
  const axis = (k: number, name: string): BpPhase[] => {
    const a = leaving(arms[k]);
    const b = leaving(arms[k + 2]);
    const left = (i: number) => leaving(arms[(i + 1) % 4]);
    const right = (i: number) => leaving(arms[(i + 3) % 4]);
    const state = 'protected' as const;
    return [
      {
        name: `${name} lefts`,
        greenSec: 15,
        moves: [
          { from: a, to: left(k), state },
          { from: b, to: left(k + 2), state },
        ],
      },
      {
        name: `${name} through`,
        greenSec: 22,
        moves: [
          { from: a, to: b, state },
          { from: b, to: a, state },
          { from: a, to: right(k), state },
          { from: b, to: right(k + 2), state },
        ],
      },
    ];
  };
  bp.control(centre, { kind: 'phases', phases: [...axis(0, 'East-west'), ...axis(1, 'North-south')] });
}

// ---------------------------------------------------------------------------
// Highway pieces
// ---------------------------------------------------------------------------

/**
 * An off-ramp then an on-ramp on one carriageway, exit first so the two flows never
 * weave. The ramps curve away to the right and end in stubs for local roads.
 */
export function onOffRamps(bp: Blueprint, ctx: BuildContext): void {
  const type = mainType(ctx, ctx.p.mainLanes);
  const ramp = rampType(ctx.p.rampLanes);
  const theta = clearAngle(bp, type, ramp);
  const radius = ctx.p.rampRadius;
  const shape = new Path({ x: 0, z: 0, h: theta }).line(RAMP_RUN).right(radius, Math.PI / 2 - theta);
  // The two ramps curve towards each other, so the gores must leave them room.
  const gore = Math.max(ctx.p.spacing / 2, shape.end.x + 24);
  const half = gore + RAMP_RUN + 240;
  const main = bp.road({
    name: 'Mainline',
    path: new Path({ x: -half, z: 0, h: 0 }).line(half * 2),
    profile: Profile.flat(0),
    type,
  });
  bp.port('W.in', main, 'start', 'in');
  bp.port('E.out', main, 'end', 'out');
  const off = bp.road({
    name: 'Off-ramp',
    path: new Path({ x: -gore, z: 0, h: theta }).line(RAMP_RUN).right(radius, Math.PI / 2 - theta).line(ctx.p.rampLength),
    profile: Profile.flat(0),
    type: ramp,
  });
  bp.port('off', off, 'end', 'out');
  // The on-ramp is the off-ramp mirrored and driven the other way.
  const e = off.path.end;
  const on = bp.road({
    name: 'On-ramp',
    path: new Path({ x: -e.x, z: e.z, h: -Math.PI / 2 })
      .line(ctx.p.rampLength)
      .right(radius, Math.PI / 2 - theta)
      .line(RAMP_RUN),
    profile: Profile.flat(0),
    type: ramp,
  });
  bp.port('on', on, 'start', 'in');
}

/** A mainline that gains a lane, runs for a while, then loses it again. */
export function laneAddDrop(bp: Blueprint, ctx: BuildContext): void {
  const base = mainType(ctx, ctx.p.mainLanes);
  const lanes = Number(/(\d+)$/.exec(base)?.[1] ?? 3);
  const wide = `highway-${Math.min(5, lanes + 1)}`;
  const run = ctx.p.addedLength;
  const stub = ctx.p.stubLength;
  const makeRoad = (name: string, x0: number, len: number, type: string) =>
    bp.road({ name, path: new Path({ x: x0, z: 0, h: 0 }).line(len), profile: Profile.flat(0), type });
  const narrow = lanes >= 5 ? 'highway-4' : base;
  const inRoad = makeRoad('Approach', -run / 2 - stub, stub, narrow);
  const middle = makeRoad('Added lane', -run / 2, run, wide);
  const outRoad = makeRoad('Departure', run / 2, stub, narrow);
  bp.port('W.in', inRoad, 'start', 'in');
  bp.port('E.out', outRoad, 'end', 'out');
  bp.finish();
  // The lane comes and goes on the right, and the other lanes keep their order.
  const count = Math.min(lanes, 4);
  const addNode = bp.pin(middle.start);
  const dropNode = bp.pin(middle.end);
  const straight = Array.from({ length: count }, (_, i) => i);
  bp.addLinks(addNode, [
    ...straight.map((i) => ({ from: arriving(inRoad), fromLane: i, to: leaving(middle), toLane: i })),
    { from: arriving(inRoad), fromLane: count - 1, to: leaving(middle), toLane: count },
  ]);
  bp.addLinks(dropNode, [
    ...straight.map((i) => ({ from: arriving(middle), fromLane: i, to: leaving(outRoad), toLane: i })),
    { from: arriving(middle), fromLane: count, to: leaving(outRoad), toLane: count - 1 },
  ]);
}
