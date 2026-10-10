/**
 * Operator preference: one shared native map (default) or a map per screen (legacy).
 *
 * Kept switchable at runtime because a shared map layers page UI over a single native
 * surface, and Android GPUs differ — if a device ever shows a blank map, turning this off in
 * Settings restores the per-screen maps without a rebuild.
 */
import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "shared_map_enabled";

let enabled = true;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Load the saved choice once. Safe to call repeatedly; failures keep the default (on). */
export async function loadMapPrefs(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (raw === "0" && enabled) {
      enabled = false;
      emit();
    }
  } catch {
    // Keep the default.
  }
}

export function setSharedMapEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  emit();
  SecureStore.setItemAsync(KEY, next ? "1" : "0").catch(() => {});
}

export function isSharedMapEnabled(): boolean {
  return enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharedMapEnabled(): boolean {
  return useSyncExternalStore(subscribe, isSharedMapEnabled, isSharedMapEnabled);
}
