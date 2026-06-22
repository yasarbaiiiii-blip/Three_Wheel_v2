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

export type ExtensionPayload = {
  enabled: boolean;
  pre_extension_m: number;
  aft_extension_m: number;
  // Optional: omit to leave the backend's saved value unchanged (the server
  // treats a missing per_line as "sticky" and preserves it). Send true/false
  // to explicitly turn per-line extensions on/off.
  per_line?: boolean;
};

export type ExtensionConfigResponse = {
  enabled: boolean;
  pre_extension_m: number;
  aft_extension_m: number;
  per_line: boolean;
  name: string;
  saved: boolean;
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
export type PlanAndStageRequest = PathPlanRequest;

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

export function parseDxf(apiBaseUrl: string, formData: FormData): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/path/parse-dxf"), {
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

export function saveExtensions(
  apiBaseUrl: string,
  pathName: string,
  payload: ExtensionPayload
): Promise<Response> {
  return postJson(apiBaseUrl, `/api/path/${encodeURIComponent(pathName)}/extensions`, payload);
}

export function getExtensions(
  apiBaseUrl: string,
  pathName: string
): Promise<ExtensionConfigResponse> {
  return getJson<ExtensionConfigResponse>(
    apiBaseUrl,
    `/api/path/${encodeURIComponent(pathName)}/extensions`
  );
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

export type { DxfEntitiesResponse };
