/**
 * Per-file tracking for local multi-type uploads (CSV + metric DXF + geo-DXF).
 * Mission geometry stays a flat PlanLine[]; identity uses lineIdPrefix on ids.
 */

export type UploadedFileStatus = "verified" | "needs_alignment";

export type UploadedFileKind = "csv" | "dxf";

export type UploadedFileVerifiedSummary = {
  scale: number | null;
  rotationDeg: number | null;
  rmseM: number | null;
};

export type UploadedFileEntry = {
  /** Stable id for this pick, e.g. `${stem}-${prefix}` */
  id: string;
  fileName: string;
  kind: UploadedFileKind;
  /** DXF georef, or CSV with GPS anchor (geo-equivalent). */
  isGeographic: boolean;
  status: UploadedFileStatus;
  /** Prefix applied to PlanLine ids from this file (`${prefix}__…`). */
  lineIdPrefix: string;
  verifiedSummary?: UploadedFileVerifiedSummary;
};

/** Metric DXF geometry held until Fix Alignment commits it into mission lines. */
export type PendingDxfAlignmentEntry = {
  fileName: string;
  rawLines: import("./plan").PlanLine[];
};
