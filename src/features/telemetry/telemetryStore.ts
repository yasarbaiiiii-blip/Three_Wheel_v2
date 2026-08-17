import { useCallback, useRef, useSyncExternalStore } from "react";
import type { TelemetrySnapshot } from "../../types/plan";
import type { SystemHealth } from "../../types/appRuntime";
import {
  mergeSystemHealthFromTelemetry,
  mergeTelemetrySnapshot,
} from "../../utils/telemetryDeadband";

type Listener = () => void;

let telemetrySnapshot: TelemetrySnapshot | null = null;
let systemHealth: SystemHealth | null = null;
const telemetryListeners = new Set<Listener>();
const healthListeners = new Set<Listener>();

function emit(set: Set<Listener>) {
  set.forEach((l) => l());
}

export function getTelemetrySnapshot(): TelemetrySnapshot | null {
  return telemetrySnapshot;
}

export function getSystemHealth(): SystemHealth | null {
  return systemHealth;
}

export function subscribeTelemetry(listener: Listener): () => void {
  telemetryListeners.add(listener);
  return () => {
    telemetryListeners.delete(listener);
  };
}

export function subscribeSystemHealth(listener: Listener): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

export function setTelemetrySnapshot(
  next: TelemetrySnapshot | null | ((prev: TelemetrySnapshot | null) => TelemetrySnapshot | null)
) {
  const value = typeof next === "function" ? next(telemetrySnapshot) : next;
  if (value === telemetrySnapshot) return;
  telemetrySnapshot = value;
  emit(telemetryListeners);
}

export function setSystemHealth(
  next: SystemHealth | null | ((prev: SystemHealth | null) => SystemHealth | null)
) {
  const value = typeof next === "function" ? next(systemHealth) : next;
  if (value === systemHealth) return;
  systemHealth = value;
  emit(healthListeners);
}

/**
 * Apply a live socket/REST telemetry packet with deadband merge.
 * Store + React subscribers update synchronously so a hitch in requestAnimationFrame
 * cannot freeze the HUD/rover marker.
 */
export function applyTelemetryPacket(data: TelemetrySnapshot) {
  const merged = mergeTelemetrySnapshot(telemetrySnapshot, data);
  if (merged !== telemetrySnapshot) {
    telemetrySnapshot = merged;
    emit(telemetryListeners);
  }
  const health = mergeSystemHealthFromTelemetry(systemHealth, data);
  if (health !== systemHealth) {
    systemHealth = health;
    emit(healthListeners);
  }
}

export function patchTelemetryMissionState(state: string) {
  setTelemetrySnapshot((prev) => {
    if (prev && prev.mission_state === state) return prev;
    return prev ? { ...prev, mission_state: state } : ({ mission_state: state } as TelemetrySnapshot);
  });
  setSystemHealth((prev) => {
    if (prev?.mission_state === state) return prev;
    return {
      ros_node: prev?.ros_node ?? true,
      fcu_connected: prev?.fcu_connected ?? false,
      armed: prev?.armed ?? false,
      mode: prev?.mode ?? "UNKNOWN",
      rpp_state: prev?.rpp_state ?? null,
      mission_state: state,
    };
  });
}

export function clearTelemetryRuntime() {
  if (telemetrySnapshot !== null) {
    telemetrySnapshot = null;
    emit(telemetryListeners);
  }
  if (systemHealth !== null) {
    systemHealth = null;
    emit(healthListeners);
  }
}

export function useTelemetrySnapshot(): TelemetrySnapshot | null {
  return useSyncExternalStore(subscribeTelemetry, getTelemetrySnapshot, getTelemetrySnapshot);
}

export function useSystemHealth(): SystemHealth | null {
  return useSyncExternalStore(subscribeSystemHealth, getSystemHealth, getSystemHealth);
}

/** Subscribe only to selected fields; re-render when selected slice changes. */
export function useTelemetrySelector<T>(
  selector: (snap: TelemetrySnapshot | null) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;
  const cacheRef = useRef<T>(selector(telemetrySnapshot));

  const subscribe = useCallback((onStoreChange: () => void) => {
    return subscribeTelemetry(() => {
      const next = selectorRef.current(telemetrySnapshot);
      if (!equalRef.current(cacheRef.current, next)) {
        cacheRef.current = next;
        onStoreChange();
      }
    });
  }, []);

  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(telemetrySnapshot);
    if (!equalRef.current(cacheRef.current, next)) {
      cacheRef.current = next;
    }
    return cacheRef.current;
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
