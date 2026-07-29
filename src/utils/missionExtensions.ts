/**
 * Mission path PRE/AFT extensions — pure geometry + config.
 *
 * App-owned: travel runs in plan-trajectory, spray-off by construction.
 * Source-agnostic (CSV + DXF). See docs/CSV_EXTENSIONS_EXECUTION_PLAN.md.
 *
 * Renamed from csvExtensions.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";

/** [north_m, east_m] — local copy to avoid circular import with missionTrajectory. */
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
  /**
   * DXF parity: split a polyline at corners so each side gets its own PRE/AFT
   * (port of backend per_line). CSV keeps false → byte-identical behaviour.
   */
  perLine?: boolean;
};

/** Alias used by DXF local flow (same shape). */
export type ExtensionConfig = CsvExtensionConfig;

export const DEFAULT_CSV_EXTENSION_CONFIG: CsvExtensionConfig = {
  enabled: false,
  preM: 0.5,
  aftM: 0.5,
  perLine: false,
};

/** Match backend _EXTENSION_JUNCTION_TOL_M (m). */
export const EXT_JUNCTION_TOL_M = 0.05;

/** Match backend _EXTENSION_COLLINEAR_DOT for per-line freeness. */
export const EXT_COLLINEAR_DOT = 0.98;

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
  const perLine = Boolean(raw?.perLine);

  if (preM < 0) preM = 0;
  if (aftM < 0) aftM = 0;
  if (preM > CSV_EXT_MAX_M) preM = CSV_EXT_MAX_M;
  if (aftM > CSV_EXT_MAX_M) aftM = CSV_EXT_MAX_M;

  if (enabled) {
    aftM = Math.max(CSV_EXT_AFT_FLOOR_M, aftM);
  }

  return { enabled, preM, aftM, perLine };
}

// ── Phase 3: per-edge freeness (port of path.py _extension_endpoint_freeness) ─

export type MarkEdge = {
  /** [north, east] polyline for this edge */
  points: NedPair[];
  startDir: NedPair | null;
  endDir: NedPair | null;
  /** Parent plan-line id (for PRE/AFT ids) */
  parentId: string;
  parentLabel: string;
};

export type EndpointFreeness = { startFree: boolean; endFree: boolean };

/**
 * Port of `_extension_endpoint_freeness`.
 * perLine=false: any shared endpoint blocks (chain ends only).
 * perLine=true: only collinear junctions block (closed square gets 4× PRE/AFT).
 */
export function computeEndpointFreeness(
  edges: MarkEdge[],
  perLine: boolean,
  tolM: number = EXT_JUNCTION_TOL_M
): EndpointFreeness[] {
  const collinear = (d1: NedPair | null, d2: NedPair | null): boolean => {
    if (!d1 || !d2) return false;
    return Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) > EXT_COLLINEAR_DOT;
  };

  const blocked = (
    pt: NedPair,
    myDir: NedPair | null,
    skipIdx: number
  ): boolean => {
    for (let j = 0; j < edges.length; j++) {
      if (j === skipIdx) continue;
      const e = edges[j];
      if (e.points.length < 2) continue;
      const s = e.points[0];
      const end = e.points[e.points.length - 1];
      for (const [otherPt, otherDir] of [
        [s, e.startDir] as const,
        [end, e.endDir] as const,
      ]) {
        if (distM(pt, otherPt) > tolM) continue;
        if (!perLine) return true;
        if (collinear(myDir, otherDir)) return true;
      }
    }
    return false;
  };

  return edges.map((edge, i) => {
    if (edge.points.length < 2) return { startFree: false, endFree: false };
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];
    if (distM(start, end) <= tolM) {
      // Self-closed: no free ends
      return { startFree: false, endFree: false };
    }
    return {
      startFree: !blocked(start, edge.startDir, i),
      endFree: !blocked(end, edge.endDir, i),
    };
  });
}

/**
 * Split a polyline at corners into straight edges (per_line mode).
 * Curved single-run entities (few points that aren't corner chains) stay whole.
 */
export function splitPolylineAtCorners(
  pts: NedPair[],
  cornerDotMax: number = 0.999
): NedPair[][] {
  if (pts.length < 3) return [pts];
  const edges: NedPair[][] = [];
  let current: NedPair[] = [pts[0], pts[1]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const d1: NedPair = [b[0] - a[0], b[1] - a[1]];
    const d2: NedPair = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(d1[0], d1[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) {
      current.push(c);
      continue;
    }
    const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
    if (dot < cornerDotMax) {
      // Corner at b — close current edge, start new
      edges.push(current);
      current = [b, c];
    } else {
      current.push(c);
    }
  }
  if (current.length >= 2) edges.push(current);
  return edges.length > 0 ? edges : [pts];
}

function unitDir(a: NedPair, b: NedPair): NedPair | null {
  const dn = b[0] - a[0];
  const de = b[1] - a[1];
  const len = Math.hypot(dn, de);
  if (len < 1e-9) return null;
  return [dn / len, de / len];
}

/** Build freeness-aware edges from painted plan lines. */
export function buildMarkEdges(
  paintedLines: PlanLine[],
  perLine: boolean
): MarkEdge[] {
  const edges: MarkEdge[] = [];
  for (const line of paintedLines) {
    const pts = planLineToNed(line);
    if (!pts || pts.length < 2) continue;
    const parentId = line.id;
    const parentLabel = line.label ?? line.id;
    if (!perLine || pts.length < 3) {
      edges.push({
        points: pts,
        startDir: unitDir(pts[0], pts[1]),
        endDir: unitDir(pts[pts.length - 2], pts[pts.length - 1]),
        parentId,
        parentLabel,
      });
      continue;
    }
    const parts = splitPolylineAtCorners(pts);
    if (parts.length <= 1) {
      edges.push({
        points: pts,
        startDir: unitDir(pts[0], pts[1]),
        endDir: unitDir(pts[pts.length - 2], pts[pts.length - 1]),
        parentId,
        parentLabel,
      });
    } else {
      parts.forEach((part, idx) => {
        if (part.length < 2) return;
        edges.push({
          points: part,
          startDir: unitDir(part[0], part[1]),
          endDir: unitDir(part[part.length - 2], part[part.length - 1]),
          parentId: `${parentId}#${idx}`,
          parentLabel: `${parentLabel} side ${idx + 1}`,
        });
      });
    }
  }
  return edges;
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
 * Suppresses all when mission is closed or config disabled (CSV / perLine=false).
 * When perLine=true, uses endpoint freeness so closed polylines get per-corner run-ups.
 */
export function buildCsvExtensionLines(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): PlanLine[] {
  const cfg = normalizeCsvExtensionConfig(config);
  if (!cfg.enabled || paintedLines.length === 0) return [];

  // CSV default: mission-level closed loop suppresses everything.
  if (!cfg.perLine && isMissionClosedLoop(paintedLines)) return [];

  if (!cfg.perLine) {
    const out: PlanLine[] = [];
    for (const line of paintedLines) {
      const prePts = extensionEndpointsForLine(line, "pre", cfg.preM);
      if (prePts) out.push(makeExtensionPlanLine(line.id, "pre", prePts, line.label ?? line.id));
      const aftPts = extensionEndpointsForLine(line, "aft", cfg.aftM);
      if (aftPts) out.push(makeExtensionPlanLine(line.id, "aft", aftPts, line.label ?? line.id));
    }
    return out;
  }

  // DXF per-line mode: freeness + corner split
  const edges = buildMarkEdges(paintedLines, true);
  const freeness = computeEndpointFreeness(edges, true);
  const out: PlanLine[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const free = freeness[i];
    if (free.startFree && cfg.preM > 0 && edge.startDir) {
      const start = edge.points[0];
      const from: NedPair = [
        start[0] - cfg.preM * edge.startDir[0],
        start[1] - cfg.preM * edge.startDir[1],
      ];
      out.push(
        makeExtensionPlanLine(edge.parentId, "pre", [from, start], edge.parentLabel)
      );
    }
    if (free.endFree && cfg.aftM > 0 && edge.endDir) {
      const end = edge.points[edge.points.length - 1];
      const to: NedPair = [
        end[0] + cfg.aftM * edge.endDir[0],
        end[1] + cfg.aftM * edge.endDir[1],
      ];
      out.push(
        makeExtensionPlanLine(edge.parentId, "aft", [end, to], edge.parentLabel)
      );
    }
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
