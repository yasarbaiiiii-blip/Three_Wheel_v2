/**
 * App-planned mission geometry frozen at Send, for Start-time restage with
 * live runtime entry (rover → first tip from current pose).
 *
 * After Send, the map is replaced with densified staged waypoints — those must
 * never be re-planned. Start always rebuilds from this snapshot + live telemetry.
 */

import type { PlanLine } from "../types/plan";
import { planAndStageAppTrajectory, type CsvStageResult } from "./missionStaging";
import {
  buildTrajectory,
  type GroundTruthSourcePoint,
  type RoverPoseForEntry,
} from "./missionTrajectory";
import {
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
} from "./missionExtensions";

export type AppPlannedStartSnapshot = {
  /** Ordered painted mark lines only (source geometry, not densified). */
  paintedLines: PlanLine[];
  extensionConfig: CsvExtensionConfig | null;
  originGps: [number, number];
  missionName: string;
  groundTruthSource?: GroundTruthSourcePoint[];
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
  groundTruthSource?: GroundTruthSourcePoint[];
}): AppPlannedStartSnapshot {
  return {
    paintedLines: clonePlanLinesForSnapshot(args.paintedLines),
    extensionConfig: args.extensionConfig
      ? normalizeCsvExtensionConfig(args.extensionConfig)
      : null,
    originGps: [args.originGps[0], args.originGps[1]],
    missionName: args.missionName,
    groundTruthSource: args.groundTruthSource
      ? args.groundTruthSource.map((g) => ({ ...g }))
      : undefined,
    capturedAtMs: Date.now(),
  };
}

export type RestageWithLiveEntryResult =
  | {
      success: true;
      missionId: string;
      plan: NonNullable<CsvStageResult["plan"]>;
      stagedInspection?: CsvStageResult["stagedInspection"];
      entryLengthM?: number;
      entryIncluded: boolean;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Rebuild trajectory from the Send snapshot, prepend live entry from roverPose,
 * plan-trajectory + stage. Caller loads to controller and starts.
 */
export async function restageAppTrajectoryWithLiveEntry(
  apiBaseUrl: string,
  args: {
    snapshot: AppPlannedStartSnapshot;
    roverPose: RoverPoseForEntry | null | undefined;
    markSpeedMs?: number;
    travelSpeedMs?: number;
  }
): Promise<RestageWithLiveEntryResult> {
  const markSpeedMs = args.markSpeedMs ?? 0.35;
  const travelSpeedMs = args.travelSpeedMs ?? 0.5;
  const snap = args.snapshot;

  if (!snap.paintedLines.length) {
    return { success: false, error: "No painted paths in the start snapshot. Re-Send the mission." };
  }
  if (
    !Number.isFinite(snap.originGps[0]) ||
    !Number.isFinite(snap.originGps[1])
  ) {
    return { success: false, error: "Start snapshot is missing origin_gps. Re-Send the mission." };
  }

  const built = buildTrajectory(snap.paintedLines, {
    markSpeedMs,
    travelSpeedMs,
    groundTruthSource: snap.groundTruthSource,
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

  const staged = await planAndStageAppTrajectory(apiBaseUrl, {
    missionName: snap.missionName,
    originGps: snap.originGps,
    runs: built.runs,
    groundTruth: built.groundTruth,
    markSpeedMs,
    travelSpeedMs,
  });

  if (!staged.success || !staged.missionId || !staged.plan) {
    return {
      success: false,
      error: staged.error || "Could not re-stage trajectory with live entry.",
    };
  }

  return {
    success: true,
    missionId: staged.missionId,
    plan: staged.plan,
    stagedInspection: staged.stagedInspection,
    entryIncluded: built.entryTransit?.included === true,
    entryLengthM: built.entryTransit?.lengthM,
  };
}
