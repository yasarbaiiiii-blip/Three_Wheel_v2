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
  return loaded?.loaded ? normalizedId(loaded.mission_id) : null;
}

export function isProtectedMissionResident(loaded: LoadedPathResponse | null): boolean {
  return Boolean(
    loaded?.loaded &&
      (loaded.protected || loaded.is_staged || loaded.placement_mode === "GPS_SURVEYED")
  );
}

export function verifyStagedLoadedMission(
  loaded: LoadedPathResponse,
  expectedMissionId: string,
  expectedPlacement: PlacementMode = "GPS_SURVEYED"
): { verified: boolean; message: string | null } {
  const expected = normalizedId(expectedMissionId);
  const actual = getLoadedMissionId(loaded);
  const mismatch = `Staged mission ${expected ?? "<missing>"} does not match loaded mission ${actual ?? "<none>"}.`;

  if (!expected || !loaded.loaded || !actual || actual !== expected) {
    return { verified: false, message: mismatch };
  }
  if (!loaded.is_staged || !loaded.protected) {
    return {
      verified: false,
      message: `Mission ${expected} is loaded but backend staged/protected metadata is not confirmed.`,
    };
  }
  if (loaded.placement_mode !== expectedPlacement) {
    return {
      verified: false,
      message: `Mission ${expected} placement is ${loaded.placement_mode ?? "unknown"}; expected ${expectedPlacement}.`,
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

export function buildMissionStartPayload(args: {
  stagedMissionId: string | null;
  stagedVerified: boolean;
  fileName: string;
  autoOrigin: boolean;
}): StartMissionPayload {
  const missionId = normalizedId(args.stagedMissionId);
  if (args.stagedVerified) {
    if (!missionId) throw new Error("Verified staged start requires a mission ID.");
    return { mission_id: missionId, auto_origin: false };
  }
  return {
    path_name: args.fileName,
    mission_file: "",
    auto_origin: args.autoOrigin,
  };
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
