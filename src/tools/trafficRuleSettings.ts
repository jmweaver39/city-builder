/** Settings of the Traffic Rules tool (TrafficRulesTool.ts), kept in EditorSettings. */
import type { VehicleClass } from '../core/trafficRuleTypes';
import type { ArmRuleKey } from '../core/trafficRuleTypes';

export type RuleMode = 'arrows' | 'speed' | 'vehicles' | 'junction' | 'priority' | 'manual' | 'timed' | 'clear';

export interface RuleModeInfo {
  mode: RuleMode;
  name: string;
  desc: string;
  /** Key within the tool. */
  key: string;
}

export const RULE_MODES: readonly RuleModeInfo[] = [
  { mode: 'arrows', name: 'Lane arrows', desc: 'Click the arrows at a lane end to allow or forbid each turn', key: 'Shift+1' },
  { mode: 'speed', name: 'Speed limits', desc: 'Pick a sign, then click roads (Shift: one lane)', key: 'Shift+2' },
  { mode: 'vehicles', name: 'Vehicles', desc: 'Pick a vehicle, then click roads to ban or allow it (Shift: one lane)', key: 'Shift+3' },
  { mode: 'junction', name: 'Junction rules', desc: 'Click the icons on each arm: U-turns, lane changes, blocking, crossings, turn on red', key: 'Shift+4' },
  { mode: 'priority', name: 'Priority road', desc: 'Click a road: it goes first all along, side roads yield (Shift: back to auto)', key: 'Shift+5' },
  { mode: 'manual', name: 'Manual lights', desc: 'Click a junction with lights, then click each light to switch it', key: 'Shift+6' },
  { mode: 'timed', name: 'Timed lights', desc: 'Copy and paste a plan, or click junctions in order for a green wave', key: 'Shift+7' },
  { mode: 'clear', name: 'Clear traffic', desc: 'Remove all vehicles or just stuck ones; pause spawning', key: 'Shift+8' },
];

export type TimedAction = 'copy' | 'paste' | 'wave';

export interface TrafficRuleSettings {
  mode: RuleMode;
  /** The speed sign a click sets, km/h, or null for the road's own limit. */
  speed: number | null;
  /** The class a click bans or allows. */
  vehicle: VehicleClass;
  /** Junction rules: the switch a click on an arm toggles; null shows every switch as icons. */
  rule: ArmRuleKey | null;
  timed: TimedAction;
  /** Green wave design speed, km/h. */
  waveSpeed: number;
  /** Show every rule's overlay icons over the whole map, not just near the cursor. */
  showAll: boolean;
}

export function defaultTrafficRuleSettings(): TrafficRuleSettings {
  return { mode: 'arrows', speed: 50, vehicle: 'truck', rule: null, timed: 'copy', waveSpeed: 50, showAll: false };
}
