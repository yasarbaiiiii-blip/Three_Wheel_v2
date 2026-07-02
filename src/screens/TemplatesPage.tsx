import React, { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { X } from "lucide-react-native";
import Slider from "@react-native-community/slider";

import { MapView } from "../components/MapView";
import { BoundaryEditor, PlacedItem } from "../components/BoundaryEditor";
import { generateAlphabetLines, FontStyle, AlphabetType, NumberType, generateNumberLines, generateTextLines } from "../utils/characterTemplates";
import { generateRoadSignLines, RoadSignType, ROAD_SIGN_LABELS } from "../utils/roadSignTemplates";
import { generateTemplateLines, ShapeType, ArcType } from "../utils/shapeTemplates";
import { generateSportsFieldLines, SportsFieldType, SPORTS_FIELD_LABELS, SPORTS_FIELD_BOUNDS } from "../utils/sportsFieldTemplates";
import { linesToDxf } from "../utils/dxfGenerator";
import { DesignDocument, DesignNode, isDesignInstance, isDesignEntity, createDesignDocument, createDesignInstance, createDesignEntity, createDesignVertex, DesignPreviewAnchor } from "../types/designDocument";
import { TemplateRegistry, createTemplateDefinition, snapshotTemplateId } from "../utils/designTemplateRegistry";
import { flattenDesignDocument, flattenDesignNode } from "../utils/designTransform";
import { migratePlacedItemsToDesignDocument, verifyMigrationParity } from "../utils/designMigration";
import { applyDesignCommand } from "../utils/designHistory";
import type { PlanLine, LayerVisibility, Page, TelemetrySnapshot, DxfEntity } from "../types/plan";
export type BoundarySide = 'top' | 'right' | 'bottom' | 'left';

export interface BoundaryEdgeInfo {
  side: BoundarySide;
  id: string;            // e.g. "boundary-top"
  from: { x: number; y: number };   // DXF local coords
  to: { x: number; y: number };     // DXF local coords
  length: number;        // width or height in meters
  angle: number;         // 0, 90, 180, 270
}

interface TemplatesPageProps {
  telemetrySnapshot: TelemetrySnapshot | null;
  layerVisibility: LayerVisibility;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  previewRoverPoint: { north: number; east: number } | null;
  onGenerateTemplate: (name: string, lines: PlanLine[]) => void;
  apiBaseUrl: string;
  onSelectPath: (name: string) => void;
  onRefreshPaths: () => void;
  onNav: (page: Page) => void;
  renderPlanPreview: (previewProps: {
    lines: PlanLine[];
    visibility: LayerVisibility;
    selectedLineId: string | null;
    onSelectLine?: (id: string | null) => void;
    roverPosN?: number | null;
    roverPosE?: number | null;
    roverHeadingDeg?: number | null;
  }) => React.ReactNode;
  mapViewEnabled?: boolean;
}

interface WordGroup {
  id: string;
  label: string;
  itemIds: string[];
}

export function TemplatesPage(props: TemplatesPageProps) {
  const [boundaryMode, setBoundaryMode] = useState(false);
  const [boundaryWidthStr, setBoundaryWidthStr] = useState("4.0");
  const [boundaryHeightStr, setBoundaryHeightStr] = useState("3.0");
  const [indentSpacingStr, setIndentSpacingStr] = useState("0.25");
  const [letterSpacingStr, setLetterSpacingStr] = useState("10");
  const [charSpacingStr, setCharSpacingStr] = useState("10");
  const [designDocument, setDesignDocument] = useState<DesignDocument>(createDesignDocument());
  const templateRegistryRef = useRef<TemplateRegistry>(new TemplateRegistry());

  const placedItems = useMemo(() => {
    const registry = templateRegistryRef.current;
    return designDocument.nodes.map(node => {
      if (isDesignInstance(node)) {
        const template = registry.getTemplate(node.templateId);
        if (!template) {
          return {
            id: node.id,
            lines: [],
            x: node.transform.eastM,
            y: node.transform.northM,
            rotation: node.transform.rotationDeg,
            scale: node.transform.scale,
            width: 0,
            height: 0,
            groupId: node.metadata?.groupId as string | undefined,
          };
        }
        return {
          id: node.id,
          lines: template.lines,
          x: node.transform.eastM,
          y: node.transform.northM,
          rotation: node.transform.rotationDeg,
          scale: node.transform.scale,
          width: template.nominalWidthM * node.transform.scale,
          height: template.nominalHeightM * node.transform.scale,
          groupId: node.metadata?.groupId as string | undefined,
        };
      } else {
        const flatLines = flattenDesignNode(node, registry, designDocument.frame);
        let minN = Infinity, maxN = -Infinity;
        let minE = Infinity, maxE = -Infinity;
        for (const l of flatLines) {
          minN = Math.min(minN, l.from.x, l.to.x);
          maxN = Math.max(maxN, l.from.x, l.to.x);
          minE = Math.min(minE, l.from.y, l.to.y);
          maxE = Math.max(maxE, l.from.y, l.to.y);
        }
        return {
          id: node.id,
          lines: flatLines,
          x: 0,
          y: 0,
          rotation: 0,
          scale: 1.0,
          width: isFinite(maxE - minE) ? (maxE - minE) : 0,
          height: isFinite(maxN - minN) ? (maxN - minN) : 0,
          groupId: node.metadata?.groupId as string | undefined,
        };
      }
    });
  }, [designDocument]);

  const worldLines = useMemo(() => {
    try {
      return flattenDesignDocument(designDocument, templateRegistryRef.current);
    } catch (e) {
      return [];
    }
  }, [designDocument]);

  const setPlacedItems = useCallback((updater: PlacedItem[] | ((prev: PlacedItem[]) => PlacedItem[])) => {
    setDesignDocument(prevDoc => {
      const registry = templateRegistryRef.current;
      const currentItems = prevDoc.nodes.map(node => {
        if (isDesignInstance(node)) {
          const template = registry.getTemplate(node.templateId);
          if (!template) {
            return {
              id: node.id,
              lines: [],
              x: node.transform.eastM,
              y: node.transform.northM,
              rotation: node.transform.rotationDeg,
              scale: node.transform.scale,
              width: 0,
              height: 0,
              groupId: node.metadata?.groupId as string | undefined,
            };
          }
          return {
            id: node.id,
            lines: template.lines,
            x: node.transform.eastM,
            y: node.transform.northM,
            rotation: node.transform.rotationDeg,
            scale: node.transform.scale,
            width: template.nominalWidthM * node.transform.scale,
            height: template.nominalHeightM * node.transform.scale,
            groupId: node.metadata?.groupId as string | undefined,
          };
        } else {
          const flatLines = flattenDesignNode(node, registry, prevDoc.frame);
          let minN = Infinity, maxN = -Infinity;
          let minE = Infinity, maxE = -Infinity;
          for (const l of flatLines) {
            minN = Math.min(minN, l.from.x, l.to.x);
            maxN = Math.max(maxN, l.from.x, l.to.x);
            minE = Math.min(minE, l.from.y, l.to.y);
            maxE = Math.max(maxE, l.from.y, l.to.y);
          }
          return {
            id: node.id,
            lines: flatLines,
            x: 0,
            y: 0,
            rotation: 0,
            scale: 1.0,
            width: isFinite(maxE - minE) ? (maxE - minE) : 0,
            height: isFinite(maxN - minN) ? (maxN - minN) : 0,
            groupId: node.metadata?.groupId as string | undefined,
          };
        }
      });
      
      const nextItems = typeof updater === 'function' ? updater(currentItems) : updater;
      
      const nextNodes = nextItems.map(item => {
        const existingNode = prevDoc.nodes.find(n => n.id === item.id);
        if (existingNode && isDesignInstance(existingNode)) {
          return {
            ...existingNode,
            transform: {
              ...existingNode.transform,
              eastM: item.x,
              northM: item.y,
              rotationDeg: item.rotation,
              scale: item.scale,
            },
            metadata: {
              ...existingNode.metadata,
              groupId: item.groupId,
            }
          };
        } else if (existingNode && isDesignEntity(existingNode)) {
          const dx = item.x;
          const dy = item.y;
          if (dx !== 0 || dy !== 0) {
            return {
              ...existingNode,
              vertices: existingNode.vertices.map(v => ({
                northM: v.northM + dy,
                eastM: v.eastM + dx,
              })),
              metadata: {
                ...existingNode.metadata,
                groupId: item.groupId,
              }
            };
          }
          return existingNode;
        } else {
          const templateId = snapshotTemplateId(item.lines);
          if (!registry.hasTemplate(templateId)) {
            const def = createTemplateDefinition(templateId, item.lines, item.width / item.scale, item.height / item.scale);
            registry.registerTemplate(def);
          }
          return createDesignInstance(
            item.id,
            templateId,
            {
              northM: item.y,
              eastM: item.x,
              rotationDeg: item.rotation,
              scale: item.scale,
            },
            {
              groupId: item.groupId,
            }
          );
        }
      });

      return {
        ...prevDoc,
        nodes: nextNodes,
        revision: prevDoc.revision + 1,
      };
    });
  }, []);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [activeTool, setActiveTool] = useState<"SELECT" | "LINE" | "FREEHAND">("SELECT");
  const [history, setHistory] = useState<{ past: import('../types/designDocument').DesignCommand[]; future: import('../types/designDocument').DesignCommand[] }>({ past: [], future: [] });
  const dragStartDocRef = useRef<DesignDocument | null>(null);

  const [previewAnchor, setPreviewAnchor] = useState<DesignPreviewAnchor>({
    mode: 'rover_latched',
    lat: 28.6139,
    lon: 77.2090,
  });

  useEffect(() => {
    const gpsLat = props.telemetrySnapshot?.lat;
    const gpsLon = props.telemetrySnapshot?.lon;
    if (previewAnchor.mode === 'rover_latched' && gpsLat != null && gpsLon != null) {
      setPreviewAnchor(prev => {
        if (prev.lat === gpsLat && prev.lon === gpsLon) return prev;
        return {
          ...prev,
          lat: gpsLat,
          lon: gpsLon,
        };
      });
    }
  }, [props.telemetrySnapshot?.lat, props.telemetrySnapshot?.lon, previewAnchor.mode]);

  const [itemNorthStr, setItemNorthStr] = useState("0.0");
  const [itemEastStr, setItemEastStr] = useState("0.0");
  const [lineLengthStr, setLineLengthStr] = useState("0.0");
  const [lineAngleStr, setLineAngleStr] = useState("0.0");
  
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [arrangeMode, setArrangeMode] = useState<"none" | "horizontal" | "vertical">("none");
  const [multiTouchMode, setMultiTouchMode] = useState<"both" | "scale" | "rotate">("both");
  const [lockPanDrag, setLockPanDrag] = useState(false);
  const [lockZoom, setLockZoom] = useState(false);
  const [sketchMode, setSketchMode] = useState(false);
  const [itemScaleStr, setItemScaleStr] = useState("1.0");
  const [itemRotationStr, setItemRotationStr] = useState("0");

  useEffect(() => {
    if (selectedItemIds.length > 0) {
      const node = designDocument.nodes.find(n => n.id === selectedItemIds[0]);
      if (node && isDesignInstance(node)) {
        setItemScaleStr(node.transform.scale.toFixed(3));
        setItemRotationStr(Math.round(node.transform.rotationDeg).toString());
        setItemNorthStr(node.transform.northM.toFixed(3));
        setItemEastStr(node.transform.eastM.toFixed(3));
      } else if (node && isDesignEntity(node) && node.type === "LINE") {
        const v0 = node.vertices[0];
        const v1 = node.vertices[1];
        if (v0 && v1) {
          const len = Math.hypot(v1.eastM - v0.eastM, v1.northM - v0.northM);
          const angle = Math.atan2(v1.eastM - v0.eastM, v1.northM - v0.northM) * 180 / Math.PI;
          setLineLengthStr(len.toFixed(3));
          setLineAngleStr(Math.round(angle).toString());
          setItemNorthStr(v0.northM.toFixed(3));
          setItemEastStr(v0.eastM.toFixed(3));
        }
      }
    } else {
      setMultiTouchMode("both");
    }
  }, [selectedItemIds, designDocument.nodes]);
  const [boundaryPosition, setBoundaryPosition] = useState({ x: 0, y: 0 });
  const [activeSnapPointId, setActiveSnapPointId] = useState<string | null>(null);
  
  const [category, setCategory] = useState<"shapes" | "alphabets" | "numbers" | "road_signs" | "sports_fields" | "characters">("shapes");
  const [fontStyle, setFontStyle] = useState<FontStyle>("smooth");
  const [shape, setShape] = useState<ShapeType>("square");
  const [selectedLetter, setSelectedLetter] = useState<AlphabetType>("A");
  const [selectedDigit, setSelectedDigit] = useState<NumberType>("0");
  const [selectedSign, setSelectedSign] = useState<RoadSignType>("am_01");
  const [selectedField, setSelectedField] = useState<SportsFieldType>("cricket_icc");
  const [arcType, setArcType] = useState<ArcType>("full");
  const [sizeInput, setSizeInput] = useState("1.0");
  const [isParsing, setIsParsing] = useState(false);
  const [inputText, setInputText] = useState("");
  const [previewText, setPreviewText] = useState("");

  // Active boundary dimensions (applied to canvas)
  const [activeBoundaryWidth, setActiveBoundaryWidth] = useState(4.0);
  const [activeBoundaryHeight, setActiveBoundaryHeight] = useState(3.0);
  const [activeIndentSpacing, setActiveIndentSpacing] = useState(0.25);
  const [activeLetterSpacingCm, setActiveLetterSpacingCm] = useState(10);

  const [showBoundaryPoints, setShowBoundaryPoints] = useState(false);

  const parsedSize = Math.max(0.1, parseFloat(sizeInput) || 1.0);

  useEffect(() => {
    if (category === "sports_fields" && SPORTS_FIELD_BOUNDS[selectedField]) {
      const bounds = SPORTS_FIELD_BOUNDS[selectedField];
      const naturalSize = Math.max(bounds.naturalWidth, bounds.naturalHeight);
      setSizeInput(naturalSize.toFixed(2));
    }
  }, [category, selectedField]);

  // PENDING values from text inputs
  const pendingWidth = parseFloat(boundaryWidthStr) || 4.0;
  const pendingHeight = parseFloat(boundaryHeightStr) || 3.0;
  const pendingIndent = parseFloat(indentSpacingStr) || 0.25;
  const pendingLetterSpacingCm = parseFloat(letterSpacingStr) || 10;
  const pendingCharSpacingCm = parseFloat(charSpacingStr) || 10;

  // ACTIVE values (applied to canvas)
  const bw = activeBoundaryWidth;
  const bh = activeBoundaryHeight;
  const indent = activeIndentSpacing;
  const lSpacing = activeLetterSpacingCm / 100; // cm → meters

  const boundaryControlPointsLocal = useMemo(() => {
    const halfW = bw / 2;
    const halfH = bh / 2;

    return [
      { id: "corner-tl", localX: -halfW, localY: -halfH },
      { id: "corner-tr", localX: halfW, localY: -halfH },
      { id: "corner-br", localX: halfW, localY: halfH },
      { id: "corner-bl", localX: -halfW, localY: halfH },
      { id: "midpoint-t", localX: 0, localY: -halfH },
      { id: "midpoint-r", localX: halfW, localY: 0 },
      { id: "midpoint-b", localX: 0, localY: halfH },
      { id: "midpoint-l", localX: -halfW, localY: 0 },
    ];
  }, [bw, bh]);

  const SNAP_THRESHOLD_M = 0.5;

  useEffect(() => {
    if (!showBoundaryPoints) {
      setActiveSnapPointId(null);
      return;
    }

    const roverN = props.telemetrySnapshot?.pos_n;
    const roverE = props.telemetrySnapshot?.pos_e;
    if (roverN == null || roverE == null) {
      setActiveSnapPointId(null);
      return;
    }

    const bpX = boundaryPosition.x;
    const bpY = boundaryPosition.y;
    let nextActiveId: string | null = null;

    for (const cp of boundaryControlPointsLocal) {
      const worldX = bpX + cp.localX;
      const worldY = bpY + cp.localY;
      const dist = Math.hypot(roverE - worldX, roverN - worldY);

      if (dist <= SNAP_THRESHOLD_M) {
        nextActiveId = cp.id;
        break;
      }
    }

    setActiveSnapPointId(nextActiveId);
  }, [boundaryControlPointsLocal, boundaryPosition.x, boundaryPosition.y, props.telemetrySnapshot?.pos_e, props.telemetrySnapshot?.pos_n, showBoundaryPoints]);

  const executeCommand = useCallback((cmd: import('../types/designDocument').DesignCommand) => {
    let inverseCmd: import('../types/designDocument').DesignCommand | null = null;
    setDesignDocument(prevDoc => {
      const { doc: nextDoc, inverse } = applyDesignCommand(prevDoc, cmd);
      inverseCmd = inverse;
      return nextDoc;
    });
    setTimeout(() => {
      if (inverseCmd) {
        setHistory(prev => ({
          past: [...prev.past, inverseCmd!],
          future: []
        }));
      }
    }, 0);
  }, []);

  const handleDragStart = useCallback(() => {
    dragStartDocRef.current = designDocument;
  }, [designDocument]);

  const handleDragEnd = useCallback(() => {
    if (!dragStartDocRef.current) return;
    const startDoc = dragStartDocRef.current;
    dragStartDocRef.current = null;

    const commands: import('../types/designDocument').DesignCommand[] = [];
    for (const node of designDocument.nodes) {
      const startNode = startDoc.nodes.find(n => n.id === node.id);
      if (!startNode) continue;

      if (isDesignInstance(node) && isDesignInstance(startNode)) {
        const tStart = startNode.transform;
        const tEnd = node.transform;
        if (
          tStart.northM !== tEnd.northM ||
          tStart.eastM !== tEnd.eastM ||
          tStart.rotationDeg !== tEnd.rotationDeg ||
          tStart.scale !== tEnd.scale
        ) {
          commands.push({
            type: "UpdateInstanceTransform",
            nodeId: node.id,
            before: { ...tStart },
            after: { ...tEnd }
          });
        }
      } else if (isDesignEntity(node) && isDesignEntity(startNode)) {
        const vStart = startNode.vertices;
        const vEnd = node.vertices;
        let changed = vStart.length !== vEnd.length;
        if (!changed) {
          for (let i = 0; i < vStart.length; i++) {
            if (vStart[i].northM !== vEnd[i].northM || vStart[i].eastM !== vEnd[i].eastM) {
              changed = true;
              break;
            }
          }
        }
        if (changed) {
          commands.push({
            type: "UpdateEntityVertices",
            nodeId: node.id,
            before: [...vStart],
            after: [...vEnd]
          });
        }
      }
    }

    if (commands.length > 0) {
      const batchCmd: import('../types/designDocument').DesignCommand = commands.length === 1 ? commands[0] : { type: "Batch", commands };
      const { inverse } = applyDesignCommand(startDoc, batchCmd);
      setHistory(prev => ({
        past: [...prev.past, inverse],
        future: []
      }));
    }
  }, [designDocument]);

  const handleUndo = useCallback(() => {
    setHistory(prev => {
      if (prev.past.length === 0) return prev;
      const cmd = prev.past[prev.past.length - 1];
      const newPast = prev.past.slice(0, -1);
      
      let invOfInv: import('../types/designDocument').DesignCommand | null = null;
      setDesignDocument(prevDoc => {
        const { doc: nextDoc, inverse } = applyDesignCommand(prevDoc, cmd);
        invOfInv = inverse;
        return nextDoc;
      });
      
      return {
        past: newPast,
        future: invOfInv ? [...prev.future, invOfInv] : prev.future
      };
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory(prev => {
      if (prev.future.length === 0) return prev;
      const cmd = prev.future[prev.future.length - 1];
      const newFuture = prev.future.slice(0, -1);
      
      let invOfInv: import('../types/designDocument').DesignCommand | null = null;
      setDesignDocument(prevDoc => {
        const { doc: nextDoc, inverse } = applyDesignCommand(prevDoc, cmd);
        invOfInv = inverse;
        return nextDoc;
      });
      
      return {
        past: invOfInv ? [...prev.past, invOfInv] : prev.past,
        future: newFuture
      };
    });
  }, []);

  // Check if pending values differ from active
  const hasBoundaryChanges =
    pendingWidth !== activeBoundaryWidth ||
    pendingHeight !== activeBoundaryHeight ||
    pendingIndent !== activeIndentSpacing ||
    pendingLetterSpacingCm !== activeLetterSpacingCm;

  const previewLines = useMemo(() => {
    if (category === "shapes") return generateTemplateLines(shape, parsedSize, arcType);
    if (category === "alphabets") return generateAlphabetLines(selectedLetter, parsedSize, fontStyle);
    if (category === "numbers") return generateNumberLines(selectedDigit, parsedSize, fontStyle);
    if (category === "road_signs") return generateRoadSignLines(selectedSign, parsedSize);
    if (category === "sports_fields") return generateSportsFieldLines(selectedField, parsedSize);
    if (category === "characters") return generateTextLines(previewText, parsedSize, fontStyle, pendingCharSpacingCm / 100);
    return [];
  }, [category, shape, selectedLetter, selectedDigit, selectedSign, selectedField, parsedSize, arcType, fontStyle, previewText, pendingCharSpacingCm]);



  const computeBoundingBox = useCallback((lines: PlanLine[]): { width: number; height: number } => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const line of lines) {
      minX = Math.min(minX, line.from.x, line.to.x);
      maxX = Math.max(maxX, line.from.x, line.to.x);
      minY = Math.min(minY, line.from.y, line.to.y);
      maxY = Math.max(maxY, line.from.y, line.to.y);
    }
    return {
      width: Math.max(0.5, maxX - minX || 0.5),
      height: Math.max(0.5, maxY - minY || 0.5),
    };
  }, []);
  const handleAddToBoundary = useCallback(() => {
    if (previewLines.length === 0) return;
    const bounds = computeBoundingBox(previewLines);
    
    const newWidth = bounds.width;
    const newHeight = bounds.height;
    
    // Boundary size validation ONLY for sports fields
    if (category === "sports_fields") {
      const safeW = bw - 2 * indent;
      const safeH = bh - 2 * indent;
      if (newWidth > safeW || newHeight > safeH) {
        Alert.alert(
          "Cannot Add Sports Field",
          `This field (${newWidth.toFixed(1)}m × ${newHeight.toFixed(1)}m) is larger than your available boundary space (${safeW.toFixed(1)}m × ${safeH.toFixed(1)}m).\n\nPlease increase your boundary size first.`
        );
        return; // Block addition
      }
    }
    
    let newX = 0;
    let newY = 0;
    
    if (boundaryMode) {
      if (placedItems.length === 0) {
        newX = -bw / 2 + indent + newWidth / 2;
        newY = 0;
      } else {
        const lastItem = placedItems[placedItems.length - 1];
        newX = lastItem.x + lastItem.width / 2 + newWidth / 2 + lSpacing;
        newY = lastItem.y;
        
        const rightEdge = bw / 2 - indent;
        if (newX + newWidth / 2 > rightEdge) {
          newX = -bw / 2 + indent + newWidth / 2;
          newY = lastItem.y - Math.max(lastItem.height, newHeight) - 0.2;
        }
      }
    } else {
      const roverN = props.telemetrySnapshot?.pos_n ?? 0;
      const roverE = props.telemetrySnapshot?.pos_e ?? 0;
      if (placedItems.length === 0) {
        newX = roverE + 2.0;
        newY = roverN;
      } else {
        const lastItem = placedItems[placedItems.length - 1];
        newX = lastItem.x + lastItem.width / 2 + newWidth / 2 + lSpacing;
        newY = lastItem.y;
      }
    }
    
    const templateId = snapshotTemplateId(previewLines);
    if (!templateRegistryRef.current.hasTemplate(templateId)) {
      const def = createTemplateDefinition(templateId, previewLines, newWidth, newHeight);
      templateRegistryRef.current.registerTemplate(def);
    }
    
    const newNode = createDesignInstance(
      `item-${Date.now()}`,
      templateId,
      {
        northM: newY,
        eastM: newX,
        rotationDeg: 0,
        scale: 1.0,
      }
    );
    
    executeCommand({ type: "AddNode", node: newNode });
    setSelectedItemIds([newNode.id]);
  }, [previewLines, computeBoundingBox, placedItems, lSpacing, bw, bh, indent, category, executeCommand]);

  const handleDeleteItem = useCallback(() => {
    const nodesToDelete = designDocument.nodes.filter(n => selectedItemIds.includes(n.id));
    if (nodesToDelete.length === 0) return;
    
    const cmds: import('../types/designDocument').DesignCommand[] = nodesToDelete.map(node => ({
      type: "DeleteNode",
      nodeId: node.id,
      snapshot: node
    }));
    
    executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    setSelectedItemIds([]);
  }, [designDocument.nodes, selectedItemIds, executeCommand]);

  const handleAutoArrange = useCallback(() => {
    if (placedItems.length === 0) return;
    const usableWidth = Math.max(0.1, bw - 2 * indent);
    const totalItemsWidth = placedItems.reduce((sum, item) => sum + item.width, 0);
    const totalGaps = (placedItems.length - 1) * lSpacing;
    const spaceNeeded = totalItemsWidth + totalGaps;
    if (spaceNeeded > usableWidth) {
      Alert.alert("Too Wide", 
        `Items need ${(spaceNeeded * 100).toFixed(0)}cm but boundary provides ${(usableWidth * 100).toFixed(0)}cm. Reduce scale or increase boundary width.`
      );
      return;
    }
    
    const leftIndentEdge = -bw / 2 + indent;
    let cursorX = leftIndentEdge;
    const centerY = 0;
    
    const cmds: import('../types/designDocument').DesignCommand[] = [];
    placedItems.forEach(item => {
      const centerX = cursorX + item.width / 2;
      cursorX += item.width + lSpacing;
      
      const node = designDocument.nodes.find(n => n.id === item.id);
      if (node && isDesignInstance(node)) {
        cmds.push({
          type: "UpdateInstanceTransform",
          nodeId: node.id,
          before: { ...node.transform },
          after: {
            ...node.transform,
            eastM: centerX,
            northM: centerY
          }
        });
      }
    });
    
    if (cmds.length > 0) {
      executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    }
  }, [placedItems, designDocument.nodes, bw, indent, lSpacing, executeCommand]);

  const handleApplyScale = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const val = parseFloat(itemScaleStr);
    const targetScale = Math.max(0.1, isNaN(val) ? 1.0 : val);
    
    const cmds: import('../types/designDocument').DesignCommand[] = [];
    designDocument.nodes.forEach(node => {
      if (!selectedItemIds.includes(node.id)) return;
      if (isDesignInstance(node)) {
        cmds.push({
          type: "UpdateInstanceTransform",
          nodeId: node.id,
          before: { ...node.transform },
          after: { ...node.transform, scale: targetScale }
        });
      }
    });
    
    if (cmds.length > 0) {
      executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    }
  }, [selectedItemIds, itemScaleStr, designDocument.nodes, executeCommand]);

  const handleApplyRotation = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const val = parseFloat(itemRotationStr);
    const targetRot = isNaN(val) ? 0 : (val % 360);
    
    const cmds: import('../types/designDocument').DesignCommand[] = [];
    designDocument.nodes.forEach(node => {
      if (!selectedItemIds.includes(node.id)) return;
      if (isDesignInstance(node)) {
        cmds.push({
          type: "UpdateInstanceTransform",
          nodeId: node.id,
          before: { ...node.transform },
          after: { ...node.transform, rotationDeg: targetRot }
        });
      }
    });
    
    if (cmds.length > 0) {
      executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    }
  }, [selectedItemIds, itemRotationStr, designDocument.nodes, executeCommand]);

  const handleApplyCoordinates = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const node = designDocument.nodes.find(n => n.id === selectedItemIds[0]);
    if (!node) return;

    const nVal = parseFloat(itemNorthStr);
    const eVal = parseFloat(itemEastStr);
    if (isNaN(nVal) || isNaN(eVal)) return;

    if (isDesignInstance(node)) {
      executeCommand({
        type: "UpdateInstanceTransform",
        nodeId: node.id,
        before: { ...node.transform },
        after: { ...node.transform, northM: nVal, eastM: eVal }
      });
    } else if (isDesignEntity(node) && node.type === "LINE") {
      const v0 = node.vertices[0];
      const v1 = node.vertices[1];
      if (v0 && v1) {
        const dn = nVal - v0.northM;
        const de = eVal - v0.eastM;
        executeCommand({
          type: "UpdateEntityVertices",
          nodeId: node.id,
          before: [...node.vertices],
          after: [
            { northM: nVal, eastM: eVal },
            { northM: v1.northM + dn, eastM: v1.eastM + de }
          ]
        });
      }
    }
  }, [selectedItemIds, itemNorthStr, itemEastStr, designDocument.nodes, executeCommand]);

  const handleApplyLengthAngle = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const node = designDocument.nodes.find(n => n.id === selectedItemIds[0]);
    if (!node || !isDesignEntity(node) || node.type !== "LINE") return;

    const length = parseFloat(lineLengthStr);
    const angleDeg = parseFloat(lineAngleStr);
    if (isNaN(length) || isNaN(angleDeg)) return;

    const v0 = node.vertices[0];
    if (v0) {
      const angleRad = (angleDeg * Math.PI) / 180;
      const newV1 = {
        northM: v0.northM + length * Math.cos(angleRad),
        eastM: v0.eastM + length * Math.sin(angleRad)
      };
      executeCommand({
        type: "UpdateEntityVertices",
        nodeId: node.id,
        before: [...node.vertices],
        after: [v0, newV1]
      });
    }
  }, [selectedItemIds, lineLengthStr, lineAngleStr, designDocument.nodes, executeCommand]);

  const handleScaleGroupToBoundary = useCallback((mode: "fit" | "fill") => {
    if (selectedItemIds.length === 0) return;
    const firstItem = placedItems.find(p => selectedItemIds.includes(p.id));
    if (!firstItem || !firstItem.groupId) return;
    
    const groupItems = placedItems.filter(p => p.groupId === firstItem.groupId);
    if (groupItems.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    groupItems.forEach(p => {
      minX = Math.min(minX, p.x - p.width / 2);
      maxX = Math.max(maxX, p.x + p.width / 2);
      minY = Math.min(minY, p.y - p.height / 2);
      maxY = Math.max(maxY, p.y + p.height / 2);
    });

    const gw = maxX - minX;
    const gh = maxY - minY;
    if (gw <= 0 || gh <= 0) return;

    const safeW = bw - 2 * indent;
    const safeH = bh - 2 * indent;

    const scaleX = safeW / gw;
    const scaleY = safeH / gh;

    const scaleMultiplier = mode === "fit" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
    
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const cmds: import('../types/designDocument').DesignCommand[] = [];
    designDocument.nodes.forEach(node => {
      if (node.metadata?.groupId !== firstItem.groupId) return;
      if (isDesignInstance(node)) {
        const dx = node.transform.eastM - cx;
        const dy = node.transform.northM - cy;
        const newX = dx * scaleMultiplier;
        const newY = dy * scaleMultiplier;
        
        cmds.push({
          type: "UpdateInstanceTransform",
          nodeId: node.id,
          before: { ...node.transform },
          after: {
            northM: newY,
            eastM: newX,
            rotationDeg: node.transform.rotationDeg,
            scale: node.transform.scale * scaleMultiplier
          }
        });
      }
    });
    
    if (cmds.length > 0) {
      executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    }
  }, [placedItems, selectedItemIds, bw, bh, indent, designDocument.nodes, executeCommand]);

  const handleGroupItems = useCallback(() => {
     if (selectedItemIds.length < 2) return;
     const groupId = "grp-" + Date.now();
     const cmds: import('../types/designDocument').DesignCommand[] = designDocument.nodes
       .filter(n => selectedItemIds.includes(n.id))
       .map(node => ({
         type: "UpdateNodeGroupId",
         nodeId: node.id,
         before: node.metadata?.groupId as string | undefined,
         after: groupId
       }));
     executeCommand({ type: "Batch", commands: cmds });
  }, [selectedItemIds, designDocument.nodes, executeCommand]);

  const handleUngroupItems = useCallback(() => {
    const firstItem = designDocument.nodes.find(p => selectedItemIds.includes(p.id));
    if (!firstItem?.metadata?.groupId) return;
    const groupId = firstItem.metadata.groupId as string;
    
    const cmds: import('../types/designDocument').DesignCommand[] = designDocument.nodes
      .filter(n => n.metadata?.groupId === groupId)
      .map(node => ({
        type: "UpdateNodeGroupId",
        nodeId: node.id,
        before: groupId,
        after: undefined
      }));
      
    executeCommand({ type: "Batch", commands: cmds });
    setSelectedItemIds([firstItem.id]);
  }, [designDocument.nodes, selectedItemIds, executeCommand]);

  const handleCopyItems = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const nodesToCopy = designDocument.nodes.filter(n => selectedItemIds.includes(n.id));
    if (nodesToCopy.length === 0) return;

    const offset = 0.5;
    const cmds: import('../types/designDocument').DesignCommand[] = [];
    const newIds: string[] = [];
    const groupMapping: Record<string, string> = {};

    nodesToCopy.forEach(node => {
      const newId = `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      newIds.push(newId);

      let newGroupId: string | undefined = undefined;
      const grpId = node.metadata?.groupId as string | undefined;
      if (grpId) {
        if (!groupMapping[grpId]) {
          groupMapping[grpId] = `grp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        }
        newGroupId = groupMapping[grpId];
      }

      if (isDesignInstance(node)) {
        const newNode = createDesignInstance(
          newId,
          node.templateId,
          {
            northM: node.transform.northM - offset,
            eastM: node.transform.eastM + offset,
            rotationDeg: node.transform.rotationDeg,
            scale: node.transform.scale,
          },
          { ...node.metadata, groupId: newGroupId }
        );
        cmds.push({ type: "AddNode", node: newNode });
      } else if (isDesignEntity(node)) {
        const newNode = createDesignEntity(
          newId,
          node.type,
          node.layer,
          node.vertices.map(v => ({ northM: v.northM - offset, eastM: v.eastM + offset })),
          node.width,
          { ...node.metadata, groupId: newGroupId }
        );
        cmds.push({ type: "AddNode", node: newNode });
      }
    });

    executeCommand(cmds.length === 1 ? cmds[0] : { type: "Batch", commands: cmds });
    setSelectedItemIds(newIds);
  }, [designDocument.nodes, selectedItemIds, executeCommand]);

  const handleParse = async () => {
    if (!props.apiBaseUrl) return;
    let finalLines: PlanLine[] = [];
    let title = "";

    if (boundaryMode) {
      if (placedItems.length === 0) {
        Alert.alert("Empty Boundary", "No items placed in boundary.");
        return;
      }
      title = `Boundary_${bw}x${bh}_${new Date().toISOString().slice(0,10)}`;
      const flattened = flattenDesignDocument(designDocument, templateRegistryRef.current);
      flattened.forEach((l) => {
        const fx = l.from.x; // north
        const fy = l.from.y; // east
        const tx = l.to.x;   // north
        const ty = l.to.y;   // east
        
        finalLines.push({
          ...l,
          entity: {
            entity_id: l.id,
            entity_type: "LINE",
            layer: "MARKING",
            color: 3,
            is_mark: true,
            length_m: Math.hypot(tx - fx, ty - fy),
            geometry: {},
            preview_points: [
              { north: fx, east: fy },
              { north: tx, east: ty },
            ],
          } as DxfEntity,
        });
      });
    } else {
      if (previewLines.length === 0) {
        Alert.alert("Empty Template", "No valid template to generate.");
        return;
      }
      const getSelectedTemplateName = () => {
        if (category === "shapes") {
          return `${shape.charAt(0).toUpperCase() + shape.slice(1)}_Template_${parsedSize}m`;
        } else if (category === "alphabets") {
          return `Letter_${selectedLetter}_${fontStyle}_${parsedSize}m`;
        } else if (category === "numbers") {
          return `Number_${selectedDigit}_${fontStyle}_${parsedSize}m`;
        } else if (category === "sports_fields") {
          return `Sports_Field_${selectedField}_${parsedSize}m`;
        } else if (category === "characters") {
          return `Text_${previewText || "Empty"}_${parsedSize}m`;
        } else {
          return `Road_Sign_${parsedSize}m`;
        }
      };
      title = getSelectedTemplateName();
      finalLines = previewLines;
    }

    setIsParsing(true);
    try {
      const fileName = `${title.replace(/\s+/g, "_")}.dxf`;
      const fileContent = linesToDxf(finalLines, fileName);
      const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, fileContent, { encoding: FileSystem.EncodingType.UTF8 });

      const formData = new FormData();
      formData.append("file", { uri: fileUri, name: fileName, type: "application/dxf" } as any);

      const res = await fetch(`${props.apiBaseUrl}/api/path/parse-dxf`, { method: "POST", body: formData });
      if (res.ok) {
        Alert.alert("Success", `Template "${fileName}" sent. Switching to alignment view.`);
        props.onRefreshPaths();
        props.onSelectPath(fileName);
        setTimeout(() => props.onNav("fields"), 500);
      } else {
        const errText = await res.text();
        Alert.alert("Parse Failed", errText || "Unknown error");
      }
    } catch (err: any) {
      console.log("Error parsing template:", err);
      Alert.alert("Error", err.message || "Failed to send template to backend.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleApplyBoundary = useCallback(() => {
    setActiveBoundaryWidth(pendingWidth);
    setActiveBoundaryHeight(pendingHeight);
    setActiveIndentSpacing(pendingIndent);
    setActiveLetterSpacingCm(pendingLetterSpacingCm);
  }, [pendingWidth, pendingHeight, pendingIndent, pendingLetterSpacingCm]);

  const handleMoveBoundary = useCallback((x: number, y: number) => {
    if (typeof x !== "number" || typeof y !== "number" || isNaN(x) || isNaN(y)) return;
    setBoundaryPosition({ x, y });
  }, []);

  const handlePlaceRoverAtPoint = useCallback((pointId: string, localX: number, localY: number) => {
    if (previewLines.length === 0) return;
    const bounds = computeBoundingBox(previewLines);
    
    const newWidth = bounds.width;
    const newHeight = bounds.height;
    
    if (category === "sports_fields") {
      const safeW = bw - 2 * indent;
      const safeH = bh - 2 * indent;
      if (newWidth > safeW || newHeight > safeH) {
        Alert.alert(
          "Cannot Add Sports Field",
          `This field (${newWidth.toFixed(1)}m × ${newHeight.toFixed(1)}m) is larger than your available boundary space (${safeW.toFixed(1)}m × ${safeH.toFixed(1)}m).\n\nPlease increase your boundary size first.`
        );
        return;
      }
    }
    
    const newItem: PlacedItem = {
      id: "item-" + Date.now(),
      lines: previewLines,
      x: localX,
      y: localY,
      rotation: 0,
      scale: 1.0,
      width: newWidth,
      height: newHeight,
    };
    setPlacedItems(prev => [...prev, newItem]);
    setSelectedItemIds([newItem.id]);
  }, [previewLines, computeBoundingBox, category, bw, indent, bh]);

  const memoSetSelectedItemIds = useCallback((ids: string[]) => {
    setSelectedItemIds(ids);
  }, []);

  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ width: "58%", backgroundColor: "transparent", padding: 14 }}>
        <View style={{ flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
          {(boundaryMode || placedItems.length > 0) && props.mapViewEnabled ? (
            <MapView
              mode="templates"
              visible={true}
              telemetrySnapshot={props.telemetrySnapshot}
              lines={[]}
              alignedRefPoints={[]}
              placedItems={placedItems}
              selectedItemIds={selectedItemIds}
              multiTouchMode={multiTouchMode}
              lockPanDrag={lockPanDrag}
              lockZoom={lockZoom}
              boundaryWidth={bw}
              boundaryHeight={bh}
              indentSpacing={indent}
              sketchMode={sketchMode}
              boundaryPosition={boundaryPosition}
              onMoveBoundary={handleMoveBoundary}
              showBoundaryPoints={showBoundaryPoints}
              activeSnapPointId={activeSnapPointId}
              onPlaceRoverAtPoint={handlePlaceRoverAtPoint}
              onUpdatePlacedItems={(items) => setPlacedItems(items)}
              onSelectionChange={(ids) => setSelectedItemIds(ids)}
              previewAnchor={previewAnchor}
            />
          ) : (boundaryMode || placedItems.length > 0) ? (
            <BoundaryEditor
              boundaryWidth={bw}
              boundaryHeight={bh}
              indentSpacing={indent}
              letterSpacing={lSpacing}
              items={placedItems}
              setItems={setPlacedItems}
              selectedItemIds={selectedItemIds}
              setSelectedItemIds={memoSetSelectedItemIds}
              multiTouchMode={multiTouchMode}
              sketchMode={sketchMode}
              boundaryPosition={boundaryPosition}
              onMoveBoundary={handleMoveBoundary}
              showBoundaryPoints={showBoundaryPoints}
              activeSnapPointId={activeSnapPointId}
              onPlaceRoverAtPoint={handlePlaceRoverAtPoint}
              activeTool={activeTool}
              onAddEntity={(entity) => executeCommand({ type: "AddNode", node: entity })}
              worldLines={worldLines}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ) : (
            <View style={{ flex: 1, position: "relative" }}>
              {props.renderPlanPreview({
                lines: previewLines,
                visibility: props.layerVisibility,
                selectedLineId: props.selectedLineId,
                onSelectLine: props.onSelectLine,
                roverPosN: props.previewRoverPoint?.north ?? null,
                roverPosE: props.previewRoverPoint?.east ?? null,
                roverHeadingDeg: props.telemetrySnapshot?.heading_ned_deg ?? null,
              })}
            </View>
          )}
        </View>
      </View>
      
      <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 12 }}>
            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
              <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
                Templates
              </Text>
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 5 }}>
                {boundaryMode ? "Boundary Mode" : "Generator"}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                 <Text style={{ color: "#cbd5e1", fontSize: 13, fontWeight: "700" }}>Use Boundary Concept</Text>
                 <Switch value={boundaryMode} onValueChange={setBoundaryMode} trackColor={{ false: "#334155", true: "#0b6b68" }} thumbColor={"#f8fafc"} />
              </View>
              {boundaryMode && (
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                   <Text style={{ color: "#cbd5e1", fontSize: 13, fontWeight: "700" }}>Sketch Mode</Text>
                   <Switch value={sketchMode} onValueChange={setSketchMode} trackColor={{ false: "#334155", true: "#0b6b68" }} thumbColor={"#f8fafc"} />
                </View>
              )}
              {boundaryMode && (
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 }}>
                   <Text style={{ color: "#cbd5e1", fontSize: 13, fontWeight: "700" }}>Show Snap Points</Text>
                   <Switch value={showBoundaryPoints} onValueChange={setShowBoundaryPoints} trackColor={{ false: "#334155", true: "#0b6b68" }} thumbColor={"#f8fafc"} />
                </View>
              )}
              {boundaryMode && (
                <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#1e293b", paddingTop: 12 }}>
                  <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", marginBottom: 8, textTransform: "uppercase" }}>Active Tool</Text>
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                    {(["SELECT", "LINE"] as const).map(tool => (
                      <Pressable
                        key={tool}
                        onPress={() => setActiveTool(tool)}
                        style={{
                          flex: 1,
                          height: 36,
                          borderRadius: 8,
                          backgroundColor: activeTool === tool ? "#0b6b68" : "#1e293b",
                          alignItems: "center",
                          justifyContent: "center",
                          borderWidth: 1,
                          borderColor: activeTool === tool ? "#0b6b68" : "#334155",
                        }}
                      >
                        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{tool}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable
                      onPress={handleUndo}
                      disabled={history.past.length === 0}
                      style={{
                        flex: 1,
                        height: 36,
                        borderRadius: 8,
                        backgroundColor: history.past.length === 0 ? "#1e293b" : "#ef4444",
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: history.past.length === 0 ? 0.4 : 1,
                      }}
                    >
                      <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>Undo ({history.past.length})</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleRedo}
                      disabled={history.future.length === 0}
                      style={{
                        flex: 1,
                        height: 36,
                        borderRadius: 8,
                        backgroundColor: history.future.length === 0 ? "#1e293b" : "#3b82f6",
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: history.future.length === 0 ? 0.4 : 1,
                      }}
                    >
                      <Text style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>Redo ({history.future.length})</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>

            {boundaryMode && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 12 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>Boundary Settings</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Width (m)</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff" }} value={boundaryWidthStr} onChangeText={setBoundaryWidthStr} keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Height (m)</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff" }} value={boundaryHeightStr} onChangeText={setBoundaryHeightStr} keyboardType="numeric" />
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Indent Spacing</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff" }} value={indentSpacingStr} onChangeText={setIndentSpacingStr} keyboardType="numeric" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Letter Spacing (cm)</Text>
                    <TextInput style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff" }} value={letterSpacingStr} onChangeText={setLetterSpacingStr} keyboardType="numeric" />
                  </View>
                </View>

                
                {hasBoundaryChanges && (
                  <Pressable
                    onPress={handleApplyBoundary}
                    style={({ pressed }) => ({
                      height: 44,
                      borderRadius: 10,
                      backgroundColor: "#0f988f",
                      borderWidth: 1.5,
                      borderColor: "#14b8a6",
                      alignItems: "center",
                      justifyContent: "center",
                      marginTop: 6,
                      flexDirection: "row",
                      elevation: 4,
                      shadowColor: "#000",
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: 0.3,
                      shadowRadius: 3.84,
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800", letterSpacing: 0.5 }}>
                      ✓ Apply Boundary Changes
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                Category
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {(["shapes", "alphabets", "numbers", "road_signs", "sports_fields", "characters"] as const).map((c) => (
                  <Pressable
                    key={c}
                    onPress={() => setCategory(c)}
                    style={{
                      flexBasis: "47%",
                      padding: 8,
                      borderRadius: 12,
                      backgroundColor: category === c ? "#0b6b68" : "#f8fafc",
                      borderWidth: 1,
                      borderColor: category === c ? "#0b6b68" : "#e2e8f0",
                      alignItems: "center"
                    }}
                  >
                    <Text style={{ color: category === c ? "#fff" : "#0f172a", fontSize: 13, fontWeight: "800", textTransform: "capitalize" }}>
                      {c.replace("_", " ")}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {category === "sports_fields" && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                  Sports Fields
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {(Object.keys(SPORTS_FIELD_LABELS) as SportsFieldType[]).map((f) => (
                    <Pressable
                      key={f}
                      onPress={() => setSelectedField(f)}
                      style={{
                        flexBasis: "47%",
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: selectedField === f ? "#0f172a" : "#f1f5f9",
                        borderWidth: 1,
                        borderColor: selectedField === f ? "#0f172a" : "#e2e8f0",
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ color: selectedField === f ? "#ffffff" : "#475569", fontSize: 12, fontWeight: "700", textAlign: "center" }}>
                        {SPORTS_FIELD_LABELS[f]}
                      </Text>
                      <Text style={{ color: selectedField === f ? "#94a3b8" : "#94a3b8", fontSize: 10, marginTop: 2, textAlign: "center" }}>
                        {SPORTS_FIELD_BOUNDS[f].naturalWidth}m × {SPORTS_FIELD_BOUNDS[f].naturalHeight}m
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {category === "characters" && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 12 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                  Characters Input
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <TextInput
                    style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff", fontSize: 14, fontWeight: "700" }}
                    value={inputText}
                    onChangeText={setInputText}
                    placeholder="Type characters..."
                    placeholderTextColor="#94a3b8"
                    autoCapitalize="characters"
                  />
                  {inputText.trim().length > 0 && (
                    <Pressable
                      onPress={() => setPreviewText(inputText)}
                      style={{ paddingHorizontal: 16, height: 44, borderRadius: 8, backgroundColor: "#0b6b68", alignItems: "center", justifyContent: "center" }}
                    >
                      <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>OK</Text>
                    </Pressable>
                  )}
                </View>
                {previewText.length > 0 && (
                  <Text style={{ color: "#475569", fontSize: 12, fontWeight: "600" }}>
                    Active Text: <Text style={{ color: "#0b6b68", fontWeight: "800" }}>"{previewText}"</Text>
                  </Text>
                )}
                
                <View style={{ marginTop: 4 }}>
                  <Text style={{ color: "#475569", fontSize: 12, marginBottom: 4, fontWeight: "600" }}>Characters Spacing (cm)</Text>
                  <TextInput
                    style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, height: 44, color: "#0f172a", backgroundColor: "#ffffff", fontSize: 14 }}
                    value={charSpacingStr}
                    onChangeText={setCharSpacingStr}
                    keyboardType="numeric"
                    placeholder="10"
                    placeholderTextColor="#94a3b8"
                  />
                </View>
              </View>
            )}

            {(category === "alphabets" || category === "numbers" || category === "characters") && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                  Font Style
                </Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {(["smooth"] as FontStyle[]).map((f) => (
                    <Pressable
                      key={f}
                      onPress={() => setFontStyle(f)}
                      style={{
                        flex: 1,
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: fontStyle === f ? "#0f172a" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: fontStyle === f ? "#0f172a" : "#e2e8f0",
                        alignItems: "center"
                      }}
                    >
                      <Text style={{ color: fontStyle === f ? "#fff" : "#0f172a", fontSize: 14, fontWeight: "800", textTransform: "capitalize" }}>
                        {f}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                Selection
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {category === "shapes" && ([] as ShapeType[]).concat(["square", "circle", "triangle"]).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setShape(s)}
                      style={{
                        width: "30%",
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: shape === s ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: shape === s ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center"
                      }}
                    >
                      <Text style={{ color: shape === s ? "#fff" : "#0f172a", fontSize: 13, fontWeight: "800", textTransform: "capitalize" }}>
                        {s}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "alphabets" && Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map((l) => (
                    <Pressable
                      key={l}
                      onPress={() => setSelectedLetter(l as AlphabetType)}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 12,
                        backgroundColor: selectedLetter === l ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: selectedLetter === l ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                    >
                      <Text style={{ color: selectedLetter === l ? "#fff" : "#0f172a", fontSize: 18, fontWeight: "800" }}>
                        {l}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "numbers" && Array.from("0123456789").map((n) => (
                    <Pressable
                      key={n}
                      onPress={() => setSelectedDigit(n as NumberType)}
                      style={{
                        width: 50,
                        height: 50,
                        borderRadius: 12,
                        backgroundColor: selectedDigit === n ? "#0b6b68" : "#f8fafc",
                        borderWidth: 1,
                        borderColor: selectedDigit === n ? "#0b6b68" : "#e2e8f0",
                        alignItems: "center",
                        justifyContent: "center"
                      }}
                    >
                      <Text style={{ color: selectedDigit === n ? "#fff" : "#0f172a", fontSize: 20, fontWeight: "800" }}>
                        {n}
                      </Text>
                    </Pressable>
                  ))}

                  {category === "road_signs" && (Object.keys(ROAD_SIGN_LABELS) as RoadSignType[]).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setSelectedSign(s)}
                      style={{
                        flexBasis: "31%",
                        padding: 12,
                        borderRadius: 12,
                        backgroundColor: selectedSign === s ? "#0f172a" : "#f1f5f9",
                        borderWidth: 1,
                        borderColor: selectedSign === s ? "#0f172a" : "#e2e8f0",
                        alignItems: "center",
                      }}
                    >
                      <Text style={{ color: selectedSign === s ? "#ffffff" : "#475569", fontSize: 13, fontWeight: "700", textAlign: "center" }}>
                        {ROAD_SIGN_LABELS[s]}
                      </Text>
                    </Pressable>
                  ))}
              </View>

              {category === "shapes" && shape === "circle" && (
                <View style={{ marginTop: 20 }}>
                  <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                    Arc Type
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    {([] as ArcType[]).concat(["quarter", "half", "full"]).map((a) => (
                      <Pressable
                        key={a}
                        onPress={() => setArcType(a)}
                        style={{
                          flex: 1,
                          padding: 12,
                          borderRadius: 12,
                          backgroundColor: arcType === a ? "#0b6b68" : "#f8fafc",
                          borderWidth: 1,
                          borderColor: arcType === a ? "#0b6b68" : "#e2e8f0",
                          alignItems: "center"
                        }}
                      >
                        <Text style={{ color: arcType === a ? "#fff" : "#0f172a", fontSize: 14, fontWeight: "800", textTransform: "capitalize" }}>
                          {a === "full" ? "Full" : a === "half" ? "Half" : "Quarter"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              <View style={{ marginTop: 20 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
                  Size (Scale)
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Slider
                      style={{ width: "100%", height: 40 }}
                      minimumValue={0.1}
                      maximumValue={category === "sports_fields" ? 500.0 : 15.0}
                      step={0.1}
                      value={parsedSize}
                      onValueChange={(val) => setSizeInput(val.toFixed(2))}
                      minimumTrackTintColor="#0f988f"
                      maximumTrackTintColor="#cbd5e1"
                      thumbTintColor="#0f172a"
                    />
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 10 }}>
                    <TextInput
                      value={sizeInput}
                      onChangeText={setSizeInput}
                      keyboardType="numeric"
                      style={{ width: 44, height: 40, color: "#0f172a", fontSize: 14, fontWeight: "700", textAlign: "right" }}
                    />
                    <Text style={{ color: "#64748b", fontSize: 14, fontWeight: "700", marginLeft: 2 }}>m</Text>
                  </View>
                </View>
                <Text style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>
                  {category === "shapes" ? (shape === "circle" ? "Diameter in meters" : shape === "square" ? "Side length in meters" : "Height in meters") : "Height in meters"}
                </Text>
              </View>
            </View>

            {boundaryMode && selectedItemIds.length > 0 && placedItems.find(p => selectedItemIds.includes(p.id))?.groupId && (
              <View style={{ flexDirection: "row", gap: 8, marginVertical: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => setMultiTouchMode(multiTouchMode === "scale" ? "both" : "scale")}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: multiTouchMode === "scale" ? "#0ea5e9" : "#f1f5f9", borderWidth: 1, borderColor: "#cbd5e1" }}
                >
                  <Text style={{ color: multiTouchMode === "scale" ? "#fff" : "#475569", fontWeight: "700", fontSize: 12 }}>Scale Only</Text>
                </Pressable>
                <Pressable
                  onPress={() => setMultiTouchMode(multiTouchMode === "rotate" ? "both" : "rotate")}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: multiTouchMode === "rotate" ? "#0ea5e9" : "#f1f5f9", borderWidth: 1, borderColor: "#cbd5e1" }}
                >
                  <Text style={{ color: multiTouchMode === "rotate" ? "#fff" : "#475569", fontWeight: "700", fontSize: 12 }}>Rotate Only</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleScaleGroupToBoundary("fit")}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: "#0b6b68" }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>Fit</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleScaleGroupToBoundary("fill")}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: "#0f988f" }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>Fill</Text>
                </Pressable>
              </View>
            )}

            {boundaryMode && selectedItemIds.length > 0 && selectedItemIds[0] !== "boundary" && (() => {
              const selectedNode = designDocument.nodes.find(n => n.id === selectedItemIds[0]);
              if (!selectedNode) return null;
              return (
                <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 8 }}>
                  <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                    Transform Selected
                  </Text>
                  
                  {isDesignInstance(selectedNode) && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ color: "#475569", fontSize: 12, fontWeight: "600", width: 60 }}>Scale:</Text>
                      <TextInput
                        style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                        value={itemScaleStr}
                        onChangeText={setItemScaleStr}
                        keyboardType="numeric"
                      />
                      <Pressable
                        onPress={handleApplyScale}
                        style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: "#0b6b68" }}
                      >
                        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply</Text>
                      </Pressable>
                    </View>
                  )}
                  
                  {isDesignInstance(selectedNode) && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ color: "#475569", fontSize: 12, fontWeight: "600", width: 60 }}>Angle:</Text>
                      <TextInput
                        style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                        value={itemRotationStr}
                        onChangeText={setItemRotationStr}
                        keyboardType="numeric"
                      />
                      <Pressable
                        onPress={handleApplyRotation}
                        style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: "#6366f1" }}
                      >
                        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply</Text>
                      </Pressable>
                    </View>
                  )}
                  
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: "#475569", fontSize: 12, fontWeight: "600", width: 60 }}>Position:</Text>
                    <View style={{ flex: 1, flexDirection: "row", gap: 4 }}>
                      <TextInput
                        placeholder="N (m)"
                        style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                        value={itemNorthStr}
                        onChangeText={setItemNorthStr}
                        keyboardType="numeric"
                      />
                      <TextInput
                        placeholder="E (m)"
                        style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                        value={itemEastStr}
                        onChangeText={setItemEastStr}
                        keyboardType="numeric"
                      />
                    </View>
                    <Pressable
                      onPress={handleApplyCoordinates}
                      style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: "#0b6b68" }}
                    >
                      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply</Text>
                    </Pressable>
                  </View>
                  
                  {isDesignEntity(selectedNode) && selectedNode.type === "LINE" && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ color: "#475569", fontSize: 12, fontWeight: "600", width: 60 }}>L & A:</Text>
                      <View style={{ flex: 1, flexDirection: "row", gap: 4 }}>
                        <TextInput
                          placeholder="Len (m)"
                          style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                          value={lineLengthStr}
                          onChangeText={setLineLengthStr}
                          keyboardType="numeric"
                        />
                        <TextInput
                          placeholder="Ang (deg)"
                          style={{ flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 6, color: "#0f172a" }}
                          value={lineAngleStr}
                          onChangeText={setLineAngleStr}
                          keyboardType="numeric"
                        />
                      </View>
                      <Pressable
                        onPress={handleApplyLengthAngle}
                        style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: "#6366f1" }}
                      >
                        <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Apply</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              );
            })()}

            {boundaryMode && props.mapViewEnabled && (
              <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 10 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                  Map View Controls
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={() => setLockPanDrag(!lockPanDrag)}
                    style={{ flex: 1, height: 38, borderRadius: 8, backgroundColor: lockPanDrag ? "#ef4444" : "#f1f5f9", borderWidth: 1, borderColor: "#cbd5e1", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: lockPanDrag ? "#fff" : "#475569", fontWeight: "700", fontSize: 12 }}>
                      {lockPanDrag ? "Pan: Locked" : "Pan: Active"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setLockZoom(!lockZoom)}
                    style={{ flex: 1, height: 38, borderRadius: 8, backgroundColor: lockZoom ? "#ef4444" : "#f1f5f9", borderWidth: 1, borderColor: "#cbd5e1", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: lockZoom ? "#fff" : "#475569", fontWeight: "700", fontSize: 12 }}>
                      {lockZoom ? "Zoom: Locked" : "Zoom: Active"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}

            {(boundaryMode || previewLines.length > 0) && (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <Pressable
                  onPress={handleAddToBoundary}
                  style={({ pressed }) => ({
                    flex: 1,
                    minWidth: 100,
                    height: 48,
                    borderRadius: 12,
                    backgroundColor: "#0ea5e9",
                    borderWidth: 1.5,
                    borderColor: "#38bdf8",
                    alignItems: "center",
                    justifyContent: "center",
                    elevation: 4,
                    shadowColor: "#000",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.3,
                    shadowRadius: 4,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.5 }}>+ Add</Text>
                </Pressable>
                
                {placedItems.length > 1 && (
                  <Pressable
                    onPress={handleAutoArrange}
                    style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: "#2563eb", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Arrange</Text>
                  </Pressable>
                )}
                
                {selectedItemIds.length > 1 && (
                  <Pressable
                    onPress={handleGroupItems}
                    style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: "#6366f1", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Group</Text>
                  </Pressable>
                )}
                
                {selectedItemIds.length > 0 && placedItems.find(p => selectedItemIds.includes(p.id))?.groupId && (
                  <Pressable
                    onPress={handleUngroupItems}
                    style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: "#f59e0b", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Ungroup</Text>
                  </Pressable>
                )}
                
                {selectedItemIds.length > 0 && (
                  <Pressable
                    onPress={handleCopyItems}
                    style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: "#10b981", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Copy</Text>
                  </Pressable>
                )}
                
                {selectedItemIds.length > 0 && (
                  <Pressable
                    onPress={handleDeleteItem}
                    style={{ height: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: "#ef4444", alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>Delete</Text>
                  </Pressable>
                )}
              </View>
            )}

            <Pressable
              onPress={handleParse}
              disabled={isParsing || (boundaryMode ? placedItems.length === 0 : previewLines.length === 0)}
              style={{
                height: 52,
                borderRadius: 14,
                backgroundColor: isParsing || (boundaryMode ? placedItems.length === 0 : previewLines.length === 0) ? "#94a3b8" : "#0f988f",
                alignItems: "center",
                justifyContent: "center",
                marginTop: 10,
                marginBottom: 20
              }}
            >
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                {isParsing ? "Parsing..." : "Parse & Send to Alignment"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
