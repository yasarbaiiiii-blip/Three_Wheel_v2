/**
 * APP-02: non-blocking pre-Start warning when the rover already stands PAST the start of the first
 * mark, on that mark's line. Start would then stage the entry 0.5 m behind the mark (entryStagingPoint)
 * and the rover would have to drive back, or the operator expected it to paint from where it stands.
 *
 * DERIVED — NOT FROM V1 SPEC: "ahead" = along-track projection of the rover onto the first mark's
 * direction is > 0 AND the lateral offset is <= ENTRY_STAGING_M. No new constants: the lateral
 * tolerance is the staging distance already used for the entry, and a rover within
 * ENTRY_TRANSIT_SKIP_M of the start is "at the start" (the planner omits the entry there), not ahead.
 */

import type { PlanLine } from "../types/plan";
import type { CsvExtensionConfig } from "./missionExtensions";
import {
  ENTRY_STAGING_M,
  ENTRY_TRANSIT_SKIP_M,
  buildTrajectory,
  resolveRoverNedInMissionFrame,
  type NedPair,
  type RoverPoseForEntry,
} from "./missionTrajectory";

export type RoverAheadResult = { ahead: boolean; alongM: number; lateralM: number };

/**
 * First mark's points when the plan STARTS with a mark (no leading PRE extension run). With a leading
 * travel run the rover is routed to that run-up, so nothing can be "past the start".
 */
export function firstMarkPointsForEntry(
  paintedLines: PlanLine[],
  extensions: Partial<CsvExtensionConfig> | null | undefined
): NedPair[] | null {
  if (paintedLines.length === 0) return null;
  const built = buildTrajectory(paintedLines, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions,
    includeEntryTransit: false,
  });
  const first = built.runs[0];
  if (!first || first.kind !== "mark") return null;
  return first.points;
}

export function roverAheadOfFirstMark(roverNed: NedPair, markPoints: NedPair[]): RoverAheadResult {
  const none = { ahead: false, alongM: 0, lateralM: Infinity };
  if (markPoints.length < 2) return none;
  const tip = markPoints[0];
  const next = markPoints.find((p) => Math.hypot(p[0] - tip[0], p[1] - tip[1]) > 1e-6);
  if (!next) return none;
  const len = Math.hypot(next[0] - tip[0], next[1] - tip[1]);
  const un = (next[0] - tip[0]) / len;
  const ue = (next[1] - tip[1]) / len;
  const dn = roverNed[0] - tip[0];
  const de = roverNed[1] - tip[1];
  const alongM = dn * un + de * ue;
  const lateralM = Math.abs(dn * ue - de * un);
  if (!Number.isFinite(alongM) || !Number.isFinite(lateralM)) return none;
  const atStart = Math.hypot(dn, de) <= ENTRY_TRANSIT_SKIP_M;
  return { ahead: !atStart && alongM > 0 && lateralM <= ENTRY_STAGING_M, alongM, lateralM };
}

/** Operator text, or null when there is nothing to warn about (including: no usable pose). */
export function startEntryAheadWarning(
  markPoints: NedPair[] | null | undefined,
  pose: RoverPoseForEntry | null | undefined,
  originGps: [number, number] | null | undefined
): string | null {
  if (!markPoints || !pose) return null;
  const resolved = resolveRoverNedInMissionFrame(pose, originGps);
  if (!resolved.ok) return null;
  const r = roverAheadOfFirstMark([resolved.north, resolved.east], markPoints);
  if (!r.ahead) return null;
  return (
    `Rover is ${r.alongM.toFixed(2)} m past the start of the first mark. ` +
    `Start will route it back to ${ENTRY_STAGING_M} m behind the start before painting; ` +
    `reposition the rover behind the start if that is not wanted.`
  );
}
