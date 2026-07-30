import type { DxfEntitiesResponse } from "../types/plan";

export type PathListItem = {
  name: string;
  description?: string;
  num_points?: number;
  [key: string]: unknown;
};

export type PathPreviewResponse = {
  name?: string;
  frame?: string;
  num_points?: number;
  bounds?: {
    north_min: number;
    north_max: number;
    east_min: number;
    east_max: number;
  };
  waypoints?: Array<{
    north: number;
    east: number;
    spray?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type EntityOverride = {
  entity_id: string;
  is_mark: boolean;
};

export type RefPoint = {
  dxf_x: number;
  dxf_y: number;
  lat: number;
  lon: number;
};

export type PathPlanRequest = {
  source: string;
  include_waypoints?: boolean;
  ref_points?: RefPoint[];
  origin_gps?: [number, number];
  rotation_deg?: number;
  [key: string]: unknown;
};

export type MissionSummary = {
  mission_id?: string;
  num_waypoints?: number;
  total_length_m?: number;
  estimated_paint_l?: number;
  estimated_runtime_s?: number;
  rmse_m?: number;
  [key: string]: unknown;
};

export type PathPlanResponse = {
  source?: string;
  mission_id?: string;
  num_waypoints?: number;
  num_segments?: number;
  segments?: unknown[];
  merged_waypoints?: unknown[];
  spray_flags?: boolean[];
  alignment_metadata?: Record<string, unknown> | null;
  planning_metadata?: Record<string, unknown>;
  warnings?: string[];
  mission_summary?: MissionSummary | null;
  [key: string]: unknown;
};

export type AlignPathRequest = {
  ref_points?: RefPoint[];
  origin_gps?: [number, number];
  rotation_deg?: number;
  [key: string]: unknown;
};

export type PointMissionPoint = {
  north_m: number;
  east_m: number;
  dwell_s: number;
  source_index: number;
  mark: boolean;
};

export type ParsePointGpsCsvResponse = {
  num_points: number;
  anchor: { lat: number; lon: number };
  point_source_frame: "GPS_SURVEYED";
  point_mission_points: PointMissionPoint[];
};

export type PlanAndStageRequest = PathPlanRequest & {
  point_source_frame?: string;
  point_mission_points?: PointMissionPoint[];
};

function apiUrl(apiBaseUrl: string, path: string) {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

function jsonHeaders() {
  return { "Content-Type": "application/json" };
}

async function getJson<T>(apiBaseUrl: string, path: string): Promise<T> {
  const res = await fetch(apiUrl(apiBaseUrl, path), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function postJson(apiBaseUrl: string, path: string, payload: unknown): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, path), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
}

export function getPaths(apiBaseUrl: string): Promise<PathListItem[]> {
  return getJson<PathListItem[]>(apiBaseUrl, "/api/paths");
}

/**
 * Rover-side DXF entity list.
 * @deprecated When `DXF_PLANNER === "app"`, use `parseLocalDxf` (Phase 8). Kept for rollback.
 */
export function getPathEntities(apiBaseUrl: string, pathName: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/entities`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

export function getPathPreview(apiBaseUrl: string, pathName: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/preview`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

/**
 * Rover-side DXF parse (uploads file to MISSION_DIR).
 * @deprecated When `DXF_PLANNER === "app"`, use `parseLocalDxf` on device. Kept for rollback.
 */
export function parseDxf(apiBaseUrl: string, formData: FormData): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/parse-dxf"), {
    method: "POST",
    body: formData,
  });
}

/**
 * @deprecated Fields Select File CSV is local-only (`parseLocalPointCsv`).
 * Kept for optional tooling / non-UI callers — do not wire mission upload UI to these.
 */
export function parsePointCsv(apiBaseUrl: string, formData: FormData): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/parse-point-csv"), {
    method: "POST",
    body: formData,
  });
}

/**
 * @deprecated Fields Select File CSV is local-only (`parseLocalPointCsv`).
 * Kept for optional tooling / non-UI callers — do not wire mission upload UI to these.
 */
export function parsePointGpsCsv(apiBaseUrl: string, formData: FormData): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/parse-point-gps-csv"), {
    method: "POST",
    body: formData,
  });
}

export function uploadPath(apiBaseUrl: string, formData: FormData): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/upload"), {
    method: "POST",
    body: formData,
  });
}

export function saveEntityOverrides(
  apiBaseUrl: string,
  pathName: string,
  overrides: EntityOverride[]
): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/entities`, { overrides });
}

export function saveEntityOrder(
  apiBaseUrl: string,
  pathName: string,
  entity_order: string[]
): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/entities/order`, { entity_order });
}

export function planPath(apiBaseUrl: string, payload: PathPlanRequest): Promise<Response> {
  return postJson(apiBaseUrl, "/api/path/plan", payload);
}

export function alignPath(apiBaseUrl: string, pathName: string, payload: AlignPathRequest): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/align`, payload);
}

export type PathSegmentInfo = {
  index: number;
  sequence: number;
  type: "MARK" | "TRANSIT" | string;
  segment_role?: string | null;
  extension_role?: string | null;
  source_entity?: string;
  is_extension?: boolean;
  spray_on?: boolean;
  speed?: number;
  length_m?: number;
  points?: number[][];
};

export type PathSegmentsResponse = {
  name: string;
  num_segments: number;
  num_waypoints: number;
  mark_length_m: number;
  transit_length_m: number;
  total_length_m: number;
  segments: PathSegmentInfo[];
  warnings?: string[] | null;
  [key: string]: unknown;
};

export function getPathSegments(apiBaseUrl: string, pathName: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/segments`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

export type StagedMissionResponse = {
  mission_id: string;
  created_at?: number | null;
  anchor?: Record<string, unknown> | null;
  num_waypoints: number;
  waypoints: number[][];
  spray_flags: boolean[];
  segment_runs: Record<string, unknown>[];
  alignment_metadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  point_mission_points?: PointMissionPoint[];
  point_source_frame?: string;
  spray_mode?: string;
  [key: string]: unknown;
};

export function planAndStage(apiBaseUrl: string, pathName: string, payload: PlanAndStageRequest): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/plan-and-stage`, payload);
}

export function getStagedMission(apiBaseUrl: string, missionId: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/staged/${encodeURIComponent(missionId)}`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

export function deletePath(apiBaseUrl: string, pathName: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}`), {
    method: "DELETE",
  });
}

export type SurveyLineConfig = {
  fillet_corners_m?: number;
  fit_arcs_max_dev_m?: number | null;
};

export function saveLineConfig(
  apiBaseUrl: string,
  pathName: string,
  config: SurveyLineConfig
): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/line-config`, config);
}

export function getLineConfig(apiBaseUrl: string, pathName: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/line-config`), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

export type { DxfEntitiesResponse };

/** Step-by-step result for the Load to Controller orchestrator */
export type LoadToControllerStep =
  | "saveOrder"
  | "saveSpray"
  | "verifySegments"
  | "planAndStage"
  | "getStagedMission"
  | "loadMission";

export type LoadToControllerResult = {
  success: boolean;
  failedStep?: LoadToControllerStep;
  error?: string;
  missionId?: string;
  stagedPlanResult?: any;
  stagedMissionInspection?: StagedMissionResponse;
  segmentVerification?: PathSegmentsResponse;
};

/**
 * Orchestrates the full "Load to Controller" flow:
 * 1. Save entity order
 * 2. Save entity spray overrides
 * 3. Verify path segments
 * 4. Plan & stage
 * 5. Get staged mission inspection
 *
 * Returns step-by-step result. The caller handles step 6 (actual load) separately.
 */
export async function loadToController(
  apiBaseUrl: string,
  pathName: string,
  opts: {
    entityOrder: string[];
    sprayOverrides: EntityOverride[];
    alignmentRequest: AlignPathRequest;
    onStep?: (step: LoadToControllerStep) => void;
  }
): Promise<LoadToControllerResult> {
  const { entityOrder, sprayOverrides, alignmentRequest, onStep } = opts;

  // Step 1: Save entity order
  try {
    onStep?.("saveOrder");
    const orderRes = await saveEntityOrder(apiBaseUrl, pathName, entityOrder);
    if (!orderRes.ok) {
      const errText = await orderRes.text();
      return { success: false, failedStep: "saveOrder", error: errText || "Failed to save path order" };
    }
  } catch (err: any) {
    return { success: false, failedStep: "saveOrder", error: err.message || "Network error saving order" };
  }

  // Step 2: Save spray overrides
  try {
    onStep?.("saveSpray");
    const sprayRes = await saveEntityOverrides(apiBaseUrl, pathName, sprayOverrides);
    if (!sprayRes.ok) {
      const errText = await sprayRes.text();
      return { success: false, failedStep: "saveSpray", error: errText || "Failed to save spray settings" };
    }
  } catch (err: any) {
    return { success: false, failedStep: "saveSpray", error: err.message || "Network error saving spray" };
  }

  // Step 3: Verify segments
  let segmentVerification: PathSegmentsResponse | undefined;
  try {
    onStep?.("verifySegments");
    const segRes = await getPathSegments(apiBaseUrl, pathName);
    if (!segRes.ok) {
      const errText = await segRes.text();
      return { success: false, failedStep: "verifySegments", error: errText || "Segment verification failed" };
    }
    segmentVerification = await segRes.json();
  } catch (err: any) {
    return { success: false, failedStep: "verifySegments", error: err.message || "Network error verifying segments" };
  }

  // Step 4: Plan & Stage
  let missionId: string | undefined;
  let stagedPlanResult: any;
  try {
    onStep?.("planAndStage");
    const body: PlanAndStageRequest = {
      source: pathName,
      ...alignmentRequest,
    };
    const planRes = await planAndStage(apiBaseUrl, pathName, body);
    if (!planRes.ok) {
      const errText = await planRes.text();
      return { success: false, failedStep: "planAndStage", error: errText || "Plan & stage failed" };
    }
    stagedPlanResult = await planRes.json();
    missionId = stagedPlanResult?.mission_id ?? stagedPlanResult?.mission_summary?.mission_id;
    if (!missionId) {
      return { success: false, failedStep: "planAndStage", error: "Response did not include a mission_id" };
    }
  } catch (err: any) {
    return { success: false, failedStep: "planAndStage", error: err.message || "Network error during planning" };
  }

  // Step 5: Get staged mission inspection
  let stagedMissionInspection: StagedMissionResponse | undefined;
  try {
    onStep?.("getStagedMission");
    const stagedRes = await getStagedMission(apiBaseUrl, missionId);
    if (!stagedRes.ok) {
      const errText = await stagedRes.text();
      return { success: false, failedStep: "getStagedMission", error: errText || "Failed to inspect staged mission" };
    }
    stagedMissionInspection = await stagedRes.json();
  } catch (err: any) {
    return { success: false, failedStep: "getStagedMission", error: err.message || "Network error inspecting staged mission" };
  }

  return {
    success: true,
    missionId,
    stagedPlanResult,
    stagedMissionInspection,
    segmentVerification,
  };
}
