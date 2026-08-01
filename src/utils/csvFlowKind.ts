/**
 * Which of the two CSV flows a selected path belongs to.
 *
 * Both arrive as `fileType: "csv"`, but they are entirely different journeys:
 *
 * - **local point CSV** — parsed on-device, previewed locally, NEVER uploaded,
 *   staged or driven. It must not show the Path Order & Load step.
 * - **pre-line survey CSV** — uploaded to the rover, previewed through the
 *   backend planner, staged via plan-and-stage and driven. It MUST show that
 *   step; it is the only way to get a survey line onto the controller.
 *
 * Conflating them is not hypothetical: `isLocalCsvFlow` was
 * `localCsvPreview != null || fileType === "csv"`, which made every pre-line CSV
 * look local and hid the load step, so a surveyed line could be previewed but
 * never actually loaded to the rover.
 */
export type CsvFlowKind = "local-point-csv" | "pre-line-survey-csv" | "not-csv";

export function classifyCsvFlow(args: {
  /** Non-null when the on-device point-CSV parser produced a preview. */
  localCsvPreview: unknown | null | undefined;
  /** importedPlan.fileType, if a plan is imported. */
  fileType: string | null | undefined;
  /** The operator's "Pre-line CSV (survey line)" toggle. */
  preLineCsvMode: boolean;
}): CsvFlowKind {
  // A local preview is decisive: only the on-device parser produces one.
  if (args.localCsvPreview != null) return "local-point-csv";
  if (args.fileType !== "csv") return "not-csv";
  return args.preLineCsvMode ? "pre-line-survey-csv" : "local-point-csv";
}

/** True when the Path Order & Load step must be hidden. */
export function hidesLoadStep(kind: CsvFlowKind): boolean {
  return kind === "local-point-csv";
}

/**
 * Paths that may use GET/POST /api/path/{name}/extensions (A16).
 * DXF always; survey CSV only in pre-line mode (local point CSV must not).
 */
export function isExtendablePathName(
  fileName: string | null | undefined,
  preLineCsvMode: boolean
): boolean {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".dxf")) return true;
  if (lower.endsWith(".csv") && preLineCsvMode) return true;
  return false;
}
