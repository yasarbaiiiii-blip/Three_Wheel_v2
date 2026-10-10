/** New streamlined 4-step workflow IDs */
export type FieldsStepId = "boundingBox" | "upload" | "align" | "orderAndSpray";

/** Map-centric plan manipulation modes */
export type PlanManipulationMode = "idle" | "scale" | "drag" | "rotate" | "resize";

/**
 * Multi-Point Fit placement lifecycle after Move/Rotate Plan:
 * - idle: not editing
 * - placing: drag/rotate with a rigid ref-point magnet (translate + rotate only — never
 *   scale-to-fit; scale changes only via Fit to Reference Points or Resize); Resize available
 * - attached: a plan feature is pinned onto a ref point (same move UX as placing; Resize available)
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

/**
 * The operator-visible steps that can be verified or invalidated.
 * - alignment: the plan has a GPS origin (every file aligned).
 * - spray: the path order / paint flags (only ever invalidated, by an edit).
 * - staged: the mission is stored on the rover and verified (Send). Start does the rest; there is no load step.
 */
export type StagedWorkflowStep = "alignment" | "spray" | "staged";

export type StagedWorkflowStatus = "pending" | "verified" | "failed";

export type StagedWorkflowState = Record<StagedWorkflowStep, StagedWorkflowStatus>;

export const INITIAL_STAGED_WORKFLOW_STATE: StagedWorkflowState = {
  alignment: "pending",
  spray: "pending",
  staged: "pending",
};

/**
 * A change at `step` invalidates it and everything after it: a new alignment demotes spray and
 * the stored mission; an edit of the path order demotes the stored mission.
 */
export function invalidateWorkflowFrom<T extends StagedWorkflowState>(current: T, step: StagedWorkflowStep): T {
  const next = { ...current };
  if (step === "alignment") next.alignment = "pending";
  if (step === "alignment" || step === "spray") next.spray = "pending";
  next.staged = "pending";
  return next;
}

/** A surveyed reference point: plan position (dxf_x = east, dxf_y = north) and its GPS position. */
export type AlignRefPoint = {
  dxf_x: number;
  dxf_y: number;
  lat: number;
  lon: number;
};

/**
 * What a verified alignment produced. `origin_gps` is the GPS position of the plan's local (0, 0),
 * the mission anchor; `ref_points` are the points it was fitted on.
 */
export type VerifiedAlignment = {
  ref_points?: AlignRefPoint[];
  origin_gps?: [number, number];
  rotation_deg?: number;
};

export type AccordionStatus = StagedWorkflowStatus | "idle";

/** Local CSV PRE/AFT extension config (app state — never saved via /extensions). */
export type {
  CsvExtensionConfig,
} from "../utils/missionExtensions";

export {
  DEFAULT_CSV_EXTENSION_CONFIG,
  normalizeCsvExtensionConfig,
} from "../utils/missionExtensions";