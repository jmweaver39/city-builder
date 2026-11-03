/** Fuzzy matching for the command palette. Pure, so it runs headless. */

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keys: string[];
  desc?: string;
  run: () => void;
}

/**
 * How well `query` matches `text`, higher is better, or null for no match. Every
 * query character must appear in order; runs, word starts and an early first hit
 * score more.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const exact = t.indexOf(q);
  if (exact >= 0) return 1000 - exact * 2 + (exact === 0 || /[\s:,-]/.test(t[exact - 1]) ? 200 : 0) - t.length * 0.1;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch) {
        found = k;
        break;
      }
    }
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s:,-]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 6 + (wordStart ? 12 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score - t.length * 0.1;
}

/** Commands matching the query, best first. With no query, recent ones lead. */
export function rankCommands(commands: readonly PaletteCommand[], query: string, recent: readonly string[] = []): PaletteCommand[] {
  if (!query.trim()) {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const first = recent.map((id) => byId.get(id)).filter((c): c is PaletteCommand => !!c);
    const rest = commands.filter((c) => !recent.includes(c.id));
    return [...first, ...rest];
  }
  const scored: { c: PaletteCommand; s: number }[] = [];
  for (const c of commands) {
    const s = Math.max(fuzzyScore(query, c.label) ?? -Infinity, (fuzzyScore(query, `${c.group} ${c.label}`) ?? -Infinity) - 5);
    if (s === -Infinity) continue;
    const boost = recent.includes(c.id) ? 30 - recent.indexOf(c.id) : 0;
    scored.push({ c, s: s + boost });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.c);
}
