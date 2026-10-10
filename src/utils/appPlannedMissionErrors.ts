/**
 * Operator messages for `POST /api/missions/plan` rejections and for the same
 * checks made in the app before sending.
 * Contract: docs/contracts/app_planned_mission.md (v2). Error bodies are
 * `{ok:false, code, reason}`; the code is the stable key, reason is the
 * backend's detail for the specific payload.
 */

import { ProdApiError } from "../api/prodClient";

export const MISSION_PLAN_ERROR_DESCRIPTIONS: Record<string, string> = {
  INVALID_PAYLOAD:
    "The rover could not read the mission payload (malformed or missing fields). This is an app/rover version mismatch: update the app or the rover.",
  INVALID_FRAME:
    "Unsupported coordinate frame. The app always sends local_ned with a GPS anchor.",
  ANCHOR_REQUIRED:
    "The mission has no GPS origin. Align the plan on the map (or load a georeferenced file) so the rover knows where the plan sits, then send again.",
  INVALID_ANCHOR:
    "The GPS origin is not valid: latitude must be within +-90, longitude within +-180, both finite numbers.",
  ORIGIN_WITH_ANCHOR:
    "The payload carried an origin offset next to the GPS anchor. This is an app bug: report it.",
  INVALID_RUN_TYPE: "A run is neither mark nor travel. This is an app bug: report it.",
  INVALID_FLAGS:
    "A point carries invalid flags (must be an integer 0..3). This is an app bug: report it.",
  NON_FINITE_COORDINATE:
    "A coordinate is not a finite number (NaN or infinity). Check the source file or the alignment.",
  OUT_OF_BOUNDS:
    "A point is more than 10 km from the GPS origin. The plan is not a local drawing for this site: check the alignment and the file units.",
  EMPTY_MISSION: "The mission has no runs: nothing to paint.",
  RUN_TOO_SHORT: "A run has fewer than 2 points: every run needs a start and an end.",
  POINTS_LIMIT_EXCEEDED:
    "The mission has too many points (50,000 submitted, 200,000 stored). Split the job into smaller missions.",
  mixed_spray_in_run:
    "Mixed spray states within a run: a mark run must be all spray ON and a travel run all spray OFF.",
  adjacent_runs_same_type:
    "Two neighbouring runs have the same type: runs must alternate between mark and travel.",
  runs_not_contiguous:
    "Gap between runs: each run must start within 10 mm of where the previous run ended. Any move between paths must be an explicit travel run.",
  STEP_NOT_DENSIFIED:
    "A step between points is longer than 5 m after the app's own densify. This is an app bug: report it.",
  INVALID_DASH: "The dash pattern is not valid: ON and OFF lengths must be between 0.05 m and 100 m.",
  too_large: "The mission upload is larger than the rover accepts. Split the job into smaller missions.",
  ARTIFACT_FAILED: "The rover could not store the mission artifact. Try again; if it persists, check the rover storage.",
  HTTP_401: "Not signed in to the rover as an operator. Sign in again, then send.",
  HTTP_403: "Your account is not allowed to upload missions (operator role required).",
  TIMEOUT: "The rover did not answer in time. Check the link and send again. Nothing was started.",
  NETWORK_ERROR: "Could not reach the rover. Check the connection and send again.",
};

/** Message for a backend/app rejection code, with the specific reason appended. */
export function formatMissionPlanError(code: string, reason?: string): string {
  const key = code.trim();
  const description =
    MISSION_PLAN_ERROR_DESCRIPTIONS[key] ?? MISSION_PLAN_ERROR_DESCRIPTIONS[key.toUpperCase()];
  if (description) {
    return reason && reason !== description ? `${description}\n(${reason})` : description;
  }
  return reason || `Mission rejected with code: ${code}`;
}

/** Operator message for anything thrown while building or uploading a mission. */
export function describeMissionPlanFailure(err: unknown): string {
  if (err instanceof ProdApiError) {
    return formatMissionPlanError(err.code, err.reason);
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && err instanceof Error) {
    // MissionPlanValidationError carries its own operator message.
    return formatMissionPlanError(code, err.message.replace(/^\[[^\]]+\]\s*/, ""));
  }
  return err instanceof Error && err.message ? err.message : "Could not send the mission.";
}
