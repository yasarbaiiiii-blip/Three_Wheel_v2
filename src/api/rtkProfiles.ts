import type {
  NtripProfile,
  NtripProfileCreateInput,
  NtripProfileRegistry,
  NtripProfileUpdateInput,
} from "../types/appRuntime";

export const NTRIP_PROFILE_TIMEOUT_MS = 15000;

export class NtripProfileConflictError extends Error {
  constructor(message = "NTRIP profiles changed on another tablet. The latest profiles have been reloaded.") {
    super(message);
    this.name = "NtripProfileConflictError";
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/$/, "")}${path}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Uses the application's installed authenticated fetch. authApi attaches
    // X-Rover-Token only when this URL matches the active rover backend.
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Rover did not respond in time. Check Wi-Fi and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.message === "string") return body.message;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((item) => (typeof item === "string" ? item : (item as { msg?: unknown })?.msg))
        .filter((item): item is string => typeof item === "string")
        .join("; ");
    }
  } catch {
    // Preserve a non-JSON backend error below.
  }
  return text.trim() || `HTTP ${response.status}`;
}

function finiteInt(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function sanitizeMigrationWarning(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
  return cleaned || null;
}

/**
 * Treat every backend response as untrusted. This allow-list intentionally
 * drops password/pass/secret fields even if a backend regression returns one.
 */
export function normalizeNtripProfile(raw: unknown): NtripProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string") return null;
  return {
    id: item.id,
    revision: finiteInt(item.revision),
    name: item.name,
    host: typeof item.host === "string" ? item.host : "",
    port: finiteInt(item.port, 2101),
    mountpoint: typeof item.mountpoint === "string" ? item.mountpoint : "",
    username: typeof item.username === "string" ? item.username : "",
    password_configured: item.password_configured === true,
    is_default: item.is_default === true,
    is_active: item.is_active === true,
    pending_apply: item.pending_apply === true,
    created_at: typeof item.created_at === "string" ? item.created_at : null,
    updated_at: typeof item.updated_at === "string" ? item.updated_at : null,
  };
}

export function normalizeNtripRegistry(raw: unknown): NtripProfileRegistry {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const profiles = Array.isArray(body.profiles)
    ? body.profiles.map(normalizeNtripProfile).filter((item): item is NtripProfile => item !== null)
    : [];
  const defaultId = typeof body.default_profile_id === "string"
    ? body.default_profile_id
    : profiles.find((profile) => profile.is_default)?.id ?? null;
  const activeId = typeof body.active_profile_id === "string"
    ? body.active_profile_id
    : profiles.find((profile) => profile.is_active)?.id ?? null;
  return {
    schema_version: finiteInt(body.schema_version, 1),
    registry_revision: finiteInt(body.registry_revision),
    default_profile_id: defaultId,
    active_profile_id: activeId,
    migration_warning: sanitizeMigrationWarning(body.migration_warning),
    profiles: profiles.map((profile) => ({
      ...profile,
      is_default: profile.is_default || profile.id === defaultId,
      is_active: profile.is_active || profile.id === activeId,
      pending_apply:
        profile.pending_apply || (profile.id === defaultId && defaultId !== null && defaultId !== activeId),
    })),
  };
}

function mutationHeaders(registryRevision: number | null): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (registryRevision !== null) headers["If-Match"] = `"${registryRevision}"`;
  return headers;
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  const message = await readApiError(response);
  if (response.status === 409 || response.status === 412) {
    throw new NtripProfileConflictError(message || undefined);
  }
  throw new Error(message);
}

export async function listNtripProfiles(
  baseUrl: string,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<NtripProfileRegistry> {
  const response = await fetchWithTimeout(
    apiUrl(baseUrl, "/api/rtk/profiles"),
    { method: "GET", headers: { Accept: "application/json" } },
    timeoutMs
  );
  await requireOk(response);
  return normalizeNtripRegistry(await response.json());
}

export function createNtripProfile(
  baseUrl: string,
  input: NtripProfileCreateInput,
  registryRevision: number | null,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<void> {
  return fetchWithTimeout(
    apiUrl(baseUrl, "/api/rtk/profiles"),
    {
      method: "POST",
      headers: mutationHeaders(registryRevision),
      body: JSON.stringify(input),
    },
    timeoutMs
  ).then(requireOk);
}

export function buildNtripProfileUpdate(input: NtripProfileUpdateInput): NtripProfileUpdateInput {
  const payload: NtripProfileUpdateInput = {};
  if (input.name !== undefined) payload.name = input.name;
  if (input.host !== undefined) payload.host = input.host;
  if (input.port !== undefined) payload.port = input.port;
  if (input.mountpoint !== undefined) payload.mountpoint = input.mountpoint;
  if (input.username !== undefined) payload.username = input.username;
  if (typeof input.password === "string" && input.password.length > 0) {
    payload.password = input.password;
  }
  return payload;
}

export function updateNtripProfile(
  baseUrl: string,
  profileId: string,
  input: NtripProfileUpdateInput,
  registryRevision: number,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<void> {
  const payload = buildNtripProfileUpdate(input);
  return fetchWithTimeout(
    apiUrl(baseUrl, `/api/rtk/profiles/${encodeURIComponent(profileId)}`),
    {
      method: "PATCH",
      headers: mutationHeaders(registryRevision),
      body: JSON.stringify(payload),
    },
    timeoutMs
  ).then(requireOk);
}

export function deleteNtripProfile(
  baseUrl: string,
  profileId: string,
  registryRevision: number,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<void> {
  return fetchWithTimeout(
    apiUrl(baseUrl, `/api/rtk/profiles/${encodeURIComponent(profileId)}`),
    {
      method: "DELETE",
      headers: mutationHeaders(registryRevision),
    },
    timeoutMs
  ).then(requireOk);
}

export function setDefaultNtripProfile(
  baseUrl: string,
  profileId: string,
  registryRevision: number,
  timeoutMs = NTRIP_PROFILE_TIMEOUT_MS
): Promise<void> {
  return fetchWithTimeout(
    apiUrl(baseUrl, `/api/rtk/profiles/${encodeURIComponent(profileId)}/default`),
    {
      method: "PUT",
      headers: mutationHeaders(registryRevision),
      body: JSON.stringify({}),
    },
    timeoutMs
  ).then(requireOk);
}
