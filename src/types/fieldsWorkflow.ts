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