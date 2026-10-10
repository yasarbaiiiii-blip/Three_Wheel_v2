/**
 * Which rover marker the map should draw.
 *
 * Telemetry is honest about staleness: a position older than the freshness window is
 * reported as missing. That is right for numbers, but an icon that disappears reads as
 * "rover gone". This keeps the last real fix and flags it stale so the map can dim it.
 */
export type RoverFix<C> = { center: C; heading: number | null };
export type RoverMarker<C> = { center: C; heading: number | null; stale: boolean };

export function resolveRoverMarker<C>(
  live: { center: C | null; heading: number | null | undefined },
  last: RoverFix<C> | null
): { marker: RoverMarker<C> | null; last: RoverFix<C> | null } {
  if (live.center) {
    // A fix without a valid heading keeps the previous heading rather than snapping to north.
    const heading = live.heading ?? last?.heading ?? null;
    const next = { center: live.center, heading };
    return { marker: { ...next, stale: false }, last: next };
  }
  return { marker: last ? { ...last, stale: true } : null, last };
}
