/**
 * Live entry (rover → first tip) pose policy for Start Mission.
 *
 * Keeps App.tsx free of ad-hoc staleness rules. The pose comes from the socket telemetry only
 * (status is never polled over REST); a missing or stale pose fails closed.
 */

import type { RoverPoseForEntry } from "./missionTrajectory";
import { STALE_THRESHOLD_MS } from "../features/telemetry/staleness";

/** Socket-cache poses older than this are not used for entry. */
export const LIVE_ENTRY_CACHE_MAX_AGE_MS = 3000;

/** Rebuild entry if the rover moved more than this while the re-staged mission was uploading. */
export const LIVE_ENTRY_RECHECK_MOVE_M = 1.0;

export type PoseSource = "socket_cache";

export type PickRoverPoseResult =
  | { ok: true; pose: RoverPoseForEntry; source: PoseSource }
  | { ok: false; error: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isFreshSocketCache(
  cachePose: RoverPoseForEntry | null,
  cacheReceivedAtMs: number | null,
  nowMs: number,
  cacheMaxAgeMs: number
): cachePose is RoverPoseForEntry {
  if (cachePose == null) return false;
  if (!isUsablePose(cachePose)) return false;
  if (cacheReceivedAtMs == null || !Number.isFinite(cacheReceivedAtMs)) return false;
  const age = nowMs - cacheReceivedAtMs;
  return age >= 0 && age <= cacheMaxAgeMs;
}

function isUsablePose(pose: RoverPoseForEntry | null): boolean {
  if (!pose || !isFiniteNumber(pose.pose_age_ms) || pose.pose_age_ms < 0 || pose.pose_age_ms > STALE_THRESHOLD_MS) return false;
  return (isFiniteNumber(pose.pos_n) && isFiniteNumber(pose.pos_e)) || (isFiniteNumber(pose.lat) && isFiniteNumber(pose.lon));
}

/**
 * Use the socket sample if it was received within cacheMaxAgeMs and its source is fresh;
 * otherwise fail closed with an operator message. There is no REST fallback.
 */
export function pickRoverPoseForEntry(args: {
  cachePose: RoverPoseForEntry | null;
  cacheReceivedAtMs: number | null;
  nowMs: number;
  cacheMaxAgeMs?: number;
  eligibility?: { ok: boolean; reasons: string[] };
}): PickRoverPoseResult {
  if (args.eligibility && !args.eligibility.ok) return {ok:false, error:args.eligibility.reasons.join(" ")};
  const cacheMax = args.cacheMaxAgeMs ?? LIVE_ENTRY_CACHE_MAX_AGE_MS;

  if (isFreshSocketCache(args.cachePose, args.cacheReceivedAtMs, args.nowMs, cacheMax)) {
    return { ok: true, pose: args.cachePose, source: "socket_cache" };
  }

  if (args.cachePose != null) {
    const receivedAt = args.cacheReceivedAtMs;
    if (receivedAt == null || !Number.isFinite(receivedAt)) {
      return {
        ok: false,
        error:
          "No fresh rover pose for approach path. Wait for live telemetry, then Start again.",
      };
    }
    const age = args.nowMs - receivedAt;
    return {
      ok: false,
      error:
        `Rover pose cache or source is stale (${Math.round(age)} ms cache age). Wait for live GPS, then Start again.`,
    };
  }

  return {
    ok: false,
    error:
      "No rover pose available for approach path. Wait for live GPS, then Start again.",
  };
}

/**
 * Start can reuse the mission stored at Send when live entry would be omitted (the rover is
 * already at the first tip). Layer-scoped Start always re-uploads: the Send artifact is the full snapshot.
 */
export function canSkipLiveEntryRestage(args: {
  entryIncluded: boolean;
  /** The mission stored at Send is uploaded and verified. */
  storedVerified: boolean;
  layerScoped: boolean;
}): boolean {
  if (args.entryIncluded) return false;
  if (args.layerScoped) return false;
  return args.storedVerified;
}

/** True when latest NED is farther than threshold from the NED used to build entry. */
export function entryPoseDrifted(
  usedNed: [number, number],
  latestNed: [number, number],
  thresholdM: number = LIVE_ENTRY_RECHECK_MOVE_M
): boolean {
  const dn = latestNed[0] - usedNed[0];
  const de = latestNed[1] - usedNed[1];
  const dist = Math.hypot(dn, de);
  return Number.isFinite(dist) && dist > thresholdM;
}
