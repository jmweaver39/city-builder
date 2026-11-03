/**
 * The floating panel of the junction markings editor. The editing itself lives in
 * MarkingsEditor, a component the Junction tool's tabs can host as well.
 */
import type { Id, MarkingHost } from '../core/types';
import type { UiContext } from './context';
import { MarkingsEditor } from './MarkingsEditor';
import type { Panel } from './Panel';

export class NodeMarkingPanel {
  private readonly editor: MarkingsEditor;

  constructor(ui: UiContext, host: Id | MarkingHost, panel: Panel) {
    const h: MarkingHost = typeof host === 'number' ? { kind: 'node', id: host } : host;
    panel.setTitle(h.kind === 'node' ? 'Junction markings' : 'Road markings');
    this.editor = new MarkingsEditor(ui, h, panel.body);
  }

  sync(): void {
    this.editor.sync();
  }

  dispose(): void {
    this.editor.dispose();
  }
}
