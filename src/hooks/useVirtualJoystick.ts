import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { Socket } from "socket.io-client";

import type {
  FrontendJoystickState,
  JoystickAcquiredResponse,
  JoystickCommandRequest,
  JoystickErrorCode,
  JoystickErrorEvent,
  JoystickIntent,
  JoystickReleaseRequest,
  JoystickReleasedResponse,
  JoystickTelemetryFields,
} from "../types/joystick";
import { JoystickCommandSerializer } from "../utils/joystickCommandScheduler";
import {
  cleanupPlanForJoystick,
  connectedJoystickState,
  isBackendJoystickInactive,
  joystickIntentDeadman,
  joystickIntentIsCentered,
  normalizeJoystickError,
  normalizeSocketError,
  requiresReacquireAfterJoystickError,
  resolveAcquireErrorState,
  shouldAcceptJoystickReleased,
  shouldClearLeaseForJoystickError,
  shouldForceNeutralForJoystickError,
  shouldRecoverFromInactiveTelemetry,
  shouldStopSenderForJoystickError,
  telemetryInactiveClearsLocalLease,
} from "../utils/joystickFrontendSafety";
import { processAxis } from "../utils/joystickMath";

const DEFAULT_MAX_THROTTLE = 0.15;
const DEFAULT_MAX_STEERING = 0.5;
const DEFAULT_COMMAND_RATE_HZ = 20;
const ACQUIRE_TIMEOUT_MS = 3800;
const RELEASE_CONFIRM_TIMEOUT_MS = 1000;
const DEAD_ZONE = 0.03;
const RESPONSE_CURVE = 1;

const ERROR_MESSAGES: Record<JoystickErrorCode, string> = {
  manual_control_disabled: "Manual control is disabled by deployment configuration",
  malformed: "Invalid request format",
  mode_unavailable: "MANUAL mode unavailable — check FCU state",
  fcu_disconnected: "Flight controller not connected",
  not_armed: "Vehicle must be armed before acquiring joystick",
  not_owner: "Session or lease mismatch — re-acquire required",
  mission_active: "Mission is active — cannot acquire joystick",
  joystick_active: "Joystick already in use by another client",
  acquire_cancelled: "Acquire was cancelled — retry",
  unavailable: "Joystick controller not available",
  lease_inactive: "Lease is not active — re-acquire required",
  transport_unavailable: "Manual control transport unhealthy",
  out_of_order: "Command sequence error",
  replay: "Command replay detected",
  rate_exceeded: "Command rate exceeded",
  nan_value: "Invalid axis value",
  out_of_range: "Axis value outside [-1, 1]",
};

function createSessionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clientMonotonicMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === "function") return Math.floor(perf.now());
  return Date.now();
}

function isJoystickAcquiredPayload(data: unknown): data is JoystickAcquiredResponse {
  return (
    !!data &&
    typeof data === "object" &&
    (data as JoystickAcquiredResponse).type === "joystick_acquired" &&
    typeof (data as JoystickAcquiredResponse).lease_id === "string"
  );
}

function isJoystickErrorPayload(data: unknown): data is JoystickErrorEvent {
  return (
    !!data &&
    typeof data === "object" &&
    (data as JoystickErrorEvent).type === "joystick_error" &&
    typeof (data as JoystickErrorEvent).code === "string"
  );
}

function isJoystickReleasedPayload(data: unknown): data is JoystickReleasedResponse {
  return (
    !!data &&
    typeof data === "object" &&
    (data as JoystickReleasedResponse).type === "joystick_released"
  );
}

type UseVirtualJoystickOptions = {
  socket: Socket | null;
  authToken: string;
  socketConnected: boolean;
  onErrorMessage?: (title: string, message: string) => void;
};

export function useVirtualJoystick({
  socket,
  authToken,
  socketConnected,
  onErrorMessage,
}: UseVirtualJoystickOptions) {
  const [state, setState] = useState<FrontendJoystickState>("DISABLED");
  const [error, setError] = useState<JoystickErrorEvent | null>(null);
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const [maxThrottle, setMaxThrottle] = useState(DEFAULT_MAX_THROTTLE);
  const [maxSteering, setMaxSteering] = useState(DEFAULT_MAX_STEERING);
  const [commandRateHz, setCommandRateHz] = useState(DEFAULT_COMMAND_RATE_HZ);
  const [lastCmdAgeMs, setLastCmdAgeMs] = useState<number | null>(null);
  const [stopReason, setStopReason] = useState<string | null>(null);
  const [deadmanPressed, setDeadmanPressed] = useState(false);
  const [displayIntent, setDisplayIntent] = useState<JoystickIntent>({ throttle: 0, steering: 0 });

  const stateRef = useRef<FrontendJoystickState>("DISABLED");
  const sessionIdRef = useRef(createSessionId());
  const leaseIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const deadmanRef = useRef(false);
  const latestThrottleRef = useRef(0);
  const latestSteeringRef = useRef(0);
  const maxThrottleRef = useRef(DEFAULT_MAX_THROTTLE);
  const maxSteeringRef = useRef(DEFAULT_MAX_STEERING);
  const commandRateHzRef = useRef(DEFAULT_COMMAND_RATE_HZ);
  const authTokenRef = useRef(authToken);
  const socketRef = useRef<Socket | null>(socket);
  const socketConnectedRef = useRef(socketConnected);
  const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acquireTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commandLoopRunningRef = useRef(false);
  const urgentNeutralPendingRef = useRef(false);
  const serializerRef = useRef(new JoystickCommandSerializer());
  const runCommandLoopRef = useRef<() => void>(() => {});

  const setFrontendState = useCallback((next: FrontendJoystickState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    socketConnectedRef.current = socketConnected;
  }, [socketConnected]);

  const clearAcquireTimeout = useCallback(() => {
    if (acquireTimeoutRef.current !== null) {
      clearTimeout(acquireTimeoutRef.current);
      acquireTimeoutRef.current = null;
    }
  }, []);

  const clearReleaseTimeout = useCallback(() => {
    if (releaseTimeoutRef.current !== null) {
      clearTimeout(releaseTimeoutRef.current);
      releaseTimeoutRef.current = null;
    }
  }, []);

  const stopCommandSender = useCallback(() => {
    commandLoopRunningRef.current = false;
    urgentNeutralPendingRef.current = false;
    if (commandTimerRef.current !== null) {
      clearTimeout(commandTimerRef.current);
      commandTimerRef.current = null;
    }
  }, []);

  const processRawIntent = useCallback((throttle: number, steering: number): JoystickIntent => {
    return {
      throttle: processAxis(throttle, DEAD_ZONE, RESPONSE_CURVE, maxThrottleRef.current),
      steering: processAxis(steering, DEAD_ZONE, RESPONSE_CURVE, maxSteeringRef.current),
    };
  }, []);

  const scheduleCommandLoop = useCallback((delayMs: number) => {
    if (commandTimerRef.current !== null) {
      clearTimeout(commandTimerRef.current);
    }
    commandTimerRef.current = setTimeout(() => {
      commandTimerRef.current = null;
      runCommandLoopRef.current();
    }, Math.max(0, delayMs));
  }, []);

  const clearLease = useCallback(() => {
    leaseIdRef.current = null;
    sequenceRef.current = 0;
    serializerRef.current.reset();
    setLeaseId(null);
  }, []);

  const forceNeutral = useCallback(() => {
    latestThrottleRef.current = 0;
    latestSteeringRef.current = 0;
    deadmanRef.current = false;
    setDeadmanPressed(false);
    setDisplayIntent({ throttle: 0, steering: 0 });
  }, []);

  const emitSerializedCommand = useCallback(
    (intent: { deadman: boolean; throttle: number; steering: number }) => {
      const sock = socketRef.current;
      if (!sock?.connected) return { emitted: false as const, reason: "no_lease" as const };

      const result = serializerRef.current.build(
        {
          auth: authTokenRef.current,
          sessionId: sessionIdRef.current,
          leaseId: leaseIdRef.current,
          commandRateHz: commandRateHzRef.current,
          maxThrottle: maxThrottleRef.current,
          maxSteering: maxSteeringRef.current,
        },
        intent,
        clientMonotonicMs()
      );

      if (result.emitted) {
        sequenceRef.current = result.sequence;
        sock.emit("joystick_command", result.payload satisfies JoystickCommandRequest);
        if (result.payload.deadman && stateRef.current === "HELD") {
          setFrontendState("ACTIVE");
        } else if (!result.payload.deadman && stateRef.current === "ACTIVE") {
          setFrontendState("HELD");
        }
      }

      return result;
    },
    [setFrontendState]
  );

  const runCommandLoop = useCallback(() => {
    if (!commandLoopRunningRef.current && !urgentNeutralPendingRef.current) return;

    const urgent = urgentNeutralPendingRef.current;
    const deadman = urgent ? false : deadmanRef.current;
    const result = emitSerializedCommand({
      deadman,
      throttle: deadman ? latestThrottleRef.current : 0,
      steering: deadman ? latestSteeringRef.current : 0,
    });
    const now = clientMonotonicMs();

    if (result.emitted && urgent) {
      urgentNeutralPendingRef.current = false;
    } else if (!result.emitted && result.reason === "too_soon") {
      scheduleCommandLoop((result.nextAllowedMs ?? now) - now);
      return;
    } else if (!result.emitted && result.reason === "no_lease") {
      stopCommandSender();
      return;
    } else if (!result.emitted && result.reason === "invalid_value") {
      forceNeutral();
      urgentNeutralPendingRef.current = true;
    }

    if (commandLoopRunningRef.current || urgentNeutralPendingRef.current) {
      const nextAllowed = serializerRef.current.nextAllowedMs({
        commandRateHz: commandRateHzRef.current,
      });
      scheduleCommandLoop(Math.max(0, nextAllowed - clientMonotonicMs()));
    }
  }, [emitSerializedCommand, forceNeutral, scheduleCommandLoop, stopCommandSender]);

  runCommandLoopRef.current = runCommandLoop;

  const startCommandSender = useCallback(
    (rateHz: number) => {
      stopCommandSender();
      commandRateHzRef.current = rateHz;
      commandLoopRunningRef.current = true;
      scheduleCommandLoop(0);
    },
    [scheduleCommandLoop, stopCommandSender]
  );

  const requestUrgentNeutralCommand = useCallback(() => {
    if (!leaseIdRef.current) return;
    urgentNeutralPendingRef.current = true;
    runCommandLoopRef.current();
  }, []);

  const emitReleaseIfOwned = useCallback(() => {
    const sock = socketRef.current;
    const lease = leaseIdRef.current;
    if (!sock?.connected || !lease) return false;

    sock.emit("joystick_release", {
      auth: authTokenRef.current,
      session_id: sessionIdRef.current,
      lease_id: lease,
    } satisfies JoystickReleaseRequest);
    return true;
  }, []);

  const startReleaseTimeout = useCallback(() => {
    clearReleaseTimeout();
    releaseTimeoutRef.current = setTimeout(() => {
      if (stateRef.current !== "RELEASING") return;
      stopCommandSender();
      forceNeutral();
      clearLease();
      setFrontendState(connectedJoystickState(socketConnectedRef.current));
    }, RELEASE_CONFIRM_TIMEOUT_MS);
  }, [clearLease, clearReleaseTimeout, forceNeutral, setFrontendState, stopCommandSender]);

  const stopAndClearLocalControl = useCallback(() => {
    stopCommandSender();
    forceNeutral();
    clearLease();
  }, [clearLease, forceNeutral, stopCommandSender]);

  const handleJoystickError = useCallback(
    (rawError: unknown) => {
      const err = normalizeJoystickError(rawError);

      clearAcquireTimeout();

      const currentState = stateRef.current;
      const wasAcquiring = currentState === "ACQUIRING";

      if (shouldClearLeaseForJoystickError(err.code)) {
        clearLease();
      }
      if (shouldStopSenderForJoystickError(err.code)) {
        stopCommandSender();
      }
      if (shouldForceNeutralForJoystickError(err.code)) {
        forceNeutral();
      }

      setError(err);
      onErrorMessage?.(
        "Joystick error",
        err.message || ERROR_MESSAGES[err.code] || err.code
      );

      if (wasAcquiring) {
        setFrontendState(resolveAcquireErrorState(err.code, socketConnectedRef.current));
        return;
      }

      if (requiresReacquireAfterJoystickError(err.code, false)) {
        setFrontendState(connectedJoystickState(socketConnectedRef.current));
      }
    },
    [clearAcquireTimeout, clearLease, forceNeutral, onErrorMessage, setFrontendState, stopCommandSender]
  );

  const onAcquired = useCallback(
    (data: JoystickAcquiredResponse) => {
      clearAcquireTimeout();
      clearReleaseTimeout();
      leaseIdRef.current = data.lease_id;
      sequenceRef.current = 0;
      serializerRef.current.reset();
      maxThrottleRef.current = data.max_throttle;
      maxSteeringRef.current = data.max_steering;
      commandRateHzRef.current = data.command_rate_hz;
      forceNeutral();

      setLeaseId(data.lease_id);
      setMaxThrottle(data.max_throttle);
      setMaxSteering(data.max_steering);
      setCommandRateHz(data.command_rate_hz);
      setError(null);
      setFrontendState("HELD");
      startCommandSender(data.command_rate_hz);
    },
    [clearAcquireTimeout, forceNeutral, setFrontendState, startCommandSender]
  );

  const onReleased = useCallback(
    (data: JoystickReleasedResponse) => {
      if (
        !shouldAcceptJoystickReleased(data, leaseIdRef.current, stateRef.current)
      ) {
        return;
      }

      clearAcquireTimeout();
      clearReleaseTimeout();
      stopCommandSender();
      forceNeutral();
      clearLease();
      setError(null);
      setStopReason(data.reason ?? null);

      if (stateRef.current !== "SUSPENDED") {
        setFrontendState(connectedJoystickState(socketConnectedRef.current));
      }
    },
    [
      clearAcquireTimeout,
      clearLease,
      clearReleaseTimeout,
      forceNeutral,
      setFrontendState,
      stopCommandSender,
    ]
  );

  const onSocketError = useCallback(
    (payload: unknown) => {
      const err = normalizeSocketError(payload);

      clearAcquireTimeout();
      clearReleaseTimeout();
      stopCommandSender();
      forceNeutral();
      clearLease();

      setError({
        type: "joystick_error",
        code: err.code as JoystickErrorCode,
        message: err.message,
      });
      onErrorMessage?.("Joystick error", err.message);

      if (err.code === "unauthorised" || err.code === "unauthorized") {
        setFrontendState("ERROR");
        return;
      }

      setFrontendState(connectedJoystickState(socketConnectedRef.current));
    },
    [
      clearAcquireTimeout,
      clearLease,
      clearReleaseTimeout,
      forceNeutral,
      onErrorMessage,
      setFrontendState,
      stopCommandSender,
    ]
  );

  const onSocketDisconnect = useCallback(() => {
    const plan = cleanupPlanForJoystick("disconnect", false);
    clearAcquireTimeout();
    clearReleaseTimeout();
    stopAndClearLocalControl();
    setFrontendState(plan.nextState ?? "DISCONNECTED");
    setError({
      type: "joystick_error",
      code: "unavailable",
      message: "Socket disconnected — re-acquire required",
    });
  }, [clearAcquireTimeout, clearReleaseTimeout, setFrontendState, stopAndClearLocalControl]);

  const reconcileTelemetry = useCallback(
    (telem: JoystickTelemetryFields) => {
      setLastCmdAgeMs(telem.joystick_last_valid_cmd_age_ms ?? null);
      if (telem.joystick_stop_reason) {
        setStopReason(telem.joystick_stop_reason);
      }

      if (telem.control_owner === "mission") {
        if (leaseIdRef.current || commandLoopRunningRef.current) {
          forceNeutral();
          stopCommandSender();
          clearLease();
        }
        clearReleaseTimeout();
        if (stateRef.current !== "BLOCKED_BY_MISSION") {
          setFrontendState("BLOCKED_BY_MISSION");
        }
        return;
      }

      const backendInactive = isBackendJoystickInactive(telem);

      if (
        backendInactive &&
        shouldRecoverFromInactiveTelemetry(stateRef.current, leaseIdRef.current !== null)
      ) {
        clearReleaseTimeout();
        stopCommandSender();
        forceNeutral();
        clearLease();
        setFrontendState(connectedJoystickState(socketConnectedRef.current));
        return;
      }

      if (
        telem.joystick_state === "inactive" &&
        telemetryInactiveClearsLocalLease(stateRef.current)
      ) {
        const plan = cleanupPlanForJoystick("telemetry_lease_loss", socketConnectedRef.current);
        clearReleaseTimeout();
        stopAndClearLocalControl();
        setFrontendState(plan.nextState ?? connectedJoystickState(socketConnectedRef.current));
      } else if (
        socketConnectedRef.current &&
        telem.connected !== false &&
        stateRef.current === "DISCONNECTED"
      ) {
        setFrontendState("AVAILABLE");
      } else if (!socketConnectedRef.current) {
        setFrontendState("DISCONNECTED");
      }
    },
    [
      clearLease,
      clearReleaseTimeout,
      forceNeutral,
      setFrontendState,
      stopAndClearLocalControl,
      stopCommandSender,
    ]
  );

  const acquire = useCallback(() => {
    const sock = socketRef.current;
    if (!sock?.connected) {
      handleJoystickError({
        type: "joystick_error",
        code: "unavailable",
        message: "Socket not connected",
      });
      return;
    }

    setError(null);
    stopCommandSender();
    forceNeutral();
    clearLease();
    setFrontendState("ACQUIRING");
    clearAcquireTimeout();
    acquireTimeoutRef.current = setTimeout(() => {
      if (stateRef.current !== "ACQUIRING") return;
      const plan = cleanupPlanForJoystick("command_timeout", socketConnectedRef.current);
      stopAndClearLocalControl();
      setFrontendState(plan.nextState ?? connectedJoystickState(socketConnectedRef.current));
      const timeoutError: JoystickErrorEvent = {
        type: "joystick_error",
        code: "acquire_cancelled",
        message: "Joystick acquire timed out before the backend granted a lease",
      };
      setError(timeoutError);
      onErrorMessage?.("Joystick error", timeoutError.message);
    }, ACQUIRE_TIMEOUT_MS);
    sock.emit("joystick_acquire", {
      auth: authTokenRef.current,
      session_id: sessionIdRef.current,
      client_monotonic_ms: clientMonotonicMs(),
    });
  }, [
    clearAcquireTimeout,
    clearLease,
    forceNeutral,
    handleJoystickError,
    onErrorMessage,
    setFrontendState,
    stopCommandSender,
    stopAndClearLocalControl,
  ]);

  const release = useCallback(() => {
    clearAcquireTimeout();
    forceNeutral();
    requestUrgentNeutralCommand();
    stopCommandSender();

    const lease = leaseIdRef.current;
    const sock = socketRef.current;

    if (!lease || !sock?.connected) {
      clearReleaseTimeout();
      clearLease();
      setFrontendState(connectedJoystickState(socketConnectedRef.current));
      return;
    }

    setFrontendState("RELEASING");
    sock.emit("joystick_release", {
      auth: authTokenRef.current,
      session_id: sessionIdRef.current,
      lease_id: lease,
    } satisfies JoystickReleaseRequest);
    startReleaseTimeout();
  }, [
    clearAcquireTimeout,
    clearLease,
    clearReleaseTimeout,
    forceNeutral,
    requestUrgentNeutralCommand,
    setFrontendState,
    startReleaseTimeout,
    stopCommandSender,
  ]);

  const setIntent = useCallback(
    (rawThrottle: number, rawSteering: number) => {
      const processed = processRawIntent(rawThrottle, rawSteering);
      latestThrottleRef.current = processed.throttle;
      latestSteeringRef.current = processed.steering;
      setDisplayIntent(processed);

      const hasLease = Boolean(leaseIdRef.current);
      const shouldDrive = joystickIntentDeadman(hasLease, processed);
      deadmanRef.current = shouldDrive;
      setDeadmanPressed(shouldDrive);

      if (!hasLease) return;

      if (shouldDrive) {
        // The command loop started in onAcquired is a self-perpetuating ~18Hz
        // heartbeat that reads deadmanRef/latestThrottleRef each tick — updating
        // those refs above is all that's needed to drive. Do NOT call
        // scheduleCommandLoop here: this runs on every gesture frame (~60-120Hz),
        // and scheduleCommandLoop cancels+restarts the pending heartbeat timer.
        // Under that flood the setTimeout(0) gets starved and never fires, so no
        // command reaches the backend and the lease is revoked (lease_timeout).
        // Only (re)start the loop if it isn't already running (transient recovery).
        if (!commandLoopRunningRef.current) {
          scheduleCommandLoop(0);
        }
      } else if (joystickIntentIsCentered(processed)) {
        requestUrgentNeutralCommand();
        if (stateRef.current === "ACTIVE") setFrontendState("HELD");
      }
    },
    [processRawIntent, requestUrgentNeutralCommand, scheduleCommandLoop, setFrontendState]
  );

  const setDeadman = useCallback(
    (pressed: boolean) => {
      deadmanRef.current = pressed;
      setDeadmanPressed(pressed);
      if (!pressed) {
        latestThrottleRef.current = 0;
        latestSteeringRef.current = 0;
        setDisplayIntent({ throttle: 0, steering: 0 });
        requestUrgentNeutralCommand();
        if (leaseIdRef.current) setFrontendState("HELD");
      } else if (leaseIdRef.current && !commandLoopRunningRef.current) {
        // Heartbeat already running picks up deadmanRef on its next tick; only
        // kick it if it somehow stopped while the lease is still held.
        scheduleCommandLoop(0);
      }
    },
    [requestUrgentNeutralCommand, scheduleCommandLoop, setFrontendState]
  );

  const handleBackground = useCallback(() => {
    const plan = cleanupPlanForJoystick("background", socketRef.current?.connected ?? false);
    clearAcquireTimeout();
    clearReleaseTimeout();
    forceNeutral();
    requestUrgentNeutralCommand();
    emitReleaseIfOwned();
    stopAndClearLocalControl();
    setFrontendState(plan.nextState ?? "SUSPENDED");
  }, [
    clearAcquireTimeout,
    clearReleaseTimeout,
    emitReleaseIfOwned,
    forceNeutral,
    requestUrgentNeutralCommand,
    setFrontendState,
    stopAndClearLocalControl,
  ]);

  const handleForeground = useCallback(() => {
    // Operator must explicitly re-acquire after backgrounding.
  }, []);

  const handleEStop = useCallback(() => {
    const plan = cleanupPlanForJoystick("estop", socketRef.current?.connected ?? false);
    clearAcquireTimeout();
    clearReleaseTimeout();
    forceNeutral();
    requestUrgentNeutralCommand();
    emitReleaseIfOwned();
    stopAndClearLocalControl();
    setFrontendState(plan.nextState ?? "DISABLED");
  }, [
    clearAcquireTimeout,
    clearReleaseTimeout,
    emitReleaseIfOwned,
    forceNeutral,
    requestUrgentNeutralCommand,
    setFrontendState,
    stopAndClearLocalControl,
  ]);

  useEffect(() => {
    const sock = socket;
    if (!sock) return;

    const onAcquiredEvent = (data: unknown) => {
      if (isJoystickAcquiredPayload(data)) onAcquired(data);
    };
    const onErrorEvent = (data: unknown) => {
      if (isJoystickErrorPayload(data)) handleJoystickError(data);
    };
    const onReleasedEvent = (data: unknown) => {
      if (isJoystickReleasedPayload(data)) onReleased(data);
    };
    const onDisconnect = () => onSocketDisconnect();
    const onSocketErrorEvent = (payload: unknown) => onSocketError(payload);

    sock.on("joystick_acquired", onAcquiredEvent);
    sock.on("joystick_error", onErrorEvent);
    sock.on("joystick_released", onReleasedEvent);
    sock.on("socket_error", onSocketErrorEvent);
    sock.on("disconnect", onDisconnect);

    return () => {
      sock.off("joystick_acquired", onAcquiredEvent);
      sock.off("joystick_error", onErrorEvent);
      sock.off("joystick_released", onReleasedEvent);
      sock.off("socket_error", onSocketErrorEvent);
      sock.off("disconnect", onDisconnect);
    };
  }, [socket, handleJoystickError, onAcquired, onReleased, onSocketDisconnect, onSocketError]);

  useEffect(() => {
    if (!socketConnected) {
      onSocketDisconnect();
      return;
    }
    if (stateRef.current === "DISCONNECTED") {
      setFrontendState("AVAILABLE");
    }
  }, [socketConnected, onSocketDisconnect, setFrontendState]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextAppState: AppStateStatus) => {
      if (nextAppState === "background" || nextAppState === "inactive") {
        handleBackground();
      } else if (nextAppState === "active") {
        handleForeground();
      }
    });
    return () => subscription.remove();
  }, [handleBackground, handleForeground]);

  useEffect(() => {
    return () => {
      clearAcquireTimeout();
      clearReleaseTimeout();
      forceNeutral();
      requestUrgentNeutralCommand();
      emitReleaseIfOwned();
      stopAndClearLocalControl();
    };
  }, [
    clearAcquireTimeout,
    clearReleaseTimeout,
    emitReleaseIfOwned,
    forceNeutral,
    requestUrgentNeutralCommand,
    stopAndClearLocalControl,
  ]);

  const joystickActive =
    state === "ACTIVE" || state === "HELD" || state === "ACQUIRING" || state === "RELEASING";

  return {
    state,
    error,
    leaseId,
    sessionId: sessionIdRef.current,
    maxThrottle,
    maxSteering,
    commandRateHz,
    lastCmdAgeMs,
    stopReason,
    deadmanPressed,
    displayIntent,
    joystickActive,
    acquire,
    release,
    setIntent,
    setDeadman,
    reconcileTelemetry,
    handleEStop,
    handleBackground,
    handleForeground,
  };
}
