import { beforeEach, describe, expect, it } from "vitest";
import { MissionReasonEnum, MissionStateEnum, MissionWaitingOnEnum } from "../../contract/prod/realtime";
import { getRoverEventsState, setRoverSocketConnected } from "../telemetry/roverEventStore";
import { liveRover, missionData, pushRoverEvent } from "../../test/roverEvents";
import {
  ACTIVE_STATES,
  LIFECYCLE_STEPS,
  describeGate,
  describeMission,
  failedStepForReason,
  isActiveState,
  missionControls,
  missionIsActive,
  parseMissionRun,
  reasonText,
  selectMission,
  waitingOnText,
  type MissionView,
} from "./missionLifecycle";

const S = MissionStateEnum;

function viewFor(over: Parameters<typeof missionData>[0]): MissionView {
  liveRover({ mission: over });
  return selectMission(getRoverEventsState());
}

describe("selectMission reads the mission_state event", () => {
  beforeEach(() => liveRover());

  it("parses every field of the 0.15.0 MissionState", () => {
    const view = viewFor({
      state: S.ERROR,
      mission_id: 9,
      run_index: 1,
      point_index: 4,
      reason_code: MissionReasonEnum.ARM_REFUSED,
      gate_reason_code: 0,
      waiting_on: MissionWaitingOnEnum.DISARM,
      reason_detail: "arm refused by px4_link (reason 1)",
      request_id: "app-x",
      source_artifact_sha256: "a".repeat(64),
      path_artifact_sha256: "b".repeat(64),
    });
    expect(view.known).toBe(true);
    if (!view.known) return;
    expect(view.run).toEqual({
      state: S.ERROR,
      missionId: 9,
      runIndex: 1,
      pointIndex: 4,
      reasonCode: MissionReasonEnum.ARM_REFUSED,
      gateReasonCode: 0,
      waitingOn: MissionWaitingOnEnum.DISARM,
      reasonDetail: "arm refused by px4_link (reason 1)",
      requestId: "app-x",
      sourceSha: "a".repeat(64),
      executionSha: "b".repeat(64),
    });
  });

  it("is unknown before the first event, after a gateway outage and with the socket down", () => {
    setRoverSocketConnected(true);
    expect(selectMission(getRoverEventsState())).toEqual({ known: false, reason: "gateway_unknown" });
    liveRover({ mission: { state: S.RUNNING } });
    pushRoverEvent("gateway_link", { connected: false });
    expect(selectMission(getRoverEventsState())).toEqual({ known: false, reason: "gateway_down" });
    liveRover({ mission: { state: S.RUNNING } });
    pushRoverEvent("mission_state", { fresh: false });
    expect(selectMission(getRoverEventsState())).toEqual({ known: false, reason: "stale" });
    liveRover({ mission: { state: S.RUNNING } });
    setRoverSocketConnected(false);
    expect(selectMission(getRoverEventsState())).toEqual({ known: false, reason: "no_socket" });
  });

  it("an unreadable state is unknown, not idle", () => {
    liveRover();
    pushRoverEvent("mission_state", { state: "running", fresh: true });
    expect(selectMission(getRoverEventsState())).toEqual({ known: false, reason: "invalid" });
    expect(parseMissionRun({ state: -1 } as never)).toBeNull();
  });
});

describe("describeMission: LOADING -> PLACING -> ARMING -> ENGAGING -> READY -> RUNNING", () => {
  const stepsOf = (d: ReturnType<typeof describeMission>) => d.steps.map((s) => `${s.label}:${s.status}`);

  it("lists the six steps in order", () => {
    expect(LIFECYCLE_STEPS).toEqual([S.LOADING, S.PLACING, S.ARMING, S.ENGAGING, S.READY, S.RUNNING]);
  });

  it.each([
    [S.LOADING, "Loading the mission", ["Loading:active", "Placing:pending", "Arming:pending", "Engaging:pending", "Ready:pending", "Running:pending"]],
    [S.PLACING, "Placing the mission at the rover's position", ["Loading:done", "Placing:active", "Arming:pending", "Engaging:pending", "Ready:pending", "Running:pending"]],
    [S.ARMING, "Arming the rover", ["Loading:done", "Placing:done", "Arming:active", "Engaging:pending", "Ready:pending", "Running:pending"]],
    [S.ENGAGING, "Engaging OFFBOARD control", ["Loading:done", "Placing:done", "Arming:done", "Engaging:active", "Ready:pending", "Running:pending"]],
    [S.READY, "Ready, waiting for the path follower", ["Loading:done", "Placing:done", "Arming:done", "Engaging:done", "Ready:active", "Running:pending"]],
    [S.RUNNING, "Running", ["Loading:done", "Placing:done", "Arming:done", "Engaging:done", "Ready:done", "Running:active"]],
  ])("state %i shows its headline and step positions", (state, headline, steps) => {
    const d = describeMission(viewFor({ state }));
    expect(d.headline).toBe(headline);
    expect(stepsOf(d)).toEqual(steps);
    expect(d.phase).toBe(state === S.RUNNING ? "running" : "starting");
    expect(d.tone).toBe(state === S.RUNNING ? "ok" : "progress");
  });

  it("shows what the rover is waiting on", () => {
    const d = describeMission(viewFor({ state: S.ARMING, waiting_on: MissionWaitingOnEnum.ARM }));
    expect(d.waitingText).toBe("Waiting for the rover to confirm arming");
    expect(waitingOnText(MissionWaitingOnEnum.NONE)).toBeNull();
    expect(waitingOnText(MissionWaitingOnEnum.OFFBOARD)).toMatch(/OFFBOARD/);
    expect(waitingOnText(MissionWaitingOnEnum.RPP_ACK)).toMatch(/path follower/);
    expect(waitingOnText(MissionWaitingOnEnum.ARTIFACT)).toMatch(/file/);
    expect(waitingOnText(MissionWaitingOnEnum.PLACEMENT)).toMatch(/placement/i);
    expect(waitingOnText(MissionWaitingOnEnum.OPERATOR)).toMatch(/operator/i);
    expect(waitingOnText(99)).toMatch(/99/);
  });

  it("a pending release takes precedence in a terminal state", () => {
    const d = describeMission(
      viewFor({ state: S.COMPLETED, waiting_on: MissionWaitingOnEnum.OFFBOARD_RELEASE })
    );
    expect(d.phase).toBe("completed");
    expect(d.waitingText).toBe("Releasing OFFBOARD control");
    expect(describeMission(viewFor({ state: S.ABORTED, waiting_on: MissionWaitingOnEnum.DISARM })).waitingText).toBe(
      "Disarming the rover"
    );
  });

  it("PAUSED keeps the run position and explains the pause", () => {
    const d = describeMission(
      viewFor({ state: S.PAUSED, reason_code: MissionReasonEnum.RPP_STALE })
    );
    expect(d.phase).toBe("paused");
    expect(d.tone).toBe("warn");
    expect(stepsOf(d)[5]).toBe("Running:active");
    expect(d.reasonText).toMatch(/path follower stopped reporting/);
  });

  it("COMPLETED marks every step done", () => {
    const d = describeMission(viewFor({ state: S.COMPLETED }));
    expect(d.phase).toBe("completed");
    expect(d.steps.every((s) => s.status === "done")).toBe(true);
    expect(d.reasonText).toBeNull();
  });

  it("ABORTED by the operator is a stop, by E-stop is danger", () => {
    const stopped = describeMission(viewFor({ state: S.ABORTED, reason_code: MissionReasonEnum.OPERATOR }));
    expect(stopped.headline).toBe("Stopped");
    expect(stopped.tone).toBe("warn");
    expect(stopped.reasonText).toBe("Stopped by the operator");
    const estop = describeMission(viewFor({ state: S.ABORTED, reason_code: MissionReasonEnum.ESTOP }));
    expect(estop.tone).toBe("danger");
    expect(estop.reasonText).toMatch(/Emergency stop/);
  });

  it("ERROR shows reason text and the rover's reason_detail, and blames the step when the reason names it", () => {
    const d = describeMission(
      viewFor({
        state: S.ERROR,
        reason_code: MissionReasonEnum.ARM_REFUSED,
        reason_detail: "arm refused by px4_link (reason 1); release: disarm timed out",
      })
    );
    expect(d.phase).toBe("error");
    expect(d.tone).toBe("danger");
    expect(d.reasonText).toBe("The rover refused to arm");
    expect(d.detail).toBe("arm refused by px4_link (reason 1); release: disarm timed out");
    expect(stepsOf(d)).toEqual(["Loading:done", "Placing:done", "Arming:failed", "Engaging:pending", "Ready:pending", "Running:pending"]);
  });

  it("ERROR with a reason that does not name a step draws no step row", () => {
    const d = describeMission(viewFor({ state: S.ERROR, reason_code: MissionReasonEnum.SAFETY, gate_reason_code: 6 }));
    expect(d.steps).toEqual([]);
    expect(d.reasonText).toBe("A safety check failed: RTK is not good enough");
  });

  it("an empty reason_detail is null; a whitespace one too", () => {
    expect(describeMission(viewFor({ state: S.ERROR, reason_detail: "   " })).detail).toBeNull();
  });

  it("unknown shows no state, no steps, and says nothing is live", () => {
    const d = describeMission({ known: false, reason: "gateway_down" });
    expect(d.phase).toBe("unknown");
    expect(d.stateName).toBeNull();
    expect(d.steps).toEqual([]);
    expect(d.unknownText).toBe("Rover controller offline");
    expect(describeMission({ known: false, reason: "stale" }).unknownText).toBe("Status not updating");
  });

  it("an unknown number from a newer rover is shown as such, not as idle", () => {
    const d = describeMission(viewFor({ state: 42 }));
    expect(d.phase).toBe("unknown");
    expect(d.stateName).toBe("UNKNOWN_42");
  });

  it("IDLE", () => {
    const d = describeMission(viewFor({ state: S.IDLE }));
    expect(d).toMatchObject({ phase: "idle", headline: "Idle", steps: [] });
  });
});

describe("reason text covers 0..17", () => {
  it("has a sentence for every reason and flags numbers it does not know", () => {
    expect(reasonText(MissionReasonEnum.NONE)).toBeNull();
    for (let code = 1; code <= 17; code++) {
      const text = reasonText(code);
      expect(text, `reason ${code}`).toBeTruthy();
      expect(text).not.toMatch(/Unknown reason/);
    }
    expect(reasonText(18)).toBe("Unknown reason (18)");
  });

  it("names the guard gate for SAFETY and RTK", () => {
    expect(reasonText(MissionReasonEnum.SAFETY, 5)).toMatch(/emergency stop is asserted/);
    expect(reasonText(MissionReasonEnum.RTK, 6)).toMatch(/RTK is not good enough/);
    expect(describeGate(10)).toMatch(/tablet link/);
    expect(describeGate(77)).toBe("guard gate 77");
  });

  it("maps a failure to its lifecycle step only when unambiguous", () => {
    expect(failedStepForReason(MissionReasonEnum.PATH_ERROR)).toBe(S.LOADING);
    expect(failedStepForReason(MissionReasonEnum.PLACEMENT_OUT_OF_BOUNDS)).toBe(S.PLACING);
    expect(failedStepForReason(MissionReasonEnum.ARM_TIMEOUT)).toBe(S.ARMING);
    expect(failedStepForReason(MissionReasonEnum.OFFBOARD_REFUSED)).toBe(S.ENGAGING);
    expect(failedStepForReason(MissionReasonEnum.RPP_ACK_TIMEOUT)).toBe(S.READY);
    expect(failedStepForReason(MissionReasonEnum.SAFETY)).toBeNull();
    expect(failedStepForReason(MissionReasonEnum.EKF_RESET)).toBeNull();
  });
});

describe("buttons per state", () => {
  const ctx = { busy: false, hasMission: true };
  const controlsFor = (state: number, c = ctx) => missionControls(viewFor({ state }), c);
  const enabled = (c: ReturnType<typeof missionControls>) =>
    [c.canStart && "start", c.canPause && "pause", c.canResume && "resume", c.canStop && "stop"].filter(Boolean);

  it.each([
    [S.IDLE, ["start"]],
    [S.LOADING, ["stop"]],
    [S.PLACING, ["stop"]],
    [S.ARMING, ["stop"]],
    [S.ENGAGING, ["stop"]],
    [S.READY, ["stop"]],
    [S.RUNNING, ["pause", "stop"]],
    [S.PAUSED, ["resume", "stop"]],
    [S.COMPLETED, ["start"]],
    [S.ABORTED, ["start"]],
    [S.ERROR, ["start"]],
  ])("state %i enables exactly %j", (state, expected) => {
    expect(enabled(controlsFor(state))).toEqual(expected);
  });

  it("Resume is only ever offered when PAUSED, Pause only when RUNNING", () => {
    for (let state = 0; state <= 10; state++) {
      const c = controlsFor(state);
      expect(c.canResume).toBe(state === S.PAUSED);
      expect(c.canPause).toBe(state === S.RUNNING);
    }
  });

  it("Start needs a stored mission, and says why it is off", () => {
    const c = controlsFor(S.IDLE, { busy: false, hasMission: false });
    expect(c.canStart).toBe(false);
    expect(c.startBlockedReason).toBe("Send a mission to the rover first");
    expect(controlsFor(S.RUNNING).startBlockedReason).toBe("A mission is already in progress");
    expect(controlsFor(S.IDLE).startBlockedReason).toBeNull();
  });

  it("nothing is enabled while a command is in flight", () => {
    for (let state = 0; state <= 10; state++) {
      const c = controlsFor(state, { busy: true, hasMission: true });
      expect(enabled(c)).toEqual([]);
    }
    expect(controlsFor(S.IDLE, { busy: true, hasMission: true }).startBlockedReason).toBe("Working…");
  });

  it("an unknown state disables Start, Pause and Resume but leaves Stop available", () => {
    const unknown: MissionView = { known: false, reason: "gateway_down" };
    const c = missionControls(unknown, ctx);
    expect(enabled(c)).toEqual(["stop"]);
    expect(c.startBlockedReason).toMatch(/Waiting for the rover/);
    expect(enabled(missionControls(unknown, { busy: true, hasMission: true }))).toEqual([]);
  });

  it("an unknown state number from a newer rover cannot be started", () => {
    const c = controlsFor(42);
    expect(c.canStart).toBe(false);
    expect(c.startBlockedReason).toBe("The rover reported an unknown state");
  });

  it("missionIsActive covers LOADING..PAUSED only", () => {
    for (let state = 0; state <= 10; state++) {
      expect(missionIsActive(viewFor({ state }))).toBe(ACTIVE_STATES.includes(state));
      expect(isActiveState(state)).toBe(ACTIVE_STATES.includes(state));
    }
    expect(missionIsActive({ known: false, reason: "stale" })).toBe(false);
  });
});
