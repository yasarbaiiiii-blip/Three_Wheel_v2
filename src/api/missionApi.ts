import { getProdApiClient } from "./prodClient";
import { beginTelemetryRequest, ingestTelemetryPacket, getMissionStartTelemetryPose, getAdaptedTelemetrySnapshot, getProdTelemetryState, getTelemetrySourceAgeMs } from "../features/telemetry/prodTelemetryStore";
import { selectMission } from "../features/mission/missionLifecycle";

export type LoadMissionPayload = {
  path_name?: string;
  mission_file?: string;
  [key: string]: unknown;
};

export type LoadMissionToControllerPayload = {
  mission_id: string;
};

/** Optional flags for App.loadMissionOnBackend (Send / Start fast path). */
export type LoadMissionOptions = {
  hideRuntimeEntryLine?: boolean;
  extensionLines?: import("../types/plan").PlanLine[] | null;
  manageBusy?: boolean;
  stagedInspection?: import("./pathApi").StagedMissionResponse | null;
  /**
   * Keep operator DXF/CSV segments on the map. Densified rover waypoints
   * collapse painted runs into one line and break per-segment spray toggles.
   */
  skipMapHydration?: boolean;
  /** Start is already on Home — don't remount the page. */
  skipNavigate?: boolean;
  /**
   * Layer-scoped Start restages a subset — mark-count must compare against
   * that subset, not the full Send snapshot.
   */
  expectedPaintedLines?: import("../types/plan").PlanLine[] | null;
  /** Caller presents the error (Start). Skip Alert/toast and rethrow. */
  rethrow?: boolean;
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

export async function loadMissionToController(
  apiBaseUrl: string,
  payload: LoadMissionToControllerPayload
): Promise<Response> {
  if (apiBaseUrl.includes(":8000") || (payload.mission_id && /^[0-9a-f]{64}$/i.test(payload.mission_id))) {
    return new Response(JSON.stringify({ success: true, mission_id: payload.mission_id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return postJson(apiBaseUrl, "/api/path/load-to-controller", payload);
}

export async function getLoadedPath(apiBaseUrl: string): Promise<Response> {
  const status = await getMissionStatus(apiBaseUrl);
  const id = status.loaded_mission_id;
  const path = id ? await getProdApiClient().getMissionPath(id) : null;
  // Never attach geometry from an old mission to a newer telemetry identity.
  const latest = missionStatusFromTelemetry();
  if (!latest || latest.loaded_mission_id !== id) throw new Error("Mission changed during recovery; retry.");
  const points = path?.points ?? [];
  const marks = points.filter(p => (p[2] & 1) !== 0).length;
  const inspection: LoadedPathResponse = {
    loaded: Boolean(id), mission_id: id, running_mission_id: latest.running_mission_id,
    state: latest.state, is_staged: Boolean(id),
    num_waypoints: points.length, num_mark: marks, num_transit: points.length - marks,
    has_spray_flags: points.length > 0, sample_coords: points.map(p => [p[0],p[1]]), sample_truncated: false,
  };
  return new Response(JSON.stringify(inspection), {status:200, headers:{"Content-Type":"application/json"}});
}

export async function startMission(apiBaseUrl: string, payload?: StartMissionPayload): Promise<Response> {
  if (payload?.mission_id && (/^[0-9a-f]{64}$/i.test(payload.mission_id) || apiBaseUrl.includes(":8000"))) {
    try {
      const prodRes = await fetch(apiUrl(apiBaseUrl, `/api/missions/${encodeURIComponent(payload.mission_id)}/start`), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (prodRes.status !== 404) {
        return prodRes;
      }
    } catch {
      // fallback
    }
  }
  return postJson(apiBaseUrl, "/api/mission/start", payload);
}

export async function stopMission(apiBaseUrl: string): Promise<Response> {
  if (apiBaseUrl.includes(":8000")) {
    try {
      const prodRes = await postJson(apiBaseUrl, "/api/mission/abort", { reason: "operator" });
      if (prodRes.status !== 404) {
        return prodRes;
      }
    } catch {
      // fallback
    }
  }
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

export function missionStatusFromTelemetry(): MissionStatus | null {
  const view = selectMission();
  const adapted = getAdaptedTelemetrySnapshot();
  if (!view.known || !adapted?.mission_state) return null;
  const id = view.run.executionSha || null;
  return {state: adapted.mission_state, rpp_state: adapted.rpp_state ?? null,
    rpp_state_name: adapted.rpp_state_name ?? "UNKNOWN", dist_to_goal: adapted.dist_to_goal_m ?? null,
    speed: adapted.speed_m_s ?? null, xtrack: adapted.xtrack_m ?? null, loaded_mission_id: id,
    running_mission_id: ["running", "paused"].includes(adapted.mission_state) ? id : null};
}

export async function getMissionStatus(_apiBaseUrl: string, _init?: RequestInit): Promise<MissionStatus> {
  const request = beginTelemetryRequest();
  const packet = await getProdApiClient().getTelemetry();
  ingestTelemetryPacket(packet, {source:"rest", request});
  const status = missionStatusFromTelemetry();
  if (!status) throw new Error("Mission telemetry unavailable or stale.");
  return status;
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
 * Validated production pose from GET /api/telemetry, with the same Start gate as socket telemetry.
 * Returns null on network/HTTP failure so callers can fall back to a timed socket cache.
 */
export async function fetchLatestTelemetryPose(
  _apiBaseUrl: string,
  originGps?: [number, number] | null
): Promise<LatestTelemetryPose | null> {
  try {
    const request = beginTelemetryRequest();
    const data = await getProdApiClient().getTelemetry();
    ingestTelemetryPacket(data, { source: "rest", request });
    return getMissionStartTelemetryPose(originGps);
  } catch {
    return null;
  }
}
