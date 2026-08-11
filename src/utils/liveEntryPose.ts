/**
 * Live entry (rover → first tip) pose policy for Start Mission.
 *
 * Keeps App.tsx free of ad-hoc staleness rules: prefer a just-fetched REST pose,
 * fall back to a client-timestamped socket cache, fail closed otherwise.
 */

import type { RoverPoseForEntry } from "./missionTrajectory";

/** Socket-cache poses older than this are not used for entry. */
export const LIVE_ENTRY_CACHE_MAX_AGE_MS = 3000;

/** Rebuild entry if rover moved more than this during restage+load. */
export const LIVE_ENTRY_RECHECK_MOVE_M = 1.0;

export type PoseSource = "rest_latest" | "socket_cache";

export type PickRoverPoseResult =
  | { ok: true; pose: RoverPoseForEntry; source: PoseSource }
  | { ok: false; error: string };

export type LiveEntryStartClass =
  | "restage_with_live_entry"
  | "legacy_start_ok"
  | "block_resend_required";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Map raw telemetry fields into RoverPoseForEntry, or null if nothing usable.
 * Does not validate GPS fix / frame — that stays in resolveRoverNedInMissionFrame.
 */
export function telemetryToRoverPoseForEntry(
  t: Partial<RoverPoseForEntry> | null | undefined
): RoverPoseForEntry | null {
  if (t == null || typeof t !== "object") return null;

  const pose: RoverPoseForEntry = {};
  let any = false;

  if (isFiniteNumber(t.pos_n)) {
    pose.pos_n = t.pos_n;
    any = true;
  }
  if (isFiniteNumber(t.pos_e)) {
    pose.pos_e = t.pos_e;
    any = true;
  }
  if (isFiniteNumber(t.lat)) {
    pose.lat = t.lat;
    any = true;
  }
  if (isFiniteNumber(t.lon)) {
    pose.lon = t.lon;
    any = true;
  }
  if (isFiniteNumber(t.gps_fix)) {
    pose.gps_fix = t.gps_fix;
    any = true;
  }
  if (isFiniteNumber(t.pose_age_ms)) {
    pose.pose_age_ms = t.pose_age_ms;
    any = true;
  }

  return any ? pose : null;
}

/**
 * Prefer REST latest. Allow socket cache only when the client received it recently.
 * REST poses are stamped with pose_age_ms from the backend when present; missing
 * age is allowed for rest_latest (caller just fetched). Cache without a receive
 * timestamp is rejected.
 */
export function pickRoverPoseForEntry(args: {
  restPose: RoverPoseForEntry | null;
  cachePose: RoverPoseForEntry | null;
  cacheReceivedAtMs: number | null;
  nowMs: number;
  cacheMaxAgeMs?: number;
}): PickRoverPoseResult {
  const cacheMax = args.cacheMaxAgeMs ?? LIVE_ENTRY_CACHE_MAX_AGE_MS;

  if (args.restPose != null) {
    return { ok: true, pose: args.restPose, source: "rest_latest" };
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
    if (age < 0 || age > cacheMax) {
      return {
        ok: false,
        error:
          `Rover pose cache is stale (${Math.round(age)} ms). Wait for live GPS, then Start again.`,
      };
    }
    return { ok: true, pose: args.cachePose, source: "socket_cache" };
  }

  return {
    ok: false,
    error:
      "No rover pose available for approach path. Wait for live GPS, then Start again.",
  };
}

/**
 * App-planned missions must restage with live entry from a Send snapshot.
 * Missing snapshot after recovery/invalidation → block (never start an old entry mission).
 */
export function classifyLiveEntryStartRequirement(args: {
  hasAppPlannedSnapshot: boolean;
  isAppPlannedMission: boolean;
}): LiveEntryStartClass {
  if (args.hasAppPlannedSnapshot) {
    return "restage_with_live_entry";
  }
  if (args.isAppPlannedMission) {
    return "block_resend_required";
  }
  return "legacy_start_ok";
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

/**
 * Whether map geometry looks like densified staged output (post-Send / recovery).
 * Used with missing snapshot to fail closed rather than start a stale entry mission.
 */
export function isAppPlannedMissionContext(args: {
  hasAppPlannedSnapshot: boolean;
  isCsvMission: boolean;
  isLocalDxfAppPlanned: boolean;
  hasStagedHydrationLines: boolean;
}): boolean {
  return (
    args.hasAppPlannedSnapshot ||
    args.isCsvMission ||
    args.isLocalDxfAppPlanned ||
    args.hasStagedHydrationLines
  );
}
