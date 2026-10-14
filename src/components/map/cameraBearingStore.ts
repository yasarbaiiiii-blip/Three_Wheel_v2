import { useSyncExternalStore } from "react";

export type CameraBearingStore = {
  getSnapshot: () => number;
  set: (bearing: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function bearingDeltaDegrees(a: number, b: number): number {
  const delta = Math.abs(normalizeBearing(a) - normalizeBearing(b));
  return Math.min(delta, 360 - delta);
}

/** One instance per native map; two mounted maps must never share camera state. */
export function createCameraBearingStore(thresholdDeg = 1): CameraBearingStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    set(next) {
      if (!Number.isFinite(next)) return;
      const normalized = normalizeBearing(next);
      if (bearingDeltaDegrees(value, normalized) < thresholdDeg) return;
      value = normalized;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useCameraBearing(store: CameraBearingStore): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
