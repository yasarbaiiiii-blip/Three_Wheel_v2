/**
 * Verify what the rover stored against what the app sent.
 *
 * Admission is lossless, and the app densifies and snaps boundaries itself, so
 * the stored mission must equal the payload: same point count, same spray
 * count, same lengths and bounding box, and a normalisation report of zero.
 * The expected values come from the payload itself
 * ({@link computeExpectedAdmission}), never from a fabricated echo. A mismatch
 * blocks Start.
 */

import type { MissionPathResponse } from "../contract/prod/rest";
import type {
  AppPlannedMissionRequest,
  AppPlannedMissionResponse,
} from "../contract/prod/missionPlan";
import { computeExpectedAdmission, type ExpectedAdmission } from "./appPlannedMissionBuilder";

/** Lengths agree within this absolute floor (m) plus {@link LENGTH_REL_TOL}. */
export const LENGTH_ABS_TOL_M = 1e-6;
export const LENGTH_REL_TOL = 1e-9;
/** Stored coordinates are written as exact floats; this only absorbs formatting. */
export const COORD_TOL_M = 1e-9;
/** Any boundary snap above this means the app left a gap between runs. */
export const NORMALISATION_SNAP_TOL_M = 1e-9;

export type AdmissionIssueCode =
  | "missing_mission"
  | "sha_invalid"
  | "normalised"
  | "run_count"
  | "num_points"
  | "num_spray_points"
  | "mark_length"
  | "transit_length"
  | "bbox"
  | "stored_missing"
  | "stored_frame"
  | "stored_anchor"
  | "stored_point_count"
  | "stored_point_mismatch";

export type AdmissionIssue = {
  code: AdmissionIssueCode;
  message: string;
};

export type AdmissionVerifyResult = {
  /** Start must stay blocked when false. */
  ok: boolean;
  issues: AdmissionIssue[];
  expected: ExpectedAdmission;
};

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= LENGTH_ABS_TOL_M + LENGTH_REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/** Check the 201 response of `POST /api/missions/plan` against the payload we sent. */
export function verifyAdmissionResponse(
  payload: AppPlannedMissionRequest,
  response: AppPlannedMissionResponse | null | undefined
): AdmissionVerifyResult {
  const expected = computeExpectedAdmission(payload);
  const issues: AdmissionIssue[] = [];
  const mission = response?.mission;

  if (!mission || typeof mission !== "object") {
    issues.push({
      code: "missing_mission",
      message: "The rover's answer has no mission summary, so the stored mission cannot be checked.",
    });
    return { ok: false, issues, expected };
  }

  if (typeof mission.sha256 !== "string" || !SHA256_HEX.test(mission.sha256)) {
    issues.push({ code: "sha_invalid", message: "The rover returned no valid mission id (sha256)." });
  }

  const norm = response?.normalisation;
  if (!norm || typeof norm.densified_steps !== "number" || typeof norm.max_boundary_snap_m !== "number") {
    issues.push({
      code: "normalised",
      message: "The rover did not report what admission changed (normalisation), so exactness cannot be confirmed.",
    });
  } else {
    if (norm.densified_steps !== 0) {
      issues.push({
        code: "normalised",
        message: `The rover split ${norm.densified_steps} step(s) longer than 5 m: the stored mission is not what the app sent.`,
      });
    }
    if (!(norm.max_boundary_snap_m <= NORMALISATION_SNAP_TOL_M)) {
      issues.push({
        code: "normalised",
        message: `The rover moved a run boundary by ${(norm.max_boundary_snap_m * 1000).toFixed(2)} mm: the stored mission is not what the app sent.`,
      });
    }
  }

  const numRuns = mission.source?.num_runs;
  if (typeof numRuns === "number" && numRuns !== expected.numRuns) {
    issues.push({
      code: "run_count",
      message: `The rover stored ${numRuns} run(s); the app sent ${expected.numRuns}.`,
    });
  }
  if (mission.num_points !== expected.numPoints) {
    issues.push({
      code: "num_points",
      message: `The rover stored ${String(mission.num_points)} point(s); the app expects ${expected.numPoints}.`,
    });
  }
  if (mission.num_spray_points !== expected.numSprayPoints) {
    issues.push({
      code: "num_spray_points",
      message: `The rover stored ${String(mission.num_spray_points)} spray point(s); the app expects ${expected.numSprayPoints}.`,
    });
  }
  if (typeof mission.mark_length_m !== "number" || !near(mission.mark_length_m, expected.markLengthM)) {
    issues.push({
      code: "mark_length",
      message: `Painted length ${String(mission.mark_length_m)} m on the rover vs ${expected.markLengthM.toFixed(3)} m sent.`,
    });
  }
  if (
    typeof mission.transit_length_m !== "number" ||
    !near(mission.transit_length_m, expected.transitLengthM)
  ) {
    issues.push({
      code: "transit_length",
      message: `Travel length ${String(mission.transit_length_m)} m on the rover vs ${expected.transitLengthM.toFixed(3)} m sent.`,
    });
  }
  const bbox = mission.bbox_ne_m;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    bbox.some((v, i) => typeof v !== "number" || Math.abs(v - expected.bboxNeM[i]) > COORD_TOL_M)
  ) {
    issues.push({
      code: "bbox",
      message: "The stored mission's bounding box differs from the geometry that was sent.",
    });
  }

  return { ok: issues.length === 0, issues, expected };
}

/**
 * Bit-exact check of the stored geometry (`GET /api/missions/{sha}/path`)
 * against the payload: frame, anchor, every point and flag.
 */
export function verifyStoredPath(
  payload: AppPlannedMissionRequest,
  stored: MissionPathResponse | null | undefined
): AdmissionIssue[] {
  const issues: AdmissionIssue[] = [];
  if (!stored || !Array.isArray(stored.points)) {
    return [{ code: "stored_missing", message: "The rover returned no stored geometry for this mission." }];
  }
  if (stored.frame !== "local_ned") {
    issues.push({ code: "stored_frame", message: `Stored frame is '${String(stored.frame)}', expected local_ned.` });
  }
  const a = stored.anchor;
  if (!a || Math.abs(a.lat - payload.anchor.lat) > 1e-12 || Math.abs(a.lon - payload.anchor.lon) > 1e-12) {
    issues.push({ code: "stored_anchor", message: "The stored GPS origin differs from the one the app sent." });
  }
  const expected = computeExpectedAdmission(payload).storedPoints;
  if (stored.points.length !== expected.length) {
    issues.push({
      code: "stored_point_count",
      message: `Stored geometry has ${stored.points.length} point(s); the app sent ${expected.length}.`,
    });
    return issues;
  }
  for (let i = 0; i < expected.length; i++) {
    const s = stored.points[i];
    const e = expected[i];
    if (
      !Array.isArray(s) ||
      Math.abs(s[0] - e[0]) > COORD_TOL_M ||
      Math.abs(s[1] - e[1]) > COORD_TOL_M ||
      s[2] !== e[2]
    ) {
      issues.push({
        code: "stored_point_mismatch",
        message: `Stored point ${i} differs from the geometry that was sent.`,
      });
      break;
    }
  }
  return issues;
}
