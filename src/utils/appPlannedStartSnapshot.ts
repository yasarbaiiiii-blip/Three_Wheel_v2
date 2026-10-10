/**
 * App-planned mission geometry frozen at Send, for Start-time restage with
 * live runtime entry (rover → first tip from current pose).
 *
 * After Send, the map is replaced with densified staged waypoints — those must
 * never be re-planned. Start always rebuilds from this snapshot + live telemetry.
 */

import type { PlanLine } from "../types/plan";
import type { DashPattern } from "./appPlannedMissionBuilder";
import { stageAppPlannedMission, type AdmittedMission } from "./missionStaging";
import { buildTrajectory, type RoverPoseForEntry } from "./missionTrajectory";
import {
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "./missionExtensions";

export type AppPlannedStartSnapshot = {
  /** Ordered painted mark lines only (source geometry, not densified). */
  paintedLines: PlanLine[];
  extensionConfig: CsvExtensionConfig | null;
  /** GPS anchor of the mission: the trajectory's local origin. */
  originGps: [number, number];
  missionName: string;
  /** Dash pattern frozen at Send (null = continuous). */
  dash: DashPattern | null;
  capturedAtMs: number;
};

/** Deep-clone plan lines so later map hydration cannot mutate the snapshot. */
export function clonePlanLinesForSnapshot(lines: PlanLine[]): PlanLine[] {
  return JSON.parse(JSON.stringify(lines)) as PlanLine[];
}

export function buildAppPlannedStartSnapshot(args: {
  paintedLines: PlanLine[];
  extensionConfig?: CsvExtensionConfig | null;
  originGps: [number, number];
  missionName: string;
  dash?: DashPattern | null;
}): AppPlannedStartSnapshot {
  return {
    paintedLines: clonePlanLinesForSnapshot(args.paintedLines),
    extensionConfig: args.extensionConfig
      ? normalizeCsvExtensionConfig(args.extensionConfig)
      : null,
    originGps: [args.originGps[0], args.originGps[1]],
    missionName: args.missionName,
    dash: args.dash ? { onM: args.dash.onM, offM: args.dash.offM } : null,
    capturedAtMs: Date.now(),
  };
}

export type RestageWithLiveEntryResult =
  | {
      success: true;
      missionId: string;
      admitted: AdmittedMission;
      entryLengthM?: number;
      entryIncluded: boolean;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Rebuild trajectory from the Send snapshot, prepend live entry from roverPose,
 * then upload through the same builder and authenticated client as Send.
 * Caller starts the returned mission id.
 */
export async function restageAppTrajectoryWithLiveEntry(args: {
  snapshot: AppPlannedStartSnapshot;
  roverPose: RoverPoseForEntry | null | undefined;
}): Promise<RestageWithLiveEntryResult> {
  const snap = args.snapshot;

  if (!snap.paintedLines.length) {
    return { success: false, error: "No painted paths in the start snapshot. Re-Send the mission." };
  }
  if (
    !Number.isFinite(snap.originGps[0]) ||
    !Number.isFinite(snap.originGps[1])
  ) {
    return { success: false, error: "Start snapshot is missing the GPS origin. Re-Send the mission." };
  }

  const built = buildTrajectory(snap.paintedLines, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions: snap.extensionConfig,
    roverPose: args.roverPose ?? null,
    originGps: snap.originGps,
    includeEntryTransit: true,
    requireEntryTransit: true,
  });

  if (built.entryTransit?.error) {
    return { success: false, error: built.entryTransit.error };
  }
  if (built.runs.length === 0) {
    return {
      success: false,
      error: built.warnings.slice(0, 3).join("\n") || "No trajectory runs produced.",
    };
  }

  const staged = await stageAppPlannedMission({
    missionName: snap.missionName,
    anchor: snap.originGps,
    runs: built.runs,
    dash: snap.dash,
    verifyStoredGeometry: false,
  });

  if (!staged.success || !staged.missionId || !staged.admitted) {
    return {
      success: false,
      error: staged.error || "Could not re-stage trajectory with live entry.",
    };
  }

  return {
    success: true,
    missionId: staged.missionId,
    admitted: staged.admitted,
    entryIncluded: built.entryTransit?.included === true,
    entryLengthM: built.entryTransit?.lengthM,
  };
}
