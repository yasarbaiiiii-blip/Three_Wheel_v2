/**
 * App-Planned Mission Builder for GAP-04 (POST /api/missions/plan).
 *
 * Authority: The client app is the sole authority for path shape, order,
 * extensions, collinearity, and must-hit points.
 *
 * Rules:
 * 1. Coordinates: local_ned in metres [north_m, east_m, flags].
 * 2. Flags: bit 0 = spray intent (1 = on, 0 = off), bit 1 = must-hit (2 = must-hit, 0 = intermediate).
 * 3. Enforces client-side limits:
 *    - Step length <= 5.0 m (subdivides collinear segments > 5.0m preserving endpoints).
 *    - Max 50,000 points.
 *    - Spatial envelope [-10000.0, 10000.0] m.
 * 4. Preserves exact run order, pre/post extensions, and non-spray transits.
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
import type { TrajectoryRun } from "./missionTrajectory";
import type { PlanLine } from "../types/plan";
import { buildTrajectory } from "./missionTrajectory";
import type { CsvExtensionConfig } from "./missionExtensions";

export class MissionPlanValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MissionPlanValidationError";
    this.code = code;
  }
}

export interface BuildAppPlannedMissionOptions {
  runs: TrajectoryRun[];
  missionName?: string;
  originNeM?: [number, number];
  clientName?: string;
  clientVersion?: string;
  /** Enforces max step length subdivision (default true, <= 5.0m). */
  densifyStepsAboveMax?: boolean;
}

/**
 * Builds the canonical AppPlannedMissionRequest payload from a list of TrajectoryRuns.
 */
export function buildAppPlannedMissionPayload(
  options: BuildAppPlannedMissionOptions
): AppPlannedMissionRequest {
  const {
    runs,
    missionName = "app_planned_mission",
    originNeM = [0.0, 0.0],
    clientName = "Three_Wheel_v2",
    clientVersion = "1.0.0",
    densifyStepsAboveMax = true,
  } = options;

  if (!runs || runs.length === 0) {
    throw new MissionPlanValidationError("EMPTY_MISSION", "Mission has no runs.");
  }

  const plannedRuns: AppPlannedRun[] = [];
  let totalPointsCount = 0;

  for (let rIdx = 0; rIdx < runs.length; rIdx++) {
    const run = runs[rIdx];
    const kind = run.kind;
    if (kind !== "mark" && kind !== "travel") {
      throw new MissionPlanValidationError(
        "INVALID_RUN_TYPE",
        `Run index ${rIdx} has invalid type ${String(kind)}. Must be 'mark' or 'travel'.`
      );
    }

    const rawPoints = run.points;
    if (!rawPoints || rawPoints.length === 0) {
      continue;
    }

    // Determine must-hit indices using collinear-aware curvature analysis
    const mustHitSet = new Set(collinearAwareMustHitIndices(rawPoints));
    const sprayBit = kind === "mark" ? FLAG_SPRAY_INTENT : 0;

    const runPoints: AppPlannedPointTuple[] = [];

    for (let i = 0; i < rawPoints.length; i++) {
      const pt = rawPoints[i];
      const north = pt[0];
      const east = pt[1];

      if (!Number.isFinite(north) || !Number.isFinite(east)) {
        throw new MissionPlanValidationError(
          "NON_FINITE_COORDINATE",
          `Run ${rIdx} point ${i} has non-finite coordinates: [${north}, ${east}]`
        );
      }

      if (
        Math.abs(north) > MISSION_ENVELOPE_M ||
        Math.abs(east) > MISSION_ENVELOPE_M
      ) {
        throw new MissionPlanValidationError(
          "OUT_OF_BOUNDS",
          `Run ${rIdx} point ${i} [${north}, ${east}] exceeds envelope [±${MISSION_ENVELOPE_M}m].`
        );
      }

      // If there's a previous point and step distance > MAX_MISSION_STEP_M
      if (i > 0 && densifyStepsAboveMax) {
        const prevPt = rawPoints[i - 1];
        const dn = north - prevPt[0];
        const de = east - prevPt[1];
        const dist = Math.hypot(dn, de);

        if (dist > MAX_MISSION_STEP_M) {
          const numSteps = Math.ceil(dist / MAX_MISSION_STEP_M);
          for (let s = 1; s < numSteps; s++) {
            const frac = s / numSteps;
            const subN = prevPt[0] + dn * frac;
            const subE = prevPt[1] + de * frac;
            // Interior densification points are NOT must-hit
            runPoints.push([subN, subE, sprayBit]);
          }
        }
      }

      const mustHitBit = mustHitSet.has(i) ? FLAG_MUST_HIT : 0;
      const flags = sprayBit | mustHitBit;
      runPoints.push([north, east, flags]);
    }

    if (runPoints.length > 0) {
      plannedRuns.push({
        type: kind,
        points: runPoints,
      });
      totalPointsCount += runPoints.length;
    }
  }

  if (totalPointsCount === 0) {
    throw new MissionPlanValidationError("EMPTY_MISSION", "Mission has 0 total points.");
  }

  if (totalPointsCount > MAX_MISSION_POINTS) {
    throw new MissionPlanValidationError(
      "POINTS_LIMIT_EXCEEDED",
      `Mission total points (${totalPointsCount}) exceeds maximum limit of ${MAX_MISSION_POINTS}.`
    );
  }

  return {
    client: clientName,
    client_version: clientVersion,
    name: missionName,
    frame: APP_MISSION_FRAME,
    origin_ne_m: originNeM,
    runs: plannedRuns,
  };
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
