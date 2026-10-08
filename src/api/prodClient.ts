/**
 * Single Production REST API Client (DYX_3WD contract)
 *
 * Rules:
 * 1. Default port 8000.
 * 2. Auth: Authorization: Bearer <token>.
 * 3. Timeout on every request via AbortController.
 * 4. NEVER retry state-mutating requests (POST, PUT, DELETE, PATCH).
 */

import { Platform } from "react-native";
import type {
  PingResponse,
  HealthResponse,
  HeartbeatResponse,
  GatewayVerdictResponse,
  MissionsListResponse,
  MissionDetailResponse,
  MissionPathResponse,
  TelemetryRestResponse,
  RunsListResponse,
  RtkStatusReport,
} from "../contract/prod/rest";
import type {
  AppPlannedMissionRequest,
  AppPlannedMissionResponse,
} from "../contract/prod/missionPlan";

export const DEFAULT_PROD_PORT = 8000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const HEARTBEAT_REQUEST_TIMEOUT_MS = 1200;

export interface ProdClientConfig {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
}

export class ProdApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
  readonly delivered: boolean;
  readonly data?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code = "HTTP_ERROR",
    reason = "",
    delivered = false,
    data?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProdApiError";
    this.status = status;
    this.code = code;
    this.reason = reason || message;
    this.delivered = delivered;
    this.data = data;
  }
}

/** Normalizes a base URL to ensure scheme and default port 8000 if not specified. */
export function normalizeProdBaseUrl(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return "http://192.168.42.1:8000";

  // Add http:// if missing
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }

  // Remove trailing slashes
  trimmed = trimmed.replace(/\/+$/, "");

  // Add port 8000 if no port is specified in host
  try {
    // If running in environment without URL class, fallback to regex
    if (typeof URL !== "undefined") {
      const u = new URL(trimmed);
      if (!u.port) {
        u.port = String(DEFAULT_PROD_PORT);
        return u.toString().replace(/\/+$/, "");
      }
      return trimmed;
    }
  } catch {
    // fallback regex check
  }

  // Regex check: if ends with :port, keep it, otherwise append :8000
  const match = trimmed.match(/^(https?:\/\/[^/:]+)(:\d+)?(\/.*)?$/);
  if (match && !match[2]) {
    return `${match[1]}:${DEFAULT_PROD_PORT}${match[3] || ""}`;
  }

  return trimmed;
}

export class ProdApiClient {
  private baseUrl: string;
  private token: string | null;
  private defaultTimeoutMs: number;

  constructor(config: ProdClientConfig) {
    this.baseUrl = normalizeProdBaseUrl(config.baseUrl);
    this.token = config.token?.trim() || null;
    this.defaultTimeoutMs = config.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  }

  setBaseUrl(url: string) {
    this.baseUrl = normalizeProdBaseUrl(url);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | null) {
    this.token = token?.trim() || null;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      timeoutMs?: number;
      noAuth?: boolean;
    } = {}
  ): Promise<T> {
    const { method = "GET", body, timeoutMs = this.defaultTimeoutMs, noAuth = false } = options;
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (!noAuth && this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const payload = isJson ? await response.json().catch(() => ({})) : await response.text();

      if (!response.ok) {
        const status = response.status;
        const code = (typeof payload === "object" && payload?.code) ? String(payload.code) : `HTTP_${status}`;
        const reason = (typeof payload === "object" && payload?.reason) ? String(payload.reason) : (typeof payload === "string" ? payload : response.statusText);
        const delivered = (typeof payload === "object" && typeof payload?.delivered === "boolean") ? payload.delivered : false;
        const data = (typeof payload === "object" && payload?.data) ? payload.data : undefined;

        throw new ProdApiError(
          reason || `Request failed with status ${status}`,
          status,
          code,
          reason,
          delivered,
          data
        );
      }

      return payload as T;
    } catch (err: unknown) {
      if (err instanceof ProdApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProdApiError(
          `Request to ${path} timed out after ${timeoutMs}ms`,
          408,
          "TIMEOUT",
          "Request timed out",
          false
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProdApiError(msg, 0, "NETWORK_ERROR", msg, false);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Endpoints ----

  /** GET /api/ping (unauthenticated) */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>("/api/ping", { noAuth: true });
  }

  /** GET /api/health */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/api/health");
  }

  /** POST /api/heartbeat */
  async heartbeat(options?: { timeoutMs?: number }): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("/api/heartbeat", {
      method: "POST",
      timeoutMs: options?.timeoutMs ?? HEARTBEAT_REQUEST_TIMEOUT_MS,
    });
  }

  /** POST /api/estop */
  async estop(asserted: boolean): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/estop", {
      method: "POST",
      body: { asserted },
    });
  }

  /** POST /api/vehicle/arm */
  async arm(arm: boolean): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/vehicle/arm", {
      method: "POST",
      body: { arm },
    });
  }

  /** POST /api/vehicle/offboard */
  async setOffboard(enable: boolean): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/vehicle/offboard", {
      method: "POST",
      body: { enable },
    });
  }

  /** POST /api/mission/abort */
  async abortMission(reason = "operator"): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/mission/abort", {
      method: "POST",
      body: { reason },
    });
  }

  /** POST /api/mission/pause */
  async pauseMission(): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/mission/pause", {
      method: "POST",
    });
  }

  /** POST /api/mission/resume */
  async resumeMission(): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/mission/resume", {
      method: "POST",
    });
  }

  /** POST /api/mission/skip_point */
  async skipPoint(): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>("/api/mission/skip_point", {
      method: "POST",
    });
  }

  /** GET /api/missions */
  async listMissions(): Promise<MissionsListResponse> {
    return this.request<MissionsListResponse>("/api/missions");
  }

  /** GET /api/missions/{sha} */
  async getMission(sha: string): Promise<MissionDetailResponse> {
    return this.request<MissionDetailResponse>(`/api/missions/${encodeURIComponent(sha)}`);
  }

  /** GET /api/missions/{sha}/path */
  async getMissionPath(sha: string): Promise<MissionPathResponse> {
    return this.request<MissionPathResponse>(`/api/missions/${encodeURIComponent(sha)}/path`);
  }

  /** POST /api/missions/{sha}/start */
  async startMission(sha: string): Promise<GatewayVerdictResponse> {
    return this.request<GatewayVerdictResponse>(`/api/missions/${encodeURIComponent(sha)}/start`, {
      method: "POST",
    });
  }

  /** POST /api/missions/plan (GAP-04 App-Planned Mission) */
  async uploadAppPlannedMission(plan: AppPlannedMissionRequest): Promise<AppPlannedMissionResponse> {
    return this.request<AppPlannedMissionResponse>("/api/missions/plan", {
      method: "POST",
      body: plan,
    });
  }

  /** GET /api/rtk/status */
  async getRtkStatus(): Promise<RtkStatusReport> {
    return this.request<RtkStatusReport>("/api/rtk/status");
  }

  /** GET /api/telemetry */
  async getTelemetry(): Promise<TelemetryRestResponse> {
    return this.request<TelemetryRestResponse>("/api/telemetry");
  }

  /** GET /api/runs */
  async listRuns(): Promise<RunsListResponse> {
    return this.request<RunsListResponse>("/api/runs");
  }
}

// Global singleton instance for app-wide sharing
let globalProdClient: ProdApiClient | null = null;

export function getProdApiClient(): ProdApiClient {
  if (!globalProdClient) {
    globalProdClient = new ProdApiClient({ baseUrl: "http://192.168.42.1:8000" });
  }
  return globalProdClient;
}

export function initProdApiClient(baseUrl: string, token?: string | null): ProdApiClient {
  globalProdClient = new ProdApiClient({ baseUrl, token });
  return globalProdClient;
}
