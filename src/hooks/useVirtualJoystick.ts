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
import { processAxis } from "../utils/joystickMath";

const DEFAULT_MAX_THROTTLE = 0.15;
const DEFAULT_MAX_STEERING = 0.5;
const DEFAULT_COMMAND_RATE_HZ = 20;
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
  const commandTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startMonotonicMsRef = useRef(Date.now());

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

  const stopCommandSender = useCallback(() => {
    if (commandTimerRef.current !== null) {
      clearInterval(commandTimerRef.current);
      commandTimerRef.current = null;
    }
  }, []);

  const processRawIntent = useCallback((throttle: number, steering: number): JoystickIntent => {
    return {
      throttle: processAxis(throttle, DEAD_ZONE, RESPONSE_CURVE, maxThrottleRef.current),
      steering: processAxis(steering, DEAD_ZONE, RESPONSE_CURVE, maxSteeringRef.current),
    };
  }, []);

  const emitCommand = useCallback((payload: JoystickCommandRequest) => {
    const sock = socketRef.current;
    if (!sock?.connected) return;
    sock.emit("joystick_command", payload);
  }, []);

  const sendImmediateNeutralDeadmanFrame = useCallback(() => {
    const lease = leaseIdRef.current;
    const session = sessionIdRef.current;
    if (!lease || !session) return;

    const seq = ++sequenceRef.current;
    emitCommand({
      auth: authTokenRef.current,
      session_id: session,
      lease_id: lease,
      sequence: seq,
      client_monotonic_ms: Date.now() - startMonotonicMsRef.current,
      deadman: false,
      throttle: 0,
      steering: 0,
    });
  }, [emitCommand]);

  const startCommandSender = useCallback(
    (rateHz: number) => {
      stopCommandSender();
      const intervalMs = Math.max(1, Math.round(1000 / rateHz));

      commandTimerRef.current = setInterval(() => {
        const lease = leaseIdRef.current;
        const session = sessionIdRef.current;
        if (!lease || !session) return;

        const seq = ++sequenceRef.current;
        const deadman = deadmanRef.current;
        emitCommand({
          auth: authTokenRef.current,
          session_id: session,
          lease_id: lease,
          sequence: seq,
          client_monotonic_ms: Date.now() - startMonotonicMsRef.current,
          deadman,
          throttle: deadman ? latestThrottleRef.current : 0,
          steering: deadman ? latestSteeringRef.current : 0,
        });
      }, intervalMs);
    },
    [emitCommand, stopCommandSender]
  );

  const clearLease = useCallback(() => {
    leaseIdRef.current = null;
    sequenceRef.current = 0;
    setLeaseId(null);
  }, []);

  const forceNeutral = useCallback(() => {
    latestThrottleRef.current = 0;
    latestSteeringRef.current = 0;
    deadmanRef.current = false;
    setDeadmanPressed(false);
    setDisplayIntent({ throttle: 0, steering: 0 });
  }, []);

  const handleJoystickError = useCallback(
    (err: JoystickErrorEvent) => {
      const shouldClearLease = [
        "not_owner",
        "lease_inactive",
        "mode_unavailable",
        "fcu_disconnected",
        "not_armed",
        "unavailable",
        "acquire_cancelled",
      ].includes(err.code);
      const shouldStopSender = [
        "lease_inactive",
        "not_owner",
        "mode_unavailable",
        "fcu_disconnected",
        "transport_unavailable",
        "acquire_cancelled",
      ].includes(err.code);
      const requiresReacquire = ["not_owner", "lease_inactive", "acquire_cancelled"].includes(err.code);
      const shouldForceNeutral = ["nan_value", "out_of_range", "transport_unavailable"].includes(err.code);

      if (shouldClearLease) clearLease();
      if (shouldStopSender) stopCommandSender();
      if (shouldForceNeutral) forceNeutral();
      if (requiresReacquire) setFrontendState("AVAILABLE");

      setError(err);
      onErrorMessage?.(
        "Joystick error",
        err.message || ERROR_MESSAGES[err.code] || err.code
      );
    },
    [clearLease, forceNeutral, onErrorMessage, setFrontendState, stopCommandSender]
  );

  const onAcquired = useCallback(
    (data: JoystickAcquiredResponse) => {
      leaseIdRef.current = data.lease_id;
      sequenceRef.current = 0;
      maxThrottleRef.current = data.max_throttle;
      maxSteeringRef.current = data.max_steering;
      commandRateHzRef.current = data.command_rate_hz;
      startMonotonicMsRef.current = Date.now();

      setLeaseId(data.lease_id);
      setMaxThrottle(data.max_throttle);
      setMaxSteering(data.max_steering);
      setCommandRateHz(data.command_rate_hz);
      setError(null);
      setFrontendState("HELD");
      startCommandSender(data.command_rate_hz);
    },
    [setFrontendState, startCommandSender]
  );

  const onReleased = useCallback(
    (_data: JoystickReleasedResponse) => {
      stopCommandSender();
      forceNeutral();
      clearLease();
      setError(null);
      setStopReason(_data.reason ?? null);
      setFrontendState(socketConnected ? "AVAILABLE" : "DISCONNECTED");
    },
    [clearLease, forceNeutral, setFrontendState, socketConnected, stopCommandSender]
  );

  const onSocketDisconnect = useCallback(() => {
    stopCommandSender();
    forceNeutral();
    clearLease();
    setFrontendState("DISCONNECTED");
    setError({
      type: "joystick_error",
      code: "unavailable",
      message: "Socket disconnected — re-acquire required",
    });
  }, [clearLease, forceNeutral, setFrontendState, stopCommandSender]);

  const reconcileTelemetry = useCallback(
    (telem: JoystickTelemetryFields) => {
      setLastCmdAgeMs(telem.joystick_last_valid_cmd_age_ms ?? null);
      if (telem.joystick_stop_reason) {
        setStopReason(telem.joystick_stop_reason);
      }

      if (telem.control_owner === "mission") {
        if (stateRef.current !== "BLOCKED_BY_MISSION") {
          setFrontendState("BLOCKED_BY_MISSION");
        }
        return;
      }

      if (
        stateRef.current === "BLOCKED_BY_MISSION" &&
        telem.control_owner === "idle" &&
        socketConnected
      ) {
        setFrontendState("AVAILABLE");
      }

      if (
        telem.joystick_state === "inactive" &&
        (stateRef.current === "ACTIVE" ||
          stateRef.current === "HELD" ||
          stateRef.current === "ACQUIRING" ||
          stateRef.current === "RELEASING")
      ) {
        stopCommandSender();
        forceNeutral();
        clearLease();
        setFrontendState(socketConnected ? "AVAILABLE" : "DISCONNECTED");
      } else if (
        socketConnected &&
        telem.connected !== false &&
        stateRef.current === "DISCONNECTED"
      ) {
        setFrontendState("AVAILABLE");
      } else if (!socketConnected) {
        setFrontendState("DISCONNECTED");
      } else if (
        socketConnected &&
        (stateRef.current === "DISABLED" || stateRef.current === "DISCONNECTED")
      ) {
        setFrontendState("AVAILABLE");
      }
    },
    [clearLease, forceNeutral, setFrontendState, socketConnected, stopCommandSender]
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
    setFrontendState("ACQUIRING");
    sock.emit("joystick_acquire", {
      auth: authTokenRef.current,
      session_id: sessionIdRef.current,
      client_monotonic_ms: Date.now() - startMonotonicMsRef.current,
    });
  }, [handleJoystickError, setFrontendState]);

  const release = useCallback(() => {
    const sock = socketRef.current;
    const lease = leaseIdRef.current;
    if (!sock?.connected || !lease) {
      stopCommandSender();
      forceNeutral();
      clearLease();
      setFrontendState(socketConnected ? "AVAILABLE" : "DISCONNECTED");
      return;
    }

    setFrontendState("RELEASING");
    stopCommandSender();
    forceNeutral();

    const payload: JoystickReleaseRequest = {
      auth: authTokenRef.current,
      session_id: sessionIdRef.current,
      lease_id: lease,
    };
    sock.emit("joystick_release", payload);
  }, [clearLease, forceNeutral, setFrontendState, socketConnected, stopCommandSender]);

  const setIntent = useCallback(
    (rawThrottle: number, rawSteering: number) => {
      const processed = processRawIntent(rawThrottle, rawSteering);
      latestThrottleRef.current = processed.throttle;
      latestSteeringRef.current = processed.steering;
      setDisplayIntent(processed);
    },
    [processRawIntent]
  );

  const setDeadman = useCallback(
    (pressed: boolean) => {
      deadmanRef.current = pressed;
      setDeadmanPressed(pressed);
      if (!pressed) {
        latestThrottleRef.current = 0;
        latestSteeringRef.current = 0;
        setDisplayIntent({ throttle: 0, steering: 0 });
        sendImmediateNeutralDeadmanFrame();
        if (leaseIdRef.current) setFrontendState("HELD");
      } else if (leaseIdRef.current) {
        setFrontendState("ACTIVE");
      }
    },
    [sendImmediateNeutralDeadmanFrame, setFrontendState]
  );

  const handleBackground = useCallback(() => {
    sendImmediateNeutralDeadmanFrame();
    release();
    setFrontendState("DISCONNECTED");
  }, [release, sendImmediateNeutralDeadmanFrame, setFrontendState]);

  const handleForeground = useCallback(() => {
    // Operator must explicitly re-acquire after backgrounding.
  }, []);

  const handleEStop = useCallback(() => {
    stopCommandSender();
    forceNeutral();
    const sock = socketRef.current;
    const lease = leaseIdRef.current;
    if (sock?.connected && lease) {
      sock.emit("joystick_release", {
        auth: authTokenRef.current,
        session_id: sessionIdRef.current,
        lease_id: lease,
      } satisfies JoystickReleaseRequest);
    }
    clearLease();
    setFrontendState("DISABLED");
  }, [clearLease, forceNeutral, setFrontendState, stopCommandSender]);

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

    sock.on("joystick_acquired", onAcquiredEvent);
    sock.on("joystick_error", onErrorEvent);
    sock.on("joystick_released", onReleasedEvent);
    sock.on("disconnect", onDisconnect);

    return () => {
      sock.off("joystick_acquired", onAcquiredEvent);
      sock.off("joystick_error", onErrorEvent);
      sock.off("joystick_released", onReleasedEvent);
      sock.off("disconnect", onDisconnect);
    };
  }, [socket, handleJoystickError, onAcquired, onReleased, onSocketDisconnect]);

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
      stopCommandSender();
      forceNeutral();
      clearLease();
    };
  }, [clearLease, forceNeutral, stopCommandSender]);

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