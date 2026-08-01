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
  /**
   * The rover is still on its documented bootstrap password and refuses to
   * operate until it is rotated. Login SUCCEEDS in this state — the token is
   * real and works for change-password — but every other endpoint returns 403
   * and the Socket.IO handshake is refused, so there is no telemetry either.
   *
   * A successful login is the ONLY way to learn this: there is deliberately no
   * unauthenticated endpoint that reports it, since that would tell an attacker
   * exactly which rovers are still on a known password.
   */
  must_change_password: boolean;
};

/** Backend's 403 discriminator while the bootstrap password is in force. */
export const PASSWORD_CHANGE_REQUIRED = "password_change_required";

let sessionToken: string | null = null;
let activeBaseUrl: string | null = null;
let invalidSessionHandler: (() => void) | null = null;
let passwordChangeRequiredHandler: (() => void) | null = null;
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
  onPasswordChangeRequired?: () => void;
}) {
  sessionToken = args.token;
  activeBaseUrl = normalizeBase(args.baseUrl);
  invalidSessionHandler = args.onInvalidSession ?? invalidSessionHandler;
  passwordChangeRequiredHandler =
    args.onPasswordChangeRequired ?? passwordChangeRequiredHandler;
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

/**
 * Is this 403 the bootstrap-password lockout, or an ordinary authorisation
 * failure? Reads a CLONE — the caller still needs to consume the real body.
 * Any parse failure means "not the lockout": never escalate an unrelated 403
 * into a forced password change.
 */
async function isPasswordChangeRequired(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail === PASSWORD_CHANGE_REQUIRED;
    return detail?.code === PASSWORD_CHANGE_REQUIRED;
  } catch {
    return false;
  }
}

export function installAuthenticatedFetch() {
  if (originalFetch) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const nextInit = shouldAttachToken(input) && sessionToken
      ? withAuthHeader(init, sessionToken)
      : init;
    const response = await originalFetch!(input, nextInit);
    if (shouldAttachToken(input)) {
      if (response.status === 401) {
        invalidSessionHandler?.();
      } else if (response.status === 403 && (await isPasswordChangeRequired(response))) {
        // Every endpoint answers 403 until the default password is rotated, so
        // without this the app renders errors on every screen with no route out.
        // Reached when the flag is missed at login — e.g. a session restored
        // from storage that predates the rover being reset to its default.
        passwordChangeRequiredHandler?.();
      }
    }
    return response;
  }) as typeof fetch;
}

function withSessionHost(
  session: Partial<OperatorSession> & { token: string },
  baseUrl: string
): OperatorSession {
  return {
    ...session,
    baseUrl: normalizeBase(baseUrl) ?? baseUrl,
    // Normalised here, not trusted from the wire. /api/auth/change-password
    // does not return the field at all (the rotation it just performed is what
    // clears the condition), and a session stored before this field existed
    // will not carry it either. Absent must read as "not blocked", or a
    // successful rotation would leave the app stuck on the mandatory screen.
    must_change_password: session.must_change_password === true,
  } as OperatorSession;
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
    const body = (await response.json()) as Partial<OperatorSession> & { token: string };
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
  const body = (await response.json()) as Partial<OperatorSession> & { token: string };
  return withSessionHost(body, normalized);
}
