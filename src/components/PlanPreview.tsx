import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { MultiPointPlacementPhase } from "../types/fieldsWorkflow";
import type { PlacedItem } from "./BoundaryEditor";
import type { AnchorCandidatePoint } from "./mapViewTypes";
import { MapView } from "./MapView";
import { Map as MapIcon } from "lucide-react-native";
import {
  getCurveGeometry,
  getPlanLineRenderPoints,
  getPreviewCircleElements,
  isCircleLikeLine,
  isCurveEntity,
  isSegmentKindVisible,
  normalizePlanLinesForCurves,
  computePlanBoundingBoxLegacy,
  buildPlanLineSvgPath,
} from "../utils/curveGeometry";
import {
  coerceFiniteNumber,
  formatFinite,
  getLineLengthM,
  isPrimaryEditableLine,
  sanitizePlanLines,
} from "../utils/pathWorkflow";
import { projectGpsToLocalMeters } from "../utils/visualAlignment";
import { getPlanStartPoint } from "../utils/planStartPoint";
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

export function PlanPreview({
  lines,
  ghostLines = null,
  mapSourceLines,
  autoOriginReference = null,
  mapGeometryFrame = "NONE",
  autoOriginEnabled = false,
  geoOrigin = null,
  stagedVerified = false,
  visibility,
  selectedLineId,
  onSelectLine,
  highlightLineIds = null,
  originShiftKey = null,
  roverPosN,
  roverPosE,
  roverHeadingDeg,
  missionRunning = false,
  selectedPoints,
  onSelectPoint,
  onGuidePointFocus,
  alignedRefPoints = [],
  telemetryPosN = null,
  telemetryPosE = null,
  telemetryPosLat = null,
  telemetryPosLon = null,
  telemetryPosAlt = null,
  mapViewEnabled = true,
  showRefPointLabels = false,
  activeRefPointLabelIndex = null,
  onToggleRefPointLabel,
  isVisualAlignmentMode,
  isPlanEditingMode = false,
  multiPointPlacementPhase = "idle",
  onPlanAttached,
  visualAlignmentItem,
  setVisualAlignmentItem,
  visualAlignmentAnchor,
  previewFallbackGps = null,
  boundaryMode = false,
  boundaryWidth,
  boundaryHeight,
  boundaryPosition,
  onMoveBoundary,
  boundaryRotation = 0,
  onRotateBoundary,
  sketchMode = false,
  showBoundaryPoints = true,
  mapMode = "fields",
  recenterRoverTrigger,
  recenterPlanTrigger,
  resetNorthTrigger,
  hideRefocusControls = false,
  snapRefPoints,
  anchorCandidates,
  onAnchorCandidateSelect,
}: {
  lines: PlanLine[];
  ghostLines?: PlanLine[] | null;
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  geoOrigin?: [number, number] | null;
  stagedVerified?: boolean;
  visibility: LayerVisibility;
  selectedLineId: string | null;
  onSelectLine?: (id: string | null, options?: { highlightLineIds?: string[] | null }) => void;
  /**
   * Explicit multi-line highlight set (e.g. every extension segment in a Path Order
   * Pre/Aft group). When null/empty, only `selectedLineId` is highlighted.
   */
  highlightLineIds?: string[] | null;
  originShiftKey?: string | null;
  roverPosN?: number | null;
  roverPosE?: number | null;
  roverHeadingDeg?: number | null;
  missionRunning?: boolean;
  selectedPoints?: { x: number; y: number }[];
  onSelectPoint?: (pt: { x: number; y: number }) => void;
  onGuidePointFocus?: (index: number) => void;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  telemetryPosN?: number | null;
  telemetryPosE?: number | null;
  telemetryPosLat?: number | null;
  telemetryPosLon?: number | null;
  telemetryPosAlt?: number | null;
  mapViewEnabled?: boolean;
  showRefPointLabels?: boolean;
  activeRefPointLabelIndex?: number | null;
  onToggleRefPointLabel?: (index: number | null) => void;
  isVisualAlignmentMode?: boolean;
  isPlanEditingMode?: boolean;
  multiPointPlacementPhase?: MultiPointPlacementPhase;
  onPlanAttached?: (info: { x: number; y: number; rotation: number; scale: number }) => void;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  visualAlignmentAnchor?: { originLat: number; originLon: number; originDxfNorth: number; originDxfEast: number } | null;
  /** Shared latched GPS for fields fallback origin (matches startPlanEditing). */
  previewFallbackGps?: { lat: number; lon: number } | null;
  boundaryMode?: boolean;
  boundaryWidth?: number;
  boundaryHeight?: number;
  boundaryPosition?: { x: number; y: number };
  onMoveBoundary?: (x: number, y: number) => void;
  boundaryRotation?: number;
  onRotateBoundary?: (rotation: number) => void;
  sketchMode?: boolean;
  showBoundaryPoints?: boolean;
  mapMode?: "fields" | "templates";
  recenterRoverTrigger?: number;
  recenterPlanTrigger?: number;
  resetNorthTrigger?: number;
  hideRefocusControls?: boolean;
  snapRefPoints?: { lat: number; lon: number }[];
  anchorCandidates?: AnchorCandidatePoint[];
  onAnchorCandidateSelect?: (candidate: AnchorCandidatePoint) => void;
}) {
  const [visualSelected, setVisualSelected] = useState(true);
  const [boundarySelected, setBoundarySelected] = useState(true);
  const isEditablePlacedItemMode = Boolean(
    visualAlignmentItem && (isVisualAlignmentMode || isPlanEditingMode)
  );
  const isVisualAlignmentPreview = Boolean(
    visualAlignmentItem && alignedRefPoints && alignedRefPoints.length > 0
  );
  const isPlacedItemActive = isEditablePlacedItemMode || isVisualAlignmentPreview;
  const placedItemId = visualAlignmentItem?.id ?? null;

  // Entering move/edit or creating a sticker selects the plan once.
  // User can still tap outside to deselect and tap the plan to reselect.
  useEffect(() => {
    if (visualAlignmentItem && (isVisualAlignmentMode || isPlanEditingMode)) {
      setVisualSelected(true);
    }
  }, [visualAlignmentItem, isVisualAlignmentMode, isPlanEditingMode]);

  // Entering Resize re-selects so edge handles are immediately interactive.
  useEffect(() => {
    if (isPlanEditingMode && multiPointPlacementPhase === "resizing") {
      setVisualSelected(true);
    }
  }, [isPlanEditingMode, multiPointPlacementPhase]);

  useEffect(() => {
    if (boundaryMode) {
      setBoundarySelected(true);
    }
  }, [boundaryMode]);

  const applyLayerVisibility = useCallback(
    (source: PlanLine[]) =>
      sanitizePlanLines(source).filter((line) => {
        // Segment-type (line/arc/circle/...) visibility only applies to real plan
        // geometry — not the synthetic transit/extension/virtual_boundary layers.
        if (line.layer === "boundary") return visibility.boundary && isSegmentKindVisible(line, visibility.segmentTypes);
        if (line.layer === "marking") return visibility.marking && isSegmentKindVisible(line, visibility.segmentTypes);
        if (line.layer === "center") return visibility.center && isSegmentKindVisible(line, visibility.segmentTypes);
        if (line.layer === "transit") return visibility.transit;
        if (line.layer === "extension") return visibility.extension;
        return true;
      }),
    [visibility]
  );

  /** Guide / CSV / multi-point pins — hide when Layers → Ref points is off. */
  const showRefPointsLayer = visibility.refPoints !== false;
  const visibleSelectedPoints = showRefPointsLayer ? selectedPoints : [];
  const visibleSnapRefPoints = showRefPointsLayer ? snapRefPoints : undefined;
  const visibleShowRefPointLabels = showRefPointsLayer && showRefPointLabels;

  const filtered = useMemo(() => applyLayerVisibility(lines), [lines, applyLayerVisibility]);

  // The Mapbox <MapView> below uses raw `mapSourceLines` instead of `filtered`
  // whenever autoOriginEnabled (it needs pre-origin-shift coordinates for its own
  // GPS georeferencing) — that swap must not also bypass layer-visibility
  // filtering, or unchecking a Layers toggle (e.g. Extension) has no effect
  // whenever auto-origin is active, which is the common connected-rover case.
  const filteredMapSourceLines = useMemo(
    () => applyLayerVisibility(mapSourceLines ?? []),
    [mapSourceLines, applyLayerVisibility]
  );

  /**
   * Static geometry the map draws underneath an active sticker.
   *
   * The sticker's own lines must drop out (they'd ghost in the design frame beneath the
   * placed copy) — but nothing else should. That distinction only shows up with a pending
   * metric DXF, where the sticker holds ONE file while `lines` still carries the rest of an
   * already-verified batch; aligning against a CSV you can no longer see is guesswork.
   * When the sticker holds the whole plan (rover / single-file flow) every id matches and
   * this collapses to empty — identical to the unconditional [] it replaces.
   */
  const placedItemLineIds = useMemo(() => {
    if (!isPlacedItemActive || !visualAlignmentItem) return null;
    return new Set(visualAlignmentItem.lines.map((l) => l.id));
  }, [isPlacedItemActive, visualAlignmentItem]);

  const staticMapLines = useMemo(() => {
    const base = autoOriginEnabled && mapSourceLines ? filteredMapSourceLines : filtered;
    if (!isPlacedItemActive) return base;
    if (!placedItemLineIds) return [];
    return base.filter((l) => !placedItemLineIds.has(l.id));
  }, [
    autoOriginEnabled,
    mapSourceLines,
    filteredMapSourceLines,
    filtered,
    isPlacedItemActive,
    placedItemLineIds,
  ]);

  const filteredPlanSignature = useMemo(() => {
    const len = filtered.length;
    if (len === 0) return '0';
    const first = filtered[0];
    const last = filtered[len - 1];
    const mid = filtered[Math.floor(len / 2)];
    return `${len}:${first.id}:${last.id}:${mid.from.x.toFixed(2)}:${mid.to.y.toFixed(2)}`;
  }, [filtered]);

  const cornerPoints = useMemo(() => getCornerPoints(filtered.filter((l) => l.layer !== "virtual_boundary")).slice(0, MAX_PREVIEW_CORNERS), [filtered]);
  // Extract the 4 unique corners of the virtual bounding box for rendering & selection
  const virtualBoxCorners = useMemo(() => {
    const vbLines = filtered.filter((line) => line.layer === "virtual_boundary");
    if (vbLines.length === 0) return [];
    const seen = new Set<string>();
    const corners: { x: number; y: number }[] = [];
    for (const line of vbLines) {
      const fKey = `${line.from.x.toFixed(4)},${line.from.y.toFixed(4)}`;
      if (!seen.has(fKey)) { seen.add(fKey); corners.push({ x: line.from.x, y: line.from.y }); }
      const tKey = `${line.to.x.toFixed(4)},${line.to.y.toFixed(4)}`;
      if (!seen.has(tKey)) { seen.add(tKey); corners.push({ x: line.to.x, y: line.to.y }); }
    }
    return corners;
  }, [filtered]);
  // Compute dimension labels (Width and Length/Height) for the 4 virtual bounding box edges
  const virtualBoxLabels = useMemo(() => {
    const vbLines = filtered.filter((line) => line.layer === "virtual_boundary");
    if (vbLines.length === 0) return [];

    let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    for (const line of vbLines) {
      minN = Math.min(minN, line.from.x, line.to.x);
      maxN = Math.max(maxN, line.from.x, line.to.x);
      minE = Math.min(minE, line.from.y, line.to.y);
      maxE = Math.max(maxE, line.from.y, line.to.y);
    }
    const centerN = (minN + maxN) / 2;
    const centerE = (minE + maxE) / 2;

    return vbLines.map((line, idx) => {
      const midN = (line.from.x + line.to.x) / 2;
      const midE = (line.from.y + line.to.y) / 2;
      const lenM = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
      const isHorizontal = Math.abs(line.to.y - line.from.y) > Math.abs(line.to.x - line.from.x);

      let text = "";
      let anchor: "start" | "middle" | "end" = "middle";
      let offsetX = 0;
      let offsetY = 0;

      if (isHorizontal) {
        text = `Width: ${lenM.toFixed(2)}m`;
        anchor = "middle";
        // Top edge in CAD (larger Northing) appears at smaller screen Y (top of screen).
        offsetY = midN > centerN ? -8 : 16;
      } else {
        // Use both Length and Height terminology as requested by user
        text = midE > centerE ? `Height: ${lenM.toFixed(2)}m` : `Length: ${lenM.toFixed(2)}m`;
        anchor = midE > centerE ? "start" : "end";
        offsetX = midE > centerE ? 6 : -6;
        offsetY = 3;
      }

      return {
        id: line.id || `vlabel-${idx}`,
        midN,
        midE,
        text,
        anchor,
        offsetX,
        offsetY,
      };
    });
  }, [filtered]);

  const primarySequenceLines = useMemo(
    () => filtered.filter(isPrimaryEditableLine),
    [filtered]
  );
  // Deliberately derived from the UNFILTERED `lines` prop (not `filtered`) so a clicked
  // Transit/Extension row from the Fields "Path Order & Load" list still highlights on
  // demand even while that layer's ambient visibility is off (e.g. transit is force-hidden
  // during reorder) — only the specifically-selected line(s) render, not the whole layer.
  const selectedLines = useMemo(() => {
    const selectable = sanitizePlanLines(lines);
    if (highlightLineIds && highlightLineIds.length > 0) {
      const idSet = new Set(highlightLineIds);
      return selectable.filter((line) => idSet.has(line.id));
    }
    const single = selectable.find((line) => line.id === selectedLineId);
    return single ? [single] : [];
  }, [lines, highlightLineIds, selectedLineId]);

  // Distance label(s) for the currently highlighted line(s) — one per line in `selectedLines`,
  // positioned at the tessellated midpoint (correct for curves, not just a chord midpoint) and
  // offset perpendicular to the line's local direction so the label sits beside it rather than
  // on top of it.
  const selectionLabels = useMemo(() => {
    return selectedLines
      .map((line) => {
        const points = getPlanLineRenderPoints(line);
        if (points.length < 2) return null;
        const midIdx = Math.floor(points.length / 2);
        const mid = points[midIdx];
        const a = points[Math.max(0, midIdx - 1)];
        const b = points[Math.min(points.length - 1, midIdx + 1)];
        const dN = b.north - a.north;
        const dE = b.east - a.east;
        const dirLen = Math.hypot(dN, dE);
        // Perpendicular to the local direction, in (north, east); falls back to a fixed
        // east-ward offset for a degenerate (near-zero-length) direction sample.
        const perpN = dirLen > 1e-9 ? -dE / dirLen : 0;
        const perpE = dirLen > 1e-9 ? dN / dirLen : 1;
        const lengthM = getLineLengthM(line);
        if (lengthM == null) return null;
        return {
          id: line.id,
          midN: mid.north,
          midE: mid.east,
          text: `${formatFinite(lengthM, 2)} m`,
          anchor: "middle" as const,
          // Screen-space pixel offset (added post-projection, like virtualBoxLabels above) —
          // north maps to screen Y inverted, so the Y component is negated.
          offsetX: perpE * 14,
          offsetY: -perpN * 14,
        };
      })
      .filter((label): label is NonNullable<typeof label> => label != null);
  }, [selectedLines]);
  const pathChunksByLayer = useMemo(
    () => ({
      virtual_boundary: buildSvgPathChunks(filtered.filter((line) => line.layer === "virtual_boundary")),
      boundary: buildSvgPathChunks(filtered.filter((line) => line.layer === "boundary")),
      marking_true: buildSvgPathChunks(filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark !== false)),
      marking_false: buildSvgPathChunks(filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark === false)),
      center: buildSvgPathChunks(filtered.filter((line) => line.layer === "center")),
      transit: buildSvgPathChunks(filtered.filter((line) => line.layer === "transit")),
      extension: buildSvgPathChunks(filtered.filter((line) => line.layer === "extension")),
    }),
    [filtered]
  );

  const previewCirclesByLayer = useMemo(
    () => ({
      virtual_boundary: getPreviewCircleElements(filtered.filter((line) => line.layer === "virtual_boundary")),
      boundary: getPreviewCircleElements(filtered.filter((line) => line.layer === "boundary")),
      marking_true: getPreviewCircleElements(
        filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark !== false)
      ),
      marking_false: getPreviewCircleElements(
        filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark === false)
      ),
      center: getPreviewCircleElements(filtered.filter((line) => line.layer === "center")),
      transit: getPreviewCircleElements(filtered.filter((line) => line.layer === "transit")),
      extension: getPreviewCircleElements(filtered.filter((line) => line.layer === "extension")),
    }),
    [filtered]
  );

  // Prefer NED telemetry from parent — matches origin-shifted plan coordinates.
  const projectedRoverPoint = useMemo(() => {
    if (roverPosN != null && roverPosE != null) {
      return {
        north: roverPosN,
        east: roverPosE,
      };
    }
    if (
      telemetryPosLat != null &&
      telemetryPosLon != null &&
      alignedRefPoints &&
      alignedRefPoints.length > 0
    ) {
      const origin = alignedRefPoints[0];
      const { north, east } = projectGpsToLocalMeters(
        telemetryPosLat,
        telemetryPosLon,
        origin.lat,
        origin.lon
      );
      return {
        north: origin.dxf_x + north,
        east: origin.dxf_y + east,
      };
    }
    return null;
  }, [telemetryPosLat, telemetryPosLon, alignedRefPoints, roverPosN, roverPosE]);

  // Rover world-space position: pos_e = East, pos_n = North
  const hasRover = projectedRoverPoint != null;
  const hasRealTelemetry = (telemetryPosLat != null && telemetryPosLon != null) || (telemetryPosN != null && telemetryPosE != null);
  const roverN = projectedRoverPoint?.north ?? 0;   // North → SVG Y (inverted)
  const roverE = projectedRoverPoint?.east ?? 0;   // East → SVG X
  const roverDeg = roverHeadingDeg ?? 0;
  const [displayRoverPose, setDisplayRoverPose] = useState<{
    north: number;
    east: number;
    headingDeg: number;
  } | null>(null);
  const displayRoverPoseRef = React.useRef<typeof displayRoverPose>(null);

  const viewportRef = React.useRef<PreviewViewport>({ panX: 0, panY: 0, zoom: 1 });
  const linesRef = React.useRef(filtered);
  const onSelectLineRef = React.useRef(onSelectLine);
  const onSelectPointRef = React.useRef(onSelectPoint);
  const [layoutSize, setLayoutSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<PreviewViewport>({ panX: 0, panY: 0, zoom: 1 });
  const [rotation, setRotation] = useState(0);
  const selectedLineIdSet = useMemo(() => new Set(selectedLines.map((line) => line.id)), [selectedLines]);
  const arrowheadsByLayer = useMemo(() => {
    const result: Record<PreviewRenderedLayer, string[]> = {
      virtual_boundary: [],
      boundary: [],
      center: [],
      transit: [],
      extension: [],
      marking_true: [],
      marking_false: [],
    };

    for (const line of filtered) {
      if (selectedLineIdSet.has(line.id)) continue;

      const layer = getPreviewRenderedLayer(line);
      if (!layer) continue;

      const segment = getPreviewArrowSegment(line, viewport, rotation, layoutSize);
      if (!segment) continue;

      const points = buildPreviewArrowheadPoints(segment.from, segment.to);
      if (points) {
        result[layer].push(points);
      }
    }

    return result;
  }, [filtered, layoutSize, rotation, selectedLineIdSet, viewport]);

  /* ── RAF throttle for viewport (pan/pinch) ── */
  const rafViewportRef = React.useRef<PreviewViewport | null>(null);
  const rafViewportIdRef = React.useRef<number | null>(null);
  const scheduleViewportCommit = React.useCallback(() => {
    if (rafViewportIdRef.current !== null) return;
    rafViewportIdRef.current = requestAnimationFrame(() => {
      if (rafViewportRef.current !== null) {
        setViewport(rafViewportRef.current);
        viewportRef.current = rafViewportRef.current;
        rafViewportRef.current = null;
      }
      rafViewportIdRef.current = null;
    });
  }, []);
  const queueViewportCommit = React.useCallback((next: PreviewViewport) => {
    viewportRef.current = next;
    rafViewportRef.current = next;
    scheduleViewportCommit();
  }, [scheduleViewportCommit]);
  React.useEffect(() => {
    return () => {
      if (rafViewportIdRef.current !== null) cancelAnimationFrame(rafViewportIdRef.current);
    };
  }, []);
  // Track whether user has manually panned so auto-pan doesn't fight them
  const userPannedRef = React.useRef(false);
  // Baseline for the "selected points grew" auto-fit below — initialized to the
  // mount-time count so it never fires on first render, only on real growth.
  const lastSelectedPointsCountRef = React.useRef(selectedPoints?.length ?? 0);

  const rotationRef = React.useRef(rotation);
  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);

  const gestureRef = React.useRef<{
    lastTouch: LocalPoint | null;
    startTouch: LocalPoint | null;
    pinchDistance: number | null;
    pinchAngle: number | null;
    pinchViewport: PreviewViewport | null;
    pinchRotation: number;
    isTap: boolean;
    lastFocal: LocalPoint | null;
  }>({
    lastTouch: null,
    startTouch: null,
    pinchDistance: null,
    pinchAngle: null,
    pinchViewport: null,
    pinchRotation: 0,
    isTap: false,
    lastFocal: null,
  });

  useEffect(() => {
    linesRef.current = filtered;
  }, [filtered]);

  useEffect(() => {
    onSelectLineRef.current = onSelectLine;
  }, [onSelectLine]);

  useEffect(() => {
    onSelectPointRef.current = onSelectPoint;
  }, [onSelectPoint]);

  useEffect(() => {
    if (!hasRover) {
      displayRoverPoseRef.current = null;
      setDisplayRoverPose(null);
      return;
    }

    const nextPose = { north: roverN, east: roverE, headingDeg: normalizeDegrees(roverDeg) };
    const prevPose = displayRoverPoseRef.current;

    if (!prevPose) {
      displayRoverPoseRef.current = nextPose;
      setDisplayRoverPose(nextPose);
      return;
    }

    const positionDelta = Math.hypot(nextPose.north - prevPose.north, nextPose.east - prevPose.east);
    const headingDelta = Math.abs(shortestAngleDelta(prevPose.headingDeg, nextPose.headingDeg));

    if (positionDelta > 1.5 || headingDelta > 25) {
      displayRoverPoseRef.current = nextPose;
      setDisplayRoverPose(nextPose);
      return;
    }

    const alpha = missionRunning ? 0.18 : 1;
    const smoothedPose = {
      north: prevPose.north + (nextPose.north - prevPose.north) * alpha,
      east: prevPose.east + (nextPose.east - prevPose.east) * alpha,
      headingDeg: normalizeDegrees(prevPose.headingDeg + shortestAngleDelta(prevPose.headingDeg, nextPose.headingDeg) * alpha),
    };

    const smoothedDelta = Math.hypot(smoothedPose.north - prevPose.north, smoothedPose.east - prevPose.east);
    const smoothedHeadingDelta = Math.abs(shortestAngleDelta(prevPose.headingDeg, smoothedPose.headingDeg));
    if (smoothedDelta < 0.001 && smoothedHeadingDelta < 0.05) {
      return;
    }

    displayRoverPoseRef.current = smoothedPose;
    setDisplayRoverPose(smoothedPose);
  }, [hasRover, missionRunning, roverDeg, roverE, roverN]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // Reset manual pan state when plan or origin alignment changes
  useEffect(() => {
    userPannedRef.current = false;
  }, [filteredPlanSignature, originShiftKey]);

  // Auto-fit when plan lines change (only triggers when plan or layout changes)
  useEffect(() => {
    if (layoutSize.width <= 0 || layoutSize.height <= 0) return;
    if (filtered.length === 0) return; // Handled by rover tracking
    if (userPannedRef.current) return;

    const roverFitPoint =
      hasRover ? { north: roverN, east: roverE } : null;
    const fitted = computeAutoFitViewport(filtered, layoutSize.width, layoutSize.height, roverFitPoint);
    const prev = viewportRef.current;
    const unchanged =
      Math.abs(prev.panX - fitted.panX) < 0.5 &&
      Math.abs(prev.panY - fitted.panY) < 0.5 &&
      Math.abs(prev.zoom - fitted.zoom) < 0.001;
    if (unchanged) return;

    viewportRef.current = fitted;
    setViewport(fitted);
    setRotation(0);
  }, [filteredPlanSignature, originShiftKey, hasRover, roverE, roverN, layoutSize.width, layoutSize.height]);

  // Re-fit whenever the selected alignment ref points GROW (a tap-add or a bulk CSV
  // import) — CSV-imported points in particular may sit outside the plan's own line
  // bounds, so without this they can land off-screen with no way for the user to know.
  // Unlike the plan-change auto-fit above, this ALWAYS re-fits (ignores userPannedRef):
  // it's a direct response to the user's own action of adding a point, not a background
  // geometry change fighting their manual navigation. Ignores shrinkage (point removal).
  useEffect(() => {
    const count = selectedPoints?.length ?? 0;
    if (count > lastSelectedPointsCountRef.current && layoutSize.width > 0 && layoutSize.height > 0) {
      const selectedNE = (selectedPoints ?? []).map((p) => ({ north: p.x, east: p.y }));
      const fitted = computeAutoFitViewport(filtered, layoutSize.width, layoutSize.height, null, selectedNE);
      viewportRef.current = fitted;
      setViewport(fitted);
    }
    lastSelectedPointsCountRef.current = count;
  }, [selectedPoints, filtered, layoutSize.width, layoutSize.height]);

  // Auto-follow rover if no plan and user hasn't panned
  useEffect(() => {
    if (layoutSize.width <= 0 || layoutSize.height <= 0) return;
    if (filtered.length > 0) return; // Handled by plan autofit
    if (userPannedRef.current) return;

    const cx = roverE;
    const cy = -roverN; // NED North is up, so invert Y
    const defaultZoom = 40; // 40 px per metre looks reasonable at ~1m scale
    const fitted: PreviewViewport = {
      panX: layoutSize.width / 2 - cx * defaultZoom,
      panY: layoutSize.height / 2 - cy * defaultZoom,
      zoom: defaultZoom,
    };
    viewportRef.current = fitted;
    setViewport(fitted);
    setRotation(0);
  }, [roverE, roverN, layoutSize.width, layoutSize.height, filtered.length]);

  const focusRover = useCallback(() => {
    if (layoutSize.width <= 0 || layoutSize.height <= 0) return;
    const pose = displayRoverPoseRef.current ?? { north: hasRover ? roverN : 0, east: hasRover ? roverE : 0 };
    const nextZoom = viewportRef.current.zoom || viewport.zoom || 1;
    const next: PreviewViewport = {
      panX: layoutSize.width / 2 - pose.east * nextZoom,
      panY: layoutSize.height / 2 - (-pose.north) * nextZoom,
      zoom: nextZoom,
    };
    viewportRef.current = next;
    setViewport(next);
    userPannedRef.current = true; // Mark as user panned so it stays here
  }, [hasRover, layoutSize.height, layoutSize.width, roverE, roverN, viewport.zoom]);

  const handleLayout = useCallback((event: any) => {
    const { width, height } = event.nativeEvent.layout ?? {};
    if (width && height) {
      setLayoutSize((prev) => {
        const newW = Math.round(width);
        const newH = Math.round(height);
        return prev.width === newW && prev.height === newH ? prev : { width: newW, height: newH };
      });
    }
  }, []);

  const layoutSizeRef = React.useRef(layoutSize);
  useEffect(() => { layoutSizeRef.current = layoutSize; }, [layoutSize]);

  const panResponder = useMemo(() => {
    let lastTouchX = 0;
    let lastTouchY = 0;

    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    let pinchStartCenterX = 0;
    let pinchStartCenterY = 0;
    let pinchStartPanX = 0;
    let pinchStartPanY = 0;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length === 1) {
          lastTouchX = touches[0].pageX;
          lastTouchY = touches[0].pageY;
          pinchStartDistance = 0;
        } else if (touches.length === 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          pinchStartDistance = Math.hypot(dx, dy);
          pinchStartZoom = viewportRef.current.zoom;
          pinchStartPanX = viewportRef.current.panX;
          pinchStartPanY = viewportRef.current.panY;
          pinchStartCenterX = (touches[0].locationX + touches[1].locationX) / 2;
          pinchStartCenterY = (touches[0].locationY + touches[1].locationY) / 2;
        }
      },
      onPanResponderMove: (evt, gestureState) => {
        userPannedRef.current = true;
        const touches = evt.nativeEvent.touches;

        if (touches.length === 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const distance = Math.hypot(dx, dy);

          if (pinchStartDistance === 0) {
            pinchStartDistance = distance;
            pinchStartZoom = viewportRef.current.zoom;
            pinchStartPanX = viewportRef.current.panX;
            pinchStartPanY = viewportRef.current.panY;
            pinchStartCenterX = (touches[0].locationX + touches[1].locationX) / 2;
            pinchStartCenterY = (touches[0].locationY + touches[1].locationY) / 2;
          } else {
            const scale = distance / pinchStartDistance;
            const newZoom = Math.max(0.01, Math.min(1000, pinchStartZoom * scale));

            const currentCenterX = (touches[0].locationX + touches[1].locationX) / 2;
            const currentCenterY = (touches[0].locationY + touches[1].locationY) / 2;

            const zoomRatio = newZoom / pinchStartZoom;
            const next = {
              panX: currentCenterX - (pinchStartCenterX - pinchStartPanX) * zoomRatio,
              panY: currentCenterY - (pinchStartCenterY - pinchStartPanY) * zoomRatio,
              zoom: newZoom,
            };
            queueViewportCommit(next);
          }
        } else if (touches.length === 1) {
          if (pinchStartDistance > 0) {
            pinchStartDistance = 0;
            lastTouchX = touches[0].pageX;
            lastTouchY = touches[0].pageY;
          }

          const dx = touches[0].pageX - lastTouchX;
          const dy = touches[0].pageY - lastTouchY;

          const next = {
            panX: viewportRef.current.panX + dx,
            panY: viewportRef.current.panY + dy,
            zoom: viewportRef.current.zoom,
          };
          lastTouchX = touches[0].pageX;
          lastTouchY = touches[0].pageY;

          queueViewportCommit(next);
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        pinchStartDistance = 0;
        // Tap detection
        if (Math.abs(gestureState.dx) < 5 && Math.abs(gestureState.dy) < 5 && evt.nativeEvent.touches.length === 0) {
          const tapX = evt.nativeEvent.locationX;
          const tapY = evt.nativeEvent.locationY;

          if (visibleShowRefPointLabels && alignedRefPoints.length > 0 && onToggleRefPointLabel) {
            let hitIndex: number | null = null;
            let hitDist = 20;
            for (let i = 0; i < alignedRefPoints.length; i++) {
              const pt = alignedRefPoints[i];
              const rawSX = pt.dxf_y * viewportRef.current.zoom + viewportRef.current.panX;
              const rawSY = -pt.dxf_x * viewportRef.current.zoom + viewportRef.current.panY;
              let sx = rawSX;
              let sy = rawSY;
              if (rotationRef.current !== 0 && layoutSizeRef.current.width > 0 && layoutSizeRef.current.height > 0) {
                const rotated = rotatePoint(rawSX, rawSY, layoutSizeRef.current.width / 2, layoutSizeRef.current.height / 2, rotationRef.current);
                sx = rotated.x;
                sy = rotated.y;
              }
              const dist = Math.hypot(tapX - sx, tapY - sy);
              if (dist <= hitDist) {
                hitDist = dist;
                hitIndex = i;
              }
            }
            if (hitIndex != null) {
              onToggleRefPointLabel(activeRefPointLabelIndex === hitIndex ? null : hitIndex);
              return;
            }
          }

          const tap = { x: tapX, y: tapY };
          if (onSelectPointRef.current) {
            // ~44px finger target for Multi-Point guide picking (Map Off canvas).
            const ptHit = pickNearestPoint(
              linesRef.current,
              viewportRef.current,
              tap,
              44,
              rotationRef.current,
              layoutSizeRef.current
            );
            if (ptHit) {
              onSelectPointRef.current(ptHit);
              return;
            }
          }
          const hit = pickNearestLineId(linesRef.current, viewportRef.current, tap, 48, rotationRef.current, layoutSizeRef.current);
          if (hit) {
            onSelectLineRef.current?.(hit);
          } else {
            onSelectLineRef.current?.(null);
          }
        }
      },
      onPanResponderTerminate: () => {
        pinchStartDistance = 0;
      },
    });
  }, []);

  const strokeForLayer = (layer: string) => {
    if (layer === "virtual_boundary") return "#06b6d4"; // Cyan dashed boundary box
    if (layer === "boundary") return "#0f172a";
    if (layer === "center") return "#d97706";
    if (layer === "transit") return "#94a3b8";
    if (layer === "extension") return "#8b5cf6";
    if (layer === "marking_true") return "#16a34a"; // Dark green for marking (spray)
    if (layer === "marking_false") return "#86efac"; // Light green for non-spray
    return "#475569";
  };

  const [recenterRoverCount, setRecenterRoverCount] = useState(0);
  const [recenterPlanCount, setRecenterPlanCount] = useState(0);

  const handleFocusRover = () => {
    if (mapViewEnabled) {
      setRecenterRoverCount((c) => c + 1);
    } else {
      focusRover();
    }
  };

  const handleFocusPlan = () => {
    if (mapViewEnabled) {
      setRecenterPlanCount((c) => c + 1);
    } else {
      if (layoutSize.width <= 0 || layoutSize.height <= 0) return;
      userPannedRef.current = true;
      if (filtered.length === 0) {
        const next: PreviewViewport = {
          panX: layoutSize.width / 2,
          panY: layoutSize.height / 2,
          zoom: 40,
        };
        viewportRef.current = next;
        setViewport(next);
        return;
      }
      const fitted = computeAutoFitViewport(filtered, layoutSize.width, layoutSize.height);
      viewportRef.current = fitted;
      setViewport(fitted);
    }
  };

  const lastExternalRoverTriggerRef = useRef(0);
  const lastExternalPlanTriggerRef = useRef(0);

  useEffect(() => {
    if (!recenterRoverTrigger || recenterRoverTrigger <= lastExternalRoverTriggerRef.current) return;
    lastExternalRoverTriggerRef.current = recenterRoverTrigger;
    if (!mapViewEnabled) focusRover();
  }, [recenterRoverTrigger, mapViewEnabled, focusRover]);

  useEffect(() => {
    if (!recenterPlanTrigger || recenterPlanTrigger <= lastExternalPlanTriggerRef.current) return;
    lastExternalPlanTriggerRef.current = recenterPlanTrigger;
    if (!mapViewEnabled) handleFocusPlan();
  }, [recenterPlanTrigger, mapViewEnabled, handleFocusPlan]);

  const roverDisplayPose = displayRoverPose ?? {
    north: roverN,
    east: roverE,
    headingDeg: normalizeDegrees(roverDeg),
  };

  // Compute rover screen coordinates for icon rendering
  // World North (roverPosN) maps to Screen Y (Up)
  // World East (roverPosE) maps to Screen X (Right)
  const rawRoverScreenX = roverDisplayPose.east * viewport.zoom + viewport.panX;
  const rawRoverScreenY = -roverDisplayPose.north * viewport.zoom + viewport.panY;

  let roverScreenX = rawRoverScreenX;
  let roverScreenY = rawRoverScreenY;
  if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
    const rotated = rotatePoint(rawRoverScreenX, rawRoverScreenY, layoutSize.width / 2, layoutSize.height / 2, rotation);
    roverScreenX = rotated.x;
    roverScreenY = rotated.y;
  }

  // Grid spacing in world units for the no-plan grid
  const GRID_WORLD_SPACING = 1; // 1 metre squares

  return (
    <View
      onLayout={handleLayout}
      style={{ flex: 1 }}
    >
      <View
        {...(mapViewEnabled ? {} : panResponder.panHandlers)}
        collapsable={false}
        style={{ flex: 1, position: "relative", backgroundColor: "#f0f4f8", overflow: "hidden" }}
      >
        {mapViewEnabled ? (
          <MapView
            mode={isPlacedItemActive || boundaryMode ? "templates" : "fields"}
            boundaryWidth={boundaryWidth}
            boundaryHeight={boundaryHeight}
            boundaryPosition={boundaryPosition}
            onMoveBoundary={onMoveBoundary}
            boundaryRotation={boundaryRotation}
            onRotateBoundary={onRotateBoundary}
            sketchMode={sketchMode}
            showBoundaryPoints={showBoundaryPoints}
            snapRefPoints={visibleSnapRefPoints}
            planPlacementPhase={
              isPlanEditingMode ? multiPointPlacementPhase : "idle"
            }
            onPlanAttached={onPlanAttached}
            placedItems={isPlacedItemActive && visualAlignmentItem ? [visualAlignmentItem] : []}
            selectedItemIds={
              // Tap plan → select; tap outside → deselect (gestures only when selected).
              isEditablePlacedItemMode && visualSelected && placedItemId
                ? [placedItemId]
                : boundaryMode && boundarySelected
                ? ["boundary"]
                : []
            }
            multiTouchMode={
              // Resize: pan only (edge-handle scale). Move: pan + two-finger rotate.
              multiPointPlacementPhase === "resizing"
                ? "scale"
                : isEditablePlacedItemMode || isPlanEditingMode
                ? "rotate"
                : "both"
            }
            onSelectionChange={(ids) => {
              if (boundaryMode) {
                setBoundarySelected(ids.includes("boundary"));
                return;
              }
              if (!isEditablePlacedItemMode || !placedItemId) return;
              setVisualSelected(ids.includes(placedItemId));
            }}
            onUpdatePlacedItem={(id, updates) => {
              if (!isEditablePlacedItemMode || !placedItemId || id !== placedItemId) return;
              setVisualAlignmentItem?.((prev: PlacedItem | null) => {
                if (!prev) return prev;
                return { ...prev, ...updates };
              });
            }}
            telemetrySnapshot={{
              lat: telemetryPosLat,
              lon: telemetryPosLon,
              alt: telemetryPosAlt,
              heading_ned_deg: roverHeadingDeg,
              pos_n: telemetryPosN,
              pos_e: telemetryPosE,
            } as any}
            lines={staticMapLines}
            ghostLines={ghostLines}
            anchorCandidates={anchorCandidates}
            onAnchorCandidateSelect={onAnchorCandidateSelect}
            alignedRefPoints={alignedRefPoints}
            autoOriginReference={autoOriginReference}
            mapGeometryFrame={mapGeometryFrame}
            autoOriginEnabled={autoOriginEnabled}
            geoOrigin={geoOrigin}
            stagedVerified={stagedVerified}
            visualAlignmentAnchor={visualAlignmentAnchor}
            previewFallbackGps={previewFallbackGps}
            visible
            showRover={visibility.rover !== false}
            showLengths={visibility.lengths === true}
            showRefPointLabels={visibleShowRefPointLabels}
            recenterRoverTrigger={recenterRoverTrigger || recenterRoverCount}
            recenterPlanTrigger={recenterPlanTrigger || recenterPlanCount}
            resetNorthTrigger={resetNorthTrigger}
            onSelectPoint={showRefPointsLayer ? onSelectPoint : undefined}
            onGuidePointFocus={showRefPointsLayer ? onGuidePointFocus : undefined}
            onSelectLine={onSelectLine}
            selectedLineId={selectedLineId}
            highlightedLines={selectedLines}
            showCornerPoints={true}
            selectedPoints={visibleSelectedPoints}
          />
        ) : filtered.length === 0 && !hasRover ? (
          // No plan, no rover: show placeholder
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 18 }}>
            <Text style={{ color: "#475569", fontSize: 15, textAlign: "center", lineHeight: 22 }}>
              No plan lines to display yet.
            </Text>
            <Text style={{ color: "#94a3b8", fontSize: 12, marginTop: 6, textAlign: "center" }}>
              Import or generate a field to see the preview here.
            </Text>
          </View>
        ) : (
          <Svg pointerEvents="none" width="100%" height="100%">
            {/* ── Background grid (always visible) ── */}
            {layoutSize.width > 0 && layoutSize.height > 0 && (() => {
              const spacing = GRID_WORLD_SPACING * viewport.zoom;
              if (spacing < 8) return null; // too dense to draw
              const originX = viewport.panX;
              const originY = viewport.panY;
              // Batch vertical grid lines into single <Path>
              let vPath = '';
              const startCol = Math.floor(-originX / spacing) - 1;
              const endCol = Math.ceil((layoutSize.width - originX) / spacing) + 1;
              for (let c = startCol; c <= endCol; c++) {
                if (c === 0) continue; // origin drawn separately
                const sx = originX + c * spacing;
                vPath += `M${sx} 0V${layoutSize.height}`;
              }
              // Batch horizontal grid lines into single <Path>
              let hPath = '';
              const startRow = Math.floor(-originY / spacing) - 1;
              const endRow = Math.ceil((layoutSize.height - originY) / spacing) + 1;
              for (let r = startRow; r <= endRow; r++) {
                if (r === 0) continue; // origin drawn separately
                const sy = originY + r * spacing;
                hPath += `M0 ${sy}H${layoutSize.width}`;
              }
              // Origin axes
              const oxLine = `M${originX} 0V${layoutSize.height}`;
              const oyLine = `M0 ${originY}H${layoutSize.width}`;
              return (
                <>
                  {vPath ? <Path d={vPath} stroke="#d8e4f0" strokeWidth={0.6} opacity={0.6} /> : null}
                  {hPath ? <Path d={hPath} stroke="#d8e4f0" strokeWidth={0.6} opacity={0.6} /> : null}
                  <Path d={oxLine} stroke="#94a3b8" strokeWidth={1.2} opacity={0.9} />
                  <Path d={oyLine} stroke="#94a3b8" strokeWidth={1.2} opacity={0.9} />
                </>
              );
            })()}

            {/* ── Plan lines ── */}
            <G transform={`translate(${layoutSize.width / 2}, ${layoutSize.height / 2}) rotate(${rotation}) translate(${-layoutSize.width / 2}, ${-layoutSize.height / 2}) translate(${viewport.panX}, ${viewport.panY}) scale(${viewport.zoom}, ${-viewport.zoom})`}>
              {PREVIEW_RENDERED_LAYERS.flatMap((layer) =>
                pathChunksByLayer[layer].map((d, index) => (
                  <Path
                    key={`${layer}-path-${index}`}
                    d={d}
                    stroke={strokeForLayer(layer)}
                    strokeWidth={layer === "virtual_boundary" ? 2.5 / viewport.zoom : 2 / viewport.zoom}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    opacity={0.96}
                    {...(layer === "extension" ? { strokeDasharray: `${8 / viewport.zoom} ${6 / viewport.zoom}` } : {})}
                    {...(layer === "virtual_boundary" ? { strokeDasharray: `${10 / viewport.zoom} ${5 / viewport.zoom}` } : {})}
                  />
                ))
              )}
              {PREVIEW_RENDERED_LAYERS.flatMap((layer) =>
                previewCirclesByLayer[layer].map((circleShape, index) => (
                  <Circle
                    key={`${layer}-circle-${circleShape.line.id}-${index}`}
                    cx={circleShape.centerEast}
                    cy={circleShape.centerNorth}
                    r={circleShape.radius}
                    stroke={strokeForLayer(layer)}
                    strokeWidth={2 / viewport.zoom}
                    fill="none"
                    opacity={0.96}
                  />
                ))
              )}
              {selectedLines.map((line) =>
                isCircleLikeLine(line) ? (() => {
                  const curve = getCurveGeometry(line);
                  if (!curve) return null;
                  return (
                    <Circle
                      key={`sel-${line.id}`}
                      cx={curve.centerEast}
                      cy={curve.centerNorth}
                      r={curve.radius}
                      stroke="#ef4444"
                      strokeWidth={3 / viewport.zoom}
                      fill="none"
                      opacity={1}
                    />
                  );
                })() : (
                  <Path
                    key={`sel-${line.id}`}
                    d={buildSvgPathForLine(line)}
                    stroke="#ef4444"
                    strokeWidth={3 / viewport.zoom}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    opacity={1}
                  />
                )
              )}
              {/* ── Endpoints / Corners ── */}
              {cornerPoints.map((pt, i) => (
                <Circle key={`ep-${i}`} cx={pt.y} cy={pt.x} r={2.5 / viewport.zoom} fill="#3b82f6" opacity={0.8} />
              ))}
              {/* ── Virtual Bounding Box Corners ── */}
              {virtualBoxCorners.map((pt, i) => (
                <Circle
                  key={`vbc-${i}`}
                  cx={pt.y}
                  cy={pt.x}
                  r={5 / viewport.zoom}
                  fill="#06b6d4"
                  stroke="#ffffff"
                  strokeWidth={1.5 / viewport.zoom}
                  opacity={0.95}
                />
              ))}
              {/* ── Selected Points (yellow highlight for alignment) ── */}
              {visibleSelectedPoints?.map((pt, i) => (
                <Circle
                  key={`sp-${i}`}
                  cx={pt.y}
                  cy={pt.x}
                  r={7 / viewport.zoom}
                  fill="#eab308"
                  stroke="#ffffff"
                  strokeWidth={2 / viewport.zoom}
                />
              ))}

              {/* ── Plan Start Direction Arrow ── */}
              {filtered.length > 0 && (() => {
                const startPoint = getPlanStartPoint(filtered);
                const first = startPoint
                  ? filtered.find((line) =>
                      coerceFiniteNumber(line.from?.x) === startPoint.north &&
                      coerceFiniteNumber(line.from?.y) === startPoint.east
                    ) ?? filtered[0]
                  : filtered[0];
                const startX = first.from.y;
                const startY = first.from.x;
                const endX = first.to.y;
                const endY = first.to.x;
                const angle = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI;
                return (
                  <G transform={`translate(${startX}, ${startY})`}>
                    <Polygon
                      points={`0,${-8 / viewport.zoom} ${12 / viewport.zoom},0 0,${8 / viewport.zoom}`}
                      fill="#ef4444"
                      stroke="#ffffff"
                      strokeWidth={1 / viewport.zoom}
                      transform={`rotate(${90 - angle})`}
                    />
                  </G>
                );
              })()}

            </G>

            {/* ── Direction arrows ── */}
            {PREVIEW_RENDERED_LAYERS.flatMap((layer) =>
              arrowheadsByLayer[layer].map((points, index) => (
                <Polygon
                  key={`arrow-${layer}-${index}`}
                  points={points}
                  fill={strokeForLayer(layer)}
                  stroke="#ffffff"
                  strokeWidth={0.8}
                  strokeLinejoin="round"
                  opacity={0.98}
                />
              ))
            )}
            {selectedLines.map((line) => {
              const segment = getPreviewArrowSegment(line, viewport, rotation, layoutSize);
              if (!segment) return null;

              const points = buildPreviewArrowheadPoints(segment.from, segment.to);
              return points ? (
                <Polygon
                  key={`sel-arrow-${line.id}`}
                  points={points}
                  fill="#ef4444"
                  stroke="#ffffff"
                  strokeWidth={0.9}
                  strokeLinejoin="round"
                />
              ) : null;
            })}
            {/* ── Rover-to-Plan distance indicator ── */}
            {hasRealTelemetry && filtered.length > 0 && (() => {
              let nextDist = Infinity;
              let nextTarget = null;
              const realN = roverN;
              const realE = roverE;

              for (let i = 0; i < filtered.length; i++) {
                const line = filtered[i];
                const segStart = { x: line.from.x, y: line.from.y };
                const segEnd = { x: line.to.x, y: line.to.y };

                const segDx = segEnd.x - segStart.x;
                const segDy = segEnd.y - segStart.y;
                const segLen2 = segDx * segDx + segDy * segDy;
                if (segLen2 === 0) continue;

                const t = ((realN - segStart.x) * segDx + (realE - segStart.y) * segDy) / segLen2;
                const targetPt = t <= 0.5
                  ? { x: segEnd.x, y: segEnd.y }
                  : (i < filtered.length - 1 ? { x: filtered[i + 1].from.x, y: filtered[i + 1].from.y } : { x: segEnd.x, y: segEnd.y });
                const targetDist = Math.hypot(targetPt.x - realN, targetPt.y - realE);
                nextDist = targetDist;
                nextTarget = targetPt;
                break;
              }
              if (nextTarget && nextDist < 100) {
                const planScreenX = nextTarget.y * viewport.zoom + viewport.panX;
                const planScreenY = -nextTarget.x * viewport.zoom + viewport.panY;
                let rotatedPlanX = planScreenX;
                let rotatedPlanY = planScreenY;
                if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
                  const rotated = rotatePoint(planScreenX, planScreenY, layoutSize.width / 2, layoutSize.height / 2, rotation);
                  rotatedPlanX = rotated.x;
                  rotatedPlanY = rotated.y;
                }
                const rx = roverScreenX;
                const ry = roverScreenY;
                const midX = (rx + rotatedPlanX) / 2;
                const midY = (ry + rotatedPlanY) / 2;
                const altSuffix = telemetryPosAlt != null ? ` (Alt: ${telemetryPosAlt.toFixed(1)}m)` : '';
                return (
                  <G key="rover-to-plan-distance">
                    <Line
                      x1={rx}
                      y1={ry}
                      x2={rotatedPlanX}
                      y2={rotatedPlanY}
                      stroke="#f59e0b"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <SvgText
                      x={midX}
                      y={midY - 8}
                      fill="#ffffff"
                      stroke="#ffffff"
                      strokeWidth={3}
                      fontSize={11}
                      fontWeight="800"
                      textAnchor="middle"
                    >
                      {`${nextDist.toFixed(2)}m${altSuffix}`}
                    </SvgText>
                    <SvgText
                      x={midX}
                      y={midY - 8}
                      fill="#f59e0b"
                      fontSize={11}
                      fontWeight="800"
                      textAnchor="middle"
                    >
                      {`${nextDist.toFixed(2)}m${altSuffix}`}
                    </SvgText>
                  </G>
                );
              }
              return null;
            })()}

            {/* ── Aligned ref labels only (green map dots removed) ── */}
            {visibleShowRefPointLabels &&
              alignedRefPoints?.map((pt, i) => {
                if (activeRefPointLabelIndex !== i) return null;
                const rawSX = pt.dxf_y * viewport.zoom + viewport.panX;
                const rawSY = -pt.dxf_x * viewport.zoom + viewport.panY;
                let sx = rawSX;
                let sy = rawSY;
                if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
                  const rotated = rotatePoint(rawSX, rawSY, layoutSize.width / 2, layoutSize.height / 2, rotation);
                  sx = rotated.x;
                  sy = rotated.y;
                }
                return (
                  <G key={`arp-${i}`}>
                    <SvgText
                      x={sx + 12}
                      y={sy - 10}
                      fontSize={10}
                      fill="#ffffff"
                      stroke="#ffffff"
                      strokeWidth={3}
                      fontWeight="700"
                    >
                      {`${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}`}
                    </SvgText>
                    <SvgText
                      x={sx + 12}
                      y={sy - 10}
                      fontSize={10}
                      fill="#0f172a"
                      fontWeight="700"
                    >
                      {`${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}`}
                    </SvgText>
                  </G>
                );
              })}

            {/* ── Virtual Bounding Box Dimension Labels ── */}
            {virtualBoxLabels.map((lbl) => {
              const rawSX = lbl.midE * viewport.zoom + viewport.panX;
              const rawSY = -lbl.midN * viewport.zoom + viewport.panY;
              let sx = rawSX + lbl.offsetX;
              let sy = rawSY + lbl.offsetY;
              if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
                const rotated = rotatePoint(sx, sy, layoutSize.width / 2, layoutSize.height / 2, rotation);
                sx = rotated.x;
                sy = rotated.y;
              }
              return (
                <G key={lbl.id}>
                  <SvgText
                    x={sx}
                    y={sy}
                    fontSize={11}
                    fill="#ffffff"
                    stroke="#ffffff"
                    strokeWidth={3.5}
                    fontWeight="700"
                    textAnchor={lbl.anchor}
                  >
                    {lbl.text}
                  </SvgText>
                  <SvgText
                    x={sx}
                    y={sy}
                    fontSize={11}
                    fill="#0891b2"
                    fontWeight="700"
                    textAnchor={lbl.anchor}
                  >
                    {lbl.text}
                  </SvgText>
                </G>
              );
            })}

            {/* ── Distance label(s) for the currently highlighted/selected line(s) ── */}
            {selectionLabels.map((lbl) => {
              const rawSX = lbl.midE * viewport.zoom + viewport.panX;
              const rawSY = -lbl.midN * viewport.zoom + viewport.panY;
              let sx = rawSX + lbl.offsetX;
              let sy = rawSY + lbl.offsetY;
              if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
                const rotated = rotatePoint(sx, sy, layoutSize.width / 2, layoutSize.height / 2, rotation);
                sx = rotated.x;
                sy = rotated.y;
              }
              return (
                <G key={`sel-label-${lbl.id}`}>
                  <SvgText
                    x={sx}
                    y={sy}
                    fontSize={11}
                    fill="#ffffff"
                    stroke="#ffffff"
                    strokeWidth={3.5}
                    fontWeight="700"
                    textAnchor={lbl.anchor}
                  >
                    {lbl.text}
                  </SvgText>
                  <SvgText
                    x={sx}
                    y={sy}
                    fontSize={11}
                    fill="#ef4444"
                    fontWeight="700"
                    textAnchor={lbl.anchor}
                  >
                    {lbl.text}
                  </SvgText>
                </G>
              );
            })}

            {/* ── Rover icon (top-down car shape) ── */}
            {hasRover && visibility.rover !== false && layoutSize.width > 0 && (() => {
              const cx = roverScreenX;
              const cy = roverScreenY;
              // Car dimensions in screen pixels
              const carLength = 22;
              const carWidth = 13;
              const noseLength = 7;
              // heading_ned_deg: 0=North(up), 90=East(right), clockwise
              // SVG rotation: 0=up, positive=clockwise, matches NED heading directly.
              // Deliberately NOT combined with the plan view's own `rotation` state:
              // the rover icon must always show the rover's true facing direction and
              // stay static under a map rotate gesture, never spin with the view.
              const headingRot = roverDisplayPose.headingDeg;
              return (
                <G transform={`translate(${cx}, ${cy}) rotate(${headingRot})`}>
                  {/* Glow shadow */}
                  <Circle cx={0} cy={0} r={carLength * 0.85} fill="rgba(14,165,233,0.12)" />
                  {/* Car body */}
                  <Polygon
                    points={`${-carWidth / 2},${carLength / 2} ${carWidth / 2},${carLength / 2} ${carWidth / 2},${-carLength / 2 + noseLength} ${0},${-carLength / 2 - noseLength / 2} ${-carWidth / 2},${-carLength / 2 + noseLength}`}
                    fill="#0ea5e9"
                    stroke="#ffffff"
                    strokeWidth={1.8}
                    strokeLinejoin="round"
                  />
                  {/* Rear wheels */}
                  <Polygon
                    points={`${-carWidth / 2 - 3},${carLength / 2 - 6} ${-carWidth / 2},${carLength / 2 - 6} ${-carWidth / 2},${carLength / 2} ${-carWidth / 2 - 3},${carLength / 2}`}
                    fill="#0f172a"
                  />
                  <Polygon
                    points={`${carWidth / 2 + 3},${carLength / 2 - 6} ${carWidth / 2},${carLength / 2 - 6} ${carWidth / 2},${carLength / 2} ${carWidth / 2 + 3},${carLength / 2}`}
                    fill="#0f172a"
                  />
                  {/* Front wheel (single, centred — 3-wheel rover) */}
                  <Polygon
                    points={`${-2.5},${-carLength / 2 + noseLength} ${2.5},${-carLength / 2 + noseLength} ${2.5},${-carLength / 2 + noseLength - 6} ${-2.5},${-carLength / 2 + noseLength - 6}`}
                    fill="#0f172a"
                  />
                  {/* Windshield */}
                  <Polygon
                    points={`${-carWidth / 2 + 2},${-carLength / 2 + noseLength + 2} ${carWidth / 2 - 2},${-carLength / 2 + noseLength + 2} ${carWidth / 2 - 3},${-carLength / 2 + noseLength + 6} ${-carWidth / 2 + 3},${-carLength / 2 + noseLength + 6}`}
                    fill="rgba(186,230,253,0.85)"
                  />
                  {/* Heading dot (nose tip) */}
                  <Circle cx={0} cy={-carLength / 2 - noseLength / 2} r={2.5} fill="#fbbf24" stroke="#fff" strokeWidth={1} />
                </G>
              );
            })()}

          </Svg>
        )}
      </View>

      {!hideRefocusControls ? (
        <View
          style={{
            position: "absolute",
            bottom: 14,
            right: 14,
            flexDirection: "column",
            gap: 8,
            zIndex: 40,
            elevation: 40,
          }}
        >
          <Pressable
            onPress={handleFocusPlan}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: pressed ? "rgba(15,23,42,0.95)" : "rgba(15,23,42,0.85)",
              borderWidth: 1.2,
              borderColor: "#10b981",
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.25,
              shadowRadius: 3.84,
              elevation: 5,
            })}
          >
            <MapIcon size={24} color="#10b981" />
          </Pressable>

          <Pressable
            onPress={handleFocusRover}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: pressed ? "rgba(15,23,42,0.95)" : "rgba(15,23,42,0.85)",
              borderWidth: 1.2,
              borderColor: "#0ea5e9",
              alignItems: "center",
              justifyContent: "center",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.25,
              shadowRadius: 3.84,
              elevation: 5,
            })}
          >
            <Tractor size={26} color="#0ea5e9" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default PlanPreview;
