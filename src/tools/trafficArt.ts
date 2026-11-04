/**
 * Pictures for the traffic rules: speed-limit signs, lane arrows, vehicle classes,
 * junction restrictions and signal heads, as small SVG strings. The map overlay
 * (icon tool marks) and the cards in the tray both use them, so a rule looks the
 * same in both places. Our own art, drawn from primitives.
 */
import type { TurnKind } from '../core/types';
import type { ArmRuleKey, VehicleClass } from '../core/trafficRuleTypes';
import { isUnlimited } from '../core/trafficRules';

const svg = (body: string, view = '0 0 32 32') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" aria-hidden="true">${body}</svg>`;

/** A round speed-limit sign. */
export function speedSignSvg(kmh: number | null): string {
  if (kmh === null) {
    return svg('<circle cx="16" cy="16" r="14.5" fill="#f4f2ec" stroke="#5b6573" stroke-width="2.5" stroke-dasharray="4 3"/><text x="16" y="20.5" font-family="Arial,sans-serif" font-weight="700" font-size="11" text-anchor="middle" fill="#3a4250">AUTO</text>');
  }
  if (isUnlimited(kmh)) {
    return svg(
      '<circle cx="16" cy="16" r="14.5" fill="#f4f2ec" stroke="#222" stroke-width="1.5"/>' +
        '<g stroke="#222" stroke-width="1.6"><line x1="7" y1="25" x2="25" y2="7"/><line x1="10" y1="27" x2="27" y2="10"/><line x1="5" y1="22" x2="22" y2="5"/><line x1="13" y1="28" x2="28" y2="13"/><line x1="4" y1="19" x2="19" y2="4"/></g>',
    );
  }
  const n = String(Math.round(kmh));
  const size = n.length >= 3 ? 11.5 : 14;
  return svg(
    `<circle cx="16" cy="16" r="14.5" fill="#f4f2ec"/><circle cx="16" cy="16" r="12.6" fill="none" stroke="#c4281c" stroke-width="3.6"/>` +
      `<text x="16" y="${16 + size * 0.36}" font-family="Arial,sans-serif" font-weight="700" font-size="${size}" text-anchor="middle" fill="#111">${n}</text>`,
  );
}

const ARROW_PATH: Record<TurnKind, string> = {
  straight: 'M16 26 V9 M10.5 14 L16 8 L21.5 14',
  left: 'M19 26 V17 Q19 12 14 12 H8 M12.5 7.5 L8 12 L12.5 16.5',
  right: 'M13 26 V17 Q13 12 18 12 H24 M19.5 7.5 L24 12 L19.5 16.5',
  uturn: 'M20 26 V13 Q20 8 15.5 8 Q11 8 11 13 V20 M7 16.5 L11 21 L15 16.5',
};

/** One lane arrow: lit when the lane takes that turn, dark when it could but does not. */
export function arrowSvg(turn: TurnKind, on: boolean): string {
  const bg = on ? '#1e9bd7' : '#1b2638';
  const fg = on ? '#ffffff' : '#7d8ba1';
  return svg(
    `<rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="${bg}" stroke="${on ? '#bfeaff' : '#3a4a63'}" stroke-width="1.5"/>` +
      `<path d="${ARROW_PATH[turn]}" fill="none" stroke="${fg}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
}

const VEHICLE_BODY: Record<VehicleClass, string> = {
  car: '<path d="M7 19 L9 13.5 Q9.8 12 11.5 12 H20.5 Q22.2 12 23 13.5 L25 19 V22.5 H7 Z" fill="currentColor"/><circle cx="11" cy="22.5" r="2.3" fill="currentColor"/><circle cx="21" cy="22.5" r="2.3" fill="currentColor"/>',
  van: '<path d="M6 21.5 V11 Q6 10 7 10 H19 L24.5 14.5 Q26 15.5 26 17 V21.5 Z" fill="currentColor"/><circle cx="10.5" cy="22" r="2.3" fill="currentColor"/><circle cx="21.5" cy="22" r="2.3" fill="currentColor"/>',
  truck: '<rect x="4.5" y="9" width="14" height="12" rx="1" fill="currentColor"/><path d="M19.5 12.5 H24 L27.5 16.5 V21 H19.5 Z" fill="currentColor"/><circle cx="9" cy="22.5" r="2.3" fill="currentColor"/><circle cx="23" cy="22.5" r="2.3" fill="currentColor"/>',
  bus: '<rect x="5" y="8.5" width="22" height="13.5" rx="2.5" fill="currentColor"/><rect x="7.5" y="11" width="17" height="4.5" rx="1" fill="#1b2638"/><circle cx="10.5" cy="22.5" r="2.2" fill="currentColor"/><circle cx="21.5" cy="22.5" r="2.2" fill="currentColor"/>',
  bike: '<circle cx="10" cy="20" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="22" cy="20" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 20 L14 13 H20 L22 20 M14 13 L16.5 20 H10 M18.5 10.5 H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  emergency: '<path d="M7 21 V13 Q7 12 8 12 H24 Q25 12 25 13 V21 Z" fill="currentColor"/><rect x="14.5" y="8" width="3" height="4" fill="#e23b3b"/><path d="M16 14 V19 M13.5 16.5 H18.5" stroke="#e23b3b" stroke-width="2"/>',
};

/** A vehicle class in a round badge: allowed (light) or banned (red, struck through). */
export function vehicleSvg(cls: VehicleClass, allowed: boolean): string {
  const ring = allowed ? '#58e6a9' : '#e23b3b';
  const body = `<g style="color:${allowed ? '#f1f6fb' : '#c9d2de'}">${VEHICLE_BODY[cls]}</g>`;
  const slash = allowed ? '' : '<line x1="7" y1="7" x2="25" y2="25" stroke="#e23b3b" stroke-width="3" stroke-linecap="round"/>';
  return svg(`<circle cx="16" cy="16" r="14.5" fill="#1b2638" stroke="${ring}" stroke-width="2.2"/>${body}${slash}`);
}

const RULE_BODY: Record<ArmRuleKey, string> = {
  uturn: `<path d="${ARROW_PATH.uturn}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  laneChange: '<path d="M11 26 V18 L21 10 V6 M17.5 9 L21 5.5 L24.5 9 M21 26 V18 L11 10 V6 M7.5 9 L11 5.5 L14.5 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  enterBlocked: '<rect x="7" y="7" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 7 L25 25 M25 7 L7 25 M16 7 V25 M7 16 H25" stroke="currentColor" stroke-width="1.4"/>',
  pedestrians: '<circle cx="16" cy="7.5" r="2.6" fill="currentColor"/><path d="M16 11 L13 18 L10 25 M16 11 L18.5 17.5 L22 25 M13 13.5 L9.5 17 M18 13 L22.5 15.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  nearTurnOnRed: '<circle cx="9" cy="9" r="4" fill="#e23b3b"/><path d="M13 27 V20 Q13 15 18 15 H25 M21 11 L25 15 L21 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  farTurnOnRed: '<circle cx="23" cy="9" r="4" fill="#e23b3b"/><path d="M19 27 V20 Q19 15 14 15 H7 M11 11 L7 15 L11 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

/** A junction restriction: green when allowed, red and struck through when not. */
export function ruleSvg(key: ArmRuleKey, allowed: boolean): string {
  const bg = allowed ? '#167a4f' : '#5b1e22';
  const ring = allowed ? '#58e6a9' : '#ff6b6b';
  const slash = allowed ? '' : '<line x1="6" y1="26" x2="26" y2="6" stroke="#ff6b6b" stroke-width="2.6" stroke-linecap="round"/>';
  return svg(`<rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="${bg}" stroke="${ring}" stroke-width="1.6"/><g style="color:#ffffff">${RULE_BODY[key]}</g>${slash}`);
}

/** A movement's light under hand control, with the turn it serves. */
export function lightSvg(turn: TurnKind, green: boolean): string {
  const lamp = green ? '#2ee06a' : '#ff3b30';
  return svg(
    `<rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#10151d" stroke="${lamp}" stroke-width="2"/>` +
      `<path d="${ARROW_PATH[turn]}" fill="none" stroke="${lamp}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
}

/** Priority diamond and yield triangle, for the priority overlay. */
export function signSvg(kind: 'priority' | 'yield' | 'stop'): string {
  if (kind === 'priority') return svg('<rect x="7" y="7" width="18" height="18" transform="rotate(45 16 16)" fill="#f4f2ec"/><rect x="10.5" y="10.5" width="11" height="11" transform="rotate(45 16 16)" fill="#e8b92e"/>');
  if (kind === 'yield') return svg('<path d="M3 6 H29 L16 28 Z" fill="#c4281c"/><path d="M9.5 9.5 H22.5 L16 21 Z" fill="#f4f2ec"/>');
  return svg('<path d="M10.5 3 H21.5 L29 10.5 V21.5 L21.5 29 H10.5 L3 21.5 V10.5 Z" fill="#c4281c" stroke="#f4f2ec" stroke-width="1.5"/><text x="16" y="19.5" font-family="Arial,sans-serif" font-weight="700" font-size="8.5" text-anchor="middle" fill="#f4f2ec">STOP</text>');
}

/** Card pictures for the tray, one per rules mode. */
export const RULE_MODE_ART: Record<string, string> = {
  arrows: arrowSvg('left', true),
  speed: speedSignSvg(50),
  vehicles: vehicleSvg('truck', false),
  junction: ruleSvg('uturn', true),
  priority: signSvg('priority'),
  manual: lightSvg('straight', true),
  timed: svg('<circle cx="16" cy="16" r="13" fill="#1b2638" stroke="#4fd1ff" stroke-width="2"/><path d="M16 8 V16 L22 19" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>'),
  clear: svg('<rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#1b2638" stroke="#4fd1ff" stroke-width="1.6"/><path d="M8 22 L13 9 H19 L24 22 Z" fill="#f1f6fb"/><path d="M6 24 H26" stroke="#ff6b6b" stroke-width="2.6" stroke-linecap="round"/><path d="M11 16 H21" stroke="#1b2638" stroke-width="2"/>'),
};
