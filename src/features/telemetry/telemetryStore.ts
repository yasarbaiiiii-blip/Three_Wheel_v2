import { useCallback, useRef, useSyncExternalStore } from "react";
import type { TelemetrySnapshot } from "../../types/plan";
import type { SystemHealth } from "../../types/appRuntime";
import {
  getAdaptedTelemetrySnapshot,
  subscribeProdTelemetry,
} from "./prodTelemetryStore";

type Listener = () => void;

let telemetrySnapshot: TelemetrySnapshot | null = null;
let systemHealth: SystemHealth | null = null;
const telemetryListeners = new Set<Listener>();
const healthListeners = new Set<Listener>();

function emit(set: Set<Listener>) {
  set.forEach((l) => l());
}

/** pose_age_ms ticks every frame; only a half-second change is worth a re-render. */
const POSE_AGE_BUCKET_MS = 500;

/**
 * getAdaptedTelemetrySnapshot() builds a fresh object on every call, and the prod store
 * ticks every 250 ms to age out stale data. Comparing by reference therefore emitted 4x/s
 * even with no new packet, re-rendering App / HomeView / SectionPages (and everything they
 * pass props to) for nothing. Compare by content instead — a value that really went stale
 * is nulled by the adapter, so it still differs and still emits.
 */
export function snapshotsEquivalent(
  a: TelemetrySnapshot | null,
  b: TelemetrySnapshot | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const keys = Object.keys(ar);
  if (keys.length !== Object.keys(br).length) return false;
  for (const k of keys) {
    const av = ar[k];
    const bv = br[k];
    if (k === "pose_age_ms" && typeof av === "number" && typeof bv === "number") {
      if (Math.floor(av / POSE_AGE_BUCKET_MS) !== Math.floor(bv / POSE_AGE_BUCKET_MS)) return false;
      continue;
    }
    if (!Object.is(av, bv)) return false;
  }
  return true;
}

// Single source of truth: continuously sync from ProdTelemetryStore
subscribeProdTelemetry(() => {
  const adapted = getAdaptedTelemetrySnapshot();
  if (!snapshotsEquivalent(adapted, telemetrySnapshot)) {
    telemetrySnapshot = adapted;
    emit(telemetryListeners);
  }
  const nextHealth: SystemHealth | null = adapted
    ? {
        ros_node: true,
        fcu_connected: Boolean(adapted.fcu_connected),
        armed: Boolean(adapted.armed),
        mode: adapted.mode ?? "MANUAL",
        rpp_state: adapted.rpp_state_name ?? null,
        mission_state: adapted.mission_state ?? "idle",
      }
    : null;
  if (JSON.stringify(nextHealth) !== JSON.stringify(systemHealth)) {
    systemHealth = nextHealth;
    emit(healthListeners);
  }
});

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
 * Legacy prototype telemetry ingestion is disabled.
 * The production rover telemetry store is the sole authority.
 */
export function applyTelemetryPacket(_data: TelemetrySnapshot) {
  // Ignored in production: telemetry exclusively sourced from ProdTelemetryStore
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

const noopUnsubscribe = () => {};
const subscribeNothing = () => noopUnsubscribe;

/**
 * Live snapshot. With `enabled=false` the hook stops listening and keeps returning the last
 * value it saw — used by the parked shared map so a hidden map costs no render work.
 */
export function useTelemetrySnapshot(enabled: boolean = true): TelemetrySnapshot | null {
  const frozen = useRef<TelemetrySnapshot | null>(telemetrySnapshot);
  const getSnapshot = useCallback(() => {
    if (enabled) frozen.current = telemetrySnapshot;
    return frozen.current;
  }, [enabled]);
  return useSyncExternalStore(enabled ? subscribeTelemetry : subscribeNothing, getSnapshot, getSnapshot);
}

export function useSystemHealth(): SystemHealth | null {
  return useSyncExternalStore(subscribeSystemHealth, getSystemHealth, getSystemHealth);
}

// ── Throttled snapshot for heavy screens ─────────────────────────────────────
// App / HomeView / SectionPages re-render thousands of lines of JSX plus a map with
// hundreds of props. At packet rate that saturates the JS thread and every tap (nav bar,
// buttons) queues behind it. These screens only need ~4 Hz for numbers; the map marker
// subscribes to the raw store itself (useTelemetrySnapshot) so the rover stays smooth.
// State that the operator acts on (armed, mode, mission, links, staleness) bypasses the
// throttle so it is never late.
const THROTTLE_MS = 250;
const IMMEDIATE_KEYS: ReadonlyArray<string> = [
  "armed",
  "mode",
  "mission_state",
  "connected",
  "gateway_connected",
  "fcu_connected",
  "operator_alive",
  "vehicle_telemetry_health",
  "rpp_state",
  "rpp_blocked_reason",
  "joystick_state",
  "joystick_active",
  "joystick_has_lease",
  "control_owner",
  "gps_fix",
];

let throttledSnapshot: TelemetrySnapshot | null = telemetrySnapshot;
let throttledAt = 0;
let throttledTimer: ReturnType<typeof setTimeout> | null = null;
let rawUnsub: (() => void) | null = null;
const throttledListeners = new Set<Listener>();

function publishThrottled(next: TelemetrySnapshot | null) {
  if (throttledTimer !== null) {
    clearTimeout(throttledTimer);
    throttledTimer = null;
  }
  throttledSnapshot = next;
  throttledAt = Date.now();
  emit(throttledListeners);
}

function immediateFieldChanged(a: TelemetrySnapshot | null, b: TelemetrySnapshot | null): boolean {
  if (!a || !b) return a !== b;
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  return IMMEDIATE_KEYS.some((k) => !Object.is(ar[k], br[k]));
}

function onRawTelemetryChanged() {
  const raw = telemetrySnapshot;
  if (raw === throttledSnapshot) return;
  const elapsed = Date.now() - throttledAt;
  if (immediateFieldChanged(raw, throttledSnapshot) || elapsed >= THROTTLE_MS) {
    publishThrottled(raw);
    return;
  }
  if (throttledTimer === null) {
    // Trailing edge: always land on the latest value, never leave the UI behind.
    throttledTimer = setTimeout(() => {
      throttledTimer = null;
      publishThrottled(telemetrySnapshot);
    }, THROTTLE_MS - elapsed);
  }
}

function subscribeThrottledTelemetry(listener: Listener): () => void {
  throttledListeners.add(listener);
  if (rawUnsub === null) {
    throttledSnapshot = telemetrySnapshot;
    throttledAt = Date.now();
    rawUnsub = subscribeTelemetry(onRawTelemetryChanged);
  }
  return () => {
    throttledListeners.delete(listener);
    if (throttledListeners.size === 0) {
      rawUnsub?.();
      rawUnsub = null;
      if (throttledTimer !== null) {
        clearTimeout(throttledTimer);
        throttledTimer = null;
      }
    }
  };
}

function getThrottledTelemetrySnapshot(): TelemetrySnapshot | null {
  // Before the first subscriber the cache is stale; read-through keeps first render correct.
  return rawUnsub === null ? telemetrySnapshot : throttledSnapshot;
}

/** Same data as useTelemetrySnapshot, but re-renders at most ~4 Hz (immediately on state changes). */
export function useThrottledTelemetrySnapshot(): TelemetrySnapshot | null {
  return useSyncExternalStore(
    subscribeThrottledTelemetry,
    getThrottledTelemetrySnapshot,
    getThrottledTelemetrySnapshot
  );
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
