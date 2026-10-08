/**
 * Staleness Evaluation Model for Production Telemetry
 *
 * Rules:
 * - Age <= 1.0 s (1000 ms)  => LIVE
 * - 1.0 s < Age <= 2.5 s (2500 ms) => STALE
 * - Age > 2.5 s or missing  => DISCONNECTED
 *
 * A stale or disconnected value is never shown as live.
 */

export type StalenessGrade = "LIVE" | "STALE" | "DISCONNECTED";

export const STALE_THRESHOLD_MS = 1000;
export const DISCONNECTED_THRESHOLD_MS = 2500;

export interface StalenessInfo {
  grade: StalenessGrade;
  ageMs: number;
  ageSec: number;
  formattedAge: string;
  isLive: boolean;
  isStale: boolean;
  isDisconnected: boolean;
}

export function evaluateStaleness(
  receivedAtEpochMs: number | null | undefined,
  nowEpochMs: number = Date.now()
): StalenessInfo {
  if (receivedAtEpochMs == null || !Number.isFinite(receivedAtEpochMs) || receivedAtEpochMs <= 0) {
    return {
      grade: "DISCONNECTED",
      ageMs: Infinity,
      ageSec: Infinity,
      formattedAge: "DISCONNECTED",
      isLive: false,
      isStale: false,
      isDisconnected: true,
    };
  }

  const ageMs = Math.max(0, nowEpochMs - receivedAtEpochMs);
  const ageSec = ageMs / 1000;

  let grade: StalenessGrade;
  if (ageMs <= STALE_THRESHOLD_MS) {
    grade = "LIVE";
  } else if (ageMs <= DISCONNECTED_THRESHOLD_MS) {
    grade = "STALE";
  } else {
    grade = "DISCONNECTED";
  }

  const formattedAge = grade === "DISCONNECTED"
    ? `DISCONNECTED (${ageSec.toFixed(1)}s)`
    : grade === "STALE"
      ? `STALE (${ageSec.toFixed(1)}s)`
      : `${ageSec.toFixed(1)}s`;

  return {
    grade,
    ageMs,
    ageSec,
    formattedAge,
    isLive: grade === "LIVE",
    isStale: grade === "STALE",
    isDisconnected: grade === "DISCONNECTED",
  };
}
