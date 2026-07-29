/**
 * CSV path PRE/AFT extensions — pure geometry + config.
 *
 * App-owned: travel runs in plan-trajectory, spray-off by construction.
 * See docs/CSV_EXTENSIONS_EXECUTION_PLAN.md.
 */

import type { PlanLine } from "../types/plan";

/** [north_m, east_m] — local copy to avoid circular import with csvTrajectory. */
type NedPair = [number, number];

/** Engine run-out floor — app AFT becomes the tail when extensions are on. */
export const CSV_EXT_AFT_FLOOR_M = 0.1;

/** Match engine ends_at_start closed-mission threshold (m). */
export const CSV_EXT_CLOSED_LOOP_TOL_M = 0.01;

/** Walk past degenerate terminal segments shorter than this (m). */
export const CSV_EXT_MIN_SEGMENT_M = 0.01;

/** Soft UI warning threshold (m). */
export const CSV_EXT_WARN_M = 2;

/** Hard typo cap (m). */
export const CSV_EXT_MAX_M = 5;

export type CsvExtensionConfig = {
  enabled: boolean;
  preM: number;
  aftM: number;
};

export const DEFAULT_CSV_EXTENSION_CONFIG: CsvExtensionConfig = {
  enabled: false,
  preM: 0.5,
  aftM: 0.5,
};

/**
 * Normalize operator input. When enabled, aftM is floored at {@link CSV_EXT_AFT_FLOOR_M}.
 * Non-finite lengths fall back to defaults; lengths are capped at {@link CSV_EXT_MAX_M}.
 */
export function normalizeCsvExtensionConfig(
  raw?: Partial<CsvExtensionConfig> | null
): CsvExtensionConfig {
  const enabled = Boolean(raw?.enabled);
  let preM = typeof raw?.preM === "number" && Number.isFinite(raw.preM) ? raw.preM : DEFAULT_CSV_EXTENSION_CONFIG.preM;
  let aftM = typeof raw?.aftM === "number" && Number.isFinite(raw.aftM) ? raw.aftM : DEFAULT_CSV_EXTENSION_CONFIG.aftM;

  if (preM < 0) preM = 0;
  if (aftM < 0) aftM = 0;
  if (preM > CSV_EXT_MAX_M) preM = CSV_EXT_MAX_M;
  if (aftM > CSV_EXT_MAX_M) aftM = CSV_EXT_MAX_M;

  if (enabled) {
    aftM = Math.max(CSV_EXT_AFT_FLOOR_M, aftM);
  }

  return { enabled, preM, aftM };
}

function distM(a: NedPair, b: NedPair): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isFinitePair(n: number, e: number): boolean {
  return Number.isFinite(n) && Number.isFinite(e);
}

/** Same NED extract rules as planLineToNedPolyline (kept local — no csvTrajectory import). */
function planLineToNed(line: PlanLine): NedPair[] | null {
  const preview = line.entity?.preview_points;
  if (preview && preview.length >= 2) {
    const pts: NedPair[] = [];
    for (const p of preview) {
      if (p == null || !isFinitePair(p.north, p.east)) continue;
      pts.push([p.north, p.east]);
    }
    return pts.length >= 2 ? pts : null;
  }
  const fx = line.from?.x;
  const fy = line.from?.y;
  const tx = line.to?.x;
  const ty = line.to?.y;
  if (!isFinitePair(fx, fy) || !isFinitePair(tx, ty)) return null;
  return [
    [fx, fy],
    [tx, ty],
  ];
}

/**
 * Unit vector along the first usable segment (start) or last usable segment (end).
 * Walks inward past sub-centimetre degenerates.
 */
export function terminalUnitVector(
  pts: NedPair[],
  end: "start" | "end",
  minSegM: number = CSV_EXT_MIN_SEGMENT_M
): NedPair | null {
  if (pts.length < 2) return null;
  if (end === "start") {
    for (let i = 0; i < pts.length - 1; i++) {
      const dn = pts[i + 1][0] - pts[i][0];
      const de = pts[i + 1][1] - pts[i][1];
      const len = Math.hypot(dn, de);
      if (len >= minSegM) return [dn / len, de / len];
    }
  } else {
    for (let i = pts.length - 1; i >= 1; i--) {
      const dn = pts[i][0] - pts[i - 1][0];
      const de = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dn, de);
      if (len >= minSegM) return [dn / len, de / len];
    }
  }
  return null;
}

/**
 * PRE: start − preM·û → start. AFT: end → end + aftM·û.
 * Returns null when length is zero or the line has no usable tangent.
 */
export function extensionEndpointsForLine(
  line: PlanLine,
  role: "pre" | "aft",
  lengthM: number
): NedPair[] | null {
  if (!(lengthM > 0) || !Number.isFinite(lengthM)) return null;
  const pts = planLineToNed(line);
  if (!pts || pts.length < 2) return null;

  if (role === "pre") {
    const u = terminalUnitVector(pts, "start");
    if (!u) return null;
    const start = pts[0];
    const from: NedPair = [start[0] - lengthM * u[0], start[1] - lengthM * u[1]];
    return [from, start];
  }

  const u = terminalUnitVector(pts, "end");
  if (!u) return null;
  const end = pts[pts.length - 1];
  const to: NedPair = [end[0] + lengthM * u[0], end[1] + lengthM * u[1]];
  return [end, to];
}

/**
 * Mission-level closed loop: first point of first painted path ≈ last of last.
 * Mirrors engine ends_at_start (0.01 m).
 */
export function isMissionClosedLoop(
  paintedLines: PlanLine[],
  tolM: number = CSV_EXT_CLOSED_LOOP_TOL_M
): boolean {
  if (paintedLines.length === 0) return false;
  const firstPts = planLineToNed(paintedLines[0]);
  const lastPts = planLineToNed(paintedLines[paintedLines.length - 1]);
  if (!firstPts || !lastPts || firstPts.length < 2 || lastPts.length < 2) return false;
  return distM(firstPts[0], lastPts[lastPts.length - 1]) < tolM;
}

function makeExtensionPlanLine(
  lineId: string,
  role: "pre" | "aft",
  points: NedPair[],
  parentLabel: string
): PlanLine {
  const id = role === "pre" ? `ext-pre-${lineId}` : `ext-aft-${lineId}`;
  const length_m = distM(points[0], points[points.length - 1]);
  const label =
    role === "pre"
      ? `Pre-ext: ${parentLabel}`
      : `Aft-ext: ${parentLabel}`;
  return {
    id,
    label,
    layer: "extension",
    segmentRole: role,
    is_mark: false,
    from: { id: 1, x: points[0][0], y: points[0][1] },
    to: { id: 2, x: points[points.length - 1][0], y: points[points.length - 1][1] },
    width: 0.1,
    entity: {
      entity_id: id,
      entity_type: "EXTENSION",
      layer: "EXTENSION",
      color: 0,
      is_mark: false,
      length_m,
      geometry: {},
      preview_points: points.map(([north, east]) => ({ north, east })),
    },
  };
}

/**
 * Preview PlanLines for each painted path (map / Path Order).
 * Suppresses all when mission is closed or config disabled.
 */
export function buildCsvExtensionLines(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): PlanLine[] {
  const cfg = normalizeCsvExtensionConfig(config);
  if (!cfg.enabled || paintedLines.length === 0) return [];
  if (isMissionClosedLoop(paintedLines)) return [];

  const out: PlanLine[] = [];
  for (const line of paintedLines) {
    const prePts = extensionEndpointsForLine(line, "pre", cfg.preM);
    if (prePts) out.push(makeExtensionPlanLine(line.id, "pre", prePts, line.label ?? line.id));
    const aftPts = extensionEndpointsForLine(line, "aft", cfg.aftM);
    if (aftPts) out.push(makeExtensionPlanLine(line.id, "aft", aftPts, line.label ?? line.id));
  }
  return out;
}

/** Operator-facing extension preview for Path Order interleaving. */
export type CsvExtensionPreview = {
  id: string;
  lineId: string;
  role: "pre" | "aft";
  label: string;
  lengthM: number;
};

export function buildCsvExtensionPreviews(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): CsvExtensionPreview[] {
  return buildCsvExtensionLines(paintedLines, config).map((line) => {
    const role: "pre" | "aft" = line.segmentRole === "aft" ? "aft" : "pre";
    const prefix = role === "pre" ? "ext-pre-" : "ext-aft-";
    const id = String(line.id);
    const lineId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
    return {
      id,
      lineId,
      role,
      label: line.label,
      lengthM: line.entity?.length_m ?? 0,
    };
  });
}

/** Total extension metres for UI totals. */
export function csvExtensionLengthM(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): number {
  return buildCsvExtensionLines(paintedLines, config).reduce(
    (sum, l) => sum + (l.entity?.length_m ?? 0),
    0
  );
}
