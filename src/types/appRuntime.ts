export type DiscoveredRover = {
  id: string;
  name: string;
  host: string;
  port: number;
  version?: string;
  responseTime?: number;
};

export type SystemHealth = {
  ros_node?: boolean;
  fcu_connected?: boolean;
  armed?: boolean;
  mode?: string;
  rpp_state?: string | number | null;
  pose_age_ms?: number | null;
  mission_state?: string | null;
};

export type ActivityEntry = {
  timestamp: string;
  level: string;
  message: string;
};

export type ToastTone = "info" | "success" | "warning" | "error";
export type AppToast = {
  id: number;
  title: string;
  message: string;
  tone: ToastTone;
};

export type RTKBackendMode = "idle" | "ntrip" | "lora";
export type RTKSourceState =
  | "idle"
  | "starting"
  | "connected"
  | "streaming"
  | "reconnecting"
  | "restarting"
  | "unavailable"
  | "error"
  | "running"
  | "stopping";

export type RTKStatus = {
  mode: RTKBackendMode;
  desired_mode: RTKBackendMode;
  pid: number | null;
  running: boolean;
  healthy: boolean;
  source_state: RTKSourceState;
  frames: number;
  bytes: number;
  last_frame_age_s: number | null;
  last_error: string | null;
  supervisor_restarts: number;
  active_profile_id: string | null;
  active_profile_revision: number | null;
};

export type NtripProfile = {
  id: string;
  revision: number;
  name: string;
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  password_configured: boolean;
  is_default: boolean;
  is_active: boolean;
  pending_apply: boolean;
  created_at: string | null;
  updated_at: string | null;
};

export type NtripProfileRegistry = {
  schema_version: number;
  registry_revision: number;
  default_profile_id: string | null;
  active_profile_id: string | null;
  migration_warning: string | null;
  profiles: NtripProfile[];
};

export type NtripProfileCreateInput = {
  name: string;
  host: string;
  port: number;
  mountpoint: string;
  username: string;
  /** Write-only. The backend never returns this value. */
  password: string;
};

export type NtripProfileUpdateInput = Partial<Omit<NtripProfileCreateInput, "password">> & {
  /** Omit to retain the saved password. Empty strings are never sent. */
  password?: string;
};
