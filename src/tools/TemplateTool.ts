/** Interchange stamps: the ghost follows the cursor, and a click stamps it. */
import { clamp } from '../core/math';
import { ELEVATION_STEP, MAX_ELEVATION, MIN_ELEVATION } from '../core/terrain';
import type { Vec3 } from '../core/types';
import { Tool } from './Tool';
import { COLORS, type TemplateDef, type TemplatePlacement, type ToolId, type ToolKey, type ToolPointer } from './types';

const ROTATE_STEP = Math.PI / 12;

export class TemplateTool extends Tool {
  readonly id: ToolId = 'template';
  private pos: Vec3 | null = null;

  get template(): TemplateDef | null {
    const { templates, settings } = this.ctx;
    return templates?.TEMPLATES.find((t) => t.id === settings.template.id) ?? null;
  }

  /** The current parameter values of a template, filled in with defaults. */
  paramsOf(def: TemplateDef): Record<string, number> {
    const stored = (this.ctx.settings.template.params[def.id] ??= {});
    for (const p of def.params) if (stored[p.key] === undefined) stored[p.key] = p.default;
    return stored;
  }

  private placement(): TemplatePlacement | null {
    if (!this.pos) return null;
    const t = this.ctx.settings.template;
    const out: TemplatePlacement = { pos: this.pos, rotation: t.rotation, elevation: t.elevation };
    if (t.roadType) out.roadType = t.roadType;
    return out;
  }

  private show(e: ToolPointer | null): void {
    const { view, templates, settings } = this.ctx;
    const def = this.template;
    const place = this.placement();
    if (!templates || !def || !place) {
      view.setPreview([]);
      this.ctx.setMarks([]);
      if (e) {
        this.ctx.setHud({
          x: e.x,
          y: e.y,
          lines: ['Intersections'],
          notes: [templates ? 'Choose an interchange in the panel' : 'Interchange templates are not available yet'],
          tone: 'warning',
        });
      }
      return;
    }
    let curves;
    try {
      curves = templates.previewTemplate(def.id, this.paramsOf(def), place);
    } catch (err) {
      view.setPreview([]);
      this.ctx.setHud(e ? { x: e.x, y: e.y, lines: [def.name], notes: [(err as Error).message], tone: 'error' } : null);
      return;
    }
    const problems = templates.placementProblems?.(def.id, this.paramsOf(def), place) ?? [];
    view.setPreview([{ curves, roadType: settings.template.roadType ?? 'highway-2', state: problems.length ? 'error' : 'ok' }]);
    this.ctx.setMarks([{ kind: 'ring', pos: place.pos, color: problems.length ? COLORS.bad : COLORS.snap, radius: 6 }]);
    if (e) {
      const deg = Math.round((((settings.template.rotation * 180) / Math.PI) % 360 + 360) % 360);
      this.ctx.setHud({
        x: e.x,
        y: e.y,
        lines: [def.name, `Rotation ${deg}\u00b0`, `Elevation ${settings.template.elevation} m`],
        notes: problems.length ? problems : ['Click to stamp. [ ] rotate, PageUp and PageDown change height'],
        tone: problems.length ? 'error' : 'ok',
      });
    }
  }

  private locate(e: ToolPointer): void {
    this.pos = this.ctx.view.pickPlane(e.x, e.y, this.ctx.settings.template.elevation);
  }

  activate(): void {
    this.show(this.pointer);
  }

  settingsChanged(): void {
    if (this.pointer) this.locate(this.pointer);
    this.show(this.pointer);
  }

  pointerMove(e: ToolPointer): void {
    this.pointer = e;
    this.locate(e);
    this.show(e);
  }

  pointerDown(e: ToolPointer): void {
    if (e.button !== 0) return;
    this.pointer = e;
    this.locate(e);
    const { net, templates } = this.ctx;
    const def = this.template;
    const place = this.placement();
    if (!templates || !def || !place) return;
    this.ctx.history.hint(`Stamp ${def.name}`);
    try {
      const result = net.batch(() => templates.stampTemplate(net, def.id, this.paramsOf(def), place));
      if (!result.segments.length) {
        this.ctx.toast(`Could not place ${def.name}: ${result.problems.join(' ') || 'nothing to stamp here.'}`, 'error');
      } else if (result.problems.length) {
        this.ctx.toast(result.problems[0], 'warning');
      }
    } catch (err) {
      this.ctx.toast(`Could not place ${def.name}: ${(err as Error).message}`, 'error');
    }
    this.show(e);
  }

  wheel(delta: number, e: ToolPointer): boolean {
    if (!e.shift) return false;
    this.rotate(delta > 0 ? 1 : -1);
    return true;
  }

  rotate(direction: 1 | -1): void {
    this.ctx.settings.template.rotation += direction * ROTATE_STEP;
    this.show(this.pointer);
    this.ctx.changed();
  }

  stepElevation(direction: 1 | -1): void {
    const t = this.ctx.settings.template;
    t.elevation = clamp(t.elevation + direction * ELEVATION_STEP, MIN_ELEVATION, MAX_ELEVATION);
    if (this.pointer) this.locate(this.pointer);
    this.show(this.pointer);
    this.ctx.changed();
  }

  keyDown(e: ToolKey): boolean {
    if (e.key === '[' || e.key === ']') {
      this.rotate(e.key === ']' ? 1 : -1);
      return true;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      this.stepElevation(e.key === 'PageUp' ? 1 : -1);
      return true;
    }
    return false;
  }

  deactivate(): void {
    this.pos = null;
  }
}
