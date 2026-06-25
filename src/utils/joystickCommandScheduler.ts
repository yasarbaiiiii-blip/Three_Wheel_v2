import type { JoystickCommandRequest } from "../types/joystick";

export const DEFAULT_SAFE_COMMAND_INTERVAL_MS = 55;

export type JoystickCommandSession = {
  auth: string;
  sessionId: string;
  leaseId: string | null;
  commandRateHz: number;
  maxThrottle: number;
  maxSteering: number;
};

export type JoystickCommandIntent = {
  deadman: boolean;
  throttle: number;
  steering: number;
};

export type JoystickCommandSendResult =
  | { emitted: true; payload: JoystickCommandRequest; sequence: number }
  | { emitted: false; reason: "no_lease" | "invalid_value" | "too_soon"; nextAllowedMs?: number };

export function safeCommandIntervalMs(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) return DEFAULT_SAFE_COMMAND_INTERVAL_MS;
  return Math.max(DEFAULT_SAFE_COMMAND_INTERVAL_MS, Math.ceil(1000 / rateHz) + 5);
}

function clamp(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  const absLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1) : 1;
  return Math.min(absLimit, Math.max(-absLimit, value));
}

export class JoystickCommandSerializer {
  private sequence = 0;
  private lastSendMonoMs: number | null = null;

  reset(): void {
    this.sequence = 0;
    this.lastSendMonoMs = null;
  }

  getSequence(): number {
    return this.sequence;
  }

  getLastSendMonoMs(): number | null {
    return this.lastSendMonoMs;
  }

  nextAllowedMs(session: Pick<JoystickCommandSession, "commandRateHz">): number {
    if (this.lastSendMonoMs === null) return 0;
    return this.lastSendMonoMs + safeCommandIntervalMs(session.commandRateHz);
  }

  build(
    session: JoystickCommandSession,
    intent: JoystickCommandIntent,
    clientMonotonicMs: number
  ): JoystickCommandSendResult {
    if (!session.leaseId || !session.sessionId) {
      return { emitted: false, reason: "no_lease" };
    }

    const now = Math.max(0, Math.floor(clientMonotonicMs));
    const nextAllowed = this.nextAllowedMs(session);
    if (now < nextAllowed) {
      return { emitted: false, reason: "too_soon", nextAllowedMs: nextAllowed };
    }

    if (!Number.isFinite(intent.throttle) || !Number.isFinite(intent.steering)) {
      return { emitted: false, reason: "invalid_value" };
    }

    const deadman = intent.deadman;
    const throttle = deadman ? clamp(intent.throttle, session.maxThrottle) : 0;
    const steering = deadman ? clamp(intent.steering, session.maxSteering) : 0;
    const sequence = this.sequence + 1;
    const payload: JoystickCommandRequest = {
      auth: session.auth,
      session_id: session.sessionId,
      lease_id: session.leaseId,
      sequence,
      client_monotonic_ms: now,
      deadman,
      throttle,
      steering,
    };

    this.sequence = sequence;
    this.lastSendMonoMs = now;
    return { emitted: true, payload, sequence };
  }
}
