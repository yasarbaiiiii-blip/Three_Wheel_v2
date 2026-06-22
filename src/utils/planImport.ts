import * as FileSystem from "expo-file-system/legacy";

import type { ImportedPlan, PlanLayer, PlanLine, PlanPoint } from "../types/plan";

type Pair = { code: string; value: string };

const ARC_SEGMENTS = 24;

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

  // Minimal support for MAVLink waypoints format (QGC WPL 110)
  // We look for lines starting with an index.
  const points: PlanPoint[] = [];
  let idCounter = 1;

  for (const line of lines) {
    if (line.startsWith("QGC")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;

    // Index 4, 5, 6 are often params. 8, 9, 10 are Lat/Lon/Alt or X/Y/Z.
    // For local NED plans, these are often meters.
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

function parseDxf(content: string): PlanLine[] {
  const pairs = toPairs(content);
  const entitiesStart = pairs.findIndex(
    (pair, index) =>
      pair.code === "0" &&
      pair.value === "SECTION" &&
      pairs[index + 1]?.code === "2" &&
      pairs[index + 1]?.value === "ENTITIES"
  );

  if (entitiesStart < 0) {
    return [];
  }

  const lines: PlanLine[] = [];
  let entityIndex = 0;
  let pointId = 1;

  for (let i = entitiesStart + 2; i < pairs.length; ) {
    const pair = pairs[i];

    if (pair.code === "0" && pair.value === "ENDSEC") {
      break;
    }

    if (pair.code !== "0") {
      i += 1;
      continue;
    }

    const type = pair.value;
    const entityPairs: Pair[] = [];
    i += 1;

    while (i < pairs.length && pairs[i].code !== "0") {
      entityPairs.push(pairs[i]);
      i += 1;
    }

    const layer = classifyLayer(getSingle(entityPairs, "8"));

    if (type === "LINE") {
      const x1 = getNumber(entityPairs, "10");
      const y1 = getNumber(entityPairs, "20");
      const x2 = getNumber(entityPairs, "11");
      const y2 = getNumber(entityPairs, "21");

      if ([x1, y1, x2, y2].every((value) => Number.isFinite(value))) {
        lines.push({
          id: `dxf-line-${entityIndex++}`,
          label: `${titleForLayer(layer)} Line ${entityIndex}`,
          layer,
          from: { id: pointId++, x: x1, y: y1 },
          to: { id: pointId++, x: x2, y: y2 },
          width: 0.1,
        });
      }
    }

    if (type === "LWPOLYLINE") {
      const vertices = getVertexList(entityPairs);
      const closed = getNumber(entityPairs, "70") === 1;

      for (let vertexIndex = 0; vertexIndex < vertices.length - 1; vertexIndex += 1) {
        lines.push(makeLine(vertices[vertexIndex], vertices[vertexIndex + 1], layer, entityIndex++, pointId));
        pointId += 2;
      }

      if (closed && vertices.length > 2) {
        lines.push(makeLine(vertices[vertices.length - 1], vertices[0], layer, entityIndex++, pointId));
        pointId += 2;
      }
    }

    if (type === "ARC" || type === "CIRCLE") {
      const cx = getNumber(entityPairs, "10");
      const cy = getNumber(entityPairs, "20");
      const radius = getNumber(entityPairs, "40");
      const startAngle = type === "ARC" ? getNumber(entityPairs, "50") : 0;
      const endAngle = type === "ARC" ? getNumber(entityPairs, "51") : 360;

      if ([cx, cy, radius].every((value) => Number.isFinite(value))) {
        const arcPoints = buildArcPoints(cx, cy, radius, startAngle, endAngle);

        for (let pointIndex = 0; pointIndex < arcPoints.length - 1; pointIndex += 1) {
          lines.push(
            makeLine(
              arcPoints[pointIndex],
              arcPoints[pointIndex + 1],
              layer,
              entityIndex++,
              pointId
            )
          );
          pointId += 2;
        }
      }
    }
  }

  return normalizePlanLines(refineLayerAssignments(dxfToAppAxes(lines)));
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
  // Deprecated: No longer forcing normalization to 100x60.
  // We return the raw lines to preserve metric scale and real-world coordinates.
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

function splitCsvRow(row: string) {
  return row
    .split(",")
    .map((value) => value.trim().replace(/^"|"$/g, ""));
}
