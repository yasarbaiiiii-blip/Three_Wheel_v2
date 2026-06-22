export type PlanLayer = "boundary" | "marking" | "center" | "transit" | "extension";
export type SidebarPanel = "import" | "details" | "mission" | "view" | "positioning" | "settings";
export type MarkingStyle = "straight" | "dotted" | "dashed";

export interface PlanPoint {
  id: number;
  x: number;
  y: number;
}

export interface PlanLine {
  id: string;
  label: string;
  layer: PlanLayer;
  from: PlanPoint;
  to: PlanPoint;
  width: number;
  is_mark?: boolean;
  entity?: DxfEntity;
}

export interface DxfPoint {
  north: number;
  east: number;
}

export interface DxfEntity {
  entity_id: string;
  entity_type: string;
  layer: string;
  color: number;
  is_mark: boolean;
  length_m: number;
  geometry: any;
  preview_points: DxfPoint[];
  extension_preview?: {
    enabled: boolean;
    pre_length_m: number;
    aft_length_m: number;
    pre_points: DxfPoint[];
    aft_points: DxfPoint[];
  };
}

export interface DxfEntitiesResponse {
  name: string;
  frame: string;
  num_entities: number;
  bounds: {
    north_min: number;
    north_max: number;
    east_min: number;
    east_max: number;
  };
  extension_config?: {
    enabled: boolean;
    pre_extension_m: number;
    aft_extension_m: number;
  };
  transit_preview?: {
    from_entity_id: string;
    to_entity_id: string;
    length_m: number;
    points: DxfPoint[];
  }[];
  entities: DxfEntity[];
}

export interface ImportedPlan {
  fileName: string;
  uri: string;
  fileType: "csv" | "dxf" | "waypoints";
  source?: "imported" | "generated" | "builtin";
}

export interface LayerVisibility {
  boundary: boolean;
  marking: boolean;
  center: boolean;
  transit: boolean;
  extension: boolean;
}

export type Page = "connection" | "home" | "fields" | "templates" | "swozi" | "status" | "positioning" | "settings" | "howto" | "about";

export interface TelemetrySnapshot {
  pos_n?: number | null;
  pos_e?: number | null;
  heading_ned_deg?: number | null;
  xtrack_m?: number | null;
  heading_err_deg?: number | null;
  lookahead_m?: number | null;
  speed_m_s?: number | null;
  kappa?: number | null;
  dist_to_goal_m?: number | null;
  pose_age_ms?: number | null;
  rpp_state?: number | null;
  rpp_state_name?: string | null;
  armed?: boolean | null;
  mode?: string | null;
  connected?: boolean | null;
  battery_v?: number | null;
  battery_pct?: number | null;
  gps_fix?: number | null;
  gps_sat?: number | null;
  lat?: number | null;
  lon?: number | null;
  alt?: number | null;
  mission_state?: string | null;
  hrms?: number | null;
  vrms?: number | null;
}

