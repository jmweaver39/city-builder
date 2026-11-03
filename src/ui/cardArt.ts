/**
 * Pictures for tray cards: the actual sign or signal for each control, a mini
 * roundabout, and isometric buildings for zones. Filled, coloured art, drawn for
 * this game, so a card reads at a glance and its name can live in the tooltip.
 */

const pic = (body: string) => `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${body}</svg>`;

const ASPHALT = '#4a5563';
const KERB = '#9aa4ae';
const PAINT = '#f4f1e8';

export const CONTROL_ART: Record<string, string> = {
  signal: pic(
    `<rect x="17" y="4" width="14" height="34" rx="4" fill="#1c2430" stroke="#0d1218" stroke-width="1.5"/>` +
      `<circle cx="24" cy="12" r="4" fill="#e9564b"/><circle cx="24" cy="21" r="4" fill="#4a3d1a"/><circle cx="24" cy="30" r="4" fill="#3fd07c"/>` +
      `<rect x="22.5" y="38" width="3" height="7" fill="#5b6572"/>`,
  ),
  stop: pic(
    `<path d="M16.5 5h15L42 15.5v15L31.5 41h-15L6 30.5v-15z" fill="#d8352c" stroke="#fff" stroke-width="2.2"/>` +
      `<text x="24" y="27.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="10.5" fill="#fff">STOP</text>`,
  ),
  allStop: pic(
    `<path d="M16.5 3h15L42 13.5v15L31.5 39h-15L6 28.5v-15z" fill="#d8352c" stroke="#fff" stroke-width="2.2"/>` +
      `<text x="24" y="25.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="10.5" fill="#fff">STOP</text>` +
      `<rect x="12" y="38" width="24" height="8" rx="1.5" fill="#fff"/><text x="24" y="44.5" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="6.5" fill="#d8352c">ALL WAY</text>`,
  ),
  yield: pic(`<path d="M5 8h38L24 41z" fill="#fff" stroke="#d8352c" stroke-width="4" stroke-linejoin="round"/>`),
  priority: pic(
    `<path d="M24 3 45 24 24 45 3 24z" fill="#fff" stroke="#c9ccd1" stroke-width="1"/><path d="M24 10 38 24 24 38 10 24z" fill="#f2c318"/>`,
  ),
  auto: pic(
    `<rect x="6" y="6" width="36" height="36" rx="8" fill="#163e3c" stroke="#3fcfc6" stroke-width="2"/>` +
      `<text x="24" y="31" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="18" fill="#86e9e2">A</text>` +
      `<path d="M36 9v6M33 12h6" stroke="#86e9e2" stroke-width="2" stroke-linecap="round"/>`,
  ),
  roundabout: pic(
    `<rect x="20" y="0" width="8" height="48" fill="${ASPHALT}"/><rect x="0" y="20" width="48" height="8" fill="${ASPHALT}"/>` +
      `<circle cx="24" cy="24" r="15" fill="none" stroke="${ASPHALT}" stroke-width="8"/>` +
      `<circle cx="24" cy="24" r="10.5" fill="#5e8a45" stroke="${KERB}" stroke-width="1.5"/>` +
      `<circle cx="24" cy="24" r="15" fill="none" stroke="${PAINT}" stroke-width="1" stroke-dasharray="3 3"/>` +
      `<path d="M37 17l2.5 4.5-5 .5" fill="none" stroke="${PAINT}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  ),
  lanes: pic(
    `<rect x="4" y="4" width="40" height="40" rx="4" fill="${ASPHALT}"/>` +
      `<path d="M14 44V30c0-6 4-10 10-10h20M24 44V34c0-3 2-5 5-5h15" fill="none" stroke="#3fcfc6" stroke-width="2.4"/>` +
      `<path d="M34 44V4" fill="none" stroke="${PAINT}" stroke-width="1.4" stroke-dasharray="4 3"/>`,
  ),
  junctionShape: pic(
    `<path d="M16 0v12a4 4 0 0 1-4 4H0M32 0v12a4 4 0 0 0 4 4h12M16 48V36a4 4 0 0 0-4-4H0M32 48V36a4 4 0 0 1 4-4h12" fill="none" stroke="${KERB}" stroke-width="2.4"/>` +
      `<rect x="9" y="13" width="6" height="6" rx="1" fill="#3fcfc6"/><rect x="33" y="29" width="6" height="6" rx="1" fill="#3fcfc6"/>`,
  ),
  markings: pic(
    `<rect x="4" y="4" width="40" height="40" rx="4" fill="${ASPHALT}"/>` +
      `<path d="M10 14h28M10 20h28M10 26h28M10 32h28" stroke="${PAINT}" stroke-width="3.2"/>`,
  ),
  editor: pic(
    `<rect x="4" y="4" width="40" height="40" rx="4" fill="${ASPHALT}"/>` +
      `<path d="M24 44V22M24 22l-8 -8M24 22h14" fill="none" stroke="#3fd07c" stroke-width="2.6" stroke-linecap="round"/>` +
      `<path d="M10 24h8" stroke="#e9564b" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="2 3"/>`,
  ),
};

/** An isometric building in a zone's colour. */
export function zoneArt(kind: string, color: string): string {
  const shade = (c: string, k: number) => {
    const n = parseInt(c.slice(1), 16);
    const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
  };
  const top = shade(color, 1.15);
  const left = shade(color, 0.85);
  const right = shade(color, 0.65);
  // An isometric box, x and y on the ground, h tall.
  const box = (cx: number, cy: number, w: number, d: number, h: number) => {
    const a = `${cx},${cy - h}`;
    const b = `${cx + w},${cy - h - w / 2}`;
    const c = `${cx + w - d},${cy - h - w / 2 - d / 2}`;
    const e = `${cx - d},${cy - h - d / 2}`;
    return (
      `<polygon points="${cx},${cy} ${cx + w},${cy - w / 2} ${cx + w},${cy - h - w / 2} ${a}" fill="${right}"/>` +
      `<polygon points="${cx},${cy} ${a} ${e} ${cx - d},${cy - d / 2}" fill="${left}"/>` +
      `<polygon points="${a} ${b} ${c} ${e}" fill="${top}"/>`
    );
  };
  const ground = `<polygon points="24,44 44,34 24,24 4,34" fill="#2a3b2a" opacity=".55"/>`;
  switch (kind) {
    case 'residential':
      return pic(
        ground +
          box(24, 40, 12, 12, 10) +
          `<polygon points="12,${24} 24,${18} 36,${24} 24,${30}" fill="${shade(color, 0.55)}"/><polygon points="12,24 24,12 24,18" fill="${shade(color, 0.75)}"/>`,
      );
    case 'commercial':
      return pic(ground + box(24, 41, 15, 13, 14) + `<rect x="13" y="32" width="11" height="3" fill="#f4f1e8" opacity=".7"/>`);
    case 'industrial':
      return pic(ground + box(22, 41, 14, 12, 9) + box(34, 33, 4, 4, 22));
    case 'office':
      return pic(ground + box(24, 42, 9, 9, 28) + `<path d="M17 20v14M21 22v14" stroke="#f4f1e8" stroke-width="1" opacity=".45"/>`);
    default:
      return pic(ground + `<path d="M14 30l20-10M14 20l20 10" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
  }
}

/** The gateway: a road arrow running off the edge of the map. */
export const GATEWAY_ART = pic(
  `<path d="M4 44 30 18" stroke="${ASPHALT}" stroke-width="12" stroke-linecap="round"/>` +
    `<path d="M8 40 26 22" stroke="${PAINT}" stroke-width="1.4" stroke-dasharray="4 3"/>` +
    `<path d="M30 6h12v12" fill="none" stroke="#3fcfc6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 6 30 18" stroke="#3fcfc6" stroke-width="3" stroke-linecap="round"/>`,
);
