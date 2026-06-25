import type { FrontendJoystickState, JoystickIntent } from "../types/joystick";

export type JoystickCleanupReason =
  | "release"
  | "background"
  | "disconnect"
  | "unmount"
  | "estop"
  | "telemetry_lease_loss"
  | "command_timeout";

export type JoystickCleanupPlan = {
  forceNeutral: true;
  releaseLease: boolean;
  stopScheduler: true;
  clearLocalControl: true;
  nextState: FrontendJoystickState | null;
};

export function telemetryInactiveClearsLocalLease(state: FrontendJoystickState): boolean {
  return state === "ACTIVE" || state === "HELD" || state === "RELEASING";
}

export function backgroundJoystickState(): FrontendJoystickState {
  return "SUSPENDED";
}

export function canAcquireJoystick(args: {
  missionRunning: boolean;
  frontendState: FrontendJoystickState;
  backendJoystickActive?: boolean | null;
  controlOwner?: string | null;
}): boolean {
  return (
    !args.missionRunning &&
    !args.backendJoystickActive &&
    args.controlOwner !== "mission" &&
    (args.frontendState === "AVAILABLE" || args.frontendState === "ERROR")
  );
}

export function joystickIntentIsCentered(intent: JoystickIntent): boolean {
  return intent.throttle === 0 && intent.steering === 0;
}

export function joystickIntentDeadman(hasLease: boolean, intent: JoystickIntent): boolean {
  return hasLease && !joystickIntentIsCentered(intent);
}

export function cleanupPlanForJoystick(
  reason: JoystickCleanupReason,
  socketConnected: boolean
): JoystickCleanupPlan {
  if (reason === "background") {
    return {
      forceNeutral: true,
      releaseLease: true,
      stopScheduler: true,
      clearLocalControl: true,
      nextState: "SUSPENDED",
    };
  }

  if (reason === "disconnect") {
    return {
      forceNeutral: true,
      releaseLease: false,
      stopScheduler: true,
      clearLocalControl: true,
      nextState: "DISCONNECTED",
    };
  }

  if (reason === "estop") {
    return {
      forceNeutral: true,
      releaseLease: true,
      stopScheduler: true,
      clearLocalControl: true,
      nextState: "DISABLED",
    };
  }

  if (reason === "unmount") {
    return {
      forceNeutral: true,
      releaseLease: true,
      stopScheduler: true,
      clearLocalControl: true,
      nextState: null,
    };
  }

  return {
    forceNeutral: true,
    releaseLease: reason === "release",
    stopScheduler: true,
    clearLocalControl: true,
    nextState: socketConnected ? "AVAILABLE" : "DISCONNECTED",
  };
}
