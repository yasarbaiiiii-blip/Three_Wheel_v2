import type { PlanLine, TelemetrySnapshot } from "../types/plan";
import type { AutoOriginReference } from "../types/autoOrigin";
import { getPlanStartPoint, sanitizePlanLines } from "./planGeometry";
import {
  transformPlanLinesGeometry,
  translationTransform,
} from "./planLineTransform";

export type { AutoOriginReference } from "../types/autoOrigin";

export function hasValidNedTelemetry(telemetry: TelemetrySnapshot | null | undefined): boolean {
  return (
    telemetry != null &&
    Number.isFinite(telemetry.pos_n) &&
    Number.isFinite(telemetry.pos_e)
  );
}

/** Minimum 3D GPS fix — matches frontend GPS status thresholds. */
export function hasValidGpsForAutoOrigin(telemetry: TelemetrySnapshot | null | undefined): boolean {
  return (
    telemetry != null &&
    Number.isFinite(telemetry.lat) &&
    Number.isFinite(telemetry.lon) &&
    telemetry.gps_fix != null &&
    telemetry.gps_fix >= 3
  );
}

export function hasValidNedAndGps(telemetry: TelemetrySnapshot | null | undefined): boolean {
  return hasValidNedTelemetry(telemetry) && hasValidGpsForAutoOrigin(telemetry);
}

export function isValidAutoOriginReference(
  reference: AutoOriginReference | null | undefined
): reference is AutoOriginReference {
  if (!reference) return false;
  return (
    Number.isFinite(reference.planStartNorth) &&
    Number.isFinite(reference.planStartEast) &&
    Number.isFinite(reference.roverNorth) &&
    Number.isFinite(reference.roverEast) &&
    Number.isFinite(reference.latitude) &&
    Number.isFinite(reference.longitude) &&
    Number.isFinite(reference.capturedAtMs)
  );
}

export function buildAutoOriginReference(
  lines: PlanLine[],
  telemetry: TelemetrySnapshot | null | undefined,
  capturedAtMs: number = Date.now()
): AutoOriginReference | null {
  const baseLines = sanitizePlanLines(lines);
  const start = getPlanStartPoint(baseLines);
  if (!start || !hasValidNedAndGps(telemetry)) {
    return null;
  }

  return {
    planStartNorth: start.north,
    planStartEast: start.east,
    roverNorth: telemetry!.pos_n as number,
    roverEast: telemetry!.pos_e as number,
    latitude: telemetry!.lat as number,
    longitude: telemetry!.lon as number,
    capturedAtMs,
  };
}

export function applyAutoOriginShift(
  lines: PlanLine[],
  reference: AutoOriginReference
): PlanLine[] {
  const dN = reference.roverNorth - reference.planStartNorth;
  const dE = reference.roverEast - reference.planStartEast;
  // Shared bake: from/to + preview_points + entity.geometry center (circles/arcs).
  return transformPlanLinesGeometry(lines, translationTransform(dN, dE));
}

export function planStartMatchesReference(
  lines: PlanLine[],
  reference: AutoOriginReference | null | undefined
): boolean {
  if (!reference) return true;
  const start = getPlanStartPoint(sanitizePlanLines(lines));
  if (!start) return false;
  return (
    start.north === reference.planStartNorth && start.east === reference.planStartEast
  );
}