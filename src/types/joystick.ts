export type JoystickErrorCode =
  | "manual_control_disabled"
  | "malformed"
  | "mode_unavailable"
  | "fcu_disconnected"
  | "not_armed"
  | "not_owner"
  | "mission_active"
  | "joystick_active"
  | "acquire_cancelled"
  | "unavailable"
  | "lease_inactive"
  | "transport_unavailable"
  | "out_of_order"
  | "replay"
  | "rate_exceeded"
  | "nan_value"
  | "out_of_range";

export interface JoystickAcquireRequest {
  auth: string;
  session_id: string;
  client_monotonic_ms: number;
}

export interface JoystickAcquiredResponse {
  type: "joystick_acquired";
  lease_id: string;
  state: "active";
  command_rate_hz: number;
  server_stop_timeout_ms: number;
  gateway_stop_timeout_ms: number;
  max_throttle: number;
  max_steering: number;
}

export interface JoystickCommandRequest {
  auth: string;
  session_id: string;
  lease_id: string;
  sequence: number;
  client_monotonic_ms: number;
  deadman: boolean;
  throttle: number;
  steering: number;
}

export interface JoystickReleaseRequest {
  auth: string;
  session_id: string;
  lease_id: string;
}

export interface JoystickReleasedResponse {
  type: "joystick_released";
  state: "inactive";
  reason: string;
}

export interface JoystickErrorEvent {
  type: "joystick_error";
  code: JoystickErrorCode;
  message: string;
}

export type FrontendJoystickState =
  | "DISABLED"
  | "DISCONNECTED"
  | "SUSPENDED"
  | "AVAILABLE"
  | "ACQUIRING"
  | "ACTIVE"
  | "HELD"
  | "RELEASING"
  | "BLOCKED_BY_MISSION"
  | "ERROR";

export interface JoystickTelemetryFields {
  joystick_state?: string | null;
  joystick_active?: boolean | null;
  joystick_owner_present?: boolean | null;
  joystick_has_lease?: boolean | null;
  joystick_last_valid_cmd_age_ms?: number | null;
  joystick_deadman?: boolean | null;
  joystick_commanded_throttle?: number | null;
  joystick_commanded_steering?: number | null;
  joystick_stop_reason?: string | null;
  control_owner?: string | null;
  joystick_owned?: boolean | null;
  gateway_active?: boolean | null;
  gateway_command_age_ms?: number | null;
  gateway_last_send_age_ms?: number | null;
  transport_healthy?: boolean | null;
  transport_error?: string | null;
  connected?: boolean | null;
  armed?: boolean | null;
  mode?: string | null;
}

export type JoystickIntent = {
  throttle: number;
  steering: number;
};
