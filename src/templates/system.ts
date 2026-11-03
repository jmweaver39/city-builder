/**
 * System interchanges: free-flowing junctions between highways. No signals and no
 * at-grade crossings; every conflict is solved by height.
 */
import { Blueprint, type Road } from './blueprint';
import {
  LEVEL,
  RAMP_FLAT,
  RAMP_RUN,
  STUB,
  addLoop,
  addRamp,
  addRightTurn,
  carriagewayOffset,
  clearAngle,
  eastWest,
  halfWidth,
  hump,
  humpHalf,
  mainType,
  northSouth,
  rampPath,
  rampType,
  rightTurnReach,
  type BuildContext,
} from './kit';
import { Path, Profile, VERTICAL_BLEND, deg } from './path';

// ---------------------------------------------------------------------------
// Trumpet
// ---------------------------------------------------------------------------

/**
 * A spur from the south meets a through highway. The spur's northbound road climbs
 * over the highway and loops round on to it westbound. The opposite left turn is a
 * long flyover. On the westbound carriageway the flyover leaves before the loop
 * joins, so exit comes before entry.
 */
export function trumpet(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const stem = `highway-${p.stemLanes}`;
  const ramp = rampType(p.rampLanes);
  const loopType = 'ramp-1';
  const R = p.loopRadius;
  const flyR = p.flyoverRadius;
  const m = carriagewayOffset(bp, main);
  const ms = carriagewayOffset(bp, stem);
  const theta = clearAngle(bp, main, ramp);
  const loopTheta = Math.max(theta, deg(15));

  // Where the loop lands decides how far away the flyover must leave.
  const run = Math.max(58, (halfWidth(bp, main) + halfWidth(bp, loopType) + 3) / Math.sin(loopTheta));
  const zc = -m - R * Math.cos(loopTheta) - run * Math.sin(loopTheta);
  const loopLand = ms + R + R * Math.sin(loopTheta) - run * Math.cos(loopTheta);

  // The flyover is one long left curve from the westbound carriageway on to a
  // heading due south along the spur, so its radius fixes where it has to leave.
  const baseRun = RAMP_RUN + 40;
  const shape = new Path({ x: 0, z: 0, h: Math.PI + theta }).line(baseRun).left(flyR, Math.PI / 2 + theta);
  const needed = -ms - shape.end.x;
  const far = Math.max(needed, loopLand + 240);
  const half = far + 60 + RAMP_RUN + STUB + 40;
  const { eb, wb } = eastWest(bp, main, m, half, () => Profile.flat(0));

  const flyStart = wb.before(far);
  const flyRun = baseRun + (far - needed) / Math.cos(theta);
  const flyPath = new Path({ x: flyStart.x, z: flyStart.z, h: flyStart.h + theta })
    .line(flyRun)
    .left(flyR, Math.PI / 2 + theta)
    .line(RAMP_RUN + 230);
  const firstOver = flyPath.crossings(wb.path).filter((c) => c.s > 60)[0].s;
  const fly = bp.road({
    name: 'Flyover to the spur',
    path: flyPath,
    profile: new Profile([
      [0, 0],
      [flyRun + VERTICAL_BLEND, 0],
      [firstOver - 24, LEVEL],
      [flyPath.length - RAMP_FLAT - 150, LEVEL],
      [flyPath.length - RAMP_FLAT, 0],
      [flyPath.length, 0],
    ]),
    type: ramp,
  });
  const Qz = fly.end.z;
  const stemLen = STUB + 120;
  const nbStart = Qz + stemLen;
  const stemIn = bp.road({
    name: 'Spur northbound',
    path: new Path({ x: ms, z: nbStart, h: -Math.PI / 2 }).line(stemLen),
    profile: Profile.flat(0),
    type: stem,
  });
  const stemOut = bp.road({
    name: 'Spur southbound',
    path: new Path({ x: -ms, z: Qz, h: Math.PI / 2 }).line(stemLen),
    profile: Profile.flat(0),
    type: stem,
  });
  bp.port('S.in', stemIn, 'start', 'in');
  bp.port('S.out', stemOut, 'end', 'out');

  // Up the spur, over the highway and round. Keeps low until past the flyover.
  const climb = new Path({ x: ms, z: Qz, h: -Math.PI / 2 })
    .line(Qz - zc)
    .right(R, deg(270) - loopTheta)
    .line(run);
  const overFly = climb.crossings(fly.path)[0];
  const overEbS = climb.crossings(eb.path)[0].s;
  const overWbS = climb.crossings(wb.path)[0].s;
  bp.road({
    name: 'Spur loop',
    path: climb,
    profile: new Profile([
      [0, 0],
      [overFly.s + 24, 0],
      [overEbS - 24, LEVEL],
      [overWbS + 24, LEVEL],
      [climb.length - run - 24, 0],
      [climb.length, 0],
    ], 24),
    type: loopType,
    overrides: { speedKmh: 45 },
  });

  addRamp(bp, 'Spur to eastbound', ramp, {
    from: stemIn.end,
    to: eb.after(far + 60),
    exitAngle: deg(14),
    mergeAngle: theta,
    r1: 160,
    turns: [1, 1],
  });
  addRamp(bp, 'Eastbound to spur', ramp, {
    from: eb.before(far + 60),
    to: stemOut.start,
    exitAngle: theta,
    mergeAngle: deg(14),
    r1: 160,
    turns: [1, 1],
  });
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

interface StackPlan {
  theta: number;
  run: number;
  /** Distance from the centre to where a left-turn ramp leaves and joins. */
  far: number;
}

/** Stations of `a` that lie within `reach` of `b` in plan. */
function stationsNear(a: Path, b: Path, reach: number): number[] {
  const out: number[] = [];
  for (let s = 0; s <= a.length; s += 6) {
    const p = a.poseAt(s);
    if (b.project(p.x, p.z).distance < reach) out.push(s);
  }
  return out;
}

/** Fit a left-turn ramp: straight off, a long left curve past the centre, straight on. */
function planStack(radius: number, theta: number, m: number, mc: number, run: number): StackPlan {
  const q = new Path({ x: 0, z: 0, h: theta }).line(run).left(radius, theta + deg(45)).end;
  // The ramp is symmetric, so it must not reach its heading of -45 degrees past the
  // diagonal. It also has to pass on its own side of the centre, back to back with
  // the ramp going the other way, which a long run can push it across.
  const mean = (m + mc) / 2;
  const noWrap = q.x - q.z - mean + 8;
  const ownSide = q.x + q.z + mean + 2 * 24;
  return { theta, run, far: Math.max(noWrap, ownSide) };
}

function leftFlyover(
  bp: Blueprint,
  name: string,
  type: string,
  inRoad: Road,
  outRoad: Road,
  plan: StackPlan,
  radius: number,
  level: number,
  under: readonly Road[] = [],
): Road {
  const from = inRoad.before(plan.far);
  const to = outRoad.after(plan.far);
  return addRamp(
    bp,
    name,
    type,
    {
      from,
      to,
      exitAngle: plan.theta,
      mergeAngle: plan.theta,
      exitRun: plan.run,
      mergeRun: plan.run,
      r1: radius,
      turns: [-1, -1],
    },
    (path) => {
      // Stay at full height from the first road crossed to the last.
      const inner = (s: number) => s > 40 && s < path.length - 40;
      const over = [inRoad, outRoad].flatMap((r) => path.crossings(r.path).map((c) => c.s)).filter(inner);
      // Hold full height for as long as the ramp's surface is over a loop's.
      const reach = halfWidth(bp, type) * 2 + 6;
      const loops = under.flatMap((r) => stationsNear(path, r.path, reach)).filter(inner);
      const firstOver = Math.min(...over, ...loops);
      const lastOver = Math.max(...over, ...loops);
      return new Profile([
        [0, from.y],
        [RAMP_FLAT, from.y],
        [firstOver - 16, level],
        [lastOver + 16, level],
        [path.length - RAMP_FLAT, to.y],
        [path.length, to.y],
      ]);
    },
  );
}

/** The steepest a flyover may be. Higher levels need longer ramps, not steeper ones. */
const FLYOVER_GRADE = 0.06;

function stack(bp: Blueprint, ctx: BuildContext, fourLevel: boolean): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const crossMain = `highway-${p.crossLanes}`;
  const ramp = rampType(p.rampLanes);
  const R = p.rampRadius;
  const m = carriagewayOffset(bp, main);
  const mc = carriagewayOffset(bp, crossMain);
  const theta = Math.max(clearAngle(bp, main, ramp), clearAngle(bp, crossMain, ramp));

  const layout = (into: Blueprint, plan: StackPlan, span: number, crossHalf: number, crossProfile: (len: number) => Profile) => {
    const { eb, wb } = eastWest(into, main, m, span, () => Profile.flat(0));
    const { sb, nb } = northSouth(into, crossMain, mc, crossHalf, crossProfile);
    const flyovers: Road[] = [];
    if (fourLevel) {
      flyovers.push(
        leftFlyover(into, 'Flyover eastbound to northbound', ramp, eb, nb, plan, R, 2 * LEVEL),
        leftFlyover(into, 'Flyover westbound to southbound', ramp, wb, sb, plan, R, 2 * LEVEL),
        leftFlyover(into, 'Flyover northbound to westbound', ramp, nb, wb, plan, R, 3 * LEVEL),
        leftFlyover(into, 'Flyover southbound to eastbound', ramp, sb, eb, plan, R, 3 * LEVEL),
      );
    } else {
      const under = [
        addLoop(into, 'Loop northbound to westbound', 'ramp-1', nb, wb, p.loopRadius).road,
        addLoop(into, 'Loop southbound to eastbound', 'ramp-1', sb, eb, p.loopRadius).road,
      ];
      flyovers.push(
        leftFlyover(into, 'Flyover eastbound to northbound', ramp, eb, nb, plan, R, 2 * LEVEL, under),
        leftFlyover(into, 'Flyover westbound to southbound', ramp, wb, sb, plan, R, 2 * LEVEL, under),
      );
    }
    return { eb, wb, sb, nb, flyovers };
  };

  // Lengthen the straight runs until every flyover makes its height at a fair grade.
  let plan = planStack(R, theta, m, mc, RAMP_RUN + 80);
  for (let run = RAMP_RUN + 80; run < 800; run += 20) {
    plan = planStack(R, theta, m, mc, run);
    const trial = layout(new Blueprint(), plan, 3000, 3000, () => Profile.flat(LEVEL));
    if (trial.flyovers.every((f) => f.profile.maxGrade() <= FLYOVER_GRADE)) break;
  }

  const reach = plan.far + 230;
  const span = reach + RAMP_RUN + STUB;
  const flat = reach + RAMP_RUN + 10;
  const { eb, wb, sb, nb } = layout(bp, plan, span, humpHalf(LEVEL, flat), hump(LEVEL, flat));
  const turnR = 170;
  addRightTurn(bp, 'Eastbound to southbound', ramp, eb, sb, reach, turnR);
  addRightTurn(bp, 'Southbound to westbound', ramp, sb, wb, reach, turnR);
  addRightTurn(bp, 'Westbound to northbound', ramp, wb, nb, reach, turnR);
  addRightTurn(bp, 'Northbound to eastbound', ramp, nb, eb, reach, turnR);
}

export const stackThreeLevel = (bp: Blueprint, ctx: BuildContext): void => stack(bp, ctx, false);
export const stackFourLevel = (bp: Blueprint, ctx: BuildContext): void => stack(bp, ctx, true);

// ---------------------------------------------------------------------------
// Turbine
// ---------------------------------------------------------------------------

/**
 * Left turns sweep round the centre like the blades of a turbine, each crossing only
 * the road it is turning on to. The ramps all stay on the middle level, over one
 * highway and under the other, so they need no height of their own.
 */
export function turbine(bp: Blueprint, ctx: BuildContext): void {
  const { p } = ctx;
  const main = mainType(ctx, p.mainLanes);
  const crossMain = `highway-${p.crossLanes}`;
  const ramp = rampType(p.rampLanes);
  const R = p.rampRadius;
  const m = carriagewayOffset(bp, main);
  const mc = carriagewayOffset(bp, crossMain);
  const low = 0;
  const high = 2 * LEVEL;
  const mid = LEVEL;

  const merge = RAMP_RUN + halfWidth(bp, main) + 40;
  const leave = p.reach;
  // A long straight on to the road pushes the blade out, leaving room to climb.
  const bladeTail = RAMP_RUN + 110;
  // The outer ramps go round the blades, so everything is sized from a stand-in.
  const standIn = new Blueprint();
  const lay = (path: Path, name: string, type: string) => standIn.road({ name, path, profile: Profile.flat(0), type });
  const standEb = lay(new Path({ x: -2000, z: m, h: 0 }).line(4000), 'x', main);
  const standWb = lay(new Path({ x: 2000, z: -m, h: Math.PI }).line(4000), 'x', main);
  const standSb = lay(new Path({ x: -mc, z: -2000, h: Math.PI / 2 }).line(4000), 'x', crossMain);
  const standNb = lay(new Path({ x: mc, z: 2000, h: -Math.PI / 2 }).line(4000), 'x', crossMain);
  const bladePath = (a: Road, b: Road) =>
    rampPath({
      from: a.before(leave),
      to: b.before(merge),
      exitAngle: clearAngle(bp, a.type, ramp),
      mergeAngle: clearAngle(bp, b.type, ramp),
      mergeRun: bladeTail,
      r1: 170,
      r2: R,
      turns: [1, -1],
    });
  const turnR = 170;
  const gap = halfWidth(bp, ramp) * 2 + 8;
  const reach = Math.max(
    rightTurnReach(standIn, ramp, standEb, standSb, turnR, leave + 190, [bladePath(standEb, standNb), bladePath(standSb, standEb)], gap),
    rightTurnReach(standIn, ramp, standNb, standEb, turnR, leave + 190, [bladePath(standNb, standWb), bladePath(standEb, standNb)], gap),
  );
  const span = reach + RAMP_RUN + STUB;
  const { eb, wb } = eastWest(bp, main, m, span, () => Profile.flat(low));
  const flat = reach + RAMP_RUN + 10;
  const half = humpHalf(high, flat);
  const { sb, nb } = northSouth(bp, crossMain, mc, half, hump(high, flat));

  const blade = (name: string, inRoad: Road, outRoad: Road, overRoad: readonly Road[]): Road => {
    const from = inRoad.before(leave);
    const to = outRoad.before(merge);
    const thetaIn = clearAngle(bp, inRoad.type, ramp);
    const thetaOut = clearAngle(bp, outRoad.type, ramp);
    return addRamp(
      bp,
      name,
      ramp,
      { from, to, exitAngle: thetaIn, mergeAngle: thetaOut, mergeRun: bladeTail, r1: 170, r2: R, turns: [1, -1] },
      (path) => {
        const hits = overRoad.map((r) => path.crossings(r.path)[0]?.s ?? path.length / 2).sort((a, b) => a - b);
        return new Profile([
          [0, from.y],
          [RAMP_FLAT, from.y],
          [hits[0] - 26, mid],
          [hits[hits.length - 1] + 26, mid],
          [path.length - RAMP_FLAT, to.y],
          [path.length, to.y],
        ]);
      },
    );
  };
  blade('Blade eastbound to northbound', eb, nb, [sb, nb]);
  blade('Blade northbound to westbound', nb, wb, [eb, wb]);
  blade('Blade westbound to southbound', wb, sb, [sb, nb]);
  blade('Blade southbound to eastbound', sb, eb, [eb, wb]);

  addRightTurn(bp, 'Eastbound to southbound', ramp, eb, sb, reach, turnR);
  addRightTurn(bp, 'Southbound to westbound', ramp, sb, wb, reach, turnR);
  addRightTurn(bp, 'Westbound to northbound', ramp, wb, nb, reach, turnR);
  addRightTurn(bp, 'Northbound to eastbound', ramp, nb, eb, reach, turnR);
}
