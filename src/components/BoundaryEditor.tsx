import React, { useState, useMemo, useRef, useEffect, useCallback, memo } from "react";
import { View, Text, Pressable, PanResponder, Switch, LayoutChangeEvent } from "react-native";
import Svg, { Path, G, Line, Rect, Circle, Polygon, Polyline, Text as SvgText } from "react-native-svg";
import type { PlanLine } from "../types/plan";
import { screenToDesignMeters, designToSvg, simplifyPath } from "../utils/designTransform";
import type { DesignVertex, DesignEntity } from "../types/designDocument";
import { createDesignEntity } from "../types/designDocument";
import { snapToGrid, findSnapCandidate } from "../utils/designSnap";

export interface PlacedItem {
  id: string;
  lines: PlanLine[];
  x: number;
  y: number;
  rotation: number;
  scale: number;
  groupId?: string;
  width: number;
  height: number;
}

export interface BoundaryEditorProps {
  boundaryWidth: number;
  boundaryHeight: number;
  indentSpacing: number;
  letterSpacing: number;
  items: PlacedItem[];
  setItems: React.Dispatch<React.SetStateAction<PlacedItem[]>>;
  selectedItemIds: string[];
  setSelectedItemIds: (ids: string[]) => void;
  multiTouchMode: "both" | "scale" | "rotate";
  sketchMode?: boolean;
  boundaryPosition?: { x: number; y: number };
  onMoveBoundary?: (x: number, y: number) => void;
  showBoundaryPoints?: boolean;
  activeSnapPointId?: string | null;
  onPlaceRoverAtPoint?: (pointId: string, localX: number, localY: number) => void;
  activeTool?: "SELECT" | "LINE" | "FREEHAND";
  onAddEntity?: (entity: DesignEntity) => void;
  worldLines?: PlanLine[];
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export const BoundaryEditor = memo(function BoundaryEditor({
  boundaryWidth,
  boundaryHeight,
  indentSpacing,
  letterSpacing,
  items,
  setItems,
  selectedItemIds,
  setSelectedItemIds,
  multiTouchMode,
  sketchMode = false,
  boundaryPosition,
  onMoveBoundary,
  showBoundaryPoints,
  activeSnapPointId,
  onPlaceRoverAtPoint,
  activeTool = "SELECT",
  onAddEntity,
  worldLines = [],
  onDragStart,
  onDragEnd,
}: BoundaryEditorProps) {
  const METER_TO_PX = 100;

  const bpX = boundaryPosition?.x || 0;
  const bpY = boundaryPosition?.y || 0;
  const cx = bpX * METER_TO_PX;
  const cy = -bpY * METER_TO_PX;
  const halfW = boundaryWidth * METER_TO_PX / 2;
  const halfH = boundaryHeight * METER_TO_PX / 2;

  const controlPoints = useMemo(() => [
    { id: "corner-tl", svgX: cx - halfW, svgY: cy - halfH },
    { id: "corner-tr", svgX: cx + halfW, svgY: cy - halfH },
    { id: "corner-br", svgX: cx + halfW, svgY: cy + halfH },
    { id: "corner-bl", svgX: cx - halfW, svgY: cy + halfH },
    { id: "midpoint-t",  svgX: cx,        svgY: cy - halfH },
    { id: "midpoint-r",  svgX: cx + halfW, svgY: cy },
    { id: "midpoint-b",  svgX: cx,        svgY: cy + halfH },
    { id: "midpoint-l",  svgX: cx - halfW, svgY: cy },
  ], [cx, cy, halfW, halfH]);


  const [svgSize, setSvgSize] = useState({ width: 400, height: 400 }); // fallback for initial taps
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const [pointerCoords, setPointerCoords] = useState<DesignVertex | null>(null);
  const [freehandPoints, setFreehandPoints] = useState<DesignVertex[]>([]);
  const drawingFreehandVertices = useRef<DesignVertex[]>([]);

  const gridGeom = useMemo(() => {
    const minorPath: string[] = [];
    const majorPath: string[] = [];
    
    const minE = bpX - boundaryWidth / 2;
    const maxE = bpX + boundaryWidth / 2;
    const minN = bpY - boundaryHeight / 2;
    const maxN = bpY + boundaryHeight / 2;
    
    const minYSvg = -maxN * METER_TO_PX;
    const maxYSvg = -minN * METER_TO_PX;
    const minXSvg = minE * METER_TO_PX;
    const maxXSvg = maxE * METER_TO_PX;
    
    const step = 0.1;
    const startE = Math.ceil(minE * 10) / 10;
    const startN = Math.ceil(minN * 10) / 10;
    
    for (let e = startE; e <= maxE; e += step) {
      const isMajor = Math.abs(e - Math.round(e)) < 0.01;
      const x = e * METER_TO_PX;
      const isAxis = Math.abs(e) < 0.01;
      if (isAxis) continue;
      
      const pathStr = `M${x} ${minYSvg}L${x} ${maxYSvg}`;
      if (isMajor) {
        majorPath.push(pathStr);
      } else {
        minorPath.push(pathStr);
      }
    }
    
    for (let n = startN; n <= maxN; n += step) {
      const isMajor = Math.abs(n - Math.round(n)) < 0.01;
      const y = -n * METER_TO_PX;
      const isAxis = Math.abs(n) < 0.01;
      if (isAxis) continue;
      
      const pathStr = `M${minXSvg} ${y}L${maxXSvg} ${y}`;
      if (isMajor) {
        majorPath.push(pathStr);
      } else {
        minorPath.push(pathStr);
      }
    }
    
    const showVerticalAxis = minE <= 0 && maxE >= 0;
    const showHorizontalAxis = minN <= 0 && maxN >= 0;
    
    return {
      minorD: minorPath.join(''),
      majorD: majorPath.join(''),
      minXSvg,
      maxXSvg,
      minYSvg,
      maxYSvg,
      showVerticalAxis,
      showHorizontalAxis,
    };
  }, [bpX, bpY, boundaryWidth, boundaryHeight]);

  const dragHandleCx = cx - halfW - 14 / camera.zoom;
  const dragHandleCy = cy - halfH - 14 / camera.zoom;
  const dragHandleR = 14 / camera.zoom;
  const dragHandleArm = 6 / camera.zoom;
  const dragHandleArrow = 3.5 / camera.zoom;

  const [lockPanDrag, setLockPanDrag] = useState(false);
  const [lockZoom, setLockZoom] = useState(false);

  const lockPanDragRef = useRef(lockPanDrag);
  useEffect(() => { lockPanDragRef.current = lockPanDrag; }, [lockPanDrag]);

  const lockZoomRef = useRef(lockZoom);
  useEffect(() => { lockZoomRef.current = lockZoom; }, [lockZoom]);

  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const selectedItemIdsRef = useRef(selectedItemIds);
  useEffect(() => { selectedItemIdsRef.current = selectedItemIds; }, [selectedItemIds]);

  const boundaryWidthRef = useRef(boundaryWidth);
  useEffect(() => { boundaryWidthRef.current = boundaryWidth; }, [boundaryWidth]);

  const boundaryHeightRef = useRef(boundaryHeight);
  useEffect(() => { boundaryHeightRef.current = boundaryHeight; }, [boundaryHeight]);

  const indentSpacingRef = useRef(indentSpacing);
  useEffect(() => { indentSpacingRef.current = indentSpacing; }, [indentSpacing]);

  const letterSpacingRef = useRef(letterSpacing);
  useEffect(() => { letterSpacingRef.current = letterSpacing; }, [letterSpacing]);

  const cameraRef = useRef(camera);
  useEffect(() => { cameraRef.current = camera; }, [camera]);
  
  const multiTouchModeRef = useRef(multiTouchMode);
  useEffect(() => { multiTouchModeRef.current = multiTouchMode; }, [multiTouchMode]);
  useEffect(() => { letterSpacingRef.current = letterSpacing; }, [letterSpacing]);

  const setItemsRef = useRef(setItems);
  useEffect(() => { setItemsRef.current = setItems; }, [setItems]);

  const setSelectedItemIdsRef = useRef(setSelectedItemIds);
  useEffect(() => { setSelectedItemIdsRef.current = setSelectedItemIds; }, [setSelectedItemIds]);

  const svgSizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => { svgSizeRef.current = svgSize; }, [svgSize]);

  const boundaryPositionRef = useRef(boundaryPosition);
  useEffect(() => { boundaryPositionRef.current = boundaryPosition; }, [boundaryPosition]);

  const showBoundaryPointsRef = useRef(showBoundaryPoints);
  useEffect(() => { showBoundaryPointsRef.current = showBoundaryPoints; }, [showBoundaryPoints]);

  const controlPointsRef = useRef(controlPoints);
  useEffect(() => { controlPointsRef.current = controlPoints; }, [controlPoints]);

  const onMoveBoundaryRef = useRef(onMoveBoundary);
  useEffect(() => { onMoveBoundaryRef.current = onMoveBoundary; }, [onMoveBoundary]);

  const onPlaceRoverAtPointRef = useRef(onPlaceRoverAtPoint);
  useEffect(() => { onPlaceRoverAtPointRef.current = onPlaceRoverAtPoint; }, [onPlaceRoverAtPoint]);

  const onDragStartRef = useRef(onDragStart);
  useEffect(() => { onDragStartRef.current = onDragStart; }, [onDragStart]);

  const onDragEndRef = useRef(onDragEnd);
  useEffect(() => { onDragEndRef.current = onDragEnd; }, [onDragEnd]);

  const onAddEntityRef = useRef(onAddEntity);
  useEffect(() => { onAddEntityRef.current = onAddEntity; }, [onAddEntity]);

  const activeToolRef = useRef(activeTool);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);

  const worldLinesRef = useRef(worldLines);
  useEffect(() => { worldLinesRef.current = worldLines; }, [worldLines]);

  const drawingLineStart = useRef<DesignVertex | null>(null);

  /* ── RAF throttle refs (Step 3) ── */
  const rafPendingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const rafCameraRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const rafItemsFnRef = useRef<((prev: PlacedItem[]) => PlacedItem[]) | null>(null);


  const scheduleRaf = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      if (rafCameraRef.current !== null) {
        setCamera(rafCameraRef.current);
        rafCameraRef.current = null;
      }

      if (rafItemsFnRef.current !== null) {
        setItemsRef.current(rafItemsFnRef.current);
        rafItemsFnRef.current = null;
      }
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

  type StartPosition = { id: string; x: number; y: number; width: number; height: number; rotation: number; scale: number; lines: PlanLine[] };
  const activeDragRef = useRef<{ 
    type: "items" | "camera" | "moveBoundary";
    ids?: string[]; 
    startPositions?: StartPosition[];
    startCamera?: { x: number; y: number; zoom: number };
    startBoundaryPosition?: { x: number; y: number };
    pinchState?: { initialDist: number; initialAngle: number; startPos?: StartPosition[]; startCamera?: { x: number; y: number; zoom: number } };
  } | null>(null);

  const hitTest = (locationX: number, locationY: number) => {
    const bw = boundaryWidthRef.current;
    const bh = boundaryHeightRef.current;
    const sz = svgSizeRef.current;
    const cam = cameraRef.current;
    if (sz.width <= 0 || sz.height <= 0) return null;
    
    const viewBoxWidth = (bw * METER_TO_PX) / cam.zoom;
    const viewBoxHeight = (bh * METER_TO_PX) / cam.zoom;
    const viewBoxX = -viewBoxWidth / 2 - cam.x * METER_TO_PX;
    const viewBoxY = -viewBoxHeight / 2 + cam.y * METER_TO_PX;
    
    const scaleX = viewBoxWidth / sz.width;
    const scaleY = viewBoxHeight / sz.height;
    
    const svgTapX = locationX * scaleX + viewBoxX;
    const svgTapY = locationY * scaleY + viewBoxY;
    
    const screenToSvg = (scaleX + scaleY) / 2;
    const itemScaleScreen = cam.zoom < 0.5 ? 50 : 30;
    const toleranceLineSvgSq = (itemScaleScreen * screenToSvg) ** 2; 

    // Keep track of candidates
    let bestLineId: string | null = null;
    let bestLineArea = Infinity;
    let bestLineDistSq = toleranceLineSvgSq;

    const distToSegmentSquared = (px: number, py: number, vx: number, vy: number, wx: number, wy: number) => {
      const l2 = (vx - wx) ** 2 + (vy - wy) ** 2;
      if (l2 === 0) return (px - vx) ** 2 + (py - vy) ** 2;
      let t = ((px - vx) * (wx - vx) + (py - vy) * (wy - vy)) / l2;
      t = Math.max(0, Math.min(1, t));
      return (px - (vx + t * (wx - vx))) ** 2 + (py - (vy + t * (wy - vy))) ** 2;
    };

    // 1. Items — line geometry has priority; padded bbox alone does not block boundary
    let bestBoxId: string | null = null;
    let bestBoxArea = Infinity;

    itemsRef.current.forEach(item => {
      const dx = svgTapX - (item.x * METER_TO_PX);
      const dy = svgTapY - (-item.y * METER_TO_PX);
      const rad = -item.rotation * Math.PI / 180;
      const localTapX = (dx * Math.cos(rad) - dy * Math.sin(rad)) / (item.scale || 1);
      const localTapY = (dx * Math.sin(rad) + dy * Math.cos(rad)) / (item.scale || 1);
      const localTapXScaled = dx * Math.cos(rad) - dy * Math.sin(rad);
      const localTapYScaled = dx * Math.sin(rad) + dy * Math.cos(rad);
      
      const itemArea = item.width * item.height;

      // Check line hits (precise)
      let minItemLineDistSq = Infinity;
      for (const l of item.lines) {
         const x1 = l.from.y * METER_TO_PX;
         const y1 = -l.from.x * METER_TO_PX;
         const x2 = l.to.y * METER_TO_PX;
         const y2 = -l.to.x * METER_TO_PX;
         const d2 = distToSegmentSquared(localTapX, localTapY, x1, y1, x2, y2) * ((item.scale || 1) ** 2);
         if (d2 < minItemLineDistSq) {
            minItemLineDistSq = d2;
         }
      }

      if (minItemLineDistSq < toleranceLineSvgSq) {
         if (itemArea < bestLineArea) {
            bestLineArea = itemArea;
            bestLineId = item.id;
            bestLineDistSq = minItemLineDistSq;
         }
      }

      // Bounding Box check (with tolerance scaled to SVG)
      const toleranceBoxSvg = 30 * screenToSvg;
      const halfW = (item.height * METER_TO_PX) / 2 + toleranceBoxSvg;
      const halfH = (item.width * METER_TO_PX) / 2 + toleranceBoxSvg;
      if (Math.abs(localTapXScaled) <= halfW && Math.abs(localTapYScaled) <= halfH) {
         if (itemArea < bestBoxArea) {
            bestBoxArea = itemArea;
            bestBoxId = item.id;
         }
      }
    });

    if (bestLineId) {
      return bestLineId;
    }

    const bp = boundaryPositionRef.current || { x: 0, y: 0 };
    const bcx = bp.x * METER_TO_PX;
    const bcy = -bp.y * METER_TO_PX;
    const bx1 = bcx - bw * METER_TO_PX / 2;
    const by1 = bcy - bh * METER_TO_PX / 2;
    const bx2 = bcx + bw * METER_TO_PX / 2;
    const by2 = bcy + bh * METER_TO_PX / 2;

    // 2. Boundary drag handle (when boundary is selected)
    if (selectedItemIdsRef.current.includes("boundary")) {
      const handleOffsetSvg = 14 / cam.zoom;
      const handleRSvg = 44 / cam.zoom;
      const handleX = bx1 - handleOffsetSvg;
      const handleY = by1 - handleOffsetSvg;
      const handleDistSq = (svgTapX - handleX) ** 2 + (svgTapY - handleY) ** 2;
      if (handleDistSq <= handleRSvg ** 2) {
        return "boundary-drag-handle";
      }
    }

    // 3. Boundary Edges
    const edgeToleranceSq = (30 * screenToSvg) ** 2; // Wider tolerance for boundary edges
    const dTop = distToSegmentSquared(svgTapX, svgTapY, bx1, by1, bx2, by1);
    if (dTop < edgeToleranceSq) return "boundary-top";
    
    const dRight = distToSegmentSquared(svgTapX, svgTapY, bx2, by1, bx2, by2);
    if (dRight < edgeToleranceSq) return "boundary-right";
    
    const dBot = distToSegmentSquared(svgTapX, svgTapY, bx1, by2, bx2, by2);
    if (dBot < edgeToleranceSq) return "boundary-bottom";
    
    const dLeft = distToSegmentSquared(svgTapX, svgTapY, bx1, by1, bx1, by2);
    if (dLeft < edgeToleranceSq) return "boundary-left";

    // 4. Boundary Interior (wins over item bbox-only hits)
    if (svgTapX >= bx1 && svgTapX <= bx2 && svgTapY >= by1 && svgTapY <= by2) {
      return "boundary-interior";
    }

    if (bestBoxId) {
      return bestBoxId;
    }

    return null;  
  };

  const panResponder = useMemo(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const locX = evt.nativeEvent.locationX;
        const locY = evt.nativeEvent.locationY;
        if (typeof locX !== 'number' || typeof locY !== 'number') return;
        
        try {
          const coords = screenToDesignMeters(locX, locY, {
            svgSize: svgSizeRef.current,
            camera: cameraRef.current,
            boundaryWidthM: boundaryWidthRef.current,
            boundaryHeightM: boundaryHeightRef.current,
            frame: { originNorthM: 0, originEastM: 0 }
          });

          if (activeToolRef.current === "LINE") {
            const snapPt = findSnapCandidate(coords, worldLinesRef.current, cameraRef.current.zoom) || snapToGrid(coords, 0.1);
            drawingLineStart.current = snapPt;
            setPointerCoords(snapPt);
            activeDragRef.current = { type: "draw" as any };
            return;
          }

          if (activeToolRef.current === "FREEHAND") {
            drawingFreehandVertices.current = [coords];
            setFreehandPoints([coords]);
            activeDragRef.current = { type: "freehand" as any };
            return;
          }

          setPointerCoords(coords);

          const hitId = hitTest(locX, locY);
          
          if (
            hitId === "boundary-drag-handle" ||
            (hitId && (hitId.startsWith("boundary-") || hitId === "boundary-interior"))
          ) {
             activeDragRef.current = { 
               type: "moveBoundary", 
               startBoundaryPosition: { ...(boundaryPositionRef.current || { x: 0, y: 0 }) }
             };
          } else if (hitId && selectedItemIdsRef.current.includes(hitId)) {
             const starts = selectedItemIdsRef.current.map(id => {
               const it = itemsRef.current.find(i => i.id === id);
               return { id, x: it?.x || 0, y: it?.y || 0, width: it?.width || 0, height: it?.height || 0, rotation: it?.rotation || 0, scale: it?.scale || 1, lines: it?.lines || [] };
             });
             activeDragRef.current = { type: "items", ids: selectedItemIdsRef.current, startPositions: starts };
             if (onDragStartRef.current) onDragStartRef.current();
          } else {
             activeDragRef.current = { type: "camera", startCamera: cameraRef.current };
          }
        } catch (err) {}
      },
      onPanResponderMove: (evt, gestureState) => {
        const locX = evt.nativeEvent.locationX;
        const locY = evt.nativeEvent.locationY;
        if (typeof locX !== 'number' || typeof locY !== 'number') return;
        
        try {
          const coords = screenToDesignMeters(locX, locY, {
            svgSize: svgSizeRef.current,
            camera: cameraRef.current,
            boundaryWidthM: boundaryWidthRef.current,
            boundaryHeightM: boundaryHeightRef.current,
            frame: { originNorthM: 0, originEastM: 0 }
          });

          const dragData = activeDragRef.current;
          if (!dragData) return;

          if (dragData.type === "draw" as any) {
            const snapPt = findSnapCandidate(coords, worldLinesRef.current, cameraRef.current.zoom) || snapToGrid(coords, 0.1);
            setPointerCoords(snapPt);
            return;
          }

          if (dragData.type === "freehand" as any) {
            const last = drawingFreehandVertices.current[drawingFreehandVertices.current.length - 1];
            if (last) {
              const dx = coords.eastM - last.eastM;
              const dy = coords.northM - last.northM;
              const dist = Math.hypot(dx, dy);
              if (dist >= 0.01) {
                drawingFreehandVertices.current.push(coords);
                setFreehandPoints([...drawingFreehandVertices.current]);
              }
            }
            return;
          }

          setPointerCoords(coords);

          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
             const t1 = touches[0];
             const t2 = touches[1];
             const currentDist = Math.hypot(t2.pageX - t1.pageX, t2.pageY - t1.pageY);
             const currentAngle = Math.atan2(t2.pageY - t1.pageY, t2.pageX - t1.pageX) * (180 / Math.PI);
             
             if (!dragData.pinchState) {
                 if (dragData.type === "camera") {
                     dragData.pinchState = { initialDist: currentDist, initialAngle: currentAngle, startCamera: cameraRef.current };
                 } else if (dragData.type === "moveBoundary") {
                     return; // Ignore pinch for moveBoundary
                 } else {
                     const starts = dragData.ids!.map(id => {
                       const it = itemsRef.current.find(i => i.id === id);
                       return { id, x: it?.x || 0, y: it?.y || 0, width: it?.width || 0, height: it?.height || 0, rotation: it?.rotation || 0, scale: it?.scale || 1, lines: it?.lines || [] };
                     });
                     dragData.pinchState = { initialDist: currentDist, initialAngle: currentAngle, startPos: starts };
                 }
             }
             
              if (dragData.type === "camera") {
                  if (lockZoomRef.current) return;
                  const initialDist = dragData.pinchState.initialDist;
                  if (initialDist === 0) return;
                  const scaleMultiplier = currentDist / initialDist;
                  rafCameraRef.current = {
                     ...dragData.pinchState.startCamera!,
                     zoom: Math.max(0.01, Math.min(10, dragData.pinchState.startCamera!.zoom * scaleMultiplier))
                  };
                  scheduleRaf();
                  return;
              }
              
              if (lockPanDragRef.current) return;
             
             const initialDist = dragData.pinchState.initialDist;
             const initialAngle = dragData.pinchState.initialAngle;
             const scaleMultiplier = initialDist === 0 ? 1 : currentDist / initialDist;
             const angleDelta = currentAngle - initialAngle;
             
             const mode = multiTouchModeRef.current;
             const appliedScale = mode === "rotate" ? 1 : Math.max(0.1, scaleMultiplier);
             const appliedRot = mode === "scale" ? 0 : angleDelta;
             
             const starts = dragData.pinchState.startPos!;
             let cX = 0, cY = 0;
             if (starts.length > 0) {
                starts.forEach(p => { cX += p.x; cY += p.y; });
                cX /= starts.length;
                cY /= starts.length;
             }
             
             const rad = -(appliedRot) * Math.PI / 180;
             const cosA = Math.cos(rad);
             const sinA = Math.sin(rad);
             
             const bpX = boundaryPositionRef.current?.x || 0;
             const bpY = boundaryPositionRef.current?.y || 0;
  
             const leftBoundary = bpX - boundaryWidthRef.current / 2 + indentSpacingRef.current;
             const rightBoundary = bpX + boundaryWidthRef.current / 2 - indentSpacingRef.current;
             const topBoundary = bpY - boundaryHeightRef.current / 2 + indentSpacingRef.current;
             const bottomBoundary = bpY + boundaryHeightRef.current / 2 - indentSpacingRef.current;
             
             setItemsRef.current(prev => prev.map(item => {
                const startP = starts.find(p => p.id === item.id);
                if (startP) {
                   const dx = startP.x - cX;
                   const dy = startP.y - cY;
                   const sdx = dx * appliedScale;
                   const sdy = dy * appliedScale;
                   
                   let newX = cX + sdx * cosA - sdy * sinA;
                   let newY = cY + sdx * sinA + sdy * cosA;
                   
                   const newW = startP.width * appliedScale;
                   const newH = startP.height * appliedScale;
                   
                   newX = Math.max(leftBoundary + newW / 2, Math.min(newX, rightBoundary - newW / 2));
                   newY = Math.max(topBoundary + newH / 2, Math.min(newY, bottomBoundary - newH / 2));
                   
                   return {
                      ...item,
                      rotation: (startP.rotation + appliedRot) % 360,
                      scale: startP.scale * appliedScale,
                      width: newW,
                      height: newH,
                      x: newX,
                      y: newY,
                       lines: startP.lines
                    };
                 }
                 return item;
              }));
             return;
          } else {
             if (dragData.pinchState) {
                 dragData.pinchState = undefined;
                 if (dragData.type === "camera") {
                     dragData.startCamera = cameraRef.current;
                 }
             }
          }
  
          const zoom = cameraRef.current.zoom;
          const sz = svgSizeRef.current;
          const screenW = sz.width > 0 ? sz.width : 400;
          const screenH = sz.height > 0 ? sz.height : 400;
          const bwVal = boundaryWidthRef.current;
          const bhVal = boundaryHeightRef.current;
  
          const dx = gestureState.dx * (bwVal / (screenW * zoom));
          const dy = -gestureState.dy * (bhVal / (screenH * zoom));
  
           if (dragData.type === "moveBoundary") {
              if (lockPanDragRef.current) return;
              const newX = dragData.startBoundaryPosition!.x + dx;
              const newY = dragData.startBoundaryPosition!.y + dy;
              onMoveBoundaryRef.current?.(newX, newY);
              return;
           }
  
           if (dragData.type === "camera") {
              if (lockPanDragRef.current) return;
              const camDx = -gestureState.dx * (bwVal / (screenW * zoom));
              const camDy = gestureState.dy * (bhVal / (screenH * zoom));
              rafCameraRef.current = {
                 ...dragData.startCamera!,
                 x: dragData.startCamera!.x + camDx,
                 y: dragData.startCamera!.y + camDy
              };
              scheduleRaf();
              return;
           }
  
           if (lockPanDragRef.current) return;
  
           const bw = boundaryWidthRef.current;
           const bh = boundaryHeightRef.current;
           const indent = indentSpacingRef.current;
  
           const bpX = boundaryPositionRef.current?.x || 0;
           const bpY = boundaryPositionRef.current?.y || 0;
  
           const updates: Record<string, {x: number, y: number}> = {};
  
           dragData.startPositions!.forEach(start => {
             let newX = start.x + dx;
             let newY = start.y + dy;
  
             const leftIndent = bpX - bw / 2 + indent;
             const rightIndent = bpX + bw / 2 - indent;
             const topIndent = bpY - bh / 2 + indent;
             const bottomIndent = bpY + bh / 2 - indent;
             const halfW = start.width / 2;
             const halfH = start.height / 2;
  
             newX = Math.max(leftIndent + halfW, Math.min(newX, rightIndent - halfW));
             newY = Math.max(topIndent + halfH, Math.min(newY, bottomIndent - halfH));
  
             updates[start.id] = {x: newX, y: newY};
           });
           
           rafItemsFnRef.current = prev => prev.map(item => updates[item.id] ? { ...item, x: updates[item.id].x, y: updates[item.id].y } : item);
           scheduleRaf();
        } catch (err) {}
      },
      onPanResponderRelease: (evt, gestureState) => {
        setPointerCoords(null);
        const dragData = activeDragRef.current;
        activeDragRef.current = null;

        if (dragData && dragData.type === "draw" as any) {
          const locX = evt.nativeEvent.locationX;
          const locY = evt.nativeEvent.locationY;
          if (typeof locX === 'number' && typeof locY === 'number') {
            try {
              const coords = screenToDesignMeters(locX, locY, {
                svgSize: svgSizeRef.current,
                camera: cameraRef.current,
                boundaryWidthM: boundaryWidthRef.current,
                boundaryHeightM: boundaryHeightRef.current,
                frame: { originNorthM: 0, originEastM: 0 }
              });
              const snapPt = findSnapCandidate(coords, worldLinesRef.current, cameraRef.current.zoom) || snapToGrid(coords, 0.1);
              if (drawingLineStart.current) {
                const dx = snapPt.eastM - drawingLineStart.current.eastM;
                const dy = snapPt.northM - drawingLineStart.current.northM;
                if (Math.hypot(dx, dy) > 0.05) {
                  if (onAddEntityRef.current) {
                    const newEntity = createDesignEntity(
                      `line-${Date.now()}`,
                      "LINE",
                      "marking",
                      [drawingLineStart.current, snapPt]
                    );
                    onAddEntityRef.current(newEntity);
                  }
                }
              }
            } catch (err) {}
          }
          drawingLineStart.current = null;
          return;
        }

        if (dragData && dragData.type === "freehand" as any) {
          try {
            const rawPoints = drawingFreehandVertices.current;
            if (rawPoints.length >= 2) {
              const simplified = simplifyPath(rawPoints, 0.005);
              let strokeLen = 0;
              for (let i = 0; i < simplified.length - 1; i++) {
                strokeLen += Math.hypot(
                  simplified[i+1].eastM - simplified[i].eastM,
                  simplified[i+1].northM - simplified[i].northM
                );
              }

              if (strokeLen >= 0.02) {
                if (onAddEntityRef.current) {
                  const newEntity = createDesignEntity(
                    `freehand-${Date.now()}`,
                    "FREEHAND",
                    "marking",
                    simplified
                  );
                  onAddEntityRef.current(newEntity);
                }
              }
            }
          } catch (err) {}
          drawingFreehandVertices.current = [];
          setFreehandPoints([]);
          return;
        }

        if (dragData && dragData.type === "items") {
          if (onDragEndRef.current) onDragEndRef.current();
        }
        
        if (Math.abs(gestureState.dx) < 3 && Math.abs(gestureState.dy) < 3) {
          const touch = evt.nativeEvent;
          const nearestId = hitTest(touch.locationX, touch.locationY);
          
          if (nearestId) {
             if (nearestId.startsWith("boundary-") || nearestId === "boundary-interior") {
                setSelectedItemIdsRef.current(["boundary"]);
             } else {
                const currentSelected = selectedItemIdsRef.current;
                const tappedItem = itemsRef.current.find(i => i.id === nearestId);
                
                if (tappedItem?.groupId) {
                   const groupItemIds = itemsRef.current
                     .filter(i => i.groupId === tappedItem.groupId)
                     .map(i => i.id);
                   
                   if (currentSelected.length > 0 && currentSelected.every(id => groupItemIds.includes(id))) {
                     setSelectedItemIdsRef.current([]);
                   } else {
                     setSelectedItemIdsRef.current(groupItemIds);
                   }
                } else {
                   if (currentSelected.includes(nearestId)) {
                      setSelectedItemIdsRef.current(currentSelected.filter((id) => id !== nearestId));
                   } else {
                      setSelectedItemIdsRef.current(multiTouchModeRef.current === "scale" ? [...currentSelected, nearestId] : [nearestId]);
                   }
                }
             }
          } else {
             setSelectedItemIdsRef.current([]);
          }
        }
      },
      onPanResponderTerminate: () => {
        setPointerCoords(null);
        const dragData = activeDragRef.current;
        activeDragRef.current = null;
        if (dragData && dragData.type === "draw" as any) {
          drawingLineStart.current = null;
        } else if (dragData && dragData.type === "freehand" as any) {
          drawingFreehandVertices.current = [];
          setFreehandPoints([]);
        } else if (dragData && dragData.type === "items") {
          if (onDragEndRef.current) onDragEndRef.current();
        }
      }
    }),
    []
  );

  const snapIndicator = useMemo(() => {
    if (!pointerCoords || activeTool !== "LINE") return null;
    const snapped = findSnapCandidate(pointerCoords, worldLines, camera.zoom, 100, 1.5);
    if (snapped) return snapped;
    return null;
  }, [pointerCoords, worldLines, camera.zoom, activeTool]);

  return (
    <View 
      style={{ flex: 1, backgroundColor: "#f8fafc", overflow: "hidden", position: "relative" }} 
      {...panResponder.panHandlers}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) setSvgSize({ width, height });
      }}
    >
      <Svg pointerEvents="none" style={{ width: "100%", height: "100%" }} viewBox={`${-boundaryWidth * METER_TO_PX / (2 * camera.zoom) - camera.x * METER_TO_PX} ${-boundaryHeight * METER_TO_PX / (2 * camera.zoom) + camera.y * METER_TO_PX} ${boundaryWidth * METER_TO_PX / camera.zoom} ${boundaryHeight * METER_TO_PX / camera.zoom}`}>
        {/* Draw Boundary Box (Outer area filled with light gray) */}
        <Rect
          x={cx - boundaryWidth * METER_TO_PX / 2}
          y={cy - boundaryHeight * METER_TO_PX / 2}
          width={boundaryWidth * METER_TO_PX}
          height={boundaryHeight * METER_TO_PX}
          fill="#f1f5f9"
          stroke="#cbd5e1"
          strokeWidth={2}
        />
        {/* Cartesian Grid System (Phase 2) */}
        <Path
          d={gridGeom.minorD}
          stroke="#cbd5e1"
          strokeWidth={0.5 / camera.zoom}
          fill="none"
          opacity={0.4}
        />
        <Path
          d={gridGeom.majorD}
          stroke="#cbd5e1"
          strokeWidth={1.0 / camera.zoom}
          fill="none"
          opacity={0.8}
        />
        {/* Origin Axes (Frame Origin at 0,0) */}
        {gridGeom.showVerticalAxis && (
          <Line
            x1={0}
            y1={gridGeom.minYSvg}
            x2={0}
            y2={gridGeom.maxYSvg}
            stroke="#64748b"
            strokeWidth={1.5 / camera.zoom}
          />
        )}
        {gridGeom.showHorizontalAxis && (
          <Line
            x1={gridGeom.minXSvg}
            y1={0}
            x2={gridGeom.maxXSvg}
            y2={0}
            stroke="#64748b"
            strokeWidth={1.5 / camera.zoom}
          />
        )}
        <Rect
          x={cx - boundaryWidth * METER_TO_PX / 2}
          y={cy - boundaryHeight * METER_TO_PX / 2}
          width={boundaryWidth * METER_TO_PX}
          height={boundaryHeight * METER_TO_PX}
          fill="none"
          stroke={selectedItemIds.includes("boundary") ? "#ef4444" : "#0f172a"}
          strokeWidth={selectedItemIds.includes("boundary") ? 4 / camera.zoom : 3 / camera.zoom}
          strokeLinejoin="round"
        />

        {/* Draw Indent Spacing Bounds (Inner canvas filled with white) */}
        {indentSpacing >= 0 && (
           <Rect
             x={cx - (boundaryWidth / 2 - indentSpacing) * METER_TO_PX}
             y={cy - (boundaryHeight / 2 - indentSpacing) * METER_TO_PX}
             width={(boundaryWidth - indentSpacing * 2) * METER_TO_PX}
             height={(boundaryHeight - indentSpacing * 2) * METER_TO_PX}
             fill="#ffffff"
           />
        )}

        {/* Boundary drag handle (visible when boundary is selected) */}
        {selectedItemIds.includes("boundary") && (
          <G pointerEvents="none">
            <Circle
              cx={dragHandleCx}
              cy={dragHandleCy}
              r={dragHandleR}
              fill="#3b82f6"
              stroke="#ffffff"
              strokeWidth={2 / camera.zoom}
            />
            <Line
              x1={dragHandleCx - dragHandleArm}
              y1={dragHandleCy}
              x2={dragHandleCx + dragHandleArm}
              y2={dragHandleCy}
              stroke="#ffffff"
              strokeWidth={2 / camera.zoom}
              strokeLinecap="round"
            />
            <Line
              x1={dragHandleCx}
              y1={dragHandleCy - dragHandleArm}
              x2={dragHandleCx}
              y2={dragHandleCy + dragHandleArm}
              stroke="#ffffff"
              strokeWidth={2 / camera.zoom}
              strokeLinecap="round"
            />
            <Line x1={dragHandleCx} y1={dragHandleCy - dragHandleArm} x2={dragHandleCx - dragHandleArrow} y2={dragHandleCy - dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx} y1={dragHandleCy - dragHandleArm} x2={dragHandleCx + dragHandleArrow} y2={dragHandleCy - dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx + dragHandleArm} y1={dragHandleCy} x2={dragHandleCx + dragHandleArrow} y2={dragHandleCy - dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx + dragHandleArm} y1={dragHandleCy} x2={dragHandleCx + dragHandleArrow} y2={dragHandleCy + dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx} y1={dragHandleCy + dragHandleArm} x2={dragHandleCx - dragHandleArrow} y2={dragHandleCy + dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx} y1={dragHandleCy + dragHandleArm} x2={dragHandleCx + dragHandleArrow} y2={dragHandleCy + dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx - dragHandleArm} y1={dragHandleCy} x2={dragHandleCx - dragHandleArrow} y2={dragHandleCy - dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
            <Line x1={dragHandleCx - dragHandleArm} y1={dragHandleCy} x2={dragHandleCx - dragHandleArrow} y2={dragHandleCy + dragHandleArrow} stroke="#ffffff" strokeWidth={1.5 / camera.zoom} strokeLinecap="round" />
          </G>
        )}

        {/* Draw Control Points */}
        {showBoundaryPoints && controlPoints.map(pt => (
          <G key={pt.id}>
            {activeSnapPointId === pt.id ? (
              <Circle
                cx={pt.svgX}
                cy={pt.svgY}
                r={14 / camera.zoom}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={3 / camera.zoom}
                opacity={0.55}
              />
            ) : null}
            {activeSnapPointId === pt.id ? (
              <Circle
                cx={pt.svgX}
                cy={pt.svgY}
                r={9 / camera.zoom}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={2 / camera.zoom}
                opacity={0.35}
              />
            ) : null}
            <Circle
              cx={pt.svgX}
              cy={pt.svgY}
              r={(activeSnapPointId === pt.id ? 7 : 6) / camera.zoom}
              fill={activeSnapPointId === pt.id ? "#f59e0b" : "#3b82f6"}
              stroke="#ffffff"
              strokeWidth={2 / camera.zoom}
            />
          </G>
        ))}



        {/* Draw Items */}
        {items.map(item => {
          const isSelected = selectedItemIds.includes(item.id);
          const totalDim = Math.max(item.width || 0, item.height || 0) * item.scale;
          const sizeScale = totalDim > 0 ? Math.sqrt(totalDim) : 1;
          
          return (
            <G 
              key={item.id} 
              transform={`translate(${item.x * METER_TO_PX}, ${-item.y * METER_TO_PX}) rotate(${item.rotation}) scale(${item.scale || 1})`}
            >
               {/* Item SVG Lines - batched into single <Path> per item (Step 4) */}
               <Path
                 d={item.lines.map(l => `M${l.from.y * METER_TO_PX} ${-l.from.x * METER_TO_PX}L${l.to.y * METER_TO_PX} ${-l.to.x * METER_TO_PX}`).join('')}
                 stroke={isSelected ? "#ef4444" : "#0f172a"}
                 strokeWidth={isSelected ? ((3 * sizeScale) / camera.zoom) / (item.scale || 1) : ((2 * sizeScale) / camera.zoom) / (item.scale || 1)}
                 strokeLinecap="round"
                 fill="none"
                 opacity={sketchMode && !isSelected ? 0.2 : 1.0}
               />
            </G>
          );
        })}

        {/* Active drawing rubber-band line preview */}
        {activeTool === "LINE" && drawingLineStart.current && pointerCoords && (
          <Line
            x1={drawingLineStart.current.eastM * METER_TO_PX}
            y1={-drawingLineStart.current.northM * METER_TO_PX}
            x2={pointerCoords.eastM * METER_TO_PX}
            y2={-pointerCoords.northM * METER_TO_PX}
            stroke="#ef4444"
            strokeWidth={3.5 / camera.zoom}
            strokeDasharray={`${6 / camera.zoom},${4 / camera.zoom}`}
          />
        )}

        {/* Active freehand drawing preview */}
        {activeTool === "FREEHAND" && freehandPoints.length > 1 && (
          <Polyline
            points={freehandPoints.map(p => `${p.eastM * METER_TO_PX},${-p.northM * METER_TO_PX}`).join(" ")}
            stroke="#ef4444"
            strokeWidth={3.5 / camera.zoom}
            fill="none"
          />
        )}

        {/* Snap endpoint indicator (red box) */}
        {snapIndicator && (
          <Rect
            x={snapIndicator.eastM * METER_TO_PX - 8 / camera.zoom}
            y={-snapIndicator.northM * METER_TO_PX - 8 / camera.zoom}
            width={16 / camera.zoom}
            height={16 / camera.zoom}
            fill="none"
            stroke="#ef4444"
            strokeWidth={2.5 / camera.zoom}
          />
        )}
      </Svg>

      {/* Floating Control Panel for Lock Toggles */}
      <View style={{
        position: "absolute",
        top: 16,
        left: 16,
        backgroundColor: "rgba(255, 255, 255, 0.95)",
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        shadowColor: "#0f172a",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
        borderWidth: 1,
        borderColor: "rgba(226, 232, 240, 0.8)",
        flexDirection: "column",
        gap: 8,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: 155 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#334155" }}>Lock Pan/Drag</Text>
          <Switch
            value={lockPanDrag}
            onValueChange={setLockPanDrag}
            trackColor={{ false: "#cbd5e1", true: "#3b82f6" }}
            thumbColor="#ffffff"
            ios_backgroundColor="#cbd5e1"
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: 155 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: "#334155" }}>Lock Zoom</Text>
          <Switch
            value={lockZoom}
            onValueChange={setLockZoom}
            trackColor={{ false: "#cbd5e1", true: "#3b82f6" }}
            thumbColor="#ffffff"
            ios_backgroundColor="#cbd5e1"
          />
        </View>
      </View>

      {/* Floating Compass Overlay */}
      <View
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          width: 54,
          height: 54,
          zIndex: 40,
          elevation: 40,
          backgroundColor: "transparent",
        }}
      >
        <Svg width={54} height={54} viewBox="0 0 54 54">
          <Circle cx={27} cy={27} r={24} fill="rgba(15,23,42,0.85)" stroke="#e2e8f0" strokeWidth={1.5} />
          <SvgText x={27} y={12} fontSize={8} fill="#ef4444" fontWeight="900" textAnchor="middle">N</SvgText>
          <SvgText x={27} y={48} fontSize={7} fill="#64748b" fontWeight="700" textAnchor="middle">S</SvgText>
          <SvgText x={47} y={30} fontSize={7} fill="#64748b" fontWeight="700" textAnchor="middle">E</SvgText>
          <SvgText x={7} y={30} fontSize={7} fill="#64748b" fontWeight="700" textAnchor="middle">W</SvgText>
          <G transform="rotate(0 27 27)">
            <Polygon points="27,15 31,27 23,27" fill="#ef4444" />
            <Polygon points="27,39 31,27 23,27" fill="#cbd5e1" />
            <Circle cx={27} cy={27} r={2.5} fill="#0f172a" stroke="#fff" strokeWidth={1} />
          </G>
        </Svg>
      </View>

      {/* Floating Coordinate HUD Readout (Phase 2) */}
      {pointerCoords && (
        <View style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          backgroundColor: "rgba(15, 23, 42, 0.9)",
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderWidth: 1,
          borderColor: "rgba(255, 255, 255, 0.15)",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.25,
          shadowRadius: 4,
          elevation: 5,
          zIndex: 50,
        }}>
          <Text style={{ color: "#94a3b8", fontSize: 10, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" }}>
            Design Coordinates
          </Text>
          <Text style={{ color: "#38bdf8", fontSize: 14, fontWeight: "700", marginTop: 2, fontFamily: "monospace" }}>
            N: {pointerCoords.northM.toFixed(3)}m  E: {pointerCoords.eastM.toFixed(3)}m
          </Text>
        </View>
      )}
    </View>
  );
}, (prev, next) => {
  return (
    prev.boundaryWidth === next.boundaryWidth &&
    prev.boundaryHeight === next.boundaryHeight &&
    prev.indentSpacing === next.indentSpacing &&
    prev.letterSpacing === next.letterSpacing &&
    prev.multiTouchMode === next.multiTouchMode &&
    prev.showBoundaryPoints === next.showBoundaryPoints &&
    prev.activeSnapPointId === next.activeSnapPointId &&
    prev.boundaryPosition?.x === next.boundaryPosition?.x &&
    prev.boundaryPosition?.y === next.boundaryPosition?.y &&
    prev.selectedItemIds.length === next.selectedItemIds.length &&
    prev.selectedItemIds.every((id, idx) => id === next.selectedItemIds[idx]) &&
    prev.items.length === next.items.length &&
    prev.items.every((p, i) => p.x === next.items[i].x && p.y === next.items[i].y && p.rotation === next.items[i].rotation && p.scale === next.items[i].scale)
  );
});
