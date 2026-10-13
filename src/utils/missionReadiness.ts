/**
 * Geometry / parse readiness for Path Order and Send-to-Rover.
 *
 * Which paths are painted is the operator's choice (the paint tick in Path Order); the app does
 * not veto a path for its shape. Parse-frame warnings that can place a mission in the wrong
 * place still require acknowledgement.
 *
 * Renamed from csvGeometryReadiness.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";
import {
  countCornerClasses,
  formatCornerCountsSummary,
  type CornerClassCounts,
} from "./cornerLifecycle";
import type { CsvPathOrderEntry } from "./missionPathOrder";
import { resolveOrderedPaintedLines, selectMarkPlanLines } from "./missionPathOrder";

export type LineFitMeta = {
  lineId: string;
  label: string;
  warnings: string[];
  mode?: string;
  maxJointTurnDeg?: number;
  /** Classified corners on this line (source or recovered post-hydrate). */
  cornerCounts?: CornerClassCounts;
  /** Compact summary e.g. "2 clean · 1 sharp". */
  cornersSummary?: string | null;
};

export type CsvSendReadiness = {
  /** True when Send may proceed without further acknowledgement. */
  canSend: boolean;
  /** Hard blockers (cannot be overridden). Empty when only ack needed. */
  hardBlocks: string[];
  /** Soft blockers cleared by operator acknowledgement. */
  needsAck: string[];
  /** Non-blocking notices (always show, never stop Send alone). */
  advisory: string[];
  /** All mark lines that carry fit warnings. */
  linesWithWarnings: LineFitMeta[];
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
  const rawCorners = Array.isArray(geom?.corners) ? geom.corners : [];
  const cornerCounts = countCornerClasses(rawCorners);
  const cornersSummary = formatCornerCountsSummary(cornerCounts);
  const mode = typeof geom?.fit_mode === "string" ? geom.fit_mode : undefined;
  const maxJointTurnDeg =
    typeof geom?.max_joint_turn_deg === "number" && Number.isFinite(geom.max_joint_turn_deg)
      ? geom.max_joint_turn_deg
      : undefined;
  return {
    lineId: line.id,
    label: line.label || line.id,
    warnings,
    mode,
    maxJointTurnDeg,
    cornerCounts: cornerCounts.total > 0 ? cornerCounts : undefined,
    cornersSummary,
  };
}

/**
 * Parse warnings that can place a mission in the wrong place or at the wrong scale.
 * These require acknowledgement before Send.
 */
export function isCriticalParseWarning(warning: string): boolean {
  return /projected|jumbled|swapped|Headerless|do not paint|confirm this is correct|local metres|cluster median|outlier|Null Island|near 0°|origin set to cluster|\$INSUNITS|assumed centimetres|unit scale|Confirm unit scale|Georeferenced DXF|no route optimisation|operator order|does not generate paths from DXF points|No LINE\/LWPOLYLINE/i.test(
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
 * @param parseAcknowledged operator confirmed critical parse-frame warnings
 */
export function evaluateCsvSendReadiness(opts: {
  lines: PlanLine[];
  pathOrder?: CsvPathOrderEntry[] | null;
  parseWarnings?: string[];
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

  const linesWithWarnings = markLines.map(getLineFitMeta).filter((m) => m.warnings.length > 0);

  const hardBlocks: string[] = [];
  const advisory: string[] = [];

  if (painted.length < 1) {
    hardBlocks.push("Paint at least one path before sending.");
  }

  if (opts.requireGpsAnchor && !opts.hasGpsAnchor) {
    hardBlocks.push(
      opts.dxfOperatorOrderAuthoritative
        ? "DXF trajectory requires a GPS origin — use a georeferenced DXF, or complete Align first."
        : "App-planned trajectory requires GPS survey points with a lat/lon anchor (origin_gps)."
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

  // Advisory geometry notes on painted paths
  // (includes corner summary strings from the fitter / post-hydrate recovery).
  for (const line of painted) {
    const m = getLineFitMeta(line);
    for (const w of m.warnings) {
      advisory.push(`${m.label}: ${w}`);
    }
    // Structured corner chip when corners exist but no warning string yet (legacy lines).
    if (
      m.cornersSummary &&
      !m.warnings.some((w) => /corner/i.test(w))
    ) {
      advisory.push(`"${m.label}": ${m.cornersSummary}`);
    }
  }

  if (opts.dxfOperatorOrderAuthoritative) {
    advisory.push(
      "Operator path order is authoritative — the rover will not re-optimise the route."
    );
  }

  const parse = partitionParseWarnings(opts.parseWarnings ?? []);
  for (const w of parse.advisory) advisory.push(w);

  const parseAck = opts.parseAcknowledged === true;

  const needsParseAck = parse.critical.length > 0 && !parseAck;

  const pendingParse = needsParseAck
    ? parse.critical.map((w) => `Parse warning needs confirmation: ${w}`)
    : [];

  const canSend = hardBlocks.length === 0 && !needsParseAck && painted.length > 0;

  return {
    canSend,
    hardBlocks,
    needsAck: pendingParse,
    advisory: dedupeStrings(advisory).slice(0, 40),
    linesWithWarnings,
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
