/**
 * Local DXF import that matches the rover's parser (G1/G2/G3/G6).
 *
 * Built for app-planned DXF missions (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 1).
 *
 * Contract — path fidelity:
 * - LINE / LWPOLYLINE / ARC / CIRCLE / SPLINE / ELLIPSE vertices (and sagitta
 *   samples of curves) are the **real file path**. The app does **not** re-fit
 *   or regenerate that geometry the way CSV road-marking does.
 * - Unit scale ($INSUNITS) and georef projection only change frame, not shape.
 * - Path generation (straights + Hyper-fit arcs from sparse points) is CSV-only
 *   (`localCsvPointsToPlanLines`). A points-only DXF is not auto-fitted here.
 *
 * Output PlanLine[] uses app NED: PlanPoint.x = north, PlanPoint.y = east;
 * entity.preview_points are {north, east} in metres.
 */

import type { PlanLayer, PlanLine, PlanPoint } from "../types/plan";
import { dxfCurveGeometryToNed } from "./curveGeometry";
import {
  looksGeographic,
  metresPerDegreePx4,
  projectGeographicToLocalNed,
} from "./geoProjection";
import { rebasePlanLineToOrigin } from "./planOriginRebase";

// ── $INSUNITS → metres (path_engine/parsers/dxf_parser.py) ──────────────────

/** DXF $INSUNITS values to metres per unit (DXF specification). */
export const INSUNITS_TO_METRES: Record<number, number | null> = {
  0: null, // unspecified — use fallback
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
};

export type DxfEntityClass = "mark" | "transit" | "ignore";

type Pair = { code: string; value: string };
type Xy = { x: number; y: number };
type Vertex = Xy & { bulge: number };

type DxfBlock = {
  name: string;
  entities: { type: string; pairs: Pair[] }[];
};

/**
 * Curve source kept from the parse pass so a geographic file can be re-derived
 * in metres once `looksGeographic` has run.
 *
 * Detection needs every coordinate in the file, so it can only run AFTER the
 * entities are parsed — by which time an ARC/CIRCLE/bulge has already been
 * tessellated in the file's own units. Keyed by entity id (`ARC-3`, …).
 *
 * Coordinates are CAD x (=lon for a geo file) / y (=lat), with any INSERT
 * transform already applied.
 */
type RawGeoCurve =
  | {
      kind: "arc";
      cx: number;
      cy: number;
      radius: number;
      startAngle: number;
      endAngle: number;
    }
  | { kind: "bulge"; vertices: Vertex[]; closed: boolean };

type InsertTransform = {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  cosR: number;
  sinR: number;
};

// ── Public API ──────────────────────────────────────────────────────────────

export function parseLocalDxf(text: string, fileName: string): LocalDxfResult {
  const warnings: string[] = [];
  const pairs = toPairs(text);
  const { scale, source, insunits } = readUnitScale(pairs);

  // Parse in raw DXF units (scale=1). Unit scale is applied only after we know
  // the drawing is metric — geographic files store lat/lon and must not be
  // multiplied by cm/mm fallbacks (G1/G2 order).
  // `scale` still rides along as fileUnitScale: curve tessellation needs a metre
  // sagitta bound expressed in drawing units, which is a density choice, not a
  // coordinate change (see parseEntity's sagittaFileUnits).
  const blockLib = buildBlockLibrary(pairs);
  const sectionPairs = extractSection(pairs, "ENTITIES");
  const entityGroups = collectEntityGroups(sectionPairs);

  const lines: PlanLine[] = [];
  let ignoredCount = 0;
  const entityIndexRef = { value: 0 };
  const pointIdRef = { value: 1 };
  // Standalone POINT entities (raw DXF units, file order) — only used for georef
  // detection when there is no line/curve sample. Never converted into a fitted path
  // (path generation is CSV-only via localCsvPointsToPlanLines).
  const pointCloudCad: Xy[] = [];
  // Curve sources in raw file units, for geographic re-tessellation (see projectGeoCurves).
  const rawGeoCurves = new Map<string, RawGeoCurve>();

  for (const group of entityGroups) {
    const layerName = getSingle(group.pairs, "8") || "0";
    const color = getNumber(group.pairs, "62");
    if (group.type.toUpperCase() === "POINT") {
      const px = getNumber(group.pairs, "10");
      const py = getNumber(group.pairs, "20");
      if (Number.isFinite(px) && Number.isFinite(py)) pointCloudCad.push({ x: px, y: py });
    }
    const classification = classifyDxfEntity(group.type, layerName);
    if (classification === "ignore") {
      ignoredCount++;
      continue;
    }
    parseEntity({
      type: group.type,
      entityPairs: group.pairs,
      layerName,
      color: Number.isFinite(color) ? color : 7,
      classification,
      unitScale: 1,
      fileUnitScale: scale,
      blockLib,
      entityIndexRef,
      pointIdRef,
      lines,
      insertTransform: null,
      rawGeoCurves,
    });
  }

  // Axis swap CAD (X=east,Y=north) → app PlanPoint (x=north, y=east).
  // Preserves entity vertices; does not re-fit or smooth the path.
  let nedLines = applyAxisSwap(lines);

  const pointCloudNed = pointCloudCad.map((p) => ({ north: p.y, east: p.x }));

  let samplePts = collectPreviewPoints(nedLines);
  const usingPointCloudForGeo = samplePts.length === 0 && pointCloudNed.length > 0;
  if (usingPointCloudForGeo) samplePts = pointCloudNed;

  const geoCheck = looksGeographic(samplePts);
  let isGeographic = false;
  let geoOrigin: { lat: number; lon: number } | null = null;
  let effectiveScale = scale;
  let effectiveSource: "insunits" | "fallback" = source;

  if (geoCheck.isGeographic) {
    isGeographic = true;
    effectiveScale = 1;
    effectiveSource = "insunits";
    const projected = projectGeographicToLocalNed(samplePts);
    geoOrigin = projected.origin;
    // Frame change only: same relative path, NED about geoOrigin for plan-trajectory.
    nedLines = applyProjectedPoints(nedLines, samplePts, projected.points);
    nedLines = projectGeoCurves(nedLines, rawGeoCurves, geoOrigin);
    warnings.push(
      `Georeferenced DXF detected — projected about (${geoOrigin.lat.toFixed(6)}, ${geoOrigin.lon.toFixed(6)}) using PX4 sphere. File path geometry is preserved.`
    );
  } else {
    if (source === "fallback") {
      warnings.push(
        `$INSUNITS absent or 0 — assumed centimetres (scale ${DEFAULT_UNIT_SCALE_M}). Confirm unit scale before Send.`
      );
    }
    if (scale !== 1) {
      nedLines = scalePlanLines(nedLines, scale);
    }
  }

  // Points-only DXF: do NOT invent a path. CSV is the only path generator.
  if (nedLines.length === 0 && pointCloudCad.length > 0) {
    warnings.push(
      `No LINE/LWPOLYLINE/ARC/CIRCLE/SPLINE/ELLIPSE path geometry in this DXF (${pointCloudCad.length} POINT entities ignored for path). ` +
        `The app does not generate paths from DXF points — export LINE/POLYLINE geometry, or use a survey CSV for point-based path generation.`
    );
  }

  const entityCount = nedLines.length;
  if (ignoredCount > 0) {
    warnings.push(
      `Ignored ${ignoredCount} entity(ies) (POINT / annotation / hatch layers).`
    );
  }

  return {
    fileName,
    unitScale: effectiveScale,
    unitScaleSource: effectiveSource,
    insunits,
    isGeographic,
    geoOrigin,
    lines: nedLines,
    entityCount,
    ignoredCount,
    warnings,
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
 * (each parse restarts at LINE-0, ARC-0, …).
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
  const mergedLines: PlanLine[] = [];
  let ignoredCount = 0;
  let entityCount = 0;

  if (isGeographic) {
    const geoOrigin = results.find((r) => r.geoOrigin != null)?.geoOrigin ?? null;
    if (!geoOrigin) {
      throw new Error("No geographic origin found in the selected DXF files.");
    }

    for (const r of results) {
      warnings.push(...r.warnings.map((w) => `${r.fileName}: ${w}`));
      ignoredCount += r.ignoredCount;
      entityCount += r.entityCount;
      const stem = dxfFileStem(r.fileName);
      const origin = r.geoOrigin ?? geoOrigin;
      const rebased = r.lines.map((line) =>
        rebaseGeoDxfLine(line, origin, geoOrigin)
      );
      mergedLines.push(...prefixDxfLineIds(rebased, stem));
    }

    return {
      fileName: combinedDxfFileName(results.map((r) => r.fileName)),
      unitScale: 1,
      unitScaleSource: "insunits",
      insunits: results[0].insunits,
      isGeographic: true,
      geoOrigin,
      lines: mergedLines,
      entityCount,
      ignoredCount,
      warnings,
    };
  }

  // Metric DXF — same local CAD frame assumed.
  for (const r of results) {
    warnings.push(...r.warnings.map((w) => `${r.fileName}: ${w}`));
    ignoredCount += r.ignoredCount;
    entityCount += r.entityCount;
    const stem = dxfFileStem(r.fileName);
    mergedLines.push(...prefixDxfLineIds(r.lines, stem));
  }

  return {
    fileName: combinedDxfFileName(results.map((r) => r.fileName)),
    unitScale: results[0].unitScale,
    unitScaleSource: results[0].unitScaleSource,
    insunits: results[0].insunits,
    isGeographic: false,
    geoOrigin: null,
    lines: mergedLines,
    entityCount,
    ignoredCount,
    warnings,
  };
}

/** Scale all geometry by metres-per-DXF-unit (metric drawings only). */
function scalePlanLines(lines: PlanLine[], scale: number): PlanLine[] {
  if (scale === 1) return lines;
  return lines.map((line) => {
    const preview = line.entity?.preview_points?.map((p) => ({
      north: p.north * scale,
      east: p.east * scale,
    }));
    const length =
      preview && preview.length >= 2
        ? polylineLength(preview.map((p) => ({ x: p.east, y: p.north })))
        : (line.entity?.length_m ?? 0) * scale;
    return {
      ...line,
      from: { ...line.from, x: line.from.x * scale, y: line.from.y * scale },
      to: { ...line.to, x: line.to.x * scale, y: line.to.y * scale },
      entity: line.entity
        ? {
            ...line.entity,
            length_m: length,
            preview_points: preview ?? line.entity.preview_points,
            geometry: scaleGeometry(line.entity.geometry, scale),
          }
        : undefined,
    };
  });
}

function scaleGeometry(geom: Record<string, unknown> | undefined, scale: number): Record<string, unknown> {
  if (!geom || typeof geom !== "object") return geom ?? {};
  const out: Record<string, unknown> = { ...geom };
  for (const key of ["cx", "cy", "radius", "majorLen", "minorLen", "centerNorth", "centerEast"] as const) {
    if (typeof out[key] === "number") out[key] = (out[key] as number) * scale;
  }
  return out;
}

/**
 * Port of DXFEntity.classify() default rules (path_engine/core.py).
 * POINT → ignore; DIM/DEFPOINTS/ANNOT/HATCH → ignore;
 * TRANSIT/TRAVEL/MOVE/RAPID → transit; else mark.
 */
export function classifyDxfEntity(
  entityType: string,
  layerName: string
): DxfEntityClass {
  const type = (entityType || "").toUpperCase();
  if (type === "POINT") return "ignore";
  // TEXT/MTEXT are annotation; never paint.
  if (type === "TEXT" || type === "MTEXT") return "ignore";

  const upper = (layerName || "").toUpperCase();
  for (const kw of ["DIM", "DEFPOINTS", "ANNOT", "HATCH"] as const) {
    if (upper.includes(kw)) return "ignore";
  }
  for (const kw of ["TRANSIT", "TRAVEL", "MOVE", "RAPID"] as const) {
    if (upper.includes(kw)) return "transit";
  }
  return "mark";
}

/** Map classification → PlanLayer used by isPaintableMarkLine. */
export function planLayerForClass(c: DxfEntityClass): PlanLayer {
  if (c === "transit") return "transit";
  return "marking";
}

// ── Unit scale ──────────────────────────────────────────────────────────────

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

// ── Tessellation (sagitta-bounded) ──────────────────────────────────────────

/**
 * Chord count for a circular arc so sagitta ≤ maxSagitta.
 * sagitta = r (1 − cos(θ/2)); θ = 2 acos(1 − s/r).
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

export function sampleArcSagitta(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
  maxSagitta: number = MAX_SAGITTA_M
): Xy[] {
  const normalizedEnd = endAngleDeg >= startAngleDeg ? endAngleDeg : endAngleDeg + 360;
  const sweepDeg = normalizedEnd - startAngleDeg;
  const sweepRad = (sweepDeg * Math.PI) / 180;
  const n = arcSegmentCount(radius, sweepRad, maxSagitta);
  const points: Xy[] = [];
  for (let i = 0; i <= n; i++) {
    const a = startAngleDeg + (sweepDeg * i) / n;
    const rad = (a * Math.PI) / 180;
    points.push({
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    });
  }
  return points;
}

export function sampleBulgeSagitta(
  p1: Xy,
  p2: Xy,
  bulge: number,
  maxSagitta: number = MAX_SAGITTA_M
): Xy[] {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || Math.abs(bulge) < 1e-6) return [p1, p2];

  const absB = Math.abs(bulge);
  const r = (d / 4) * (absB + 1 / absB);
  const h = (d / 4) * (1 / absB - absB);
  const sign = bulge > 0 ? 1 : -1;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const cx = mx + h * (-sign * (dy / d));
  const cy = my + h * (sign * (dx / d));
  const startAngleRad = Math.atan2(p1.y - cy, p1.x - cx);
  const sweepRad = 4 * Math.atan(bulge);
  const n = arcSegmentCount(r, sweepRad, maxSagitta);
  const points: Xy[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = startAngleRad + sweepRad * t;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return points;
}

// ── Entity parse ────────────────────────────────────────────────────────────

function parseEntity(args: {
  type: string;
  entityPairs: Pair[];
  layerName: string;
  color: number;
  classification: DxfEntityClass;
  unitScale: number;
  fileUnitScale: number;
  blockLib: Map<string, DxfBlock>;
  entityIndexRef: { value: number };
  pointIdRef: { value: number };
  lines: PlanLine[];
  insertTransform: InsertTransform | null;
  rawGeoCurves: Map<string, RawGeoCurve>;
}): void {
  const {
    type,
    entityPairs,
    layerName,
    color,
    classification,
    unitScale,
    fileUnitScale,
    blockLib,
    entityIndexRef,
    pointIdRef,
    lines,
    insertTransform,
    rawGeoCurves,
  } = args;

  const s = unitScale;
  /**
   * MAX_SAGITTA_M is a bound on real-world flattening error, but coordinates here
   * are still in drawing units (`s` is always 1 — see parseLocalDxf), so the bound
   * has to be converted into those units or it means nothing. Comparing 0.005 to a
   * radius in millimetres over-samples ~32x; against kilometres it is a 5 m sagitta
   * and under-samples by the same factor.
   *
   * $INSUNITS is only a hint and geographic files lie about it — that is harmless
   * here, because projectGeoCurves re-tessellates every geographic curve in true
   * metres after detection.
   */
  const sagittaFileUnits = MAX_SAGITTA_M / (fileUnitScale > 0 ? fileUnitScale : 1);
  const tf = (x: number, y: number): Xy => {
    const sx = x * s;
    const sy = y * s;
    if (!insertTransform) return { x: sx, y: sy };
    const t = insertTransform;
    // insert transform is in DXF units; apply scale after transform components
    // already baked in units via dx/dy/scale — re-apply unit scale on dx/dy:
    const ux = sx * t.scaleX;
    const uy = sy * t.scaleY;
    return {
      x: ux * t.cosR - uy * t.sinR + t.dx * s,
      y: ux * t.sinR + uy * t.cosR + t.dy * s,
    };
  };
  const tfPts = (pts: Xy[]) => pts.map((p) => tf(p.x / s, p.y / s)); // pts already scaled? handle carefully below

  // Prefer scaling raw coords once:
  const scalePt = (x: number, y: number) => tf(x, y);

  const isMark = classification === "mark";
  const planLayer = planLayerForClass(classification);
  const labelPrefix = isMark ? "Marking" : "Transit";

  if (type === "INSERT") {
    resolveInsert({
      entityPairs,
      blockLib,
      layerName,
      color,
      classification,
      unitScale,
      fileUnitScale,
      entityIndexRef,
      pointIdRef,
      lines,
      rawGeoCurves,
    });
    return;
  }

  if (type === "LINE") {
    const x1 = getNumber(entityPairs, "10");
    const y1 = getNumber(entityPairs, "20");
    const x2 = getNumber(entityPairs, "11");
    const y2 = getNumber(entityPairs, "21");
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const from = scalePt(x1, y1);
    const to = scalePt(x2, y2);
    const idx = entityIndexRef.value++;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    pushLine(lines, {
      id: `LINE-${idx}`,
      label: `${labelPrefix} Line ${idx + 1}`,
      layer: planLayer,
      from,
      to,
      isMark,
      entityId: `LINE-${idx}`,
      entityType: "LINE",
      layerName,
      color,
      lengthM: len,
      geometry: { start: [from.y, from.x], end: [to.y, to.x] },
      // preview stored pre-axis-swap as CAD x/y → later as north=y east=x
      previewCad: [from, to],
      pointIdRef,
    });
    return;
  }

  if (type === "LWPOLYLINE" || type === "POLYLINE") {
    // LWPOLYLINE: every (10,20) is a path vertex.
    // Classic POLYLINE: entity (10,20,30) is the *base location* (often 0,0,0); path
    // vertices live only on following VERTEX entities when vertices-follow (66=1).
    // Including the base point as a vertex poisons georef detection (mixes Null Island
    // with lat/lon) and places the plan off-map — common for geo-referenced 3D polylines.
    let vertices =
      type === "POLYLINE"
        ? getPolylinePathVertices(entityPairs)
        : getVertexList(entityPairs);
    if (vertices.length < 2) return;
    const flags = getNumber(entityPairs, "70") || 0;
    const closed = (flags & 1) === 1;
    const preview: Xy[] = [];
    const addSeg = (a: Vertex, b: Xy) => {
      if (Math.abs(a.bulge || 0) >= 1e-6) {
        // Sample in raw DXF units then scale each point
        const raw = sampleBulgeSagitta(a, b, a.bulge, sagittaFileUnits);
        for (const rp of raw) {
          const p = scalePt(rp.x, rp.y);
          if (
            preview.length === 0 ||
            Math.hypot(p.x - preview[preview.length - 1].x, p.y - preview[preview.length - 1].y) > 1e-9
          ) {
            preview.push(p);
          }
        }
      } else {
        const p1 = scalePt(a.x, a.y);
        const p2 = scalePt(b.x, b.y);
        if (preview.length === 0) preview.push(p1);
        preview.push(p2);
      }
    };
    for (let i = 0; i < vertices.length - 1; i++) addSeg(vertices[i], vertices[i + 1]);
    if (closed && vertices.length > 2) addSeg(vertices[vertices.length - 1], vertices[0]);
    if (preview.length < 2) return;
    const idx = entityIndexRef.value++;
    const len = polylineLength(preview);
    // Bulge arcs only: a straight polyline projects vertex-for-vertex, so it needs
    // no geographic re-tessellation (see projectGeoCurves).
    const sim = insertSimilarity(insertTransform);
    if (sim && vertices.some((v) => Math.abs(v.bulge || 0) >= 1e-6)) {
      rawGeoCurves.set(`${type}-${idx}`, {
        kind: "bulge",
        closed,
        vertices: vertices.map((v) => {
          const p = scalePt(v.x, v.y);
          return { x: p.x, y: p.y, bulge: v.bulge };
        }),
      });
    }
    pushLine(lines, {
      id: `${type}-${idx}`,
      label: `${labelPrefix} Polyline ${idx + 1}`,
      layer: planLayer,
      from: preview[0],
      to: preview[preview.length - 1],
      isMark,
      entityId: `${type}-${idx}`,
      entityType: type,
      layerName,
      color,
      lengthM: len,
      geometry: { closed, vertexCount: vertices.length },
      previewCad: preview,
      pointIdRef,
    });
    return;
  }

  if (type === "ARC" || type === "CIRCLE") {
    const cx = getNumber(entityPairs, "10");
    const cy = getNumber(entityPairs, "20");
    const radius = getNumber(entityPairs, "40");
    const startAngle = type === "ARC" ? getNumber(entityPairs, "50") : 0;
    const endAngle = type === "ARC" ? getNumber(entityPairs, "51") : 360;
    if (![cx, cy, radius].every(Number.isFinite) || !(radius > 0)) return;
    // Sagitta bound in metres → convert max sagitta to DXF units for sampling
    const rawPts = sampleArcSagitta(cx, cy, radius, startAngle, endAngle, sagittaFileUnits);
    const pts = rawPts.map((p) => scalePt(p.x, p.y));
    if (pts.length < 2) return;
    const idx = entityIndexRef.value++;
    const sweep = (endAngle >= startAngle ? endAngle : endAngle + 360) - startAngle;
    const arcLen = (Math.abs(sweep) / 360) * 2 * Math.PI * radius * s;
    // Keep the circle definition for a possible geographic re-tessellation: the
    // samples above are bounded in FILE units, which is only a metre bound for a
    // metric drawing (see projectGeoCurves).
    const sim = insertSimilarity(insertTransform);
    if (sim) {
      const center = scalePt(cx, cy);
      rawGeoCurves.set(`${type}-${idx}`, {
        kind: "arc",
        cx: center.x,
        cy: center.y,
        radius: radius * s * sim.scale,
        startAngle: startAngle + sim.rotationDeg,
        endAngle: endAngle + sim.rotationDeg,
      });
    }
    pushLine(lines, {
      id: `${type}-${idx}`,
      label: `${labelPrefix} ${type === "CIRCLE" ? "Circle" : "Arc"} ${idx + 1}`,
      layer: planLayer,
      from: pts[0],
      to: pts[pts.length - 1],
      isMark,
      entityId: `${type}-${idx}`,
      entityType: type,
      layerName,
      color,
      lengthM: arcLen,
      geometry: dxfCurveGeometryToNed({
        cx: cx * s,
        cy: cy * s,
        radius: radius * s,
        startAngle,
        endAngle,
      }),
      previewCad: pts,
      pointIdRef,
    });
    return;
  }

  if (type === "SPLINE") {
    const controlXs = getAllNumbers(entityPairs, "10");
    const controlYs = getAllNumbers(entityPairs, "20");
    if (controlXs.length < 2 || controlXs.length !== controlYs.length) return;
    const controlPts = controlXs.map((x, i) => ({ x, y: controlYs[i] ?? 0 }));
    // Dense Catmull-Rom; segment count from chord vs sagitta on avg radius-ish
    const extent = controlExtent(controlPts);
    const nSeg = Math.max(16, Math.ceil(extent / Math.max(sagittaFileUnits, 1e-6)));
    const sampled = sampleSpline(controlPts, Math.min(nSeg, 512));
    const pts = sampled.map((p) => scalePt(p.x, p.y));
    if (pts.length < 2) return;
    const idx = entityIndexRef.value++;
    pushLine(lines, {
      id: `SPLINE-${idx}`,
      label: `${labelPrefix} Spline ${idx + 1}`,
      layer: planLayer,
      from: pts[0],
      to: pts[pts.length - 1],
      isMark,
      entityId: `SPLINE-${idx}`,
      entityType: "SPLINE",
      layerName,
      color,
      lengthM: polylineLength(pts),
      geometry: { num_control_points: controlPts.length },
      previewCad: pts,
      pointIdRef,
    });
    return;
  }

  if (type === "ELLIPSE") {
    const cx = getNumber(entityPairs, "10");
    const cy = getNumber(entityPairs, "20");
    const mx = getNumber(entityPairs, "11");
    const my = getNumber(entityPairs, "21");
    const ratio = getNumber(entityPairs, "40") || 1;
    const startParam = getNumber(entityPairs, "41") || 0;
    const endParam = getNumber(entityPairs, "42") || 2 * Math.PI;
    if (![cx, cy, mx, my].every(Number.isFinite)) return;
    const majorLen = Math.hypot(mx, my);
    const majorAngle = Math.atan2(my, mx);
    const minorLen = majorLen * ratio;
    // Approximate: use major radius for sagitta segment count
    const sweep = endParam - startParam;
    const n = arcSegmentCount(majorLen, sweep, sagittaFileUnits);
    const pts: Xy[] = [];
    const cosA = Math.cos(majorAngle);
    const sinA = Math.sin(majorAngle);
    for (let i = 0; i <= n; i++) {
      const t = startParam + (sweep * i) / n;
      const ex = majorLen * Math.cos(t);
      const ey = minorLen * Math.sin(t);
      pts.push(scalePt(cx + ex * cosA - ey * sinA, cy + ex * sinA + ey * cosA));
    }
    if (pts.length < 2) return;
    const idx = entityIndexRef.value++;
    pushLine(lines, {
      id: `ELLIPSE-${idx}`,
      label: `${labelPrefix} Ellipse ${idx + 1}`,
      layer: planLayer,
      from: pts[0],
      to: pts[pts.length - 1],
      isMark,
      entityId: `ELLIPSE-${idx}`,
      entityType: "ELLIPSE",
      layerName,
      color,
      lengthM: polylineLength(pts),
      geometry: {
        cx: cx * s,
        cy: cy * s,
        majorLen: majorLen * s,
        minorLen: minorLen * s,
        majorAngle,
        startParam,
        endParam,
      },
      previewCad: pts,
      pointIdRef,
    });
    return;
  }

  // Unknown / unsupported entity types silently skipped
  void tfPts;
}

function resolveInsert(args: {
  entityPairs: Pair[];
  blockLib: Map<string, DxfBlock>;
  layerName: string;
  color: number;
  classification: DxfEntityClass;
  unitScale: number;
  fileUnitScale: number;
  entityIndexRef: { value: number };
  pointIdRef: { value: number };
  lines: PlanLine[];
  rawGeoCurves: Map<string, RawGeoCurve>;
}): void {
  const blockName = getSingle(args.entityPairs, "2");
  const block = args.blockLib.get(blockName);
  if (!block) return;
  const insX = getNumber(args.entityPairs, "10");
  const insY = getNumber(args.entityPairs, "20");
  const scaleX = getNumber(args.entityPairs, "41") || 1;
  const scaleY = getNumber(args.entityPairs, "42") || scaleX;
  const rotationDeg = getNumber(args.entityPairs, "50") || 0;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const t: InsertTransform = {
    dx: insX,
    dy: insY,
    scaleX,
    scaleY,
    cosR: Math.cos(rotationRad),
    sinR: Math.sin(rotationRad),
  };
  for (const child of block.entities) {
    const childLayer = getSingle(child.pairs, "8") || args.layerName;
    const childClass = classifyDxfEntity(child.type, childLayer);
    if (childClass === "ignore") continue;
    parseEntity({
      type: child.type,
      entityPairs: child.pairs,
      layerName: childLayer,
      color: args.color,
      classification: childClass,
      unitScale: args.unitScale,
      fileUnitScale: args.fileUnitScale,
      blockLib: args.blockLib,
      entityIndexRef: args.entityIndexRef,
      pointIdRef: args.pointIdRef,
      lines: args.lines,
      insertTransform: t,
      rawGeoCurves: args.rawGeoCurves,
    });
  }
}

/**
 * INSERT transforms under which a circle stays a circle (uniform scale + rotation),
 * so a curve's centre/radius/angles survive as closed-form values. Returns null for
 * a non-uniform scale — that curve is an ellipse and cannot be re-tessellated as an arc.
 * A negative uniform scale is a 180° rotation, not a mirror.
 */
function insertSimilarity(
  t: InsertTransform | null
): { scale: number; rotationDeg: number } | null {
  if (!t) return { scale: 1, rotationDeg: 0 };
  if (t.scaleX !== t.scaleY) return null;
  const rotationDeg = (Math.atan2(t.sinR, t.cosR) * 180) / Math.PI;
  return t.scaleX < 0
    ? { scale: -t.scaleX, rotationDeg: rotationDeg + 180 }
    : { scale: t.scaleX, rotationDeg };
}

function pushLine(
  lines: PlanLine[],
  args: {
    id: string;
    label: string;
    layer: PlanLayer;
    from: Xy;
    to: Xy;
    isMark: boolean;
    entityId: string;
    entityType: string;
    layerName: string;
    color: number;
    lengthM: number;
    geometry: Record<string, unknown>;
    previewCad: Xy[];
    pointIdRef: { value: number };
  }
): void {
  // CAD frame: x=east-ish, y=north-ish. Store preview as north=y, east=x (pre-axis-swap
  // of from/to). Axis swap later swaps from/to PlanPoint coords only.
  const preview_points = args.previewCad.map((p) => ({ north: p.y, east: p.x }));
  lines.push({
    id: args.id,
    label: args.label,
    layer: args.layer,
    from: { id: args.pointIdRef.value++, x: args.from.x, y: args.from.y },
    to: { id: args.pointIdRef.value++, x: args.to.x, y: args.to.y },
    width: 0.1,
    is_mark: args.isMark,
    entity: {
      entity_id: args.entityId,
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

/**
 * CAD → app axes: PlanPoint.x/y swap (x becomes north, y becomes east).
 * preview_points already {north,east} from CAD y,x — leave them.
 */
function applyAxisSwap(lines: PlanLine[]): PlanLine[] {
  return lines.map((line) => {
    let entity = line.entity;
    const entityType = (entity?.entity_type ?? "").trim().toUpperCase();
    if (entity?.geometry && (entityType === "CIRCLE" || entityType === "ARC")) {
      const geom = entity.geometry as {
        cx?: number;
        cy?: number;
        centerNorth?: number;
        radius?: number;
        startAngle?: number;
        endAngle?: number;
      };
      if (geom.cx != null && geom.cy != null && geom.centerNorth == null) {
        entity = {
          ...entity,
          geometry: dxfCurveGeometryToNed({
            cx: geom.cx,
            cy: geom.cy,
            radius: geom.radius ?? 0,
            startAngle: geom.startAngle ?? 0,
            endAngle: geom.endAngle ?? 360,
          }),
        };
      }
    }
    return {
      ...line,
      from: { ...line.from, x: line.from.y, y: line.from.x },
      to: { ...line.to, x: line.to.y, y: line.to.x },
      ...(entity ? { entity } : {}),
    };
  });
}

function collectPreviewPoints(
  lines: PlanLine[]
): Array<{ north: number; east: number }> {
  const pts: Array<{ north: number; east: number }> = [];
  for (const line of lines) {
    const pp = line.entity?.preview_points;
    if (pp && pp.length > 0) {
      for (const p of pp) pts.push({ north: p.north, east: p.east });
    } else {
      pts.push({ north: line.from.x, east: line.from.y });
      pts.push({ north: line.to.x, east: line.to.y });
    }
  }
  return pts;
}

function applyProjectedPoints(
  lines: PlanLine[],
  before: Array<{ north: number; east: number }>,
  after: Array<{ north: number; east: number }>
): PlanLine[] {
  // Map each unique before point to after by index order (stable walk).
  let cursor = 0;
  return lines.map((line) => {
    const pp = line.entity?.preview_points;
    if (pp && pp.length > 0) {
      const newPp = pp.map(() => {
        const p = after[cursor++] ?? { north: 0, east: 0 };
        return { north: p.north, east: p.east };
      });
      const first = newPp[0];
      const last = newPp[newPp.length - 1];
      return {
        ...line,
        from: { ...line.from, x: first.north, y: first.east },
        to: { ...line.to, x: last.north, y: last.east },
        entity: line.entity
          ? {
              ...line.entity,
              preview_points: newPp,
              length_m: polylineLength(
                newPp.map((p) => ({ x: p.east, y: p.north }))
              ),
            }
          : undefined,
      };
    }
    const a = after[cursor++] ?? { north: 0, east: 0 };
    const b = after[cursor++] ?? a;
    return {
      ...line,
      from: { ...line.from, x: a.north, y: a.east },
      to: { ...line.to, x: b.north, y: b.east },
    };
  });
}

/**
 * Re-derive geographic ARC/CIRCLE/bulge geometry in the projected metre frame.
 *
 * A DXF is only known to be geographic once every coordinate has been read, so the
 * parse pass has already flattened curves in FILE units — degrees here. Two defects
 * follow, both fixed by this pass:
 *  - the MAX_SAGITTA_M bound is compared against a radius in degrees (~1e-5), so
 *    arcSegmentCount clamps and returns its 4-segment floor: a quarter arc becomes
 *    4 chords instead of a smooth curve;
 *  - an isotropic circle flattened in degree space and then projected is squashed
 *    by cos(lat) E-W, which opens ~3 cm gaps against LINEs authored tangent to it.
 *
 * Mirrors path_engine/parsers/georef.py detect_and_project: the CENTRE projects
 * per-axis about the origin (lat→north, lon→east), the RADIUS scales by the NORTH
 * rate — the axis cos(lat) does not distort. Bulge is scale-invariant, so a bulge
 * segment is re-derived from its projected endpoints.
 *
 * entity.geometry lands in the same metre frame as preview_points (G2) — leaving it
 * in degrees makes getCurveGeometry (curveGeometry.ts) draw the curve at Null Island.
 */
function projectGeoCurves(
  lines: PlanLine[],
  rawCurves: Map<string, RawGeoCurve>,
  origin: { lat: number; lon: number }
): PlanLine[] {
  if (lines.length === 0) return lines;
  const { mPerDegNorth, mPerDegEast } = metresPerDegreePx4(origin.lat);
  const toNorth = (lat: number) => (lat - origin.lat) * mPerDegNorth;
  const toEast = (lon: number) => (lon - origin.lon) * mPerDegEast;

  return lines.map((line) => {
    const entity = line.entity;
    if (!entity) return line;
    const raw = rawCurves.get(entity.entity_id);

    if (raw?.kind === "arc") {
      const centerEast = toEast(raw.cx);
      const centerNorth = toNorth(raw.cy);
      const radiusM = raw.radius * mPerDegNorth;
      const pts = sampleArcSagitta(
        centerEast,
        centerNorth,
        radiusM,
        raw.startAngle,
        raw.endAngle,
        MAX_SAGITTA_M
      );
      if (pts.length < 2) return line;
      const sweep =
        (raw.endAngle >= raw.startAngle ? raw.endAngle : raw.endAngle + 360) -
        raw.startAngle;
      return replaceCurveSamples(line, pts, {
        lengthM: (Math.abs(sweep) / 360) * 2 * Math.PI * radiusM,
        geometry: dxfCurveGeometryToNed({
          cx: centerEast,
          cy: centerNorth,
          radius: radiusM,
          startAngle: raw.startAngle,
          endAngle: raw.endAngle,
        }),
      });
    }

    if (raw?.kind === "bulge") {
      const vertices = raw.vertices.map((v) => ({
        x: toEast(v.x),
        y: toNorth(v.y),
        bulge: v.bulge,
      }));
      const pts = tessellateBulgePath(vertices, raw.closed, MAX_SAGITTA_M);
      if (pts.length < 2) return line;
      return replaceCurveSamples(line, pts, { lengthM: polylineLength(pts) });
    }

    // Non-uniform INSERT curves keep their degree-space samples (they are ellipses,
    // not arcs), but geometry must still leave this function in metres.
    const entityType = (entity.entity_type ?? "").trim().toUpperCase();
    if (entityType !== "ARC" && entityType !== "CIRCLE") return line;
    const geom = entity.geometry as
      | { centerNorth?: number; centerEast?: number; radius?: number }
      | undefined;
    if (
      typeof geom?.centerNorth !== "number" ||
      typeof geom?.centerEast !== "number" ||
      typeof geom?.radius !== "number"
    ) {
      return line;
    }
    return {
      ...line,
      entity: {
        ...entity,
        geometry: {
          ...geom,
          centerNorth: toNorth(geom.centerNorth),
          centerEast: toEast(geom.centerEast),
          radius: geom.radius * mPerDegNorth,
        },
      },
    };
  });
}

/** Swap a line's tessellation for `ptsCad` (CAD x=east, y=north), keeping ids/labels. */
function replaceCurveSamples(
  line: PlanLine,
  ptsCad: Xy[],
  next: { lengthM: number; geometry?: Record<string, unknown> }
): PlanLine {
  const preview_points = ptsCad.map((p) => ({ north: p.y, east: p.x }));
  const first = preview_points[0];
  const last = preview_points[preview_points.length - 1];
  return {
    ...line,
    from: { ...line.from, x: first.north, y: first.east },
    to: { ...line.to, x: last.north, y: last.east },
    entity: line.entity
      ? {
          ...line.entity,
          preview_points,
          length_m: next.lengthM,
          ...(next.geometry ? { geometry: next.geometry } : {}),
        }
      : undefined,
  };
}

/**
 * Flatten a bulge polyline entirely within one frame.
 *
 * Kept separate from the LWPOLYLINE parse branch on purpose: that branch samples in
 * file units and transforms each sample, which is what projectGeoCurves exists to
 * undo. Folding the two together would put the degree-space bound back on this path.
 */
function tessellateBulgePath(
  vertices: Vertex[],
  closed: boolean,
  maxSagitta: number
): Xy[] {
  const out: Xy[] = [];
  const push = (p: Xy) => {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-9) out.push(p);
  };
  const addSeg = (a: Vertex, b: Xy) => {
    if (Math.abs(a.bulge || 0) >= 1e-6) {
      for (const p of sampleBulgeSagitta(a, b, a.bulge, maxSagitta)) push(p);
    } else {
      push({ x: a.x, y: a.y });
      push({ x: b.x, y: b.y });
    }
  };
  for (let i = 0; i < vertices.length - 1; i++) addSeg(vertices[i], vertices[i + 1]);
  if (closed && vertices.length > 2) addSeg(vertices[vertices.length - 1], vertices[0]);
  return out;
}

// ── DXF pair helpers ────────────────────────────────────────────────────────

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

function collectEntityGroups(sectionPairs: Pair[]): { type: string; pairs: Pair[] }[] {
  const groups: { type: string; pairs: Pair[] }[] = [];
  let i = 0;
  while (i < sectionPairs.length) {
    const p = sectionPairs[i];
    if (p.code === "0") {
      const type = p.value;
      i++;
      const groupPairs: Pair[] = [];
      while (i < sectionPairs.length && sectionPairs[i].code !== "0") {
        groupPairs.push(sectionPairs[i]);
        i++;
      }
      if (type === "POLYLINE") {
        while (i < sectionPairs.length && sectionPairs[i].value !== "SEQEND") {
          if (sectionPairs[i].code === "0" && sectionPairs[i].value === "VERTEX") {
            i++;
            while (i < sectionPairs.length && sectionPairs[i].code !== "0") {
              groupPairs.push(sectionPairs[i]);
              i++;
            }
          } else {
            i++;
          }
        }
        if (i < sectionPairs.length && sectionPairs[i].code === "0" && sectionPairs[i].value === "SEQEND") {
          i++;
          while (i < sectionPairs.length && sectionPairs[i].code !== "0") i++;
        }
      }
      groups.push({ type, pairs: groupPairs });
    } else {
      i++;
    }
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
      const blockName = getSingle(blockPairs, "2");
      if (blockName && !blockName.startsWith("*")) {
        blocks.set(blockName, {
          name: blockName,
          entities: collectEntityGroups(blockPairs),
        });
      }
    } else {
      i++;
    }
  }
  return blocks;
}

function getSingle(pairs: Pair[], code: string) {
  return pairs.find((p) => p.code === code)?.value ?? "";
}

function getNumber(pairs: Pair[], code: string) {
  return Number(getSingle(pairs, code));
}

function getAllNumbers(pairs: Pair[], code: string): number[] {
  return pairs
    .filter((p) => p.code === code)
    .map((p) => Number(p.value))
    .filter((v) => Number.isFinite(v));
}

function getVertexList(pairs: Pair[]): Vertex[] {
  const vertices: Vertex[] = [];
  let current: Vertex | null = null;
  for (const pair of pairs) {
    if (pair.code === "10") {
      if (current) vertices.push(current);
      current = { x: Number(pair.value), y: 0, bulge: 0 };
    } else if (pair.code === "20" && current) {
      current.y = Number(pair.value);
    } else if (pair.code === "42" && current) {
      current.bulge = Number(pair.value);
    }
  }
  if (current) vertices.push(current);
  return vertices.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
}

/**
 * Path vertices for classic POLYLINE (AcDb3dPolyline / AcDb2dPolyline).
 *
 * When group 66 = 1 (vertices follow), VERTEX entities carry the path and the
 * POLYLINE entity's own (10,20) is only a base/location — never a path corner.
 * Dropping that base point is required for georeferenced polylines whose vertices
 * are lat/lon while the base sits at (0,0).
 *
 * When 66 is absent/0, fall back to every (10,20) in the group (legacy layout).
 */
function getPolylinePathVertices(pairs: Pair[]): Vertex[] {
  const all = getVertexList(pairs);
  if (all.length === 0) return all;
  const verticesFollow = getNumber(pairs, "66");
  // DXF: 66 present and non-zero ⇒ vertices follow as VERTEX entities.
  if (Number.isFinite(verticesFollow) && verticesFollow !== 0) {
    // First (10,20) is the POLYLINE entity location; remaining are VERTEX coords
    // flattened into the same pair list by collectEntityGroups.
    return all.length >= 2 ? all.slice(1) : [];
  }
  return all;
}

function polylineLength(pts: Xy[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

function controlExtent(pts: Xy[]): number {
  if (pts.length === 0) return 0;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function sampleSpline(controlPts: Xy[], numSegments: number): Xy[] {
  const n = controlPts.length;
  if (n <= 2) return controlPts.slice();
  const result: Xy[] = [controlPts[0]];
  for (let i = 0; i < n - 1; i++) {
    const p0 = controlPts[Math.max(0, i - 1)];
    const p1 = controlPts[i];
    const p2 = controlPts[Math.min(n - 1, i + 1)];
    const p3 = controlPts[Math.min(n - 1, i + 2)];
    const steps = i < n - 2 ? Math.max(1, Math.ceil(numSegments / (n - 1))) : 1;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return result;
}
