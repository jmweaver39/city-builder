/**
 * Pictures for the Modify > Upgrade cards and their styles: filled, coloured art
 * in the same 48 px style as cardArt.ts, so a card reads at a glance and its name
 * lives in the tooltip.
 */
import type { UpgradeCardId } from '../core/upgradeTypes';

const pic = (body: string) => `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${body}</svg>`;

const ASPHALT = '#4a5563';
const PAINT = '#f4f1e8';
const WALK = '#9aa4ae';
const GREEN = '#5e8a45';
const LEAF = '#4f8a3a';
const STEEL = '#c3c8cd';
const POST = '#6b737b';
const GLOW = '#ffd27a';

/** A road seen from above running up the card, with sidewalks. */
const road = `<rect x="0" y="0" width="48" height="48" rx="4" fill="#2f3b2f"/><rect x="8" y="0" width="32" height="48" fill="${WALK}"/><rect x="12" y="0" width="24" height="48" fill="${ASPHALT}"/><path d="M24 2v44" stroke="${PAINT}" stroke-width="1.2" stroke-dasharray="4 4"/>`;

const lamp = (x: number, h: number, dir: 1 | -1, arm = 9) =>
  `<path d="M${x} 46V${46 - h}h${dir * arm}" fill="none" stroke="${POST}" stroke-width="2.4" stroke-linecap="round"/><rect x="${dir > 0 ? x + arm - 3 : x - arm - 3}" y="${44 - h}" width="6" height="3" rx="1" fill="${GLOW}"/><path d="M${x + dir * arm - 4} ${48 - h}l-3 9h14l-3-9" fill="${GLOW}" opacity=".18"/>`;

const tree = (x: number, y: number, r = 7) => `<path d="M${x} ${y + r}v8" stroke="#6b4f35" stroke-width="2.4"/><circle cx="${x}" cy="${y}" r="${r}" fill="${LEAF}"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.3}" r="${r * 0.45}" fill="#69a64c"/>`;

export const UPGRADE_ART: Record<UpgradeCardId, string> = {
  lights: pic(`<rect x="0" y="40" width="48" height="8" rx="2" fill="${ASPHALT}"/>${lamp(12, 32, 1, 12)}${lamp(38, 32, -1, 10)}`),
  barriers: pic(
    `<rect x="0" y="38" width="48" height="10" rx="2" fill="${ASPHALT}"/><rect x="4" y="10" width="40" height="28" fill="#bfbbb0"/>` +
      `<path d="M12 10v28M20 10v28M28 10v28M36 10v28" stroke="#8f8b82" stroke-width="1.6"/><path d="M4 10h40" stroke="#7d7a72" stroke-width="2.4"/>`,
  ),
  structure: pic(
    `<path d="M0 46h48V40H0z" fill="#6c5a44"/><path d="M8 40V20h32v20" fill="#7a6650"/><rect x="6" y="14" width="5" height="26" fill="#bcb7ac"/><rect x="37" y="14" width="5" height="26" fill="#bcb7ac"/>` +
      `<rect x="6" y="12" width="36" height="5" fill="${ASPHALT}"/><path d="M12 14.5h24" stroke="${PAINT}" stroke-width="1" stroke-dasharray="3 3"/>`,
  ),
  trees: pic(`<rect x="0" y="40" width="48" height="8" rx="2" fill="${ASPHALT}"/><rect x="0" y="36" width="48" height="4" fill="${WALK}"/>${tree(13, 18, 9)}${tree(35, 20, 8)}`),
  rails: pic(
    `<rect x="0" y="34" width="48" height="14" rx="2" fill="${ASPHALT}"/><path d="M8 34V20M24 34V20M40 34V20" stroke="${POST}" stroke-width="3"/>` +
      `<path d="M2 21c4 3 8 3 11 0s7-3 11 0 7 3 11 0 7-3 11 0" fill="none" stroke="${STEEL}" stroke-width="5"/>`,
  ),
  stops: pic(
    `<rect x="0" y="40" width="48" height="8" rx="2" fill="${WALK}"/><rect x="6" y="14" width="26" height="3" rx="1" fill="#2f3a44"/><rect x="8" y="17" width="22" height="18" fill="#9fb7c4" opacity=".75"/>` +
      `<path d="M8 17v23M30 17v23" stroke="#39434d" stroke-width="2"/><rect x="11" y="30" width="16" height="3" fill="#7a5a3a"/>` +
      `<path d="M40 40V10" stroke="#39434d" stroke-width="2"/><rect x="35" y="8" width="10" height="10" rx="2" fill="#2c6fd1"/><text x="40" y="16" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="8" fill="#fff">B</text>`,
  ),
  remove: pic(
    `${road}<circle cx="24" cy="24" r="13" fill="#2a1416" stroke="#e9564b" stroke-width="3"/><path d="M18 18l12 12M30 18 18 30" stroke="#e9564b" stroke-width="3.2" stroke-linecap="round"/>`,
  ),
};

/** Small pictures for each style, keyed card then style. */
export const STYLE_ART: Record<string, string> = {
  'lights.standard': pic(lamp(18, 34, 1, 14)),
  'lights.double': pic(`${lamp(24, 34, 1, 12)}${lamp(24, 34, -1, 12)}`),
  'lights.decorative': pic(
    `<path d="M24 46V18" stroke="#24302b" stroke-width="3"/><path d="M19 46h10" stroke="#24302b" stroke-width="4"/><path d="M18 18h12l-2-8h-8z" fill="${GLOW}" stroke="#24302b" stroke-width="2"/><path d="M20 9h8l-4-4z" fill="#24302b"/>`,
  ),
  'lights.highmast': pic(`<path d="M24 46V8" stroke="${POST}" stroke-width="3"/><rect x="14" y="5" width="20" height="4" rx="2" fill="#2a2e33"/><circle cx="16" cy="10" r="2" fill="${GLOW}"/><circle cx="24" cy="10" r="2" fill="${GLOW}"/><circle cx="32" cy="10" r="2" fill="${GLOW}"/>`),
  'lights.none': pic(`<path d="M18 46V12h12" fill="none" stroke="${POST}" stroke-width="2.4" opacity=".5"/><circle cx="24" cy="26" r="15" fill="none" stroke="#e9564b" stroke-width="3"/><path d="M13 37 35 15" stroke="#e9564b" stroke-width="3"/>`),
  'barriers.concrete': pic(`<rect x="4" y="10" width="40" height="32" fill="#bfbbb0"/><path d="M14 10v32M24 10v32M34 10v32" stroke="#8f8b82" stroke-width="1.6"/>`),
  'barriers.acrylic': pic(`<rect x="4" y="10" width="40" height="32" fill="#a9d6ee" opacity=".55" stroke="#6a8ea3" stroke-width="2"/><path d="M24 10v32" stroke="#6a8ea3" stroke-width="2"/><path d="M9 34 19 16M28 34l10-18" stroke="#fff" stroke-width="2" opacity=".6"/>`),
  'barriers.timber': pic(`<rect x="4" y="10" width="40" height="32" fill="#8a6a45"/><path d="M4 16h40M4 22h40M4 28h40M4 34h40" stroke="#5e4630" stroke-width="1.4"/>`),
  'barriers.metal': pic(`<rect x="4" y="10" width="40" height="32" fill="#8d969e"/><path d="M4 10h40v4H4z" fill="#6b737b"/><g fill="#5c646b">${Array.from({ length: 20 }, (_, i) => `<circle cx="${9 + (i % 5) * 7.5}" cy="${19 + Math.floor(i / 5) * 6}" r="1.2"/>`).join('')}</g>`),
  'barriers.berm': pic(`<path d="M2 42C10 18 38 18 46 42z" fill="${GREEN}"/><path d="M10 34c6-8 22-8 28 0" stroke="#7fb05c" stroke-width="2" fill="none"/>`),
  'structure.embankment': pic(`<path d="M2 42 14 18h20l12 24z" fill="#7a6650"/><path d="M2 42 14 18h20l12 24" fill="none" stroke="${GREEN}" stroke-width="3"/><rect x="14" y="15" width="20" height="4" fill="${ASPHALT}"/>`),
  'structure.retaining': pic(`<path d="M10 42V18h28v24z" fill="#7a6650"/><rect x="8" y="16" width="5" height="26" fill="#bcb7ac"/><rect x="35" y="16" width="5" height="26" fill="#bcb7ac"/><rect x="8" y="13" width="32" height="4" fill="${ASPHALT}"/>`),
  'structure.trench': pic(`<path d="M2 14h10v28h24V14h10v32H2z" fill="#7a6650"/><rect x="10" y="12" width="4" height="30" fill="#bcb7ac"/><rect x="34" y="12" width="4" height="30" fill="#bcb7ac"/><rect x="14" y="38" width="20" height="4" fill="${ASPHALT}"/>`),
  'trees.trees': pic(`<rect x="0" y="40" width="48" height="8" fill="${WALK}"/><rect x="20" y="40" width="8" height="3" fill="#4a3d2e"/>${tree(24, 18, 11)}`),
  'trees.grass': pic(`<rect x="0" y="38" width="48" height="10" fill="${GREEN}"/>${tree(14, 20, 8)}${tree(34, 20, 8)}`),
  'trees.hedge': pic(`<rect x="0" y="40" width="48" height="8" fill="${WALK}"/><rect x="4" y="20" width="40" height="20" rx="6" fill="#3f6a2c"/><path d="M10 26h6M22 30h6M32 25h6" stroke="#5a8c3e" stroke-width="2" stroke-linecap="round"/>`),
  'rails.wbeam': pic(`<path d="M10 42V20M38 42V20" stroke="${POST}" stroke-width="3"/><path d="M4 22c5 3 9 3 13 0s9-3 13 0 9 3 14 0" fill="none" stroke="${STEEL}" stroke-width="6"/>`),
  'rails.jersey': pic(`<path d="M8 42h32l-6-6-3-18H17l-3 18z" fill="#c9c4b8" stroke="#9c978b" stroke-width="1.5"/>`),
  'rails.cable': pic(`<path d="M12 42V14M36 42V14" stroke="${POST}" stroke-width="2"/><path d="M2 20h44M2 26h44M2 32h44" stroke="${STEEL}" stroke-width="1.8"/>`),
  'stops.bus': UPGRADE_ART.stops,
  'stops.bike': pic(`<rect x="0" y="40" width="48" height="8" fill="${WALK}"/><path d="M10 40V26a6 6 0 0 1 12 0v14M26 40V26a6 6 0 0 1 12 0v14" fill="none" stroke="${STEEL}" stroke-width="3"/><circle cx="18" cy="34" r="5" fill="none" stroke="#2c6fd1" stroke-width="2"/>`),
  'remove.all': UPGRADE_ART.remove,
};
