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
  return memoryFallback[KEY_PROD_HOST] || "http://192.168.42.1:8000";
}
