/**
 * Presentational status for the Fields right-rail header.
 * Pure: same inputs always yield the same chips / CTA. Workflow gating stays in FieldsPage.
 */

export type FieldsOriginKind = "gps" | "auto" | "unanchored";
export type FieldsCtaId = "align" | "pathOrder" | "none";

export type FieldsRailStatus = {
  fileName: string;
  fileCount: number;
  readyDone: number;
  readyTotal: number;
  origin: FieldsOriginKind;
  ctaId: FieldsCtaId;
  ctaLabel: string;
};

export type FieldsRailStatusInput = {
  primaryFileName: string | null | undefined;
  fileCount: number;
  uploadDone: boolean;
  /** Align card is part of this flow (metric DXF / pending batch). */
  alignRequired: boolean;
  alignDone: boolean;
  templatesVisible: boolean;
  /** Upload (+ align) complete — Path Order can send. */
  pathOrderReady: boolean;
  stagedOrLoaded: boolean;
  autoOrigin: boolean;
  hasGpsOrigin: boolean;
};

export function deriveFieldsRailStatus(input: FieldsRailStatusInput): FieldsRailStatus {
  const trimmed = input.primaryFileName?.trim() ?? "";
  const fileName = trimmed.length > 0 ? trimmed : "No file";
  const fileCount = Number.isFinite(input.fileCount) ? Math.max(0, Math.floor(input.fileCount)) : 0;

  let readyTotal = 1;
  let readyDone = input.uploadDone ? 1 : 0;

  if (input.alignRequired) {
    readyTotal += 1;
    if (input.alignDone) readyDone += 1;
  }

  if (input.templatesVisible) {
    readyTotal += 1;
    // Optional step: counts as ready once the mission frame exists.
    if (input.uploadDone && (!input.alignRequired || input.alignDone)) readyDone += 1;
  }

  readyTotal += 1;
  if (input.pathOrderReady || input.stagedOrLoaded) readyDone += 1;

  readyDone = Math.min(readyDone, readyTotal);

  const origin: FieldsOriginKind = input.hasGpsOrigin
    ? "gps"
    : input.autoOrigin
      ? "auto"
      : "unanchored";

  let ctaId: FieldsCtaId = "none";
  let ctaLabel = "";
  if (input.uploadDone && input.alignRequired && !input.alignDone) {
    ctaId = "align";
    ctaLabel = "Align DXF";
  } else if (input.uploadDone && (!input.alignRequired || input.alignDone) && !input.stagedOrLoaded) {
    ctaId = "pathOrder";
    ctaLabel = "Send";
  }

  return { fileName, fileCount, readyDone, readyTotal, origin, ctaId, ctaLabel };
}

export function originChipLabel(origin: FieldsOriginKind): string {
  if (origin === "gps") return "Origin GPS";
  if (origin === "auto") return "Origin Auto";
  return "Origin unanchored";
}

export function readyChipLabel(done: number, total: number): string {
  if (total <= 0) return "0 of 0 ready";
  if (done >= total) return `${total} of ${total} ready`;
  return `${done} of ${total} ready`;
}
