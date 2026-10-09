/**
 * Secure token and connection settings storage.
 * Uses expo-secure-store on native; falls back to localStorage/memory for web/test.
 */

import { Platform } from "react-native";

const KEY_PROD_TOKEN = "rover.prod.bearerToken.v1";
const KEY_PROD_HOST = "rover.prod.hostUrl.v1";

let memoryFallback: Record<string, string> = {};

async function getSecureStore() {
  if (Platform.OS === "web") return null;
  try {
    return await import("expo-secure-store");
  } catch {
    return null;
  }
}

export async function saveProdToken(token: string | null): Promise<void> {
  const store = await getSecureStore();
  if (token) {
    if (store?.setItemAsync) {
      await store.setItemAsync(KEY_PROD_TOKEN, token.trim());
    } else if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY_PROD_TOKEN, token.trim());
    } else {
      memoryFallback[KEY_PROD_TOKEN] = token.trim();
    }
  } else {
    if (store?.deleteItemAsync) {
      await store.deleteItemAsync(KEY_PROD_TOKEN);
    } else if (typeof localStorage !== "undefined") {
      localStorage.removeItem(KEY_PROD_TOKEN);
    } else {
      delete memoryFallback[KEY_PROD_TOKEN];
    }
  }
}

export async function loadProdToken(): Promise<string | null> {
  const store = await getSecureStore();
  if (store?.getItemAsync) {
    const val = await store.getItemAsync(KEY_PROD_TOKEN);
    return val?.trim() || null;
  } else if (typeof localStorage !== "undefined") {
    const val = localStorage.getItem(KEY_PROD_TOKEN);
    return val?.trim() || null;
  }
  return memoryFallback[KEY_PROD_TOKEN] || null;
}

export async function saveProdHost(host: string): Promise<void> {
  const store = await getSecureStore();
  const val = host.trim();
  if (store?.setItemAsync) {
    await store.setItemAsync(KEY_PROD_HOST, val);
  } else if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY_PROD_HOST, val);
  } else {
    memoryFallback[KEY_PROD_HOST] = val;
  }
}

export async function loadProdHost(): Promise<string> {
  const store = await getSecureStore();
  if (store?.getItemAsync) {
    const val = await store.getItemAsync(KEY_PROD_HOST);
    if (val?.trim()) return val.trim();
  } else if (typeof localStorage !== "undefined") {
    const val = localStorage.getItem(KEY_PROD_HOST);
    if (val?.trim()) return val.trim();
  }
  // No fixed default: the rover is found by its beacon, or typed by the operator.
  return memoryFallback[KEY_PROD_HOST] || "";
}

/*
 * Per-rover tokens. Each rover issues its own operator token, so the app keeps one token per rover
 * address (e.g. http://192.168.3.100:8000) and the operator only selects a rover and connects.
 * A saved token stays until the operator forgets it or clears app data; disconnecting keeps it.
 */
const KEY_PROD_TOKENS = "rover.prod.bearerTokens.v1";

/** Map key for a rover address: scheme://host:port, lowercase, no trailing slash. */
export function roverTokenKey(host: string): string {
  return host.trim().replace(/\/+$/, "").toLowerCase();
}

async function readRaw(key: string): Promise<string | null> {
  const store = await getSecureStore();
  if (store?.getItemAsync) return (await store.getItemAsync(key)) ?? null;
  if (typeof localStorage !== "undefined") return localStorage.getItem(key);
  return memoryFallback[key] ?? null;
}

async function writeRaw(key: string, value: string | null): Promise<void> {
  const store = await getSecureStore();
  if (value === null) {
    if (store?.deleteItemAsync) await store.deleteItemAsync(key);
    else if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    else delete memoryFallback[key];
  } else if (store?.setItemAsync) {
    await store.setItemAsync(key, value);
  } else if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  } else {
    memoryFallback[key] = value;
  }
}

async function readTokenMap(): Promise<Record<string, string>> {
  const raw = await readRaw(KEY_PROD_TOKENS);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function writeTokenMap(map: Record<string, string>): Promise<void> {
  await writeRaw(KEY_PROD_TOKENS, Object.keys(map).length ? JSON.stringify(map) : null);
}

/** Saved token for this rover. Migrates the older single saved token when it belonged to this rover. */
export async function loadProdTokenFor(host: string): Promise<string | null> {
  const key = roverTokenKey(host);
  const map = await readTokenMap();
  if (map[key]) return map[key];
  const legacyToken = await loadProdToken();
  if (legacyToken && roverTokenKey(await loadProdHost()) === key) {
    map[key] = legacyToken;
    await writeTokenMap(map);
    await saveProdToken(null);
    return legacyToken;
  }
  return null;
}

/** Saves (token) or forgets (null) the token for this rover only. */
export async function saveProdTokenFor(host: string, token: string | null): Promise<void> {
  const key = roverTokenKey(host);
  const map = await readTokenMap();
  const value = token?.trim();
  if (value) map[key] = value;
  else delete map[key];
  await writeTokenMap(map);
}

/*
 * Tokens keyed by rover identity (rover_id from /api/ping and the discovery beacon). One rover can be
 * reached at several addresses (site router, Jetson hotspot); keying by rover_id lets one saved token
 * work on all of them. Host-keyed entries remain as a fallback and migrate on first use.
 */
const KEY_LAST_ROVER_ID = "rover.prod.lastRoverId.v1";

function roverIdKey(roverId: string): string {
  return `rover:${roverId.trim()}`;
}

export async function loadProdTokenForRover(roverId: string, host?: string): Promise<string | null> {
  const map = await readTokenMap();
  const key = roverIdKey(roverId);
  if (map[key]) return map[key];
  if (host) {
    const byHost = await loadProdTokenFor(host);
    if (byHost) {
      const fresh = await readTokenMap();
      fresh[key] = byHost;
      await writeTokenMap(fresh);
      return byHost;
    }
  }
  return null;
}

export async function saveProdTokenForRover(roverId: string, token: string | null): Promise<void> {
  const map = await readTokenMap();
  const key = roverIdKey(roverId);
  const value = token?.trim();
  if (value) map[key] = value;
  else delete map[key];
  await writeTokenMap(map);
}

export async function saveLastRoverId(roverId: string | null): Promise<void> {
  await writeRaw(KEY_LAST_ROVER_ID, roverId?.trim() || null);
}

export async function loadLastRoverId(): Promise<string | null> {
  return (await readRaw(KEY_LAST_ROVER_ID))?.trim() || null;
}
