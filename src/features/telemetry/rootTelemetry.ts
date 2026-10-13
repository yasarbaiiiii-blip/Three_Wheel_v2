import type { TelemetrySnapshot } from "../../types/plan";

/** App-level state only follows the rover when it has moved this far from the last position it rendered. */
export const ROOT_MOVE_M = 0.5;

const hasFix = (s: TelemetrySnapshot) => Number.isFinite(s.lat) && Number.isFinite(s.lon);

/**
 * Equality for the telemetry slice the whole App tree renders from (mission state, GPS fix, coarse
 * position). `a` is the last value that caused a render, so the 0.5 m threshold is measured from it:
 * a parked rover whose GPS jitters across a rounding line no longer re-renders the app every packet.
 */
export function rootTelemetryEqual(a: TelemetrySnapshot | null, b: TelemetrySnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if ((a.mission_state ?? "") !== (b.mission_state ?? "")) return false;
  if (hasFix(a) !== hasFix(b)) return false;
  const aKnown = a.pos_n != null && a.pos_e != null;
  const bKnown = b.pos_n != null && b.pos_e != null;
  if (aKnown !== bKnown) return false;
  if (!aKnown) return true;
  return Math.hypot((b.pos_n as number) - (a.pos_n as number), (b.pos_e as number) - (a.pos_e as number)) < ROOT_MOVE_M;
}
