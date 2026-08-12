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

export type RTKMode = "idle" | "ntrip" | "lora" | "stopping";
