import type { RTKBackendMode, RTKSourceState, RTKStatus } from "../types/appRuntime";

export const RTK_STATUS_TIMEOUT_MS = 5000;

export const EMPTY_RTK_STATUS: RTKStatus = {
  mode: "idle",
  desired_mode: "idle",
  pid: null,
  running: false,
  healthy: false,
  source_state: "idle",
  frames: 0,
  bytes: 0,
  last_frame_age_s: null,
  last_error: null,
  supervisor_restarts: 0,
  active_profile_id: null,
  active_profile_revision: null,
};

const MODES = new Set<RTKBackendMode>(["idle", "ntrip", "lora"]);
const SOURCE_STATES = new Set<RTKSourceState>([
  "idle",
  "starting",
  "connected",
  "streaming",
  "reconnecting",
  "restarting",
  "unavailable",
  "error",
  "running",
  "stopping",
]);

function mode(value: unknown): RTKBackendMode {
  const normalized = typeof value === "string" ? value.toLowerCase() : "idle";
  return MODES.has(normalized as RTKBackendMode) ? normalized as RTKBackendMode : "idle";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function safeText(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
  return cleaned || null;
}

export function normalizeRtkStatus(raw: unknown): RTKStatus {
  if (!raw || typeof raw !== "object") return EMPTY_RTK_STATUS;
  const data = raw as Record<string, unknown>;
  const rawSourceState = typeof data.source_state === "string"
    ? data.source_state.toLowerCase()
    : "idle";
  const sourceState = SOURCE_STATES.has(rawSourceState as RTKSourceState)
    ? rawSourceState as RTKSourceState
    : "error";
  return {
    mode: mode(data.mode),
    desired_mode: mode(data.desired_mode),
    pid: finiteNumber(data.pid) === null ? null : Math.trunc(finiteNumber(data.pid)!),
    running: data.running === true,
    healthy: data.healthy === true,
    source_state: sourceState,
    frames: nonNegativeInt(data.frames),
    bytes: nonNegativeInt(data.bytes),
    last_frame_age_s: finiteNumber(data.last_frame_age_s),
    last_error: safeText(data.last_error),
    supervisor_restarts: nonNegativeInt(data.supervisor_restarts),
    active_profile_id: safeText(data.active_profile_id, 128),
    active_profile_revision:
      finiteNumber(data.active_profile_revision) === null
        ? null
        : Math.max(0, Math.trunc(finiteNumber(data.active_profile_revision)!)),
  };
}

export function hasLiveCorrections(status: RTKStatus): boolean {
  return Boolean(
    status.mode === "ntrip" &&
    status.running &&
    status.healthy &&
    status.source_state === "streaming" &&
    status.frames > 0 &&
    status.last_frame_age_s !== null &&
    status.last_frame_age_s <= 10
  );
}

export function rtkStatusLabel(status: RTKStatus): string {
  if (status.mode === "lora" && status.running) {
    return status.healthy ? "LoRa corrections active" : "LoRa process running";
  }
  if (hasLiveCorrections(status)) return "NTRIP corrections streaming";
  switch (status.source_state) {
    case "starting": return "NTRIP starting";
    case "connected": return "NTRIP connected · waiting for corrections";
    case "reconnecting": return "NTRIP reconnecting";
    case "restarting": return "NTRIP process restarting";
    case "unavailable": return "NTRIP unavailable";
    case "error": return "NTRIP error";
    case "streaming": return "NTRIP stream stale";
    case "running": return "NTRIP process running";
    case "stopping": return "RTK stopping";
    default:
      return status.desired_mode === "ntrip" ? "NTRIP waiting to start" : "RTK idle";
  }
}

export async function fetchRtkStatus(
  baseUrl: string,
  timeoutMs = RTK_STATUS_TIMEOUT_MS
): Promise<RTKStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.trim().replace(/\/$/, "")}/api/rtk/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RTK status request failed (${response.status}).`);
    return normalizeRtkStatus(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("RTK status request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
