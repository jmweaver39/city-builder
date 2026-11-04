/**
 * Persisted shapes for road upgrades: street lights, trees, guard rails, bus stops
 * and bike racks, set per side of a segment or on its median. Sound barriers and
 * structures keep their own fields (wallTypes.ts); the upgrade cards edit those
 * too. Logic lives in roadUpgrades.ts.
 */

/** 'none' is an explicit choice: no lamps here, not even the automatic ones. */
export type LightStyle = 'none' | 'standard' | 'double' | 'decorative' | 'highmast';
/** Trees in pits, a grass verge with trees, or a clipped hedge. */
export type TreeStyle = 'trees' | 'grass' | 'hedge';
/** Steel W-beam rail, concrete jersey barrier, or tensioned cable barrier. */
export type RailStyle = 'wbeam' | 'jersey' | 'cable';

/** One side of a road, left and right as seen along segment a to b. */
export interface SideUpgrades {
  lights?: LightStyle;
  trees?: TreeStyle;
  rail?: RailStyle;
  busStop?: boolean;
  bikeRacks?: boolean;
}

/** The median of a road that has one. */
export interface MedianUpgrades {
  lights?: LightStyle;
  trees?: TreeStyle;
  rail?: RailStyle;
}

export interface RoadUpgrades {
  left?: SideUpgrades;
  right?: SideUpgrades;
  median?: MedianUpgrades;
}

/** Where an upgrade goes on a segment. */
export type UpgradePlace = 'left' | 'right' | 'median';

export type UpgradeCardId = 'lights' | 'barriers' | 'structure' | 'trees' | 'rails' | 'stops' | 'remove';

export interface UpgradeStyleDef {
  value: string;
  label: string;
  desc: string;
}

export interface UpgradeCardDef {
  id: UpgradeCardId;
  label: string;
  desc: string;
  styles: readonly UpgradeStyleDef[];
  /** Style picked until the player picks another. */
  defaultStyle: string;
  /** A centre click goes on the median, where the road has one. */
  median: boolean;
}

export const LIGHT_STYLES: readonly UpgradeStyleDef[] = [
  { value: 'standard', label: 'Single arm', desc: 'A lamp post with one arm over the road' },
  { value: 'double', label: 'Double arm', desc: 'Two arms from one post, for the median' },
  { value: 'decorative', label: 'Decorative', desc: 'Lantern posts for streets and squares' },
  { value: 'highmast', label: 'High mast', desc: 'Tall masts with a ring of lamps, for highways' },
  { value: 'none', label: 'No lights', desc: 'No lamps, not even the automatic ones' },
];

export const TREE_STYLES: readonly UpgradeStyleDef[] = [
  { value: 'trees', label: 'Street trees', desc: 'Trees in pits on the sidewalk, or along the median' },
  { value: 'grass', label: 'Grass and trees', desc: 'A grass verge planted with trees' },
  { value: 'hedge', label: 'Hedge', desc: 'A clipped hedge along the edge or median' },
];

export const RAIL_STYLES: readonly UpgradeStyleDef[] = [
  { value: 'wbeam', label: 'W-beam', desc: 'Steel guard rail on posts' },
  { value: 'jersey', label: 'Concrete jersey', desc: 'A low concrete safety barrier' },
  { value: 'cable', label: 'Cable barrier', desc: 'Tensioned steel cables on thin posts' },
];

export const STOP_STYLES: readonly UpgradeStyleDef[] = [
  { value: 'bus', label: 'Bus stop', desc: 'A shelter and sign halfway along the sidewalk' },
  { value: 'bike', label: 'Bike racks', desc: 'Stands for bikes on the sidewalk' },
];

export const UPGRADE_CARDS: readonly UpgradeCardDef[] = [
  { id: 'lights', label: 'Street lights', desc: 'Lamp posts, spaced to suit the road. They replace the automatic ones', styles: LIGHT_STYLES, defaultStyle: 'standard', median: true },
  {
    id: 'barriers',
    label: 'Sound barriers',
    desc: 'Noise walls along the road edge',
    styles: [
      { value: 'concrete', label: 'Concrete', desc: 'Concrete panels' },
      { value: 'acrylic', label: 'Acrylic', desc: 'Transparent acrylic panels' },
      { value: 'timber', label: 'Timber', desc: 'Timber boards' },
      { value: 'metal', label: 'Metal', desc: 'Perforated metal acoustic panels' },
      { value: 'berm', label: 'Earth berm', desc: 'A grassed earth bank' },
    ],
    defaultStyle: 'concrete',
    median: false,
  },
  {
    id: 'structure',
    label: 'Walls and structure',
    desc: 'Embankment, retaining walls or a trench where the road leaves the ground',
    styles: [
      { value: 'embankment', label: 'Embankment', desc: 'Raised on an earth bank with sloped sides' },
      { value: 'retaining', label: 'Retaining wall', desc: 'Vertical walls instead of slopes. A side click walls that side only' },
      { value: 'trench', label: 'Trench', desc: 'Sunk in an open cut between walls' },
    ],
    defaultStyle: 'retaining',
    median: false,
  },
  { id: 'trees', label: 'Trees', desc: 'Street trees, grass verges and hedges', styles: TREE_STYLES, defaultStyle: 'trees', median: true },
  { id: 'rails', label: 'Guard rails', desc: 'Safety barriers along the edge or the median', styles: RAIL_STYLES, defaultStyle: 'wbeam', median: true },
  { id: 'stops', label: 'Stops and racks', desc: 'Bus stops and bike racks on the sidewalk', styles: STOP_STYLES, defaultStyle: 'bus', median: false },
  { id: 'remove', label: 'Remove', desc: 'Clears the upgrades under the click: a side, or the whole road from the middle', styles: [{ value: 'all', label: 'Remove all', desc: 'Lights, trees, rails, stops, barriers and walls' }], defaultStyle: 'all', median: false },
];

export function upgradeCard(id: UpgradeCardId): UpgradeCardDef {
  return UPGRADE_CARDS.find((c) => c.id === id)!;
}
