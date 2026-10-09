/**
 * App-Planned Mission Builder for GAP-04 (POST /api/missions/plan).
 *
 * Ingest Rules (Contract v1.1):
 * R1 mixed_spray_in_run: every point of "mark" has bit0 = 1, and every point of "travel" has bit0 = 0.
 * R2 adjacent_runs_same_type: runs strictly alternate mark/travel. Merges same-type neighbours.
 * R3 runs_not_contiguous: runs[k+1].points[0] equals runs[k].points[-1] within 0.001 m (north & east).
 *    All spatial gaps must be explicit travel runs.
 * R4 boundary points: shared point keeps previous run's spray bit; must-hit bit is OR of both.
 * R5 limits: frame="local_ned", finite coords, envelope [±10,000m], step <= 5.0m, points <= 50,000.
 */

import {
  APP_MISSION_FRAME,
  MAX_MISSION_POINTS,
  MAX_MISSION_STEP_M,
  MISSION_ENVELOPE_M,
  FLAG_SPRAY_INTENT,
  FLAG_MUST_HIT,
  type AppPlannedMissionRequest,
  type AppPlannedRun,
  type AppPlannedPointTuple,
} from "../contract/prod/missionPlan";
import { collinearAwareMustHitIndices } from "../api/planTrajectory";
import type { TrajectoryRun, NedPair } from "./missionTrajectory";
import type { PlanLine } from "../types/plan";
import { buildTrajectory } from "./missionTrajectory";
import type { CsvExtensionConfig } from "./missionExtensions";

export const BOUNDARY_TOUCH_TOL_M = 0.001;

export class MissionPlanValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MissionPlanValidationError";
    this.code = code;
  }
}

/**
 * Validates an AppPlannedMissionRequest against the production ingest rules R1-R5.
 * Throws MissionPlanValidationError with exact rover error codes on rejection.
 */
export function validateAppPlannedMissionRequest(payload: AppPlannedMissionRequest): void {
  if (payload.frame !== APP_MISSION_FRAME) {
    throw new MissionPlanValidationError(
      "bad_frame",
      `Invalid frame '${payload.frame}'. Must be '${APP_MISSION_FRAME}'.`
    );
  }

  const runs = payload.runs;
  if (!runs || runs.length === 0) {
    throw new MissionPlanValidationError("empty_mission", "Mission has no runs.");
  }

  let totalPoints = 0;

  for (let rIdx = 0; rIdx < runs.length; rIdx++) {
    const run = runs[rIdx];
    const pts = run.points;

    if (!pts || pts.length < 2) {
      throw new MissionPlanValidationError(
        "run_too_short",
        `Run index ${rIdx} has ${pts?.length ?? 0} points; minimum is 2.`
      );
    }

    const isMark = run.type === "mark";

    // R1: mixed_spray_in_run
    for (let pIdx = 0; pIdx < pts.length; pIdx++) {
      const pt = pts[pIdx];
      const north = pt[0];
      const east = pt[1];
      const flags = pt[2];

      if (!Number.isFinite(north) || !Number.isFinite(east)) {
        throw new MissionPlanValidationError(
          "non_finite_coordinate",
          `Run ${rIdx} point ${pIdx} has non-finite coordinates: [${north}, ${east}].`
        );
      }

      if (
        Math.abs(north) > MISSION_ENVELOPE_M ||
        Math.abs(east) > MISSION_ENVELOPE_M
      ) {
        throw new MissionPlanValidationError(
          "out_of_bounds",
          `Run ${rIdx} point ${pIdx} [${north}, ${east}] exceeds envelope [±${MISSION_ENVELOPE_M}m].`
        );
      }

      const sprayBit = flags & FLAG_SPRAY_INTENT;
      if (isMark && sprayBit === 0) {
        throw new MissionPlanValidationError(
          "mixed_spray_in_run",
          `Mark run index ${rIdx} point ${pIdx} has spray bit 0; mark runs require bit0 = 1.`
        );
      }
      if (!isMark && sprayBit !== 0) {
        throw new MissionPlanValidationError(
          "mixed_spray_in_run",
          `Travel run index ${rIdx} point ${pIdx} has spray bit 1; travel runs require bit0 = 0.`
        );
      }

      // Check step size to previous point
      if (pIdx > 0) {
        const prev = pts[pIdx - 1];
        const stepDist = Math.hypot(north - prev[0], east - prev[1]);
        if (stepDist > MAX_MISSION_STEP_M + 1e-4) {
          throw new MissionPlanValidationError(
            "step_too_large",
            `Run ${rIdx} step from ${pIdx - 1} to ${pIdx} is ${stepDist.toFixed(3)}m, exceeding ${MAX_MISSION_STEP_M}m limit.`
          );
        }
      }
    }

    totalPoints += pts.length;

    // Check relationship with previous run
    if (rIdx > 0) {
      const prevRun = runs[rIdx - 1];

      // R2: adjacent_runs_same_type
      if (run.type === prevRun.type) {
        throw new MissionPlanValidationError(
          "adjacent_runs_same_type",
          `Adjacent runs ${rIdx - 1} and ${rIdx} are both '${run.type}'. Runs must strictly alternate.`
        );
      }

      // R3: runs_not_contiguous
      const prevEnd = prevRun.points[prevRun.points.length - 1];
      const currStart = pts[0];
      const dn = Math.abs(currStart[0] - prevEnd[0]);
      const de = Math.abs(currStart[1] - prevEnd[1]);

      if (dn > BOUNDARY_TOUCH_TOL_M || de > BOUNDARY_TOUCH_TOL_M) {
        throw new MissionPlanValidationError(
          "runs_not_contiguous",
          `Run ${rIdx} start [${currStart[0].toFixed(4)}, ${currStart[1].toFixed(4)}] does not match run ${rIdx - 1} end [${prevEnd[0].toFixed(4)}, ${prevEnd[1].toFixed(4)}] (gap: ${Math.hypot(dn, de).toFixed(4)}m > ${BOUNDARY_TOUCH_TOL_M}m).`
        );
      }
    }
  }

  if (totalPoints > MAX_MISSION_POINTS) {
    throw new MissionPlanValidationError(
      "point_limit_exceeded",
      `Mission total points (${totalPoints}) exceeds limit of ${MAX_MISSION_POINTS}.`
    );
  }
}

export interface BuildAppPlannedMissionOptions {
  runs: TrajectoryRun[];
  missionName?: string;
  originNeM?: [number, number];
  clientName?: string;
  clientVersion?: string;
  densifyStepsAboveMax?: boolean;
}

/**
 * Builds the canonical AppPlannedMissionRequest from TrajectoryRuns, strictly enforcing R1-R5:
 * - Inserts explicit travel runs for spatial gaps.
 * - Merges adjacent same-type runs.
 * - Snaps touching boundary points to 100% exact equality.
 * - Enforces pure spray flags per run type and densifies steps > 5.0m.
 */
export function buildAppPlannedMissionPayload(
  options: BuildAppPlannedMissionOptions
): AppPlannedMissionRequest {
  const {
    runs: inputRuns,
    missionName = "app_planned_mission",
    originNeM = [0.0, 0.0],
    clientName = "Three_Wheel_v2",
    clientVersion = "1.0.0",
    densifyStepsAboveMax = true,
  } = options;

  if (!inputRuns || inputRuns.length === 0) {
    throw new MissionPlanValidationError("empty_mission", "Mission has no runs.");
  }

  // Phase 1: Filter empty runs and pre-validate finite coordinates
  const sanitizedRuns: Array<{ kind: "mark" | "travel"; rawPoints: NedPair[] }> = [];

  for (let i = 0; i < inputRuns.length; i++) {
    const r = inputRuns[i];
    if (!r.points || r.points.length === 0) continue;

    for (let pIdx = 0; pIdx < r.points.length; pIdx++) {
      const pt = r.points[pIdx];
      if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        throw new MissionPlanValidationError(
          "non_finite_coordinate",
          `Run ${i} point ${pIdx} has non-finite coordinates: [${pt[0]}, ${pt[1]}].`
        );
      }
      if (
        Math.abs(pt[0]) > MISSION_ENVELOPE_M ||
        Math.abs(pt[1]) > MISSION_ENVELOPE_M
      ) {
        throw new MissionPlanValidationError(
          "out_of_bounds",
          `Run ${i} point ${pIdx} [${pt[0]}, ${pt[1]}] exceeds envelope [±${MISSION_ENVELOPE_M}m].`
        );
      }
    }

    sanitizedRuns.push({
      kind: r.kind,
      rawPoints: r.points.map((p) => [p[0], p[1]]),
    });
  }

  if (sanitizedRuns.length === 0) {
    throw new MissionPlanValidationError("empty_mission", "Mission has zero valid runs.");
  }

  // Phase 2: Bridge any spatial gaps with explicit travel runs and merge adjacent runs of same type (R2 & R3)
  const connectedRuns: Array<{ kind: "mark" | "travel"; rawPoints: NedPair[] }> = [];

  for (let i = 0; i < sanitizedRuns.length; i++) {
    const curr = sanitizedRuns[i];

    if (connectedRuns.length === 0) {
      connectedRuns.push({ kind: curr.kind, rawPoints: [...curr.rawPoints] });
      continue;
    }

    const prev = connectedRuns[connectedRuns.length - 1];
    const prevEnd = prev.rawPoints[prev.rawPoints.length - 1];
    const currStart = curr.rawPoints[0];

    const gap = Math.hypot(currStart[0] - prevEnd[0], currStart[1] - prevEnd[1]);

    if (gap > BOUNDARY_TOUCH_TOL_M) {
      // Non-contiguous gap: must insert an explicit travel run!
      if (prev.kind === "travel") {
        // Previous run is already travel: extend it directly to currStart
        prev.rawPoints.push([currStart[0], currStart[1]]);
      } else {
        // Previous was mark: insert connecting travel run from prevEnd to currStart
        connectedRuns.push({
          kind: "travel",
          rawPoints: [[prevEnd[0], prevEnd[1]], [currStart[0], currStart[1]]],
        });
      }
    }

    // Now curr starts at the last point of the chain.
    const lastRun = connectedRuns[connectedRuns.length - 1];
    const lastEnd = lastRun.rawPoints[lastRun.rawPoints.length - 1];

    // Snap currStart exactly to lastEnd
    const snappedPoints: NedPair[] = [
      [lastEnd[0], lastEnd[1]],
      ...curr.rawPoints.slice(1).map((p) => [p[0], p[1]] as NedPair),
    ];

    if (curr.kind === lastRun.kind) {
      // Merge adjacent runs of same type (R2)
      // Skip the duplicated boundary point (snappedPoints[0])
      for (let k = 1; k < snappedPoints.length; k++) {
        lastRun.rawPoints.push(snappedPoints[k]);
      }
    } else {
      connectedRuns.push({
        kind: curr.kind,
        rawPoints: snappedPoints,
      });
    }
  }

  // Phase 3: Construct point tuples with proper flags and step densification
  const finalRuns: AppPlannedRun[] = [];

  for (let rIdx = 0; rIdx < connectedRuns.length; rIdx++) {
    const run = connectedRuns[rIdx];
    const isMark = run.kind === "mark";
    const sprayBit = isMark ? FLAG_SPRAY_INTENT : 0;
    const rawPts = run.rawPoints;

    // Collinear must-hit points
    const mustHitSet = new Set(collinearAwareMustHitIndices(rawPts));
    const pointTuples: AppPlannedPointTuple[] = [];

    for (let i = 0; i < rawPts.length; i++) {
      const pt = rawPts[i];
      const north = pt[0];
      const east = pt[1];

      // Densify step if > MAX_MISSION_STEP_M
      if (i > 0 && densifyStepsAboveMax) {
        const prevPt = rawPts[i - 1];
        const dn = north - prevPt[0];
        const de = east - prevPt[1];
        const dist = Math.hypot(dn, de);

        if (dist > MAX_MISSION_STEP_M) {
          const numSteps = Math.ceil(dist / MAX_MISSION_STEP_M);
          for (let s = 1; s < numSteps; s++) {
            const frac = s / numSteps;
            const subN = prevPt[0] + dn * frac;
            const subE = prevPt[1] + de * frac;
            // Densified interior points have no must-hit bit, but keep run's sprayBit
            pointTuples.push([subN, subE, sprayBit]);
          }
        }
      }

      // Must-hit bit (endpoints of runs are always must-hit by default, or from curvature analysis)
      const isEndpoint = i === 0 || i === rawPts.length - 1;
      const isMustHit = isEndpoint || mustHitSet.has(i);
      const mustHitBit = isMustHit ? FLAG_MUST_HIT : 0;
      const flags = sprayBit | mustHitBit;

      pointTuples.push([north, east, flags]);
    }

    if (pointTuples.length < 2) {
      throw new MissionPlanValidationError(
        "run_too_short",
        `Run index ${rIdx} has fewer than 2 points after construction.`
      );
    }

    finalRuns.push({
      type: run.kind,
      points: pointTuples,
    });
  }

  // Boundary condition check: ensure exact snapping across run boundaries
  for (let k = 1; k < finalRuns.length; k++) {
    const prevEnd = finalRuns[k - 1].points[finalRuns[k - 1].points.length - 1];
    const currStart = finalRuns[k].points[0];

    // Snap coordinates exactly
    currStart[0] = prevEnd[0];
    currStart[1] = prevEnd[1];

    // R4: Boundary point must-hit bit is OR of both submitted copies
    const prevMustHit = (prevEnd[2] & FLAG_MUST_HIT) !== 0;
    const currMustHit = (currStart[2] & FLAG_MUST_HIT) !== 0;
    if (prevMustHit || currMustHit) {
      prevEnd[2] |= FLAG_MUST_HIT;
      currStart[2] |= FLAG_MUST_HIT;
    }
  }

  const payload: AppPlannedMissionRequest = {
    client: clientName,
    client_version: clientVersion,
    name: missionName,
    frame: APP_MISSION_FRAME,
    origin_ne_m: originNeM,
    runs: finalRuns,
  };

  // Perform rigorous validation pass to guarantee 100% adherence before emitting
  validateAppPlannedMissionRequest(payload);

  return payload;
}

/**
 * Builds an AppPlannedMissionRequest directly from PlanLine[] geometry.
 */
export function buildAppPlannedMissionFromLines(args: {
  lines: PlanLine[];
  missionName?: string;
  originNeM?: [number, number];
  extensionConfig?: CsvExtensionConfig | null;
  markSpeedMs?: number;
  travelSpeedMs?: number;
}): AppPlannedMissionRequest {
  const markSpeedMs = args.markSpeedMs ?? 0.35;
  const travelSpeedMs = args.travelSpeedMs ?? 0.5;

  const trajectory = buildTrajectory(args.lines, {
    markSpeedMs,
    travelSpeedMs,
    extensions: args.extensionConfig,
    includeEntryTransit: false,
  });

  return buildAppPlannedMissionPayload({
    runs: trajectory.runs,
    missionName: args.missionName,
    originNeM: args.originNeM,
  });
}
