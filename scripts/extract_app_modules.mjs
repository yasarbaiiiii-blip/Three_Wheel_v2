/**
 * One-shot extractor: peel large pure/leaf sections out of App.tsx into modules.
 * Run from package root: node scripts/extract_app_modules.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const appPath = path.join(root, "App.tsx");
const lines = fs.readFileSync(appPath, "utf8").split(/\r?\n/);

function slice(start, endInclusive) {
  return lines.slice(start - 1, endInclusive).join("\n");
}

function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content.replace(/\n+$/, "") + "\n");
  console.log("wrote", rel, content.split("\n").length, "lines");
}

// --- planPreviewGeometry (types + pure helpers used by PlanPreview) ---
const geometryBody = slice(7895, 8332);
write(
  "src/utils/planPreviewGeometry.ts",
  `import type { PlanLine } from "../types/plan";
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

${geometryBody
  .replace(/^type PreviewViewport/, "export type PreviewViewport")
  .replace(/^type LocalPoint/, "export type LocalPoint")
  .replace(/^function /gm, "export function ")}
`
);

// --- PlanPreview component (raw body from App) ---
const planPreviewFn = slice(8334, 9816);
write(
  "src/components/PlanPreview.tsx",
  `import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from "react-native-svg";
import { Tractor } from "lucide-react-native";

import type { PlanLine, LayerVisibility } from "../types/plan";
import type { AutoOriginReference, MapGeometryFrame } from "../types/autoOrigin";
import {
  getCurveGeometry,
  getPlanLineRenderPoints,
  getPreviewCircleElements,
  isCircleLikeLine,
  isCurveEntity,
  isSegmentKindVisible,
  normalizePlanLinesForCurves,
} from "../utils/curveGeometry";
import {
  PREVIEW_ARROWHEAD_HALF_WIDTH_PX,
  PREVIEW_ARROWHEAD_LENGTH_PX,
  PREVIEW_RENDERED_LAYERS,
  MAX_PREVIEW_CORNERS,
  PATH_SEGMENT_CHUNK_SIZE,
  type PreviewRenderedLayer,
  type PreviewViewport,
  type LocalPoint,
  buildPreviewArrowheadPoints,
  buildSvgPathChunks,
  buildSvgPathForLine,
  clamp,
  computeAutoFitViewport,
  computePlanBounds,
  distancePointToSegment,
  getCornerPoints,
  getLineAnchorPoint,
  getPreviewArrowSegment,
  getPreviewRenderedLayer,
  isFiniteNumber,
  isRenderableLine,
  mapPreviewPointToScreen,
  normalizeDegrees,
  pickNearestLineId,
  pickNearestPoint,
  rotatePoint,
  shortestAngleDelta,
  toScreenPoint,
  touchAngle,
  touchDistance,
} from "../utils/planPreviewGeometry";
import { computePlanBoundingBoxLegacy, buildPlanLineSvgPath } from "../utils/curveGeometry";

${planPreviewFn.replace(/^function PlanPreview/, "export function PlanPreview")}

export default PlanPreview;
`
);

// --- ConnectionView ---
const connectionView = slice(7292, 7754);
write(
  "src/features/connection/ConnectionView.tsx",
  `import React from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { DiscoveredRover } from "../../types/appRuntime";

${connectionView}

export default ConnectionView;
`
);

// --- Secondary static pages + helpers from Swozi through end of styles used by them ---
// Include SwoziPage through build helpers / linesToDxf / RowToggle / secH styles
const secondary = slice(9818, 11211);
write(
  "src/screens/SecondaryPages.tsx",
  `import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import Slider from "@react-native-community/slider";
import type { PlanLine } from "../types/plan";
import * as FileSystem from "expo-file-system/legacy";

${secondary}

export {
  SwoziPage,
  StatusPage,
  PositioningPage,
  SettingsPage,
  HowToPage,
  AboutPage,
  linesToDxf,
  buildTemplate,
  buildRectangleTemplate,
  defaultDimensions,
  formatSprayParamValue,
};
`
);

console.log("Extraction files written. App.tsx still needs import wiring (next step).");
