/** What each template must carry, written out by hand so tests do not trust the template. */
export type Move = readonly [string, string];

const pairs = (froms: string[], tos: string[]): Move[] => froms.flatMap((f) => tos.map((t) => [f, t] as Move));

/** Four two-way arms: every arm reaches every other. */
const fourWay = (names: string[]): Move[] => names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b] as Move));

/** Highway one-way legs W, E plus two-way cross road N, S. */
const serviceMoves: Move[] = [
  ['W.in', 'E.out'],
  ['E.in', 'W.out'],
  ['W.in', 'N'],
  ['W.in', 'S'],
  ['E.in', 'N'],
  ['E.in', 'S'],
  ['N', 'E.out'],
  ['N', 'W.out'],
  ['S', 'E.out'],
  ['S', 'W.out'],
  ['N', 'S'],
  ['S', 'N'],
];

/** All twelve movements of a four-leg highway junction, named one by one. */
const twelveMoves: Move[] = [
  ['W.in', 'E.out'],
  ['W.in', 'N.out'],
  ['W.in', 'S.out'],
  ['E.in', 'W.out'],
  ['E.in', 'N.out'],
  ['E.in', 'S.out'],
  ['N.in', 'S.out'],
  ['N.in', 'E.out'],
  ['N.in', 'W.out'],
  ['S.in', 'N.out'],
  ['S.in', 'E.out'],
  ['S.in', 'W.out'],
];

export interface MainRun {
  from: string;
  to: string;
  /** What the driver passes, in order. */
  events: ('exit' | 'entry')[];
}

const both = (a: MainRun['events']): MainRun[] => [
  { from: 'W.in', to: 'E.out', events: a },
  { from: 'E.in', to: 'W.out', events: a },
];

const all = (a: MainRun['events']): MainRun[] => [
  ...both(a),
  { from: 'N.in', to: 'S.out', events: a },
  { from: 'S.in', to: 'N.out', events: a },
];

/** Mainline runs for the templates that have a highway through them. */
export const MAIN_RUNS: Record<string, MainRun[]> = {
  'on-off-ramps': [{ from: 'W.in', to: 'E.out', events: ['exit', 'entry'] }],
  'lane-add-drop': [{ from: 'W.in', to: 'E.out', events: [] }],
  // Exit before entry on everything with a terminal.
  diamond: both(['exit', 'entry']),
  spui: both(['exit', 'entry']),
  parclo: both(['exit', 'entry', 'entry']),
  'diverging-diamond': both(['exit', 'entry']),
  trumpet: both(['exit', 'entry']),
  // The classic cloverleaf weave is entry then exit between the two loops.
  cloverleaf: all(['exit', 'entry', 'exit', 'entry']),
  'stack-3': all(['exit', 'exit', 'entry', 'entry']),
  'stack-4': all(['exit', 'exit', 'entry', 'entry']),
  turbine: all(['exit', 'exit', 'entry', 'entry']),
};

export const SPECS: Record<string, { moves: Move[] }> = {
  'roundabout-small': { moves: fourWay(['E', 'N', 'W', 'S']) },
  'roundabout-large': { moves: fourWay(['E', 'N', 'W', 'S']) },
  'roundabout-turbo': { moves: fourWay(['E', 'N', 'W', 'S']) },
  'signal-crossing': { moves: fourWay(['E', 'N', 'W', 'S']) },
  'on-off-ramps': {
    moves: [
      ['W.in', 'E.out'],
      ['W.in', 'off'],
      ['on', 'E.out'],
    ],
  },
  'lane-add-drop': { moves: [['W.in', 'E.out']] },
  diamond: { moves: serviceMoves },
  spui: { moves: serviceMoves },
  parclo: { moves: serviceMoves },
  cloverleaf: { moves: twelveMoves },
  'diverging-diamond': { moves: serviceMoves },
  trumpet: {
    moves: [
      ['W.in', 'E.out'],
      ['E.in', 'W.out'],
      ['W.in', 'S.out'],
      ['E.in', 'S.out'],
      ['S.in', 'E.out'],
      ['S.in', 'W.out'],
    ],
  },
  'stack-3': { moves: twelveMoves },
  'stack-4': { moves: twelveMoves },
  turbine: { moves: twelveMoves },
};

