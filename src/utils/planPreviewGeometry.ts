import type { PlanLine } from "../types/plan";
import {
  buildPlanLineSvgPath,
  computePlanBoundingBoxLegacy,
  isCircleLikeLine,
  isCurveEntity,
} from "./curveGeometry";

export const MAX_PREVIEW_CORNERS = 450;
export const PATH_SEGMENT_CHUNK_SIZE = 650;
export const PREVIEW_ARROWHEAD_LENGTH_PX = 14;
export const PREVIEW_ARROWHEAD_HALF_WIDTH_PX = 5;
export const PREVIEW_RENDERED_LAYERS = [
  "virtual_boundary",
  "boundary",
  "center",
  "transit",
  "extension",
  "marking_true",
  "marking_false",
] as const;

export type PreviewRenderedLayer = (typeof PREVIEW_RENDERED_LAYERS)[number];

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isRenderableLine(line: PlanLine | null | undefined): line is PlanLine {
  return Boolean(
    line &&
      line.from &&
      line.to &&
      isFiniteNumber(line.from.x) &&
      isFiniteNumber(line.from.y) &&
      isFiniteNumber(line.to.x) &&
      isFiniteNumber(line.to.y)
  );
}

export function buildSvgPathChunks(lines: PlanLine[]) {
  const chunks: string[] = [];
  let current = "";
  let count = 0;

  for (const line of lines) {
    if (!isRenderableLine(line)) continue;
    if (isCircleLikeLine(line)) continue;

    const segment = buildPlanLineSvgPath(line);
    if (!segment) continue;
    current += segment;

    count += 1;

    if (count >= PATH_SEGMENT_CHUNK_SIZE) {
      chunks.push(current);
      current = "";
      count = 0;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function buildSvgPathForLine(line: PlanLine) {
  return buildSvgPathChunks([line]).join(" ");
}

export function getLineAnchorPoint(line: PlanLine) {
  const pts = line.entity?.preview_points;
  if (pts && pts.length > 0) {
    const midIndex = Math.floor(pts.length / 2);
    const mid = pts[midIndex];
    if (mid && isFiniteNumber(mid.north) && isFiniteNumber(mid.east)) {
      return { x: mid.north, y: mid.east };
    }
    const sum = pts.reduce(
      (acc, pt) => {
        acc.north += Number(pt.north) || 0;
        acc.east += Number(pt.east) || 0;
        return acc;
      },
      { north: 0, east: 0 }
    );
    return {
      x: sum.north / pts.length,
      y: sum.east / pts.length,
    };
  }

  return {
    x: (line.from.x + line.to.x) / 2,
    y: (line.from.y + line.to.y) / 2,
  };
}

export type PreviewViewport = {
  panX: number;
  panY: number;
  zoom: number;
};

export type LocalPoint = { x: number; y: number };

export function touchDistance(t1: { locationX: number; locationY: number }, t2: { locationX: number; locationY: number }) {
  const dx = t1.locationX - t2.locationX;
  const dy = t1.locationY - t2.locationY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function touchAngle(t1: { locationX: number; locationY: number }, t2: { locationX: number; locationY: number }) {
  const dx = t1.locationX - t2.locationX;
  const dy = t1.locationY - t2.locationY;
  return Math.atan2(dy, dx);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDegrees(value: number) {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

export function shortestAngleDelta(fromDeg: number, toDeg: number) {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

export function computePlanBounds(lines: PlanLine[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const line of lines) {
    minX = Math.min(minX, line.from.x, line.to.x);
    minY = Math.min(minY, line.from.y, line.to.y);
    maxX = Math.max(maxX, line.from.x, line.to.x);
    maxY = Math.max(maxY, line.from.y, line.to.y);
  }

  return { minX, minY, maxX, maxY };
}

export function computeAutoFitViewport(
  lines: PlanLine[],
  width: number,
  height: number,
  roverPoint?: { north: number; east: number } | null,
  extraPoints?: { north: number; east: number }[] | null
): PreviewViewport {
  if (lines.length === 0 && !extraPoints?.length) {
    return { panX: width / 2, panY: height / 2, zoom: 1 };
  }
  if (width <= 0 || height <= 0) {
    return { panX: width / 2, panY: height / 2, zoom: 1 };
  }

  // Swap X/Y in bounds: World X is North (Up), World Y is East (Right)
  // minX/maxX will now track the Easting (World Y)
  // minY/maxY will now track the Northing (World X)
  let minE = Number.POSITIVE_INFINITY;
  let maxE = Number.NEGATIVE_INFINITY;
  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;

  if (lines.length > 0) {
    const bounds = computePlanBoundingBoxLegacy(lines);
    minN = bounds.minX;
    maxN = bounds.maxX;
    minE = bounds.minY;
    maxE = bounds.maxY;
  }

  if (roverPoint) {
    minN = Math.min(minN, roverPoint.north);
    maxN = Math.max(maxN, roverPoint.north);
    minE = Math.min(minE, roverPoint.east);
    maxE = Math.max(maxE, roverPoint.east);
  }

  // Include selected alignment ref points (tapped or CSV-imported) — they may sit outside
  // the plan's own line bounds and must never end up framed off-screen.
  if (extraPoints?.length) {
    for (const p of extraPoints) {
      minN = Math.min(minN, p.north);
      maxN = Math.max(maxN, p.north);
      minE = Math.min(minE, p.east);
      maxE = Math.max(maxE, p.east);
    }
  }

  const bboxW = maxE - minE; // Width on screen is Easting span
  const bboxH = maxN - minN; // Height on screen is Northing span

  if (bboxW <= 0.0001 && bboxH <= 0.0001) {
    return {
      panX: width / 2 - minE,
      panY: height / 2 + minN,
      zoom: 1,
    };
  }

  const paddingFactor = 0.70;
  const scaleX = bboxW > 0 ? (width * paddingFactor) / bboxW : 1;
  const scaleY = bboxH > 0 ? (height * paddingFactor) / bboxH : 1;
  const zoom = clamp(Math.min(scaleX, scaleY), 0.08, 800);
  const centerE = (minE + maxE) / 2;
  const centerN = (minN + maxN) / 2;

  return {
    panX: width / 2 - centerE * zoom,
    panY: height / 2 + centerN * zoom,
    zoom,
  };
}

export function toScreenPoint(point: { x: number; y: number }, viewport: PreviewViewport): LocalPoint {
  // point.x = North, point.y = East
  // Screen X = East * zoom + panX
  // Screen Y = -North * zoom + panY
  return {
    x: point.y * viewport.zoom + viewport.panX,
    y: -point.x * viewport.zoom + viewport.panY,
  };
}

export function rotatePoint(px: number, py: number, cx: number, cy: number, angleDegrees: number): LocalPoint {
  const radians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = px - cx;
  const dy = py - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

export function buildPreviewArrowheadPoints(from: LocalPoint, to: LocalPoint): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  if (length < 8) return null;

  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  const tipX = midX + ux * PREVIEW_ARROWHEAD_LENGTH_PX * 0.45;
  const tipY = midY + uy * PREVIEW_ARROWHEAD_LENGTH_PX * 0.45;
  const baseX = midX - ux * PREVIEW_ARROWHEAD_LENGTH_PX * 0.55;
  const baseY = midY - uy * PREVIEW_ARROWHEAD_LENGTH_PX * 0.55;
  const base1X = baseX + px * PREVIEW_ARROWHEAD_HALF_WIDTH_PX;
  const base1Y = baseY + py * PREVIEW_ARROWHEAD_HALF_WIDTH_PX;
  const base2X = baseX - px * PREVIEW_ARROWHEAD_HALF_WIDTH_PX;
  const base2Y = baseY - py * PREVIEW_ARROWHEAD_HALF_WIDTH_PX;

  return `${tipX},${tipY} ${base1X},${base1Y} ${base2X},${base2Y}`;
}

export function mapPreviewPointToScreen(
  point: { x: number; y: number },
  viewport: PreviewViewport,
  rotation: number,
  layoutSize: { width: number; height: number }
) {
  const screenPoint = toScreenPoint(point, viewport);

  if (rotation === 0 || layoutSize.width <= 0 || layoutSize.height <= 0) {
    return screenPoint;
  }

  return rotatePoint(
    screenPoint.x,
    screenPoint.y,
    layoutSize.width / 2,
    layoutSize.height / 2,
    rotation
  );
}

export function getPreviewArrowSegment(
  line: PlanLine,
  viewport: PreviewViewport,
  rotation: number,
  layoutSize: { width: number; height: number }
) {
  const previewPoints = line.entity?.preview_points;

  if (previewPoints && previewPoints.length > 1) {
    const segments = previewPoints.slice(0, -1).map((point, index) => ({
      from: { x: point.north, y: point.east },
      to: { x: previewPoints[index + 1].north, y: previewPoints[index + 1].east },
    }));
    const middle = Math.floor(segments.length / 2);
    const ordered = [
      ...segments.slice(middle),
      ...segments.slice(0, middle).reverse(),
    ];

    for (const segment of ordered) {
      const from = mapPreviewPointToScreen(segment.from, viewport, rotation, layoutSize);
      const to = mapPreviewPointToScreen(segment.to, viewport, rotation, layoutSize);
      if (Math.hypot(to.x - from.x, to.y - from.y) >= 8) {
        return { from, to };
      }
    }

    return null;
  }

  return {
    from: mapPreviewPointToScreen(line.from, viewport, rotation, layoutSize),
    to: mapPreviewPointToScreen(line.to, viewport, rotation, layoutSize),
  };
}

export function getPreviewRenderedLayer(line: PlanLine): PreviewRenderedLayer | null {
  if (line.layer === "boundary" || line.layer === "center" || line.layer === "transit" || line.layer === "extension") {
    return line.layer;
  }

  if (line.layer === "marking") {
    return line.entity?.is_mark === false ? "marking_false" : "marking_true";
  }

  return null;
}

export function distancePointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  const sx = x1 + t * dx;
  const sy = y1 + t * dy;
  return Math.hypot(px - sx, py - sy);
}

export function pickNearestLineId(
  lines: PlanLine[],
  viewport: PreviewViewport,
  tap: LocalPoint,
  radiusPx: number,
  rotation: number = 0,
  layoutSize: { width: number; height: number } = { width: 0, height: 0 }
) {
  let nearestId: string | null = null;
  let nearestDistance = radiusPx;

  const cx = layoutSize.width / 2;
  const cy = layoutSize.height / 2;

  for (const line of lines) {
    if (line.entity && line.entity.preview_points && line.entity.preview_points.length > 1) {
      const pts = line.entity.preview_points;
      for (let i = 0; i < pts.length - 1; i++) {
        let from = toScreenPoint({ x: pts[i].north, y: pts[i].east }, viewport);
        let to = toScreenPoint({ x: pts[i + 1].north, y: pts[i + 1].east }, viewport);

        if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
          from = rotatePoint(from.x, from.y, cx, cy, rotation);
          to = rotatePoint(to.x, to.y, cx, cy, rotation);
        }

        const distance = distancePointToSegment(tap.x, tap.y, from.x, from.y, to.x, to.y);

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestId = line.id;
        }
      }
    } else {
      let from = toScreenPoint(line.from, viewport);
      let to = toScreenPoint(line.to, viewport);

      if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
        from = rotatePoint(from.x, from.y, cx, cy, rotation);
        to = rotatePoint(to.x, to.y, cx, cy, rotation);
      }

      const distance = distancePointToSegment(tap.x, tap.y, from.x, from.y, to.x, to.y);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = line.id;
      }
    }
  }

  return nearestId;
}

export function getCornerPoints(lines: PlanLine[]): { x: number, y: number }[] {
  const pointMap = new Map<string, { pt: { x: number, y: number }, segments: { dx: number, dy: number }[] }>();

  for (const line of lines) {
    if (isCurveEntity(line) || isCircleLikeLine(line)) {
      continue;
    }
    const k1 = `${line.from.x.toFixed(3)},${line.from.y.toFixed(3)}`;
    const k2 = `${line.to.x.toFixed(3)},${line.to.y.toFixed(3)}`;

    const len1 = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
    const dx1 = len1 > 0 ? (line.to.x - line.from.x) / len1 : 0;
    const dy1 = len1 > 0 ? (line.to.y - line.from.y) / len1 : 0;

    if (!pointMap.has(k1)) pointMap.set(k1, { pt: line.from, segments: [] });
    pointMap.get(k1)!.segments.push({ dx: dx1, dy: dy1 });

    const len2 = Math.hypot(line.from.x - line.to.x, line.from.y - line.to.y);
    const dx2 = len2 > 0 ? (line.from.x - line.to.x) / len2 : 0;
    const dy2 = len2 > 0 ? (line.from.y - line.to.y) / len2 : 0;

    if (!pointMap.has(k2)) pointMap.set(k2, { pt: line.to, segments: [] });
    pointMap.get(k2)!.segments.push({ dx: dx2, dy: dy2 });
  }

  const corners: { x: number, y: number }[] = [];

  for (const { pt, segments } of pointMap.values()) {
    if (segments.length === 1 || segments.length > 2) {
      corners.push(pt);
    } else if (segments.length === 2) {
      const dotProduct = segments[0].dx * segments[1].dx + segments[0].dy * segments[1].dy;
      if (dotProduct > -0.85) {
        corners.push(pt);
      }
    }
  }

  return corners;
}

export function pickNearestPoint(
  lines: PlanLine[],
  viewport: PreviewViewport,
  tap: LocalPoint,
  radiusPx: number,
  rotation: number = 0,
  layoutSize: { width: number; height: number } = { width: 0, height: 0 }
) {
  // Closest point on any plan stroke (mid-line or endpoint). Do NOT prefer
  // corners over a nearer mid-segment hit. Outside / hollow interior = null.
  let nearestPoint: { x: number; y: number } | null = null;
  let nearestDistance = radiusPx;

  const cx = layoutSize.width / 2;
  const cy = layoutSize.height / 2;

  const toScreen = (pt: { x: number; y: number }) => {
    let screenPt = toScreenPoint(pt, viewport);
    if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
      screenPt = rotatePoint(screenPt.x, screenPt.y, cx, cy, rotation);
    }
    return screenPt;
  };

  for (const line of lines) {
    if (
      line.layer === "virtual_boundary" ||
      line.layer === "transit" ||
      line.layer === "extension"
    ) {
      continue;
    }

    const segs: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
      const pts = line.entity.preview_points;
      for (let i = 0; i < pts.length - 1; i++) {
        segs.push({
          a: { x: pts[i].north, y: pts[i].east },
          b: { x: pts[i + 1].north, y: pts[i + 1].east },
        });
      }
    } else if (line.from && line.to) {
      segs.push({ a: line.from, b: line.to });
    }

    if (segs.length === 0) {
      for (const pt of [line.from, line.to]) {
        if (!pt) continue;
        const screenPt = toScreen(pt);
        const dist = Math.hypot(tap.x - screenPt.x, tap.y - screenPt.y);
        if (dist < nearestDistance) {
          nearestDistance = dist;
          nearestPoint = pt;
        }
      }
      continue;
    }

    for (const { a, b } of segs) {
      const sa = toScreen(a);
      const sb = toScreen(b);
      // Project tap onto screen-space segment, then map t back to plan coords.
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const l2 = dx * dx + dy * dy;
      let t = 0;
      if (l2 > 0) {
        t = Math.max(0, Math.min(1, ((tap.x - sa.x) * dx + (tap.y - sa.y) * dy) / l2));
      }
      const sx = sa.x + t * dx;
      const sy = sa.y + t * dy;
      const dist = Math.hypot(tap.x - sx, tap.y - sy);
      if (dist < nearestDistance) {
        nearestDistance = dist;
        nearestPoint = {
          x: a.x + t * (b.x - a.x),
          y: a.y + t * (b.y - a.y),
        };
      }
    }
  }

  return nearestPoint;
}
