/**
 * Pure helpers that turn gateway snapshot entries into display values.
 *
 * Rule from docs/contracts/dyx3_system_gateway.md: a stale or missing source is
 * UNKNOWN, never the last value. Every helper here returns null for unknown so
 * the UI shows "—" instead of a frozen or fake number.
 */

import type { SnapshotEntry } from "../../contract/prod/realtime";

export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Accuracy-style values where 0 (or negative) is a "not known" sentinel, not a real reading. */
export function positiveOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/** The entry's data when the gateway marks it fresh; otherwise null. A missing `fresh` flag counts as fresh. */
export function usableData<T>(entry: SnapshotEntry<T> | null | undefined): T | null {
  if (!entry || entry.data == null) return null;
  if (entry.fresh === false) return null;
  return entry.data;
}

/**
 * Age of an entry as it is now, in ms: the age the gateway reported when it built the
 * packet plus the time the packet has been sitting in the app.
 */
export function entryAgeMs(
  entry: SnapshotEntry<unknown> | null | undefined,
  packetAgeMs: number
): number | null {
  if (!entry) return null;
  const gatewayAgeS = finiteOrNull(entry.age_s);
  if (gatewayAgeS === null || gatewayAgeS < 0) return null;
  if (!Number.isFinite(packetAgeMs) || packetAgeMs < 0) return null;
  return Math.round(gatewayAgeS * 1000 + packetAgeMs);
}

export type FixSeverity = "ok" | "warn" | "bad";

/** RTK FIXED is ok; RTK FLOAT and DGPS are a warning; everything else (including 3D) is bad. */
export function gpsFixSeverity(name: string | null | undefined): FixSeverity {
  const n = (name ?? "").toLowerCase();
  if (n.includes("float") || n.includes("dgps") || n.includes("diff")) return "warn";
  if (n.includes("fixed")) return "ok";
  return "bad";
}

/** RppStatus.tick_state (dyx3_interfaces). Only the blocking states are named. */
const TICK_BLOCKED: Record<number, string> = {
  [-1]: "STALE",
  4: "RTK WAIT",
  5: "JUMP SKIP",
};

/** RppStatus.rtk_reason. 0 is ok. */
const RTK_REASON: Record<number, string> = {
  1: "RTK unavailable",
  2: "RTK stale",
  3: "fix below minimum",
  4: "not a rover fix",
  5: "accuracy unknown",
  6: "accuracy too large",
  7: "RTK recovering",
};

/**
 * Why RPP is not driving, or null when nothing is blocking (or the gateway does not send the fields yet).
 * Example: "RTK WAIT · accuracy too large".
 */
export function rppBlockedReason(
  tickState: number | null | undefined,
  rtkReason: number | null | undefined
): string | null {
  const tick = finiteOrNull(tickState);
  const reason = finiteOrNull(rtkReason);
  const tickText = tick !== null ? TICK_BLOCKED[tick] ?? null : null;
  const reasonText = reason !== null && reason !== 0 ? RTK_REASON[reason] ?? `RTK reason ${reason}` : null;
  if (tickText && reasonText) return `${tickText} · ${reasonText}`;
  return tickText ?? reasonText;
}

/** Battery percent for the UI. Null when the backend does not report it; never a fake 0. */
export function batteryPercentOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}
