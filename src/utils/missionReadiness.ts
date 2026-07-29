/**
 * Geometry / parse readiness for Path Order and Send-to-Rover.
 *
 * Contract: non-paintable painted paths must never reach the rover unless the
 * operator explicitly skips them or acknowledges the risk. Parse-frame warnings
 * that can place a mission in the wrong place also require acknowledgement.
 *
 * Renamed from csvGeometryReadiness.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";
import type { CsvPathOrderEntry } from "./missionPathOrder";
import { resolveOrderedPaintedLines, selectMarkPlanLines } from "./missionPathOrder";

export type LineFitMeta = {
  lineId: string;
  label: string;
  /** False when geometry layer marked the path undrivable / invalid. Undefined treated as true (legacy). */
  paintable: boolean;
  warnings: string[];
  mode?: string;
  maxJointTurnDeg?: number;
};

export type CsvSendReadiness = {
  /** True when Send may proceed without further acknowledgement. */
  canSend: boolean;
  /** Hard blockers (cannot override without changing order/paint). Empty when only ack needed. */
  hardBlocks: string[];
  /** Soft blockers cleared by operator acknowledgement. */
  needsAck: string[];
  /** Non-blocking notices (always show, never stop Send alone). */
  advisory: string[];
  /** Painted mark paths with paintable === false. */
  nonPaintablePainted: LineFitMeta[];
  /** All mark lines that carry fit warnings. */
  linesWithWarnings: LineFitMeta[];
  /** Still need geometry risk acknowledgement. */
  needsGeometryAck: boolean;
  /** Still need parse/frame acknowledgement. */
  needsParseAck: boolean;
  /** Critical parse warnings (for UI). */
  criticalParseWarnings: string[];
};

/** Extract fit metadata from a plan line's geometry blob. */
export function getLineFitMeta(line: PlanLine): LineFitMeta {
  const geom = line.entity?.geometry;
  const rawWarnings = geom?.fit_warnings;
  const warnings = Array.isArray(rawWarnings)
    ? rawWarnings.filter((w): w is string => typeof w === "string" && w.trim() !== "")
    : [];
  const paintable = geom?.paintable === false ? false : true;
  const mode = typeof geom?.fit_mode === "string" ? geom.fit_mode : undefined;
  const maxJointTurnDeg =
    typeof geom?.max_joint_turn_deg === "number" && Number.isFinite(geom.max_joint_turn_deg)
      ? geom.max_joint_turn_deg
      : undefined;
  return {
    lineId: line.id,
    label: line.label || line.id,
    paintable,
    warnings,
    mode,
    maxJointTurnDeg,
  };
}

/** True when this line must not be painted without operator action. */
export function isGeometryNonPaintable(line: PlanLine): boolean {
  return line.entity?.geometry?.paintable === false;
}

/**
 * Parse warnings that can place a mission in the wrong place or at the wrong scale.
 * These require acknowledgement before Send.
 */
export function isCriticalParseWarning(warning: string): boolean {
  return /projected|jumbled|swapped|Headerless|do not paint|confirm this is correct|local metres|cluster median|outlier|Null Island|near 0°|origin set to cluster|\$INSUNITS|assumed centimetres|unit scale|Confirm unit scale|Georeferenced DXF|no route optimisation|operator order/i.test(
    warning
  );
}

export function partitionParseWarnings(warnings: string[]): {
  critical: string[];
  advisory: string[];
} {
  const critical: string[] = [];
  const advisory: string[] = [];
  for (const w of warnings) {
    if (!w || !String(w).trim()) continue;
    if (isCriticalParseWarning(w)) critical.push(w);
    else advisory.push(w);
  }
  return { critical, advisory };
}

/**
 * Evaluate whether the current CSV mission may be sent to the rover.
 *
 * @param geometryAcknowledged operator accepted non-paintable painted paths (risk override)
 * @param parseAcknowledged operator confirmed critical parse-frame warnings
 */
export function evaluateCsvSendReadiness(opts: {
  lines: PlanLine[];
  pathOrder?: CsvPathOrderEntry[] | null;
  parseWarnings?: string[];
  geometryAcknowledged?: boolean;
  parseAcknowledged?: boolean;
  /** When true (app planner), missing GPS anchor is a hard block. */
  requireGpsAnchor?: boolean;
  hasGpsAnchor?: boolean;
  /**
   * DXF app planner: operator order is authoritative (no rover route optimisation).
   * Surfaced as needs-ack when true.
   */
  dxfOperatorOrderAuthoritative?: boolean;
  /** Estimated densified waypoints (G9); hard-block when over max. */
  estimatedWaypoints?: number;
  maxWaypoints?: number;
}): CsvSendReadiness {
  const markLines = selectMarkPlanLines(opts.lines);
  const order =
    opts.pathOrder ??
    markLines.map((l) => ({ lineId: l.id, label: l.label, paint: true as boolean }));
  const painted = resolveOrderedPaintedLines(markLines, order);

  const linesWithWarnings = markLines
    .map(getLineFitMeta)
    .filter((m) => m.warnings.length > 0 || !m.paintable);

  const nonPaintablePainted = painted
    .map(getLineFitMeta)
    .filter((m) => !m.paintable);

  const hardBlocks: string[] = [];
  const advisory: string[] = [];

  if (painted.length < 1) {
    hardBlocks.push("Paint at least one path before sending.");
  }

  if (opts.requireGpsAnchor && !opts.hasGpsAnchor) {
    hardBlocks.push(
      "App-planned trajectory requires a GPS survey with a lat/lon anchor (origin_gps)."
    );
  }

  if (
    typeof opts.estimatedWaypoints === "number" &&
    typeof opts.maxWaypoints === "number" &&
    opts.estimatedWaypoints > opts.maxWaypoints
  ) {
    hardBlocks.push(
      `Estimated waypoints (${opts.estimatedWaypoints}) exceed max_waypoints (${opts.maxWaypoints}). Coarsen spacing or split the site.`
    );
  }

  // Advisory geometry warnings on painted paths that are still paintable
  for (const line of painted) {
    const m = getLineFitMeta(line);
    if (!m.paintable) continue;
    for (const w of m.warnings) {
      advisory.push(`${m.label}: ${w}`);
    }
  }

  if (opts.dxfOperatorOrderAuthoritative) {
    advisory.push(
      "Operator path order is authoritative — the rover will not re-optimise the route."
    );
  }

  const parse = partitionParseWarnings(opts.parseWarnings ?? []);
  for (const w of parse.advisory) advisory.push(w);

  const geoAck = opts.geometryAcknowledged === true;
  const parseAck = opts.parseAcknowledged === true;

  const needsGeometryAck = nonPaintablePainted.length > 0 && !geoAck;
  const needsParseAck = parse.critical.length > 0 && !parseAck;

  const pendingGeo = needsGeometryAck
    ? nonPaintablePainted.map(
        (m) =>
          `Non-paintable path still painted: "${m.label}". Skip it above, or acknowledge the risk.`
      )
    : [];
  const pendingParse = needsParseAck
    ? parse.critical.map((w) => `Parse warning needs confirmation: ${w}`)
    : [];

  // Policy: acknowledgement means "I reviewed this; Send may proceed with paintable paths only
  // (non-paintable painted paths are still refused by buildTrajectory)".
  const effectiveHard = [...hardBlocks];
  const hasPaintablePainted = painted.some((l) => !isGeometryNonPaintable(l));
  if (painted.length > 0 && !hasPaintablePainted && (geoAck || nonPaintablePainted.length === 0)) {
    effectiveHard.push(
      "All painted paths are non-paintable. Skip them or fix the CSV — nothing left to send."
    );
  }

  const canSend =
    effectiveHard.length === 0 &&
    !needsGeometryAck &&
    !needsParseAck &&
    hasPaintablePainted;

  return {
    canSend,
    hardBlocks: effectiveHard,
    needsAck: [...pendingGeo, ...pendingParse],
    advisory: dedupeStrings(advisory).slice(0, 40),
    nonPaintablePainted,
    linesWithWarnings,
    needsGeometryAck,
    needsParseAck,
    criticalParseWarnings: parse.critical,
  };
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
