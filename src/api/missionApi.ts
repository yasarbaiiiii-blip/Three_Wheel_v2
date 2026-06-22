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

export async function getMissionStatus(apiBaseUrl: string, init?: RequestInit): Promise<MissionStatus> {
  const res = await fetch(apiUrl(apiBaseUrl, "/api/mission/status"), init);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return (await res.json()) as MissionStatus;
}
