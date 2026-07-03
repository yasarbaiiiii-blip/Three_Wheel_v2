import * as FileSystem from "expo-file-system/legacy";

import type { ImportedPlan, PlanLayer, PlanLine, PlanPoint } from "../types/plan";

type Pair = { code: string; value: string };

const ARC_SEGMENTS = 144;
const SPLINE_SEGMENTS = 64;
const ELLIPSE_SEGMENTS = 72;

export async function readImportedPlanFile(plan: ImportedPlan) {
  const raw = await FileSystem.readAsStringAsync(plan.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (plan.fileType === "dxf") {
    return parseDxf(raw);
  }

  if (plan.fileType === "waypoints") {
    return parseWaypoints(raw);
  }

  return parseCsv(raw);
}

export function parseImportedPlanContent(
  fileType: ImportedPlan["fileType"],
  content: string
) {
  if (fileType === "dxf") {
    return parseDxf(content);
  }

  if (fileType === "waypoints") {
    return parseWaypoints(content);
  }

  return parseCsv(content);
}

function parseWaypoints(content: string): PlanLine[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const points: PlanPoint[] = [];
  let idCounter = 1;

  for (const line of lines) {
    if (line.startsWith("QGC")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;

    const x = Number(parts[8]);
    const y = Number(parts[9]);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push({ id: idCounter++, x, y });
    }
  }

  const planLines: PlanLine[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    planLines.push({
      id: `waypoint-line-${i}`,
      label: `Path Segment ${i + 1}`,
      layer: "marking",
      from: points[i],
      to: points[i + 1],
      width: 0.1,
    });
  }

  return normalizePlanLines(planLines);
}

// ── Section extractors ──

/** Extract all pairs belonging to the first section with the given name. */
function extractSection(pairs: Pair[], sectionName: string): Pair[] {
  for (let i = 0; i < pairs.length; i++) {
    if (
      pairs[i]?.code === "0" &&
      pairs[i]?.value === "SECTION" &&
      pairs[i + 1]?.code === "2" &&
      pairs[i + 1]?.value === sectionName
    ) {
      // Start after the SECTION/2/name triple
      let j = i + 3;
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
 * Collect entity-pair groups from a section's pair list.
 * Each group starts at a "0" code with an entity type name.
 */
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
      groups.push({ type, pairs: groupPairs });
    } else {
      i++;
    }
  }
  return groups;
}

// ── Block library (INSERT support) ──

type DxfBlock = {
  name: string;
  entities: { type: string; pairs: Pair[] }[];
};

/**
 * Parse the BLOCKS section and return a map of block-name → block definition.
 */
function buildBlockLibrary(pairs: Pair[]): Map<string, DxfBlock> {
  const blocks = new Map<string, DxfBlock>();
  const sectionPairs = extractSection(pairs, "BLOCKS");
  // BLOCK/name/.../ENDBLK groups
  let i = 0;
  while (i < sectionPairs.length) {
    const p = sectionPairs[i];
    if (p.code === "0" && p.value === "BLOCK") {
      i++;
      const blockPairs: Pair[] = [];
      while (i < sectionPairs.length && !(sectionPairs[i].code === "0" && sectionPairs[i].value === "ENDBLK")) {
        blockPairs.push(sectionPairs[i]);
        i++;
      }
      // Skip ENDBLK
      if (i < sectionPairs.length) i++;

      const blockName = getSingle(blockPairs, "2");
      if (blockName && !blockName.startsWith("*")) {
        // Collect child entity groups within this block
        const entities = collectEntityGroups(blockPairs);
        blocks.set(blockName, { name: blockName, entities });
      }
    } else {
      i++;
    }
  }
  return blocks;
}

/**
 * Resolve an INSERT entity: look up the block, parse its child entities
 * with the INSERT's transform (position, scale, rotation) applied.
 */
function resolveInsert(
  entityPairs: Pair[],
  blockLib: Map<string, DxfBlock>,
  layer: PlanLayer,
  entityIndexRef: { value: number },
  pointIdRef: { value: number },
  lines: PlanLine[]
): void {
  const blockName = getSingle(entityPairs, "2");
  const block = blockLib.get(blockName);
  if (!block) return;

  const insX = getNumber(entityPairs, "10");
  const insY = getNumber(entityPairs, "20");
  const scaleX = getNumber(entityPairs, "41") || 1;
  const scaleY = getNumber(entityPairs, "42") || scaleX;
  const rotationDeg = getNumber(entityPairs, "50") || 0;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotationRad);
  const sinR = Math.sin(rotationRad);

  // Apply transform: for each entity in the block, transform its points
  for (const child of block.entities) {
    const childLayer = classifyLayer(getSingle(child.pairs, "8")) || layer;
    parseSingleEntity(child.type, child.pairs, childLayer, blockLib, entityIndexRef, pointIdRef, lines, {
      dx: insX,
      dy: insY,
      scaleX,
      scaleY,
      cosR,
      sinR,
      rotationDeg,
    });
  }
}

type InsertTransform = {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  cosR: number;
  sinR: number;
  rotationDeg: number;
};

function applyInsertTransform(
  x: number,
  y: number,
  t: InsertTransform
): { x: number; y: number } {
  // Apply scale, then rotation, then translation
  const sx = x * t.scaleX;
  const sy = y * t.scaleY;
  return {
    x: sx * t.cosR - sy * t.sinR + t.dx,
    y: sx * t.sinR + sy * t.cosR + t.dy,
  };
}

function applyInsertTransformToPoints(
  pts: { x: number; y: number }[],
  t: InsertTransform
): { x: number; y: number }[] {
  return pts.map((p) => applyInsertTransform(p.x, p.y, t));
}

// ── Entity parsing helpers for exported entities (no transform) ──

type ParseContext = {
  blockLib: Map<string, DxfBlock>;
  entityIndexRef: { value: number };
  pointIdRef: { value: number };
  lines: PlanLine[];
  insertTransform: InsertTransform | null;
};

/**
 * Parse a single entity type and push resulting PlanLines into `lines`.
 * `insertTransform` is non-null when called from INSERT resolution.
 */
function parseSingleEntity(
  type: string,
  entityPairs: Pair[],
  layer: PlanLayer,
  blockLib: Map<string, DxfBlock>,
  entityIndexRef: { value: number },
  pointIdRef: { value: number },
  lines: PlanLine[],
  insertTransform: InsertTransform | null = null
): void {
  // Helper to apply either insert transform or identity
  const tf = (x: number, y: number) =>
    insertTransform ? applyInsertTransform(x, y, insertTransform) : { x, y };
  const tfPts = (pts: { x: number; y: number }[]) =>
    insertTransform ? applyInsertTransformToPoints(pts, insertTransform) : pts;

  if (type === "LINE") {
    const x1 = getNumber(entityPairs, "10");
    const y1 = getNumber(entityPairs, "20");
    const x2 = getNumber(entityPairs, "11");
    const y2 = getNumber(entityPairs, "21");

    if ([x1, y1, x2, y2].every((v) => Number.isFinite(v))) {
      const from = tf(x1, y1);
      const to = tf(x2, y2);
      lines.push({
        id: `dxf-line-${entityIndexRef.value++}`,
        label: `${titleForLayer(layer)} Line ${entityIndexRef.value}`,
        layer,
        from: { id: pointIdRef.value++, x: from.x, y: from.y },
        to: { id: pointIdRef.value++, x: to.x, y: to.y },
        width: 0.1,
      });
    }
    return;
  }

  if (type === "LWPOLYLINE") {
    const vertices = getVertexList(entityPairs);
    const closed = getNumber(entityPairs, "70") === 1;
    const tfVertices = tfPts(vertices);

    for (let vi = 0; vi < tfVertices.length - 1; vi++) {
      lines.push(makeLine(tfVertices[vi], tfVertices[vi + 1], layer, entityIndexRef.value++, pointIdRef.value));
      pointIdRef.value += 2;
    }
    if (closed && tfVertices.length > 2) {
      lines.push(makeLine(tfVertices[tfVertices.length - 1], tfVertices[0], layer, entityIndexRef.value++, pointIdRef.value));
      pointIdRef.value += 2;
    }
    return;
  }

  if (type === "ARC" || type === "CIRCLE") {
    const cx = getNumber(entityPairs, "10");
    const cy = getNumber(entityPairs, "20");
    const radius = getNumber(entityPairs, "40");
    const startAngle = type === "ARC" ? getNumber(entityPairs, "50") : 0;
    const endAngle = type === "ARC" ? getNumber(entityPairs, "51") : 360;

    if ([cx, cy, radius].every((v) => Number.isFinite(v))) {
      const arcPoints = buildArcPoints(cx, cy, radius, startAngle, endAngle);
      if (arcPoints.length >= 2) {
        const tfArcPoints = tfPts(arcPoints);
        const sweep = (endAngle >= startAngle ? endAngle : endAngle + 360) - startAngle;
        const arcLength = (sweep / 360) * 2 * Math.PI * radius;

        lines.push({
          id: `dxf-arc-${entityIndexRef.value++}`,
          label: `${titleForLayer(layer)} ${type === "CIRCLE" ? "Circle" : "Arc"} ${entityIndexRef.value}`,
          layer,
          from: { id: pointIdRef.value++, x: tfArcPoints[0].x, y: tfArcPoints[0].y },
          to: { id: pointIdRef.value++, x: tfArcPoints[tfArcPoints.length - 1].x, y: tfArcPoints[tfArcPoints.length - 1].y },
          width: 0.1,
          entity: {
            entity_id: `entity-${entityIndexRef.value}`,
            entity_type: type,
            layer: getSingle(entityPairs, "8") || "0",
            color: getNumber(entityPairs, "62") || 7,
            is_mark: false,
            length_m: arcLength,
            geometry: { cx, cy, radius, startAngle, endAngle },
            preview_points: tfArcPoints.map((p) => ({ north: p.y, east: p.x })),
          },
        });
      }
    }
    return;
  }

  if (type === "SPLINE") {
    const degree = getNumber(entityPairs, "71") || 3;
    const controlXs = getAllNumbers(entityPairs, "10");
    const controlYs = getAllNumbers(entityPairs, "20");
    const knots = getAllNumbers(entityPairs, "40");

    if (controlXs.length >= 2 && controlXs.length === controlYs.length) {
      const controlPts: { x: number; y: number }[] = controlXs.map((x, i) => ({
        x, y: controlYs[i] ?? 0,
      }));
      const sampledPoints = sampleSpline(controlPts, knots, degree, SPLINE_SEGMENTS);
      if (sampledPoints.length >= 2) {
        const tfPts2 = tfPts(sampledPoints);
        lines.push({
          id: `dxf-spline-${entityIndexRef.value++}`,
          label: `${titleForLayer(layer)} Spline ${entityIndexRef.value}`,
          layer,
          from: { id: pointIdRef.value++, x: tfPts2[0].x, y: tfPts2[0].y },
          to: { id: pointIdRef.value++, x: tfPts2[tfPts2.length - 1].x, y: tfPts2[tfPts2.length - 1].y },
          width: 0.1,
          entity: {
            entity_id: `entity-${entityIndexRef.value}`,
            entity_type: type,
            layer: getSingle(entityPairs, "8") || "0",
            color: getNumber(entityPairs, "62") || 7,
            is_mark: false,
            length_m: 0,
            geometry: { degree, num_control_points: controlPts.length },
            preview_points: tfPts2.map((p) => ({ north: p.y, east: p.x })),
          },
        });
      }
    }
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

    if ([cx, cy, mx, my].every((v) => Number.isFinite(v))) {
      const majorLen = Math.hypot(mx, my);
      const majorAngle = Math.atan2(my, mx);
      const minorLen = majorLen * ratio;

      const points = buildEllipsePoints(cx, cy, majorLen, minorLen, majorAngle, startParam, endParam);
      if (points.length >= 2) {
        const tfPts2 = tfPts(points);
        const sweep = endParam - startParam;
        const arcLength = sweep * Math.sqrt((majorLen * majorLen + minorLen * minorLen) / 2);

        lines.push({
          id: `dxf-ellipse-${entityIndexRef.value++}`,
          label: `${titleForLayer(layer)} Ellipse ${entityIndexRef.value}`,
          layer,
          from: { id: pointIdRef.value++, x: tfPts2[0].x, y: tfPts2[0].y },
          to: { id: pointIdRef.value++, x: tfPts2[tfPts2.length - 1].x, y: tfPts2[tfPts2.length - 1].y },
          width: 0.1,
          entity: {
            entity_id: `entity-${entityIndexRef.value}`,
            entity_type: type,
            layer: getSingle(entityPairs, "8") || "0",
            color: getNumber(entityPairs, "62") || 7,
            is_mark: false,
            length_m: arcLength,
            geometry: { cx, cy, majorLen, minorLen, majorAngle, startParam, endParam },
            preview_points: tfPts2.map((p) => ({ north: p.y, east: p.x })),
          },
        });
      }
    }
    return;
  }

  if (type === "POINT") {
    const px = getNumber(entityPairs, "10");
    const py = getNumber(entityPairs, "20");
    if (Number.isFinite(px) && Number.isFinite(py)) {
      const pt = tf(px, py);
      // Emit as a tiny 1cm cross so it's visible on the map
      const tiny = 0.005; // 5mm
      lines.push({
        id: `dxf-point-${entityIndexRef.value++}`,
        label: `${titleForLayer(layer)} Point ${entityIndexRef.value}`,
        layer,
        from: { id: pointIdRef.value++, x: pt.x - tiny, y: pt.y },
        to: { id: pointIdRef.value++, x: pt.x + tiny, y: pt.y },
        width: 0.1,
      });
      lines.push({
        id: `dxf-point-${entityIndexRef.value}`,
        label: `${titleForLayer(layer)} Point ${entityIndexRef.value}`,
        layer,
        from: { id: pointIdRef.value++, x: pt.x, y: pt.y - tiny },
        to: { id: pointIdRef.value++, x: pt.x, y: pt.y + tiny },
        width: 0.1,
      });
      entityIndexRef.value++;
    }
    return;
  }

  if (type === "TEXT" || type === "MTEXT") {
    const tx = getNumber(entityPairs, "10");
    const ty = getNumber(entityPairs, "20");
    const height = getNumber(entityPairs, "40") || 1;
    const rotationDeg = getNumber(entityPairs, "50") || 0;
    const textContent = getSingle(entityPairs, "1") || "";
    const widthFactor = getNumber(entityPairs, "41") || 0.8;

    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      const origin = tf(tx, ty);
      const rad = (rotationDeg * Math.PI) / 180;
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);
      const w = textContent.length * height * widthFactor * 0.6;
      const h = height;

      // Build bounding box corners
      const corners = [
        { x: origin.x, y: origin.y },
        { x: origin.x + w * cosR, y: origin.y + w * sinR },
        { x: origin.x + w * cosR - h * sinR, y: origin.y + w * sinR + h * cosR },
        { x: origin.x - h * sinR, y: origin.y + h * cosR },
      ];

      for (let ci = 0; ci < 4; ci++) {
        const next = (ci + 1) % 4;
        lines.push({
          id: `dxf-text-${entityIndexRef.value}-${ci}`,
          label: textContent || `${titleForLayer(layer)} Text`,
          layer,
          from: { id: pointIdRef.value++, x: corners[ci].x, y: corners[ci].y },
          to: { id: pointIdRef.value++, x: corners[next].x, y: corners[next].y },
          width: 0.1,
        });
      }
      entityIndexRef.value++;
    }
    return;
  }

  if (type === "INSERT") {
    resolveInsert(entityPairs, blockLib, layer, entityIndexRef, pointIdRef, lines);
    return;
  }

  // Unknown entity type — silently skip (no crash)
}

// ── Main parseDxf ──

function parseDxf(content: string): PlanLine[] {
  const pairs = toPairs(content);

  // Phase 1: Build block library from BLOCKS section
  const blockLib = buildBlockLibrary(pairs);

  // Phase 2: Parse ENTITIES section
  const sectionPairs = extractSection(pairs, "ENTITIES");
  const entityGroups = collectEntityGroups(sectionPairs);

  const lines: PlanLine[] = [];
  const entityIndexRef = { value: 0 };
  const pointIdRef = { value: 1 };

  for (const group of entityGroups) {
    const layer = classifyLayer(getSingle(group.pairs, "8"));
    parseSingleEntity(
      group.type,
      group.pairs,
      layer,
      blockLib,
      entityIndexRef,
      pointIdRef,
      lines,
      null // no insert transform at top level
    );
  }

  return normalizePlanLines(refineLayerAssignments(dxfToAppAxes(lines)));
}

// ── SPLINE sampling (Catmull-Rom through control points) ──

function sampleSpline(
  controlPts: { x: number; y: number }[],
  _knots: number[],
  _degree: number,
  numSegments: number
): { x: number; y: number }[] {
  // Catmull-Rom spline through control points
  // For N control points, we produce N-2 segments (start/end excluded as they're virtual)
  const n = controlPts.length;
  if (n === 2) return controlPts; // Degenerate: straight line
  if (n === 1) return controlPts;

  const result: { x: number; y: number }[] = [];
  // Add first point
  result.push(controlPts[0]);

  // Catmull-Rom through interior points
  for (let i = 0; i < n - 1; i++) {
    const p0 = controlPts[Math.max(0, i - 1)];
    const p1 = controlPts[i];
    const p2 = controlPts[Math.min(n - 1, i + 1)];
    const p3 = controlPts[Math.min(n - 1, i + 2)];

    const steps = i < n - 2 ? numSegments / (n - 1) : 1;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      result.push({ x, y });
    }
  }

  return result;
}

// ── ELLIPSE sampling ──

function buildEllipsePoints(
  cx: number,
  cy: number,
  majorLen: number,
  minorLen: number,
  majorAngle: number,
  startParam: number,
  endParam: number
): { x: number; y: number }[] {
  const sweep = endParam - startParam;
  const numSteps = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * ELLIPSE_SEGMENTS));
  const points: { x: number; y: number }[] = [];
  const cosA = Math.cos(majorAngle);
  const sinA = Math.sin(majorAngle);

  for (let i = 0; i <= numSteps; i++) {
    const t = startParam + (sweep * i) / numSteps;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const ex = majorLen * cosT;
    const ey = minorLen * sinT;
    points.push({
      x: cx + ex * cosA - ey * sinA,
      y: cy + ex * sinA + ey * cosA,
    });
  }

  return points;
}

// ── DXF helpers ──

function toPairs(content: string): Pair[] {
  const rows = content.split(/\r?\n/);
  const pairs: Pair[] = [];

  for (let i = 0; i < rows.length - 1; i += 2) {
    pairs.push({
      code: rows[i].trim(),
      value: rows[i + 1].trim(),
    });
  }

  return pairs;
}

function getSingle(pairs: Pair[], code: string) {
  return pairs.find((pair) => pair.code === code)?.value ?? "";
}

function getNumber(pairs: Pair[], code: string) {
  return Number(getSingle(pairs, code));
}

function getAllNumbers(pairs: Pair[], code: string): number[] {
  return pairs
    .filter((pair) => pair.code === code)
    .map((pair) => Number(pair.value))
    .filter((v) => Number.isFinite(v));
}

function getVertexList(pairs: Pair[]) {
  const xs = pairs.filter((pair) => pair.code === "10").map((pair) => Number(pair.value));
  const ys = pairs.filter((pair) => pair.code === "20").map((pair) => Number(pair.value));

  return xs
    .map((x, index) => ({ x, y: ys[index] }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function makeLine(
  from: { x: number; y: number },
  to: { x: number; y: number },
  layer: PlanLayer,
  entityIndex: number,
  pointId: number
): PlanLine {
  return {
    id: `entity-${entityIndex}`,
    label: `${titleForLayer(layer)} Segment ${entityIndex + 1}`,
    layer,
    from: { id: pointId, x: from.x, y: from.y },
    to: { id: pointId + 1, x: to.x, y: to.y },
    width: 0.1,
  };
}

function buildArcPoints(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const normalizedEnd =
    endAngle >= startAngle ? endAngle : endAngle + 360;
  const sweep = normalizedEnd - startAngle;
  const segmentCount = Math.max(8, Math.ceil((sweep / 360) * ARC_SEGMENTS));
  const points: PlanPoint[] = [];

  for (let index = 0; index <= segmentCount; index += 1) {
    const angle = startAngle + (sweep * index) / segmentCount;
    const radians = (angle * Math.PI) / 180;
    points.push({
      id: index,
      x: cx + radius * Math.cos(radians),
      y: cy + radius * Math.sin(radians),
    });
  }

  return points;
}

// ── Layer / post-processing ──

function classifyLayer(layerName?: string): PlanLayer {
  const name = (layerName || "").toLowerCase();

  if (name.includes("bound")) {
    return "boundary";
  }

  if (name.includes("center") || name.includes("centre") || name.includes("mid")) {
    return "center";
  }

  return "marking";
}

function titleForLayer(layer: PlanLayer) {
  if (layer === "boundary") {
    return "Boundary";
  }

  if (layer === "center") {
    return "Center";
  }

  return "Marking";
}

/**
 * DXF/CAD coordinates are X = East, Y = North. The rest of this app uses the
 * NED convention `PlanLine.x = North`, `.y = East` (see shapeTemplates.ts and
 * toScreenPoint in App.tsx). Without this swap the imported plan renders
 * transposed (reflected across the diagonal) — origin looks right but the
 * overall profile is wrong. Display-only: the rover reads the DXF file itself.
 */
function dxfToAppAxes(lines: PlanLine[]): PlanLine[] {
  return lines.map((line) => ({
    ...line,
    from: { ...line.from, x: line.from.y, y: line.from.x },
    to: { ...line.to, x: line.to.y, y: line.to.x },
  }));
}

function parseCsv(content: string): PlanLine[] {
  const rows = content
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length === 0) {
    return [];
  }

  const firstColumns = splitCsvRow(rows[0]).map((value) => value.toLowerCase());
  const hasHeader = firstColumns.some((column) =>
    ["x1", "startx", "fromx", "layer", "label"].includes(column)
  );
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const pointOffset = hasHeader ? 0 : 1;

  const lines = dataRows
    .map((row, index) => {
      const columns = splitCsvRow(row);

      if (hasHeader) {
        const map = Object.fromEntries(
          firstColumns.map((header, headerIndex) => [header, columns[headerIndex] ?? ""])
        );

        const x1 = Number(map.x1 ?? map.startx ?? map.fromx);
        const y1 = Number(map.y1 ?? map.starty ?? map.fromy);
        const x2 = Number(map.x2 ?? map.endx ?? map.tox);
        const y2 = Number(map.y2 ?? map.endy ?? map.toy);

        if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) {
          return null;
        }

        return {
          id: `csv-line-${index}`,
          label: map.label || `CSV Line ${index + 1}`,
          layer: classifyLayer(map.layer),
          from: { id: pointOffset + index * 2 + 1, x: x1, y: y1 },
          to: { id: pointOffset + index * 2 + 2, x: x2, y: y2 },
          width: Number(map.width || 0.1) || 0.1,
        } satisfies PlanLine;
      }

      if (columns.length >= 4) {
        const [x1Text, y1Text, x2Text, y2Text] = columns;
        const x1 = Number(x1Text);
        const y1 = Number(y1Text);
        const x2 = Number(x2Text);
        const y2 = Number(y2Text);

        if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) {
          return null;
        }

        return {
          id: `csv-line-${index}`,
          label: `CSV Line ${index + 1}`,
          layer: "marking" as PlanLayer,
          from: { id: pointOffset + index * 2 + 1, x: x1, y: y1 },
          to: { id: pointOffset + index * 2 + 2, x: x2, y: y2 },
          width: 0.1,
        } satisfies PlanLine;
      }

      return null;
    })
    .filter((line): line is PlanLine => Boolean(line));

  return normalizePlanLines(refineLayerAssignments(lines));
}

export function normalizePlanLines(lines: PlanLine[]) {
  return lines;
}

function refineLayerAssignments(lines: PlanLine[]) {
  if (lines.length === 0) {
    return lines;
  }

  const hasExplicitBoundary = lines.some((line) => line.layer === "boundary");
  const hasExplicitCenter = lines.some((line) => line.layer === "center");

  if (hasExplicitBoundary && hasExplicitCenter) {
    return lines;
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const line of lines) {
    minX = Math.min(minX, line.from.x, line.to.x);
    maxX = Math.max(maxX, line.from.x, line.to.x);
    minY = Math.min(minY, line.from.y, line.to.y);
    maxY = Math.max(maxY, line.from.y, line.to.y);
  }

  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const centerX = minX + width / 2;
  const centerY = minY + height / 2;
  const edgeTolerance = Math.max(width, height) * 0.035;
  const centerTolerance = Math.min(width, height) * 0.06;
  const circleBand = Math.min(width, height) * 0.18;
  const circleTolerance = Math.min(width, height) * 0.035;

  return lines.map((line) => {
    if (line.layer === "boundary" || line.layer === "center") {
      return line;
    }

    const midpointX = (line.from.x + line.to.x) / 2;
    const midpointY = (line.from.y + line.to.y) / 2;
    const nearLeft =
      Math.abs(line.from.x - minX) < edgeTolerance &&
      Math.abs(line.to.x - minX) < edgeTolerance;
    const nearRight =
      Math.abs(line.from.x - maxX) < edgeTolerance &&
      Math.abs(line.to.x - maxX) < edgeTolerance;
    const nearTop =
      Math.abs(line.from.y - minY) < edgeTolerance &&
      Math.abs(line.to.y - minY) < edgeTolerance;
    const nearBottom =
      Math.abs(line.from.y - maxY) < edgeTolerance &&
      Math.abs(line.to.y - maxY) < edgeTolerance;

    if (nearLeft || nearRight || nearTop || nearBottom) {
      return { ...line, layer: "boundary" as PlanLayer };
    }

    const midpointDistance = Math.hypot(midpointX - centerX, midpointY - centerY);
    const crossesVerticalCenter =
      Math.abs(line.from.x - centerX) < centerTolerance &&
      Math.abs(line.to.x - centerX) < centerTolerance;
    const crossesHorizontalCenter =
      Math.abs(line.from.y - centerY) < centerTolerance &&
      Math.abs(line.to.y - centerY) < centerTolerance;
    const nearCenterCircle =
      Math.abs(midpointDistance - circleBand) < circleTolerance ||
      midpointDistance < centerTolerance * 1.25;

    if (crossesVerticalCenter || crossesHorizontalCenter || nearCenterCircle) {
      return { ...line, layer: "center" as PlanLayer };
    }

    return line;
  });
}

function splitCsvRow(row: string) {
  return row
    .split(",")
    .map((value) => value.trim().replace(/^"|"$/g, ""));
}