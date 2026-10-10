/**
 * Local DXF import that matches the rover's parser (G1/G2/G3/G6).
 *
 * Built for app-planned DXF missions (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 1).
 *
 * Contract - path fidelity:
 * - LINE / LWPOLYLINE / POLYLINE / ARC / CIRCLE / SPLINE / ELLIPSE vertices (and
 *   sagitta samples of curves) are the **real file path**. The app does **not**
 *   re-fit or regenerate that geometry the way CSV road-marking does.
 * - Unit scale ($INSUNITS) and georef projection only change frame, not shape.
 * - Path generation (straights + Hyper-fit arcs from sparse points) is CSV-only
 *   (`localCsvPointsToPlanLines`). A points-only DXF is not auto-fitted here.
 * - Nothing is dropped silently: every skipped, degenerate or unsupported entity is
 *   counted and returned as a warning, and malformed numbers refuse the file.
 *
 * How geometry is represented.
 * Every entity is first reduced to an exact primitive in plan XY (file units):
 * - straight pieces and circular bulge pieces of a path, or
 * - an elliptical arc P(t) = c + u cos t + v sin t (ARC, CIRCLE, ELLIPSE and bulge
 *   arcs under a non-similarity transform), or
 * - a NURBS curve (SPLINE).
 * The block-INSERT chain and the entity's OCS (arbitrary-axis algorithm) are composed
 * as 3-D 3x4 affine matrices and applied to those primitives, so non-uniform scale,
 * mirroring and flipped extrusions come out exactly. Tessellation happens last, in
 * metres, with a chord error of at most MAX_SAGITTA_M.
 *
 * Output PlanLine[] uses app NED: PlanPoint.x = north, PlanPoint.y = east;
 * entity.preview_points are {north, east} in metres.
 */

import type { PlanLayer, PlanLine } from "../types/plan";
import { dxfCurveGeometryToNed } from "./curveGeometry";
import {
  looksGeographic,
  metresPerDegree,
  projectGeographicToLocalNed,
  projectGpsToLocalMeters,
} from "./geoProjection";
import { rebasePlanLineToOrigin } from "./planOriginRebase";

// -- $INSUNITS -> metres (path_engine/parsers/dxf_parser.py) -------------------

/** DXF $INSUNITS values to metres per unit (DXF specification). */
export const INSUNITS_TO_METRES: Record<number, number | null> = {
  0: null, // unspecified - use fallback
  1: 0.0254, // inches
  2: 0.3048, // feet
  3: 1609.344, // miles
  4: 0.001, // mm
  5: 0.01, // cm
  6: 1.0, // m
  7: 1000.0, // km
  8: 2.54e-8, // microinches
  9: 2.54e-5, // mils
  10: 0.9144, // yards
  11: 1e-10, // angstroms
  12: 1e-9, // nanometers
  13: 1e-6, // microns
  14: 0.1, // decimeters
  15: 100.0, // hectometers
};

/** Rover fallback when $INSUNITS is 0/absent (centimetres). */
export const DEFAULT_UNIT_SCALE_M = 0.01;

/** Match rover spline/ellipse flattening distance (m). */
export const MAX_SAGITTA_M = 0.005;

/** Entities (after block expansion) a single DXF may produce. */
export const MAX_DXF_ENTITIES = 20_000;
/** Tessellated points a single DXF may produce. */
export const MAX_DXF_POINTS = 500_000;
/** Deepest INSERT nesting that is expanded. */
export const MAX_BLOCK_NEST_DEPTH = 16;
/** A metric drawing is expected to be local; beyond this it is a projected CRS (m). */
export const PROJECTED_COORD_BLOCK_M = 100_000;

export type LocalDxfResult = {
  fileName: string;
  unitScale: number;
  unitScaleSource: "insunits" | "fallback";
  insunits: number | null;
  isGeographic: boolean;
  geoOrigin: { lat: number; lon: number } | null;
  lines: PlanLine[];
  entityCount: number;
  ignoredCount: number;
  warnings: string[];
  /**
   * Warnings the operator must acknowledge before this DXF may be staged or loaded
   * (today: the assumed centimetre unit scale). The UI forwards them with `warnings`
   * to the send-readiness gate, which classifies them as critical parse warnings
   * (isCriticalParseWarning) and requires an explicit acknowledgement.
   */
  blockingWarnings: string[];
};

export type DxfEntityClass = "mark" | "transit" | "ignore";

type Pair = { code: string; value: string };
type Xy = { x: number; y: number };
type Vec3 = [number, number, number];

type RawEntity = {
  type: string;
  pairs: Pair[];
  /** Classic POLYLINE: the VERTEX sub-entities, one pair list each. */
  vertices: Pair[][];
  /** INSERT with attributes-follow: number of ATTRIB sub-entities consumed. */
  attribs: number;
};

type DxfBlock = {
  name: string;
  header: Pair[];
  entities: RawEntity[];
};

/** Elliptical arc P(t) = c + u cos t + v sin t, t from t0 to t1 (t1 < t0 sweeps backwards). */
export type EllipseArc = {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  t0: number;
  t1: number;
};

/** NURBS curve in plan XY; weights are all 1 for a non-rational B-spline. */
export type Nurbs = {
  degree: number;
  knots: number[];
  ctrl: Xy[];
  weights: number[];
};

/** One piece of a path (LINE, LWPOLYLINE, POLYLINE). */
type Piece =
  | { kind: "line"; to: Xy }
  /** Circular bulge segment; the transform is a similarity so endpoints + bulge suffice. */
  | { kind: "bulge"; from: Xy; to: Xy; bulge: number }
  /** Bulge segment under a non-similarity transform: an exact elliptical arc. */
  | { kind: "ellipse"; arc: EllipseArc; to: Xy };

type Body =
  | {
      kind: "path";
      type: "LINE" | "LWPOLYLINE" | "POLYLINE";
      start: Xy;
      pieces: Piece[];
      closed: boolean;
      vertexCount: number;
    }
  | { kind: "conic"; type: "ARC" | "CIRCLE" | "ELLIPSE"; arc: EllipseArc }
  | {
      kind: "spline";
      /** Control-point NURBS, or null for a fit-point-only spline. */
      nurbs: Nurbs | null;
      fit: Xy[];
      closedFlag: boolean;
    };

type Rec = {
  body: Body;
  layerName: string;
  color: number;
  classification: DxfEntityClass;
  /** Representative points in file units (georef detection and the projected-CRS guard). */
  key: Xy[];
};

// -- Public API ----------------------------------------------------------------

export function parseLocalDxf(text: string, fileName: string): LocalDxfResult {
  const warnings: string[] = [];
  const blockingWarnings: string[] = [];
  const pairs = toPairs(text);
  const { scale, source, insunits } = readUnitScale(pairs);

  // Parse in raw DXF units. The unit scale is applied only after we know the drawing
  // is metric - geographic files store lat/lon and must not be multiplied by cm/mm
  // fallbacks (G1/G2 order).
  const ctx = createContext(buildBlockLibrary(pairs));
  for (const group of collectEntityGroups(extractSection(pairs, "ENTITIES"))) {
    visitEntity(group, ROOT_ENV, ctx);
  }
  failOnNonFinite(ctx);

  const keyPoints: Xy[] = [];
  for (const rec of ctx.recs) for (const p of rec.key) keyPoints.push(p);

  // Detection needs every coordinate in the file, so it runs once all entities are read.
  let samplePts = keyPoints.map((p) => ({ north: p.y, east: p.x }));
  const usingPointCloudForGeo = samplePts.length === 0 && ctx.pointCloud.length > 0;
  if (usingPointCloudForGeo) {
    samplePts = ctx.pointCloud.map((p) => ({ north: p.y, east: p.x }));
  }

  const geoCheck = looksGeographic(samplePts);
  let isGeographic = false;
  let geoOrigin: { lat: number; lon: number } | null = null;
  let effectiveScale = scale;
  let effectiveSource: "insunits" | "fallback" = source;

  if (geoCheck.isGeographic) {
    isGeographic = true;
    effectiveScale = 1;
    effectiveSource = "insunits";
    geoOrigin = projectGeographicToLocalNed(samplePts).origin;
    warnings.push(
      `Georeferenced DXF detected - projected about (${geoOrigin.lat.toFixed(6)}, ${geoOrigin.lon.toFixed(6)}) on the WGS84 tangent plane. File path geometry is preserved.`
    );
  } else {
    if (source === "fallback") {
      blockingWarnings.push(
        insunits != null && insunits !== 0
          ? `$INSUNITS=${insunits} is not a recognised unit - assumed centimetres (scale ${DEFAULT_UNIT_SCALE_M}). Confirm unit scale before Send.`
          : `$INSUNITS absent or 0 - assumed centimetres (scale ${DEFAULT_UNIT_SCALE_M}). Confirm unit scale before Send.`
      );
    }
    let maxAbs = 0;
    for (const p of keyPoints) {
      maxAbs = Math.max(maxAbs, Math.abs(p.x) * scale, Math.abs(p.y) * scale);
    }
    if (maxAbs > PROJECTED_COORD_BLOCK_M) {
      throw new Error(
        `Coordinates look like a projected CRS (values up to ${maxAbs.toFixed(0)} m), not local site metres. ` +
          `Export lat/lon, or subtract a site origin so x/y are local metres within ~${PROJECTED_COORD_BLOCK_M / 1000} km of zero.`
      );
    }
  }

  const frame = makeFrame(isGeographic ? 1 : scale, geoOrigin);
  const lines: PlanLine[] = [];
  const idxRef = { value: 0 };
  const pointIdRef = { value: 1 };
  for (const rec of ctx.recs) emitRec(rec, frame, ctx, lines, idxRef, pointIdRef);

  warnings.push(...diagnosticWarnings(ctx));

  // Points-only DXF: do NOT invent a path. CSV is the only path generator.
  if (lines.length === 0 && ctx.pointCloud.length > 0) {
    warnings.push(
      `No LINE/LWPOLYLINE/ARC/CIRCLE/SPLINE/ELLIPSE path geometry in this DXF (${ctx.pointCloud.length} POINT entities ignored for path). ` +
        `The app does not generate paths from DXF points - export LINE/POLYLINE geometry, or use a survey CSV for point-based path generation.`
    );
  } else if (lines.length === 0 && ctx.pointCloud.length === 0) {
    warnings.push(
      "No importable path geometry (LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE) was found in this DXF."
    );
  }

  const plainIgnored = ctx.diag.ignored - ctx.diag.text;
  if (plainIgnored > 0) {
    warnings.push(
      `Ignored ${plainIgnored} entity(ies) (POINT / annotation / hatch layers).`
    );
  }

  return {
    fileName,
    unitScale: effectiveScale,
    unitScaleSource: effectiveSource,
    insunits,
    isGeographic,
    geoOrigin,
    lines,
    entityCount: lines.length,
    ignoredCount: ctx.diag.ignored,
    warnings,
    blockingWarnings,
  };
}

export function dxfFileStem(fileName: string): string {
  const base = (fileName || "").split(/[\\/]/).pop() || "dxf";
  return base.replace(/\.[^.]+$/, "") || base;
}

function combinedDxfFileName(fileNames: string[]): string {
  if (fileNames.length === 0) return "combined.dxf";
  if (fileNames.length === 1) return fileNames[0];
  return `${dxfFileStem(fileNames[0])}_x${fileNames.length}.dxf`;
}

/**
 * Prefix plan-line / entity ids so multi-file DXF merges never collide
 * (each parse restarts at LINE-0, ARC-0, ...).
 */
export function prefixDxfLineIds(lines: PlanLine[], prefix: string): PlanLine[] {
  return lines.map((line) => ({
    ...line,
    id: `${prefix}__${line.id}`,
    label: line.label ? `${prefix}: ${line.label}` : prefix,
    entity: line.entity
      ? {
          ...line.entity,
          entity_id: `${prefix}__${line.entity.entity_id}`,
        }
      : undefined,
  }));
}

/**
 * Re-base a geo-DXF line from `fromOrigin` NED into `toOrigin` NED via WGS84.
 * Thin wrapper over shared {@link rebasePlanLineToOrigin}.
 */
function rebaseGeoDxfLine(
  line: PlanLine,
  fromOrigin: { lat: number; lon: number },
  toOrigin: { lat: number; lon: number }
): PlanLine {
  return rebasePlanLineToOrigin(line, fromOrigin, toOrigin);
}

/**
 * Merge several already-parsed local DXFs into one plan (multi-file Select File).
 *
 * Rules:
 * - All files must be the same class: all metric or all georeferenced.
 * - Metric: lines concatenated (same CAD/site frame assumed).
 * - Geographic: first file's geoOrigin is the shared plan origin; other files
 *   are re-based into that NED frame so path geometry stays true to lat/lon.
 * - Line/entity ids are prefixed per source file to avoid collisions.
 * - Warnings and blocking warnings of every file are carried, prefixed by file name.
 */
export function mergeLocalDxfResults(results: LocalDxfResult[]): LocalDxfResult {
  if (results.length === 0) {
    throw new Error("No DXF files to merge.");
  }
  if (results.length === 1) return results[0];

  const isGeographic = results[0].isGeographic;
  for (const r of results) {
    if (r.isGeographic !== isGeographic) {
      throw new Error(
        `Cannot mix metric and georeferenced DXFs in one import (${results[0].fileName} is ${
          results[0].isGeographic ? "geographic" : "metric"
        }, ${r.fileName} is ${r.isGeographic ? "geographic" : "metric"}).`
      );
    }
  }

  const warnings: string[] = [
    `Merged ${results.length} DXF files into one plan.`,
  ];
  const blockingWarnings: string[] = [];
  const mergedLines: PlanLine[] = [];
  let ignoredCount = 0;
  let entityCount = 0;

  const geoOrigin = isGeographic
    ? (results.find((r) => r.geoOrigin != null)?.geoOrigin ?? null)
    : null;
  if (isGeographic && !geoOrigin) {
    throw new Error("No geographic origin found in the selected DXF files.");
  }

  for (const r of results) {
    warnings.push(...r.warnings.map((w) => `${r.fileName}: ${w}`));
    blockingWarnings.push(...r.blockingWarnings.map((w) => `${r.fileName}: ${w}`));
    ignoredCount += r.ignoredCount;
    entityCount += r.entityCount;
    const stem = dxfFileStem(r.fileName);
    if (isGeographic && geoOrigin) {
      const origin = r.geoOrigin ?? geoOrigin;
      mergedLines.push(
        ...prefixDxfLineIds(
          r.lines.map((line) => rebaseGeoDxfLine(line, origin, geoOrigin)),
          stem
        )
      );
    } else {
      mergedLines.push(...prefixDxfLineIds(r.lines, stem));
    }
  }

  return {
    fileName: combinedDxfFileName(results.map((r) => r.fileName)),
    unitScale: isGeographic ? 1 : results[0].unitScale,
    unitScaleSource:
      isGeographic || results.every((r) => r.unitScaleSource === "insunits")
        ? "insunits"
        : "fallback",
    insunits: results[0].insunits,
    isGeographic,
    geoOrigin,
    lines: mergedLines,
    entityCount,
    ignoredCount,
    warnings,
    blockingWarnings,
  };
}

/**
 * Port of DXFEntity.classify() default rules (path_engine/core.py).
 * POINT / TEXT / MTEXT / ATTRIB / ATTDEF -> ignore; DIM/DEFPOINTS/ANNOT/HATCH layers
 * -> ignore; TRANSIT/TRAVEL/MOVE/RAPID -> transit; else mark.
 */
export function classifyDxfEntity(
  entityType: string,
  layerName: string
): DxfEntityClass {
  const type = (entityType || "").toUpperCase();
  if (type === "POINT") return "ignore";
  // Text is annotation; never paint.
  if (TEXT_TYPES.has(type)) return "ignore";

  const upper = (layerName || "").toUpperCase();
  for (const kw of ["DIM", "DEFPOINTS", "ANNOT", "HATCH"] as const) {
    if (upper.includes(kw)) return "ignore";
  }
  for (const kw of ["TRANSIT", "TRAVEL", "MOVE", "RAPID"] as const) {
    if (upper.includes(kw)) return "transit";
  }
  return "mark";
}

/** Map classification -> PlanLayer used by isPaintableMarkLine. */
export function planLayerForClass(c: DxfEntityClass): PlanLayer {
  if (c === "transit") return "transit";
  return "marking";
}

const TEXT_TYPES = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);

/** Entity types the importer turns into geometry (INSERT is expanded). */
const GEOMETRY_TYPES = new Set([
  "LINE",
  "LWPOLYLINE",
  "POLYLINE",
  "ARC",
  "CIRCLE",
  "ELLIPSE",
  "SPLINE",
]);

// -- Unit scale ------------------------------------------------------------------

export function readUnitScale(pairs: Pair[]): {
  scale: number;
  source: "insunits" | "fallback";
  insunits: number | null;
} {
  const header = extractSection(pairs, "HEADER");
  let insunits: number | null = null;
  for (let i = 0; i < header.length - 1; i++) {
    if (header[i].code === "9" && header[i].value === "$INSUNITS") {
      const v = Number(header[i + 1]?.value);
      if (Number.isFinite(v)) insunits = v;
      break;
    }
  }
  if (insunits == null || insunits === 0) {
    return { scale: DEFAULT_UNIT_SCALE_M, source: "fallback", insunits: insunits ?? 0 };
  }
  const mapped = INSUNITS_TO_METRES[insunits];
  if (mapped != null && mapped > 0) {
    return { scale: mapped, source: "insunits", insunits };
  }
  return { scale: DEFAULT_UNIT_SCALE_M, source: "fallback", insunits };
}

// -- Tessellation (sagitta-bounded) ----------------------------------------------

/**
 * Chord count for a circular arc so sagitta <= maxSagitta.
 * sagitta = r (1 - cos(theta/2)); theta = 2 acos(1 - s/r).
 */
export function arcSegmentCount(
  radius: number,
  sweepRad: number,
  maxSagitta: number = MAX_SAGITTA_M
): number {
  const r = Math.abs(radius);
  if (!(r > 0) || !(Math.abs(sweepRad) > 0)) return 2;
  const s = Math.min(maxSagitta, r * 0.999);
  const maxTheta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - s / r)));
  const n = Math.ceil(Math.abs(sweepRad) / Math.max(maxTheta, 1e-9));
  return Math.max(4, n);
}

/** Largest semi-axis (largest singular value of [u v]) of an ellipse arc. */
function maxSemiAxis(arc: EllipseArc): number {
  const uu = arc.ux * arc.ux + arc.uy * arc.uy;
  const vv = arc.vx * arc.vx + arc.vy * arc.vy;
  const uv = arc.ux * arc.vx + arc.uy * arc.vy;
  return Math.sqrt((uu + vv + Math.hypot(uu - vv, 2 * uv)) / 2);
}

function ellipsePoint(arc: EllipseArc, t: number): Xy {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: arc.cx + arc.ux * c + arc.vx * s, y: arc.cy + arc.uy * c + arc.vy * s };
}

/**
 * Chord count for an elliptical arc. The affine image of a circle sagitta is bounded by
 * the largest singular value times the circle sagitta, so arcSegmentCount on the
 * largest semi-axis bounds the chord error of the whole arc.
 */
export function ellipseArcSegments(
  arc: EllipseArc,
  maxSagitta: number = MAX_SAGITTA_M
): number {
  return arcSegmentCount(maxSemiAxis(arc), arc.t1 - arc.t0, maxSagitta);
}

/**
 * Tessellate an elliptical arc (uniform in the parameter) with chord error <= maxSagitta.
 * A full sweep closes exactly (last point is the first). `reserve` is called with the
 * point count before anything is allocated so the caller can enforce a point budget.
 */
export function tessellateEllipseArc(
  arc: EllipseArc,
  maxSagitta: number = MAX_SAGITTA_M,
  reserve?: (count: number) => void
): Xy[] {
  const n = ellipseArcSegments(arc, maxSagitta);
  reserve?.(n + 1);
  const sweep = arc.t1 - arc.t0;
  const pts: Xy[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(ellipsePoint(arc, arc.t0 + (sweep * i) / n));
  }
  if (Math.abs(sweep) >= 2 * Math.PI - 1e-9) pts[n] = { ...pts[0] };
  return pts;
}

/** Circle through p1 and p2 for a DXF bulge (tan of a quarter of the included angle). */
function bulgeCircle(p1: Xy, p2: Xy, bulge: number): EllipseArc {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  const absB = Math.abs(bulge);
  const r = (d / 4) * (absB + 1 / absB);
  const h = (d / 4) * (1 / absB - absB);
  const sign = bulge > 0 ? 1 : -1;
  const cx = (p1.x + p2.x) / 2 + h * (-sign * (dy / d));
  const cy = (p1.y + p2.y) / 2 + h * (sign * (dx / d));
  const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
  return {
    cx,
    cy,
    ux: r,
    uy: 0,
    vx: 0,
    vy: r,
    t0: startAngle,
    t1: startAngle + 4 * Math.atan(bulge),
  };
}

// -- NURBS -----------------------------------------------------------------------

/** Largest span index k in [p, n-1] with U[k] <= t (last non-empty span for t >= U[n]). */
function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n]) {
    let k = n - 1;
    while (k > p && U[k] >= U[n]) k--;
    return k;
  }
  let lo = p;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (U[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Point on a (rational) B-spline by de Boor's algorithm in homogeneous coordinates. */
export function nurbsPoint(nb: Nurbs, t: number): Xy {
  const p = nb.degree;
  const U = nb.knots;
  const k = findSpan(nb.ctrl.length, p, t, U);
  const dx: number[] = [];
  const dy: number[] = [];
  const dw: number[] = [];
  for (let j = 0; j <= p; j++) {
    const i = k - p + j;
    const w = nb.weights[i];
    dx.push(nb.ctrl[i].x * w);
    dy.push(nb.ctrl[i].y * w);
    dw.push(w);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const alpha = (t - U[i]) / (U[i + p - r + 1] - U[i]);
      dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
      dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
      dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
    }
  }
  return { x: dx[p] / dw[p], y: dy[p] / dw[p] };
}

function distanceToSegment(q: Xy, a: Xy, b: Xy): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(q.x - a.x, q.y - a.y);
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
  return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
}

const NURBS_MIN_DEPTH = 2;
const NURBS_MAX_DEPTH = 24;
/** Probe deviation allowed as a fraction of the sagitta bound (margin between probes). */
const NURBS_FLATNESS_MARGIN = 0.8;

/**
 * Adaptive tessellation of a NURBS curve with chord error <= maxSagitta (coordinates
 * and bound in the same unit - metres here). Every distinct knot is a vertex, so
 * C0 corners are exact; each knot span is split until the curve at 1/4, 1/2 and 3/4
 * of the interval lies within the bound of the chord.
 */
export function tessellateNurbs(
  nb: Nurbs,
  maxSagitta: number = MAX_SAGITTA_M,
  reserve?: (count: number) => void
): Xy[] {
  const p = nb.degree;
  const n = nb.ctrl.length;
  const U = nb.knots;
  const breaks: number[] = [];
  for (let i = p; i <= n; i++) {
    if (breaks.length === 0 || U[i] > breaks[breaks.length - 1]) breaks.push(U[i]);
  }
  const out: Xy[] = [];
  const push = (pt: Xy) => {
    reserve?.(1);
    out.push(pt);
  };
  const refine = (ta: number, pa: Xy, tb: number, pb: Xy, depth: number): void => {
    let flat = true;
    if (depth < NURBS_MIN_DEPTH) {
      flat = false;
    } else if (depth < NURBS_MAX_DEPTH) {
      for (const f of [0.25, 0.5, 0.75]) {
        const q = nurbsPoint(nb, ta + (tb - ta) * f);
        if (distanceToSegment(q, pa, pb) > NURBS_FLATNESS_MARGIN * maxSagitta) {
          flat = false;
          break;
        }
      }
    }
    if (flat) {
      push(pb);
      return;
    }
    const tm = (ta + tb) / 2;
    const pm = nurbsPoint(nb, tm);
    refine(ta, pa, tm, pm, depth + 1);
    refine(tm, pm, tb, pb, depth + 1);
  };
  let prev = nurbsPoint(nb, breaks[0]);
  push(prev);
  for (let i = 0; i + 1 < breaks.length; i++) {
    const next = nurbsPoint(nb, breaks[i + 1]);
    refine(breaks[i], prev, breaks[i + 1], next, 0);
    prev = next;
  }
  return out;
}

/** Nonzero B-spline basis functions N[0..p] at t in span `span` (Piegl & Tiller A2.2). */
function basisFuns(span: number, t: number, p: number, U: number[]): number[] {
  const N: number[] = new Array(p + 1).fill(0);
  const left: number[] = new Array(p + 1).fill(0);
  const right: number[] = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[span + 1 - j];
    right[j] = U[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/**
 * Clamped interpolating spline through fit points (global interpolation, Piegl &
 * Tiller 9.2.1): chord-length parameters, averaged knots, degree min(3, count-1).
 * Returns null when the fit points cannot be interpolated (fewer than two distinct
 * points, or a singular system).
 */
export function fitPointNurbs(fit: Xy[]): Nurbs | null {
  const pts: Xy[] = [];
  for (const q of fit) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-12) pts.push(q);
  }
  const n = pts.length;
  if (n < 2) return null;
  const p = Math.min(3, n - 1);

  const ubar: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    ubar.push(total);
  }
  for (let i = 1; i < n; i++) ubar[i] /= total;
  ubar[n - 1] = 1;

  const U: number[] = new Array(p + 1).fill(0);
  for (let j = 1; j <= n - 1 - p; j++) {
    let sum = 0;
    for (let i = j; i <= j + p - 1; i++) sum += ubar[i];
    U.push(sum / p);
  }
  for (let i = 0; i <= p; i++) U.push(1);

  // Banded collocation system A P = Q, A[k][i] = N_i,p(ubar[k]); bandwidth p each side.
  const width = 2 * p + 1;
  const band: number[][] = [];
  const rx: number[] = [];
  const ry: number[] = [];
  for (let k = 0; k < n; k++) {
    const span = findSpan(n, p, ubar[k], U);
    const N = basisFuns(span, ubar[k], p, U);
    const row: number[] = new Array(width).fill(0);
    for (let j = 0; j <= p; j++) {
      const col = span - p + j;
      const idx = col - k + p;
      if (idx < 0 || idx >= width) return null;
      row[idx] = N[j];
    }
    band.push(row);
    rx.push(pts[k].x);
    ry.push(pts[k].y);
  }
  for (let k = 0; k < n; k++) {
    const pivot = band[k][p];
    if (!(Math.abs(pivot) > 1e-14)) return null;
    for (let i = k + 1; i < Math.min(n, k + p + 1); i++) {
      const factor = band[i][k - i + p] / pivot;
      if (factor === 0) continue;
      for (let j = k; j < Math.min(n, k + p + 1); j++) {
        band[i][j - i + p] -= factor * band[k][j - k + p];
      }
      rx[i] -= factor * rx[k];
      ry[i] -= factor * ry[k];
    }
  }
  const ctrl: Xy[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sx = rx[i];
    let sy = ry[i];
    for (let j = i + 1; j < Math.min(n, i + p + 1); j++) {
      sx -= band[i][j - i + p] * ctrl[j].x;
      sy -= band[i][j - i + p] * ctrl[j].y;
    }
    ctrl[i] = { x: sx / band[i][p], y: sy / band[i][p] };
  }
  return { degree: p, knots: U, ctrl, weights: new Array(n).fill(1) };
}

// -- Affine transforms -----------------------------------------------------------

/** 3-D affine transform: 3x4 row-major [m00 m01 m02 tx; m10 m11 m12 ty; m20 m21 m22 tz]. */
type Mat = number[];

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a after b: (a o b)(p) = a(b(p)). */
function matMul(a: Mat, b: Mat): Mat {
  const r: Mat = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] =
        a[i * 4] * b[j] +
        a[i * 4 + 1] * b[4 + j] +
        a[i * 4 + 2] * b[8 + j] +
        (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return r;
}

function matPoint(m: Mat, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function matVec(m: Mat, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

function translateMat(x: number, y: number, z: number): Mat {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
}

function scaleMat(sx: number, sy: number, sz: number): Mat {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0];
}

function rotZMat(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Extrusion direction (codes 210/220/230, default 0,0,1), normalised; null when the
 * stored vector has no length.
 */
function extrusionOf(pairs: Pair[]): Vec3 | null {
  const n: Vec3 = [num(pairs, "210", 0), num(pairs, "220", 0), num(pairs, "230", 1)];
  if (!(Math.hypot(n[0], n[1], n[2]) > 1e-12)) return null;
  return normalize(n);
}

/**
 * OCS -> WCS matrix by the AutoCAD arbitrary-axis algorithm:
 * Ax = Wy x N when |Nx| and |Ny| are both < 1/64, otherwise Wz x N (normalised);
 * Ay = N x Ax. Columns are Ax, Ay, N.
 */
function ecsMatrix(n: Vec3): Mat {
  const ax = normalize(
    Math.abs(n[0]) < 1 / 64 && Math.abs(n[1]) < 1 / 64
      ? cross([0, 1, 0], n)
      : cross([0, 0, 1], n)
  );
  const ay = cross(n, ax);
  return [ax[0], ay[0], n[0], 0, ax[1], ay[1], n[1], 0, ax[2], ay[2], n[2], 0];
}

/** 2-D affine X = a x + b y + e, Y = c x + d y + f. */
type Aff = { a: number; b: number; c: number; d: number; e: number; f: number };

/** Plan-view (XY) image of OCS points at elevation z under the 3-D transform m. */
function planAffine(m: Mat, z: number): Aff {
  return { a: m[0], b: m[1], c: m[4], d: m[5], e: m[2] * z + m[3], f: m[6] * z + m[7] };
}

function affPoint(A: Aff, p: Xy): Xy {
  return { x: A.a * p.x + A.b * p.y + A.e, y: A.c * p.x + A.d * p.y + A.f };
}

/** Image of an elliptical arc under a 2-D affine map. */
function affArc(A: Aff, arc: EllipseArc): EllipseArc {
  const c = affPoint(A, { x: arc.cx, y: arc.cy });
  return {
    cx: c.x,
    cy: c.y,
    ux: A.a * arc.ux + A.b * arc.uy,
    uy: A.c * arc.ux + A.d * arc.uy,
    vx: A.a * arc.vx + A.b * arc.vy,
    vy: A.c * arc.vx + A.d * arc.vy,
    t0: arc.t0,
    t1: arc.t1,
  };
}

/** Linear part is a (possibly mirroring) similarity: circles stay circles. */
function similarityOf(A: Aff): { mirrored: boolean } | null {
  const c1 = Math.hypot(A.a, A.c);
  const c2 = Math.hypot(A.b, A.d);
  if (!(c1 > 0) || !(c2 > 0)) return null;
  const tol = 1e-9 * Math.max(c1, c2);
  if (Math.abs(c1 - c2) > tol) return null;
  if (Math.abs(A.a * A.b + A.c * A.d) > 1e-9 * c1 * c2) return null;
  return { mirrored: A.a * A.d - A.b * A.c < 0 };
}

/** Facts about an elliptical arc used to choose between circle and ellipse output. */
function analyseConic(arc: EllipseArc) {
  const uu = arc.ux * arc.ux + arc.uy * arc.uy;
  const vv = arc.vx * arc.vx + arc.vy * arc.vy;
  const uv = arc.ux * arc.vx + arc.uy * arc.vy;
  const det = arc.ux * arc.vy - arc.uy * arc.vx;
  const circular =
    Math.abs(uu - vv) <= 1e-9 * Math.max(uu, vv) && Math.abs(uv) <= 1e-9 * Math.sqrt(uu * vv);
  // Rotate the parameter so the axes are orthogonal: tan 2phi = 2 u.v / (|u|^2 - |v|^2).
  const phi = 0.5 * Math.atan2(2 * uv, uu - vv);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const majX = arc.ux * cp + arc.vx * sp;
  const majY = arc.uy * cp + arc.vy * sp;
  const minX = -arc.ux * sp + arc.vx * cp;
  const minY = -arc.uy * sp + arc.vy * cp;
  return {
    circular,
    mirrored: det < 0,
    radius: Math.sqrt(uu),
    angle0: Math.atan2(arc.uy, arc.ux),
    majorLen: Math.hypot(majX, majY),
    minorLen: Math.hypot(minX, minY),
    majorAngle: Math.atan2(majY, majX),
    phi,
  };
}

// -- Import context and diagnostics -----------------------------------------------

type Env = {
  /** Block-chain transform of the entity's container (identity at top level). */
  chain: Mat;
  /** Layer that layer-"0" content inherits (the INSERT's layer). */
  layer: string;
  /** Colour inherited from the INSERT, or null at top level. */
  color: number | null;
  /** Names of the blocks currently being expanded, outermost first. */
  stack: string[];
};

const ROOT_ENV: Env = { chain: IDENTITY, layer: "0", color: null, stack: [] };

type Ctx = {
  lib: Map<string, DxfBlock>;
  recs: Rec[];
  /** Top-level POINT entities (raw units): georef detection only, never a path. */
  pointCloud: Xy[];
  diag: {
    /** `${type}|${reason}` -> skipped entities of that type for that reason. */
    skipped: Map<string, { type: string; reason: string; count: number }>;
    /** entity type -> entities with a malformed number. */
    nonFinite: Map<string, number>;
    /** Entities ignored by classification (includes text). */
    ignored: number;
    /** Text-like entities ignored (TEXT, MTEXT, ATTRIB, ATTDEF). */
    text: number;
    /** Fit-point-only splines interpolated. */
    fitSplines: number;
  };
  entities: number;
  points: number;
};

function createContext(lib: Map<string, DxfBlock>): Ctx {
  return {
    lib,
    recs: [],
    pointCloud: [],
    diag: { skipped: new Map(), nonFinite: new Map(), ignored: 0, text: 0, fitSplines: 0 },
    entities: 0,
    points: 0,
  };
}

function noteSkipped(ctx: Ctx, type: string, reason: string): void {
  const key = `${type}|${reason}`;
  const cur = ctx.diag.skipped.get(key);
  if (cur) cur.count++;
  else ctx.diag.skipped.set(key, { type, reason, count: 1 });
}

function countEntity(ctx: Ctx): void {
  ctx.entities++;
  if (ctx.entities > MAX_DXF_ENTITIES) {
    throw new Error(
      `This DXF expands to more than ${MAX_DXF_ENTITIES.toLocaleString("en-US")} entities (after block expansion). ` +
        "Split the drawing into smaller files; nothing was imported."
    );
  }
}

function reservePoints(ctx: Ctx, count: number): void {
  ctx.points += count;
  if (ctx.points > MAX_DXF_POINTS) {
    throw new Error(
      `This DXF tessellates to more than ${MAX_DXF_POINTS.toLocaleString("en-US")} path points. ` +
        "Split the drawing or simplify its curves; nothing was imported."
    );
  }
}

/** Group codes whose values are numbers the importer interprets. */
function isNumericCode(code: string): boolean {
  const c = Number(code);
  return (c >= 10 && c <= 59) || (c >= 70 && c <= 79) || (c >= 210 && c <= 239);
}

function hasNonFinite(pairs: Pair[]): boolean {
  for (const p of pairs) {
    if (!isNumericCode(p.code)) continue;
    if (p.value === "" || !Number.isFinite(Number(p.value))) return true;
  }
  return false;
}

/** Counts the entity as malformed and returns false when any interpreted number is not finite. */
function checkFinite(raw: RawEntity, ctx: Ctx): boolean {
  if (
    !hasNonFinite(raw.pairs) &&
    !raw.vertices.some((v) => hasNonFinite(v))
  ) {
    return true;
  }
  ctx.diag.nonFinite.set(raw.type, (ctx.diag.nonFinite.get(raw.type) ?? 0) + 1);
  return false;
}

function failOnNonFinite(ctx: Ctx): void {
  if (ctx.diag.nonFinite.size === 0) return;
  const parts = [...ctx.diag.nonFinite.entries()].map(([t, n]) => `${n} ${t}`);
  throw new Error(
    `DXF contains non-finite or non-numeric coordinate values (${parts.join(", ")}). ` +
      "The file was not imported; fix or re-export the drawing."
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function diagnosticWarnings(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const { type, reason, count } of ctx.diag.skipped.values()) {
    out.push(`Skipped ${count} ${type} ${plural(count, "entity", "entities")} (${reason}).`);
  }
  if (ctx.diag.fitSplines > 0) {
    out.push(
      `Interpolated ${ctx.diag.fitSplines} fit-point-only SPLINE ${plural(ctx.diag.fitSplines, "entity", "entities")} ` +
        "with a clamped cubic through the fit points (end tangents, if any, are not applied)."
    );
  }
  if (ctx.diag.text > 0) {
    out.push(
      `Skipped ${ctx.diag.text} text ${plural(ctx.diag.text, "entity", "entities")} (TEXT/MTEXT): DXF text is not painted. ` +
        "Use the built-in text tool to mark lettering."
    );
  }
  return out;
}

// -- Entity expansion (blocks, OCS) ------------------------------------------------

function visitEntity(raw: RawEntity, env: Env, ctx: Ctx): void {
  const type = raw.type;
  const own = getSingle(raw.pairs, "8");
  // Content on layer "0" inherits the layer of the INSERT that places it.
  const layerName = own === "" || own === "0" ? env.layer : own;
  const colorRaw = Number(getSingle(raw.pairs, "62"));
  const color = env.color ?? (Number.isFinite(colorRaw) ? colorRaw : 7);

  // The ENTITIES section also holds paper-space (layout) entities: code 67 = 1. Title
  // blocks, viewports and layout annotation are not ground geometry.
  if (env.stack.length === 0 && getSingle(raw.pairs, "67") === "1") {
    noteSkipped(ctx, type, "paper-space layout entity");
    return;
  }

  if (type === "POINT") {
    if (!checkFinite(raw, ctx)) return;
    if (env.stack.length === 0) {
      ctx.pointCloud.push({ x: num(raw.pairs, "10", 0), y: num(raw.pairs, "20", 0) });
    }
    ctx.diag.ignored++;
    return;
  }

  const classification = classifyDxfEntity(type, layerName);
  if (classification === "ignore") {
    ctx.diag.ignored++;
    if (TEXT_TYPES.has(type)) ctx.diag.text++;
    return;
  }
  if (type !== "INSERT" && !GEOMETRY_TYPES.has(type)) {
    noteSkipped(ctx, type, "unsupported");
    return;
  }
  if (!checkFinite(raw, ctx)) return;
  countEntity(ctx);

  if (type === "INSERT") {
    expandInsert(raw, env, ctx, layerName, color);
    return;
  }

  const built = buildBody(type, raw, env.chain, ctx);
  if (!built) return;
  ctx.recs.push({ body: built.body, layerName, color, classification, key: built.key });
}

function expandInsert(
  raw: RawEntity,
  env: Env,
  ctx: Ctx,
  layerName: string,
  color: number
): void {
  const pairs = raw.pairs;
  const name = getSingle(pairs, "2");
  const block = ctx.lib.get(name.toUpperCase());
  if (!block) {
    noteSkipped(ctx, "INSERT", "block definition not found");
    return;
  }
  if (env.stack.some((n) => n.toUpperCase() === block.name.toUpperCase())) {
    throw new Error(
      `Block "${block.name}" contains itself (${[...env.stack, block.name].join(" -> ")}). ` +
        "The file was not imported; fix the circular block reference."
    );
  }
  if (env.stack.length >= MAX_BLOCK_NEST_DEPTH) {
    throw new Error(
      `Blocks are nested more than ${MAX_BLOCK_NEST_DEPTH} levels deep (${[...env.stack, block.name].join(" -> ")}). ` +
        "The file was not imported; flatten the block structure."
    );
  }

  const n = extrusionOf(pairs);
  const cols = num(pairs, "70", 1);
  const rows = num(pairs, "71", 1);
  const sx = num(pairs, "41", 1);
  const sy = num(pairs, "42", 1);
  const sz = num(pairs, "43", 1);
  if (n == null) {
    noteSkipped(ctx, "INSERT", "zero-length extrusion vector");
    return;
  }
  if (sx === 0 || sy === 0 || sz === 0) {
    noteSkipped(ctx, "INSERT", "zero scale factor");
    return;
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    noteSkipped(ctx, "INSERT", "invalid column/row count");
    return;
  }
  if (cols * rows > MAX_DXF_ENTITIES) {
    throw new Error(
      `An INSERT array of ${cols} x ${rows} instances exceeds the ${MAX_DXF_ENTITIES.toLocaleString("en-US")} entity limit. ` +
        "The file was not imported."
    );
  }
  if (hasNonFinite(block.header)) {
    ctx.diag.nonFinite.set("BLOCK", (ctx.diag.nonFinite.get("BLOCK") ?? 0) + 1);
    return;
  }
  const base: Vec3 = [num(block.header, "10", 0), num(block.header, "20", 0), num(block.header, "30", 0)];
  const ins: Vec3 = [num(pairs, "10", 0), num(pairs, "20", 0), num(pairs, "30", 0)];
  const colSp = num(pairs, "44", 0);
  const rowSp = num(pairs, "45", 0);
  const rot = (num(pairs, "50", 0) * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);

  // Block coordinates -> INSERT OCS: subtract the base point, scale, rotate.
  const local = matMul(rotZMat(rot), matMul(scaleMat(sx, sy, sz), translateMat(-base[0], -base[1], -base[2])));
  const ecs = ecsMatrix(n);
  ctx.diag.text += raw.attribs;
  ctx.diag.ignored += raw.attribs;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Array offsets live in the rotated INSERT frame and are not scaled.
      const ox = c * colSp;
      const oy = r * rowSp;
      const place = translateMat(
        ins[0] + cosR * ox - sinR * oy,
        ins[1] + sinR * ox + cosR * oy,
        ins[2]
      );
      const chain = matMul(env.chain, matMul(ecs, matMul(place, local)));
      const childEnv: Env = {
        chain,
        layer: layerName,
        color,
        stack: [...env.stack, block.name],
      };
      for (const child of block.entities) visitEntity(child, childEnv, ctx);
      if (cols * rows > 1) countEntity(ctx);
    }
  }
}

/** Primitive + representative points for one non-INSERT entity; null when skipped (noted). */
function buildBody(
  type: string,
  raw: RawEntity,
  chain: Mat,
  ctx: Ctx
): { body: Body; key: Xy[] } | null {
  switch (type) {
    case "LINE":
      return buildLine(raw, chain, ctx);
    case "LWPOLYLINE":
    case "POLYLINE":
      return buildPolyline(type, raw, chain, ctx);
    case "ARC":
    case "CIRCLE":
      return buildArcCircle(type, raw, chain, ctx);
    case "ELLIPSE":
      return buildEllipse(raw, chain, ctx);
    default:
      return buildSpline(raw, chain, ctx);
  }
}

function hasAll(pairs: Pair[], codes: string[]): boolean {
  return codes.every((c) => pairs.some((p) => p.code === c));
}

function buildLine(raw: RawEntity, chain: Mat, ctx: Ctx) {
  const pairs = raw.pairs;
  if (!hasAll(pairs, ["10", "20", "11", "21"])) {
    noteSkipped(ctx, "LINE", "missing end-point coordinates");
    return null;
  }
  // LINE end points are WCS (no OCS).
  const a = matPoint(chain, [num(pairs, "10", 0), num(pairs, "20", 0), num(pairs, "30", 0)]);
  const b = matPoint(chain, [num(pairs, "11", 0), num(pairs, "21", 0), num(pairs, "31", 0)]);
  const from = { x: a[0], y: a[1] };
  const to = { x: b[0], y: b[1] };
  if (from.x === to.x && from.y === to.y) {
    noteSkipped(ctx, "LINE", "zero length");
    return null;
  }
  return {
    body: {
      kind: "path",
      type: "LINE",
      start: from,
      pieces: [{ kind: "line", to }],
      closed: false,
      vertexCount: 2,
    } as Body,
    key: [from, to],
  };
}

type Vertex = Xy & { bulge: number };

/** LWPOLYLINE vertices: every (10, 20) with its optional bulge (42). Null when a vertex lacks y. */
function lwVertices(pairs: Pair[]): Vertex[] | null {
  const vertices: Vertex[] = [];
  let current: Vertex | null = null;
  let hasY = false;
  for (const pair of pairs) {
    if (pair.code === "10") {
      if (current && !hasY) return null;
      current = { x: Number(pair.value), y: 0, bulge: 0 };
      hasY = false;
      vertices.push(current);
    } else if (pair.code === "20" && current) {
      current.y = Number(pair.value);
      hasY = true;
    } else if (pair.code === "42" && current) {
      current.bulge = Number(pair.value);
    }
  }
  if (current && !hasY) return null;
  return vertices;
}

/** Classic POLYLINE vertices, dropping spline frame control points when the curve points exist. */
function polylineVertices(raw: RawEntity): Vertex[] | null {
  const flagsOf = (v: Pair[]) => num(v, "70", 0);
  const hasSplineCurvePoints = raw.vertices.some((v) => (flagsOf(v) & 8) !== 0);
  const out: Vertex[] = [];
  for (const v of raw.vertices) {
    if (hasSplineCurvePoints && (flagsOf(v) & 16) !== 0) continue;
    if (!hasAll(v, ["10", "20"])) return null;
    out.push({ x: num(v, "10", 0), y: num(v, "20", 0), bulge: num(v, "42", 0) });
  }
  return out;
}

function buildPolyline(type: "LWPOLYLINE" | "POLYLINE", raw: RawEntity, chain: Mat, ctx: Ctx) {
  const pairs = raw.pairs;
  const flags = num(pairs, "70", 0);
  let vertices: Vertex[] | null;
  let A: Aff;
  if (type === "LWPOLYLINE") {
    vertices = lwVertices(pairs);
    const n = extrusionOf(pairs);
    if (n == null) {
      noteSkipped(ctx, type, "zero-length extrusion vector");
      return null;
    }
    A = planAffine(matMul(chain, ecsMatrix(n)), num(pairs, "38", 0));
  } else {
    if ((flags & (16 | 64)) !== 0) {
      noteSkipped(ctx, type, "polygon/polyface mesh is not a path");
      return null;
    }
    vertices = polylineVertices(raw);
    if ((flags & 8) !== 0) {
      // 3-D polyline: vertices are WCS.
      A = planAffine(chain, 0);
    } else {
      const n = extrusionOf(pairs);
      if (n == null) {
        noteSkipped(ctx, type, "zero-length extrusion vector");
        return null;
      }
      A = planAffine(matMul(chain, ecsMatrix(n)), num(pairs, "30", 0));
    }
  }
  if (vertices == null) {
    noteSkipped(ctx, type, "vertex without coordinates");
    return null;
  }
  if (vertices.length < 2) {
    noteSkipped(ctx, type, "fewer than 2 vertices");
    return null;
  }
  const closed = (flags & 1) === 1;
  const sim = similarityOf(A);
  const pts = vertices.map((v) => affPoint(A, v));
  const pieces: Piece[] = [];
  const key: Xy[] = [pts[0]];

  const addSeg = (i: number, j: number) => {
    const v = vertices[i];
    const to = pts[j];
    const d = Math.hypot(vertices[j].x - v.x, vertices[j].y - v.y);
    if (Math.abs(v.bulge) < 1e-6 || d === 0) {
      pieces.push({ kind: "line", to });
      key.push(to);
      return;
    }
    if (sim) {
      const piece: Piece = {
        kind: "bulge",
        from: pts[i],
        to,
        bulge: sim.mirrored ? -v.bulge : v.bulge,
      };
      pieces.push(piece);
      const circ = bulgeCircle(piece.from, piece.to, piece.bulge);
      key.push(ellipsePoint(circ, (circ.t0 + circ.t1) / 2), to);
    } else {
      const arc = affArc(A, bulgeCircle(v, vertices[j], v.bulge));
      pieces.push({ kind: "ellipse", arc, to });
      key.push(ellipsePoint(arc, (arc.t0 + arc.t1) / 2), to);
    }
  };
  for (let i = 0; i < vertices.length - 1; i++) addSeg(i, i + 1);
  // A closed two-vertex polyline is only a loop when the second vertex carries a bulge.
  const last = vertices[vertices.length - 1];
  if (closed && (vertices.length > 2 || Math.abs(last.bulge) >= 1e-6)) {
    addSeg(vertices.length - 1, 0);
  }
  return {
    body: {
      kind: "path",
      type,
      start: pts[0],
      pieces,
      closed,
      vertexCount: vertices.length,
    } as Body,
    key,
  };
}

/** Sweep in degrees (0, 360] from start to end angle; null when degenerate. */
function arcSweepDeg(startDeg: number, endDeg: number): number | null {
  let s = endDeg - startDeg;
  while (s < 0) s += 360;
  while (s > 360) s -= 360;
  return s < 1e-9 ? null : s;
}

/** True when an elliptical arc has collapsed to a line or a point (edge-on or zero size). */
function isFlatConic(arc: EllipseArc): boolean {
  const det = arc.ux * arc.vy - arc.uy * arc.vx;
  const major = maxSemiAxis(arc);
  return !(major > 0) || Math.abs(det) <= 1e-9 * major * major;
}

function conicKey(arc: EllipseArc): Xy[] {
  const key: Xy[] = [];
  for (let i = 0; i <= 8; i++) key.push(ellipsePoint(arc, arc.t0 + ((arc.t1 - arc.t0) * i) / 8));
  return key;
}

function buildArcCircle(type: "ARC" | "CIRCLE", raw: RawEntity, chain: Mat, ctx: Ctx) {
  const pairs = raw.pairs;
  if (!hasAll(pairs, ["10", "20", "40"]) || (type === "ARC" && !hasAll(pairs, ["50", "51"]))) {
    noteSkipped(ctx, type, "missing centre, radius or angles");
    return null;
  }
  const radius = num(pairs, "40", 0);
  if (!(radius > 0)) {
    noteSkipped(ctx, type, "radius is not positive");
    return null;
  }
  const n = extrusionOf(pairs);
  if (n == null) {
    noteSkipped(ctx, type, "zero-length extrusion vector");
    return null;
  }
  let t0 = 0;
  let t1 = 2 * Math.PI;
  if (type === "ARC") {
    const startDeg = num(pairs, "50", 0);
    const sweep = arcSweepDeg(startDeg, num(pairs, "51", 0));
    if (sweep == null) {
      noteSkipped(ctx, type, "start and end angle are equal");
      return null;
    }
    t0 = (startDeg * Math.PI) / 180;
    t1 = t0 + (sweep * Math.PI) / 180;
  }
  const A = planAffine(matMul(chain, ecsMatrix(n)), num(pairs, "30", 0));
  const arc = affArc(A, {
    cx: num(pairs, "10", 0),
    cy: num(pairs, "20", 0),
    ux: radius,
    uy: 0,
    vx: 0,
    vy: radius,
    t0,
    t1,
  });
  if (isFlatConic(arc)) {
    noteSkipped(ctx, type, "collapsed to a line by its transform");
    return null;
  }
  return { body: { kind: "conic", type, arc } as Body, key: conicKey(arc) };
}

function buildEllipse(raw: RawEntity, chain: Mat, ctx: Ctx) {
  const pairs = raw.pairs;
  if (!hasAll(pairs, ["10", "20", "11", "21"])) {
    noteSkipped(ctx, "ELLIPSE", "missing centre or major axis");
    return null;
  }
  const n = extrusionOf(pairs);
  const ratio = num(pairs, "40", 1);
  const major: Vec3 = [num(pairs, "11", 0), num(pairs, "21", 0), num(pairs, "31", 0)];
  if (n == null) {
    noteSkipped(ctx, "ELLIPSE", "zero-length extrusion vector");
    return null;
  }
  if (!(ratio > 0) || !(Math.hypot(major[0], major[1], major[2]) > 0)) {
    noteSkipped(ctx, "ELLIPSE", "zero-size major axis or axis ratio");
    return null;
  }
  const start = num(pairs, "41", 0);
  let sweep = num(pairs, "42", 2 * Math.PI) - start;
  while (sweep < 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI + 1e-9) sweep -= 2 * Math.PI;
  if (sweep < 1e-12) {
    noteSkipped(ctx, "ELLIPSE", "start and end parameter are equal");
    return null;
  }
  // Centre and major axis are WCS; the extrusion fixes the sweep direction:
  // minor axis = ratio * (N x major).
  const minor = cross(n, major);
  const c = matPoint(chain, [num(pairs, "10", 0), num(pairs, "20", 0), num(pairs, "30", 0)]);
  const u = matVec(chain, major);
  const v = matVec(chain, [minor[0] * ratio, minor[1] * ratio, minor[2] * ratio]);
  const arc: EllipseArc = {
    cx: c[0],
    cy: c[1],
    ux: u[0],
    uy: u[1],
    vx: v[0],
    vy: v[1],
    t0: start,
    t1: start + sweep,
  };
  if (isFlatConic(arc)) {
    noteSkipped(ctx, "ELLIPSE", "collapsed to a line by its transform");
    return null;
  }
  return { body: { kind: "conic", type: "ELLIPSE", arc } as Body, key: conicKey(arc) };
}

function buildSpline(raw: RawEntity, chain: Mat, ctx: Ctx) {
  const pairs = raw.pairs;
  const flags = num(pairs, "70", 0);
  const closedFlag = (flags & (1 | 2)) !== 0;
  const toXy = (x: number, y: number, z: number): Xy => {
    const p = matPoint(chain, [x, y, z]);
    return { x: p[0], y: p[1] };
  };
  const cx = allNumbers(pairs, "10");
  const cy = allNumbers(pairs, "20");
  const cz = allNumbers(pairs, "30");
  const fx = allNumbers(pairs, "11");
  const fy = allNumbers(pairs, "21");
  const fz = allNumbers(pairs, "31");
  if (cx.length !== cy.length || fx.length !== fy.length) {
    noteSkipped(ctx, "SPLINE", "control or fit point without both coordinates");
    return null;
  }
  const ctrl = cx.map((x, i) => toXy(x, cy[i], cz[i] ?? 0));
  const fit = fx.map((x, i) => toXy(x, fy[i], fz[i] ?? 0));

  if (ctrl.length === 0) {
    if (fit.length < 2) {
      noteSkipped(ctx, "SPLINE", "no control points and fewer than 2 fit points");
      return null;
    }
    if (closedFlag) {
      noteSkipped(ctx, "SPLINE", "closed or periodic fit-point-only spline is not supported");
      return null;
    }
    return { body: { kind: "spline", nurbs: null, fit, closedFlag } as Body, key: fit };
  }

  const degree = num(pairs, "71", 3);
  const knots = allNumbers(pairs, "40");
  const weightsRaw = allNumbers(pairs, "41");
  if (!Number.isInteger(degree) || degree < 1 || degree > 10 || ctrl.length < degree + 1) {
    noteSkipped(ctx, "SPLINE", "degree is invalid for the number of control points");
    return null;
  }
  if (knots.length !== ctrl.length + degree + 1) {
    noteSkipped(
      ctx,
      "SPLINE",
      "invalid knot vector: the knot count must equal control points + degree + 1"
    );
    return null;
  }
  for (let i = 0; i + 1 < knots.length; i++) {
    if (knots[i + 1] < knots[i]) {
      noteSkipped(ctx, "SPLINE", "invalid knot vector: knots decrease");
      return null;
    }
  }
  if (!(knots[ctrl.length] > knots[degree])) {
    noteSkipped(ctx, "SPLINE", "invalid knot vector: empty parameter domain");
    return null;
  }
  const weights = weightsRaw.length === 0 ? ctrl.map(() => 1) : weightsRaw;
  if (weights.length !== ctrl.length || weights.some((w) => !(w > 0))) {
    noteSkipped(ctx, "SPLINE", "weights are inconsistent with the control points or not positive");
    return null;
  }
  return {
    body: { kind: "spline", nurbs: { degree, knots, ctrl, weights }, fit: [], closedFlag } as Body,
    key: ctrl,
  };
}

// -- Output ------------------------------------------------------------------------

/** File units -> metres (local NED frame about the geo origin for geographic files). */
type Frame = {
  geographic: boolean;
  point: (p: Xy) => Xy;
  arc: (a: EllipseArc) => EllipseArc;
};

/**
 * Metric: uniform scale by the unit factor.
 * Geographic: every point projects through projectGpsToLocalMeters about the origin.
 * Mirroring path_engine/parsers/georef.py detect_and_project, a curve defined by a centre
 * and radius projects its CENTRE per axis and scales its axes by the NORTH metres per
 * degree (the axis cos(lat) does not distort).
 */
function makeFrame(scale: number, origin: { lat: number; lon: number } | null): Frame {
  if (!origin) {
    return {
      geographic: false,
      point: (p) => ({ x: p.x * scale, y: p.y * scale }),
      arc: (a) => ({
        cx: a.cx * scale,
        cy: a.cy * scale,
        ux: a.ux * scale,
        uy: a.uy * scale,
        vx: a.vx * scale,
        vy: a.vy * scale,
        t0: a.t0,
        t1: a.t1,
      }),
    };
  }
  const { mPerDegNorth } = metresPerDegree(origin.lat);
  const point = (p: Xy): Xy => {
    const m = projectGpsToLocalMeters(p.y, p.x, origin.lat, origin.lon);
    return { x: m.east, y: m.north };
  };
  return {
    geographic: true,
    point,
    arc: (a) => {
      const c = point({ x: a.cx, y: a.cy });
      return {
        cx: c.x,
        cy: c.y,
        ux: a.ux * mPerDegNorth,
        uy: a.uy * mPerDegNorth,
        vx: a.vx * mPerDegNorth,
        vy: a.vy * mPerDegNorth,
        t0: a.t0,
        t1: a.t1,
      };
    },
  };
}

function pushDistinct(out: Xy[], p: Xy): void {
  const prev = out[out.length - 1];
  if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-9) out.push(p);
}

/** Flatten a path (straights + arcs) in metres. Arc ends are pinned to the vertices. */
function tessellatePath(
  body: Extract<Body, { kind: "path" }>,
  frame: Frame,
  ctx: Ctx
): Xy[] {
  const reserve = (n: number) => reservePoints(ctx, n);
  const out: Xy[] = [frame.point(body.start)];
  reserve(1);
  for (const piece of body.pieces) {
    const to = frame.point(piece.to);
    if (piece.kind === "line") {
      reserve(1);
      out.push(to);
      continue;
    }
    const from = out[out.length - 1];
    let samples: Xy[];
    if (piece.kind === "bulge") {
      if (Math.hypot(to.x - from.x, to.y - from.y) === 0) {
        out.push(to);
        continue;
      }
      samples = tessellateEllipseArc(bulgeCircle(from, to, piece.bulge), MAX_SAGITTA_M, reserve);
    } else {
      if (frame.geographic) {
        throw new Error(
          "A georeferenced DXF contains a non-uniformly scaled INSERT with arc segments, which cannot be projected exactly. " +
            "The file was not imported; explode the block or use a uniform scale."
        );
      }
      samples = tessellateEllipseArc(frame.arc(piece.arc), MAX_SAGITTA_M, reserve);
    }
    samples[0] = from;
    samples[samples.length - 1] = to;
    for (const s of samples) pushDistinct(out, s);
  }
  return out;
}

function polylineLength(pts: Xy[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function norm360(d: number): number {
  return ((d % 360) + 360) % 360 + 0;
}

function emitRec(
  rec: Rec,
  frame: Frame,
  ctx: Ctx,
  lines: PlanLine[],
  idxRef: { value: number },
  pointIdRef: { value: number }
): void {
  const isMark = rec.classification === "mark";
  const planLayer = planLayerForClass(rec.classification);
  const labelPrefix = isMark ? "Marking" : "Transit";
  const common = {
    layer: planLayer,
    isMark,
    layerName: rec.layerName,
    color: rec.color,
    pointIdRef,
  };
  const body = rec.body;

  if (body.kind === "path") {
    const pts = tessellatePath(body, frame, ctx);
    const idx = idxRef.value++;
    const id = `${body.type}-${idx}`;
    if (body.type === "LINE") {
      const from = pts[0];
      const to = pts[pts.length - 1];
      pushLine(lines, {
        ...common,
        id,
        label: `${labelPrefix} Line ${idx + 1}`,
        entityType: "LINE",
        lengthM: Math.hypot(to.x - from.x, to.y - from.y),
        geometry: { start: [from.y, from.x], end: [to.y, to.x] },
        preview: pts,
      });
      return;
    }
    pushLine(lines, {
      ...common,
      id,
      label: `${labelPrefix} Polyline ${idx + 1}`,
      entityType: body.type,
      lengthM: polylineLength(pts),
      geometry: { closed: body.closed, vertexCount: body.vertexCount },
      preview: pts,
    });
    return;
  }

  if (body.kind === "conic") {
    const arc = frame.arc(body.arc);
    const shape = analyseConic(arc);
    let pts = tessellateEllipseArc(arc, MAX_SAGITTA_M, (n) => reservePoints(ctx, n));
    const idx = idxRef.value++;
    const sweepRad = arc.t1 - arc.t0;
    const full = Math.abs(sweepRad) >= 2 * Math.PI - 1e-9;

    if (body.type !== "ELLIPSE" && shape.circular) {
      // A true circle/arc (similarity, possibly mirrored). Geometry is CCW from
      // startAngle to endAngle, so a mirrored (clockwise) arc is emitted reversed.
      const startRad = shape.mirrored ? shape.angle0 - arc.t1 : shape.angle0 + arc.t0;
      const startAngle = norm360(deg(startRad));
      const sweepDeg = full ? 360 : deg(sweepRad);
      if (shape.mirrored) pts = pts.slice().reverse();
      pushLine(lines, {
        ...common,
        id: `${body.type}-${idx}`,
        label: `${labelPrefix} ${body.type === "CIRCLE" ? "Circle" : "Arc"} ${idx + 1}`,
        entityType: body.type,
        lengthM: shape.radius * Math.abs(sweepRad),
        geometry: dxfCurveGeometryToNed({
          cx: arc.cx,
          cy: arc.cy,
          radius: shape.radius,
          startAngle,
          endAngle: startAngle + sweepDeg,
        }),
        preview: pts,
      });
      return;
    }

    // Elliptical result (ELLIPSE entity, or an ARC/CIRCLE under a non-uniform scale /
    // oblique extrusion): principal-axis form, parameters measured from the major axis.
    pushLine(lines, {
      ...common,
      id: `ELLIPSE-${idx}`,
      label: `${labelPrefix} Ellipse ${idx + 1}`,
      entityType: "ELLIPSE",
      lengthM: polylineLength(pts),
      geometry: {
        cx: arc.cx,
        cy: arc.cy,
        majorLen: shape.majorLen,
        minorLen: shape.minorLen,
        majorAngle: shape.majorAngle,
        startParam: arc.t0 - shape.phi,
        endParam: arc.t1 - shape.phi,
        clockwise: shape.mirrored,
      },
      preview: pts,
    });
    return;
  }

  // SPLINE
  const nurbs: Nurbs | null = body.nurbs
    ? { ...body.nurbs, ctrl: body.nurbs.ctrl.map(frame.point) }
    : fitPointNurbs(body.fit.map(frame.point));
  if (!nurbs) {
    noteSkipped(ctx, "SPLINE", "fit points could not be interpolated");
    return;
  }
  const pts = tessellateNurbs(nurbs, MAX_SAGITTA_M, (n) => reservePoints(ctx, n));
  if (body.closedFlag) {
    const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
    if (gap > MAX_SAGITTA_M) {
      noteSkipped(ctx, "SPLINE", "flagged closed or periodic but its control data does not close");
      return;
    }
  }
  if (!body.nurbs) ctx.diag.fitSplines++;
  const idx = idxRef.value++;
  const rational = nurbs.weights.some((w) => w !== 1);
  pushLine(lines, {
    ...common,
    id: `SPLINE-${idx}`,
    label: `${labelPrefix} Spline ${idx + 1}`,
    entityType: "SPLINE",
    lengthM: polylineLength(pts),
    geometry: {
      degree: nurbs.degree,
      num_control_points: nurbs.ctrl.length,
      rational,
      fit_points_only: !body.nurbs,
    },
    preview: pts,
  });
}

function pushLine(
  lines: PlanLine[],
  args: {
    id: string;
    label: string;
    layer: PlanLayer;
    isMark: boolean;
    entityType: string;
    layerName: string;
    color: number;
    lengthM: number;
    geometry: Record<string, unknown>;
    /** Metre samples in CAD axes (x = east, y = north). */
    preview: Xy[];
    pointIdRef: { value: number };
  }
): void {
  const preview_points = args.preview.map((p) => ({ north: p.y, east: p.x }));
  const first = preview_points[0];
  const last = preview_points[preview_points.length - 1];
  lines.push({
    id: args.id,
    label: args.label,
    layer: args.layer,
    from: { id: args.pointIdRef.value++, x: first.north, y: first.east },
    to: { id: args.pointIdRef.value++, x: last.north, y: last.east },
    width: 0.1,
    is_mark: args.isMark,
    entity: {
      entity_id: args.id,
      entity_type: args.entityType,
      layer: args.layerName,
      color: args.color,
      is_mark: args.isMark,
      length_m: args.lengthM,
      geometry: args.geometry,
      preview_points,
    },
  });
}

// -- DXF pair helpers ------------------------------------------------------------

function toPairs(content: string): Pair[] {
  const rows = content.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i < rows.length - 1; i += 2) {
    pairs.push({ code: rows[i].trim(), value: rows[i + 1].trim() });
  }
  return pairs;
}

function extractSection(pairs: Pair[], sectionName: string): Pair[] {
  for (let i = 0; i < pairs.length; i++) {
    if (
      pairs[i]?.code === "0" &&
      pairs[i]?.value === "SECTION" &&
      pairs[i + 1]?.code === "2" &&
      pairs[i + 1]?.value === sectionName
    ) {
      let j = i + 2;
      const result: Pair[] = [];
      while (j < pairs.length && !(pairs[j].code === "0" && pairs[j].value === "ENDSEC")) {
        result.push(pairs[j]);
        j++;
      }
      return result;
    }
  }
  return [];
}

/**
 * Split a section into entities. A POLYLINE keeps its VERTEX sub-entities and an INSERT
 * keeps a count of its ATTRIB sub-entities; both end at SEQEND (or at the next entity
 * when SEQEND is missing, so a malformed polyline can never swallow what follows).
 */
function collectEntityGroups(sectionPairs: Pair[]): RawEntity[] {
  const groups: RawEntity[] = [];
  let i = 0;
  while (i < sectionPairs.length) {
    const p = sectionPairs[i];
    if (p.code !== "0") {
      i++;
      continue;
    }
    const type = p.value.toUpperCase();
    i++;
    const groupPairs: Pair[] = [];
    while (i < sectionPairs.length && sectionPairs[i].code !== "0") {
      groupPairs.push(sectionPairs[i]);
      i++;
    }
    const vertices: Pair[][] = [];
    let attribs = 0;
    if (type === "POLYLINE" || (type === "INSERT" && getSingle(groupPairs, "66") === "1")) {
      const childType = type === "POLYLINE" ? "VERTEX" : "ATTRIB";
      while (i < sectionPairs.length && sectionPairs[i].code === "0") {
        const sub = sectionPairs[i].value.toUpperCase();
        if (sub === childType) {
          i++;
          const subPairs: Pair[] = [];
          while (i < sectionPairs.length && sectionPairs[i].code !== "0") {
            subPairs.push(sectionPairs[i]);
            i++;
          }
          if (type === "POLYLINE") vertices.push(subPairs);
          else attribs++;
        } else {
          if (sub === "SEQEND") {
            i++;
            while (i < sectionPairs.length && sectionPairs[i].code !== "0") i++;
          }
          break;
        }
      }
    }
    if (type === "SEQEND") continue;
    groups.push({ type, pairs: groupPairs, vertices, attribs });
  }
  return groups;
}

function buildBlockLibrary(pairs: Pair[]): Map<string, DxfBlock> {
  const blocks = new Map<string, DxfBlock>();
  const sectionPairs = extractSection(pairs, "BLOCKS");
  let i = 0;
  while (i < sectionPairs.length) {
    if (sectionPairs[i].code === "0" && sectionPairs[i].value === "BLOCK") {
      i++;
      const blockPairs: Pair[] = [];
      while (
        i < sectionPairs.length &&
        !(sectionPairs[i].code === "0" && sectionPairs[i].value === "ENDBLK")
      ) {
        blockPairs.push(sectionPairs[i]);
        i++;
      }
      if (i < sectionPairs.length) i++;
      // Header = group codes before the first entity (name, base point, flags).
      const firstEntity = blockPairs.findIndex((p) => p.code === "0");
      const header = firstEntity === -1 ? blockPairs : blockPairs.slice(0, firstEntity);
      const blockName = getSingle(header, "2");
      if (blockName) {
        blocks.set(blockName.toUpperCase(), {
          name: blockName,
          header,
          entities: collectEntityGroups(blockPairs),
        });
      }
    } else {
      i++;
    }
  }
  return blocks;
}

function getSingle(pairs: Pair[], code: string): string {
  return pairs.find((p) => p.code === code)?.value ?? "";
}

/** First value of `code` as a number, or `fallback` when the code is absent. */
function num(pairs: Pair[], code: string, fallback: number): number {
  const p = pairs.find((q) => q.code === code);
  return p ? Number(p.value) : fallback;
}

function allNumbers(pairs: Pair[], code: string): number[] {
  return pairs.filter((p) => p.code === code).map((p) => Number(p.value));
}
