/**
 * Build -> upload -> verify chain for app-planned missions (CSV + DXF).
 *
 * The payload is built by the one builder (`appPlannedMissionBuilder`), sent
 * through the authenticated production client (`prodClient`, which sets the
 * operator bearer token) as `POST /api/missions/plan` with the GPS anchor, and
 * the rover's answer is checked against the payload itself: the stored mission
 * must equal what was sent. Status never comes from polling; the only reads are
 * the upload answer and one optional geometry read-back at Send.
 *
 * The committing step (load to controller, then Start) is deliberately NOT
 * here. This module stops at a stored mission the operator can still walk away
 * from.
 */

import { getProdApiClient, type ProdApiClient } from "../api/prodClient";
import type {
  AppPlannedMissionRequest,
  AppPlannedMissionResponse,
  AppPlannedNormalisation,
  AppPlannedMissionSummary,
  MissionAnchor,
} from "../contract/prod/missionPlan";
import {
  buildAppPlannedMissionPayload,
  type DashPattern,
} from "./appPlannedMissionBuilder";
import type { StagedPlanResultState } from "../types/fieldsWorkflow";
import { describeMissionPlanFailure } from "./appPlannedMissionErrors";
import type { TrajectoryRun } from "./missionTrajectory";
import {
  verifyAdmissionResponse,
  verifyStoredPath,
  type AdmissionIssue,
} from "./missionTrajectoryVerification";

export type MissionStageStep = "build" | "upload" | "verify";

export const MISSION_STAGE_STEP_LABELS: Record<MissionStageStep, string> = {
  build: "Building mission…",
  upload: "Uploading mission to the rover…",
  verify: "Verifying the stored mission…",
};

/** What the rover stored, as reported by its answer and the app's own run lengths. */
export type AdmittedMission = {
  /** Content hash of the stored artifact: the mission id used by Load and Start. */
  missionId: string;
  mission: AppPlannedMissionSummary;
  normalisation: AppPlannedNormalisation;
  numRuns: number;
  numWaypoints: number;
  markLengthM: number;
  transitLengthM: number;
  totalLengthM: number;
};

export type MissionStageResult = {
  success: boolean;
  failedStep?: MissionStageStep;
  error?: string;
  missionName?: string;
  missionId?: string;
  admitted?: AdmittedMission;
  /** The exact payload that was sent. */
  payload?: AppPlannedMissionRequest;
  /** True when verification failed: Load must stay blocked. */
  loadBlocked?: boolean;
};

function issuesToMessage(issues: AdmissionIssue[]): string {
  return issues.map((i) => i.message).join("\n");
}

/**
 * Plan -> upload -> verify an app-planned trajectory.
 *
 * - No GPS origin: refused here with a clear operator error. EKF-local is never sent.
 * - Blocks success (Load stays off) when the stored mission differs from the payload.
 */
export async function stageAppPlannedMission(args: {
  missionName: string;
  /** WGS84 position of the trajectory's local origin. Required. */
  anchor: MissionAnchor | [number, number] | null | undefined;
  runs: TrajectoryRun[];
  dash?: DashPattern | null;
  /**
   * Read the stored geometry back and compare every point and flag. On for
   * Send; Start re-stages skip it (large) and rely on the summary check.
   */
  verifyStoredGeometry?: boolean;
  onStep?: (step: MissionStageStep) => void;
  /** Injected in tests; defaults to the app-wide authenticated client. */
  client?: ProdApiClient;
}): Promise<MissionStageResult> {
  const { onStep } = args;
  const missionName = args.missionName;

  if (args.runs.length === 0) {
    return { success: false, failedStep: "build", missionName, error: "No trajectory runs to send." };
  }

  let payload: AppPlannedMissionRequest;
  try {
    onStep?.("build");
    payload = buildAppPlannedMissionPayload({
      runs: args.runs,
      anchor: args.anchor,
      missionName,
      dash: args.dash,
    });
  } catch (err) {
    return { success: false, failedStep: "build", missionName, error: describeMissionPlanFailure(err) };
  }

  const client = args.client ?? getProdApiClient();
  if (!client.getToken()) {
    return {
      success: false,
      failedStep: "upload",
      missionName,
      payload,
      error: "Not signed in to the rover as an operator. Sign in, then send again.",
    };
  }

  let response: AppPlannedMissionResponse;
  try {
    onStep?.("upload");
    response = await client.uploadAppPlannedMission(payload);
  } catch (err) {
    return {
      success: false,
      failedStep: "upload",
      missionName,
      payload,
      error: describeMissionPlanFailure(err),
    };
  }

  onStep?.("verify");
  const verdict = verifyAdmissionResponse(payload, response);
  const missionId = response?.mission?.sha256;
  if (!verdict.ok) {
    return {
      success: false,
      failedStep: "verify",
      loadBlocked: true,
      missionName,
      missionId,
      payload,
      error: `The rover's stored mission does not match what was sent. Load blocked.\n${issuesToMessage(verdict.issues)}`,
    };
  }

  if (args.verifyStoredGeometry !== false) {
    try {
      const stored = await client.getMissionPath(response.mission.sha256);
      const issues = verifyStoredPath(payload, stored);
      if (issues.length > 0) {
        return {
          success: false,
          failedStep: "verify",
          loadBlocked: true,
          missionName,
          missionId,
          payload,
          error: `The rover's stored geometry does not match what was sent. Load blocked.\n${issuesToMessage(issues)}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        failedStep: "verify",
        loadBlocked: true,
        missionName,
        missionId,
        payload,
        error: `Could not read the stored mission back to verify it. Load blocked.\n${describeMissionPlanFailure(err)}`,
      };
    }
  }

  const mark = verdict.expected.markLengthM;
  const transit = verdict.expected.transitLengthM;
  return {
    success: true,
    missionName,
    missionId: response.mission.sha256,
    payload,
    admitted: {
      missionId: response.mission.sha256,
      mission: response.mission,
      normalisation: response.normalisation,
      numRuns: verdict.expected.numRuns,
      numWaypoints: response.mission.num_points,
      markLengthM: mark,
      transitLengthM: transit,
      totalLengthM: mark + transit,
    },
  };
}

/** Workflow summary of an admitted mission (Send panel and Start re-stage). */
export function stagedPlanResultFromAdmitted(admitted: AdmittedMission): StagedPlanResultState {
  return {
    missionId: admitted.missionId,
    numWaypoints: admitted.numWaypoints,
    numSegments: admitted.numRuns,
    totalLengthM: admitted.totalLengthM,
    markLengthM: admitted.markLengthM,
    transitLengthM: admitted.transitLengthM,
    estimatedPaintL: null,
    estimatedRuntimeS: null,
    rmseM: null,
    warnings: [],
  };
}
