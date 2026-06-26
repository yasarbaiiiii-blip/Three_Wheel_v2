/**
 * designTransform.ts — Phase 1 geometry transforms.
 *
 * Single source of truth for:
 *   - flattenDesignDocument (DesignDocument → PlanLine[])
 *   - flattenDesignNode (DesignNode → PlanLine[])
 *   - screenToDesignMeters / designToSvg
 *
 * Convention (from docs/coordinate-conventions.md):
 *   PlanPoint.x = north, PlanPoint.y = east
 *   SVG X = east, SVG Y = −north  (×100 px/m)
 */

import type { PlanLine, PlanPoint } from '../types/plan';
import type {
  DesignDocument,
  DesignNode,
  DesignEntity,
  DesignInstance,
  DesignVertex,
  DesignFrame,
  DesignPreviewAnchor,
} from '../types/designDocument';
import { isDesignInstance, isDesignEntity } from '../types/designDocument';
import type { TemplateRegistry } from './designTemplateRegistry';
import { validateDesignDocument } from './designValidation';

// ──────────────────────────────────────────
// Flatten: DesignDocument → PlanLine[]
// ──────────────────────────────────────────

export class DesignTransformError extends Error {
  constructor(message: string, public details?: string[]) {
    super(message);
    this.name = 'DesignTransformError';
  }
}

/**
 * Flatten a complete DesignDocument into legacy PlanLine[] format
 * for DXF export and backend compatibility.
 *
 * This is the **single flatten boundary** — all instance transforms
 * are applied here and only here.
 */
export function flattenDesignDocument(
  doc: DesignDocument,
  registry: TemplateRegistry,
): PlanLine[] {
  // Pre-validate
  const vr = validateDesignDocument(doc, registry.getIdSet());
  if (!vr.ok) {
    throw new DesignTransformError(
      'Cannot flatten invalid DesignDocument',
      vr.errors,
    );
  }

  const result: PlanLine[] = [];
  for (const node of doc.nodes) {
    const nodeLines = flattenDesignNode(node, registry, doc.frame);
    result.push(...nodeLines);
  }
  return result;
}

/**
 * Flatten a single DesignNode into PlanLine[].
 *
 * - INSTANCE: look up template lines, apply transform (rotate + scale + translate) ONCE
 * - ENTITY: convert vertices to PlanLines directly (already in world frame)
 */
export function flattenDesignNode(
  node: DesignNode,
  registry: TemplateRegistry,
  frame: DesignFrame,
): PlanLine[] {
  if (isDesignInstance(node)) {
    return flattenInstance(node, registry, frame);
  }
  if (isDesignEntity(node)) {
    return flattenEntity(node, frame);
  }
  return [];
}

/**
 * Flatten a DesignInstance by applying its transform to template-local lines.
 *
 * Transform application (matches legacy transformVisualDxfPoint but without double-scale):
 *   worldNorth = (localNorth * cos − localEast * sin) * scale + transform.northM
 *   worldEast  = (localNorth * sin + localEast * cos) * scale + transform.eastM
 *
 * This is applied ONCE — the template lines are never pre-scaled.
 */
function flattenInstance(
  instance: DesignInstance,
  registry: TemplateRegistry,
  _frame: DesignFrame,
): PlanLine[] {
  const template = registry.getTemplate(instance.templateId);
  if (!template) {
    throw new DesignTransformError(
      `Template not found: ${instance.templateId}`,
    );
  }

  const { northM, eastM, rotationDeg, scale } = instance.transform;
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  return template.lines.map((line, i) => {
    // Template-local PlanPoint: x = north, y = east
    const fromNorth = (line.from.x * cos - line.from.y * sin) * scale + northM;
    const fromEast = (line.from.x * sin + line.from.y * cos) * scale + eastM;
    const toNorth = (line.to.x * cos - line.to.y * sin) * scale + northM;
    const toEast = (line.to.x * sin + line.to.y * cos) * scale + eastM;

    return {
      ...line,
      id: `${instance.id}-${i}`,
      from: { ...line.from, x: fromNorth, y: fromEast } as PlanPoint,
      to: { ...line.to, x: toNorth, y: toEast } as PlanPoint,
    };
  });
}

/**
 * Flatten a DesignEntity — vertices are already in world frame.
 * Convert consecutive vertex pairs into PlanLines.
 */
function flattenEntity(
  entity: DesignEntity,
  _frame: DesignFrame,
): PlanLine[] {
  const lines: PlanLine[] = [];
  const verts = entity.vertices;

  if (entity.type === 'POINT' || verts.length < 2) {
    // Points produce no lines
    return lines;
  }

  for (let i = 0; i < verts.length - 1; i++) {
    lines.push({
      id: `${entity.id}-${i}`,
      label: `${entity.id} seg ${i}`,
      layer: (entity.layer.toLowerCase() as any) || 'marking',
      from: {
        id: i * 2,
        x: verts[i].northM,      // PlanPoint.x = north
        y: verts[i].eastM,       // PlanPoint.y = east
      },
      to: {
        id: i * 2 + 1,
        x: verts[i + 1].northM,
        y: verts[i + 1].eastM,
      },
      width: entity.width ?? 0.1,
    });
  }

  return lines;
}

// ──────────────────────────────────────────
// Screen ↔ Design coordinate transforms
// ──────────────────────────────────────────

export interface ViewportContext {
  svgSize: { width: number; height: number };
  camera: { x: number; y: number; zoom: number };
  boundaryWidthM: number;
  boundaryHeightM: number;
  frame: DesignFrame;
  pxPerM?: number; // default 100
}

/**
 * Convert screen pixel coordinates to design world metres.
 *
 * Inverse of the BoundaryEditor viewBox transform:
 *   screenX → SVG X → east (metres)
 *   screenY → SVG Y → −north (metres) → north
 */
export function screenToDesignMeters(
  screenX: number,
  screenY: number,
  ctx: ViewportContext,
): DesignVertex {
  const pxPerM = ctx.pxPerM ?? 100;
  const { svgSize, camera, boundaryWidthM, boundaryHeightM, frame } = ctx;

  if (svgSize.width <= 0 || svgSize.height <= 0) {
    throw new DesignTransformError('svgSize must be > 0');
  }

  // ViewBox dimensions (in SVG units / px)
  const viewBoxW = boundaryWidthM * pxPerM / camera.zoom;
  const viewBoxH = boundaryHeightM * pxPerM / camera.zoom;

  // ViewBox origin
  const viewBoxX = camera.x * pxPerM - viewBoxW / 2;
  const viewBoxY = -camera.y * pxPerM - viewBoxH / 2;

  // Screen pixels → SVG coordinates
  const svgX = viewBoxX + (screenX / svgSize.width) * viewBoxW;
  const svgY = viewBoxY + (screenY / svgSize.height) * viewBoxH;

  // SVG → design metres (east = svgX / pxPerM, north = -svgY / pxPerM)
  const eastM = svgX / pxPerM + frame.originEastM;
  const northM = -svgY / pxPerM + frame.originNorthM;

  return { northM, eastM };
}

/**
 * Convert design world metres to SVG coordinates (for rendering).
 *
 * east → svgX (×pxPerM)
 * north → svgY (×pxPerM, negated)
 */
export function designToSvg(
  vertex: DesignVertex,
  pxPerM: number = 100,
  frame?: DesignFrame,
): { svgX: number; svgY: number } {
  const oN = frame?.originNorthM ?? 0;
  const oE = frame?.originEastM ?? 0;
  return {
    svgX: (vertex.eastM - oE) * pxPerM,
    svgY: -(vertex.northM - oN) * pxPerM,
  };
}

/**
 * Compute the length of a PlanLine in metres.
 */
export function planLineLength(line: PlanLine): number {
  return Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
}

// ──────────────────────────────────────────
// Ramer-Douglas-Peucker path simplification
// ──────────────────────────────────────────

function getSqSegDist(p: DesignVertex, p1: DesignVertex, p2: DesignVertex) {
  let x = p1.eastM;
  let y = p1.northM;
  let dx = p2.eastM - x;
  let dy = p2.northM - y;

  if (dx !== 0 || dy !== 0) {
    let t = ((p.eastM - x) * dx + (p.northM - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2.eastM;
      y = p2.northM;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p.eastM - x;
  dy = p.northM - y;
  return dx * dx + dy * dy;
}

function simplifyDPStep(
  points: DesignVertex[],
  first: number,
  last: number,
  sqTolerance: number,
  simplified: DesignVertex[]
) {
  let maxSqDist = sqTolerance;
  let index = -1;

  for (let i = first + 1; i < last; i++) {
    const sqDist = getSqSegDist(points[i], points[first], points[last]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }

  if (index > -1) {
    if (index - first > 1) {
      simplifyDPStep(points, first, index, sqTolerance, simplified);
    }
    simplified.push(points[index]);
    if (last - index > 1) {
      simplifyDPStep(points, index, last, sqTolerance, simplified);
    }
  }
}

/**
 * Simplifies a polyline using the Ramer-Douglas-Peucker algorithm.
 */
export function simplifyPath(
  points: DesignVertex[],
  tolerance: number
): DesignVertex[] {
  if (points.length <= 2) return points;
  const sqTolerance = tolerance * tolerance;
  const simplified: DesignVertex[] = [points[0]];
  simplifyDPStep(points, 0, points.length - 1, sqTolerance, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

// ──────────────────────────────────────────
// GPS ↔ Design coordinate transforms
// ──────────────────────────────────────────

const EARTH_RADIUS = 6378137.0;

/**
 * Project a design vertex (northM, eastM) directly to GPS (lat, lon)
 * relative to the anchor's survey location.
 */
export function projectDesignToGps(
  vertex: DesignVertex,
  anchor: DesignPreviewAnchor,
): { lat: number; lon: number } {
  const originLatRad = (anchor.lat * Math.PI) / 180;
  const lat = anchor.lat + (vertex.northM / EARTH_RADIUS) * (180 / Math.PI);
  const lon =
    anchor.lon +
    (vertex.eastM / (EARTH_RADIUS * Math.cos(originLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

/**
 * Project a GPS position back to design-space metres (northM, eastM)
 * relative to the anchor's survey location.
 */
export function projectGpsToDesignMeters(
  lat: number,
  lon: number,
  anchor: DesignPreviewAnchor,
): DesignVertex {
  const originLatRad = (anchor.lat * Math.PI) / 180;
  const northM = (lat - anchor.lat) * (EARTH_RADIUS * Math.PI) / 180;
  const eastM =
    (lon - anchor.lon) *
    (EARTH_RADIUS * Math.cos(originLatRad) * Math.PI) /
    180;
  return { northM, eastM };
}
