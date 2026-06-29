import { Platform } from "react-native";

const STORAGE_KEY = "rover.operatorSession.v1";
const TOKEN_HEADER = "X-Rover-Token";

export type OperatorSession = {
  token: string;
  session_id: string;
  expires_at: string;
  ttl_s: number;
};

let sessionToken: string | null = null;
let activeBaseUrl: string | null = null;
let invalidSessionHandler: (() => void) | null = null;
let originalFetch: typeof fetch | null = null;

function normalizeBase(url: string | null | undefined): string | null {
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
    if (Date.parse(parsed.expires_at) <= Date.now()) return null;
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

export async function login(baseUrl: string, password: string): Promise<OperatorSession> {
  const response = await fetch(`${normalizeBase(baseUrl)}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(response.status === 503 ? "Rover password is not configured." : "Invalid rover password.");
  }
  return (await response.json()) as OperatorSession;
}

export async function logout(baseUrl: string) {
  await fetch(`${normalizeBase(baseUrl)}/api/auth/logout`, { method: "POST" }).catch(() => {});
}

export async function changePassword(
  baseUrl: string,
  currentPassword: string,
  newPassword: string
): Promise<OperatorSession> {
  const response = await fetch(`${normalizeBase(baseUrl)}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Password change failed (${response.status})`);
  }
  return (await response.json()) as OperatorSession;
}
