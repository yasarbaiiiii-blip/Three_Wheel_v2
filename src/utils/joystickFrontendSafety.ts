import type {
  FrontendJoystickState,
  JoystickErrorCode,
  JoystickErrorEvent,
  JoystickIntent,
  JoystickTelemetryFields,
} from "../types/joystick";

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

export function shouldClearLeaseForJoystickError(code: string): boolean {
  return [
    "not_owner",
    "lease_inactive",
    "mode_unavailable",
    "fcu_disconnected",
    "not_armed",
    "unavailable",
    "acquire_cancelled",
  ].includes(code);
}

export function shouldStopSenderForJoystickError(code: string): boolean {
  return [
    "lease_inactive",
    "not_owner",
    "mode_unavailable",
    "fcu_disconnected",
    "transport_unavailable",
    "acquire_cancelled",
  ].includes(code);
}

export function shouldForceNeutralForJoystickError(code: string): boolean {
  return ["nan_value", "out_of_range", "transport_unavailable"].includes(code);
}

export function resolveAcquireErrorState(
  code: string,
  socketConnected: boolean
): FrontendJoystickState {
  switch (code) {
    case "mission_active":
      return "BLOCKED_BY_MISSION";
    case "unauthorised":
    case "unauthorized":
    case "manual_control_disabled":
      return "ERROR";
    default:
      return socketConnected ? "AVAILABLE" : "DISCONNECTED";
  }
}

export function requiresReacquireAfterJoystickError(
  code: string,
  wasAcquiring: boolean
): boolean {
  if (wasAcquiring) return false;
  return (
    ["not_owner", "lease_inactive", "acquire_cancelled", "lease_timeout"].includes(code) ||
    shouldClearLeaseForJoystickError(code)
  );
}

export function connectedJoystickState(socketConnected: boolean): FrontendJoystickState {
  return socketConnected ? "AVAILABLE" : "DISCONNECTED";
}

export function normalizeJoystickError(raw: unknown): JoystickErrorEvent {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as JoystickErrorEvent).type === "joystick_error" &&
    typeof (raw as JoystickErrorEvent).code === "string"
  ) {
    const event = raw as JoystickErrorEvent;
    return {
      type: "joystick_error",
      code: event.code,
      message:
        typeof event.message === "string" && event.message.length > 0
          ? event.message
          : event.code,
    };
  }

  if (raw && typeof raw === "object" && typeof (raw as JoystickErrorEvent).code === "string") {
    const code = (raw as JoystickErrorEvent).code as JoystickErrorCode;
    const message = (raw as JoystickErrorEvent).message;
    return {
      type: "joystick_error",
      code,
      message: typeof message === "string" && message.length > 0 ? message : code,
    };
  }

  return {
    type: "joystick_error",
    code: "unavailable",
    message: "Unknown joystick error",
  };
}

export function normalizeSocketError(raw: unknown): { code: string; message: string } {
  if (raw && typeof raw === "object") {
    const reason = (raw as { reason?: string }).reason;
    if (reason === "unauthorised" || reason === "unauthorized") {
      return { code: "unauthorised", message: "Authentication failed" };
    }
    if (typeof reason === "string" && reason.length > 0) {
      return { code: reason, message: reason };
    }
  }
  return { code: "unavailable", message: "Socket error" };
}

export function isBackendJoystickInactive(telem: JoystickTelemetryFields): boolean {
  return (
    telem.joystick_active === false &&
    telem.joystick_state === "inactive" &&
    telem.control_owner !== "mission"
  );
}

export const RECOVERABLE_INACTIVE_JOYSTICK_STATES: readonly FrontendJoystickState[] = [
  "RELEASING",
  "BLOCKED_BY_MISSION",
  "SUSPENDED",
];

export function shouldRecoverFromInactiveTelemetry(
  state: FrontendJoystickState,
  hasLocalLease: boolean
): boolean {
  return !hasLocalLease && RECOVERABLE_INACTIVE_JOYSTICK_STATES.includes(state);
}

export function shouldAcceptJoystickReleased(
  payload: { lease_id?: string | null },
  currentLeaseId: string | null,
  currentState: FrontendJoystickState
): boolean {
  if (payload.lease_id && currentLeaseId && payload.lease_id !== currentLeaseId) {
    return false;
  }
  if (payload.lease_id) {
    return true;
  }
  return currentState === "RELEASING" || currentLeaseId !== null;
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
