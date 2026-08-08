/**
 * Touch-position -> compass-bearing math for CompassDial. Kept free of any
 * react-native-* import (gesture-handler / reanimated / svg) so it stays
 * testable under vitest's plain 'node' environment (see vitest.config.ts) —
 * CompassDial.tsx itself pulls in those native-module packages and must
 * never be imported from a test file in this project.
 */

import { normalizeBearingDeg } from "../../utils/planOffset";

/**
 * Compass bearing for a touch at screen-space offset (dx, dy) from the dial's
 * center — dx rightward, dy downward (standard RN gesture coordinates).
 *
 * Derivation: up (dx=0,dy<0) -> 0 deg (north), right (dx>0,dy=0) -> 90 deg
 * (east), down (dx=0,dy>0) -> 180 deg (south), left (dx<0,dy=0) -> 270 deg
 * (west) -- i.e. atan2(dx, -dy), normalized to [0,360). This is
 * magnitude-independent by construction: only the angle from center matters,
 * never how far off-center the touch lands.
 */
export function bearingFromOffset(dx: number, dy: number): number {
  return normalizeBearingDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}
