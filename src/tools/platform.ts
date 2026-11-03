/**
 * The name of the main modifier key, for messages: the Command glyph on a Mac and
 * Ctrl elsewhere. Pointer events treat the two the same (ToolPointer.ctrl). The
 * keymap in src/ui formats whole shortcuts; tools only need this one word.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '');
}

/** '⌘' on a Mac, 'Ctrl' elsewhere. */
export const MOD_KEY: string = isMacPlatform() ? '⌘' : 'Ctrl';
