export type PlanLayer = "boundary" | "marking" | "center" | "transit" | "extension" | "virtual_boundary";
export type SidebarPanel = "import" | "details" | "mission" | "view" | "positioning" | "settings";
export type MarkingStyle = "straight" | "dotted" | "dashed";

export interface PlanPoint {
  id: number;
  x: number;
  y: number;
}

/**
 * Path-segment role for synthetic / runtime legs.
 * - `pre` / `aft`: extension run-up / run-out (must not appear under Path Order Transit)
 * - `none`: ordinary inter-shape transit (or unset on older lines)
 */
export type PlanSegmentRole = "pre" | "aft" | "none";

export interface PlanLine {
  id: string;
  label: string;
  layer: PlanLayer;
  from: PlanPoint;
  to: PlanPoint;
  width: number;
  is_mark?: boolean;
  entity?: DxfEntity;
  /** Set when the client classifies a leg as extension pre/aft vs inter-shape transit. */
  segmentRole?: PlanSegmentRole;
  /**
   * Mission Layer this line belongs to, recovered by geometry matching after a
   * stage/hydrate round trip strips the file-prefixed id (see tagLinesWithMissionLayer
   * in missionLayerLines.ts). Absent on freshly-imported lines, which resolve their
   * layer via lineIdPrefix instead.
   */
  missionLayerId?: string | null;
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
  is_geographic?: boolean;
  geo_origin?: [number, number] | null;
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
  /** Whether the rover marker itself is shown. Defaults to visible when omitted. */
  rover?: boolean;
  /**
   * Guide / CSV / multi-point ref markers (gold pins + labels).
   * Defaults to visible when omitted.
   */
  refPoints?: boolean;
  /**
   * Per-path length labels ("12.34 m" beside each plan line).
   *
   * NOTE the inverted default: unlike every other flag here, this one is HIDDEN unless
   * explicitly `true`. A plan with many segments prints a length beside each one, which
   * buries the geometry itself — so path details are opt-in via the Layers ▸ Lengths
   * checkbox rather than something the operator has to turn off. Read it as
   * `lengths === true`, never `lengths !== false`.
   */
  lengths?: boolean;
  /**
   * Per-geometry-type visibility for plan segments (keyed by normalizeCurveEntityType,
   * e.g. "line" | "arc" | "circle"). A type missing from the map is treated as visible —
   * this only needs to record explicit opt-outs.
   */
  segmentTypes?: Record<string, boolean>;
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
  /** Actual rover horizontal speed from MAVROS velocity_local. */
  measured_speed_m_s?: number | null;
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
  /** Human-readable GPS fix type name from API, e.g. "RTK Fixed", "Float", "No Fix" */
  gps_fix_name?: string | null;
  gps_sat?: number | null;
  lat?: number | null;
  lon?: number | null;
  alt?: number | null;
  mission_state?: string | null;
  hrms?: number | null;
  vrms?: number | null;
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
  gateway_last_frame?: { x: number; y: number; z: number; r: number; buttons: number } | null;
  gateway_last_sent_neutral?: boolean | null;
  transport?: string | null;
  transport_healthy?: boolean | null;
  transport_error?: string | null;
  // Additional fields from /api/telemetry/latest
  along_track_speed_mps?: number | null;
  cross_track_speed_mps?: number | null;
  projection_segment_index?: number | null;
  gps_safety_ok?: boolean | null;
  manual_resume_required?: boolean | null;
}

