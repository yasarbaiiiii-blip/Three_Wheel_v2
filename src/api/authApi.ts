import { Platform } from "react-native";

const STORAGE_KEY = "rover.operatorSession.v1";
const TOKEN_HEADER = "X-Rover-Token";
const LOGIN_TIMEOUT_MS = 15000;

export type OperatorSession = {
  token: string;
  session_id: string;
  expires_at: string;
  ttl_s: number;
  /** Backend this session was issued for (tokens are in-memory on the server). */
  baseUrl: string;
};

let sessionToken: string | null = null;
let activeBaseUrl: string | null = null;
let invalidSessionHandler: (() => void) | null = null;
let originalFetch: typeof fetch | null = null;

export function normalizeBase(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim().replace(/\/$/, "");
  return trimmed || null;
}

async function secureStore() {
  if (Platform.OS === "web") return null;
  try {
    return await import("expo-secure-store");
  } catch {
    return null;
  }
}

export function setAuthRuntime(args: {
  token: string | null;
  baseUrl: string | null;
  onInvalidSession?: () => void;
}) {
  sessionToken = args.token;
  activeBaseUrl = normalizeBase(args.baseUrl);
  invalidSessionHandler = args.onInvalidSession ?? invalidSessionHandler;
}

export function isSessionExpired(session: OperatorSession | null | undefined): boolean {
  if (!session?.expires_at) return true;
  return Date.parse(session.expires_at) <= Date.now();
}

export function sessionMatchesHost(
  session: OperatorSession | null | undefined,
  baseUrl: string | null | undefined
): boolean {
  const target = normalizeBase(baseUrl);
  const sessionHost = normalizeBase(session?.baseUrl);
  return Boolean(target && sessionHost && target === sessionHost);
}

/** True when a stored session can be reused for Socket.IO (same host, not expired). */
export function canReuseSession(
  session: OperatorSession | null | undefined,
  baseUrl: string | null | undefined
): boolean {
  return Boolean(session?.token && !isSessionExpired(session) && sessionMatchesHost(session, baseUrl));
}

export async function saveStoredSession(session: OperatorSession | null) {
  if (!session) {
    const store = await secureStore();
    if (store?.deleteItemAsync) await store.deleteItemAsync(STORAGE_KEY);
    else if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
    return;
  }
  const value = JSON.stringify(session);
  const store = await secureStore();
  if (store?.setItemAsync) await store.setItemAsync(STORAGE_KEY, value);
  else if (typeof sessionStorage !== "undefined") sessionStorage.setItem(STORAGE_KEY, value);
}

export async function loadStoredSession(): Promise<OperatorSession | null> {
  const store = await secureStore();
  const raw = store?.getItemAsync
    ? await store.getItemAsync(STORAGE_KEY)
    : typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(STORAGE_KEY)
      : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OperatorSession;
    if (!parsed.token || !parsed.expires_at) return null;
    if (isSessionExpired(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function shouldAttachToken(input: RequestInfo | URL): boolean {
  if (!sessionToken || !activeBaseUrl) return false;
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!raw.startsWith(activeBaseUrl)) return false;
  return !raw.includes("/api/auth/login");
}

function withAuthHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set(TOKEN_HEADER, token);
  return { ...init, headers };
}

export function installAuthenticatedFetch() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const nextInit = shouldAttachToken(input) && sessionToken
      ? withAuthHeader(init, sessionToken)
      : init;
    const response = await originalFetch!(input, nextInit);
    if (response.status === 401 && shouldAttachToken(input)) {
      invalidSessionHandler?.();
    }
    return response;
  }) as typeof fetch;
}

function withSessionHost(session: OperatorSession, baseUrl: string): OperatorSession {
  return { ...session, baseUrl: normalizeBase(baseUrl) ?? baseUrl };
}

export async function login(
  baseUrl: string,
  password: string,
  timeoutMs = LOGIN_TIMEOUT_MS
): Promise<OperatorSession> {
  const normalized = normalizeBase(baseUrl);
  if (!normalized) {
    throw new Error("Enter a valid backend address.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalized}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(response.status === 503 ? "Rover password is not configured." : "Invalid rover password.");
    }
    const body = (await response.json()) as Omit<OperatorSession, "baseUrl">;
    return withSessionHost(body, normalized);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Login timed out. Check Wi-Fi and rover backend.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function logout(baseUrl: string) {
  await fetch(`${normalizeBase(baseUrl)}/api/auth/logout`, { method: "POST" }).catch(() => {});
}

export async function changePassword(
  baseUrl: string,
  currentPassword: string,
  newPassword: string
): Promise<OperatorSession> {
  const normalized = normalizeBase(baseUrl);
  if (!normalized) {
    throw new Error("Backend address is not set.");
  }
  const response = await fetch(`${normalized}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Password change failed (${response.status})`);
  }
  const body = (await response.json()) as Omit<OperatorSession, "baseUrl">;
  return withSessionHost(body, normalized);
}
