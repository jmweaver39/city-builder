/**
 * Wires the traffic rules into the app: road signs for speed limits and bans,
 * and the keys and palette commands of Junction > Rules.
 */
import type { RoadNetwork } from '../core/RoadNetwork';
import type { Renderer } from '../render/Renderer';
import { TrafficSignLayer } from '../render/trafficSigns';
import type { SimApi } from '../sim/api';
import type { ToolManager } from '../tools/ToolManager';
import { RULE_MODES } from '../tools/trafficRuleSettings';
import { registerKeys, type KeyBinding } from '../ui/keymap';
import type { UI } from '../ui/UI';

export function installTrafficRules(opts: { net: RoadNetwork; sim: SimApi; renderer: Renderer; tools: ToolManager; ui: UI }): () => void {
  const { net, sim, renderer, tools, ui } = opts;
  const layer = new TrafficSignLayer(net, renderer.context);
  const removeLayer = renderer.context.addLayer(layer);
  const open = (mode: (typeof RULE_MODES)[number]['mode']) => () => {
    tools.settings.trafficRules.mode = mode;
    ui.toolbar.openTab('junction');
    tools.setTool('trafficRules');
    tools.settingsChanged();
  };
  const keys: KeyBinding[] = [
    ...RULE_MODES.map((m) => ({
      id: `rules.${m.mode}`,
      label: m.name,
      group: 'Traffic rules',
      keys: [],
      scope: 'global' as const,
      desc: m.desc,
      run: open(m.mode),
    })),
    { id: 'rules.step', label: 'Next or previous sign or vehicle', group: 'Traffic rules', keys: ['[', ']'], scope: 'tool:trafficRules', desc: 'Speed limits and Vehicles modes', noPalette: true },
    { id: 'rules.wave', label: 'Link green wave', group: 'Traffic rules', keys: ['Enter'], scope: 'tool:trafficRules', desc: 'Timed lights: link the picked junctions', noPalette: true },
    { id: 'rules.clearAll', label: 'Clear all traffic', group: 'Traffic rules', keys: [], scope: 'global', desc: 'Remove every vehicle now', run: () => ui.context.toast(`Removed ${sim.clearTraffic?.() ?? 0} vehicles.`) },
    { id: 'rules.clearStuck', label: 'Clear stuck vehicles', group: 'Traffic rules', keys: [], scope: 'global', desc: 'Remove vehicles that have not moved for 20 s', run: () => ui.context.toast(`Removed ${sim.clearTraffic?.({ stuckOnly: true }) ?? 0} stuck vehicles.`) },
    {
      id: 'rules.pauseSpawn',
      label: 'Pause or resume spawning',
      group: 'Traffic rules',
      keys: [],
      scope: 'global',
      desc: 'Stop or restart new vehicles',
      run: () => {
        const next = !sim.spawnPaused;
        sim.setSpawnPaused?.(next);
        ui.context.toast(next ? 'Spawning paused.' : 'Spawning resumed.');
        tools.settingsChanged();
      },
    },
  ];
  const unregister = registerKeys(keys);
  return () => {
    unregister();
    removeLayer();
    layer.dispose();
  };
}
