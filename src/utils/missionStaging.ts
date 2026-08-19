/**
 * Plan → stage chain for app-planned missions (CSV + DXF).
 *
 * Mirrors the legacy DXF flow's `pathApi.loadToController`, minus steps that only mean
 * something for a rover-side DXF: entity order and per-entity spray overrides are sidecar
 * state keyed to CAD entity ids.
 *
 * The committing step (`/api/path/load-to-controller`) is deliberately NOT here. That one
 * changes rover state and already has a careful, tested implementation in App's
 * `loadMissionOnBackend` — post-load verification, staged-artifact re-fetch, map hydration
 * and mission-identity bookkeeping. This module stops at a staged mission the operator can
 * still walk away from.
 *
 * When `CSV_PLANNER === "app"` (or DXF app planner), use {@link planAndStageAppTrajectory}
 * instead of the survey-file / parse-dxf upload path.
 *
 * Renamed from csvMissionStaging.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import {
  buildPlanTrajectoryRequest,
  planTrajectory,
  type PlanTrajectoryResponse,
} from "../api/planTrajectory";
import * as pathApi from "../api/pathApi";
import type { SurveyGroundTruthPoint, TrajectoryRun } from "./missionTrajectory";
import {
  mergeStagedMustHitCheck,
  verifyTrajectoryResponse,
  type TrajectoryVerifyResult,
} from "./missionTrajectoryVerification";
import { parsePlanAndStageResponse } from "./pathWorkflow";
import type { SurveyCsvExport } from "./surveyCsvExport";
import type { SprayMode } from "../api/planTrajectory";

export type CsvStageStep =
  | "upload"
  | "lineConfig"
  | "planAndStage"
  | "planTrajectory"
  | "verifyEcho"
  | "inspect";

export const CSV_STAGE_STEP_LABELS: Record<CsvStageStep, string> = {
  upload: "Uploading survey CSV…",
  lineConfig: "Applying line config…",
  planAndStage: "Planning & staging mission…",
  planTrajectory: "Planning trajectory on rover…",
  verifyEcho: "Verifying densified runs…",
  inspect: "Inspecting staged mission…",
};

/**
 * Road-marking decision: leave surveyed corners sharp (fillet_corners_m = 0).
 * Softening is a marking-spec choice; operators who need fillets set them via
 * the rover line-config API. Arc fit max deviation stays at the planner default
 * unless overridden — Hyper + adaptive tolerance on the backend handle noise.
 */
export const CSV_DEFAULT_LINE_CONFIG: pathApi.SurveyLineConfig = {
  fillet_corners_m: 0,
};

export type CsvStageResult = {
  success: boolean;
  failedStep?: CsvStageStep;
  error?: string;
  /** Name the file took in the rover's missions dir. */
  pathName?: string;
  missionId?: string;
  plan?: pathApi.PathPlanResponse;
  stagedInspection?: pathApi.StagedMissionResponse;
  /** Present when app planner path ran Phase 4 verification. */
  echoVerification?: TrajectoryVerifyResult;
  /** True when staged via plan-trajectory (no survey file on disk). */
  appPlanned?: boolean;
};

/**
 * Body for `POST /api/path/{name}/plan-and-stage`.
 *
 * `optimize` must stay TRUE, and not because reordering is wanted. On this planner the
 * route optimiser is also the only pass that inserts TRANSIT connectors between separate
 * marking paths — the explicit connector pass is gated behind path extensions, which are
 * off for a CSV. Turning optimisation off therefore does not merely keep file order, it
 * deletes the dead-head legs: the two paths of `roads_coordinates.csv` merge into ONE
 * continuous MARK run and the rover paints straight across the 642 m gap between them.
 * Measured on the real files: `optimize:false` gives runs [MARK 44292, TRANSIT 1] with a
 * 101.7° step turn (167.0° on the roundabout); `optimize:true` gives
 * [MARK 15864, TRANSIT 4267, MARK 28428] and 42.2° / 0.3°.
 *
 * Reordering is safe here because the map is redrawn from the planner's own waypoints
 * before anything is committed — the operator confirms the route that was chosen rather
 * than the one we guessed.
 *
 * `origin_gps` is deliberately absent. A lat/lon survey CSV carries its own geographic
 * origin, which the planner reads off the parsed segments and turns into GPS_SURVEYED
 * placement. Sending one here would override the file's own anchor. A north/east CSV has
 * no georeference at all and correctly stages as LOCAL_NED.
 *
 * `line_spacing` is coarsened for large survey files. plan-and-stage has a hard ~15 s
 * server budget; densifying a multi-thousand-point road survey at the default ~5–10 cm
 * spacing can produce 40k+ waypoints and 504 on a loaded Jetson. Coarser spacing keeps
 * the plan shape and transit legs while staying under the budget.
 */
export function buildCsvPlanAndStageBody(
  fileName: string,
  opts: { surveyPointCount?: number } = {}
): pathApi.PlanAndStageRequest {
  const body: pathApi.PlanAndStageRequest = {
    source: fileName,
    include_waypoints: true,
    optimize: true,
    close_loop: false,
  };
  const n = opts.surveyPointCount ?? 0;
  // Thresholds are on *survey* points (pre-densify). roads_coordinates ≈ 2.5k rows.
  if (n >= 1500) body.line_spacing = 0.15;
  else if (n >= 500) body.line_spacing = 0.1;
  return body;
}

/** Best-effort human-readable message from a failed response. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${fallback} (${res.status})`;
    try {
      const body = JSON.parse(text);
      const detail = body?.detail ?? body?.message;
      if (typeof detail === "string" && detail.trim() !== "") return detail;
    } catch {
      // Not JSON — fall through to the raw body, which FastAPI sometimes returns.
    }
    return text;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Upload the canonical CSV, plan and stage it, then read the staged artifact back.
 *
 * `formData` is built by the caller because it needs the platform's file APIs (a Blob on
 * web, a cache-file reference on native) and this module stays node-testable.
 */
export async function uploadAndStageCsvMission(
  apiBaseUrl: string,
  exported: SurveyCsvExport,
  formData: FormData,
  opts: { onStep?: (step: CsvStageStep) => void } = {}
): Promise<CsvStageResult> {
  const { onStep } = opts;
  const pathName = exported.fileName;

  try {
    onStep?.("upload");
    const uploadRes = await pathApi.uploadPath(apiBaseUrl, formData);
    if (!uploadRes.ok) {
      return {
        success: false,
        failedStep: "upload",
        error: await readError(uploadRes, "Upload failed"),
      };
    }
  } catch (err) {
    return { success: false, failedStep: "upload", error: errorMessage(err, "Network error during upload") };
  }

  try {
    onStep?.("lineConfig");
    const cfgRes = await pathApi.saveLineConfig(apiBaseUrl, pathName, CSV_DEFAULT_LINE_CONFIG);
    if (!cfgRes.ok) {
      // Non-fatal on older backends without line-config — plan still proceeds.
      // Surface only when the status is a real validation error.
      if (cfgRes.status === 422) {
        return {
          success: false,
          failedStep: "lineConfig",
          pathName,
          error: await readError(cfgRes, "Line config rejected"),
        };
      }
    }
  } catch {
    // Network blip on optional config — continue to plan.
  }

  let plan: pathApi.PathPlanResponse;
  let missionId: string;
  try {
    onStep?.("planAndStage");
    const planRes = await pathApi.planAndStage(
      apiBaseUrl,
      pathName,
      buildCsvPlanAndStageBody(pathName, { surveyPointCount: exported.numPoints })
    );
    if (!planRes.ok) {
      return {
        success: false,
        failedStep: "planAndStage",
        pathName,
        error: await readError(planRes, "Plan & stage failed"),
      };
    }
    const parsed = parsePlanAndStageResponse(await planRes.json());
    if (!parsed) {
      return {
        success: false,
        failedStep: "planAndStage",
        pathName,
        error: "Plan & stage succeeded but returned no mission ID.",
      };
    }
    plan = parsed.plan;
    missionId = parsed.missionId;
  } catch (err) {
    return {
      success: false,
      failedStep: "planAndStage",
      pathName,
      error: errorMessage(err, "Network error during planning"),
    };
  }

  try {
    onStep?.("inspect");
    const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
    if (!stagedRes.ok) {
      return {
        success: false,
        failedStep: "inspect",
        pathName,
        missionId,
        plan,
        error: await readError(stagedRes, "Staged mission inspection failed"),
      };
    }
    const stagedInspection = (await stagedRes.json()) as pathApi.StagedMissionResponse;
    return { success: true, pathName, missionId, plan, stagedInspection };
  } catch (err) {
    return {
      success: false,
      failedStep: "inspect",
      pathName,
      missionId,
      plan,
      error: errorMessage(err, "Network error inspecting staged mission"),
    };
  }
}

/**
 * App-planned path: POST /api/path/plan-trajectory, verify run_echo, then inspect staged.
 * Does not upload a survey file. Blocks success when echo verification fails (Load must stay off).
 */
export async function planAndStageAppTrajectory(
  apiBaseUrl: string,
  args: {
    missionName: string;
    originGps: [number, number];
    runs: TrajectoryRun[];
    groundTruth?: SurveyGroundTruthPoint[];
    markSpeedMs?: number;
    travelSpeedMs?: number;
    /** Default continuous; dash/point supported (finding 5). */
    sprayMode?: SprayMode;
    dashOnDistanceM?: number | null;
    dashOffDistanceM?: number | null;
    /**
     * Start restage already verified run_echo; skip GET /staged/{id} (large)
     * and the must_hit spot-check. Send keeps inspect for map hydrate.
     */
    skipStagedInspect?: boolean;
    onStep?: (step: CsvStageStep) => void;
  }
): Promise<CsvStageResult> {
  const { onStep } = args;
  const markSpeedMs = args.markSpeedMs ?? 0.35;
  const travelSpeedMs = args.travelSpeedMs ?? 0.5;
  const pathName = args.missionName;

  if (args.runs.length === 0) {
    return {
      success: false,
      failedStep: "planTrajectory",
      error: "No trajectory runs to send.",
      appPlanned: true,
    };
  }

  let plan: PlanTrajectoryResponse;
  let missionId: string;
  try {
    onStep?.("planTrajectory");
    const body = buildPlanTrajectoryRequest({
      missionName: args.missionName,
      originGps: args.originGps,
      runs: args.runs,
      groundTruth: args.groundTruth,
      markSpeedMs,
      travelSpeedMs,
      sprayMode: args.sprayMode,
      dashOnDistanceM: args.dashOnDistanceM,
      dashOffDistanceM: args.dashOffDistanceM,
    });
    const res = await planTrajectory(apiBaseUrl, body);
    if (!res.ok) {
      return {
        success: false,
        failedStep: "planTrajectory",
        pathName,
        error: await readError(res, "Plan trajectory failed"),
        appPlanned: true,
      };
    }
    const json = await res.json();
    const parsed = parsePlanAndStageResponse(json);
    if (!parsed) {
      return {
        success: false,
        failedStep: "planTrajectory",
        pathName,
        error: "Plan trajectory succeeded but returned no mission ID.",
        appPlanned: true,
      };
    }
    plan = json as PlanTrajectoryResponse;
    missionId = parsed.missionId;
  } catch (err) {
    return {
      success: false,
      failedStep: "planTrajectory",
      pathName,
      error: errorMessage(err, "Network error during plan-trajectory"),
      appPlanned: true,
    };
  }

  onStep?.("verifyEcho");
  let echoVerification = verifyTrajectoryResponse(args.runs, plan);
  if (!echoVerification.ok) {
    const detail = echoVerification.issues
      .filter((i) => i.code !== "backend_warning" && i.code !== "must_hit_missing")
      .map((i) => i.message)
      .join("\n");
    return {
      success: false,
      failedStep: "verifyEcho",
      pathName,
      missionId,
      plan,
      echoVerification,
      appPlanned: true,
      error:
        "Densified run_echo does not match the trajectory we sent — Load blocked.\n" + detail,
    };
  }

  if (args.skipStagedInspect) {
    return {
      success: true,
      pathName,
      missionId,
      plan,
      echoVerification,
      appPlanned: true,
    };
  }

  try {
    onStep?.("inspect");
    const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
    if (!stagedRes.ok) {
      return {
        success: false,
        failedStep: "inspect",
        pathName,
        missionId,
        plan,
        echoVerification,
        appPlanned: true,
        error: await readError(stagedRes, "Staged mission inspection failed"),
      };
    }
    const stagedInspection = (await stagedRes.json()) as pathApi.StagedMissionResponse;

    // Phase 4 must_hit spot-check on staged artifact (finding 2).
    echoVerification = mergeStagedMustHitCheck(echoVerification, {
      sentRuns: args.runs,
      waypoints: stagedInspection.waypoints,
      mustHit: (stagedInspection as { must_hit?: unknown }).must_hit,
    });
    if (!echoVerification.ok) {
      const detail = echoVerification.issues
        .filter((i) => i.code !== "backend_warning" && i.code !== "must_hit_missing")
        .map((i) => i.message)
        .join("\n");
      return {
        success: false,
        failedStep: "verifyEcho",
        pathName,
        missionId,
        plan,
        stagedInspection,
        echoVerification,
        appPlanned: true,
        error:
          "Staged must_hit spot-check failed — Load blocked.\n" + detail,
      };
    }

    return {
      success: true,
      pathName,
      missionId,
      plan,
      stagedInspection,
      echoVerification,
      appPlanned: true,
    };
  } catch (err) {
    return {
      success: false,
      failedStep: "inspect",
      pathName,
      missionId,
      plan,
      echoVerification,
      appPlanned: true,
      error: errorMessage(err, "Network error inspecting staged mission"),
    };
  }
}
