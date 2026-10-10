/**
 * Mission lifecycle as the operator sees it, derived from `mission_state` rover events
 * (docs/contracts/dyx3_mission.md section 2, interfaces 0.15.0). Pure functions only: the UI
 * renders what these return, the tests pin them.
 *
 * LOADING -> PLACING -> ARMING -> ENGAGING -> READY -> RUNNING, then COMPLETED / ABORTED / ERROR;
 * RUNNING <-> PAUSED. The rover arms itself and switches to OFFBOARD: the operator never does.
 */

import {
  MISSION_STATE_NAMES,
  MissionReasonEnum,
  MissionStateEnum,
  MissionWaitingOnEnum,
  type MissionData,
} from "../../contract/prod/realtime";
import {
  describeUnknown,
  selectKind,
  type RoverEventsState,
  type UnknownReason,
} from "../telemetry/roverEventStore";

/** The mission, as parsed from a `mission_state` event's data. */
export type MissionRun = {
  state: number;
  /** Execution id; incremented on every accepted start. */
  missionId: number;
  runIndex: number;
  pointIndex: number;
  reasonCode: number;
  gateReasonCode: number;
  waitingOn: number;
  /** The rover's own words for the current state/reason; may end in `; release: ...`. */
  reasonDetail: string;
  /** The start's request_id (empty when none). Matches the id the app sent. */
  requestId: string;
  sourceSha: string;
  executionSha: string;
};

export type MissionView =
  | { known: true; run: MissionRun; seq: number; replay: boolean }
  | { known: false; reason: UnknownReason };

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate the `data` of a fresh `mission_state` event. Null when `state` is not a number. */
export function parseMissionRun(data: Partial<Record<keyof MissionData, unknown>>): MissionRun | null {
  const state = asInt(data.state);
  if (state === null) return null;
  return {
    state,
    missionId: asInt(data.mission_id) ?? 0,
    runIndex: asInt(data.run_index) ?? 0,
    pointIndex: asInt(data.point_index) ?? 0,
    reasonCode: asInt(data.reason_code) ?? 0,
    gateReasonCode: asInt(data.gate_reason_code) ?? 0,
    waitingOn: asInt(data.waiting_on) ?? 0,
    reasonDetail: asText(data.reason_detail),
    requestId: asText(data.request_id),
    sourceSha: asText(data.source_artifact_sha256),
    executionSha: asText(data.path_artifact_sha256),
  };
}

/** The mission lifecycle from the rover-event state. Unknown unless the gateway link is up and the event is fresh. */
export function selectMission(s?: RoverEventsState): MissionView {
  const v = selectKind("mission_state", s);
  if (!v.known) return v;
  const run = parseMissionRun(v.data);
  if (!run) return { known: false, reason: "invalid" };
  return { known: true, run, seq: v.event.seq, replay: v.event.replay };
}

// ---- state classes -------------------------------------------------------------------------

/** States between an accepted start and RUNNING. */
export const STARTING_STATES: readonly number[] = [
  MissionStateEnum.LOADING,
  MissionStateEnum.PLACING,
  MissionStateEnum.ARMING,
  MissionStateEnum.ENGAGING,
  MissionStateEnum.READY,
];

/** The execution holds the vehicle: start refused BUSY, abort legal. */
export const ACTIVE_STATES: readonly number[] = [
  ...STARTING_STATES,
  MissionStateEnum.RUNNING,
  MissionStateEnum.PAUSED,
];

/** A new start is accepted from these (the previous execution has ended or never was). */
export const STARTABLE_STATES: readonly number[] = [
  MissionStateEnum.IDLE,
  MissionStateEnum.COMPLETED,
  MissionStateEnum.ABORTED,
  MissionStateEnum.ERROR,
];

export const isActiveState = (state: number) => ACTIVE_STATES.includes(state);
export const isTerminalState = (state: number) =>
  state === MissionStateEnum.COMPLETED || state === MissionStateEnum.ABORTED || state === MissionStateEnum.ERROR;

/** The steps the operator watches go by, in order. */
export const LIFECYCLE_STEPS: readonly number[] = [
  MissionStateEnum.LOADING,
  MissionStateEnum.PLACING,
  MissionStateEnum.ARMING,
  MissionStateEnum.ENGAGING,
  MissionStateEnum.READY,
  MissionStateEnum.RUNNING,
];

const STEP_LABELS: Record<number, string> = {
  [MissionStateEnum.LOADING]: "Loading",
  [MissionStateEnum.PLACING]: "Placing",
  [MissionStateEnum.ARMING]: "Arming",
  [MissionStateEnum.ENGAGING]: "Engaging",
  [MissionStateEnum.READY]: "Ready",
  [MissionStateEnum.RUNNING]: "Running",
};

// ---- text ----------------------------------------------------------------------------------

const HEADLINES: Record<number, string> = {
  [MissionStateEnum.IDLE]: "Idle",
  [MissionStateEnum.LOADING]: "Loading the mission",
  [MissionStateEnum.PLACING]: "Placing the mission at the rover's position",
  [MissionStateEnum.ARMING]: "Arming the rover",
  [MissionStateEnum.ENGAGING]: "Engaging OFFBOARD control",
  [MissionStateEnum.READY]: "Ready, waiting for the path follower",
  [MissionStateEnum.RUNNING]: "Running",
  [MissionStateEnum.PAUSED]: "Paused",
  [MissionStateEnum.COMPLETED]: "Completed",
  [MissionStateEnum.ABORTED]: "Stopped",
  [MissionStateEnum.ERROR]: "Failed",
};

const WAITING_TEXT: Record<number, string> = {
  [MissionWaitingOnEnum.ARTIFACT]: "Waiting for the mission file to load",
  [MissionWaitingOnEnum.PLACEMENT]: "Waiting for the placement at the rover's position",
  [MissionWaitingOnEnum.ARM]: "Waiting for the rover to confirm arming",
  [MissionWaitingOnEnum.OFFBOARD]: "Waiting for OFFBOARD control to be confirmed",
  [MissionWaitingOnEnum.RPP_ACK]: "Waiting for the path follower to acknowledge the mission",
  [MissionWaitingOnEnum.OPERATOR]: "Waiting for the operator",
  [MissionWaitingOnEnum.OFFBOARD_RELEASE]: "Releasing OFFBOARD control",
  [MissionWaitingOnEnum.DISARM]: "Disarming the rover",
};

/** Guard gate names (MotionSetpointStatus.REASON_*), in the operator's words. */
const GATE_TEXT: Record<number, string> = {
  1: "invalid safety message",
  2: "the safety status is not being reported",
  4: "the mission gate is closed",
  5: "the emergency stop is asserted",
  6: "RTK is not good enough",
  8: "the rover's flight-controller link is unhealthy",
  9: "the heading estimate is not trustworthy",
  10: "the tablet link was lost",
  11: "the rover is not armed or in OFFBOARD",
  12: "the position estimate is unhealthy",
  13: "the rover has no valid GPS reference",
};

export function describeGate(code: number): string {
  return GATE_TEXT[code] ?? `guard gate ${code}`;
}

/** What the rover is waiting for; null for NONE. Shown during the start and while it releases. */
export function waitingOnText(code: number): string | null {
  if (code === MissionWaitingOnEnum.NONE) return null;
  return WAITING_TEXT[code] ?? `Waiting (step ${code})`;
}

/** Why the mission ended, paused or failed; null for NONE. */
export function reasonText(code: number, gateReasonCode = 0): string | null {
  const gate = gateReasonCode > 0 ? `: ${describeGate(gateReasonCode)}` : "";
  switch (code) {
    case MissionReasonEnum.NONE:
      return null;
    case MissionReasonEnum.OPERATOR:
      return "Stopped by the operator";
    case MissionReasonEnum.SAFETY:
      return `A safety check failed${gate}`;
    case MissionReasonEnum.RTK:
      return `RTK is not good enough${gate}`;
    case MissionReasonEnum.PATH_ERROR:
      return "The mission file is missing or damaged. Send the mission again";
    case MissionReasonEnum.INTERNAL_ERROR:
      return "Internal rover error";
    case MissionReasonEnum.EKF_RESET:
      return "The rover's position estimate was reset, so the placed path may no longer lie where it was drawn. Stop and start again";
    case MissionReasonEnum.EKF_REFERENCE_INVALID:
      return "The rover has no valid GPS reference or fresh position to place the mission";
    case MissionReasonEnum.PLACEMENT_OUT_OF_BOUNDS:
      return "The mission lies too far from the rover (more than 1 km from its GPS reference)";
    case MissionReasonEnum.NO_PLACEMENT_FRAME:
      return "The mission has no GPS origin. Send it again from the app";
    case MissionReasonEnum.ARM_REFUSED:
      return "The rover refused to arm";
    case MissionReasonEnum.ARM_TIMEOUT:
      return "The rover did not confirm arming in time";
    case MissionReasonEnum.OFFBOARD_REFUSED:
      return "The rover refused OFFBOARD control";
    case MissionReasonEnum.OFFBOARD_TIMEOUT:
      return "The rover did not confirm OFFBOARD control in time";
    case MissionReasonEnum.RPP_ACK_TIMEOUT:
      return "The path follower did not acknowledge the mission in time";
    case MissionReasonEnum.ESTOP:
      return "Emergency stop asserted; the rover disarmed";
    case MissionReasonEnum.RPP_ERROR:
      return "The path follower reported an error";
    case MissionReasonEnum.RPP_STALE:
      return "The path follower stopped reporting (automatic pause)";
    default:
      return `Unknown reason (${code})`;
  }
}

/**
 * The lifecycle step a failure happened in, when the reason names it unambiguously.
 * SAFETY / RTK / EKF_RESET can strike in several steps: no step is blamed.
 */
export function failedStepForReason(reasonCode: number): number | null {
  switch (reasonCode) {
    case MissionReasonEnum.PATH_ERROR:
      return MissionStateEnum.LOADING;
    case MissionReasonEnum.EKF_REFERENCE_INVALID:
    case MissionReasonEnum.PLACEMENT_OUT_OF_BOUNDS:
    case MissionReasonEnum.NO_PLACEMENT_FRAME:
      return MissionStateEnum.PLACING;
    case MissionReasonEnum.ARM_REFUSED:
    case MissionReasonEnum.ARM_TIMEOUT:
      return MissionStateEnum.ARMING;
    case MissionReasonEnum.OFFBOARD_REFUSED:
    case MissionReasonEnum.OFFBOARD_TIMEOUT:
      return MissionStateEnum.ENGAGING;
    case MissionReasonEnum.RPP_ACK_TIMEOUT:
      return MissionStateEnum.READY;
    default:
      return null;
  }
}

// ---- description for the screen ------------------------------------------------------------

export type StepStatus = "done" | "active" | "pending" | "failed";
export type LifecycleTone = "neutral" | "progress" | "ok" | "warn" | "danger";
export type LifecyclePhase =
  | "unknown"
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "aborted"
  | "error";

export type LifecycleStep = { state: number; label: string; status: StepStatus };

export type LifecycleDescription = {
  phase: LifecyclePhase;
  /** Upper-case state name from the contract, or null while unknown. */
  stateName: string | null;
  headline: string;
  tone: LifecycleTone;
  /** The six steps with their status; empty when the state has no meaningful step position. */
  steps: LifecycleStep[];
  /** What the rover is waiting on, or null. */
  waitingText: string | null;
  /** Why it ended / paused / failed, or null. */
  reasonText: string | null;
  /** The rover's own `reason_detail`, or null when empty. */
  detail: string | null;
  /** Execution id, when known. */
  missionId: number | null;
  /** Never a value from before: set when the whole mission state is unknown. */
  unknownText: string | null;
};

function stepsFor(activeStep: number | null, failedStep: number | null, allDone: boolean): LifecycleStep[] {
  const activeIndex = activeStep === null ? -1 : LIFECYCLE_STEPS.indexOf(activeStep);
  const failedIndex = failedStep === null ? -1 : LIFECYCLE_STEPS.indexOf(failedStep);
  return LIFECYCLE_STEPS.map((state, i) => {
    let status: StepStatus = "pending";
    if (allDone) status = "done";
    else if (failedIndex >= 0) status = i < failedIndex ? "done" : i === failedIndex ? "failed" : "pending";
    else if (activeIndex >= 0) status = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
    return { state, label: STEP_LABELS[state], status };
  });
}

/** Everything the mission-run screen shows for one mission view. */
export function describeMission(view: MissionView): LifecycleDescription {
  if (!view.known) {
    return {
      phase: "unknown",
      stateName: null,
      headline: "Mission status unknown",
      tone: "neutral",
      steps: [],
      waitingText: null,
      reasonText: null,
      detail: null,
      missionId: null,
      unknownText: describeUnknown(view.reason),
    };
  }
  const { run } = view;
  const stateName = MISSION_STATE_NAMES[run.state] ?? `UNKNOWN_${run.state}`;
  const headline = HEADLINES[run.state] ?? `Unknown state (${run.state})`;
  const base = {
    stateName,
    headline,
    waitingText: waitingOnText(run.waitingOn),
    reasonText: reasonText(run.reasonCode, run.gateReasonCode),
    detail: run.reasonDetail.trim() ? run.reasonDetail.trim() : null,
    missionId: run.missionId,
    unknownText: null,
  };

  switch (run.state) {
    case MissionStateEnum.IDLE:
      return { ...base, phase: "idle", tone: "neutral", steps: [] };
    case MissionStateEnum.LOADING:
    case MissionStateEnum.PLACING:
    case MissionStateEnum.ARMING:
    case MissionStateEnum.ENGAGING:
    case MissionStateEnum.READY:
      return { ...base, phase: "starting", tone: "progress", steps: stepsFor(run.state, null, false) };
    case MissionStateEnum.RUNNING:
      return { ...base, phase: "running", tone: "ok", steps: stepsFor(MissionStateEnum.RUNNING, null, false) };
    case MissionStateEnum.PAUSED:
      return { ...base, phase: "paused", tone: "warn", steps: stepsFor(MissionStateEnum.RUNNING, null, false) };
    case MissionStateEnum.COMPLETED:
      return { ...base, phase: "completed", tone: "ok", steps: stepsFor(null, null, true) };
    case MissionStateEnum.ABORTED: {
      const estop = run.reasonCode === MissionReasonEnum.ESTOP;
      return { ...base, phase: "aborted", tone: estop ? "danger" : "warn", steps: [] };
    }
    case MissionStateEnum.ERROR: {
      const failed = failedStepForReason(run.reasonCode);
      return {
        ...base,
        phase: "error",
        tone: "danger",
        steps: failed === null ? [] : stepsFor(null, failed, false),
      };
    }
    default:
      return { ...base, phase: "unknown", tone: "neutral", steps: [], unknownText: "The rover reported a state this app does not know" };
  }
}

// ---- buttons -------------------------------------------------------------------------------

export type MissionControls = {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  /** Why Start is off, for a hint under the button; null when it is on. */
  startBlockedReason: string | null;
};

export type ControlContext = {
  /** A command (start, pause, resume, stop) is in flight: nothing else may be sent meanwhile. */
  busy: boolean;
  /** A mission is stored on the rover and ready to start (uploaded and verified). */
  hasMission: boolean;
};

/**
 * Which buttons are enabled for a mission view.
 *
 *  - Start: only when no execution is active (IDLE or a finished one), a mission is stored, no command is in flight.
 *  - Pause: only RUNNING. Resume: only PAUSED (never automatic).
 *  - Stop (abort): any active state, and also while the state is unknown, because stopping is always the safe
 *    thing to try (the rover answers "not active" if there is nothing to stop). E-stop is separate and never gated.
 */
export function missionControls(view: MissionView, ctx: ControlContext): MissionControls {
  const none: MissionControls = {
    canStart: false,
    canPause: false,
    canResume: false,
    canStop: false,
    startBlockedReason: null,
  };
  if (!view.known) {
    return {
      ...none,
      canStop: !ctx.busy,
      startBlockedReason: "Waiting for the rover's mission status",
    };
  }
  const state = view.run.state;
  const idle = !ctx.busy;
  const startable = STARTABLE_STATES.includes(state);
  const active = isActiveState(state);
  let startBlockedReason: string | null = null;
  if (!startable) {
    startBlockedReason = active ? "A mission is already in progress" : "The rover reported an unknown state";
  } else if (!ctx.hasMission) {
    startBlockedReason = "Send a mission to the rover first";
  } else if (ctx.busy) {
    startBlockedReason = "Working…";
  }
  return {
    canStart: idle && startable && ctx.hasMission,
    canPause: idle && state === MissionStateEnum.RUNNING,
    canResume: idle && state === MissionStateEnum.PAUSED,
    canStop: idle && active,
    startBlockedReason,
  };
}

/** True while an execution holds the vehicle (LOADING ... PAUSED). Unknown is not active. */
export function missionIsActive(view: MissionView): boolean {
  return view.known && isActiveState(view.run.state);
}
