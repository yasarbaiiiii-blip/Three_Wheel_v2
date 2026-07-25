/** New streamlined 4-step workflow IDs */
export type FieldsStepId = "templates" | "upload" | "align" | "orderAndSpray";

/** Map-centric plan manipulation modes */
export type PlanManipulationMode = "idle" | "scale" | "drag" | "rotate" | "resize";

/**
 * Multi-Point Fit placement lifecycle after Move/Rotate Plan:
 * - idle: not editing
 * - placing: drag/rotate; magnetic similarity scale-to-fit toward refs; Resize available
 * - attached: dual-ref attach acquired (same move UX as placing; Resize available)
 * - resizing: edge-midpoint arrows only; drag/rotate off; Done returns to placing
 * - captured: Use This Position completed
 */
export type MultiPointPlacementPhase =
  | "idle"
  | "placing"
  | "attached"
  | "resizing"
  | "captured";

/** Real-time transform HUD data shown above the plan on the map */
export type TransformHUDData = {
  scaleMultiplier: number;
  /** Bounding box width in meters */
  boundingWidthM: number;
  /** Bounding box height in meters */
  boundingHeightM: number;
  rotationDeg: number;
  offsetMeters: { x: number; y: number };
};

/** @deprecated Use FieldsStepId instead — kept for backward compat during refactor */
export type FieldsAccordionId =
  | "upload"
  | "templates"
  | "planPreview"
  | "planEditing"
  | "pathOrder"
  | "alignDxf"
  | "sprayVerify"
  | "segmentVerify"
  | "planStage";

export type AlignmentResultState = {
  method: unknown;
  scale: number | null;
  rotation_deg: number | null;
  offset_n: number | null;
  offset_e: number | null;
  origin_gps: unknown;
  rmse_m: number | null;
  sample_coords: unknown;
  residuals: unknown;
  warnings: unknown;
};

export type StagedPlanResultState = {
  missionId: string;
  numWaypoints: number | null;
  numSegments: number | null;
  totalLengthM: number | null;
  markLengthM: number | null;
  transitLengthM: number | null;
  estimatedPaintL: number | null;
  estimatedRuntimeS: number | null;
  rmseM: number | null;
  warnings: string[];
};

export type StagedWorkflowStep =
  | "upload"
  | "entities"
  | "order"
  | "alignment"
  | "spray"
  | "staged"
  | "loaded"
  | "started";

export type StagedWorkflowStatus = "pending" | "verified" | "failed";

export type StagedWorkflowState = Record<StagedWorkflowStep, StagedWorkflowStatus>;

export const INITIAL_STAGED_WORKFLOW_STATE: StagedWorkflowState = {
  upload: "pending",
  entities: "pending",
  order: "pending",
  alignment: "pending",
  spray: "pending",
  staged: "pending",
  loaded: "pending",
  started: "pending",
};

export type AccordionStatus = StagedWorkflowStatus | "idle";