import type { DxfEntity, DxfPoint, PlanLine } from "../types/plan";

export const MAP_CIRCLE_STEPS = 128;
export const MAP_ARC_STEPS = 192;
export const SVG_CIRCLE_STEPS = 256;

export type PlanBoundingBox = {
  minNorth: number;
  minEast: number;
  maxNorth: number;
  maxEast: number;
};

export type CurveGeometry = {
  centerNorth: number;
  centerEast: number;
  radius: number;
  startAngle: number;
  endAngle: number;
};

const FULL_CIRCLE_SWEEP = 360;
const CURVE_SAMPLE_STEPS = 72;

function coerceFinite(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

export function normalizeCurveEntityType(entityType: string | undefined): string {
  return (entityType ?? "").trim().toLowerCase();
}

export function isCircleEntity(line: PlanLine): boolean {
  return normalizeCurveEntityType(line.entity?.entity_type) === "circle";
}

export function isArcEntity(line: PlanLine): boolean {
  return normalizeCurveEntityType(line.entity?.entity_type) === "arc";
}

export function isCurveEntity(line: PlanLine): boolean {
  const type = normalizeCurveEntityType(line.entity?.entity_type);
  return type === "circle" || type === "arc";
}

/** True when the line should render as a smooth closed circle (entity tag or fitted preview). */
export function isCircleLikeLine(line: PlanLine): boolean {
  if (isCircleEntity(line)) return true;
  const points = line.entity?.preview_points ?? [];
  if (points.length < 8) return false;
  return inferCurveGeometryFromPreviewPoints(points, "circle") != null;
}

function readGeometryFields(geom: Record<string, unknown>) {
  const centerNorth = coerceFinite(
    geom.centerNorth ?? geom.center_north ?? geom.cy ?? geom.north ?? geom.y
  );
  const centerEast = coerceFinite(
    geom.centerEast ?? geom.center_east ?? geom.cx ?? geom.east ?? geom.x
  );
  const radius = coerceFinite(geom.radius ?? geom.r);
  const startAngle = coerceFinite(geom.startAngle ?? geom.start_angle) ?? 0;
  const endAngle = coerceFinite(geom.endAngle ?? geom.end_angle);
  return { centerNorth, centerEast, radius, startAngle, endAngle };
}

function isClosedPointRing(points: DxfPoint[], radius: number): boolean {
  if (points.length < 6) return false;
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(first.north - last.north, first.east - last.east);
  return gap <= Math.max(radius * 0.2, 0.05);
}

function fitCircleFromPoints(points: DxfPoint[]): CurveGeometry | null {
  if (points.length < 6) return null;

  let centerNorth = 0;
  let centerEast = 0;
  for (const pt of points) {
    centerNorth += pt.north;
    centerEast += pt.east;
  }
  centerNorth /= points.length;
  centerEast /= points.length;

  const radii = points.map((pt) => Math.hypot(pt.north - centerNorth, pt.east - centerEast));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (!Number.isFinite(radius) || radius <= 0) return null;

  const variance =
    radii.reduce((sum, value) => sum + (value - radius) ** 2, 0) / radii.length;
  const coefficientOfVariation = Math.sqrt(variance) / radius;
  if (coefficientOfVariation > 0.15) return null;

  return { centerNorth, centerEast, radius, startAngle: 0, endAngle: FULL_CIRCLE_SWEEP };
}

/** Infer a circle/arc from tessellated preview_points (common in API entities). */
export function inferCurveGeometryFromPreviewPoints(
  points: DxfPoint[],
  entityType: string
): CurveGeometry | null {
  const fitted = fitCircleFromPoints(points);
  if (!fitted) return null;

  const normalizedType = normalizeCurveEntityType(entityType);
  if (
    normalizedType === "circle" ||
    isClosedPointRing(points, fitted.radius) ||
    points.length >= 8
  ) {
    return fitted;
  }

  if (normalizedType === "arc" && points.length >= 2) {
    const start = points[0];
    const end = points[points.length - 1];
    const startAngle =
      (Math.atan2(start.north - fitted.centerNorth, start.east - fitted.centerEast) * 180) / Math.PI;
    const endAngle =
      (Math.atan2(end.north - fitted.centerNorth, end.east - fitted.centerEast) * 180) / Math.PI;
    const sweep = normalizedArcSweep(startAngle, endAngle);
    if (sweep < FULL_CIRCLE_SWEEP - 10) {
      return {
        centerNorth: fitted.centerNorth,
        centerEast: fitted.centerEast,
        radius: fitted.radius,
        startAngle,
        endAngle,
      };
    }
    return fitted;
  }

  return null;
}

function geometryFromEntityFields(entity: DxfEntity): CurveGeometry | null {
  const entityType = normalizeCurveEntityType(entity.entity_type);
  const geom = entity.geometry;
  if (!geom || typeof geom !== "object") return null;

  const parsed = readGeometryFields(geom as Record<string, unknown>);
  if (
    parsed.centerNorth == null ||
    parsed.centerEast == null ||
    parsed.radius == null ||
    parsed.radius <= 0
  ) {
    return null;
  }

  return {
    centerNorth: parsed.centerNorth,
    centerEast: parsed.centerEast,
    radius: parsed.radius,
    startAngle: parsed.startAngle,
    endAngle:
      entityType === "circle"
        ? parsed.startAngle + FULL_CIRCLE_SWEEP
        : (parsed.endAngle ?? FULL_CIRCLE_SWEEP),
  };
}

/** Normalize backend/API entity geometry into NED curve fields. */
export function normalizeDxfEntityGeometry(entity: DxfEntity): DxfEntity {
  const existing = geometryFromEntityFields(entity);
  if (existing) {
    return { ...entity, geometry: existing };
  }

  const inferred = inferCurveGeometryFromPreviewPoints(
    entity.preview_points ?? [],
    entity.entity_type
  );
  if (!inferred) return entity;

  return {
    ...entity,
    geometry: inferred,
  };
}

export function normalizePlanLineEntity(line: PlanLine): PlanLine {
  if (!line.entity) return line;
  const entity = normalizeDxfEntityGeometry(line.entity);
  if (entity === line.entity) return line;
  return { ...line, entity };
}

export function normalizePlanLinesForCurves(lines: PlanLine[]): PlanLine[] {
  return lines.map(normalizePlanLineEntity);
}

/** Read curve geometry stored in NED: centerNorth/centerEast or legacy cx/cy after axis fix. */
export function getCurveGeometry(line: PlanLine): CurveGeometry | null {
  const normalized = line.entity ? normalizeDxfEntityGeometry(line.entity) : null;
  const geom = normalized?.geometry ?? line.entity?.geometry;
  if (!geom || typeof geom !== "object") {
    const inferred = inferCurveGeometryFromPreviewPoints(
      line.entity?.preview_points ?? [],
      line.entity?.entity_type ?? ""
    );
    return inferred;
  }

  const parsed = readGeometryFields(geom as Record<string, unknown>);
  const centerNorth = parsed.centerNorth;
  const centerEast = parsed.centerEast;
  const radius = parsed.radius;
  if (centerNorth == null || centerEast == null || radius == null || radius <= 0) {
    return inferCurveGeometryFromPreviewPoints(
      line.entity?.preview_points ?? [],
      line.entity?.entity_type ?? ""
    );
  }

  const entityType = normalizeCurveEntityType(line.entity?.entity_type);
  const startAngle = parsed.startAngle;
  const endAngle =
    entityType === "circle"
      ? startAngle + FULL_CIRCLE_SWEEP
      : (parsed.endAngle ?? FULL_CIRCLE_SWEEP);

  return { centerNorth, centerEast, radius, startAngle, endAngle };
}

/** Convert raw DXF circle/arc geometry (X=east, Y=north) to NED storage. */
export function dxfCurveGeometryToNed(geometry: {
  cx: number;
  cy: number;
  radius: number;
  startAngle?: number;
  endAngle?: number;
}) {
  return {
    centerNorth: geometry.cy,
    centerEast: geometry.cx,
    radius: geometry.radius,
    startAngle: geometry.startAngle ?? 0,
    endAngle: geometry.endAngle ?? FULL_CIRCLE_SWEEP,
  };
}

function includePoint(
  bounds: PlanBoundingBox,
  north: number,
  east: number
): PlanBoundingBox {
  return {
    minNorth: Math.min(bounds.minNorth, north),
    minEast: Math.min(bounds.minEast, east),
    maxNorth: Math.max(bounds.maxNorth, north),
    maxEast: Math.max(bounds.maxEast, east),
  };
}

function emptyBounds(): PlanBoundingBox {
  return {
    minNorth: Number.POSITIVE_INFINITY,
    minEast: Number.POSITIVE_INFINITY,
    maxNorth: Number.NEGATIVE_INFINITY,
    maxEast: Number.NEGATIVE_INFINITY,
  };
}

function isValidBounds(bounds: PlanBoundingBox): boolean {
  return (
    Number.isFinite(bounds.minNorth) &&
    Number.isFinite(bounds.minEast) &&
    Number.isFinite(bounds.maxNorth) &&
    Number.isFinite(bounds.maxEast)
  );
}

function expandBoundsWithCurve(bounds: PlanBoundingBox, curve: CurveGeometry): PlanBoundingBox {
  let next = bounds;
  next = includePoint(next, curve.centerNorth - curve.radius, curve.centerEast);
  next = includePoint(next, curve.centerNorth + curve.radius, curve.centerEast);
  next = includePoint(next, curve.centerNorth, curve.centerEast - curve.radius);
  next = includePoint(next, curve.centerNorth, curve.centerEast + curve.radius);
  return next;
}

/** True extents using preview_points, curve geometry, and from/to endpoints. */
export function computePlanBoundingBox(lines: PlanLine[]): PlanBoundingBox {
  let bounds = emptyBounds();

  for (const line of lines) {
    const curve = getCurveGeometry(line);
    if (curve) {
      bounds = expandBoundsWithCurve(bounds, curve);
    }

    const preview = line.entity?.preview_points;
    if (preview && preview.length > 0) {
      for (const pt of preview) {
        if (Number.isFinite(pt.north) && Number.isFinite(pt.east)) {
          bounds = includePoint(bounds, pt.north, pt.east);
        }
      }
    }

    if (line.from && Number.isFinite(line.from.x) && Number.isFinite(line.from.y)) {
      bounds = includePoint(bounds, line.from.x, line.from.y);
    }
    if (line.to && Number.isFinite(line.to.x) && Number.isFinite(line.to.y)) {
      bounds = includePoint(bounds, line.to.x, line.to.y);
    }
  }

  if (!isValidBounds(bounds)) {
    return { minNorth: 0, minEast: 0, maxNorth: 0, maxEast: 0 };
  }

  return bounds;
}

/** Legacy {minX,maxX,minY,maxY} where x=north, y=east. */
export function computePlanBoundingBoxLegacy(lines: PlanLine[]) {
  const box = computePlanBoundingBox(lines);
  return {
    minX: box.minNorth,
    minY: box.minEast,
    maxX: box.maxNorth,
    maxY: box.maxEast,
  };
}

function normalizedArcSweep(startAngle: number, endAngle: number): number {
  const end = endAngle >= startAngle ? endAngle : endAngle + FULL_CIRCLE_SWEEP;
  return end - startAngle;
}

function curvePointAtAngle(curve: CurveGeometry, angleDeg: number): DxfPoint {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    north: curve.centerNorth + curve.radius * Math.sin(radians),
    east: curve.centerEast + curve.radius * Math.cos(radians),
  };
}

function isFullCircleCurve(line: PlanLine, curve: CurveGeometry): boolean {
  if (isCircleEntity(line)) return true;
  return normalizedArcSweep(curve.startAngle, curve.endAngle) >= FULL_CIRCLE_SWEEP - 1e-3;
}

/** Parametric NED samples along a CIRCLE/ARC entity. */
export function sampleCurveEntityPoints(
  line: PlanLine,
  steps = CURVE_SAMPLE_STEPS,
  mapMode = false
): DxfPoint[] {
  const curve = getCurveGeometry(line);
  if (!curve) return [];

  const sweep = normalizedArcSweep(curve.startAngle, curve.endAngle);
  const circleSteps = mapMode ? MAP_CIRCLE_STEPS : steps;
  const arcSteps = mapMode ? MAP_ARC_STEPS : steps;
  const count = isFullCircleCurve(line, curve)
    ? Math.max(circleSteps, 32)
    : Math.max(8, Math.ceil((sweep / FULL_CIRCLE_SWEEP) * arcSteps));
  const points: DxfPoint[] = [];

  for (let i = 0; i <= count; i++) {
    const angle = curve.startAngle + (sweep * i) / count;
    points.push(curvePointAtAngle(curve, angle));
  }

  return points;
}

/** Points used for map/GPS projection — native curve samples when available. */
export function getPlanLineRenderPoints(line: PlanLine, mapMode = false): DxfPoint[] {
  if (isCurveEntity(line) || isCircleLikeLine(line)) {
    const sampled = sampleCurveEntityPoints(line, CURVE_SAMPLE_STEPS, mapMode);
    if (sampled.length >= 2) return sampled;
  }

  const preview = line.entity?.preview_points;
  if (preview && preview.length >= 2) {
    return preview;
  }

  if (
    line.from &&
    line.to &&
    Number.isFinite(line.from.x) &&
    Number.isFinite(line.from.y) &&
    Number.isFinite(line.to.x) &&
    Number.isFinite(line.to.y)
  ) {
    return [
      { north: line.from.x, east: line.from.y },
      { north: line.to.x, east: line.to.y },
    ];
  }

  return [];
}

export function getPreviewCircleElements(
  lines: PlanLine[]
): Array<{ line: PlanLine; centerNorth: number; centerEast: number; radius: number }> {
  const circles: Array<{ line: PlanLine; centerNorth: number; centerEast: number; radius: number }> = [];
  for (const line of lines) {
    if (!isCircleLikeLine(line)) continue;
    const curve = getCurveGeometry(line);
    if (!curve) continue;
    circles.push({
      line,
      centerNorth: curve.centerNorth,
      centerEast: curve.centerEast,
      radius: curve.radius,
    });
  }
  return circles;
}

function buildSvgArcPath(curve: CurveGeometry): string {
  const sweep = normalizedArcSweep(curve.startAngle, curve.endAngle);
  const start = curvePointAtAngle(curve, curve.startAngle);
  const end = curvePointAtAngle(curve, curve.startAngle + sweep);
  const r = curve.radius;

  if (sweep >= FULL_CIRCLE_SWEEP - 1e-6) {
    const mid = curvePointAtAngle(curve, curve.startAngle + sweep / 2);
    return (
      `M${start.east} ${start.north}` +
      `A${r} ${r} 0 1 1 ${mid.east} ${mid.north}` +
      `A${r} ${r} 0 1 1 ${start.east} ${start.north}`
    );
  }

  const largeArc = sweep > 180 ? 1 : 0;
  return `M${start.east} ${start.north}A${r} ${r} 0 ${largeArc} 1 ${end.east} ${end.north}`;
}

/** SVG path d attribute for one plan line (native arcs for CIRCLE/ARC). */
export function buildPlanLineSvgPath(line: PlanLine): string {
  if (!line.from || !line.to) return "";

  const curve = getCurveGeometry(line);
  if (curve && (isCurveEntity(line) || isCircleLikeLine(line))) {
    return buildSvgArcPath(curve);
  }

  const preview = line.entity?.preview_points;
  if (preview && preview.length > 1) {
    let path = `M${preview[0].east} ${preview[0].north}`;
    for (let i = 1; i < preview.length; i++) {
      path += `L${preview[i].east} ${preview[i].north}`;
    }
    return path;
  }

  return `M${line.from.y} ${line.from.x}L${line.to.y} ${line.to.x}`;
}

/** Selection anchors for curves — avoid showing every tessellation vertex. */
export function getCurveSelectionAnchors(line: PlanLine): DxfPoint[] {
  const curve = getCurveGeometry(line);
  if (!curve) return [];

  if (isCircleEntity(line) || isCircleLikeLine(line)) {
    return [{ north: curve.centerNorth, east: curve.centerEast }];
  }

  const start = curvePointAtAngle(curve, curve.startAngle);
  const end = curvePointAtAngle(curve, curve.startAngle + normalizedArcSweep(curve.startAngle, curve.endAngle));
  return [start, end];
}