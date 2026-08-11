export type LoadMissionPayload = {
  path_name?: string;
  mission_file?: string;
  [key: string]: unknown;
};

export type LoadMissionToControllerPayload = {
  mission_id: string;
};

export type PlacementMode = "GPS_SURVEYED" | "LOCAL_NED";

export type StartMissionPayload = {
  mission_id?: string;
  path_name?: string;
  mission_file?: string;
  auto_origin?: boolean;
};

export type MissionStatus = {
  state: string;
  rpp_state: number | null;
  rpp_state_name: string;
  dist_to_goal: number | null;
  speed: number | null;
  xtrack: number | null;
  loaded_mission_id?: string | null;
  running_mission_id?: string | null;
  [key: string]: unknown;
};

export type LoadedPathResponse = {
  loaded: boolean;
  name?: string | null;
  mission_id?: string | null;
  running_mission_id?: string | null;
  source_name?: string | null;
  placement_mode?: PlacementMode | null;
  is_staged?: boolean;
  protected?: boolean;
  state: string;
  num_waypoints: number;
  num_mark: number;
  num_transit: number;
  has_spray_flags: boolean;
  sample_coords: number[][];
  sample_truncated: boolean;
  anchor?: Record<string, unknown> | null;
  [key: string]: unknown;
};

function apiUrl(apiBaseUrl: string, path: string) {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

function postJson(apiBaseUrl: string, path: string, payload?: unknown): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, path), {
    method: "POST",
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export function loadMission(apiBaseUrl: string, payload: LoadMissionPayload): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/load", payload);
}

export function loadMissionToController(
  apiBaseUrl: string,
  payload: LoadMissionToControllerPayload
): Promise<Response> {
  return postJson(apiBaseUrl, "/api/path/load-to-controller", payload);
}

export function getLoadedPath(apiBaseUrl: string): Promise<Response> {
  return fetch(apiUrl(apiBaseUrl, "/api/mission/loaded-path"), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
}

export function startMission(apiBaseUrl: string, payload?: StartMissionPayload): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/start", payload);
}

export function stopMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/stop");
}

export function abortMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/abort");
}

export function clearMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/clear");
}

export function pauseMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/pause");
}

export function resumeMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/resume");
}

export function nextMission(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/next");
}

export function exportLog(apiBaseUrl: string): Promise<Response> {
  return postJson(apiBaseUrl, "/api/mission/export");
}

export async function getMissionStatus(apiBaseUrl: string, init?: RequestInit): Promise<MissionStatus> {
  const res = await fetch(apiUrl(apiBaseUrl, "/api/mission/status"), init);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MissionStatus;
}

/**
 * Re-fetch mission status and reconcile local workflow state.
 * Returns the loaded path and mission state from the backend.
 */
export async function fetchMissionStatus(apiBaseUrl: string): Promise<{
  state: string;
  loaded_mission_id: string | null;
  running_mission_id: string | null;
}> {
  const status = await getMissionStatus(apiBaseUrl);
  return {
    state: status.state ?? "idle",
    loaded_mission_id: status.loaded_mission_id ?? null,
    running_mission_id: status.running_mission_id ?? null,
  };
}

/**
 * Fetch staged mission verification status from the backend.
 * Returns { verified, mission_id } or null if not staged.
 */
export async function fetchStagedMissionStatus(
  apiBaseUrl: string,
  missionId: string | null
): Promise<{ verified: boolean; mission_id: string | null } | null> {
  if (!missionId) return null;
  try {
    const res = await fetch(
      `${apiBaseUrl.replace(/\/$/, "")}/api/path/staged/${encodeURIComponent(missionId)}`,
      { method: "GET", headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      verified: Boolean(data?.mission_id),
      mission_id: data?.mission_id ?? null,
    };
  } catch {
    return null;
  }
}

/** Pose fields needed to build the runtime entry leg at Start. */
export type LatestTelemetryPose = {
  pos_n?: number | null;
  pos_e?: number | null;
  lat?: number | null;
  lon?: number | null;
  gps_fix?: number | null;
  pose_age_ms?: number | null;
};

/**
 * Fresh rover pose from GET /api/telemetry/latest.
 * Returns null on network/HTTP failure so callers can fall back to a timed socket cache.
 */
export async function fetchLatestTelemetryPose(
  apiBaseUrl: string
): Promise<LatestTelemetryPose | null> {
  try {
    const res = await fetch(apiUrl(apiBaseUrl, "/api/telemetry/latest"), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;

    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;

    // Normalize common aliases (same as the socket telemetry handler).
    const lat =
      num(data.lat) ??
      num(data.latitude) ??
      num(data.gps_lat) ??
      num(data.global_lat);
    const lon =
      num(data.lon) ??
      num(data.longitude) ??
      num(data.gps_lon) ??
      num(data.global_lon);

    return {
      pos_n: num(data.pos_n),
      pos_e: num(data.pos_e),
      lat,
      lon,
      gps_fix: num(data.gps_fix),
      pose_age_ms: num(data.pose_age_ms),
    };
  } catch {
    return null;
  }
}
