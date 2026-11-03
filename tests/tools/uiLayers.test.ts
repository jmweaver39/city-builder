import { describe, expect, it } from 'vitest';

// Node's fs, loaded without needing Node types in this project's tsconfig.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL, encoding: 'utf8'): string };

/**
 * Every child of #ui takes pointer events, so a full-screen layer added there
 * swallows the map's clicks unless it opts out. Browser check of the same thing:
 * document.elementFromPoint at the screen centre is the canvas with no panel open.
 */
describe('layers over the map', () => {
  const css = readFileSync(new URL('../../src/ui/style.css', import.meta.url), 'utf8');

  it('keeps full-screen layers from taking clicks', () => {
    const rule = /#ui > \.keycap-overlay[^{]*\{[^}]*pointer-events:\s*none\s*!important/.exec(css);
    expect(rule, 'the keycap overlay must opt out of #ui > * pointer events').not.toBeNull();
    expect(rule![0]).toContain('.toasts');
    expect(rule![0]).toContain('.cursor-hud');
    expect(css).toMatch(/#ui > \.shortcuts:not\(\.visible\)\s*\{\s*pointer-events:\s*none\s*!important/);
  });

  it('puts nothing over the map for the shortcut panel but the panel itself', () => {
    const src = readFileSync(new URL('../../src/ui/ShortcutPanel.ts', import.meta.url), 'utf8');
    // No hover zone element: hover comes from the pointer position.
    expect(src).not.toMatch(/shortcuts-zone/);
    expect(css).not.toMatch(/\.shortcuts-zone/);
    // Faded out, the panel takes no pointer events; shown, only its own box does.
    expect(css).toMatch(/\.shortcuts \{[^}]*pointer-events:\s*none\s*!important/);
    expect(css).toMatch(/\.shortcuts\.visible \{[^}]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.shortcuts \{[^}]*width:\s*220px/);
  });

  it('mounts the keycap overlay only while it shows', () => {
    const src = readFileSync(new URL('../../src/ui/ShortcutPanel.ts', import.meta.url), 'utf8');
    // The constructor mounts only the panel, not the overlay.
    expect(src).toMatch(/host\.append\(this\.root\);/);
    // The overlay goes in only after the early return that removes it when off.
    const removeAt = src.indexOf('this.overlay.remove()');
    const appendAt = src.indexOf('this.host.append(this.overlay)');
    expect(removeAt).toBeGreaterThan(0);
    expect(appendAt).toBeGreaterThan(removeAt);
  });
});
