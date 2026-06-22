import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutChangeEvent,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Paintbrush,
  FileUp,
  Hand,
  RotateCw,
  RotateCcw,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react-native";
import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from "react-native-svg";

import type { Palette } from "../theme/colors";
import type { ImportedPlan, MarkingStyle, PlanLine, PlanPoint } from "../types/plan";

interface GeometryViewportProps {
  palette: Palette;
  compact: boolean;
  mode?: "home" | "plan";
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  onImportPress: () => void;
  markingStyle: MarkingStyle;
  onSelectMarkingStyle: (style: MarkingStyle) => void;
  rotation: number;
  onRotationChange: (angle: number) => void;
  onDeleteSelectedLine: () => void;
  planNotes: string;
}

const PATH_SEGMENT_CHUNK_SIZE = 650;
const ARROWHEAD_LENGTH_PX = 14;
const ARROWHEAD_HALF_WIDTH_PX = 5;
const RENDERED_PLAN_LAYERS = ["boundary", "marking", "center"] as const;

type RenderedPlanLayer = (typeof RENDERED_PLAN_LAYERS)[number];

interface SvgPoint {
  x: number;
  y: number;
}

function isRenderableLine(line: PlanLine | null | undefined): line is PlanLine {
  return Boolean(
    line &&
      line.from &&
      line.to &&
      Number.isFinite(line.from.x) &&
      Number.isFinite(line.from.y) &&
      Number.isFinite(line.to.x) &&
      Number.isFinite(line.to.y)
  );
}

function buildSvgPathChunks(lines: PlanLine[]) {
  const chunks: string[] = [];
  let current = "";
  let count = 0;

  for (const line of lines) {
    if (!isRenderableLine(line)) continue;
    current += `M${line.from.y} ${line.from.x}L${line.to.y} ${line.to.x}`;
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

function buildArrowheadPoints(from: SvgPoint, to: SvgPoint): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length < 8) return null;

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const ux = dx / length;
  const uy = dy / length;

  const px = -uy;
  const py = ux;

  const tipX = mx + ux * ARROWHEAD_LENGTH_PX * 0.45;
  const tipY = my + uy * ARROWHEAD_LENGTH_PX * 0.45;

  const baseCx = mx - ux * ARROWHEAD_LENGTH_PX * 0.55;
  const baseCy = my - uy * ARROWHEAD_LENGTH_PX * 0.55;

  const b1x = baseCx + px * ARROWHEAD_HALF_WIDTH_PX;
  const b1y = baseCy + py * ARROWHEAD_HALF_WIDTH_PX;
  const b2x = baseCx - px * ARROWHEAD_HALF_WIDTH_PX;
  const b2y = baseCy - py * ARROWHEAD_HALF_WIDTH_PX;

  return `${tipX},${tipY} ${b1x},${b1y} ${b2x},${b2y}`;
}

function rotateSvgPoint(point: SvgPoint, rotation: number, surfaceSize: { width: number; height: number }): SvgPoint {
  const centerX = surfaceSize.width / 2;
  const centerY = surfaceSize.height / 2;
  const radians = (rotation * Math.PI) / 180;
  const dx = point.x - centerX;
  const dy = point.y - centerY;

  return {
    x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function mapPlanPointToSvg(
  point: PlanPoint,
  zoom: number,
  rotation: number,
  offset: { x: number; y: number },
  surfaceSize: { width: number; height: number }
): SvgPoint {
  return rotateSvgPoint(
    {
      x: point.y * zoom + offset.x,
      y: -point.x * zoom + offset.y,
    },
    rotation,
    surfaceSize
  );
}

function isRenderedPlanLayer(layer: PlanLine["layer"]): layer is RenderedPlanLayer {
  return RENDERED_PLAN_LAYERS.includes(layer as RenderedPlanLayer);
}

export function GeometryViewport({
  palette,
  compact,
  importedPlan,
  lines,
  selectedLineId,
  onSelectLine,
  onImportPress,
  markingStyle,
  onSelectMarkingStyle,
  rotation,
  onRotationChange,
  onDeleteSelectedLine,
}: GeometryViewportProps) {
  const [zoom, setZoom] = useState(1);
  const [rotateDragMode, setRotateDragMode] = useState(false);
  const [dragMode, setDragMode] = useState(false);
  const [angleModalVisible, setAngleModalVisible] = useState(false);
  const [markingModalVisible, setMarkingModalVisible] = useState(false);
  const [miniInfoVisible, setMiniInfoVisible] = useState(false);
  const [angleInput, setAngleInput] = useState("0");
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [surfaceSize, setSurfaceSize] = useState({
    width: 0,
    height: 0,
  });
  const rotationRef = useRef(rotation);
  const ignoreTapRef = useRef(false);
  const dragBaseRotation = useRef(rotation);
  const dragBaseOffset = useRef(offset);
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchZoomBaseRef = useRef(1);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchMovedRef = useRef(false);

  /* ── RAF throttle refs (Step 1) ── */
  const rafPendingRef = useRef<Record<string, any>>({});
  const rafIdRef = useRef<number | null>(null);

  const scheduleCommit = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      const pending = rafPendingRef.current;
      if (pending.offset) {
        setOffset(pending.offset);
      }
      if (pending.zoom !== undefined) {
        setZoom(pending.zoom);
      }
      rafPendingRef.current = {};
      rafIdRef.current = null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const safeLines = useMemo(() => lines.filter(isRenderableLine), [lines]);

  /* ── Viewport culling (Step 2) ── */
  const visibleBounds = useMemo(() => {
    if (surfaceSize.width === 0) return null;
    const margin = 0.2;
    const halfW = (surfaceSize.width / zoom) * (1 + margin);
    const halfH = (surfaceSize.height / zoom) * (1 + margin);
    const cx = -offset.x / zoom;
    const cy = offset.y / zoom;
    return { minX: cx - halfW, maxX: cx + halfW, minY: cy - halfH, maxY: cy + halfH };
  }, [offset.x, offset.y, zoom, surfaceSize.width, surfaceSize.height]);

  const culledLines = useMemo(() => {
    if (!visibleBounds) return safeLines;
    return safeLines.filter(line => {
      const midX = (line.from.x + line.to.x) / 2;
      const midY = (line.from.y + line.to.y) / 2;
      return midX >= visibleBounds.minX && midX <= visibleBounds.maxX &&
             midY >= visibleBounds.minY && midY <= visibleBounds.maxY;
    });
  }, [safeLines, visibleBounds]);

  useEffect(() => {
    rotationRef.current = rotation;
  }, [rotation]);

  useEffect(() => {
    dragBaseOffset.current = offset;
  }, [offset]);

  useEffect(() => {
    if (!importedPlan || surfaceSize.width <= 0 || surfaceSize.height <= 0 || safeLines.length === 0) {
      if (!importedPlan) {
        setZoom(1);
        setRotateDragMode(false);
        setDragMode(false);
        setOffset({ x: 0, y: 0 });
      }
      return;
    }

    // Auto-fit logic for absolute metric coordinates
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const line of safeLines) {
      minX = Math.min(minX, line.from.x, line.to.x);
      minY = Math.min(minY, line.from.y, line.to.y);
      maxX = Math.max(maxX, line.from.x, line.to.x);
      maxY = Math.max(maxY, line.from.y, line.to.y);
    }

    const bboxW = maxX - minX;
    const bboxH = maxY - minY;

    if (bboxW <= 0.0001 && bboxH <= 0.0001) {
      setOffset({ x: surfaceSize.width / 2 - minX, y: surfaceSize.height / 2 + minY });
      setZoom(1);
      return;
    }

    const paddingFactor = 0.82;
    const scaleX = (surfaceSize.width * paddingFactor) / bboxW;
    const scaleY = (surfaceSize.height * paddingFactor) / bboxH;
    const newZoom = Math.min(scaleX, scaleY);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    setZoom(newZoom);
    setOffset({
      x: surfaceSize.width / 2 - centerX * newZoom,
      y: surfaceSize.height / 2 + centerY * newZoom,
    });
  }, [importedPlan, surfaceSize, safeLines]);

  const selectedLine = useMemo(
    () => safeLines.find((line) => line.id === selectedLineId) ?? null,
    [safeLines, selectedLineId]
  );

  /* ── Path chunks via ref + async effect (Step 2) ── */
  const pathChunksRef = useRef<Record<string, string[]>>({ boundary: [], marking: [], center: [] });
  const [pathVersion, setPathVersion] = useState(0);
  useEffect(() => {
    pathChunksRef.current = {
      boundary: buildSvgPathChunks(culledLines.filter(line => line.layer === "boundary")),
      marking:  buildSvgPathChunks(culledLines.filter(line => line.layer === "marking")),
      center:   buildSvgPathChunks(culledLines.filter(line => line.layer === "center")),
    };
    setPathVersion(v => v + 1);
  }, [culledLines]);

  const arrowheadsByLayer = useMemo(
    () => {
      const result: Record<RenderedPlanLayer, string[]> = { boundary: [], marking: [], center: [] };

      for (const line of safeLines) {
        if (line.id === selectedLineId) continue;
        if (!isRenderedPlanLayer(line.layer)) continue;
        const pts = buildArrowheadPoints(
          mapPlanPointToSvg(line.from, zoom, rotation, offset, surfaceSize),
          mapPlanPointToSvg(line.to, zoom, rotation, offset, surfaceSize)
        );
        if (pts) result[line.layer].push(pts);
      }

      return result;
    },
    [offset, rotation, safeLines, selectedLineId, surfaceSize, zoom]
  );

  const planTransform = useMemo(
    () =>
      `translate(${surfaceSize.width / 2} ${surfaceSize.height / 2}) rotate(${rotation}) translate(${-surfaceSize.width / 2} ${-surfaceSize.height / 2}) translate(${offset.x} ${offset.y}) scale(${zoom} ${-zoom})`,
    [offset.x, offset.y, rotation, zoom, surfaceSize]
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => dragMode || rotateDragMode,
        onMoveShouldSetPanResponder: (_, gesture) => {
          if (!(rotateDragMode || dragMode)) {
            return false;
          }

          return (
            Math.abs(gesture.dx) > 6 ||
            Math.abs(gesture.dy) > 6 ||
            gesture.numberActiveTouches > 1
          );
        },
        onPanResponderGrant: (_, gesture) => {
          dragBaseRotation.current = rotationRef.current;
          dragBaseOffset.current = offset;
        },
        onPanResponderMove: (_, gesture) => {
          if (rotateDragMode) {
            const nextAngle =
              (dragBaseRotation.current + gesture.dx * 0.6 + 3600) % 360;
            onRotationChange(nextAngle);
            return;
          }

          if (dragMode) {
            rafPendingRef.current.offset = {
              x: dragBaseOffset.current.x + gesture.dx,
              y: dragBaseOffset.current.y + gesture.dy,
            };
            scheduleCommit();
          }
        },
        onPanResponderRelease: (_, gesture) => {
          if (rotateDragMode) {
            setRotateDragMode(false);
          }
        },
        onPanResponderTerminate: () => {
          if (rotateDragMode) {
            setRotateDragMode(false);
          }
        },
      }),
    [dragMode, offset, onRotationChange, rotateDragMode]
  );

  const applyAngle = () => {
    const next = Number(angleInput);

    if (Number.isNaN(next)) {
      return;
    }

    onRotationChange(((next % 360) + 360) % 360);
    setAngleModalVisible(false);
  };

  const handleTouchStart = (event: any) => {
    const touches = event.nativeEvent.touches;
    touchMovedRef.current = false;

    if (touches.length === 1) {
      touchStartRef.current = {
        x: touches[0].locationX,
        y: touches[0].locationY,
      };
    }

    if (!dragMode) {
      return;
    }

    if (touches.length === 2) {
      const [a, b] = touches;
      pinchDistanceRef.current = Math.hypot(
        a.pageX - b.pageX,
        a.pageY - b.pageY
      );
      pinchZoomBaseRef.current = zoom;
    }
  };

  const handleTouchMove = (event: any) => {
    const touches = event.nativeEvent.touches;

    if (touches.length === 1 && touchStartRef.current) {
      const dx = touches[0].locationX - touchStartRef.current.x;
      const dy = touches[0].locationY - touchStartRef.current.y;

      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        touchMovedRef.current = true;
      }
    } else if (touches.length > 1) {
      touchMovedRef.current = true;
    }

    if (!dragMode) {
      return;
    }

    if (touches.length === 2 && pinchDistanceRef.current) {
      const [a, b] = touches;
      const nextDistance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
      const scale = nextDistance / pinchDistanceRef.current;
      const nextZoom = Math.max(0.6, Math.min(2.6, pinchZoomBaseRef.current * scale));
      rafPendingRef.current.zoom = nextZoom;
      scheduleCommit();
    }
  };

  const handleTouchEnd = (event: any) => {
    if (
      !dragMode &&
      !rotateDragMode &&
      !touchMovedRef.current &&
      touchStartRef.current
    ) {
      const touch =
        event.nativeEvent.changedTouches?.[0] ?? event.nativeEvent;
      const locationX = touch.locationX ?? touchStartRef.current.x;
      const locationY = touch.locationY ?? touchStartRef.current.y;
      handleCanvasTapFromLocalPoint(locationX, locationY);
    }

    pinchDistanceRef.current = null;
    touchStartRef.current = null;
    touchMovedRef.current = false;
  };

  const handleSurfaceLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSurfaceSize({ width, height });
  };

  const handleCanvasTapFromLocalPoint = (locationX: number, locationY: number) => {
    if (
      dragMode ||
      rotateDragMode ||
      safeLines.length === 0 ||
      !surfaceSize.width ||
      !surfaceSize.height
    ) {
      return;
    }

    const viewportPoint = mapLocalPointToCanvas(
      locationX,
      locationY,
      surfaceSize.width,
      surfaceSize.height
    );

    if (!viewportPoint) {
      return;
    }

    const planPoint = invertCanvasTransform(
      viewportPoint.x,
      viewportPoint.y,
      zoom,
      rotation,
      offset,
      surfaceSize
    );
    const nearest = findNearestLine(planPoint.x, planPoint.y, safeLines);
    const hitThreshold = Math.max(0.8, 18 / (viewportPoint.scale * zoom));

    if (nearest && nearest.distance <= hitThreshold) {
      onSelectLine(nearest.line.id);
      return;
    }

    onSelectLine(null);
  };

  return (
    <View
      className="flex-1"
      style={{
        backgroundColor: palette.background,
        borderLeftWidth: compact ? 0 : 1,
        borderTopWidth: compact ? 1 : 0,
        borderColor: palette.border,
      }}
    >
      <View className="flex-1 p-4">
        <View
          className="w-full flex-1 overflow-hidden border"
          style={{
            borderColor: palette.border,
            backgroundColor: palette.panel,
            minHeight: compact ? 320 : undefined,
            borderRadius: 0,
          }}
        >
          {importedPlan ? (
            <>
              <View
                style={styles.canvasGestureSurface}
                onLayout={handleSurfaceLayout}
                {...panResponder.panHandlers}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                <Svg
                  width="100%"
                  height="100%"
                  preserveAspectRatio="xMidYMid meet"
                >
                  <G transform={planTransform}>
                    {RENDERED_PLAN_LAYERS.flatMap((layer) =>
                      pathChunksByLayer[layer].map((d, index) => (
                        <Path
                          key={`${layer}-${index}`}
                          d={d}
                          stroke={
                            layer === "center"
                              ? palette.amber
                              : layer === "boundary"
                                ? palette.foreground
                                : palette.mutedForeground
                          }
                          strokeWidth={0.45 / zoom}
                          strokeDasharray={dashPattern(markingStyle)}
                          strokeLinecap="round"
                          fill="none"
                        />
                      ))
                    )}
                    {selectedLine ? (
                      <>
                        <Line
                          x1={selectedLine.from.y}
                          y1={selectedLine.from.x}
                          x2={selectedLine.to.y}
                          y2={selectedLine.to.x}
                          stroke={palette.emerald}
                          strokeWidth={0.85 / zoom}
                          strokeDasharray={dashPattern(markingStyle)}
                          strokeLinecap="round"
                        />
                        <Circle
                          cx={selectedLine.from.y}
                          cy={selectedLine.from.x}
                          r={1.2 / zoom}
                          fill={palette.emerald}
                        />
                        <Circle
                          cx={selectedLine.to.y}
                          cy={selectedLine.to.x}
                          r={1.2 / zoom}
                          fill={palette.emerald}
                        />
                      </>
                    ) : null}
                  </G>
                  {RENDERED_PLAN_LAYERS.flatMap((layer) =>
                    arrowheadsByLayer[layer].map((pts, index) => (
                      <Polygon
                        key={`arrow-${layer}-${index}`}
                        points={pts}
                        fill={
                          layer === "center"
                            ? palette.amber
                            : layer === "boundary"
                              ? palette.foreground
                              : palette.mutedForeground
                        }
                        stroke="none"
                      />
                    ))
                  )}
                  {selectedLine ? (() => {
                    const pts = buildArrowheadPoints(
                      mapPlanPointToSvg(selectedLine.from, zoom, rotation, offset, surfaceSize),
                      mapPlanPointToSvg(selectedLine.to, zoom, rotation, offset, surfaceSize)
                    );
                    return pts ? (
                      <Polygon points={pts} fill={palette.emerald} stroke="none" />
                    ) : null;
                  })() : null}
                </Svg>
              </View>

              {/* Floating Compass Overlay */}
              <View
                style={{
                  position: "absolute",
                  top: 14,
                  right: 14,
                  width: 54,
                  height: 54,
                  zIndex: 40,
                  elevation: 40,
                  backgroundColor: "transparent",
                }}
              >
                <Svg width={54} height={54} viewBox="0 0 54 54">
                  {/* Outer circle */}
                  <Circle cx={27} cy={27} r={24} fill="rgba(15,23,42,0.85)" stroke={palette.border} strokeWidth={1.5} />
                  
                  {/* Cardinal labels */}
                  <SvgText x={27} y={12} fontSize={8} fill="#ef4444" fontWeight="900" textAnchor="middle">N</SvgText>
                  <SvgText x={27} y={48} fontSize={7} fill={palette.mutedForeground} fontWeight="700" textAnchor="middle">S</SvgText>
                  <SvgText x={47} y={30} fontSize={7} fill={palette.mutedForeground} fontWeight="700" textAnchor="middle">E</SvgText>
                  <SvgText x={7} y={30} fontSize={7} fill={palette.mutedForeground} fontWeight="700" textAnchor="middle">W</SvgText>
                  
                  {/* Rotating needle */}
                  <G transform={`rotate(${rotation} 27 27)`}>
                    {/* North Pointer */}
                    <Polygon points="27,15 31,27 23,27" fill="#ef4444" />
                    {/* South Pointer */}
                    <Polygon points="27,39 31,27 23,27" fill="#cbd5e1" />
                    {/* Center pin */}
                    <Circle cx={27} cy={27} r={2.5} fill="#0f172a" stroke="#fff" strokeWidth={1} />
                  </G>
                </Svg>
              </View>

              <View
                className="absolute left-6 right-6 top-6 flex-row items-start justify-between rounded-2xl px-4 py-4"
                style={{ backgroundColor: palette.background, gap: 16 }}
              >
                <View
                  className="flex-1"
                  style={{ maxWidth: 200 }}
                >
                  <Text
                    className="text-xs font-semibold uppercase"
                    style={{ color: palette.mutedForeground, letterSpacing: 0.5 }}
                  >
                    File Summary
                  </Text>
                  <Text
                    className="mt-1 text-base font-semibold"
                    style={{ color: palette.foreground }}
                  >
                    {importedPlan.fileName}
                  </Text>
                  <Text className="mt-1 text-xs" style={{ color: palette.mutedForeground }}>
                    {safeLines.length} points imported
                  </Text>
                </View>
                <View className="items-end" style={{ gap: 10 }}>
                  <View
                    className="flex-1"
                    style={{ maxWidth: 200, alignItems: "flex-end" }}
                  >
                    <Text
                      className="text-xs font-semibold uppercase"
                      style={{ color: palette.mutedForeground, letterSpacing: 0.5 }}
                    >
                      Map Home
                    </Text>
                    <Text
                      className="mt-1 text-base font-semibold text-right"
                      style={{ color: palette.foreground }}
                    >
                      {importedPlan.fileName}
                    </Text>
                    <Text className="mt-1 text-xs text-right" style={{ color: palette.mutedForeground }}>
                      {selectedLine
                        ? "Selected details are in Plan Info."
                        : "Tap a line to see its details."}
                    </Text>
                  </View>
                </View>

                <View className="items-end">
                  <Text
                    className="text-xs font-semibold uppercase"
                    style={{ color: palette.mutedForeground, letterSpacing: 0.5 }}
                  >
                    Selected Line
                  </Text>
                  <Text
                    className="mt-1 text-sm font-semibold"
                    style={{ color: palette.foreground }}
                  >
                    {selectedLine
                      ? `${selectedLine.from.id} to ${selectedLine.to.id}`
                      : "Tap any line"}
                  </Text>
                  {selectedLine ? (
                    <Pressable
                      onPress={() => setMiniInfoVisible(true)}
                      className="mt-3 rounded-xl px-4 py-3"
                      style={{ backgroundColor: palette.muted }}
                    >
                      <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                        Open mini info tab
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {selectedLine ? (
                <Pressable
                  onPress={onDeleteSelectedLine}
                  className="absolute bottom-6 right-6 h-12 w-12 items-center justify-center rounded-2xl"
                  style={{
                    backgroundColor: palette.crimson,
                    zIndex: 20,
                    elevation: 20,
                  }}
                >
                  <Trash2 size={18} color="#FFFFFF" />
                </Pressable>
              ) : null}

            </>
          ) : (
            <View className="flex-1 items-center justify-center px-8" style={{ gap: 16 }}>
              <View
                className="items-center justify-center rounded-full"
                style={{
                  width: 72,
                  height: 72,
                  backgroundColor: palette.muted,
                }}
              >
                <Search size={28} color={palette.mutedForeground} />
              </View>
              <Text className="text-xl font-semibold" style={{ color: palette.foreground }}>
                Import a plan to view it here
              </Text>
              <Text
                className="text-center text-sm"
                style={{ color: palette.mutedForeground, maxWidth: 360 }}
              >
                Upload a DXF or CSV file to preview the plan, inspect lines, and
                start the mission flow.
              </Text>
              <Pressable
                onPress={onImportPress}
                className="h-14 flex-row items-center justify-center rounded-md px-5"
                style={{ backgroundColor: palette.foreground, gap: 8 }}
              >
                <FileUp size={18} color={palette.background} />
                <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                  Import File
                </Text>
              </Pressable>
              <Text className="text-xs" style={{ color: palette.mutedForeground }}>
                Only CSV and DXF supported.
              </Text>
            </View>
          )}
        </View>
      </View>

      <View
        className="border-t px-4 py-3"
        style={{
          borderTopColor: palette.border,
          backgroundColor: palette.panel,
        }}
      >
        <View
          className="rounded-2xl px-4 py-4"
          style={{ backgroundColor: palette.background }}
        >
          <View className="flex-row items-center justify-between" style={{ gap: 14 }}>
            <View className="flex-row items-center" style={{ gap: 12 }}>
              <LabeledToolButton
                icon={<ZoomOut size={24} color={palette.foreground} />}
                label="Zoom -"
                palette={palette}
                onPress={() => setZoom((current) => Math.max(0.6, current - 0.15))}
              />
              <LabeledToolButton
                icon={<ZoomIn size={24} color={palette.foreground} />}
                label="Zoom +"
                palette={palette}
                onPress={() => setZoom((current) => Math.min(2.6, current + 0.15))}
              />
              <LabeledToolButton
                icon={<RotateCcw size={24} color={palette.foreground} />}
                label="Rot CCW"
                palette={palette}
                onPress={() => onRotationChange(((rotation - 15) % 360 + 360) % 360)}
              />
              <LabeledToolButton
                icon={<RotateCw size={24} color={palette.foreground} />}
                label="Rot CW"
                palette={palette}
                onPress={() => onRotationChange(((rotation + 15) % 360 + 360) % 360)}
              />
              <Pressable
                onPress={() => {
                  setRotateDragMode(false);
                  setDragMode((current) => !current);
                }}
                className="items-center"
              >
                <View
                  className="h-14 w-[78px] items-center justify-center rounded-2xl"
                  style={{
                    backgroundColor: dragMode ? palette.emerald : palette.muted,
                  }}
                >
                  <Hand
                    size={24}
                    color={dragMode ? "#FFFFFF" : palette.foreground}
                  />
                </View>
                <Text
                  className="mt-2 text-xs font-semibold"
                  style={{ color: palette.foreground }}
                >
                  Move
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (ignoreTapRef.current) {
                    ignoreTapRef.current = false;
                    return;
                  }

                  setAngleInput(rotation.toFixed(0));
                  setAngleModalVisible(true);
                }}
                onLongPress={() => {
                  ignoreTapRef.current = true;
                  setDragMode(false);
                  setRotateDragMode(true);
                }}
                delayLongPress={260}
                className="items-center"
              >
                <View
                  className="h-14 w-[78px] items-center justify-center rounded-2xl"
                  style={{
                    backgroundColor: rotateDragMode ? palette.emerald : palette.muted,
                  }}
                >
                  <RotateCw
                    size={24}
                    color={rotateDragMode ? "#FFFFFF" : palette.foreground}
                  />
                </View>
                <Text
                  className="mt-2 text-xs font-semibold"
                  style={{ color: palette.foreground }}
                >
                  Rotate
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMarkingModalVisible(true)}
                className="items-center"
              >
                <View
                  className="h-14 w-[78px] items-center justify-center rounded-2xl"
                  style={{ backgroundColor: palette.muted }}
                >
                  <Paintbrush size={24} color={palette.foreground} />
                </View>
                <Text className="mt-2 text-xs font-semibold" style={{ color: palette.foreground }}>
                  Style
                </Text>
              </Pressable>
            </View>

            <View className="flex-1 items-end">
              <View className="flex-row flex-wrap justify-end" style={{ gap: 12 }}>
                <MetaBadge label={`${(zoom * 100).toFixed(0)}%`} palette={palette} />
                <MetaBadge label={`${rotation.toFixed(0)} deg`} palette={palette} />
                <MetaBadge
                  label={dragMode ? "Drag on" : "Drag off"}
                  palette={palette}
                />
                <MetaBadge
                  label={rotateDragMode ? "Rotate on" : "Rotate off"}
                  palette={palette}
                />
                <MetaBadge
                  label={
                    selectedLine
                      ? `${selectedLine.from.id}-${selectedLine.to.id}`
                      : "No line"
                  }
                  palette={palette}
                />
              </View>
            </View>
          </View>
        </View>
      </View>

      <Modal
        visible={angleModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAngleModalVisible(false)}
      >
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <View
            className="w-full max-w-[340px] rounded-xl border p-5"
            style={{
              borderColor: palette.border,
              backgroundColor: palette.panel,
              gap: 14,
            }}
          >
            <Text className="text-lg font-semibold" style={{ color: palette.foreground }}>
              Rotate Plan
            </Text>
            <Text className="text-sm" style={{ color: palette.mutedForeground }}>
              Enter the angle in degrees.
            </Text>
            <TextInput
              value={angleInput}
              onChangeText={setAngleInput}
              keyboardType="numeric"
              className="rounded-md border px-4 py-3 text-sm font-semibold"
              style={{
                color: palette.foreground,
                borderColor: palette.border,
                backgroundColor: palette.background,
              }}
            />
            <View className="flex-row" style={{ gap: 10 }}>
              <Pressable
                onPress={() => setAngleModalVisible(false)}
                className="flex-1 items-center justify-center rounded-md px-4 py-3"
                style={{ backgroundColor: palette.muted }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={applyAngle}
                className="flex-1 items-center justify-center rounded-md px-4 py-3"
                style={{ backgroundColor: palette.foreground }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                  Apply
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={miniInfoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMiniInfoVisible(false)}
      >
        <View
          className="flex-1 items-end justify-start px-6 pt-28"
          style={{ backgroundColor: "rgba(0,0,0,0.28)" }}
        >
          <View
            className="rounded-2xl border p-5"
            style={{
              width: 320,
              borderColor: palette.border,
              backgroundColor: palette.panel,
              gap: 10,
            }}
          >
            <Text className="text-lg font-semibold" style={{ color: palette.foreground }}>
              Mini Line Info
            </Text>
            {selectedLine ? (
              <>
                <MiniInfoRow label="Line" value={selectedLine.label} palette={palette} />
                <MiniInfoRow label="Layer" value={selectedLine.layer} palette={palette} />
                <MiniInfoRow
                  label="Length"
                  value={`${lineLength(selectedLine).toFixed(2)} m`}
                  palette={palette}
                />
                <MiniInfoRow
                  label="Width"
                  value={`${selectedLine.width.toFixed(2)} m`}
                  palette={palette}
                />
                <MiniInfoRow
                  label="Angle"
                  value={`${lineAngle(selectedLine).toFixed(1)} deg`}
                  palette={palette}
                />
              </>
            ) : (
              <Text className="text-sm" style={{ color: palette.mutedForeground }}>
                Select a line first.
              </Text>
            )}

            <Pressable
              onPress={() => setMiniInfoVisible(false)}
              className="mt-2 items-center justify-center rounded-xl px-4 py-3"
              style={{ backgroundColor: palette.muted }}
            >
              <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                Close
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={markingModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMarkingModalVisible(false)}
      >
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
        >
          <View
            className="w-full max-w-[340px] rounded-xl border p-5"
            style={{
              borderColor: palette.border,
              backgroundColor: palette.panel,
              gap: 14,
            }}
          >
            <Text className="text-lg font-semibold" style={{ color: palette.foreground }}>
              Marking Style
            </Text>
            <Text className="text-sm" style={{ color: palette.mutedForeground }}>
              Choose how the field lines should be painted.
            </Text>

            <MarkingOption
              label="Straight Line"
              active={markingStyle === "straight"}
              palette={palette}
              onPress={() => onSelectMarkingStyle("straight")}
            />
            <MarkingOption
              label="Dotted Line"
              active={markingStyle === "dotted"}
              palette={palette}
              onPress={() => onSelectMarkingStyle("dotted")}
            />
            <MarkingOption
              label="Dashed Line"
              active={markingStyle === "dashed"}
              palette={palette}
              onPress={() => onSelectMarkingStyle("dashed")}
            />

            <View className="flex-row" style={{ gap: 10 }}>
              <Pressable
                onPress={() => setMarkingModalVisible(false)}
                className="flex-1 items-center justify-center rounded-md px-4 py-3"
                style={{ backgroundColor: palette.muted }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.foreground }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setMarkingModalVisible(false)}
                className="flex-1 items-center justify-center rounded-md px-4 py-3"
                style={{ backgroundColor: palette.foreground }}
              >
                <Text className="text-sm font-semibold" style={{ color: palette.background }}>
                  Save
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function LabeledToolButton({
  icon,
  label,
  palette,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      className="items-center"
    >
      <View
        className="h-14 w-[78px] items-center justify-center rounded-2xl"
        style={{ backgroundColor: palette.muted }}
      >
        {icon}
      </View>
      <Text className="mt-2 text-xs font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

function MarkingOption({
  label,
  active,
  palette,
  onPress,
}: {
  label: string;
  active: boolean;
  palette: Palette;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-xl border px-4 py-4"
      style={{
        borderColor: active ? palette.emerald : palette.border,
        backgroundColor: active ? palette.muted : palette.background,
      }}
    >
      <Text className="text-base font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

function MetaBadge({
  label,
  palette,
}: {
  label: string;
  palette: Palette;
}) {
  return (
    <View
      className="rounded-xl px-4 py-3"
      style={{ backgroundColor: palette.background }}
    >
      <Text className="text-xs font-semibold" style={{ color: palette.foreground }}>
        {label}
      </Text>
    </View>
  );
}

function MiniInfoRow({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: Palette;
}) {
  return (
    <View
      className="flex-row items-center justify-between rounded-xl px-4 py-3"
      style={{ backgroundColor: palette.background }}
    >
      <Text className="text-sm font-semibold" style={{ color: palette.mutedForeground }}>
        {label}
      </Text>
      <Text className="ml-4 flex-1 text-right text-sm font-semibold" style={{ color: palette.foreground }}>
        {value}
      </Text>
    </View>
  );
}

function dashPattern(style: MarkingStyle) {
  if (style === "dotted") {
    return "0.3 1.3";
  }

  if (style === "dashed") {
    return "2.2 1.5";
  }

  return undefined;
}

function formatMarkingStyle(style: MarkingStyle) {
  if (style === "dotted") {
    return "Dotted Line";
  }

  if (style === "dashed") {
    return "Dashed Line";
  }

  return "Straight Line";
}

function lineLength(line: PlanLine) {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function lineAngle(line: PlanLine) {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

const styles = StyleSheet.create({
  canvasGestureSurface: {
    flex: 1,
    padding: 20,
  },
});

function mapLocalPointToCanvas(
  locationX: number,
  locationY: number,
  width: number,
  height: number
) {
  if (!width || !height) {
    return null;
  }

  // With no viewBox, Svg coordinates match container pixels.
  // We account for the padding: 20 in styles.canvasGestureSurface.
  return { x: locationX, y: locationY, scale: 1 };
}

function invertCanvasTransform(
  x: number,
  y: number,
  zoom: number,
  rotation: number,
  offset: { x: number; y: number },
  surfaceSize: { width: number; height: number }
) {
  const centerX = surfaceSize.width / 2;
  const centerY = surfaceSize.height / 2;
  const radians = (-rotation * Math.PI) / 180;

  // 1. Undo rotation around screen center
  const dx = x - centerX;
  const dy = y - centerY;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);

  // 2. Undo translation and scaling (remembering Y is inverted)
  // Forward: ScreenX = World_East * zoom + offset.x
  // Forward: ScreenY = -World_North * zoom + offset.y
  // So:
  // World_East (Y) = (ScreenX - offset.x) / zoom
  // World_North (X) = -(ScreenY - offset.y) / zoom
  
  const screenX_unrotated = rotatedX + centerX;
  const screenY_unrotated = rotatedY + centerY;

  return {
    x: -(screenY_unrotated - offset.y) / zoom, // World North
    y: (screenX_unrotated - offset.x) / zoom,  // World East
  };
}

function findNearestLine(x: number, y: number, lines: PlanLine[]) {
  let best: { line: PlanLine; distance: number } | null = null;

  for (const line of lines) {
    const distance = pointToSegmentDistance(
      x,
      y,
      line.from.x,
      line.from.y,
      line.to.x,
      line.to.y
    );

    if (!best || distance < best.distance) {
      best = { line, distance };
    }
  }

  return best;
}

function pointToSegmentDistance(
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

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))
  );
  const projectionX = x1 + t * dx;
  const projectionY = y1 + t * dy;

  return Math.hypot(px - projectionX, py - projectionY);
}
