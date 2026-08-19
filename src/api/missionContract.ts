import type { LoadedPathResponse, PlacementMode, StartMissionPayload } from "./missionApi";

export type MissionContractErrorKind = "conflict" | "placement" | "other";

export type MissionContractError = {
  kind: MissionContractErrorKind;
  status: number;
  title: string;
  message: string;
};

export type StagedStartGate = {
  isStagedWorkflow: boolean;
  allowed: boolean;
  message: string | null;
};

export type WorkflowState = {
  upload: string;
  alignment: string;
  spray: string;
  staged: string;
  loaded: string;
  started: string;
};

export function invalidateWorkflowFrom<T extends WorkflowState>(
  current: T,
  step: "alignment" | "spray" | "staged" | "loaded"
): T {
  const next = { ...current };
  if (step === "alignment") next.alignment = "pending";
  if (step === "alignment" || step === "spray") next.spray = "pending";
  if (step === "alignment" || step === "spray" || step === "staged") next.staged = "pending";
  next.loaded = "pending";
  next.started = "pending";
  return next;
}

function normalizedId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getLoadedMissionId(loaded: LoadedPathResponse | null): string | null {
  return normalizedId(loaded?.mission_id);
}

export function isProtectedMissionResident(loaded: LoadedPathResponse | null): boolean {
  return Boolean(
    loaded?.loaded &&
      (loaded.protected || loaded.is_staged || loaded.placement_mode === "GPS_SURVEYED")
  );
}

/** After Load, rover geometry must not silently drop painted paths from a multi-file send. */
export function verifyHydratedMarkCount(
  expectedMarkCount: number,
  loadedMarkCount: number
): { ok: boolean; message: string | null } {
  if (expectedMarkCount >= 2 && loadedMarkCount < expectedMarkCount) {
    return {
      ok: false,
      message: `Load returned ${loadedMarkCount} painted path(s) but this mission has ${expectedMarkCount}. Re-Send the full batch so every file stays on the map.`,
    };
  }
  return { ok: true, message: null };
}

/** Poll budget after load-to-controller while the rover still reports the previous mission. */
export const LOADED_PATH_CONFIRM_ATTEMPTS = 8;
export const LOADED_PATH_CONFIRM_GAP_MS = 300;

/**
 * True when getLoadedPath likely just hasn't flipped to the new mission_id yet
 * (Send's mission still resident, or loaded flag not latched). Hard failures
 * (zero waypoints, missing staged metadata on the matching id) are not transient.
 */
export function isTransientLoadedMissionMismatch(
  loaded: LoadedPathResponse | null,
  expectedMissionId: string
): boolean {
  const expected = normalizedId(expectedMissionId);
  if (!expected) return false;
  const actual = getLoadedMissionId(loaded);
  if (!actual || actual !== expected) return true;
  const state = typeof loaded?.state === "string" ? loaded.state.toLowerCase() : "";
  if (!loaded?.loaded && state !== "completed") return true;
  return false;
}

export async function confirmStagedMissionLoaded(args: {
  expectedMissionId: string;
  fetchLoaded: () => Promise<LoadedPathResponse | null>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  gapMs?: number;
}): Promise<{
  verified: boolean;
  loaded: LoadedPathResponse | null;
  message: string | null;
}> {
  const attempts = args.attempts ?? LOADED_PATH_CONFIRM_ATTEMPTS;
  const gapMs = args.gapMs ?? LOADED_PATH_CONFIRM_GAP_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let loaded: LoadedPathResponse | null = null;
  let last: { verified: boolean; message: string | null } = {
    verified: false,
    message: `Staged mission ${args.expectedMissionId} does not match loaded mission <none>.`,
  };

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(gapMs);
    try {
      loaded = await args.fetchLoaded();
    } catch {
      loaded = null;
    }
    if (!loaded) {
      last = { verified: false, message: "Loaded path verification failed" };
      continue;
    }
    last = verifyStagedLoadedMission(loaded, args.expectedMissionId);
    if (last.verified) return { verified: true, loaded, message: null };
    if (!isTransientLoadedMissionMismatch(loaded, args.expectedMissionId)) {
      return { verified: false, loaded, message: last.message };
    }
  }

  return { verified: false, loaded, message: last.message };
}

export function verifyStagedLoadedMission(
  loaded: LoadedPathResponse,
  expectedMissionId: string,
  expectedPlacement: PlacementMode = "GPS_SURVEYED"
): { verified: boolean; message: string | null } {
  const expected = normalizedId(expectedMissionId);
  const actual = getLoadedMissionId(loaded);
  const missionState = typeof loaded.state === "string" ? loaded.state.toLowerCase() : "";
  const isCompleted = missionState === "completed";
  const mismatch = `Staged mission ${expected ?? "<missing>"} does not match loaded mission ${actual ?? "<none>"}.`;

  if (!expected || (!loaded.loaded && !isCompleted) || !actual || actual !== expected) {
    return { verified: false, message: mismatch };
  }
  
  const isProtected = loaded.is_staged || loaded.protected || loaded.placement_mode === "GPS_SURVEYED";
  if (!isProtected) {
    return {
      verified: false,
      message: `Mission ${expected} is loaded but backend staged/protected metadata is not confirmed.`,
    };
  }

  if (loaded.num_waypoints <= 0) {
    return { verified: false, message: `Mission ${expected} has no loaded waypoints.` };
  }
  return { verified: true, message: null };
}

export function evaluateMissionStartGate(args: {
  stagedVerified: boolean;
  loadedVerified: boolean;
  stagedMissionId: string | null;
  loaded: LoadedPathResponse | null;
  alignmentVerified?: boolean;
}): StagedStartGate {
  const { stagedVerified, loadedVerified, stagedMissionId, loaded, alignmentVerified } = args;
  if (!stagedVerified) {
    if (alignmentVerified) {
      return {
        isStagedWorkflow: true,
        allowed: false,
        message: "GPS alignment complete — run Plan & Stage, then Load to controller before starting.",
      };
    }
    if (isProtectedMissionResident(loaded)) {
      return {
        isStagedWorkflow: false,
        allowed: false,
        message: "A protected surveyed mission is resident; legacy filename start is blocked.",
      };
    }
    return { isStagedWorkflow: false, allowed: true, message: null };
  }

  if (!loadedVerified) {
    return {
      isStagedWorkflow: true,
      allowed: false,
      message: "Load and verify the staged mission on the controller before starting.",
    };
  }

  const expected = normalizedId(stagedMissionId);
  if (!expected) {
    return {
      isStagedWorkflow: true,
      allowed: false,
      message: "Staged mission ID is missing from loaded-path verification.",
    };
  }

  const verification = loaded
    ? verifyStagedLoadedMission(loaded, expected)
    : { verified: false, message: `Staged mission ${expected} does not match loaded mission <none>.` };
  return {
    isStagedWorkflow: true,
    allowed: verification.verified,
    message: verification.message,
  };
}

/**
 * Build the /api/mission/start body.
 *
 * Phase 5: for app-planned CSV trajectory missions there is no disk file to re-load.
 * Passing `requireStagedMission: true` (CSV flow) refuses the path_name fallback and
 * throws so the caller never discards surveyed placement by re-staging from filename.
 */
export function buildMissionStartPayload(args: {
  stagedMissionId: string | null;
  stagedVerified: boolean;
  fileName: string;
  autoOrigin: boolean;
  /**
   * When true, start is only allowed with a verified staged mission_id.
   * Use for CSV / plan-trajectory missions (no meaningful path_name reload).
   */
  requireStagedMission?: boolean;
}): StartMissionPayload {
  const missionId = normalizedId(args.stagedMissionId);
  if (args.stagedVerified) {
    if (!missionId) throw new Error("Verified staged start requires a mission ID.");
    return { mission_id: missionId, auto_origin: false };
  }
  if (args.requireStagedMission) {
    throw new Error(
      "CSV mission is not staged-verified. Plan & stage the trajectory and load it " +
        "to the controller before starting — filename start would discard surveyed placement."
    );
  }
  return {
    path_name: args.fileName,
    mission_file: "",
    auto_origin: args.autoOrigin,
  };
}

/**
 * Phase 5 gate helper: CSV trajectory missions must not fall through to path_name start.
 * Returns a block message, or null when start may proceed via the normal staged gate.
 */
export function csvMissionStartBlockMessage(args: {
  isCsvMission: boolean;
  stagedVerified: boolean;
}): string | null {
  if (!args.isCsvMission) return null;
  if (args.stagedVerified) return null;
  return (
    "This CSV mission is not staged and verified. Send/plan the trajectory and load it " +
    "before starting — a filename start cannot place a surveyed CSV correctly."
  );
}

export function classifyMissionError(status: number, detail: string): MissionContractError {
  if (status === 409) {
    return { kind: "conflict", status, title: "Mission conflict", message: detail };
  }
  if (status === 422) {
    return {
      kind: "placement",
      status,
      title: "GPS placement unavailable",
      message: detail,
    };
  }
  return { kind: "other", status, title: "Mission failed", message: detail };
}

export function runningMissionMismatch(
  loadedMissionId: string | null | undefined,
  runningMissionId: string | null | undefined
): string | null {
  const loaded = normalizedId(loadedMissionId);
  const running = normalizedId(runningMissionId);
  if (!running || loaded === running) return null;
  return `Running mission ${running} does not match loaded mission ${loaded ?? "<none>"}.`;
}
