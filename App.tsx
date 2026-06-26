import "react-native-gesture-handler";
import "./global.css";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  LogBox,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

import Slider from "@react-native-community/slider";
import * as FileSystem from "expo-file-system/legacy";
import * as DocumentPicker from "expo-document-picker";
import { SafeAreaInsetsContext, SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView, TouchableOpacity as RNGHTouchableOpacity, GestureDetector, Gesture } from "react-native-gesture-handler";
import AnimatedReanimated, { runOnJS, useSharedValue } from "react-native-reanimated";

import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from "react-native-svg";
import { io, Socket } from "socket.io-client";
import {
  Battery,
  CircleHelp,
  LayoutTemplate,
  ListChecks,
  File,
  FilePenLine,
  FileUp,
  FileText,
  Info,
  LocateFixed,
  LogOut,
  List,
  Menu,
  RadioTower,
  Settings,
  Signal,
  Tractor,
  Trash2,
  ChevronRight,
  Waves,
  X,
  RotateCcw,
  RotateCw,
  Eye,
  EyeOff,
  Map as MapIcon,
  Check as CheckIcon,
  Gamepad2,
} from "lucide-react-native";

import { BoundaryEditor, PlacedItem } from "./src/components/BoundaryEditor";
import { DeadmanButton } from "./src/components/DeadmanButton";
import { ManualJoystick } from "./src/components/ManualJoystick";
import { useVirtualJoystick } from "./src/hooks/useVirtualJoystick";
import { readImportedPlanFile, normalizePlanLines } from "./src/utils/planImport";
import type { ImportedPlan, PlanLine } from "./src/types/plan";
import * as missionApi from "./src/api/missionApi";
import {
  buildMissionStartPayload,
  classifyMissionError,
  evaluateMissionStartGate,
  getLoadedMissionId,
  invalidateWorkflowFrom,
  isProtectedMissionResident,
  runningMissionMismatch,
  verifyStagedLoadedMission,
} from "./src/api/missionContract";
import * as pathApi from "./src/api/pathApi";
import { generateTemplateLines, ShapeType, ArcType } from "./src/utils/shapeTemplates";
import { generateAlphabetLines, generateNumberLines, FontStyle, AlphabetType, NumberType } from "./src/utils/characterTemplates";
import { generateRoadSignLines, RoadSignType, ROAD_SIGN_LABELS } from "./src/utils/roadSignTemplates";
import { canAcquireJoystick as canAcquireJoystickForState } from "./src/utils/joystickFrontendSafety";

import type { Page, TelemetrySnapshot, LayerVisibility } from "./src/types/plan";
import { TemplatesPage } from "./src/screens/TemplatesPage";
import { MapView } from "./src/components/MapView";
import {
  buildVisualAlignmentRefPoints,
  computeLineBoundingBox,
} from "./src/utils/visualAlignment";
import {
  anchorToAlignedRefPoints,
  stagedMissionMatchesId,
  waypointsToPlanLines,
} from "./src/utils/stagedMissionHydration";
import { enforceAlignmentScale } from "./src/utils/designAlignmentPolicy";
import type { AutoOriginReference, MapGeometryFrame } from "./src/types/autoOrigin";
import {
  applyAutoOriginShift,
  buildAutoOriginReference,
  planStartMatchesReference,
} from "./src/utils/autoOrigin";
import { resolveMapGeometryFrame } from "./src/utils/mapGeometryProjection";

LogBox.ignoreLogs(["Maximum update depth exceeded"]);

const MAX_PREVIEW_CORNERS = 450;
const PATH_SEGMENT_CHUNK_SIZE = 650;
const PREVIEW_ARROWHEAD_LENGTH_PX = 14;
const PREVIEW_ARROWHEAD_HALF_WIDTH_PX = 5;
const PREVIEW_RENDERED_LAYERS = ["boundary", "center", "transit", "extension", "marking_true", "marking_false"] as const;

type PreviewRenderedLayer = (typeof PREVIEW_RENDERED_LAYERS)[number];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

function formatFinite(value: unknown, digits = 2, fallback = "n/a") {
  const next = coerceFiniteNumber(value);
  return next == null ? fallback : next.toFixed(digits);
}

const PRIMARY_ENTITY_TYPES = new Set(["line", "arc", "circle"]);

function normalizeEntityType(entityType: unknown) {
  return String(entityType ?? "").trim().toLowerCase();
}

type NormalizedExtensionRole = "PRE" | "AFT" | "none";

type NormalizedPathSegment = {
  index: number;
  sequence: number;
  type: "MARK" | "TRANSIT" | string;
  extensionRole: NormalizedExtensionRole;
  sprayOn: boolean;
  sourceEntity: string;
  lengthM: number | null;
};

function normalizeSegmentType(rawType: unknown): "MARK" | "TRANSIT" | string {
  const type = String(rawType ?? "").trim().toUpperCase();
  if (type === "MARK") return "MARK";
  if (type === "TRANSIT") return "TRANSIT";
  return type || "UNKNOWN";
}

function normalizeExtensionRole(segment: pathApi.PathSegmentInfo): NormalizedExtensionRole {
  const roleSources = [segment.segment_role, segment.extension_role];
  for (const raw of roleSources) {
    const role = String(raw ?? "").trim().toLowerCase();
    if (role === "pre" || role === "pre_transit") return "PRE";
    if (role === "aft" || role === "aft_transit") return "AFT";
  }
  return "none";
}

function normalizePathSegment(segment: pathApi.PathSegmentInfo): NormalizedPathSegment {
  return {
    index: segment.index,
    sequence: segment.sequence,
    type: normalizeSegmentType(segment.type),
    extensionRole: normalizeExtensionRole(segment),
    sprayOn: !!segment.spray_on,
    sourceEntity: String(segment.source_entity ?? "").trim(),
    lengthM: coerceFiniteNumber(segment.length_m),
  };
}

function summarizeNormalizedSegments(segments: pathApi.PathSegmentInfo[]) {
  const normalized = segments.map(normalizePathSegment);
  let markCount = 0;
  let transitCount = 0;
  let preExtensionCount = 0;
  let aftExtensionCount = 0;
  let sprayOnCount = 0;
  let sprayOffCount = 0;

  for (const segment of normalized) {
    if (segment.type === "MARK") markCount += 1;
    if (segment.type === "TRANSIT") transitCount += 1;
    if (segment.extensionRole === "PRE") preExtensionCount += 1;
    if (segment.extensionRole === "AFT") aftExtensionCount += 1;
    if (segment.sprayOn) sprayOnCount += 1;
    else sprayOffCount += 1;
  }

  return {
    normalized,
    markCount,
    transitCount,
    preExtensionCount,
    aftExtensionCount,
    sprayOnCount,
    sprayOffCount,
  };
}

function parsePathSegmentsResponse(data: unknown): pathApi.PathSegmentsResponse | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, "segments")) return null;
  if (!Array.isArray(body.segments)) return null;
  if (body.segments.length === 0) return null;
  return body as pathApi.PathSegmentsResponse;
}

function formatExtensionRoleLabel(role: NormalizedExtensionRole) {
  if (role === "PRE") return "pre";
  if (role === "AFT") return "aft";
  return "none";
}

function formatWaypointPair(waypoints: unknown): string {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return "n/a";
  const formatPoint = (point: unknown) => {
    if (!Array.isArray(point) || point.length < 2) return "n/a";
    return `[${formatFinite(point[0], 2)}, ${formatFinite(point[1], 2)}]`;
  };
  return `${formatPoint(waypoints[0])} → ${formatPoint(waypoints[waypoints.length - 1])}`;
}

function parsePlanAndStageResponse(data: unknown): { plan: pathApi.PathPlanResponse; missionId: string } | null {
  if (!data || typeof data !== "object") return null;
  const plan = data as pathApi.PathPlanResponse;
  const missionId = plan.mission_summary?.mission_id ?? plan.mission_id;
  if (typeof missionId !== "string" || missionId.trim() === "") return null;
  return { plan, missionId: missionId.trim() };
}

function formatSprayFlagSample(loaded: missionApi.LoadedPathResponse): string {
  if (!loaded.has_spray_flags) return "n/a";
  return `mark ${loaded.num_mark} / transit ${loaded.num_transit}`;
}

type StagedStartGate = {
  isStagedWorkflow: boolean;
  allowed: boolean;
  message: string | null;
};

function evaluateStagedStartGate(
  stagedWorkflow: StagedWorkflowState,
  loadedPathInspection: missionApi.LoadedPathResponse | null,
  stagedMissionId: string | null
): StagedStartGate {
  return evaluateMissionStartGate({
    stagedVerified: stagedWorkflow.staged === "verified",
    loadedVerified: stagedWorkflow.loaded === "verified",
    stagedMissionId,
    loaded: loadedPathInspection,
    alignmentVerified: stagedWorkflow.alignment === "verified",
  });
}

function isPrimaryEditableLine(line: PlanLine) {
  if (line.layer === "transit" || line.layer === "extension") {
    return false;
  }

  return PRIMARY_ENTITY_TYPES.has(normalizeEntityType(line.entity?.entity_type));
}

function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
) {
  const EARTH_RADIUS = 6378137.0;
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const originLatRad = (originLat * Math.PI) / 180;
  const originLonRad = (originLon * Math.PI) / 180;

  const north = (latRad - originLatRad) * EARTH_RADIUS;
  const east = (lonRad - originLonRad) * EARTH_RADIUS * Math.cos(originLatRad);

  return { north, east };
}

function getPlanStartPoint(lines: PlanLine[]) {
  // Prefer the first executed non-spray leg when the backend plan overlay is
  // present. With path extensions enabled, runtime-transit-0 is the PRE run-up
  // before entity A, so auto-origin must anchor there instead of at A itself.
  const runtimeStartLine = lines.find((line) => line.id === "runtime-transit-0");
  const fallbackPreExtensionLine = lines.find(
    (line) => line.layer === "extension" && line.id.startsWith("ext-pre-")
  );
  const primaryLine =
    runtimeStartLine ?? fallbackPreExtensionLine ?? lines.find(isPrimaryEditableLine) ?? lines[0];
  if (!primaryLine) return null;

  const north = coerceFiniteNumber(primaryLine.from?.x);
  const east = coerceFiniteNumber(primaryLine.from?.y);
  if (north == null || east == null) return null;

  return { north, east };
}

function createUploadFormData(fileUri: string, fileName: string, mimeType: string) {
  const form = new FormData();
  form.append("file", {
    uri: fileUri,
    name: fileName,
    type: mimeType,
  } as any);
  return form;
}

function ReorderableLineList({
  data,
  onDragEnd,
}: {
  data: PlanLine[];
  onDragEnd: (next: PlanLine[]) => void;
}) {
  const moveItem = useCallback((fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= data.length || fromIndex === toIndex) return;
    const next = [...data];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onDragEnd(next);
  }, [data, onDragEnd]);

  return (
    <FlatList
      data={data}
      keyExtractor={(item: PlanLine) => item.id}
      style={{ flex: 1 }}
      renderItem={({ item, index }) => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: 14,
            backgroundColor: "#fff",
            borderBottomWidth: 1,
            borderBottomColor: "#f1f5f9",
            gap: 10,
          }}
        >
          <View style={{ width: 20, alignItems: "center" }}>
            <Text style={{ color: "#94a3b8", fontSize: 20, fontWeight: "800" }}>≡</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "700" }}>
              {item.label} <Text style={{ color: "#64748b", fontWeight: "500", fontSize: 12 }}>({item.entity?.entity_type})</Text>
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => moveItem(index, index - 1)}
              disabled={index === 0}
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: index === 0 ? "#e2e8f0" : "#0f172a",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900" }}>↑</Text>
            </Pressable>
            <Pressable
              onPress={() => moveItem(index, index + 1)}
              disabled={index === data.length - 1}
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: index === data.length - 1 ? "#e2e8f0" : "#0f172a",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900" }}>↓</Text>
            </Pressable>
          </View>
        </View>
      )}
    />
  );
}

function isRenderableLine(line: PlanLine | null | undefined): line is PlanLine {
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

function sanitizePlanLines(lines: PlanLine[]) {
  return lines.filter(isRenderableLine);
}

function buildSvgPathChunks(lines: PlanLine[]) {
  const chunks: string[] = [];
  let current = "";
  let count = 0;

  for (const line of lines) {
    if (!isRenderableLine(line)) continue;

    if (line.entity && line.entity.preview_points && line.entity.preview_points.length > 1) {
      const pts = line.entity.preview_points;
      current += `M${pts[0].east} ${pts[0].north}`;
      for (let i = 1; i < pts.length; i++) {
        current += `L${pts[i].east} ${pts[i].north}`;
      }
    } else {
      current += `M${line.from.y} ${line.from.x}L${line.to.y} ${line.to.x}`;
    }

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

function buildSvgPathForLine(line: PlanLine) {
  return buildSvgPathChunks([line]).join(" ");
}

function getLineAnchorPoint(line: PlanLine) {
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

type DiscoveredRover = {
  id: string;
  name: string;
  host: string;
  port: number;
  version?: string;
  responseTime?: number;
};

type SystemHealth = {
  ros_node?: boolean;
  fcu_connected?: boolean;
  armed?: boolean;
  mode?: string;
  rpp_state?: string | number | null;
  pose_age_ms?: number | null;
  mission_state?: string | null;
};



type ActivityEntry = {
  timestamp: string;
  level: string;
  message: string;
};

type ToastTone = "info" | "success" | "warning" | "error";
type AppToast = {
  id: number;
  title: string;
  message: string;
  tone: ToastTone;
};

type StagedWorkflowStep = "upload" | "entities" | "order" | "alignment" | "spray" | "staged" | "loaded" | "started";
type StagedWorkflowStatus = "pending" | "verified" | "failed";
type StagedWorkflowState = Record<StagedWorkflowStep, StagedWorkflowStatus>;

const INITIAL_STAGED_WORKFLOW_STATE: StagedWorkflowState = {
  upload: "pending",
  entities: "pending",
  order: "pending",
  alignment: "pending",
  spray: "pending",
  staged: "pending",
  loaded: "pending",
  started: "pending",
};

const BG = "#d9d9dc";
const TOP = "#ececee";
const GREEN = "#eef2f7";
const GREEN_DARK = "#f8fafc";
const TEAL = "#0f988f";
const LOCAL_WS_CANDIDATES = [
  "http://localhost:5001",
  "http://127.0.0.1:5001",
];
const PRIORITY_BACKEND_IPS: string[] = [];

const DISCOVERY_REFRESH_MS = 5000;
const DISCOVERY_PORT = 5001;
const SUBNET_HOST_MIN = 1;
const SUBNET_HOST_MAX = 254;
const SUBNET_SCAN_CONCURRENCY = 24;
const DEFAULT_ROVER_BACKEND = "http://192.168.1.102:5001";
/** Set via Jetson ~/.rover_token when auth is enabled; empty when ROVER_DISABLE_AUTH=1 */
const ROVER_AUTH_TOKEN = "";

const MENU_ITEMS: Array<{ key: Page; label: string; icon: React.ReactNode }> = [
  { key: "fields", label: "Fields", icon: <File size={22} color="#fff" /> },
  { key: "templates", label: "Templates", icon: <LayoutTemplate size={22} color="#fff" /> },
  { key: "swozi", label: "Swozi", icon: <Tractor size={22} color="#fff" /> },
  { key: "status", label: "Status", icon: <Waves size={22} color="#fff" /> },
  { key: "positioning", label: "Positioning", icon: <LocateFixed size={22} color="#fff" /> },
  { key: "settings", label: "Settings", icon: <Settings size={22} color="#fff" /> },
  { key: "howto", label: "How To", icon: <CircleHelp size={22} color="#fff" /> },
  { key: "about", label: "About", icon: <Info size={22} color="#fff" /> },
];

export default function App() {
  const [page, setPage] = useState<Page>("connection");
  const [menuOpen, setMenuOpen] = useState(true);
  const [selectedWs, setSelectedWs] = useState<string>("");
  const [manualHost, setManualHost] = useState<string>(() => {
    if (typeof window !== "undefined" && window.location && window.location.hostname) {
      const host = window.location.hostname;
      if (host && host !== "localhost" && host !== "127.0.0.1") {
        return `http://${host}:5001`;
      }
    }
    return DEFAULT_ROVER_BACKEND;
  });
  const [wsStatus, setWsStatus] = useState<"idle" | "scanning" | "ready" | "connecting" | "connected" | "error">("idle");
  const [wsError, setWsError] = useState<string>("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [discoveredRovers, setDiscoveredRovers] = useState<DiscoveredRover[]>([]);
  const [backendPinned, setBackendPinned] = useState(false);
  const [fieldGeneratorOpen, setFieldGeneratorOpen] = useState(false);
  const [importedPlan, setImportedPlan] = useState<ImportedPlan | null>(null);
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  // 1. Mode Toggle State
  const [isVisualAlignmentMode, setIsVisualAlignmentMode] = useState(false);

  // 2. The temporary "Sticker" holding all DXF lines
  const [visualAlignmentItem, setVisualAlignmentItem] = useState<PlacedItem | null>(null);

  // 3. Trigger Function: Bundles lines into one item
  function startVisualAlignment() {
    console.log("[Align DXF] startVisualAlignment: Initiating visual alignment mode.");
    if (lines.length === 0) {
      console.log("[Align DXF] startVisualAlignment: No lines available to align, aborting.");
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    lines.forEach(line => {
      if (line.from && line.to) {
        minX = Math.min(minX, line.from.x, line.to.x);
        minY = Math.min(minY, line.from.y, line.to.y);
        maxX = Math.max(maxX, line.from.x, line.to.x);
        maxY = Math.max(maxY, line.from.y, line.to.y);
      }
    });

    setVisualAlignmentItem({
      id: "visual-alignment-group",
      lines: lines,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      width: maxX - minX,
      height: maxY - minY,
    });

    console.log(`[Align DXF] startVisualAlignment: Created visual sticker. Width: ${maxX - minX}, Height: ${maxY - minY}`);
    setIsVisualAlignmentMode(true);
  }

  function handleConfirmVisualAlignment() {
    console.log("[Align DXF] handleConfirmVisualAlignment: Confirming visual alignment position.");
    if (!visualAlignmentItem) {
      console.log("[Align DXF] handleConfirmVisualAlignment: visualAlignmentItem is null, aborting.");
      return;
    }

    const { minX, minY, maxX, maxY } = computeLineBoundingBox(lines);
    const dxfCorners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];

    const baseLat = telemetrySnapshot?.lat ?? 28.6139;
    const baseLon = telemetrySnapshot?.lon ?? 77.2090;

    const extractedLLA = buildVisualAlignmentRefPoints(
      dxfCorners,
      visualAlignmentItem,
      baseLat,
      baseLon
    );

    console.log("Captured LLA reference points for rover:", extractedLLA);

    // Keep canonical DXF lines unchanged; retain the sticker transform for map preview.
    setExtractedCorners(extractedLLA);
    setIsVisualAlignmentMode(false);
  }
  const [extractedCorners, setExtractedCorners] = useState<{ dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    boundary: true,
    marking: true,
    center: true,
    transit: true,
    extension: true,
  });
  const [showRefPointLabels, setShowRefPointLabels] = useState(false);
  const [activeRefPointLabelIndex, setActiveRefPointLabelIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!showRefPointLabels) {
      setActiveRefPointLabelIndex(null);
    }
  }, [showRefPointLabels]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [telemetrySnapshot, setTelemetrySnapshot] = useState<TelemetrySnapshot | null>(null);
  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>([]);
  const [discoveryFeed, setDiscoveryFeed] = useState<DiscoveredRover[]>([]);
  const [telemetryError, setTelemetryError] = useState<string>("");
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [missionActionBusy, setMissionActionBusy] = useState(false);
  const [missionFileReady, setMissionFileReady] = useState(false);
  const [missionLoaded, setMissionLoaded] = useState(false);
  const [missionRunning, setMissionRunning] = useState(false);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [rtkModalOpen, setRtkModalOpen] = useState(false);
  const [rtkCaster, setRtkCaster] = useState("");
  const [rtkPort, setRtkPort] = useState("2101");
  const [rtkMountPoint, setRtkMountPoint] = useState("");
  const [rtkUsername, setRtkUsername] = useState("");
  const [rtkPassword, setRtkPassword] = useState("");
  const [rtkConnecting, setRtkConnecting] = useState(false);
  const [rtkRunning, setRtkRunning] = useState(false);
  const [rtkHealthy, setRtkHealthy] = useState(false);
  const [toggleA, setToggleA] = useState(false);
  const [toggleB, setToggleB] = useState(false);
  const [toggleC, setToggleC] = useState(true);
  const [toggleD, setToggleD] = useState(false);
  const [delayA, setDelayA] = useState(0.1);
  const [delayB, setDelayB] = useState(0.1);
  const [backendPaths, setBackendPaths] = useState<any[]>([]);
  const [selectedPathName, setSelectedPathName] = useState<string | null>(null);
  const [stagedWorkflow, setStagedWorkflow] = useState<StagedWorkflowState>(INITIAL_STAGED_WORKFLOW_STATE);
  const [alignmentResult, setAlignmentResult] = useState<AlignmentResultState | null>(null);
  const [verifiedAlignmentRequest, setVerifiedAlignmentRequest] = useState<pathApi.AlignPathRequest | null>(null);
  const [segmentVerification, setSegmentVerification] = useState<pathApi.PathSegmentsResponse | null>(null);
  const [stagedPlanResult, setStagedPlanResult] = useState<StagedPlanResultState | null>(null);
  const [stagedMissionInspection, setStagedMissionInspection] = useState<pathApi.StagedMissionResponse | null>(null);
  const [stagedMissionId, setStagedMissionId] = useState<string | null>(null);
  const [loadedPathInspection, setLoadedPathInspection] = useState<missionApi.LoadedPathResponse | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [extensionsEnabled, setExtensionsEnabled] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");

  const [prevMissionState, setPrevMissionState] = useState<string | null>(null);

  const [autoOrigin, setAutoOrigin] = useState(false);
  const [autoOriginReference, setAutoOriginReference] = useState<AutoOriginReference | null>(null);
  const [alignedRefPoints, setAlignedRefPoints] = useState<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>([]);
  const protectedMissionResident = isProtectedMissionResident(loadedPathInspection);
  const autoOriginEligible =
    autoOrigin &&
    stagedWorkflow.staged !== "verified" &&
    alignedRefPoints.length === 0;
  const missionStateRef = useRef<string | null>(null);
  const [mapViewEnabled, setMapViewEnabled] = useState(false);

  const toggleAutoOrigin = useCallback(() => {
    setAutoOrigin((prev) => {
      const next = !prev;
      if (!next) {
        setAutoOriginReference(null);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    missionStateRef.current = telemetrySnapshot?.mission_state ?? null;
  }, [telemetrySnapshot?.mission_state]);

  useEffect(() => {
    if (!autoOriginEligible) {
      setAutoOriginReference(null);
    }
  }, [autoOriginEligible]);

  useEffect(() => {
    if (!autoOriginEligible || autoOriginReference) return;
    const captured = buildAutoOriginReference(sanitizePlanLines(lines), telemetrySnapshot);
    if (captured) {
      setAutoOriginReference(captured);
    }
  }, [autoOriginEligible, autoOriginReference, lines, telemetrySnapshot]);

  useEffect(() => {
    if (!autoOriginReference) return;
    if (!planStartMatchesReference(lines, autoOriginReference)) {
      setAutoOriginReference(null);
    }
  }, [lines, autoOriginReference]);

  const mapSourceLines = useMemo(() => sanitizePlanLines(lines), [lines]);

  const displayedLines = useMemo(() => {
    const base = mapSourceLines;
    if (!autoOriginEligible || !autoOriginReference) return base;
    return applyAutoOriginShift(base, autoOriginReference);
  }, [mapSourceLines, autoOriginEligible, autoOriginReference]);

  const mapGeometryFrame = useMemo(
    () =>
      resolveMapGeometryFrame({
        mode: "fields",
        alignedRefPoints,
        stagedVerified: stagedWorkflow.staged === "verified",
        autoOriginReference,
        autoOriginEnabled: autoOriginEligible,
      }),
    [alignedRefPoints, stagedWorkflow.staged, autoOriginReference, autoOriginEligible]
  );

  // [CANVAS] frame-alignment debug. Logs the auto-origin transform whenever the
  // captured origin, run-state, or rover pose changes, so a wrong rover-icon
  // placement can be diagnosed against the drawn path's first point.
  useEffect(() => {
    if (!autoOriginEligible) return;
    const first = getPlanStartPoint(sanitizePlanLines(lines));
    const rover =
      telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
        ? { n: telemetrySnapshot.pos_n, e: telemetrySnapshot.pos_e }
        : null;
    console.log("[CANVAS] frame", JSON.stringify({
      missionRunning,
      missionState: telemetrySnapshot?.mission_state ?? null,
      autoOriginReference,
      planFirstPoint: first,
      roverTelemetry: rover,
      delta: autoOriginReference && first
        ? {
            dN: autoOriginReference.roverNorth - autoOriginReference.planStartNorth,
            dE: autoOriginReference.roverEast - autoOriginReference.planStartEast,
          }
        : null,
    }));
  }, [
    autoOriginEligible,
    missionRunning,
    autoOriginReference,
    telemetrySnapshot?.mission_state,
    telemetrySnapshot?.pos_n,
    telemetrySnapshot?.pos_e,
    lines,
  ]);

  const previewRoverPoint = useMemo(() => {
    const telemetryPoint =
      telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null
        ? { north: telemetrySnapshot.pos_n, east: telemetrySnapshot.pos_e }
        : null;
    const planStartPoint = getPlanStartPoint(displayedLines);

    // ALWAYS use real telemetry when available, so the icon shows the true rover position
    return telemetryPoint ?? planStartPoint;
  }, [
    displayedLines,
    telemetrySnapshot?.pos_e,
    telemetrySnapshot?.pos_n,
  ]);

  const frozenRoverPos = useMemo(() => {
    if (telemetrySnapshot?.pos_n == null || telemetrySnapshot?.pos_e == null) {
      return null;
    }

    return { n: telemetrySnapshot.pos_n, e: telemetrySnapshot.pos_e };
  }, [telemetrySnapshot?.pos_n, telemetrySnapshot?.pos_e]);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedWsRef = useRef(selectedWs);
  const manualHostRef = useRef(manualHost);
  const backendPinnedRef = useRef(backendPinned);
  const previousSelectedPathRef = useRef<string | null>(null);

  const activeMenu = useMemo(() => MENU_ITEMS.find((x) => x.key === page), [page]);
  const sectionTitle =
    page === "fields"
      ? "Fields"
      : activeMenu?.label ?? "Section";
  const isOffline = wsError.startsWith("Offline");
  const apiBaseUrl = selectedWs || manualHost;

  const logAction = useCallback((action: string, details?: Record<string, unknown>) => {
    const stamp = new Date().toISOString();
    if (details && Object.keys(details).length > 0) {
      console.log(`[${stamp}] [UI] ${action}`, details);
      return;
    }
    console.log(`[${stamp}] [UI] ${action}`);
  }, []);

  const showToast = useCallback((title: string, message: string, tone: ToastTone = "info") => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    const id = Date.now();
    setToast({ id, title, message, tone });
    toastTimerRef.current = setTimeout(() => {
      setToast((current) => (current?.id === id ? null : current));
    }, 2800);
  }, []);

  const virtualJoystick = useVirtualJoystick({
    socket,
    authToken: ROVER_AUTH_TOKEN,
    socketConnected: wsStatus === "connected",
    onErrorMessage: (title, message) => showToast(title, message, "error"),
  });
  const virtualJoystickRef = useRef(virtualJoystick);
  virtualJoystickRef.current = virtualJoystick;

  const setWorkflowStep = useCallback((step: StagedWorkflowStep, status: StagedWorkflowStatus) => {
    setStagedWorkflow((prev) => (prev[step] === status ? prev : { ...prev, [step]: status }));
  }, []);

  const invalidateStagedWorkflowFrom = useCallback((step: "alignment" | "spray" | "staged" | "loaded") => {
    setStagedWorkflow((prev) => invalidateWorkflowFrom(prev, step));

    if (step === "alignment") {
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
    }
    if (step === "alignment" || step === "spray") {
      setSegmentVerification(null);
    }
    if (step === "alignment" || step === "spray" || step === "staged") {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
    }
    setLoadedPathInspection(null);
    setMissionLoaded(false);
  }, []);

  const reconcileLoadedMission = useCallback((
    loaded: missionApi.LoadedPathResponse,
    status?: missionApi.MissionStatus
  ) => {
    const inspection = {
      ...loaded,
      running_mission_id: status?.running_mission_id ?? loaded.running_mission_id ?? null,
    };
    setLoadedPathInspection(inspection);

    if (stagedWorkflow.staged === "verified" && stagedMissionId) {
      const verification = verifyStagedLoadedMission(inspection, stagedMissionId);
      setMissionLoaded(verification.verified);
      setStagedWorkflow((prev) => ({
        ...prev,
        loaded: verification.verified ? "verified" : "pending",
        started: verification.verified ? prev.started : "pending",
      }));
      return;
    }

    setMissionLoaded(Boolean(inspection.loaded && !isProtectedMissionResident(inspection)));
  }, [stagedMissionId, stagedWorkflow.staged]);

  useEffect(() => {
    if (previousSelectedPathRef.current === selectedPathName) return;
    previousSelectedPathRef.current = selectedPathName;
    setStagedWorkflow((prev) => ({
      ...prev,
      alignment: "pending",
      spray: "pending",
      staged: "pending",
      loaded: "pending",
      started: "pending",
    }));
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setSegmentVerification(null);
    setStagedPlanResult(null);
    setStagedMissionInspection(null);
    setStagedMissionId(null);
    setLoadedPathInspection(null);
  }, [selectedPathName]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (telemetrySnapshot) {
      const currentState = telemetrySnapshot.mission_state;
      if (prevMissionState === "running" && (currentState === "idle" || currentState === "completed")) {
        setTimeout(() => {
          Alert.alert("Mission Completed", "The rover has successfully finished the mission.");
        }, 500);
      }
      setPrevMissionState(currentState ?? null);
    }
  }, [telemetrySnapshot?.mission_state, prevMissionState]);

  useEffect(() => {
    selectedWsRef.current = selectedWs;
  }, [selectedWs]);

  useEffect(() => {
    manualHostRef.current = manualHost;
  }, [manualHost]);

  useEffect(() => {
    backendPinnedRef.current = backendPinned;
  }, [backendPinned]);





  const deleteSelectedLine = () => {
    if (!selectedLineId) return;
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Editing the plan is blocked while a protected surveyed mission is resident.");
      return;
    }
    logAction("DELETE_LINE", { selectedLineId });
    setLines((prev) => {
      const next = prev.filter((line) => line.id !== selectedLineId);
      setSelectedLineId(next[0]?.id ?? null);
      if (next.length === 0) {
        setImportedPlan(null);
      }
      return next;
    });
  };

  const deleteEntirePlan = () => {
    if (protectedMissionResident) {
      Alert.alert("Mission conflict", "Deleting the plan is blocked while a protected surveyed mission is resident.");
      return;
    }
    logAction("DELETE_PLAN");
    setLines([]);
    setSelectedLineId(null);
    setImportedPlan(null);
    setAutoOriginReference(null);
    setLayerVisibility({ boundary: true, marking: true, center: true, transit: true, extension: true });
  };

  const connectSelectedWebsocket = async () => {
    const target = selectedWs || manualHost;
    if (!target) return;
    logAction("WS_CONNECT", { selectedWs: target });
    setWsStatus("connecting");
    setWsError("");

    try {
      const nextSocket = io(target, {
        transports: ["websocket"], // Use websocket ONLY - polling is unreliable in APK builds
        timeout: 20000, // Increase to 20 seconds
        forceNew: true,
      });

      await new Promise<void>((resolve, reject) => {
        nextSocket.on("connect", () => {
          resolve();
        });
        nextSocket.on("connect_error", (err) => {
          reject(err);
        });
      });

      nextSocket.on("disconnect", (reason) => {
        console.log(`[SOCKET] Disconnected from ${target} — reason: ${reason}`);
      });

      nextSocket.on("error", (err) => {
        console.error("[SOCKET] Error:", err);
      });

      nextSocket.on("telemetry", (rawData: any) => {
        let data = rawData;
        if (typeof rawData === "string") {
          try {
            data = JSON.parse(rawData);
          } catch (e) {
            console.error("[SOCKET] Failed to parse telemetry JSON:", e);
            return;
          }
        }
        if (!data || typeof data !== "object") {
          console.warn("[SOCKET] Invalid telemetry format:", data);
          return;
        }

        virtualJoystickRef.current.reconcileTelemetry(data);

        setTelemetrySnapshot((prev) => {
          if (!prev) return data;
          // Optimize updates: only set state if keys have actually changed
          if (
            prev.pos_n === data.pos_n &&
            prev.pos_e === data.pos_e &&
            prev.lat === data.lat &&
            prev.lon === data.lon &&
            prev.heading_ned_deg === data.heading_ned_deg &&
            prev.rpp_state === data.rpp_state &&
            prev.armed === data.armed &&
            prev.mode === data.mode &&
            prev.battery_pct === data.battery_pct &&
            prev.gps_fix === data.gps_fix &&
            prev.gps_sat === data.gps_sat &&
            prev.hrms === data.hrms &&
            prev.vrms === data.vrms &&
            prev.speed_m_s === data.speed_m_s &&
            prev.measured_speed_m_s === data.measured_speed_m_s &&
            prev.joystick_state === data.joystick_state &&
            prev.joystick_active === data.joystick_active &&
            prev.control_owner === data.control_owner &&
            prev.joystick_last_valid_cmd_age_ms === data.joystick_last_valid_cmd_age_ms
          ) {
            return prev;
          }
          return { ...prev, ...data };
        });

        setSystemHealth((prev) => {
          const next = {
            ros_node: true, // We are receiving socket packets, so ROS is running
            fcu_connected: data.connected ?? false,
            armed: data.armed ?? false,
            mode: data.mode ?? "UNKNOWN",
            rpp_state: data.rpp_state,
            mission_state: prev?.mission_state || "UNKNOWN",
          };
          if (
            prev &&
            prev.ros_node === next.ros_node &&
            prev.fcu_connected === next.fcu_connected &&
            prev.armed === next.armed &&
            prev.mode === next.mode &&
            prev.rpp_state === next.rpp_state &&
            prev.mission_state === next.mission_state
          ) {
            return prev;
          }
          return next;
        });
      });

      nextSocket.on("mission_status", (rawData: any) => {
        let data = rawData;
        if (typeof rawData === "string") {
          try {
            data = JSON.parse(rawData);
          } catch (e) {
            console.error("[SOCKET] Failed to parse mission_status JSON:", e);
            return;
          }
        }
        if (!data || typeof data !== "object") {
          console.warn("[SOCKET] Invalid mission_status format:", data);
          return;
        }

        if (data.state) {
          setMissionRunning(data.state === "running");
          setIsPaused(data.state === "paused");
          setTelemetrySnapshot((prev) => {
            if (prev && prev.mission_state === data.state) return prev;
            return prev ? { ...prev, mission_state: data.state } : { mission_state: data.state } as any;
          });
          setSystemHealth((prev) => {
            const next = {
              ros_node: prev?.ros_node ?? true,
              fcu_connected: prev?.fcu_connected ?? false,
              armed: prev?.armed ?? false,
              mode: prev?.mode ?? "UNKNOWN",
              rpp_state: prev?.rpp_state ?? null,
              mission_state: data.state,
            };
            if (prev && prev.mission_state === next.mission_state) return prev;
            return next;
          });
          void refreshMissionIdentity();
        }
      });

      setSocket(nextSocket);
      setWsStatus("connected");
      setSelectedWs(target);
      setManualHost(target);
      setBackendPinned(true);
      setPage("home");
      setMenuOpen(true);
      logAction("WS_CONNECTED", { apiBaseUrl: target });
    } catch (error) {
      setWsStatus("error");
      setWsError(error instanceof Error ? error.message : "Unable to connect");
      logAction("WS_CONNECT_FAILED", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const disconnectToConnectionScreen = () => {
    logAction("WS_DISCONNECT");
    socket?.disconnect();
    setSocket(null);
    setWsStatus("idle");
    setBackendPinned(false);
    setPage("connection");
    setMenuOpen(true);
  };

  const enterOfflinePreview = () => {
    logAction("OFFLINE_PREVIEW");
    socket?.disconnect();
    setSocket(null);
    setSelectedWs("");
    setBackendPinned(false);
    setWsStatus("idle");
    setWsError("");
    setPage("home");
    setMenuOpen(true);
  };

  const scanForWebsockets = async () => {
    const currentSelectedWs = selectedWsRef.current;
    const currentManualHost = manualHostRef.current;
    const isPinned = backendPinnedRef.current;
    logAction("DISCOVERY_SCAN_START", { manualHost: currentManualHost, selectedWs: currentSelectedWs, backendPinned: isPinned });
    setWsStatus("scanning");
    setWsError("");

    // Always probe the manual host directly with a fast dedicated request
    // This ensures the "Connect" button works even if subnet sweep is slow
    let manualHostReachable = false;
    if (currentManualHost) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const pingRes = await fetch(`${currentManualHost}/api/ping`, { signal: controller.signal });
        clearTimeout(timeout);
        if (pingRes.ok) {
          manualHostReachable = true;
        }
      } catch {
        // manual host not reachable, fall through to subnet sweep
      }
    }

    const candidateHosts = Array.from(
      new Set([
        ...priorityScanHosts(),
        ...LOCAL_WS_CANDIDATES,
        currentManualHost,
        ...buildSubnetSweepCandidates(currentManualHost),
      ])
    );

    const discovered = (
      await runWithConcurrency(candidateHosts, SUBNET_SCAN_CONCURRENCY, async (candidate) => {
        const responseTime = await probeBackendHost(candidate);
        if (responseTime === null) return [] as DiscoveredRover[];

        const beacons = await discoverBackendBeacons(candidate, responseTime);
        if (beacons.length > 0) {
          return beacons;
        }

        const parsed = parseHost(candidate);
        return parsed
          ? [{
            id: `${parsed.host}-${parsed.port}`,
            name: `Rover ${parsed.host.split(".").pop() ?? parsed.host}`,
            host: parsed.host,
            port: parsed.port,
            version: "1.0",
            responseTime,
          }]
          : [];
      })
    ).flat();

    discovered.sort((a, b) => {
      const aPriority = PRIORITY_BACKEND_IPS.includes(a.host);
      const bPriority = PRIORITY_BACKEND_IPS.includes(b.host);
      if (aPriority && !bPriority) return -1;
      if (!aPriority && bPriority) return 1;
      return (a.responseTime ?? 9999) - (b.responseTime ?? 9999);
    });

    const seen = new Set<string>();
    const uniqueDiscovered = discovered.filter((entry) => {
      const key = `${entry.host}:${entry.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setDiscoveredRovers(uniqueDiscovered);

    const bestHost = uniqueDiscovered[0] ? `http://${uniqueDiscovered[0].host}:${uniqueDiscovered[0].port}` : "";
    if (bestHost) {
      const currentTarget = currentSelectedWs || currentManualHost;
      if (!currentTarget || manualHostReachable) {
        // If the manual host is reachable, keep it selected
        if (manualHostReachable && currentManualHost) {
          setSelectedWs(currentManualHost);
          // Auto-connect to the manual host if it was reachable
          logAction("DISCOVERY_SCAN_MANUAL_HOST_REACHABLE", { host: currentManualHost });
        }
        if (!currentTarget) {
          setSelectedWs(bestHost);
          setManualHost(bestHost);
        }
      }
      setWsStatus("ready");
      setWsError("");
      logAction("DISCOVERY_SCAN_RESULT", { bestHost, currentTarget, manualHostReachable });
      return;
    }

    // If manual host was reachable but not in discovered list, still allow it
    if (manualHostReachable && currentManualHost) {
      const manualEntry = parseHost(currentManualHost);
      if (manualEntry) {
        const fakeRover: DiscoveredRover = {
          id: `${manualEntry.host}-${manualEntry.port}`,
          name: `Rover ${manualEntry.host.split(".").pop() ?? manualEntry.host}`,
          host: manualEntry.host,
          port: manualEntry.port,
          version: "manual",
          responseTime: 0,
        };
        setDiscoveredRovers([fakeRover]);
        setSelectedWs(currentManualHost);
        setWsStatus("ready");
        setWsError("");
        logAction("DISCOVERY_SCAN_MANUAL_FALLBACK", { host: currentManualHost });
        return;
      }
    }

    setSelectedWs("");
    setWsStatus("idle");
    setWsError("Offline: no backend found on the network.");
    logAction("DISCOVERY_SCAN_EMPTY");
  };

  const handleSelectWebsocket = useCallback(
    (value: string) => {
      logAction("WS_SELECTED", { value });
      setSelectedWs(value);
      setManualHost(value);
      setBackendPinned(true);
    },
    [logAction]
  );

  useEffect(() => {
    if (page !== "connection") return;
    void scanForWebsockets();
    const timer = setInterval(() => {
      void scanForWebsockets();
    }, DISCOVERY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [page]);

  const fetchBackendPaths = async () => {
    if (!apiBaseUrl) return;
    try {
      console.log("[API GET] /api/paths - Polling paths list...");
      const data = await pathApi.getPaths(apiBaseUrl);
      console.log(`[API GET] /api/paths - Success, found ${data.length} paths`);
      setBackendPaths(data);
    } catch (err) {
      console.log("[API GET] /api/paths - Error fetching paths:", err);
    }
  };

  const fetchWithRetry = async (request: () => Promise<Response>, retries = 2) => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await request();
        if (res.ok) return res;
        // If not ok, it might be a 404, which shouldn't be retried if the endpoint really doesn't exist
        if (res.status === 404) return res;
      } catch (err) {
        if (i === retries - 1) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    return request(); // fallback final attempt
  };

  const previewSelectedPath = async (pathName: string) => {
    if (!apiBaseUrl) return;
    setLoadedPathInspection(null);
    setMissionActionBusy(true);
    try {
      console.log(`[API GET] /api/path/${pathName}/preview - Fetching detailed preview...`);
      setSelectedPathName(pathName);
      let generatedLines: PlanLine[] = [];
      try {
        if (pathName.toLowerCase().endsWith(".dxf")) {
          const res = await fetchWithRetry(() => pathApi.getPathEntities(apiBaseUrl, pathName));
          if (res.ok) {
            const body = await res.json();
            const isEnabled = body.extension_config?.enabled ?? false;
            setExtensionsEnabled(isEnabled);
            if (body.extension_config) {
              setExtPre(String(body.extension_config.pre_extension_m ?? "0.5"));
              setExtAft(String(body.extension_config.aft_extension_m ?? "0.5"));
            }
            console.log(`[API GET] /api/path/${pathName}/entities - Success, loaded ${body.num_entities} entities`);
            setWorkflowStep("entities", "verified");
            const entities = body.entities || [];
            // Per-entity extension run-ups are only drawn in the fallback path.
            // When /plan succeeds, extensions arrive as non-spray runs in the
            // authoritative merged waypoints, so we must not draw them twice.
            const fallbackExtLines: PlanLine[] = [];

            entities.forEach((ent: any, i: number) => {
              const layerUpper = String(ent.layer || "").toUpperCase();
              let layerName: PlanLine["layer"] = "marking"; // default to marking
              if (layerUpper.includes("BOUND")) layerName = "boundary";
              else if (layerUpper.includes("CENTER")) layerName = "center";
              else if (layerUpper.includes("MARK")) layerName = "marking";

              // Use the first and last preview_points for 'from' and 'to'
              const pts = ent.preview_points || [];
              const fromPt = pts[0] || { north: 0, east: 0 };
              const toPt = pts[pts.length - 1] || fromPt;

              generatedLines.push({
                id: ent.entity_id || `dxf-ent-${i}`,
                label: `${ent.entity_type || "Entity"} ${ent.entity_id || i}`,
                layer: layerName,
                from: { id: i * 2 + 1, x: fromPt.north, y: fromPt.east },
                to: { id: i * 2 + 2, x: toPt.north, y: toPt.east },
                width: 0.1,
                is_mark: ent.is_mark,
                entity: ent,
              });

              // Add extensions if enabled (buffered — only drawn in fallback)
              if (ent.extension_preview && ent.extension_preview.enabled) {
                if (ent.extension_preview.pre_points && ent.extension_preview.pre_points.length >= 2) {
                  const pre = ent.extension_preview.pre_points;
                  fallbackExtLines.push({
                    id: `ext-pre-${ent.entity_id || i}`,
                    label: `Pre-extension ${ent.entity_id || i}`,
                    layer: "extension",
                    from: { id: i * 100 + 1, x: pre[0].north, y: pre[0].east },
                    to: { id: i * 100 + 2, x: pre[pre.length - 1].north, y: pre[pre.length - 1].east },
                    width: 0.1,
                    entity: { ...ent, preview_points: pre }
                  });
                }
                if (ent.extension_preview.aft_points && ent.extension_preview.aft_points.length >= 2) {
                  const aft = ent.extension_preview.aft_points;
                  fallbackExtLines.push({
                    id: `ext-aft-${ent.entity_id || i}`,
                    label: `Aft-extension ${ent.entity_id || i}`,
                    layer: "extension",
                    from: { id: i * 100 + 3, x: aft[0].north, y: aft[0].east },
                    to: { id: i * 100 + 4, x: aft[aft.length - 1].north, y: aft[aft.length - 1].east },
                    width: 0.1,
                    entity: { ...ent, preview_points: aft }
                  });
                }
              }
            });

            // Authoritative runtime path overlay.
            //
            // The /entities `transit_preview` connects MARK entities in *saved
            // order* with straight crossings — it never runs the shape grouper /
            // optimizer the mission uses. For connected loops (e.g. a square,
            // where all 4 sides chain into one run) and multi-shape DXFs it
            // therefore draws phantom transits the rover never drives, so the
            // preview disagrees with the executed mission.
            //
            // Instead, overlay the exact merged waypoints /plan publishes — the
            // single source of truth for what the rover does. MARK waypoints are
            // already shown as editable entity lines above, so we draw only the
            // non-spray runs here (real inter-shape transits + extension
            // run-ups). Result: preview == mission for any DXF. Falls back to the
            // legacy per-entity extensions + straight transit_preview when /plan
            // is unavailable (offline / older backend), so the operator always
            // gets a usable picture.
            let runtimePathApplied = false;
            try {
              const planRes = await pathApi.planPath(apiBaseUrl, { source: pathName, include_waypoints: true });
              if (planRes.ok) {
                const planData = await planRes.json();
                const wps = Array.isArray(planData.merged_waypoints) ? planData.merged_waypoints : [];
                const sprayFlags = Array.isArray(planData.spray_flags) ? planData.spray_flags : [];
                if (wps.length >= 2) {
                  for (let i = 0; i < wps.length - 1; i++) {
                    const isMark = sprayFlags[i] ?? true;
                    if (isMark) continue; // marks already drawn as editable entity lines
                    const fromNorth = coerceFiniteNumber(wps[i]?.[0]);
                    const fromEast = coerceFiniteNumber(wps[i]?.[1]);
                    const toNorth = coerceFiniteNumber(wps[i + 1]?.[0]);
                    const toEast = coerceFiniteNumber(wps[i + 1]?.[1]);
                    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) continue;
                    generatedLines.push({
                      id: `runtime-transit-${i}`,
                      label: "Transit",
                      layer: "transit",
                      from: { id: 900000 + i * 2 + 1, x: fromNorth, y: fromEast },
                      to: { id: 900000 + i * 2 + 2, x: toNorth, y: toEast },
                      width: 0.1,
                    });
                  }
                  runtimePathApplied = true;
                }
              } else {
                console.log(`[API POST] /api/path/plan - overlay status ${planRes.status}, using legacy preview`);
              }
            } catch (planErr) {
              console.log("[API POST] /api/path/plan - overlay failed, using legacy preview:", planErr);
            }

            // Extension run-ups belong in the list only when the runtime /plan
            // overlay is unavailable. When runtimePathApplied, non-spray PRE/AFT
            // segments are already drawn as runtime-transit-* lines — pushing
            // fallbackExtLines too would duplicate the path on canvas and map.
            if (!runtimePathApplied) {
              generatedLines.push(...fallbackExtLines);
            }

            if (!runtimePathApplied) {
              if (body.transit_preview && Array.isArray(body.transit_preview)) {
                body.transit_preview.forEach((transit: any, i: number) => {
                  const pts = transit.points || [];
                  if (pts.length < 2) return;
                  generatedLines.push({
                    id: `transit-${i}`,
                    label: `Transit ${transit.from_entity_id || "?"} to ${transit.to_entity_id || "?"}`,
                    layer: "transit",
                    from: { id: i * 1000 + 1, x: pts[0].north, y: pts[0].east },
                    to: { id: i * 1000 + 2, x: pts[pts.length - 1].north, y: pts[pts.length - 1].east },
                    width: 0.1,
                    entity: { entity_id: `transit-${i}`, entity_type: "TRANSIT", layer: "TRANSIT", color: 0, is_mark: false, length_m: transit.length_m || 0, geometry: {}, preview_points: pts }
                  });
                });
              }
            }
            if (generatedLines.length === 0) {
              throw new Error("Preview entities did not contain valid geometries");
            }
          } else {
            throw new Error(`Entities endpoint failed with status ${res.status}`);
          }
        } else {
          const res = await fetchWithRetry(() => pathApi.getPathPreview(apiBaseUrl, pathName));
          if (res.ok) {
            const body = await res.json();
            console.log(`[API GET] /api/path/${pathName}/preview - Success, loaded ${body.num_points} points`);
            const pts = Array.isArray(body?.waypoints) ? body.waypoints : [];
            if (pts.length < 2) {
              throw new Error("Preview returned fewer than two waypoints");
            }
            for (let i = 0; i < pts.length - 1; i++) {
              const fromPt = pts[i];
              const toPt = pts[i + 1];
              const fromNorth = coerceFiniteNumber(fromPt?.north);
              const fromEast = coerceFiniteNumber(fromPt?.east);
              const toNorth = coerceFiniteNumber(toPt?.north);
              const toEast = coerceFiniteNumber(toPt?.east);

              if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
                continue;
              }

              const sprayFlag = fromPt?.spray ?? true;
              generatedLines.push({
                id: `rpp-line-${i}`,
                label: `Segment ${i + 1}`,
                layer: sprayFlag ? "marking" : "center",
                from: { id: i * 2 + 1, x: fromNorth, y: fromEast },
                to: { id: i * 2 + 2, x: toNorth, y: toEast },
                width: 0.1,
              });
            }
            if (generatedLines.length === 0) {
              throw new Error("Preview waypoints did not contain valid coordinates");
            }
          } else {
            console.error(`[API GET] /api/path/${pathName}/preview - Failed with status ${res.status}`);
            throw new Error("Preview not available");
          }
        }
      } catch (err) {
        console.log("[API GET] /api/path/entities/preview - Endpoint failed/not supported, fallback to mock line:", err);
        generatedLines = [{
          id: "rpp-line-0",
          label: "Segment 1 (Preview fallback)",
          layer: "marking",
          from: { id: 1, x: 0, y: 0 },
          to: { id: 2, x: 0, y: 10 },
          width: 0.1,
        }];
      }
      const normalized = sanitizePlanLines(normalizePlanLines(generatedLines));
      setLines(normalized);
      setImportedPlan({
        fileName: pathName,
        uri: "",
        fileType: pathName.endsWith(".csv") ? "csv" : pathName.endsWith(".waypoints") ? "waypoints" : "dxf",
        source: "builtin"
      });
      setSelectedLineId(normalized[0]?.id ?? null);
      setMissionFileReady(true);
      setMissionLoaded(false);
      setMissionRunning(false);
    } catch (err) {
      console.log("Error loading path preview:", err);
      Alert.alert("Preview failed", err instanceof Error ? err.message : String(err));
    } finally {
      setMissionActionBusy(false);
    }
  };

  const parseDxfPlan = async () => {
    if (!apiBaseUrl || !importedPlan) return;
    if (protectedMissionResident) {
      const message = "Reparse is blocked while a protected surveyed mission is resident.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return;
    }
    setMissionActionBusy(true);
    try {
      showToast("Parse", "Sending modifications to backend...", "info");

      // The user indicated that the parse-dxf payload is still UploadFile
      // So we will reconstruct the DXF or rely on the backend to provide a way
      // Wait, we can't easily generate a perfect DXF on the frontend and upload it
      // if it still expects an UploadFile. BUT the user explicitly confirmed:
      // "it's payload is the file itself will do they didn't changed"
      // If we must send the file itself, we will trigger the upload flow or call plan.
      // But wait! If the user unchecks a box, we need a way to tell the backend!
      // I will send the current entities as JSON to /api/path/plan for actual planning,
      // or simulate it here based on what they approved.
      // For now, I will use /api/path/parse-dxf if it accepts the file, but since the
      // prompt says "at bottom the abutton will appear to send to post for POST /api/path/parse-dxf endpoint"
      // I will implement a POST request.

      // Sending an empty file if the backend expects multipart/form-data for /parse-dxf
      // But passing the modified entities in some way if possible.
      const content = linesToDxf(lines, importedPlan.fileName);
      let form: FormData;
      if (Platform.OS === "web") {
        // Browsers require a real Blob/File in a multipart body. The native
        // {uri,name,type} descriptor serialises to "[object Object]" in the
        // browser, so the backend received garbage and returned 422.
        form = new FormData();
        form.append("file", new Blob([content], { type: "application/dxf" }), importedPlan.fileName);
      } else {
        const tempFileName = `${Date.now()}-${importedPlan.fileName.replace(/[\\/:*?"<>|]/g, "_")}`;
        const tempFileUri = `${FileSystem.cacheDirectory ?? ""}${tempFileName}`;
        await FileSystem.writeAsStringAsync(tempFileUri, content, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        form = createUploadFormData(tempFileUri, importedPlan.fileName, "application/dxf");
      }

      const res = await pathApi.parseDxf(apiBaseUrl, form);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Parse failed");
        throw new Error(errMsg);
      }
      invalidateStagedWorkflowFrom("alignment");
      setWorkflowStep("upload", "verified");

      // Choice A: Refresh preview immediately!
      await previewSelectedPath(importedPlan.fileName);
      showToast("Parsed", "Plan updated successfully.", "success");
    } catch (error) {
      setWorkflowStep("upload", "failed");
      logAction("PARSE_FAILED", { error: error instanceof Error ? error.message : String(error) });
      Alert.alert("Parse failed", error instanceof Error ? error.message : "Could not parse.");
      showToast("Parse failed", error instanceof Error ? error.message : "Parse failed.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  };

  useEffect(() => {
    if (page !== "fields" || !apiBaseUrl || missionActionBusy) return;
    void fetchBackendPaths();
    const timer = setInterval(() => {
      void fetchBackendPaths();
    }, 5000);
    return () => clearInterval(timer);
  }, [page, apiBaseUrl, missionActionBusy]);

  async function refreshTelemetryPanel() {
    if (!apiBaseUrl) return;
    setTelemetryLoading(true);
    setTelemetryError("");
    try {
      const [statusRes, healthRes, telemetryRes, loadedRes] = await Promise.all([
        fetchMissionStatus(apiBaseUrl),
        fetchJson<{
          ros_node: boolean;
          fcu_connected: boolean;
          armed: boolean;
          mode: string;
          rpp_state: number;
          pose_age_ms: number;
          mission_state: string;
        }>(`${apiBaseUrl}/api/healthz`).catch((err) => {
          console.log("healthz failed:", err);
          return null;
        }),
        fetchJson<{
          pos_n: number;
          pos_e: number;
          heading_ned_deg: number;
          xtrack_m: number;
          heading_err_deg: number;
          lookahead_m: number;
          speed_m_s: number;
          measured_speed_m_s?: number | null;
          kappa: number;
          dist_to_goal_m: number;
          pose_age_ms: number;
          rpp_state: number;
          rpp_state_name: string;
          armed: boolean;
          mode: string;
          connected: boolean;
          battery_v: number;
          battery_pct: number;
          gps_fix: number;
          gps_sat: number;
          lat: number;
          lon: number;
          alt: number;
        }>(`${apiBaseUrl}/api/telemetry/latest`).catch((err) => {
          console.log("telemetry/latest failed:", err);
          return null;
        }),
        fetchJson<missionApi.LoadedPathResponse>(`${apiBaseUrl}/api/mission/loaded-path`).catch((err) => {
          console.log("loaded-path failed:", err);
          return null;
        }),
      ]);

      if (loadedRes) reconcileLoadedMission(loadedRes, statusRes);
      setMissionRunning(statusRes.state === "running");

      setTelemetrySnapshot({
        rpp_state: telemetryRes ? telemetryRes.rpp_state : statusRes.rpp_state,
        rpp_state_name: telemetryRes ? telemetryRes.rpp_state_name : statusRes.rpp_state_name,
        dist_to_goal_m: telemetryRes ? telemetryRes.dist_to_goal_m : statusRes.dist_to_goal,
        speed_m_s: telemetryRes ? telemetryRes.speed_m_s : statusRes.speed,
        measured_speed_m_s:
          telemetryRes?.measured_speed_m_s ??
          statusRes?.measured_speed_m_s ??
          null,
        xtrack_m: telemetryRes ? telemetryRes.xtrack_m : statusRes.xtrack,
        battery_pct: telemetryRes ? telemetryRes.battery_pct : 85,
        battery_v: telemetryRes ? telemetryRes.battery_v : null,
        pose_age_ms: telemetryRes ? telemetryRes.pose_age_ms : (healthRes ? healthRes.pose_age_ms : 100),
        gps_sat: telemetryRes ? telemetryRes.gps_sat : 12,
        gps_fix: telemetryRes ? telemetryRes.gps_fix : null,
        pos_n: telemetryRes ? telemetryRes.pos_n : 0.0,
        pos_e: telemetryRes ? telemetryRes.pos_e : 0.0,
        heading_ned_deg: telemetryRes ? telemetryRes.heading_ned_deg : 0.0,
        heading_err_deg: telemetryRes ? telemetryRes.heading_err_deg : null,
        lookahead_m: telemetryRes ? telemetryRes.lookahead_m : 0.0,
        kappa: telemetryRes ? telemetryRes.kappa : null,
        lat: telemetryRes ? telemetryRes.lat : null,
        lon: telemetryRes ? telemetryRes.lon : null,
        alt: telemetryRes ? telemetryRes.alt : null,
        armed: telemetryRes ? telemetryRes.armed : (healthRes ? healthRes.armed : (statusRes.state !== "idle" && statusRes.state !== "error")),
        mode: telemetryRes ? telemetryRes.mode : (healthRes ? healthRes.mode : statusRes.state.toUpperCase()),
        mission_state: statusRes.state,
      } as any);

      if (statusRes.state === "paused") {
        setIsPaused(true);
      } else if (statusRes.state === "running") {
        setIsPaused(false);
      }

      setSystemHealth({
        ros_node: healthRes ? healthRes.ros_node : (telemetryRes ? telemetryRes.connected : false),
        fcu_connected: healthRes ? healthRes.fcu_connected : (telemetryRes ? telemetryRes.connected : false),
        armed: telemetryRes ? telemetryRes.armed : (healthRes ? healthRes.armed : (statusRes.state !== "idle" && statusRes.state !== "error")),
        mode: telemetryRes ? telemetryRes.mode : (healthRes ? healthRes.mode : statusRes.state.toUpperCase()),
        rpp_state: telemetryRes ? telemetryRes.rpp_state : statusRes.rpp_state,
        mission_state: statusRes.state,
      } as any);
    } catch (error) {
      setTelemetryError(error instanceof Error ? error.message : "Unable to load status");
    } finally {
      setTelemetryLoading(false);
    }
  }

  async function refreshMissionIdentity() {
    if (!apiBaseUrl) return;
    try {
      const [status, loaded] = await Promise.all([
        fetchMissionStatus(apiBaseUrl),
        fetchJson<missionApi.LoadedPathResponse>(`${apiBaseUrl}/api/mission/loaded-path`),
      ]);
      reconcileLoadedMission(loaded, status);
      setMissionRunning(status.state === "running");
    } catch {
      // Telemetry errors are presented by the existing status refresh path.
    }
  }

  useEffect(() => {
    if (!apiBaseUrl || wsStatus !== "connected") return;
    void refreshMissionIdentity();
    const timer = setInterval(() => void refreshMissionIdentity(), 3000);
    return () => clearInterval(timer);
  }, [apiBaseUrl, reconcileLoadedMission, wsStatus]);

  async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchMissionStatus(apiBaseUrl: string): Promise<missionApi.MissionStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      return await missionApi.getMissionStatus(apiBaseUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }



  async function parseFetchError(res: Response, fallbackPrefix: string): Promise<string> {
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json && typeof json.detail === "string") {
          return json.detail;
        }
        if (json && typeof json.message === "string") {
          return json.message;
        }
      } catch {
        if (text) return text;
      }
    } catch {
      // ignore
    }
    return `${fallbackPrefix} (status ${res.status})`;
  }

  async function parseMissionResponseError(res: Response, fallbackPrefix: string) {
    const detail = await parseFetchError(res, fallbackPrefix);
    return classifyMissionError(res.status, detail);
  }

  async function loadMissionOnBackend(requestedStagedMissionId?: string) {
    const requestedMissionId = requestedStagedMissionId?.trim() || stagedMissionId?.trim() || "";
    const isStagedLoad = requestedMissionId !== "";

    if (stagedWorkflow.staged === "verified" && !requestedMissionId) {
      setLoadedPathInspection(null);
      setWorkflowStep("loaded", "failed");
      Alert.alert("Load blocked", "Staged mission is verified but the mission ID is missing. Re-run Plan & Stage before loading.");
      showToast("Load blocked", "Missing staged mission ID.", "error");
      return;
    }

    if (isStagedLoad) {
      if (stagedWorkflow.staged !== "verified") {
        setLoadedPathInspection(null);
        setWorkflowStep("loaded", "failed");
        Alert.alert("Prerequisites Required", "Plan and stage the mission before loading to the controller.");
        return;
      }
      if (!apiBaseUrl) {
        setLoadedPathInspection(null);
        setWorkflowStep("loaded", "failed");
        return;
      }
    } else if (protectedMissionResident) {
      const message = "A protected surveyed mission is resident. Legacy filename load is blocked.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return;
    } else if (!apiBaseUrl || !importedPlan || lines.length === 0) {
      return;
    }

    logAction("LOAD_REQUEST", { apiBaseUrl, stagedMissionId: requestedMissionId || null, fileName: importedPlan?.fileName });
    setMissionActionBusy(true);
    try {
      showToast("Load", `Loading path...`, "info");

      if (isStagedLoad) {
        const missionId = requestedMissionId;
        const loadRes = await missionApi.loadMissionToController(apiBaseUrl, { mission_id: missionId });
        if (!loadRes.ok) {
          throw await parseMissionResponseError(loadRes, "Load to controller failed");
        }

        const loadedRes = await missionApi.getLoadedPath(apiBaseUrl);
        if (!loadedRes.ok) {
          const errMsg = await parseFetchError(loadedRes, "Loaded path verification failed");
          throw new Error(errMsg);
        }

        const loadedData = (await loadedRes.json()) as missionApi.LoadedPathResponse;
        const verification = verifyStagedLoadedMission(loadedData, missionId);
        if (!verification.verified) {
          setLoadedPathInspection(loadedData);
          throw classifyMissionError(409, verification.message ?? "Loaded staged mission verification failed.");
        }

        let stagedArtifact: pathApi.StagedMissionResponse | null =
          stagedMissionMatchesId(stagedMissionInspection, missionId) ? stagedMissionInspection : null;
        if (!stagedArtifact) {
          const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
          if (!stagedRes.ok) {
            const errMsg = await parseFetchError(stagedRes, "Staged mission geometry fetch failed");
            throw new Error(errMsg);
          }
          stagedArtifact = (await stagedRes.json()) as pathApi.StagedMissionResponse;
          if (!stagedMissionMatchesId(stagedArtifact, missionId)) {
            throw new Error(`Staged mission ${missionId} could not be loaded for map preview.`);
          }
          setStagedMissionInspection(stagedArtifact);
        }

        const hydratedLines = waypointsToPlanLines(
          stagedArtifact.waypoints ?? [],
          stagedArtifact.spray_flags ?? []
        );
        if (hydratedLines.length === 0) {
          throw new Error(`Staged mission ${missionId} has no drawable waypoints for map preview.`);
        }

        setAlignedRefPoints(anchorToAlignedRefPoints(stagedArtifact.anchor));
        setLines(sanitizePlanLines(hydratedLines));
        setSelectedLineId(hydratedLines[0]?.id ?? null);
        setVisualAlignmentItem(null);
        setIsVisualAlignmentMode(false);

        setLoadedPathInspection(loadedData);
        setMissionLoaded(true);
        setWorkflowStep("loaded", "verified");
        setMissionRunning(false);
        void refreshTelemetryPanel();
        logAction("LOAD_SUCCESS", { stagedMissionId: missionId, fileName: importedPlan?.fileName });
        setPage("home");
        showToast("Mission loaded", "Staged mission loaded to controller and verified.", "success");
        return;
      }

      const res = await missionApi.loadMission(apiBaseUrl, {
        path_name: importedPlan!.fileName,
        mission_file: "",
      });

      if (!res.ok) {
        throw await parseMissionResponseError(res, "Load failed");
      }

      setLoadedPathInspection(null);
      setMissionLoaded(true);
      setWorkflowStep("loaded", "verified");
      setMissionRunning(false);
      void refreshTelemetryPanel();
      logAction("LOAD_SUCCESS", { fileName: importedPlan?.fileName });
      setPage("home");
      showToast("File loaded", "Load succeeded. Start and Export are now available.", "success");
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      if (isStagedLoad && !missionError) {
        setLoadedPathInspection(null);
      }
      setWorkflowStep("loaded", "failed");
      logAction("LOAD_FAILED", {
        fileName: importedPlan?.fileName,
        stagedMissionId: requestedMissionId || null,
        status: missionError?.status ?? null,
        error: missionError?.message ?? (error instanceof Error ? error.message : String(error)),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not load the mission.");
      const title = missionError?.title ?? "Load failed";
      Alert.alert(title, message);
      showToast(title, message, "error");
      if (missionError?.status === 409) void refreshMissionIdentity();
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function startLoadedMission() {
    if (!apiBaseUrl || !importedPlan || lines.length === 0) {
      return;
    }

    if (virtualJoystick.joystickActive || telemetrySnapshot?.joystick_active) {
      Alert.alert("Joystick active", "Release manual drive before starting a mission.");
      showToast("Start blocked", "Release the joystick lease before starting.", "error");
      return;
    }

    const startGate = evaluateStagedStartGate(stagedWorkflow, loadedPathInspection, stagedMissionId);
    if (!startGate.allowed) {
      setWorkflowStep("started", "failed");
      Alert.alert("Cannot Start", startGate.message ?? "Staged mission is not ready to start.");
      showToast("Start blocked", startGate.message ?? "Complete load verification first.", "error");
      return;
    }

    const isStagedStart = startGate.isStagedWorkflow;

    logAction("START_REQUEST", {
      apiBaseUrl,
      fileName: importedPlan.fileName,
      missionRunning,
      autoOrigin,
      isStagedStart,
      stagedMissionId: isStagedStart ? getLoadedMissionId(loadedPathInspection) : null,
    });
    setMissionActionBusy(true);
    try {
      showToast(missionRunning ? "Stop" : "Start", missionRunning ? "Stopping mission..." : "Starting mission...", "info");
      const startPayload = buildMissionStartPayload({
        stagedMissionId,
        stagedVerified: isStagedStart,
        fileName: importedPlan.fileName,
        autoOrigin,
      });
      const res = await missionApi.startMission(apiBaseUrl, startPayload);
      if (!res.ok) {
        throw await parseMissionResponseError(res, "Start failed");
      }
      setMissionRunning(true);
      setWorkflowStep("started", "verified");
      if (!isStagedStart && autoOrigin && autoOriginReference) {
        const planStart = getPlanStartPoint(displayedLines);
        console.log("[CANVAS] start-anchor", JSON.stringify({
          capturedOrigin: {
            n: autoOriginReference.roverNorth,
            e: autoOriginReference.roverEast,
          },
          planFirstPoint: planStart,
          expectedDelta: planStart
            ? {
                dN: autoOriginReference.roverNorth - autoOriginReference.planStartNorth,
                dE: autoOriginReference.roverEast - autoOriginReference.planStartEast,
              }
            : null,
        }));
      }
      void refreshTelemetryPanel();
      logAction("START_SUCCESS", { fileName: importedPlan.fileName, autoOrigin });
      Alert.alert("Started", `${importedPlan.fileName} started on the rover.`);
      showToast("Mission running", `${importedPlan.fileName} is now active.`, "success");
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      setWorkflowStep("started", "failed");
      logAction("START_FAILED", {
        fileName: importedPlan.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not start the mission.");
      const title = missionError?.title ?? "Start failed";
      Alert.alert(title, message);
      showToast(title, message, "error");
      if (missionError?.status === 409) void refreshMissionIdentity();
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function startNtrip() {
    if (!apiBaseUrl) return;
    setRtkConnecting(true);
    try {
      if (!rtkCaster || !rtkPort || !rtkMountPoint || !rtkUsername || !rtkPassword) {
        Alert.alert("Missing fields", "Please fill in all 5 RTK caster credentials.");
        setRtkConnecting(false);
        return;
      }
      logAction("RTK_CONNECT_REQUEST", { caster: rtkCaster, port: rtkPort, mountpoint: rtkMountPoint });
      showToast("RTK Injection", "Connecting to NTRIP caster...", "info");
      const res = await fetch(`${apiBaseUrl}/api/rtk/ntrip/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host: rtkCaster,
          port: parseInt(rtkPort, 10),
          mountpoint: rtkMountPoint,
          user: rtkUsername,
          pass: rtkPassword,
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "NTRIP start failed.");
      }
      const data = await res.json();
      setRtkRunning(data.running);
      setRtkHealthy(data.healthy);
      logAction("RTK_CONNECT_SUCCESS", { caster: rtkCaster });
      Alert.alert("RTK Started", "NTRIP RTK caster started successfully.");
      showToast("RTK Started", "NTRIP RTK stream active.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      logAction("RTK_ACTION_FAILED", { error: error instanceof Error ? error.message : String(error) });
      Alert.alert("RTK Action Failed", error instanceof Error ? error.message : "Failed to perform RTK action.");
      showToast("RTK Failed", error instanceof Error ? error.message : "Failed to perform RTK action.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  async function startLora() {
    if (!apiBaseUrl) return;
    setRtkConnecting(true);
    try {
      showToast("RTK Injection", "Starting LoRA...", "info");
      const res = await fetch(`${apiBaseUrl}/api/rtk/lora/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baudrate: 115200,
          serial_port: "/dev/ttyUSB0",
        }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "LoRA start failed.");
      }
      const data = await res.json();
      setRtkRunning(data.running);
      setRtkHealthy(data.healthy);
      Alert.alert("LoRA Started", "LoRA RTK stream started successfully.");
      showToast("LoRA Started", "LoRA RTK stream active.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      Alert.alert("LoRA Failed", error instanceof Error ? error.message : "Failed to start LoRA.");
      showToast("LoRA Failed", error instanceof Error ? error.message : "Failed to start LoRA.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  async function stopRtk() {
    if (!apiBaseUrl) return;
    setRtkConnecting(true);
    try {
      showToast("RTK Injection", "Stopping RTK stream...", "warning");
      logAction("RTK_STOP_REQUEST");
      const res = await fetch(`${apiBaseUrl}/api/rtk/stop`, {
        method: "POST",
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Failed to stop RTK correction stream.");
      }
      setRtkRunning(false);
      logAction("RTK_STOP_SUCCESS");
      Alert.alert("RTK Stopped", "RTK correction stream stopped successfully.");
      showToast("RTK Stopped", "RTK stream stopped.", "success");
      setRtkModalOpen(false);
    } catch (error) {
      Alert.alert("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.");
      showToast("Stop Failed", error instanceof Error ? error.message : "Failed to stop RTK action.", "error");
    } finally {
      setRtkConnecting(false);
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    const fetchRtkStatus = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/rtk/status`);
        if (res.ok) {
          const data = await res.json();
          setRtkRunning(data.running);
          setRtkHealthy(data.healthy);
        }
      } catch (err) {
        console.log("Failed to fetch RTK status:", err);
      }
    };
    void fetchRtkStatus();
    const interval = setInterval(fetchRtkStatus, 3000);
    return () => clearInterval(interval);
  }, [apiBaseUrl]);

  async function stopMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before stopping a mission.");
      return;
    }

    logAction("STOP_REQUEST", { apiBaseUrl });
    setMissionActionBusy(true);
    try {
      showToast("Stop", "Stopping mission...", "warning");
      const res = await missionApi.stopMission(apiBaseUrl);

      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Stop failed");
        throw new Error(errMsg);
      }

      setMissionRunning(false);
      void refreshTelemetryPanel();
      logAction("STOP_SUCCESS");
      Alert.alert("Stopped", "Mission stop command sent to the backend.");
      showToast("Mission stopped", "Stop command accepted by the backend.", "success");
    } catch (error) {
      logAction("STOP_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      showToast("Stop failed", error instanceof Error ? error.message : "Could not stop the mission.", "error");
      Alert.alert("Stop failed", error instanceof Error ? error.message : "Could not stop the mission.");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function clearResidentMissionOnBackend() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before clearing a mission.");
      return;
    }

    logAction("CLEAR_REQUEST", {
      apiBaseUrl,
      selectedPathName,
      missionRunning,
      missionLoaded,
      missionState: telemetrySnapshot?.mission_state ?? null,
    });
    setMissionActionBusy(true);
    try {
      showToast("Clear", "Clearing resident mission...", "warning");
      const res = await missionApi.clearMission(apiBaseUrl);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Clear failed");
        const error = new Error(errMsg) as Error & { status?: number };
        error.status = res.status;
        throw error;
      }

      setImportedPlan(null);
      setLines([]);
      setSelectedLineId(null);
      setSelectedPathName(null);
      setMissionFileReady(false);
      setMissionLoaded(false);
      setMissionRunning(false);
      setAutoOrigin(false);
      setAutoOriginReference(null);
      setExtractedCorners(null);
      setAlignedRefPoints([]);
      setAlignmentResult(null);
      setVerifiedAlignmentRequest(null);
      setVisualAlignmentItem(null);
      setIsVisualAlignmentMode(false);
      setSegmentVerification(null);
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      setLoadedPathInspection(null);
      setStagedWorkflow(INITIAL_STAGED_WORKFLOW_STATE);

      void refreshMissionIdentity();
      void refreshTelemetryPanel();
      logAction("CLEAR_SUCCESS");
      Alert.alert("Cleared", "Resident mission unloaded successfully.");
      showToast("Mission cleared", "Resident mission has been unloaded.", "success");
    } catch (error) {
      logAction("CLEAR_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      const message = error instanceof Error ? error.message : "Could not clear the mission.";
      Alert.alert("Clear failed", message);
      showToast("Clear failed", message, "error");
      if (typeof error === "object" && error && "status" in error && (error as { status?: number }).status === 409) {
        void refreshMissionIdentity();
      }
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function pauseMissionOnBackend() {
    if (!apiBaseUrl) return;
    setMissionActionBusy(true);
    try {
      showToast("Pause", "Pausing mission...", "info");
      const res = await missionApi.abortMission(apiBaseUrl);
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Pause failed");
        throw new Error(errMsg);
      }
      setIsPaused(true);
      showToast("Mission paused", "Mission has been paused.", "success");
      void refreshTelemetryPanel();
    } catch (error) {
      Alert.alert("Pause failed", error instanceof Error ? error.message : "Could not pause the mission.");
      showToast("Pause failed", error instanceof Error ? error.message : "Could not pause.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function armVehicle(arm: boolean) {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    logAction("ARM_REQUEST", { apiBaseUrl, arm });
    setMissionActionBusy(true);
    try {
      showToast(arm ? "Arm" : "Disarm", arm ? "Arming vehicle..." : "Disarming vehicle...", "info");
      const res = await fetch(`${apiBaseUrl}/api/arm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ arm }),
      });
      let data;
      try { data = await res.clone().json(); } catch (e) { }

      if (!res.ok || (data && data.success === false)) {
        const errMsg = data?.message || (await parseFetchError(res, arm ? "Arm failed" : "Disarm failed"));
        throw new Error(errMsg);
      }
      void refreshTelemetryPanel();
      logAction("ARM_SUCCESS", { arm });
      Alert.alert(arm ? "Armed" : "Disarmed", `Vehicle was successfully ${arm ? "armed" : "disarmed"}.`);
      showToast(arm ? "Armed" : "Disarmed", `Vehicle is now ${arm ? "armed" : "disarmed"}.`, "success");
    } catch (error) {
      logAction("ARM_FAILED", {
        arm,
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert(arm ? "Arm failed" : "Disarm failed", error instanceof Error ? error.message : "Command rejected.");
      showToast(arm ? "Arm failed" : "Disarm failed", error instanceof Error ? error.message : "Command rejected.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function setVehicleMode(targetMode: "MANUAL") {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    logAction("SET_MODE_REQUEST", { apiBaseUrl, targetMode });
    setMissionActionBusy(true);
    try {
      showToast("Mode", `Switching to ${targetMode}...`, "info");
      const res = await fetch(`${apiBaseUrl}/api/set_mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: targetMode })
      });
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "Set mode failed");
        throw new Error(errMsg);
      }
      void refreshTelemetryPanel();
      logAction("SET_MODE_SUCCESS", { targetMode });
      Alert.alert("Mode Changed", `Vehicle mode set to ${targetMode}.`);
      showToast("Mode Changed", `Vehicle mode is now ${targetMode}.`, "success");
    } catch (error) {
      logAction("SET_MODE_FAILED", {
        targetMode,
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert("Mode Change Failed", error instanceof Error ? error.message : "Command rejected.");
      showToast("Mode Change Failed", error instanceof Error ? error.message : "Command rejected.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function estopVehicle() {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before sending commands.");
      return;
    }
    virtualJoystick.handleEStop();
    logAction("ESTOP_REQUEST", { apiBaseUrl });
    setMissionActionBusy(true);
    try {
      showToast("E-Stop", "Sending EMERGENCY STOP...", "error");
      const res = await fetch(`${apiBaseUrl}/api/estop`, {
        method: "POST",
      });
      if (!res.ok) {
        const errMsg = await parseFetchError(res, "E-Stop failed");
        throw new Error(errMsg);
      }
      void refreshTelemetryPanel();
      logAction("ESTOP_SUCCESS");
      Alert.alert("E-STOP Sent", "Emergency Stop command accepted.");
      showToast("E-STOP Sent", "Emergency Stop command active.", "success");
    } catch (error) {
      logAction("ESTOP_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      Alert.alert("E-Stop failed", error instanceof Error ? error.message : "Command rejected.");
      showToast("E-Stop failed", error instanceof Error ? error.message : "Command rejected.", "error");
    } finally {
      setMissionActionBusy(false);
    }
  }

  async function runTemplateOnBackend(name: string, generatedLines: PlanLine[]) {
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a backend before running a template.");
      return;
    }
    if (protectedMissionResident) {
      const message = "Template load is blocked while a protected surveyed mission is resident.";
      Alert.alert("Mission conflict", message);
      showToast("Mission conflict", message, "error");
      return;
    }
    const fileName = `${name.replace(/\s+/g, "_").toLowerCase()}_template.dxf`;
    logAction("LOAD_TEMPLATE_REQUEST", { apiBaseUrl, fileName });
    setMissionActionBusy(true);
    try {
      showToast("Load", `Loading template ${fileName}...`, "info");
      const res = await missionApi.loadMission(apiBaseUrl, {
        path_name: fileName,
        mission_file: "",
      });

      if (!res.ok) {
        throw await parseMissionResponseError(res, "Load failed");
      }

      setImportedPlan({
        fileName,
        uri: "",
        fileType: "dxf",
        source: "generated",
      });
      const safeGeneratedLines = sanitizePlanLines(generatedLines);
      setLines(safeGeneratedLines);
      setSelectedLineId(safeGeneratedLines[0]?.id ?? null);
      setMissionLoaded(true);
      setMissionRunning(false);
      void refreshTelemetryPanel();
      setPage("home");
      showToast("Template loaded", "Template path loaded successfully.", "success");
    } catch (error) {
      const missionError = error && typeof error === "object" && "kind" in error
        ? error as ReturnType<typeof classifyMissionError>
        : null;
      logAction("LOAD_TEMPLATE_FAILED", {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      const message = missionError?.message ?? (error instanceof Error ? error.message : "Could not load template.");
      const title = missionError?.title ?? "Load failed";
      Alert.alert(title, message);
      showToast(title, message, "error");
      if (missionError?.status === 409) void refreshMissionIdentity();
    } finally {
      setMissionActionBusy(false);
    }
  }

  function priorityScanHosts() {
    return PRIORITY_BACKEND_IPS.map((ip) => `http://${ip}:${DISCOVERY_PORT}`);
  }

  function parseHost(candidate: string) {
    try {
      const url = new URL(candidate);
      return {
        host: url.hostname,
        port: Number(url.port || 5001),
      };
    } catch {
      return null;
    }
  }

  async function probeBackendHost(candidate: string): Promise<number | null> {
    const start = Date.now();
    const endpoints = ["/api/ping", "/api/healthz"];
    for (const endpoint of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${candidate}${endpoint}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) return Date.now() - start;
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  function buildSubnetSweepCandidates(seedHost: string) {
    const prefixes = new Set<string>();

    // 1. Check seed host if it's a private IP
    const parsed = parseHost(seedHost);
    if (parsed && isPrivateLanIp(parsed.host)) {
      const octets = parsed.host.split(".");
      if (octets.length === 4) {
        prefixes.add(octets.slice(0, 3).join("."));
      }
    }

    // 2. Check window.location if running in a web environment (will be undefined in React Native APK)
    if (typeof window !== "undefined" && window.location && window.location.hostname) {
      const host = window.location.hostname;
      if (isPrivateLanIp(host)) {
        const octets = host.split(".");
        if (octets.length === 4) {
          prefixes.add(octets.slice(0, 3).join("."));
        }
      }
    }

    // 3. Always include common private subnets
    prefixes.add("192.168.1");
    prefixes.add("192.168.0");
    prefixes.add("192.168.2");
    prefixes.add("10.0.0");
    prefixes.add("172.16.0");

    // 4. Extract subnet from manual host and add it as a priority scan
    //    This helps when user enters an IP manually on a non-192.168.x network
    try {
      const seedParsed = parseHost(seedHost);
      if (seedParsed && isPrivateLanIp(seedParsed.host)) {
        const octets = seedParsed.host.split(".");
        if (octets.length === 4) {
          prefixes.add(octets.slice(0, 3).join("."));
        }
      }
    } catch {
      // ignore
    }

    const candidates: string[] = [];
    for (const prefix of prefixes) {
      for (let hostOctet = SUBNET_HOST_MIN; hostOctet <= SUBNET_HOST_MAX; hostOctet++) {
        candidates.push(`http://${prefix}.${hostOctet}:${DISCOVERY_PORT}`);
      }
    }
    return candidates;
  }

  function isPrivateLanIp(host: string) {
    const octets = host.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) {
      return false;
    }

    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const currentIndex = cursor++;
        const value = items[currentIndex];
        const result = await worker(value);
        results[currentIndex] = result;
      }
    });

    await Promise.all(runners);
    return results;
  }

  async function discoverBackendBeacons(candidate: string, responseTime: number): Promise<DiscoveredRover[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${candidate}/api/discover`, {
        method: "POST",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const body = await res.json();
      return (body.beacons ?? []).map((rover: any) => ({
        id: rover.id ?? rover.rover_id ?? `${rover.host}-${rover.port}`,
        name: rover.name ?? rover.rover_name ?? `Rover ${String(rover.host ?? "").split(".").pop() ?? ""}`,
        host: rover.host ?? rover.ip ?? "",
        port: Number(rover.port ?? 5001),
        version: rover.version ?? "1.0",
        responseTime,
      })).filter((entry: DiscoveredRover) => Boolean(entry.host));
    } catch {
      return [];
    }
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SafeAreaInsetsContext.Consumer>
          {(insets) => (
            <View
              style={{
                flex: 1,
                backgroundColor: BG,
                paddingTop: insets?.top ?? 0,
                paddingRight: insets?.right ?? 0,
                paddingBottom: insets?.bottom ?? 0,
                paddingLeft: insets?.left ?? 0,
              }}
            >
              {page === "connection" ? (
                <ConnectionView
                  selectedWs={selectedWs}
                  manualHost={manualHost}
                  wsError={wsError}
                  wsStatus={wsStatus}
                  isOffline={isOffline}
                  discoveredRovers={discoveredRovers}
                  onRefresh={scanForWebsockets}
                  onSelect={handleSelectWebsocket}
                  onManualHostChange={setManualHost}
                  onConnect={connectSelectedWebsocket}
                  onOfflinePreview={enterOfflinePreview}
                />
              ) : page === "home" ? (
                <HomeView
                  autoOrigin={autoOrigin}
                  onToggleAutoOrigin={toggleAutoOrigin}
                  previewRoverPoint={previewRoverPoint}
                  originShiftKey={
                    autoOriginReference
                      ? `${autoOriginReference.roverNorth.toFixed(3)}:${autoOriginReference.roverEast.toFixed(3)}`
                      : autoOrigin
                        ? "pending"
                        : null
                  }
                  importedPlan={importedPlan}
                  lines={displayedLines}
                  mapSourceLines={mapSourceLines}
                  autoOriginReference={autoOriginReference}
                  mapGeometryFrame={mapGeometryFrame}
                  autoOriginEnabled={autoOriginEligible}
                  setLines={setLines}
                  selectedLineId={selectedLineId}
                  onSelectLine={setSelectedLineId}
                  onDeleteSelectedLine={deleteSelectedLine}
                  onConfirmDeletePlan={deleteEntirePlan}
                  menuOpen={menuOpen}
                  onToggleMenu={() => setMenuOpen((v) => !v)}
                  onNav={(p) => {
                    logAction("NAVIGATE", { page: p });
                    setPage(p);
                    setMenuOpen(false);
                  }}
                  onDisconnect={disconnectToConnectionScreen}
                  layerVisibility={layerVisibility}
                  setLayerVisibility={setLayerVisibility}
                  onStopPlan={stopMissionOnBackend}
                  onClearMission={clearResidentMissionOnBackend}
                  onStartPlan={startLoadedMission}
                  onPausePlan={pauseMissionOnBackend}
                  onArmVehicle={armVehicle}
                  onSetMode={setVehicleMode}
                  onEstopVehicle={estopVehicle}
                  virtualJoystick={virtualJoystick}
                  missionActionBusy={missionActionBusy}
                  missionFileReady={missionFileReady}
                  missionLoaded={missionLoaded}
                  missionRunning={missionRunning}
                  systemHealth={systemHealth}
                  telemetrySnapshot={telemetrySnapshot}
                  activityFeed={activityFeed}
                  discoveryFeed={discoveryFeed}
                  telemetryError={telemetryError}
                  telemetryLoading={telemetryLoading}
                  isPaused={isPaused}
                  setIsPaused={setIsPaused}
                  rtkModalOpen={rtkModalOpen}
                  setRtkModalOpen={setRtkModalOpen}
                  rtkCaster={rtkCaster}
                  setRtkCaster={setRtkCaster}
                  rtkPort={rtkPort}
                  setRtkPort={setRtkPort}
                  rtkMountPoint={rtkMountPoint}
                  setRtkMountPoint={setRtkMountPoint}
                  rtkUsername={rtkUsername}
                  setRtkUsername={setRtkUsername}
                  rtkPassword={rtkPassword}
                  setRtkPassword={setRtkPassword}
                  rtkConnecting={rtkConnecting}
                  startNtrip={startNtrip}
                  startLora={startLora}
                  stopRtk={stopRtk}
                  rtkRunning={rtkRunning}
                  rtkHealthy={rtkHealthy}
                  onParsePlan={parseDxfPlan}
                  apiBaseUrl={apiBaseUrl}
                  selectedPathName={selectedPathName}
                  onRefreshPaths={() => {
                    const target = selectedPathName || importedPlan?.fileName;
                    if (target) previewSelectedPath(target);
                  }}
                  stagedWorkflow={stagedWorkflow}
                  stagedMissionId={stagedMissionId}
                  loadedPathInspection={loadedPathInspection}
                  onInvalidateWorkflow={invalidateStagedWorkflowFrom}
                  alignedRefPoints={alignedRefPoints}
                  setAlignedRefPoints={setAlignedRefPoints}
                  mapViewEnabled={mapViewEnabled}
                  setMapViewEnabled={setMapViewEnabled}
                  showRefPointLabels={showRefPointLabels}
                  setShowRefPointLabels={setShowRefPointLabels}
                  activeRefPointLabelIndex={activeRefPointLabelIndex}
                  setActiveRefPointLabelIndex={setActiveRefPointLabelIndex}
                />
              ) : (
                <SectionScreen
                  telemetrySnapshot={telemetrySnapshot}
                  missionRunning={missionRunning}
                  previewRoverPoint={previewRoverPoint}
                  title={sectionTitle}
                  page={page}
                  importedPlan={importedPlan}
                  lines={displayedLines}
                  mapSourceLines={mapSourceLines}
                  autoOriginReference={autoOriginReference}
                  mapGeometryFrame={mapGeometryFrame}
                  autoOriginEnabled={autoOriginEligible}
                  setLines={setLines}
                  selectedLineId={selectedLineId}
                  backendPaths={backendPaths}
                  selectedPathName={selectedPathName}
                  onSelectPath={previewSelectedPath}
                  onLoadSelectedPath={loadMissionOnBackend}
                  missionActionBusy={missionActionBusy}
                  apiBaseUrl={apiBaseUrl}
                  onRefreshPaths={fetchBackendPaths}
                  onBack={() => setPage("home")}
                  showRefPointLabels={showRefPointLabels}
                  setShowRefPointLabels={setShowRefPointLabels}
                  activeRefPointLabelIndex={activeRefPointLabelIndex}
                  setActiveRefPointLabelIndex={setActiveRefPointLabelIndex}
                  isVisualAlignmentMode={isVisualAlignmentMode}
                  visualAlignmentItem={visualAlignmentItem}
                  setVisualAlignmentItem={setVisualAlignmentItem}
                  onStartVisualAlignment={startVisualAlignment}
                  onConfirmVisualAlignment={handleConfirmVisualAlignment}
                  extractedCorners={extractedCorners}
                  setExtractedCorners={setExtractedCorners}
                  onNav={(p) => setPage(p)}
                  onSelectLine={setSelectedLineId}
                  onGenerateTemplate={(name, generatedLines) => {
                    if (protectedMissionResident) {
                      Alert.alert("Mission conflict", "Generating a new template is blocked while a protected surveyed mission is resident.");
                      return;
                    }
                    const safeGeneratedLines = sanitizePlanLines(generatedLines);
                    setImportedPlan({ fileName: `${name}.dxf`, uri: "", fileType: "dxf", source: "generated" });
                    setLines(safeGeneratedLines);
                    setSelectedLineId(safeGeneratedLines[0]?.id ?? null);
                    setMissionFileReady(false);
                    setMissionLoaded(false);
                    setMissionRunning(false);
                    setPage("home");
                    showToast("Template ready", `${name}.dxf is ready to upload.`, "success");
                  }}
                  layerVisibility={layerVisibility}
                  setLayerVisibility={setLayerVisibility}
                  setImportedPlan={setImportedPlan}
                  onRunTemplate={runTemplateOnBackend}
                  extensionsEnabled={extensionsEnabled}
                  setExtensionsEnabled={setExtensionsEnabled}
                  extPre={extPre}
                  setExtPre={setExtPre}
                  extAft={extAft}
                  setExtAft={setExtAft}
                  missionFileReady={missionFileReady}
                  toggleA={toggleA}
                  toggleB={toggleB}
                  toggleC={toggleC}
                  toggleD={toggleD}
                  delayA={delayA}
                  delayB={delayB}
                  setToggleA={setToggleA}
                  setToggleB={setToggleB}
                  setToggleC={setToggleC}
                  setToggleD={setToggleD}
                  setDelayA={setDelayA}
                  setDelayB={setDelayB}
                  onParsePlan={parseDxfPlan}
                  onWorkflowStep={setWorkflowStep}
                  stagedWorkflow={stagedWorkflow}
                  alignmentResult={alignmentResult}
                  setAlignmentResult={setAlignmentResult}
                  verifiedAlignmentRequest={verifiedAlignmentRequest}
                  setVerifiedAlignmentRequest={setVerifiedAlignmentRequest}
                  segmentVerification={segmentVerification}
                  setSegmentVerification={setSegmentVerification}
                  stagedPlanResult={stagedPlanResult}
                  setStagedPlanResult={setStagedPlanResult}
                  stagedMissionInspection={stagedMissionInspection}
                  setStagedMissionInspection={setStagedMissionInspection}
                  stagedMissionId={stagedMissionId}
                  setStagedMissionId={setStagedMissionId}
                  loadedPathInspection={loadedPathInspection}
                  onInvalidateWorkflow={invalidateStagedWorkflowFrom}
                  alignedRefPoints={alignedRefPoints}
                  setAlignedRefPoints={setAlignedRefPoints}
                  mapViewEnabled={mapViewEnabled}
                  setMapViewEnabled={setMapViewEnabled}
                />
              )}


              {toast ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: 16,
                    right: 16,
                    bottom: 18,
                    zIndex: 999,
                    alignItems: "center",
                  }}
                >
                  <View
                    style={{
                      maxWidth: 560,
                      width: "100%",
                      borderRadius: 16,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      backgroundColor:
                        toast.tone === "success"
                          ? "#0f766e"
                          : toast.tone === "warning"
                            ? "#b45309"
                            : toast.tone === "error"
                              ? "#991b1b"
                              : "#0f172a",
                      borderWidth: 1,
                      borderColor:
                        toast.tone === "success"
                          ? "#5eead4"
                          : toast.tone === "warning"
                            ? "#fdba74"
                            : toast.tone === "error"
                              ? "#fca5a5"
                              : "#334155",
                      shadowColor: "#000",
                      shadowOpacity: 0.16,
                      shadowRadius: 16,
                      shadowOffset: { width: 0, height: 8 },
                      elevation: 10,
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "900", letterSpacing: 0.6, textTransform: "uppercase" }}>
                      {toast.title}
                    </Text>
                    <Text style={{ color: "#e2e8f0", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                      {toast.message}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          )}
        </SafeAreaInsetsContext.Consumer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function TopBar({
  title,
  onBack,
  onMorePress,
  mapViewEnabled,
  setMapViewEnabled,
}: {
  title: string;
  onBack?: () => void;
  onMorePress?: () => void;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <View
      style={{
        height: 76,
        backgroundColor: "#f8fafc",
        borderBottomWidth: 1,
        borderBottomColor: "#d7dee8",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={14}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: "#eef2f7",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: "#d7dee8",
            }}
          >
            <Text style={{ fontSize: 24, color: "#0f172a", lineHeight: 24 }}>‹</Text>
          </Pressable>
        ) : null}
        <Text style={{ fontSize: 18, color: "#0f172a", fontWeight: "700" }}>{title}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {setMapViewEnabled && (
          <Pressable
            onPress={() => setMapViewEnabled((v) => !v)}
            style={{
              height: 38,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              borderRadius: 12,
              backgroundColor: mapViewEnabled ? "#3b82f6" : "#ffffff",
              borderWidth: 1,
              borderColor: mapViewEnabled ? "#2563eb" : "#d7dee8",
            }}
          >
            <MapIcon size={14} color={mapViewEnabled ? "#ffffff" : "#0f172a"} />
            <Text style={{ color: mapViewEnabled ? "#ffffff" : "#0f172a", fontSize: 11, fontWeight: "800" }}>
              {mapViewEnabled ? "Map On" : "Map"}
            </Text>
          </Pressable>
        )}
        {onMorePress ? (
          <Pressable
            onPress={onMorePress}
            hitSlop={14}
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              backgroundColor: "#eef2f7",
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: "#d7dee8",
            }}
          >
            <Text style={{ fontSize: 20, color: "#0f172a", lineHeight: 20 }}>⋮</Text>
          </Pressable>
        ) : (
          !setMapViewEnabled && <View style={{ width: 38, height: 38 }} />
        )}
      </View>
    </View>
  );
}

function HomeView({
  autoOrigin,
  onToggleAutoOrigin,
  previewRoverPoint,
  originShiftKey,
  mapSourceLines,
  autoOriginReference,
  mapGeometryFrame,
  autoOriginEnabled,
  importedPlan,
  lines,
  selectedLineId,
  onSelectLine,
  onDeleteSelectedLine,
  onConfirmDeletePlan,
  menuOpen,
  onToggleMenu,
  onNav,
  onDisconnect,
  layerVisibility,
  setLayerVisibility,
  onStopPlan,
  onClearMission,
  onStartPlan,
  onPausePlan,
  onArmVehicle,
  onSetMode,
  onEstopVehicle,
  virtualJoystick,
  missionActionBusy,
  missionFileReady,
  missionLoaded,
  missionRunning,
  systemHealth,
  telemetrySnapshot,
  activityFeed,
  discoveryFeed,
  telemetryError,
  telemetryLoading,
  isPaused,
  setIsPaused,
  rtkModalOpen,
  setRtkModalOpen,
  rtkCaster,
  setRtkCaster,
  rtkPort,
  setRtkPort,
  rtkMountPoint,
  setRtkMountPoint,
  rtkUsername,
  setRtkUsername,
  rtkPassword,
  setRtkPassword,
  rtkConnecting,
  startNtrip,
  startLora,
  stopRtk,
  rtkRunning,
  rtkHealthy,
  onParsePlan,
  setLines,
  apiBaseUrl,
  selectedPathName,
  onRefreshPaths,
  stagedWorkflow,
  stagedMissionId,
  loadedPathInspection,
  onInvalidateWorkflow,
  alignedRefPoints = [],
  setAlignedRefPoints,
  mapViewEnabled = false,
  setMapViewEnabled,
  showRefPointLabels = false,
  setShowRefPointLabels,
  activeRefPointLabelIndex = null,
  setActiveRefPointLabelIndex,
  isVisualAlignmentMode,
  visualAlignmentItem,
  setVisualAlignmentItem,
  onStartVisualAlignment,
  onConfirmVisualAlignment,
}: {
  autoOrigin: boolean;
  onToggleAutoOrigin: () => void;
  previewRoverPoint: { north: number; east: number } | null;
  originShiftKey?: string | null;
  mapSourceLines: PlanLine[];
  autoOriginReference: AutoOriginReference | null;
  mapGeometryFrame: MapGeometryFrame;
  autoOriginEnabled: boolean;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onSelectLine: (id: string | null) => void;
  onDeleteSelectedLine: () => void;
  onConfirmDeletePlan: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onNav: (p: Page) => void;
  onDisconnect: () => void;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  onStopPlan: () => Promise<void>;
  onClearMission: () => Promise<void>;
  onStartPlan: () => Promise<void>;
  onPausePlan: () => Promise<void>;
  onArmVehicle: (arm: boolean) => Promise<void>;
  onSetMode: (mode: "MANUAL") => Promise<void>;
  onEstopVehicle: () => Promise<void>;
  virtualJoystick: ReturnType<typeof useVirtualJoystick>;
  missionActionBusy: boolean;
  missionFileReady: boolean;
  missionLoaded: boolean;
  missionRunning: boolean;
  systemHealth: SystemHealth | null;
  telemetrySnapshot: TelemetrySnapshot | null;
  activityFeed: ActivityEntry[];
  discoveryFeed: DiscoveredRover[];
  telemetryError: string;
  telemetryLoading: boolean;
  isPaused: boolean;
  setIsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  rtkModalOpen: boolean;
  setRtkModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  rtkCaster: string;
  setRtkCaster: React.Dispatch<React.SetStateAction<string>>;
  rtkPort: string;
  setRtkPort: React.Dispatch<React.SetStateAction<string>>;
  rtkMountPoint: string;
  setRtkMountPoint: React.Dispatch<React.SetStateAction<string>>;
  rtkUsername: string;
  setRtkUsername: React.Dispatch<React.SetStateAction<string>>;
  rtkPassword: string;
  setRtkPassword: React.Dispatch<React.SetStateAction<string>>;
  rtkConnecting: boolean;
  startNtrip: () => Promise<void>;
  startLora: () => Promise<void>;
  stopRtk: () => Promise<void>;
  rtkRunning: boolean;
  rtkHealthy: boolean;
  onParsePlan: () => Promise<void>;
  apiBaseUrl?: string;
  selectedPathName?: string | null;
  onRefreshPaths?: () => void;
  stagedWorkflow: StagedWorkflowState;
  stagedMissionId: string | null;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onInvalidateWorkflow?: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  showRefPointLabels?: boolean;
  setShowRefPointLabels: React.Dispatch<React.SetStateAction<boolean>>;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
}) {
  const [sprayModalOpen, setSprayModalOpen] = useState(false);
  const [sprayTab, setSprayTab] = useState<"continuous" | "dashed" | "point">("continuous");
  const [dashDistanceOn, setDashDistanceOn] = useState("0.3");
  const [dashDistanceOff, setDashDistanceOff] = useState("0.3");
  const [pointExecutionMode, setPointExecutionMode] = useState<"auto" | "manual">("auto");
  const [activeSprayMode, setActiveSprayMode] = useState<string>("continuous");
  const [activePointExecutionMode, setActivePointExecutionMode] = useState<string>("auto");
  const [isSprayMasterEnabled, setIsSprayMasterEnabled] = useState(false);
  const [isSprayMasterChanging, setIsSprayMasterChanging] = useState(false);

  const handleSetSprayMode = async () => {
    if (!apiBaseUrl || !selectedPathName) return;
    try {
      let res;
      if (sprayTab === "continuous") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/continuous`, { 
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({})
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("continuous");
      } else if (sprayTab === "dashed") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/dash`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            dash_on_distance_m: parseFloat(dashDistanceOn) || 0.3,
            dash_off_distance_m: parseFloat(dashDistanceOff) || 0.3,
            dash_phase_reset: "per_mark_region"
          })
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("dashed");
      } else if (sprayTab === "point") {
        res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/path/${encodeURIComponent(selectedPathName)}/spray-mode/point`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            point_execution_mode: pointExecutionMode
          })
        });
        if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
        setActiveSprayMode("point");
        setActivePointExecutionMode(pointExecutionMode);
      }
      setSprayModalOpen(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to set spray mode.");
    }
  };

  const handleSprayMasterToggle = async () => {
    if (!apiBaseUrl) return;
    const nextEnable = !isSprayMasterEnabled;
    setIsSprayMasterChanging(true);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/spray/${nextEnable ? "enable" : "disable"}`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to ${nextEnable ? "enable" : "disable"} master spray.`);
        return;
      }
      const data = await res.json();
      if (data.enabled !== undefined) {
        setIsSprayMasterEnabled(!!data.enabled);
      } else {
        setIsSprayMasterEnabled(nextEnable);
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSprayMasterChanging(false);
    }
  };

  const stagedStartGate = useMemo(
    () => evaluateStagedStartGate(stagedWorkflow, loadedPathInspection, stagedMissionId),
    [stagedWorkflow, loadedPathInspection, stagedMissionId]
  );
  const startBlocked = !stagedStartGate.allowed;
  const protectedResident = isProtectedMissionResident(loadedPathInspection);
  const runningMismatch = runningMissionMismatch(
    getLoadedMissionId(loadedPathInspection),
    loadedPathInspection?.running_mission_id
  );
  const selectedLine = lines.find((line) => line.id === selectedLineId) ?? null;
  const hasPlan = lines.length > 0;
  const hasSelectedLine = Boolean(selectedLine);
  const [safetyControlsEnabled, setSafetyControlsEnabled] = useState(false);
  const [compassExpanded, setCompassExpanded] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteScope, setDeleteScope] = useState<"line" | "plan" | null>(null);
  const [rightPanelMode, setRightPanelMode] = useState<"system" | "details">("system");
  const [isSprayingSet, setIsSprayingSet] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showPointsModal, setShowPointsModal] = useState(false);
  const [joystickPanelOpen, setJoystickPanelOpen] = useState(false);
  const [crossTrackAlerted, setCrossTrackAlerted] = useState(false);

  const isVehicleArmed = telemetrySnapshot?.armed ?? systemHealth?.armed ?? false;
  const vehicleMode = (telemetrySnapshot?.mode ?? systemHealth?.mode ?? "MANUAL").toUpperCase();
  const hasJoystickLease = Boolean(virtualJoystick.leaseId);
  const stickEnabled =
    hasJoystickLease &&
    (virtualJoystick.state === "ACTIVE" || virtualJoystick.state === "HELD");
  const canAcquireJoystick =
    canAcquireJoystickForState({
      missionRunning,
      frontendState: virtualJoystick.state,
      backendJoystickActive: telemetrySnapshot?.joystick_active,
      controlOwner: telemetrySnapshot?.control_owner,
    });

  const handleOpenJoystickPanel = useCallback(() => {
    if (missionRunning) {
      Alert.alert("Mission Running", "Stop the mission before using manual drive.");
      return;
    }
    if (!apiBaseUrl) {
      Alert.alert("No backend", "Connect to a rover backend first.");
      return;
    }
    setJoystickPanelOpen(true);
  }, [apiBaseUrl, missionRunning]);

  const handleCloseJoystickPanel = useCallback(() => {
    virtualJoystick.release();
    setJoystickPanelOpen(false);
  }, [virtualJoystick]);

  useEffect(() => {
    if (!missionRunning) {
      if (crossTrackAlerted) setCrossTrackAlerted(false);
      return;
    }
    const xtrack = telemetrySnapshot?.xtrack_m;
    if (xtrack != null) {
      if (Math.abs(xtrack) >= 0.05) {
        if (!crossTrackAlerted) {
          setCrossTrackAlerted(true);
          Alert.alert(
            "Cross Track Warning",
            `Cross-track error exceeded 5cm (currently ${Math.abs(xtrack).toFixed(2)} m).`,
            [
              { text: "Dismiss", style: "cancel" },
              {
                text: "Pause Mission",
                style: "destructive",
                onPress: onPausePlan,
              }
            ]
          );
        }
      } else {
        if (crossTrackAlerted) {
          setCrossTrackAlerted(false);
        }
      }
    }
  }, [telemetrySnapshot?.xtrack_m, missionRunning, crossTrackAlerted, onPausePlan]);

  const availableLayers = useMemo(() => {
    return {
      boundary: lines.some((l) => l.layer === "boundary"),
      marking: lines.some((l) => l.layer === "marking"),
      center: lines.some((l) => l.layer === "center"),
      transit: lines.some((l) => l.layer === "transit"),
      extension: lines.some((l) => l.layer === "extension"),
    };
  }, [lines]);

  const handleSetSpray = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to save overrides to.");
      return;
    }
    setIsSprayingSet(true);
    try {
      const overridesMap = new Map<string, boolean>();
      lines
        .filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit")
        .forEach(l => {
          overridesMap.set(l.entity!.entity_id, !!l.entity!.is_mark);
        });

      const overrides = Array.from(overridesMap.entries()).map(([entity_id, is_mark]) => ({
        entity_id,
        is_mark
      }));

      const res = await pathApi.saveEntityOverrides(apiBaseUrl, targetPath, overrides);
      if (res.ok) {
        onInvalidateWorkflow?.("spray");
        Alert.alert("Success", "Spray overrides saved.");
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to save spray overrides.");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Network error.");
    } finally {
      setIsSprayingSet(false);
    }
  };

  const pulse = (label: string, ok: boolean | undefined | null) => ({
    label,
    value: ok === undefined || ok === null ? "Unknown" : ok ? "OK" : "Alert",
    tone: ok ? "#16a34a" : ok === false ? "#dc2626" : "#64748b",
  });
  const openExportDialog = () => {
    if (!importedPlan || lines.length === 0) return;
    const baseName = importedPlan.fileName.replace(/\.[^/.]+$/, "") || "generated_plan";
    console.log(`[${new Date().toISOString()}] [UI] EXPORT_OPEN`, { fileName: baseName });
    setExportFileName(baseName);
    setExportDialogOpen(true);
  };

  const saveExportedPlan = async () => {
    if (!importedPlan || lines.length === 0) return;
    const cleanedName = exportFileName.trim().replace(/[\\/:*?"<>|]/g, "_") || "generated_plan";
    const fileContent = linesToDxf(lines, cleanedName);

    try {
      if (Platform.OS === "android") {
        console.log(`[${new Date().toISOString()}] [UI] EXPORT_SAVE_ANDROID`, { fileName: cleanedName });
        const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (permissions.granted) {
          const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
            permissions.directoryUri,
            cleanedName,
            "application/dxf"
          );
          await FileSystem.writeAsStringAsync(fileUri, fileContent, {
            encoding: FileSystem.EncodingType.UTF8,
          });
          setExportDialogOpen(false);
          Alert.alert("Exported", "DXF file saved successfully to your selected folder!");
        } else {
          Alert.alert("Permission Denied", "Cannot export without folder selection permissions.");
        }
      } else {
        const uri = `${FileSystem.documentDirectory ?? ""}${cleanedName}.dxf`;
        console.log(`[${new Date().toISOString()}] [UI] EXPORT_SAVE_FALLBACK`, { fileName: cleanedName, uri });
        await FileSystem.writeAsStringAsync(uri, fileContent, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        setExportDialogOpen(false);
        Alert.alert("Exported", `DXF saved to app storage:\n${uri}`);
      }
    } catch (error: any) {
      console.error("Export save error:", error);
      Alert.alert("Export Failed", error.message || "An unknown error occurred during save.");
    }
  };

  const missionActionButtonStyle = {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  const displayedSpeedMps =
    telemetrySnapshot?.measured_speed_m_s ??
    telemetrySnapshot?.speed_m_s;

  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
      <View style={{ flex: 1, position: "relative" }}>
        <View
          style={{
            position: "absolute",
            left: 14,
            width: "58%",
            top: 14,
            height: 52,
            flexDirection: "row",
            alignItems: "center",
            gap: 14,
            zIndex: 30,
            elevation: 30,
            backgroundColor: "transparent",
          }}
        >
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 16,
              borderWidth: 0,
              backgroundColor: "transparent",
            }}
          >
            <Pressable
              onPress={onToggleMenu}
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "#ffffff",
                borderWidth: 1,
                borderColor: "#e2e8f0",
              }}
            >
              <Menu size={22} color="#0f172a" />
            </Pressable>

            <Pressable
              onPress={() => setMapViewEnabled?.((v) => !v)}
              style={{
                height: 40,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: mapViewEnabled ? "#3b82f6" : "#ffffff",
                borderWidth: 1,
                borderColor: mapViewEnabled ? "#2563eb" : "#e2e8f0",
              }}
            >
              <MapIcon size={16} color={mapViewEnabled ? "#ffffff" : "#0f172a"} />
              <Text style={{ color: mapViewEnabled ? "#ffffff" : "#0f172a", fontSize: 12, fontWeight: "800" }}>
                {mapViewEnabled ? "Map On" : "Map"}
              </Text>
            </Pressable>

            <View style={{ flex: 1, minWidth: 0 }}>
              {importedPlan ? (
                <View style={{ gap: 10 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "800", letterSpacing: 1.1, textTransform: "uppercase" }}>
                        File
                      </Text>
                      <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "800" }} numberOfLines={1}>
                        {importedPlan.fileName}
                      </Text>
                    </View>

                    {missionLoaded ? (
                      <>
                        <View
                          style={{
                            paddingHorizontal: 10,
                            height: 34,
                            borderRadius: 12,
                            backgroundColor: "#dcfce7",
                            alignItems: "center",
                            justifyContent: "center",
                            borderWidth: 1,
                            borderColor: "#86efac",
                          }}
                        >
                          <Text style={{ color: "#166534", fontSize: 12, fontWeight: "800" }}>File loaded</Text>
                        </View>
                        <Pressable
                          onPress={openExportDialog}
                          disabled={lines.length === 0}
                          style={{
                            ...missionActionButtonStyle,
                            backgroundColor: "#ffffff",
                            borderWidth: 1,
                            borderColor: "#cbd5e1",
                            marginRight: 20,
                          }}
                        >
                          <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800" }}>
                            Export
                          </Text>
                        </Pressable>
                      </>
                    ) : null}
                  </View>
                </View>
              ) : (
                <Pressable
                  onPress={() => onNav("fields")}
                  style={{
                    alignSelf: "flex-start",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: "#d7dee8",
                    backgroundColor: "#ffffff",
                  }}
                >
                  <View style={{ width: 34, height: 34, borderRadius: 12, backgroundColor: "#f1f5f9", alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ color: "#0f172a", fontSize: 16, fontWeight: "900" }}>+</Text>
                  </View>
                  <View>
                    <Text style={{ color: "#0f172a", fontSize: 15, fontWeight: "800" }}>No file loaded</Text>
                    <Text style={{ color: "#64748b", fontSize: 11 }}>Tap to load or create one</Text>
                  </View>
                </Pressable>
              )}
            </View>
          </View>
        </View>

        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ width: "58%", backgroundColor: "#ffffff" }}>
            <View style={{ flex: 1, margin: 14, marginTop: 72, borderRadius: 20, overflow: "hidden", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <View style={{ flex: 1, position: "relative" }}>
                <PlanPreview
                  lines={lines}
                  mapSourceLines={mapSourceLines}
                  autoOriginReference={autoOriginReference}
                  mapGeometryFrame={mapGeometryFrame}
                  autoOriginEnabled={autoOriginEnabled}
                  visibility={layerVisibility}
                  selectedLineId={selectedLineId}
                  onSelectLine={onSelectLine}
                  originShiftKey={originShiftKey}
                  roverPosN={previewRoverPoint?.north ?? null}
                  roverPosE={previewRoverPoint?.east ?? null}
                  roverHeadingDeg={telemetrySnapshot?.heading_ned_deg ?? null}
                  missionRunning={missionRunning}
                  alignedRefPoints={alignedRefPoints}
                  telemetryPosN={telemetrySnapshot?.pos_n ?? null}
                  telemetryPosE={telemetrySnapshot?.pos_e ?? null}
                  telemetryPosLat={telemetrySnapshot?.lat ?? null}
                  telemetryPosLon={telemetrySnapshot?.lon ?? null}
                  telemetryPosAlt={telemetrySnapshot?.alt ?? null}
                  mapViewEnabled={mapViewEnabled}
                  showRefPointLabels={showRefPointLabels}
                  activeRefPointLabelIndex={activeRefPointLabelIndex}
                  onToggleRefPointLabel={setActiveRefPointLabelIndex}
                  isVisualAlignmentMode={isVisualAlignmentMode}
                  visualAlignmentItem={visualAlignmentItem}
                  setVisualAlignmentItem={setVisualAlignmentItem}
                  stagedVerified={stagedWorkflow.staged === "verified"}
                />
              </View>
            </View>
          </View>

          <View style={{ width: "42%", height: "100%", backgroundColor: "transparent", padding: 8, paddingLeft: 0 }}>
            <View
              style={{
                flex: 1,
                minHeight: 0,
                backgroundColor: "transparent",
              }}
            >
              {rightPanelMode === "system" ? (
                <View style={{ flex: 1 }}>
                  {/* Top Card: Diagnostics (Light Theme) */}
                  <View style={{
                    flex: 1,
                    borderRadius: 18,
                    backgroundColor: "#ffffff",
                    borderWidth: 1,
                    borderColor: "#e2e8f0",
                    overflow: "hidden",
                  }}>
                    <ScrollView
                      style={{ flex: 1 }}
                      contentContainerStyle={{ padding: 14, paddingBottom: 18 }}
                      showsVerticalScrollIndicator={false}
                    >
                      <View style={{ borderBottomWidth: 1, borderBottomColor: "#f1f5f9", paddingBottom: 12, marginBottom: 12 }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 4, gap: 12 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: "#64748b", fontSize: 9.5, fontWeight: "800", letterSpacing: 1.4, textTransform: "uppercase" }}>
                              Rover Ops
                            </Text>
                            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
                              <Text style={{ color: "#0f172a", fontSize: 22, fontWeight: "900" }}>
                                System Panel
                              </Text>
                              <Text style={{
                                color: (!telemetryError && (systemHealth?.ros_node || systemHealth?.fcu_connected || telemetrySnapshot !== null)) ? "#16a34a" : "#dc2626",
                                fontSize: 11,
                                fontWeight: "800",
                                textTransform: "uppercase",
                                letterSpacing: 0.5
                              }}>
                                {(!telemetryError && (systemHealth?.ros_node || systemHealth?.fcu_connected || telemetrySnapshot !== null)) ? "Live" : "Offline"}
                              </Text>
                            </View>
                            <Text style={{ color: "#475569", fontSize: 12, lineHeight: 17, marginTop: 6 }}>
                              Real-time diagnostics and status feed.
                            </Text>
                          </View>
                          <View style={{ alignItems: "flex-end", gap: 8 }}>
                            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
                              <RadioTower
                                size={18}
                                color={
                                  telemetrySnapshot?.gps_fix === 6
                                    ? "#16a34a"
                                    : telemetrySnapshot?.gps_fix === 5
                                      ? "#ea580c"
                                      : "#dc2626"
                                }
                              />
                              <Battery
                                size={18}
                                color={
                                  telemetrySnapshot?.battery_pct != null
                                    ? telemetrySnapshot.battery_pct >= 50
                                      ? "#16a34a"
                                      : telemetrySnapshot.battery_pct >= 20
                                        ? "#ea580c"
                                        : "#dc2626"
                                    : "#dc2626"
                                }
                              />
                              <Signal
                                size={18}
                                color={
                                  telemetrySnapshot?.gps_sat != null
                                    ? telemetrySnapshot.gps_sat >= 10
                                      ? "#16a34a"
                                      : telemetrySnapshot.gps_sat >= 6
                                        ? "#ea580c"
                                        : "#dc2626"
                                    : "#dc2626"
                                }
                              />
                            </View>
                            <Pressable
                              onPress={() => setRightPanelMode("details")}
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 6,
                                backgroundColor: "#0f172a",
                                paddingHorizontal: 10,
                                paddingVertical: 8,
                                borderRadius: 8,
                              }}
                            >
                              <ListChecks size={14} color="#ffffff" />
                              <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 }}>
                                View Line Details
                              </Text>
                            </Pressable>
                          </View>
                        </View>
                      </View>

                      {telemetryError ? <Text style={[drawerStyles.error, { color: "#b91c1c" }]}>{telemetryError}</Text> : null}
                      {telemetryLoading ? <Text style={[drawerStyles.loading, { color: "#2563eb" }]}>Refreshing live data...</Text> : null}

                      {/* ── Priority section: GPS, Armed, Mode ── */}
                      <View style={{ borderRadius: 14, backgroundColor: "#f8faff", borderWidth: 1, borderColor: "#e2e8f0", padding: 12, marginBottom: 12, gap: 8 }}>
                        <Text style={{ color: "#64748b", fontSize: 9, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 2 }}>GPS & Vehicle Status</Text>
                        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>GPS Fix</Text>
                            <Text style={{ color: telemetrySnapshot?.gps_fix == null ? "#94a3b8" : telemetrySnapshot.gps_fix >= 5 ? "#16a34a" : telemetrySnapshot.gps_fix >= 3 ? "#d97706" : "#dc2626", fontSize: 13, fontWeight: "900", marginTop: 3 }}>
                              {telemetrySnapshot?.gps_fix == null ? "n/a" : telemetrySnapshot.gps_fix === 0 ? "No Fix" : telemetrySnapshot.gps_fix === 4 ? "DGPS" : telemetrySnapshot.gps_fix === 5 ? "RTK Float" : telemetrySnapshot.gps_fix === 6 ? "RTK Fixed" : `Fix (${telemetrySnapshot.gps_fix})`}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Satellites</Text>
                            <Text style={{ color: telemetrySnapshot?.gps_sat == null ? "#94a3b8" : telemetrySnapshot.gps_sat >= 10 ? "#16a34a" : telemetrySnapshot.gps_sat >= 6 ? "#d97706" : "#dc2626", fontSize: 13, fontWeight: "900", marginTop: 3 }}>
                              {telemetrySnapshot?.gps_sat == null ? "n/a" : `${telemetrySnapshot.gps_sat} sats`}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Latitude</Text>
                            <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800", marginTop: 3 }} numberOfLines={1}>
                              {telemetrySnapshot?.lat == null ? "n/a" : telemetrySnapshot.lat.toFixed(6)}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Longitude</Text>
                            <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800", marginTop: 3 }} numberOfLines={1}>
                              {telemetrySnapshot?.lon == null ? "n/a" : telemetrySnapshot.lon.toFixed(6)}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Altitude</Text>
                            <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "900", marginTop: 3 }}>
                              {telemetrySnapshot?.alt == null ? "n/a" : `${telemetrySnapshot.alt.toFixed(1)} m`}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: (telemetrySnapshot?.armed ?? systemHealth?.armed) ? "#fef2f2" : "#f0fdf4", borderRadius: 10, borderWidth: 1, borderColor: (telemetrySnapshot?.armed ?? systemHealth?.armed) ? "#fca5a5" : "#86efac", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Armed</Text>
                            <Text style={{ color: (telemetrySnapshot?.armed ?? systemHealth?.armed) ? "#dc2626" : "#16a34a", fontSize: 13, fontWeight: "900", marginTop: 3 }}>
                              {(telemetrySnapshot?.armed ?? systemHealth?.armed) ? "ARMED" : "DISARMED"}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>Mode</Text>
                            <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "900", marginTop: 3 }}>
                              {telemetrySnapshot?.mode ?? systemHealth?.mode ?? "n/a"}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>HRMS</Text>
                            <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800", marginTop: 3 }} numberOfLines={1}>
                              {telemetrySnapshot?.hrms == null ? "n/a" : `${telemetrySnapshot.hrms.toFixed(3)} m`}
                            </Text>
                          </View>
                          <View style={{ flex: 1, minWidth: 80, backgroundColor: "#ffffff", borderRadius: 10, borderWidth: 1, borderColor: "#e2e8f0", padding: 8 }}>
                            <Text style={{ color: "#94a3b8", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>VRMS</Text>
                            <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800", marginTop: 3 }} numberOfLines={1}>
                              {telemetrySnapshot?.vrms == null ? "n/a" : `${telemetrySnapshot.vrms.toFixed(3)} m`}
                            </Text>
                          </View>
                        </View>
                      </View>


                      <View style={drawerStyles.stripRow}>
                        <StripMetric
                          label="Battery"
                          value={telemetrySnapshot?.battery_pct == null ? "n/a" : `${telemetrySnapshot.battery_pct.toFixed(0)}%`}
                          tone={telemetrySnapshot?.battery_pct == null ? "#64748b" : telemetrySnapshot.battery_pct >= 55 ? "#16a34a" : telemetrySnapshot.battery_pct >= 25 ? "#d97706" : "#dc2626"}
                          icon={<Battery size={13} color="#64748b" />}
                          progressPct={telemetrySnapshot?.battery_pct ?? undefined}
                          light
                        />
                        <StripMetric
                          label="Pose age"
                          value={telemetrySnapshot?.pose_age_ms == null ? "n/a" : `${telemetrySnapshot.pose_age_ms.toFixed(0)} ms`}
                          tone={telemetrySnapshot?.pose_age_ms == null ? "#64748b" : telemetrySnapshot.pose_age_ms <= 500 ? "#16a34a" : telemetrySnapshot.pose_age_ms <= 1500 ? "#d97706" : "#dc2626"}
                          icon={<Signal size={13} color="#64748b" />}
                          light
                        />
                        <StripMetric
                          label="RPP State"
                          value={
                            telemetrySnapshot?.rpp_state_name && telemetrySnapshot?.rpp_state != null
                              ? `${telemetrySnapshot.rpp_state_name} (${telemetrySnapshot.rpp_state})`
                              : telemetrySnapshot?.rpp_state_name || String(telemetrySnapshot?.rpp_state ?? systemHealth?.rpp_state ?? "n/a")
                          }
                          tone="#0f172a"
                          icon={<Tractor size={13} color="#64748b" />}
                          light
                        />
                      </View>

                      <View style={drawerStyles.section}>
                        <SectionTitle title="Telemetry snapshot" light />
                        <MiniGrid
                          items={[
                            ["Speed", displayedSpeedMps == null ? "n/a" : `${displayedSpeedMps.toFixed(2)} m/s`],
                            ["Heading", telemetrySnapshot?.heading_ned_deg == null ? "n/a" : `${telemetrySnapshot.heading_ned_deg.toFixed(1)}°`],
                            ["Cross-track", telemetrySnapshot?.xtrack_m == null ? "n/a" : `${telemetrySnapshot.xtrack_m.toFixed(2)} m`],
                            ["Goal dist", telemetrySnapshot?.dist_to_goal_m == null ? "n/a" : `${telemetrySnapshot.dist_to_goal_m.toFixed(2)} m`],
                            ["Lookahead", telemetrySnapshot?.lookahead_m == null ? "n/a" : `${telemetrySnapshot.lookahead_m.toFixed(2)} m`],
                            ["North (N)", telemetrySnapshot?.pos_n == null ? "n/a" : `${telemetrySnapshot.pos_n.toFixed(2)} m`],
                            ["East (E)", telemetrySnapshot?.pos_e == null ? "n/a" : `${telemetrySnapshot.pos_e.toFixed(2)} m`],
                          ]}
                          light
                        />
                      </View>

                      <View style={drawerStyles.section}>
                        <SectionTitle title="Guidance & Status" light />
                        <MiniGrid
                          items={[
                            ["Heading Err", telemetrySnapshot?.heading_err_deg == null ? "n/a" : `${telemetrySnapshot.heading_err_deg.toFixed(1)}°`],
                            ["Curvature (K)", telemetrySnapshot?.kappa == null ? "n/a" : telemetrySnapshot.kappa.toFixed(4)],
                            ["Battery V", telemetrySnapshot?.battery_v == null ? "n/a" : `${telemetrySnapshot.battery_v.toFixed(2)} V`],
                            ["Pose Age", telemetrySnapshot?.pose_age_ms == null ? "n/a" : `${telemetrySnapshot.pose_age_ms.toFixed(0)} ms`],
                            ["RPP State", telemetrySnapshot?.rpp_state_name ?? "n/a"],
                            ["FCU Connection", systemHealth?.fcu_connected ? "Connected" : "Disconnected"],
                          ]}
                          light
                        />
                      </View>

                      <View style={drawerStyles.section}>
                        <SectionTitle title="System status" light />
                        <MiniGrid
                          items={[
                            ["ROS Node", (systemHealth?.ros_node || telemetrySnapshot !== null) ? "Running" : "Offline"],
                            ["FCU Connection", (telemetrySnapshot?.connected ?? systemHealth?.fcu_connected) ? "Connected" : "Disconnected"],
                            ["Mission State", (telemetrySnapshot?.mission_state ?? systemHealth?.mission_state ?? "Unknown").toUpperCase()],
                          ]}
                          light
                        />
                      </View>
                    </ScrollView>
                  </View>

                  {/* Bottom Card: Controls (Dark Theme) */}
                  <View style={{
                    borderRadius: 18,
                    backgroundColor: "#070c17",
                    padding: 14,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.08)",
                    marginTop: 10,
                  }}>
                    {joystickPanelOpen ? (
                      <View style={{ minHeight: 280 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12, marginTop: 8 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <View style={{ width: 3, height: 10, backgroundColor: "#3b82f6", borderRadius: 1.5 }} />
                            <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8 }}>
                              Manual Drive
                            </Text>
                          </View>
                          <Pressable
                            onPress={handleCloseJoystickPanel}
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 8,
                              backgroundColor: "rgba(255,255,255,0.08)",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <X size={18} color="#e2e8f0" strokeWidth={2.5} />
                          </Pressable>
                        </View>

                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                          <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "700" }}>
                            {virtualJoystick.state}
                          </Text>
                          <Text style={{ color: isVehicleArmed ? "#34d399" : "#f87171", fontSize: 9.5, fontWeight: "700" }}>
                            {isVehicleArmed ? "ARMED" : "DISARMED"}
                          </Text>
                          <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "700" }}>
                            {vehicleMode}
                          </Text>
                          <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "700" }}>
                            {virtualJoystick.commandRateHz.toFixed(0)} Hz
                          </Text>
                          {virtualJoystick.lastCmdAgeMs != null ? (
                            <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "700" }}>
                              cmd {virtualJoystick.lastCmdAgeMs.toFixed(0)}ms
                            </Text>
                          ) : null}
                        </View>

                        <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 8 }}>
                          <ManualJoystick
                            disabled={!stickEnabled}
                            onChange={(values) => {
                              virtualJoystick.setIntent(values.forward, values.yaw);
                            }}
                            onRelease={() => {
                              virtualJoystick.setIntent(0, 0);
                            }}
                          />
                        </View>

                        <Text style={{ color: "#cbd5e1", fontSize: 10, textAlign: "center", lineHeight: 15, marginTop: 6 }}>
                          Throttle {virtualJoystick.displayIntent.throttle >= 0 ? "+" : ""}
                          {virtualJoystick.displayIntent.throttle.toFixed(2)} · Steering{" "}
                          {virtualJoystick.displayIntent.steering >= 0 ? "+" : ""}
                          {virtualJoystick.displayIntent.steering.toFixed(2)}
                        </Text>
                        <Text style={{ color: "#64748b", fontSize: 9.5, textAlign: "center", marginTop: 4 }}>
                          Limits ±{(virtualJoystick.maxThrottle * 100).toFixed(0)}% throttle · ±
                          {(virtualJoystick.maxSteering * 100).toFixed(0)}% steering
                        </Text>

                        {/* Disabled for one-finger joystick drive. Keep the component wiring here for rollback/testing.
                          <View style={{ marginTop: 12 }}>
                            <DeadmanButton
                              disabled={!hasJoystickLease}
                              active={virtualJoystick.deadmanPressed}
                              onPress={() => virtualJoystick.setDeadman(true)}
                              onRelease={() => virtualJoystick.setDeadman(false)}
                            />
                          </View>
                        */}

                        <Text style={{ color: stickEnabled ? "#64748b" : "#f87171", fontSize: 10, textAlign: "center", lineHeight: 15, marginTop: 10 }}>
                          {stickEnabled
                            ? "Move the stick to drive. Return to centre or lift finger to stop."
                            : virtualJoystick.state === "BLOCKED_BY_MISSION"
                              ? "Mission active — release mission before manual drive."
                              : hasJoystickLease
                                ? "Lease held neutral — move the stick to drive."
                                : virtualJoystick.state === "SUSPENDED"
                                  ? "App resumed — wait for telemetry, then acquire again."
                                  : "Press Acquire (vehicle must be armed). Backend confirms MANUAL."}
                        </Text>

                        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                          <Pressable
                            onPress={() => virtualJoystick.acquire()}
                            disabled={
                              !canAcquireJoystick ||
                              virtualJoystick.state === "ACQUIRING" ||
                              virtualJoystick.state === "RELEASING" ||
                              hasJoystickLease
                            }
                            style={{
                              flex: 1,
                              height: 36,
                              borderRadius: 8,
                              backgroundColor:
                                !canAcquireJoystick || hasJoystickLease ? "#1e293b" : "#0d9488",
                              alignItems: "center",
                              justifyContent: "center",
                              opacity: virtualJoystick.state === "ACQUIRING" ? 0.6 : 1,
                            }}
                          >
                            <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>
                              {virtualJoystick.state === "ACQUIRING" ? "Acquiring..." : "Acquire"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => virtualJoystick.release()}
                            disabled={!hasJoystickLease}
                            style={{
                              flex: 1,
                              height: 36,
                              borderRadius: 8,
                              backgroundColor: !hasJoystickLease ? "#1e293b" : "#b45309",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>
                              Release
                            </Text>
                          </Pressable>
                        </View>

                        {virtualJoystick.stopReason ? (
                          <Text style={{ color: "#fbbf24", fontSize: 9.5, textAlign: "center", marginTop: 8 }}>
                            Stop: {virtualJoystick.stopReason}
                          </Text>
                        ) : null}

                        <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
                          <Pressable
                            onPress={() => onArmVehicle?.(!isVehicleArmed)}
                            disabled={missionActionBusy}
                            style={{
                              flex: 1,
                              height: 36,
                              borderRadius: 8,
                              backgroundColor: isVehicleArmed ? "#b91c1c" : "#2563eb",
                              alignItems: "center",
                              justifyContent: "center",
                              opacity: missionActionBusy ? 0.6 : 1,
                            }}
                          >
                            <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>
                              {isVehicleArmed ? "Disarm" : "Arm"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => onSetMode?.("MANUAL")}
                            disabled={missionActionBusy || vehicleMode === "MANUAL"}
                            style={{
                              flex: 1,
                              height: 36,
                              borderRadius: 8,
                              backgroundColor: vehicleMode === "MANUAL" ? "#1e293b" : "#8b5cf6",
                              alignItems: "center",
                              justifyContent: "center",
                              opacity: missionActionBusy ? 0.6 : 1,
                            }}
                          >
                            <Text style={{ color: "#ffffff", fontSize: 11, fontWeight: "800" }}>
                              {vehicleMode === "MANUAL" ? "Manual Ready" : "Set Manual"}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : (
                    <>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 16, marginTop: 12 }}>
                      <View style={{ width: 3, height: 10, backgroundColor: "#10b981", borderRadius: 1.5 }} />
                      <Text style={{ color: "#94a3b8", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8 }}>
                        Mission Controls
                      </Text>
                    </View>

                    <Pressable
                      onPress={() => setSprayModalOpen(true)}
                      style={{
                        backgroundColor: "#0ea5e9",
                        height: 38,
                        borderRadius: 8,
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 12,
                      }}
                    >
                      <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "800", textTransform: "uppercase", textAlign: "center" }}>
                        Spray
                      </Text>
                    </Pressable>

                    <View style={{ flexDirection: "row", gap: 8, marginBottom: 12, alignItems: "center" }}>
                      <Pressable
                        onPress={() => setSafetyControlsEnabled(!safetyControlsEnabled)}
                        style={{
                          flex: 1,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingVertical: 4,
                        }}
                      >
                        <View style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          borderWidth: 1.5,
                          borderColor: safetyControlsEnabled ? "#3b82f6" : "#475569",
                          backgroundColor: safetyControlsEnabled ? "#3b82f6" : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                        }}>
                          {safetyControlsEnabled && (
                            <View style={{
                              width: 6,
                              height: 6,
                              borderRadius: 1,
                              backgroundColor: "#ffffff",
                            }} />
                          )}
                        </View>
                        <Text style={{ color: "#94a3b8", fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 }} numberOfLines={1}>
                          Show Safety
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={onToggleAutoOrigin}
                        style={{
                          flex: 1,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingVertical: 4,
                        }}
                      >
                        <View style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          borderWidth: 1.5,
                          borderColor: autoOrigin ? "#3b82f6" : "#475569",
                          backgroundColor: autoOrigin ? "#3b82f6" : "transparent",
                          alignItems: "center",
                          justifyContent: "center",
                        }}>
                          {autoOrigin && (
                            <View style={{
                              width: 6,
                              height: 6,
                              borderRadius: 1,
                              backgroundColor: "#ffffff",
                            }} />
                          )}
                        </View>
                        <Text style={{ color: "#94a3b8", fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 }} numberOfLines={1}>
                          Origin Check
                        </Text>
                      </Pressable>
                    </View>

                    <View style={{ flexDirection: "row", gap: 8, marginBottom: 12, alignItems: "center" }}>
                      <Pressable
                        onPress={handleOpenJoystickPanel}
                        style={{
                          backgroundColor: "#1d4ed8",
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          alignItems: "center",
                          justifyContent: "center",
                          flexDirection: "row",
                          gap: 6,
                        }}
                      >
                        <Gamepad2 size={14} color="#ffffff" />
                        <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.3 }} numberOfLines={1}>
                          Joystick
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => setRtkModalOpen(true)}
                        style={{
                          backgroundColor: "#16a34a",
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: "#ffffff", fontSize: 10, fontWeight: "800", textTransform: "uppercase", textAlign: "center" }}>
                          RTK Injection
                        </Text>
                      </Pressable>
                    </View>

                    <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                      {activeSprayMode === "point" && activePointExecutionMode === "manual" && (
                        <Pressable
                          onPress={async () => {
                            if (!apiBaseUrl) return;
                            try {
                              const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/mission/point/continue`, { method: "POST" });
                              if (!res.ok) {
                                const err = await res.json();
                                Alert.alert("Error", err.detail || "Failed to continue.");
                              }
                            } catch (e: any) {
                              Alert.alert("Error", e.message || "Failed to continue.");
                            }
                          }}
                          style={{
                            flex: 1,
                            height: 38,
                            borderRadius: 8,
                            backgroundColor: "#8b5cf6",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800", textTransform: "uppercase" }}>Continue</Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={onClearMission}
                        disabled={missionActionBusy}
                        style={{
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          backgroundColor: missionActionBusy ? "#1e293b" : "#f97316",
                          alignItems: "center",
                          justifyContent: "center",
                          opacity: missionActionBusy ? 0.7 : 1,
                        }}
                      >
                        <Text style={{ color: missionActionBusy ? "#64748b" : "#ffffff", fontSize: 12, fontWeight: "800", textTransform: "uppercase" }}>
                          {missionActionBusy ? "Clearing..." : "Clear"}
                        </Text>
                      </Pressable>
                    </View>

                    {startBlocked && stagedStartGate.message ? (
                      <Text style={{ color: "#fbbf24", fontSize: 10, lineHeight: 14, marginBottom: 8 }}>
                        {stagedStartGate.message}
                      </Text>
                    ) : null}

                    {loadedPathInspection?.loaded ? (
                      <Text style={{ color: runningMismatch ? "#f87171" : "#94a3b8", fontSize: 9.5, lineHeight: 14, marginBottom: 8 }}>
                        Staged: {stagedMissionId ?? "n/a"} | Loaded: {getLoadedMissionId(loadedPathInspection) ?? "n/a"} | Running: {loadedPathInspection.running_mission_id ?? "n/a"}{"\n"}
                        Placement: {loadedPathInspection.placement_mode ?? "unknown"} | {loadedPathInspection.protected ? "protected" : "unprotected"}{runningMismatch ? ` | ${runningMismatch}` : ""}
                      </Text>
                    ) : null}

                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Pressable
                        onPress={() => onStartPlan()}
                        disabled={
                          missionActionBusy ||
                          lines.length === 0 ||
                          startBlocked ||
                          virtualJoystick.joystickActive ||
                          Boolean(telemetrySnapshot?.joystick_active)
                        }
                        style={{
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          backgroundColor:
                            missionActionBusy ||
                            lines.length === 0 ||
                            startBlocked ||
                            virtualJoystick.joystickActive ||
                            telemetrySnapshot?.joystick_active
                              ? "#1e293b"
                              : "#0d9488",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text
                          style={{
                            color:
                              missionActionBusy ||
                              lines.length === 0 ||
                              startBlocked ||
                              virtualJoystick.joystickActive ||
                              telemetrySnapshot?.joystick_active
                                ? "#64748b"
                                : "#ffffff",
                            fontSize: 12,
                            fontWeight: "800",
                          }}
                        >
                          Start
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={onPausePlan}
                        disabled={missionActionBusy || lines.length === 0}
                        style={{
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          backgroundColor: (missionActionBusy || lines.length === 0) ? "#1e293b" : "rgba(255,255,255,0.08)",
                          borderWidth: 1,
                          borderColor: "rgba(255,255,255,0.12)",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: (missionActionBusy || lines.length === 0) ? "#64748b" : "#ffffff", fontSize: 12, fontWeight: "800" }}>
                          Pause
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={onStopPlan}
                        disabled={missionActionBusy || lines.length === 0}
                        style={{
                          flex: 1,
                          height: 38,
                          borderRadius: 8,
                          backgroundColor: (missionActionBusy || lines.length === 0) ? "#1e293b" : "#e11d48",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text style={{ color: (missionActionBusy || lines.length === 0) ? "#64748b" : "#ffffff", fontSize: 12, fontWeight: "800" }}>
                          Stop
                        </Text>
                      </Pressable>
                    </View>

                    {safetyControlsEnabled && (
                      <View style={{
                        flexDirection: "row",
                        gap: 8,
                        marginTop: 8,
                        borderTopWidth: 1,
                        borderTopColor: "rgba(255, 255, 255, 0.05)",
                        paddingTop: 8,
                      }}>
                        <Pressable
                          onPress={() => onArmVehicle?.(!(telemetrySnapshot?.armed ?? systemHealth?.armed))}
                          disabled={missionActionBusy}
                          style={{
                            flex: 1,
                            height: 38,
                            borderRadius: 8,
                            backgroundColor: (telemetrySnapshot?.armed ?? systemHealth?.armed) ? "#b91c1c" : "#2563eb",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800" }}>
                            {(telemetrySnapshot?.armed ?? systemHealth?.armed) ? "Disarm" : "Arm"}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => onSetMode?.("MANUAL")}
                          disabled={missionActionBusy || (telemetrySnapshot?.mode ?? systemHealth?.mode) === "MANUAL"}
                          style={{
                            flex: 1,
                            height: 38,
                            borderRadius: 8,
                            backgroundColor: (telemetrySnapshot?.mode ?? systemHealth?.mode) === "MANUAL" ? "#1e293b" : "#8b5cf6",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: missionActionBusy ? 0.6 : 1,
                          }}
                        >
                          <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "800" }}>
                            {(telemetrySnapshot?.mode ?? systemHealth?.mode) === "MANUAL" ? "Manual Ready" : "Set Manual"}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={onEstopVehicle}
                          disabled={missionActionBusy}
                          style={{
                            flex: 1,
                            height: 38,
                            borderRadius: 8,
                            backgroundColor: "#dc2626",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Text style={{ color: "#ffffff", fontSize: 12, fontWeight: "900" }}>
                            E-Stop
                          </Text>
                        </Pressable>
                      </View>
                    )}
                    </>
                    )}
                  </View>
                </View>
              ) : (
                /* Alternate/Fallback Card (Dark Theme) */
                <View style={{
                  flex: 1,
                  borderRadius: 18,
                  backgroundColor: "#070c17",
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.08)",
                  overflow: "hidden",
                }}>
                  <ScrollView
                    style={{ flex: 1 }}
                    contentContainerStyle={{ padding: 14, paddingBottom: 18 }}
                    showsVerticalScrollIndicator={false}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, marginBottom: 8 }}>
                      <View>
                        <Text style={{ color: "#64748b", fontSize: 9.5, fontWeight: "800", letterSpacing: 1.4, textTransform: "uppercase" }}>
                          Rover Ops
                        </Text>
                        <Text style={{ color: "#fff", fontSize: 22, fontWeight: "900", marginTop: 2 }}>
                          Line Details
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => setRightPanelMode("system")}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          backgroundColor: "rgba(255,255,255,0.08)",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <X size={18} color="#e2e8f0" strokeWidth={2.5} />
                      </Pressable>
                    </View>
                    <Text style={{ color: "#94a3b8", fontSize: 12, lineHeight: 17, marginBottom: 4 }}>
                      Tap a line on the canvas, then inspect geometry and spray overrides here.
                    </Text>

                    <View style={drawerStyles.section}>
                      <SectionTitle title="Visible layers" />
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {availableLayers.boundary && <CompactLayerToggle label="Boundary" value={layerVisibility.boundary} onToggle={() => setLayerVisibility((prev) => ({ ...prev, boundary: !prev.boundary }))} />}
                        {availableLayers.marking && <CompactLayerToggle label="Marking" value={layerVisibility.marking} onToggle={() => setLayerVisibility((prev) => ({ ...prev, marking: !prev.marking }))} />}
                        {availableLayers.center && <CompactLayerToggle label="Center" value={layerVisibility.center} onToggle={() => setLayerVisibility((prev) => ({ ...prev, center: !prev.center }))} />}
                        {availableLayers.transit && <CompactLayerToggle label="Transit" value={layerVisibility.transit} onToggle={() => setLayerVisibility((prev) => ({ ...prev, transit: !prev.transit }))} />}
                        {availableLayers.extension && <CompactLayerToggle label="Extension" value={layerVisibility.extension} onToggle={() => setLayerVisibility((prev) => ({ ...prev, extension: !prev.extension }))} />}
                      </View>
                      <View style={{ marginTop: 12 }}>
                        <CompactLayerToggle label="Show Reference Point Labels" value={showRefPointLabels} onToggle={() => setShowRefPointLabels(prev => !prev)} />
                      </View>
                    </View>

                    {selectedLine ? (
                      <>
                        {/* TOP SECTION: Line Details */}
                        {/* TOP SECTION: Geometry Details with Points */}
                        <View style={drawerStyles.section}>
                          <SectionTitle title="Geometry Details" />
                          <View style={{ borderRadius: 16, padding: 12, backgroundColor: "#111827", borderWidth: 1, borderColor: "rgba(148,163,184,0.16)", gap: 10 }}>
                            <ListRow left="Entity Type" right={selectedLine.entity?.entity_type || "Segment"} tone="#fff" />
                            <ListRow left="Line ID" right={selectedLine.id} tone="#fff" />
                            <ListRow left="Layer" right={selectedLine.layer} tone="#fff" />
                            <ListRow left="Length" right={`${selectedLine.entity?.length_m != null ? selectedLine.entity.length_m.toFixed(2) : lineLength(selectedLine).toFixed(2)} m`} tone="#fff" />
                            <ListRow left="From" right={`(${selectedLine.from.x.toFixed(2)}, ${selectedLine.from.y.toFixed(2)})`} tone="#fff" />
                            <ListRow left="To" right={`(${selectedLine.to.x.toFixed(2)}, ${selectedLine.to.y.toFixed(2)})`} tone="#fff" />

                            <View style={{ marginTop: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.05)" }}>
                              <Text style={{ color: "#94a3b8", fontSize: 10, fontWeight: "700", textTransform: "uppercase", marginBottom: 8 }}>
                                Available Points ({selectedLine.entity?.preview_points?.length || 2})
                              </Text>
                              <View style={{ maxHeight: 100, backgroundColor: "#0f172a", borderRadius: 8, padding: 8, borderWidth: 1, borderColor: "rgba(148,163,184,0.1)" }}>
                                <ScrollView nestedScrollEnabled={true}>
                                  {(selectedLine.entity?.preview_points || [
                                    { north: selectedLine.from.x, east: selectedLine.from.y },
                                    { north: selectedLine.to.x, east: selectedLine.to.y }
                                  ]).map((pt: any, i: number, arr: any[]) => (
                                    <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: i === arr.length - 1 ? 0 : 1, borderBottomColor: "rgba(148,163,184,0.05)" }}>
                                      <Text style={{ color: "#94a3b8", fontSize: 11, fontFamily: "monospace" }}>Pt {i + 1}</Text>
                                      <Text style={{ color: "#fff", fontSize: 11, fontFamily: "monospace" }}>N: {Number(pt.north).toFixed(2)}, E: {Number(pt.east).toFixed(2)}</Text>
                                    </View>
                                  ))}
                                </ScrollView>
                              </View>
                            </View>
                          </View>
                        </View>
                      </>
                    ) : (
                      <View style={[drawerStyles.section, { marginTop: 18 }]}>
                        <EmptyLine text="Tap a highlighted line in the canvas to see its details here." />
                      </View>
                    )}

                    {/* ALWAYS VISIBLE AT BOTTOM: Line Viewer & Set Spray */}
                    {importedPlan?.fileType === "dxf" && (
                      <View style={[drawerStyles.section, { marginTop: 24, paddingBottom: 20 }]}>
                        <SectionTitle title="Line Viewer (Spray Overrides)" />
                        <View style={{ borderRadius: 16, padding: 12, backgroundColor: "#1e293b", borderWidth: 1, borderColor: "rgba(148,163,184,0.16)", maxHeight: 250 }}>

                          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)", marginBottom: 4 }}>
                            <Text style={{ color: "#fff", fontSize: 12, fontWeight: "600" }}>Total: {lines.filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit").length}</Text>
                            <Pressable
                              onPress={() => {
                                onInvalidateWorkflow?.("spray");
                                const entityLines = lines.filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit");
                                const anyUnmarked = entityLines.some(l => !l.entity!.is_mark);
                                setLines(prev => prev.map((entry) => {
                                  if (entry.entity && entry.entity.entity_id && entry.layer !== "extension" && entry.layer !== "transit") {
                                    return { ...entry, entity: { ...entry.entity, is_mark: anyUnmarked } };
                                  }
                                  return entry;
                                }));
                              }}
                              style={{ backgroundColor: "rgba(255,255,255,0.08)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}
                            >
                              <Text style={{ color: "#38bdf8", fontSize: 10, fontWeight: "800", textTransform: "uppercase" }}>Toggle All</Text>
                            </Pressable>
                          </View>

                          <ScrollView nestedScrollEnabled={true}>
                            {lines.filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit").map((line, idx) => (
                              <View key={line.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" }}>
                                <View style={{ flex: 1 }}>
                                  <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>{line.label}</Text>
                                  <Text style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>{line.layer}</Text>
                                </View>
                                <Pressable
                                  onPress={() => {
                                    if (line.entity) {
                                      onInvalidateWorkflow?.("spray");
                                      setLines(prev =>
                                        prev.map((entry) =>
                                          entry.id === line.id && entry.entity
                                            ? {
                                              ...entry,
                                              entity: {
                                                ...entry.entity,
                                                is_mark: !entry.entity.is_mark,
                                              },
                                            }
                                            : entry
                                        )
                                      );
                                    }
                                  }}
                                  style={{
                                    width: 24, height: 24, borderRadius: 6, borderWidth: 1,
                                    borderColor: line.entity?.is_mark ? "#0d9488" : "rgba(148,163,184,0.5)",
                                    backgroundColor: line.entity?.is_mark ? "#0d9488" : "transparent",
                                    alignItems: "center", justifyContent: "center"
                                  }}
                                >
                                  {line.entity?.is_mark && <CheckIcon size={14} color="#fff" />}
                                </Pressable>
                              </View>
                            ))}
                          </ScrollView>
                        </View>

                        <Pressable
                          onPress={handleSetSpray}
                          disabled={isSprayingSet}
                          style={{
                            marginTop: 16,
                            backgroundColor: isSprayingSet ? "#334155" : "#0f988f",
                            paddingVertical: 14,
                            borderRadius: 12,
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                        >
                          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "800" }}>
                            {isSprayingSet ? "Saving..." : "Set Spray"}
                          </Text>
                        </Pressable>
                      </View>
                    )}


                  </ScrollView>
                </View>
              )}
            </View>
          </View>
        </View>

        <Modal transparent visible={deleteDialogOpen} animationType="fade" onRequestClose={() => setDeleteDialogOpen(false)}>
          <Pressable
            style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.25)", justifyContent: "center", padding: 20 }}
            onPress={() => {
              setDeleteDialogOpen(false);
              setDeleteScope(null);
            }}
          >
            <Pressable
              onPress={() => { }}
              style={{
                backgroundColor: "#fff",
                borderRadius: 22,
                padding: 18,
                borderWidth: 1,
                borderColor: "#d7dee8",
                maxWidth: 520,
                width: "100%",
                alignSelf: "center",
                shadowColor: "#000",
                shadowOpacity: 0.12,
                shadowRadius: 20,
                shadowOffset: { width: 0, height: 12 },
                elevation: 5,
              }}
            >
              <Text style={{ color: "#0f172a", fontSize: 20, fontWeight: "800" }}>Delete what?</Text>
              <Text style={{ color: "#64748b", marginTop: 6, lineHeight: 20 }}>
                Choose whether to delete the selected line or remove the entire plan.
              </Text>

              <View style={{ marginTop: 16, padding: 12, borderRadius: 18, backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#e2e8f0" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>
                  Choice
                </Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    disabled={!hasSelectedLine}
                    onPress={() => setDeleteScope("line")}
                    style={{
                      flex: 1,
                      paddingVertical: 14,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: deleteScope === "line" ? "#0f172a" : "#d7dee8",
                      backgroundColor: deleteScope === "line" ? "#eef2ff" : "#ffffff",
                      alignItems: "center",
                      opacity: hasSelectedLine ? 1 : 0.45,
                    }}
                  >
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>Selected line</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setDeleteScope("plan")}
                    style={{
                      flex: 1,
                      paddingVertical: 14,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: deleteScope === "plan" ? "#0f172a" : "#d7dee8",
                      backgroundColor: deleteScope === "plan" ? "#eef2ff" : "#ffffff",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>Full plan</Text>
                  </Pressable>
                </View>
                {!hasSelectedLine ? (
                  <Text style={{ color: "#94a3b8", fontSize: 12, marginTop: 10, lineHeight: 18 }}>
                    No line is selected, so the selected-line option is disabled.
                  </Text>
                ) : null}
              </View>

              <View style={{ marginTop: 18, padding: 12, borderRadius: 18, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e2e8f0" }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>
                  Action
                </Text>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Pressable
                    onPress={() => {
                      setDeleteDialogOpen(false);
                      setDeleteScope(null);
                    }}
                    style={{
                      flex: 1,
                      paddingVertical: 13,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      backgroundColor: "#f8fafc",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    disabled={!deleteScope || (deleteScope === "line" && !hasSelectedLine)}
                    onPress={() => {
                      if (deleteScope === "line") {
                        onDeleteSelectedLine();
                      } else if (deleteScope === "plan") {
                        onConfirmDeletePlan();
                      }
                      setDeleteDialogOpen(false);
                      setDeleteScope(null);
                    }}
                    style={{
                      flex: 1,
                      paddingVertical: 13,
                      borderRadius: 16,
                      backgroundColor: deleteScope && !(deleteScope === "line" && !hasSelectedLine) ? "#b91c1c" : "#94a3b8",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#fff", fontWeight: "800" }}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        {/* Points Modal */}
        <Modal transparent visible={showPointsModal} animationType="slide" onRequestClose={() => setShowPointsModal(false)}>
          <View style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.6)", padding: 40, justifyContent: "center", alignItems: "center" }}>
            <View style={{ width: "100%", maxWidth: 600, backgroundColor: "#1e293b", borderRadius: 24, overflow: "hidden", maxHeight: "90%" }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.1)" }}>
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800" }}>Entity Preview Points</Text>
                <Pressable onPress={() => setShowPointsModal(false)} style={{ padding: 4 }}>
                  <X size={24} color="#94a3b8" />
                </Pressable>
              </View>
              <ScrollView style={{ flex: 1, padding: 20 }}>
                <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.1)", paddingBottom: 8, marginBottom: 8 }}>
                  <Text style={{ flex: 1, color: "#94a3b8", fontWeight: "700" }}>#</Text>
                  <Text style={{ flex: 2, color: "#94a3b8", fontWeight: "700" }}>North</Text>
                  <Text style={{ flex: 2, color: "#94a3b8", fontWeight: "700" }}>East</Text>
                </View>
                {(selectedLine?.entity?.preview_points || []).map((pt: any, i: number) => (
                  <View key={i} style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" }}>
                    <Text style={{ flex: 1, color: "#cbd5e1" }}>{i + 1}</Text>
                    <Text style={{ flex: 2, color: "#fff", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>{pt.north.toFixed(4)}</Text>
                    <Text style={{ flex: 2, color: "#fff", fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>{pt.east.toFixed(4)}</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {menuOpen ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 64,
              bottom: 0,
              width: "50%",
              backgroundColor: "#0f172a",
              paddingVertical: 14,
              paddingHorizontal: 12,
              zIndex: 20,
              elevation: 20,
            }}
          >
            {MENU_ITEMS.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => onNav(item.key)}
                style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 12 }}
              >
                <View
                  style={{
                    width: 68,
                    height: 68,
                    backgroundColor: "#111827",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#334155",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  {item.icon}
                </View>
                <Text style={{ color: "#f8fafc", fontSize: 34 / 2 }}>{item.label}</Text>
              </Pressable>
            ))}
            <View style={{ marginTop: 4 }}>
              <Pressable onPress={onDisconnect} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <View
                  style={{
                    width: 68,
                    height: 68,
                    backgroundColor: "#111827",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#334155",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <LogOut size={22} color="#fff" />
                </View>
                <Text style={{ color: "#f8fafc", fontSize: 34 / 2 }}>Exit</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <Modal transparent visible={exportDialogOpen} animationType="fade" onRequestClose={() => setExportDialogOpen(false)}>
        <Pressable
          onPress={() => setExportDialogOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(15,23,42,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => { }}
            style={{
              width: "100%",
              maxWidth: 360,
              borderRadius: 16,
              backgroundColor: "#ffffff",
              padding: 16,
              borderWidth: 1,
              borderColor: "#d8e1eb",
            }}
          >
            <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900" }}>Export File</Text>
            <Text style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
              Choose the filename for the exported DXF.
            </Text>
            <TextInput
              value={exportFileName}
              onChangeText={setExportFileName}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="generated_plan"
              style={{
                marginTop: 12,
                height: 44,
                borderWidth: 1,
                borderColor: "#cbd5e1",
                borderRadius: 12,
                paddingHorizontal: 12,
                backgroundColor: "#f8fafc",
                color: "#0f172a",
              }}
            />
            <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
              <Pressable
                onPress={() => setExportDialogOpen(false)}
                style={{
                  flex: 1,
                  height: 42,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "#e2e8f0",
                }}
              >
                <Text style={{ color: "#0f172a", fontWeight: "800" }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveExportedPlan}
                style={{
                  flex: 1,
                  height: 42,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "#0b6b68",
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "800" }}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal transparent visible={sprayModalOpen} animationType="fade" onRequestClose={() => setSprayModalOpen(false)}>
        <Pressable
          onPress={() => setSprayModalOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(15,23,42,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => { }}
            style={{
              width: "100%",
              maxWidth: 360,
              borderRadius: 16,
              backgroundColor: "#ffffff",
              padding: 16,
              borderWidth: 1,
              borderColor: "#d8e1eb",
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900" }}>Spray Configuration</Text>
              <Pressable onPress={() => setSprayModalOpen(false)} hitSlop={10}>
                <X size={20} color="#94a3b8" />
              </Pressable>
            </View>

            {/* Master Spray Enable */}
            <View style={{ backgroundColor: "#f8fafc", padding: 12, borderRadius: 12, marginBottom: 16 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: "#334155", fontSize: 14, fontWeight: "700" }}>Master Spray Gate</Text>
                {isSprayMasterEnabled && (
                  <View style={{ backgroundColor: "#22c55e", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ color: "#fff", fontSize: 9, fontWeight: "bold" }}>ENABLED</Text>
                  </View>
                )}
              </View>
              <Pressable
                onPress={handleSprayMasterToggle}
                disabled={isSprayMasterChanging}
                style={{
                  marginTop: 10,
                  backgroundColor: isSprayMasterChanging ? "#94a3b8" : isSprayMasterEnabled ? "#ef4444" : "#0ea5e9",
                  paddingVertical: 10,
                  borderRadius: 8,
                  alignItems: "center"
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>
                  {isSprayMasterChanging ? "..." : isSprayMasterEnabled ? "Spray Disable" : "Spray Enable"}
                </Text>
              </Pressable>
            </View>

            {/* Mode Selection */}
            {!selectedPathName ? (
              <View style={{ backgroundColor: "#fef2f2", padding: 12, borderRadius: 8, marginBottom: 16, borderWidth: 1, borderColor: "#fecaca" }}>
                <Text style={{ color: "#b91c1c", fontSize: 12, fontWeight: "600", textAlign: "center" }}>
                  You must load a path/plan to configure spray modes.
                </Text>
              </View>
            ) : (
              <>
                <View style={{ flexDirection: "row", backgroundColor: "#e2e8f0", borderRadius: 8, padding: 4, marginBottom: 16 }}>
                  {(["continuous", "dashed", "point"] as const).map(tab => (
                    <Pressable
                      key={tab}
                      onPress={() => setSprayTab(tab)}
                      style={{
                        flex: 1,
                        paddingVertical: 8,
                        alignItems: "center",
                        backgroundColor: sprayTab === tab ? "#ffffff" : "transparent",
                        borderRadius: 6,
                      }}
                    >
                      <Text style={{ color: sprayTab === tab ? "#0f172a" : "#64748b", fontSize: 12, fontWeight: sprayTab === tab ? "700" : "500", textTransform: "capitalize" }}>
                        {tab}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {sprayTab === "continuous" && (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={{ color: "#64748b", fontSize: 12, marginBottom: 12 }}>Standard continuous spraying along marked regions.</Text>
                    <Pressable
                      onPress={handleSetSprayMode}
                      style={{ backgroundColor: "#0ea5e9", paddingVertical: 10, borderRadius: 8, alignItems: "center" }}
                    >
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Set Mode</Text>
                    </Pressable>
                  </View>
                )}

                {sprayTab === "dashed" && (
                  <View style={{ marginBottom: 16 }}>
                    <View style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: "#64748b", fontSize: 12, marginBottom: 6 }}>Distance On (m)</Text>
                        <TextInput value={dashDistanceOn} onChangeText={setDashDistanceOn} keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#f8fafc" }} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: "#64748b", fontSize: 12, marginBottom: 6 }}>Distance Off (m)</Text>
                        <TextInput value={dashDistanceOff} onChangeText={setDashDistanceOff} keyboardType="numeric" style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: "#f8fafc" }} />
                      </View>
                    </View>
                    <Pressable
                      onPress={handleSetSprayMode}
                      style={{ backgroundColor: "#0ea5e9", paddingVertical: 10, borderRadius: 8, alignItems: "center" }}
                    >
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Set Mode</Text>
                    </Pressable>
                  </View>
                )}

                {sprayTab === "point" && (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={{ color: "#64748b", fontSize: 12, marginBottom: 6 }}>Execution Mode</Text>
                    <View style={{ flexDirection: "row", backgroundColor: "#f1f5f9", borderRadius: 8, padding: 4, marginBottom: 12 }}>
                      {(["auto", "manual"] as const).map(mode => (
                        <Pressable
                          key={mode}
                          onPress={() => setPointExecutionMode(mode as any)}
                          style={{ flex: 1, paddingVertical: 6, alignItems: "center", backgroundColor: pointExecutionMode === mode ? "#ffffff" : "transparent", borderRadius: 6 }}
                        >
                          <Text style={{ color: pointExecutionMode === mode ? "#0f172a" : "#64748b", fontSize: 12, fontWeight: pointExecutionMode === mode ? "700" : "500", textTransform: "capitalize" }}>{mode}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Pressable
                      onPress={handleSetSprayMode}
                      style={{ backgroundColor: "#0ea5e9", paddingVertical: 10, borderRadius: 8, alignItems: "center" }}
                    >
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Set Mode</Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

          </Pressable>
        </Pressable>
      </Modal>

      <Modal transparent visible={rtkModalOpen} animationType="fade" onRequestClose={() => setRtkModalOpen(false)}>
        <Pressable
          onPress={() => !rtkConnecting && setRtkModalOpen(false)}
          style={{
            flex: 1,
            backgroundColor: "rgba(15,23,42,0.45)",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Pressable
            onPress={() => { }}
            style={{
              width: "100%",
              maxWidth: 380,
              borderRadius: 16,
              backgroundColor: "#ffffff",
              padding: 20,
              borderWidth: 1,
              borderColor: "#d8e1eb",
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.15,
              shadowRadius: 10,
              elevation: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <RadioTower size={22} color="#0ea5e9" />
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900" }}>RTK Caster Configuration</Text>
              </View>
              <Pressable
                onPress={async () => {
                  try {
                    const result = await DocumentPicker.getDocumentAsync({ type: ["text/plain", "public.plain-text", "*/*"] });
                    if (result.canceled || !result.assets || result.assets.length === 0) return;
                    const uri = result.assets[0].uri;
                    const content = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
                    const lines = content.split(/\r?\n/);
                    let foundAny = false;
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (!trimmed || trimmed.startsWith("#")) continue;
                      const match = trimmed.match(/^([^:=]+)[:=](.*)$/);
                      if (match) {
                        const key = match[1].trim().toLowerCase();
                        const val = match[2].trim();
                        if (key === "host" || key === "caster host") { setRtkCaster(val); foundAny = true; }
                        else if (key === "port") { setRtkPort(val); foundAny = true; }
                        else if (key === "mountpoint" || key === "mount point") { setRtkMountPoint(val); foundAny = true; }
                        else if (key === "username" || key === "user") { setRtkUsername(val); foundAny = true; }
                        else if (key === "password" || key === "pass") { setRtkPassword(val); foundAny = true; }
                      }
                    }
                    if (!foundAny) {
                      Alert.alert("Invalid File", "No matching RTK keys found in the file.");
                    }
                  } catch (e) {
                    Alert.alert("Import Failed", "Could not read the RTK file.");
                  }
                }}
                style={{ padding: 6, backgroundColor: "#f1f5f9", borderRadius: 8 }}
              >
                <FileUp size={18} color="#0f172a" />
              </Pressable>
            </View>
            <Text style={{ color: "#64748b", fontSize: 11.5, marginBottom: 14 }}>
              Enter NTRIP caster credentials to inject RTK correction data into the GPS.
            </Text>

            <View style={{ gap: 10 }}>
              <View>
                <Text style={{ color: "#475569", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 }}>Caster Host</Text>
                <TextInput
                  value={rtkCaster}
                  onChangeText={setRtkCaster}
                  editable={!rtkRunning}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="caster.emlid.com"
                  style={{
                    height: 38,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    backgroundColor: rtkRunning ? "#e2e8f0" : "#f8fafc",
                    color: rtkRunning ? "#64748b" : "#0f172a",
                    fontSize: 13,
                  }}
                />
              </View>

              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1.5 }}>
                  <Text style={{ color: "#475569", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 }}>Port</Text>
                  <TextInput
                    value={rtkPort}
                    onChangeText={setRtkPort}
                    editable={!rtkRunning}
                    keyboardType="numeric"
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="2101"
                    style={{
                      height: 38,
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      backgroundColor: rtkRunning ? "#e2e8f0" : "#f8fafc",
                      color: rtkRunning ? "#64748b" : "#0f172a",
                      fontSize: 13,
                    }}
                  />
                </View>
                <View style={{ flex: 2 }}>
                  <Text style={{ color: "#475569", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 }}>Mount Point</Text>
                  <TextInput
                    value={rtkMountPoint}
                    onChangeText={setRtkMountPoint}
                    editable={!rtkRunning}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="e.g. MP23960a"
                    style={{
                      height: 38,
                      borderWidth: 1,
                      borderColor: "#cbd5e1",
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      backgroundColor: rtkRunning ? "#e2e8f0" : "#f8fafc",
                      color: rtkRunning ? "#64748b" : "#0f172a",
                      fontSize: 13,
                    }}
                  />
                </View>
              </View>

              <View>
                <Text style={{ color: "#475569", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 }}>Username</Text>
                <TextInput
                  value={rtkUsername}
                  onChangeText={setRtkUsername}
                  editable={!rtkRunning}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="NTRIP Username"
                  style={{
                    height: 38,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    backgroundColor: rtkRunning ? "#e2e8f0" : "#f8fafc",
                    color: rtkRunning ? "#64748b" : "#0f172a",
                    fontSize: 13,
                  }}
                />
              </View>

              <View>
                <Text style={{ color: "#475569", fontSize: 9.5, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 }}>Password</Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    height: 38,
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                    borderRadius: 8,
                    backgroundColor: rtkRunning ? "#e2e8f0" : "#f8fafc",
                    paddingRight: 10,
                  }}
                >
                  <TextInput
                    value={rtkPassword}
                    onChangeText={setRtkPassword}
                    editable={!rtkRunning}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="NTRIP Password"
                    style={{
                      flex: 1,
                      height: "100%",
                      paddingHorizontal: 10,
                      color: rtkRunning ? "#64748b" : "#0f172a",
                      fontSize: 13,
                    }}
                  />
                  <Pressable
                    onPress={() => setShowPassword(!showPassword)}
                    style={{
                      padding: 4,
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    {showPassword ? (
                      <EyeOff size={16} color="#64748b" />
                    ) : (
                      <Eye size={16} color="#64748b" />
                    )}
                  </Pressable>
                </View>
              </View>
            </View>

            {/* Row 1 */}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
              <Pressable
                onPress={() => !rtkConnecting && setRtkModalOpen(false)}
                disabled={rtkConnecting}
                style={{ flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#e2e8f0" }}
              >
                <Text style={{ color: "#0f172a", fontWeight: "800", fontSize: 13 }}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={startNtrip}
                disabled={rtkConnecting || rtkRunning}
                style={{ flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: (rtkConnecting || rtkRunning) ? "#93c5fd" : "#0ea5e9" }}
              >
                <Text style={{ color: "#ffffff", fontWeight: "800", fontSize: 13 }}>Ntrip Start</Text>
              </Pressable>
            </View>

            {/* Row 2 */}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
              <Pressable
                onPress={startLora}
                disabled={rtkConnecting || rtkRunning}
                style={{ flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: (rtkConnecting || rtkRunning) ? "#a78bfa" : "#8b5cf6" }}
              >
                <Text style={{ color: "#ffffff", fontWeight: "800", fontSize: 13 }}>Lora Start</Text>
              </Pressable>

              {rtkRunning ? (
                <Pressable
                  onPress={stopRtk}
                  disabled={rtkConnecting}
                  style={{ flex: 1, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#dc2626" }}
                >
                  <Text style={{ color: "#ffffff", fontWeight: "800", fontSize: 13 }}>Stop</Text>
                </Pressable>
              ) : (
                <View style={{ flex: 1 }} />
              )}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

    </View>
  );
}

function HeaderTelemetryPill({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <View style={headerTelemetryStyles.pill}>
      <View style={headerTelemetryStyles.iconWrap}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={headerTelemetryStyles.label}>{label}</Text>
        <Text style={[headerTelemetryStyles.value, { color: tone }]} numberOfLines={1}>
          {value}
        </Text>
      </View>

    </View>
  );
}

function CompassOverlay({
  telemetrySnapshot,
  expanded,
  onToggleExpanded,
}: {
  telemetrySnapshot: TelemetrySnapshot | null;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const hasPosition = telemetrySnapshot?.pos_n != null || telemetrySnapshot?.pos_e != null;

  return (
    <Pressable style={compassStyles.wrap} hitSlop={10} onPress={onToggleExpanded}>
      <View style={compassStyles.header}>
        <View style={compassStyles.dot} />
        <Text style={compassStyles.title}>{hasPosition ? "Position" : "Compass"}</Text>
      </View>
      <View style={compassStyles.body}>
        <View style={compassStyles.northTick} />
        <View style={compassStyles.centerRing}>
          <Text style={compassStyles.centerText}>
            {expanded ? "N/E" : hasPosition ? "Tap map" : "Tap"}
          </Text>
        </View>
      </View>
      <View style={compassStyles.values}>
        {expanded ? (
          <>
            <Text style={compassStyles.valueText}>
              North {telemetrySnapshot?.pos_n == null ? "--" : telemetrySnapshot.pos_n.toFixed(2)}
            </Text>
            <Text style={compassStyles.valueText}>
              East {telemetrySnapshot?.pos_e == null ? "--" : telemetrySnapshot.pos_e.toFixed(2)}
            </Text>
          </>
        ) : (
          <>
            <Text style={compassStyles.valueText}>
              N {telemetrySnapshot?.pos_n == null ? "--" : telemetrySnapshot.pos_n.toFixed(2)}
            </Text>
            <Text style={compassStyles.valueText}>
              E {telemetrySnapshot?.pos_e == null ? "--" : telemetrySnapshot.pos_e.toFixed(2)}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

function TelemetryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <View style={telemetryStatStyles.card}>
      <Text style={telemetryStatStyles.label}>{label}</Text>
      <Text style={[telemetryStatStyles.value, { color: tone }]}>{value}</Text>
    </View>
  );
}

function boolText(value: boolean | null | undefined) {
  if (value == null) return "n/a";
  return value ? "YES" : "NO";
}

function boolTone(value: boolean | null | undefined) {
  if (value == null) return "#94a3b8";
  return value ? "#22c55e" : "#ef4444";
}

function telemetryTone(value: number | null | undefined, lowGood: number, highGood: number) {
  if (value == null) return "#94a3b8";
  if (value >= highGood) return "#22c55e";
  if (value >= lowGood) return "#d97706";
  return "#ef4444";
}

const compassStyles = {
  wrap: {
    position: "absolute" as const,
    left: 12,
    bottom: 12,
    width: 160,
    borderRadius: 18,
    backgroundColor: "rgba(15,23,42,0.9)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.24)",
    padding: 12,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: "#22c55e",
  },
  title: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800" as const,
    letterSpacing: 0.8,
    textTransform: "uppercase" as const,
  },
  body: {
    marginTop: 10,
    height: 58,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    position: "relative" as const,
  },
  northTick: {
    position: "absolute" as const,
    top: 7,
    width: 2,
    height: 12,
    borderRadius: 99,
    backgroundColor: "#38bdf8",
  },
  centerRing: {
    width: 36,
    height: 36,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  centerText: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: "700" as const,
  },
  values: {
    marginTop: 10,
    gap: 2,
  },
  valueText: {
    color: "#e2e8f0",
    fontSize: 11,
    fontWeight: "700" as const,
  },
} as const;

const telemetryStatStyles = {
  card: {
    minWidth: 92,
    flexGrow: 1,
    flexBasis: "30%" as const,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 0.5,
    textTransform: "uppercase" as const,
  },
  value: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "800" as const,
    marginTop: 4,
  },
} as const;

const headerTelemetryStyles = {
  pill: {
    minWidth: 94,
    flex: 1,
    flexBasis: "48%" as const,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 10,
    backgroundColor: "#e2e8f0",
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  label: {
    color: "#64748b",
    fontSize: 9,
    fontWeight: "800" as const,
    letterSpacing: 0.7,
    textTransform: "uppercase" as const,
  },
  value: {
    color: "#0f172a",
    fontSize: 11,
    fontWeight: "800" as const,
    marginTop: 2,
  },
} as const;

const telemetryCtaStyles = {
  outer: {
    width: "100%",
    minHeight: 84,
    borderRadius: 18,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#d7e0ea",
    overflow: "hidden" as const,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  inner: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  leftRail: {
    width: 18,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 99,
    backgroundColor: "#0f172a",
  },
  line: {
    width: 2,
    height: 30,
    borderRadius: 999,
    backgroundColor: "#cbd5e1",
  },
  title: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "900" as const,
  },
  subtitle: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  chevronWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "#e2e8f0",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
} as const;

function LineDetailsDrawer({
  visible,
  onClose,
  selectedLine,
  hasPlan,
  layerVisibility,
  setLayerVisibility,
  showRefPointLabels,
  setShowRefPointLabels,
}: {
  visible: boolean;
  onClose: () => void;
  selectedLine: PlanLine | null;
  hasPlan: boolean;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  showRefPointLabels: boolean;
  setShowRefPointLabels: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.2)" }} onPress={onClose}>
        <View style={drawerStyles.sheet}>
          <Pressable style={drawerStyles.close} onPress={onClose}>
            <Text style={drawerStyles.closeText}>×</Text>
          </Pressable>
          <View style={{ marginTop: 4 }}>
            <Text style={{ color: "#64748b", fontSize: 9.5, fontWeight: "800", letterSpacing: 1.4, textTransform: "uppercase" }}>
              Rover Ops
            </Text>
            <Text style={{ color: "#fff", fontSize: 22, fontWeight: "900", marginTop: 2 }}>
              Line Details
            </Text>
          </View>
          <Text style={{ color: "#94a3b8", fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 4 }}>
                      Tap a line on the canvas, then inspect geometry and spray overrides here.
          </Text>

          <View style={drawerStyles.grid}>
            <StatCard
              label="Selection"
              value={{
                label: "Current line",
                value: selectedLine ? selectedLine.label : "No line selected",
                tone: selectedLine ? "#ffffff" : "#64748b",
              }}
            />
            <StatCard
              label="Status"
              value={{
                label: "Drawer state",
                value: selectedLine ? "Loaded" : "Empty",
                tone: selectedLine ? "#16a34a" : "#d97706",
              }}
            />
            <StatCard
              label="Layer"
              value={{
                label: "Visible layers",
                value: hasPlan ? "Available" : "No plan",
                tone: hasPlan ? "#ffffff" : "#64748b",
              }}
            />
            <StatCard
              label="Info"
              value={{
                label: "Line geometry",
                value: selectedLine ? `${lineLength(selectedLine).toFixed(2)} m` : "n/a",
                tone: "#ffffff",
              }}
            />
          </View>

          {selectedLine ? (
            <>
              <View style={drawerStyles.stripRow}>
                <StripMetric label="Length" value={`${lineLength(selectedLine).toFixed(2)} m`} tone="#ffffff" />
                <StripMetric label="Angle" value={`${lineAngle(selectedLine).toFixed(2)}°`} tone="#ffffff" />
                <StripMetric label="Width" value={`${selectedLine.width.toFixed(2)} m`} tone="#ffffff" />
              </View>

              <View style={drawerStyles.section}>
                <SectionTitle title="Geometry" />
                <View style={{ borderRadius: 16, padding: 12, backgroundColor: "#111827", borderWidth: 1, borderColor: "rgba(148,163,184,0.16)", gap: 10 }}>
                  <ListRow left="Line label" right={selectedLine.label} tone="#fff" />
                  <ListRow left="Layer" right={selectedLine.layer} tone="#fff" />
                  <ListRow left="From" right={`(${selectedLine.from.x.toFixed(2)}, ${selectedLine.from.y.toFixed(2)})`} tone="#fff" />
                  <ListRow left="To" right={`(${selectedLine.to.x.toFixed(2)}, ${selectedLine.to.y.toFixed(2)})`} tone="#fff" />
                  <ListRow left="Point IDs" right={`${selectedLine.from.id} -> ${selectedLine.to.id}`} tone="#fff" />
                  <ListRow left="Line ID" right={selectedLine.id} tone="#fff" />
                </View>
              </View>

              <View style={drawerStyles.section}>
                <SectionTitle title="Visible layers" />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <CompactLayerToggle
                    label="Boundary"
                    value={layerVisibility.boundary}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, boundary: !prev.boundary }))}
                  />
                  <CompactLayerToggle
                    label="Marking"
                    value={layerVisibility.marking}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, marking: !prev.marking }))}
                  />
                  <CompactLayerToggle
                    label="Center"
                    value={layerVisibility.center}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, center: !prev.center }))}
                  />
                  <CompactLayerToggle
                    label="Transit"
                    value={layerVisibility.transit}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, transit: !prev.transit }))}
                  />
                  <CompactLayerToggle
                    label="Extension"
                    value={layerVisibility.extension}
                    onToggle={() => setLayerVisibility((prev) => ({ ...prev, extension: !prev.extension }))}
                  />
                </View>
                <View style={{ marginTop: 12 }}>
                  <CompactLayerToggle
                    label="Show Reference Point Labels"
                    value={showRefPointLabels}
                    onToggle={() => setShowRefPointLabels(prev => !prev)}
                  />
                </View>
              </View>
            </>
          ) : (
            <View style={[drawerStyles.section, { marginTop: 18 }]}>
              <EmptyLine text="Tap a highlighted line in the canvas to see its details here." />
            </View>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

function StatCard({ label, value, fullWidth, light }: { label: string; value: { label: string; value: string; tone: string }; fullWidth?: boolean; light?: boolean }) {
  const accentColor = (value.tone === "#ffffff" || value.tone === "#fff" || value.tone === "#0f172a") ? "#3b82f6" : value.tone || "#475569";

  let cardBg = undefined;
  if (light) {
    if (value.tone === "#16a34a") {
      cardBg = "#f0fdf4"; // Very soft green tint
    } else if (value.tone === "#dc2626") {
      cardBg = "#fef2f2"; // Very soft red tint
    } else if (value.tone === "#d97706") {
      cardBg = "#fffbeb"; // Very soft amber tint
    }
  }

  return (
    <View style={[
      light ? drawerStyles.lightCard : drawerStyles.card,
      cardBg && { backgroundColor: cardBg },
      fullWidth && { width: "100%", flexBasis: "100%" },
      { borderLeftWidth: 3, borderLeftColor: accentColor }
    ]}>
      <Text style={light ? drawerStyles.lightCardLabel : drawerStyles.cardLabel}>{label}</Text>
      <Text style={[light ? drawerStyles.lightCardValue : drawerStyles.cardValue, { color: light ? "#0f172a" : "#ffffff" }]}>{value.value}</Text>
      <Text style={light ? drawerStyles.lightCardMeta : drawerStyles.cardMeta}>{value.label}</Text>
    </View>
  );
}

function StripMetric({ label, value, tone, icon, progressPct, light }: { label: string; value: string; tone: string; icon?: React.ReactNode; progressPct?: number; light?: boolean }) {
  const isLightText = tone === "#ffffff" || tone === "#fff";
  const displayTone = light && isLightText ? "#0f172a" : tone;
  return (
    <View style={[light ? drawerStyles.lightStrip : drawerStyles.strip, { position: "relative", overflow: "hidden" }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {icon}
        <Text style={light ? drawerStyles.lightStripLabel : drawerStyles.stripLabel}>{label}</Text>
      </View>
      <Text style={[light ? drawerStyles.lightStripValue : drawerStyles.stripValue, { color: displayTone }]}>{value}</Text>
      {progressPct !== undefined && (
        <View style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 4,
          backgroundColor: light ? "#e2e8f0" : "rgba(255,255,255,0.06)",
        }}>
          <View style={{
            width: `${Math.min(100, Math.max(0, progressPct))}%`,
            height: "100%",
            backgroundColor: displayTone,
          }} />
        </View>
      )}
    </View>
  );
}

function SectionTitle({ title, light }: { title: string; light?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, marginTop: 12 }}>
      <View style={{ width: 3, height: 10, backgroundColor: "#3b82f6", borderRadius: 1.5 }} />
      <Text style={light ? drawerStyles.lightSectionTitle : drawerStyles.sectionTitle}>{title}</Text>
      {light && (
        <View style={{ flex: 1, height: 1, backgroundColor: "#e2e8f0", marginLeft: 4 }} />
      )}
    </View>
  );
}

function MiniGrid({ items, light }: { items: Array<[string, string]>; light?: boolean }) {
  return (
    <View style={{
      borderRadius: 12,
      backgroundColor: light ? "#f8fafc" : "#111827",
      borderWidth: 1,
      borderColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
      overflow: "hidden",
      marginTop: 4,
    }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {items.map(([label, value], index) => {
          const isRightColumn = index % 2 === 1;
          const isBottomRow = index >= items.length - 2;
          return (
            <View
              key={label}
              style={{
                width: "50%",
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRightWidth: isRightColumn ? 0 : 1,
                borderRightColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
                borderBottomWidth: isBottomRow ? 0 : 1,
                borderBottomColor: light ? "#e2e8f0" : "rgba(255, 255, 255, 0.05)",
              }}
            >
              <Text style={{ color: "#64748b", fontSize: 8.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {label}
              </Text>
              <Text style={{ color: light ? "#0f172a" : "#ffffff", fontSize: 12, fontWeight: "800", marginTop: 2 }}>
                {value}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function ListRow({ left, right, tone }: { left: string; right: string; tone: string }) {
  return (
    <View style={drawerStyles.row}>
      <Text style={drawerStyles.rowLeft} numberOfLines={1}>{left}</Text>
      <Text style={[drawerStyles.rowRight, { color: tone }]} numberOfLines={1}>{right}</Text>
    </View>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <Text style={drawerStyles.empty}>{text}</Text>;
}

const drawerStyles = {
  sheet: {
    position: "absolute" as const,
    right: 0,
    top: 0,
    bottom: 0,
    width: "42%",
    minWidth: 340,
    maxWidth: 520,
    backgroundColor: "#070c17",
    padding: 14,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(255,255,255,0.08)",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: -8, height: 0 },
    elevation: 8,
  },
  close: {
    alignSelf: "flex-end" as const,
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: "rgba(148,163,184,0.12)",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginBottom: 8,
  },
  closeText: { color: "#fff", fontSize: 22, lineHeight: 22, marginTop: -2 },
  kicker: { color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.6, textTransform: "uppercase" as const },
  title: { color: "#fff", fontSize: 28, fontWeight: "900", marginTop: 6 },
  subtitle: { color: "#cbd5e1", fontSize: 13, lineHeight: 19, marginTop: 8, maxWidth: 380 },
  error: { color: "#fecaca", marginTop: 10, fontWeight: "700" as const },
  loading: { color: "#bfdbfe", marginTop: 10, fontWeight: "700" as const },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 10 },
  card: { flexGrow: 1, width: "48%", minWidth: 120, borderRadius: 12, backgroundColor: "#111827", borderWidth: 1, borderColor: "rgba(255,255,255,0.06)", paddingVertical: 10, paddingHorizontal: 12, flexDirection: "column" as const, overflow: "hidden" as const },
  cardLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, letterSpacing: 0.8, textTransform: "uppercase" as const },
  cardValue: { color: "#fff", fontSize: 15, fontWeight: "800" as const, marginTop: 4 },
  cardMeta: { color: "#94a3b8", fontSize: 9.5, marginTop: 2 },
  lightCard: { flexGrow: 1, width: "48%", minWidth: 120, borderRadius: 12, backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#e2e8f0", paddingVertical: 10, paddingHorizontal: 12, flexDirection: "column" as const, overflow: "hidden" as const },
  lightCardLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, letterSpacing: 0.8, textTransform: "uppercase" as const },
  lightCardValue: { color: "#0f172a", fontSize: 15, fontWeight: "800" as const, marginTop: 4 },
  lightCardMeta: { color: "#475569", fontSize: 9.5, marginTop: 2 },
  stripRow: { flexDirection: "row" as const, gap: 8, marginTop: 8 },
  strip: { flex: 1, borderRadius: 10, backgroundColor: "#111827", paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  stripLabel: { color: "#64748b", fontSize: 8.5, fontWeight: "800" as const, textTransform: "uppercase" as const },
  stripValue: { color: "#fff", fontSize: 12.5, fontWeight: "800" as const, marginTop: 3 },
  lightStrip: { flex: 1, borderRadius: 10, backgroundColor: "#f8fafc", paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: "#e2e8f0" },
  lightStripLabel: { color: "#64748b", fontSize: 8.5, fontWeight: "800" as const, textTransform: "uppercase" as const },
  lightStripValue: { color: "#0f172a", fontSize: 12.5, fontWeight: "800" as const, marginTop: 3 },
  section: { marginTop: 12 },
  sectionTitle: { color: "#94a3b8", fontSize: 10.5, fontWeight: "800" as const, letterSpacing: 1, textTransform: "uppercase" as const, marginBottom: 0 },
  lightSectionTitle: { color: "#0f172a", fontSize: 10.5, fontWeight: "800" as const, letterSpacing: 1, textTransform: "uppercase" as const, marginBottom: 0 },
  miniGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
  miniCell: { width: "31.5%", minWidth: 88, borderRadius: 10, backgroundColor: "#111827", padding: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  miniLabel: { color: "#64748b", fontSize: 9, fontWeight: "800" as const, textTransform: "uppercase" as const },
  miniValue: { color: "#fff", fontSize: 12, fontWeight: "800" as const, marginTop: 4 },
  list: { gap: 6 },
  row: { flexDirection: "row" as const, justifyContent: "space-between", gap: 10, borderRadius: 8, backgroundColor: "#111827", paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  rowLeft: { color: "#e2e8f0", fontSize: 11.5, flexShrink: 1, paddingRight: 8 },
  rowRight: { color: "#fff", fontSize: 11, fontWeight: "800" as const },
  empty: { color: "#94a3b8", fontSize: 12, paddingVertical: 8 },
} as const;

function CompactLayerToggle({
  label,
  value,
  onToggle,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: value ? "#0f172a" : "#cbd5e1",
        backgroundColor: value ? "#e2e8f0" : "#f8fafc",
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: value ? "#0f172a" : "#94a3b8",
          backgroundColor: value ? "#0f172a" : "#fff",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {value ? <Text style={{ color: "#fff", fontSize: 11, fontWeight: "800" }}>✓</Text> : null}
      </View>
      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function DetailStatCard({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexBasis: "48%",
        flexGrow: 1,
        minWidth: 120,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "#d8e1eb",
        backgroundColor: "#ffffff",
        paddingHorizontal: 12,
        paddingVertical: 12,
        gap: 6,
      }}
    >
      <Text style={{ color: "#64748b", fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8 }}>
        {label}
      </Text>
      <Text style={{ color: "#0f172a", fontSize: 15, fontWeight: "800" }}>
        {value}
      </Text>
    </View>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <Text
        style={{
          color: "#64748b",
          fontSize: 12,
          fontWeight: "800",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          width: 92,
          flexShrink: 0,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: "#0f172a",
          fontSize: 13,
          fontWeight: "700",
          flex: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
function SectionScreen(props: {
  title: string;
  page: Page;
  telemetrySnapshot: TelemetrySnapshot | null;
  missionRunning: boolean;
  previewRoverPoint: { north: number; east: number } | null;
  importedPlan: ImportedPlan | null;
  lines: PlanLine[];
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  selectedLineId: string | null;
  onBack: () => void;
  onSelectLine: (id: string | null) => void;
  onGenerateTemplate: (name: string, lines: PlanLine[]) => void;
  layerVisibility: LayerVisibility;
  setLayerVisibility: React.Dispatch<React.SetStateAction<LayerVisibility>>;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  onRunTemplate: (name: string, lines: PlanLine[]) => Promise<void>;
  missionFileReady: boolean;
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  toggleD: boolean;
  delayA: number;
  delayB: number;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  setToggleD: (v: boolean) => void;
  setDelayA: (v: number) => void;
  setDelayB: (v: number) => void;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (missionId?: string) => void;
  missionActionBusy: boolean;
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onParsePlan?: () => Promise<void>;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
  segmentVerification: pathApi.PathSegmentsResponse | null;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApi.PathSegmentsResponse | null>>;
  stagedPlanResult: StagedPlanResultState | null;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  stagedMissionInspection: pathApi.StagedMissionResponse | null;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  stagedMissionId: string | null;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  onNav: (page: Page) => void;
  extensionsEnabled?: boolean;
  setExtensionsEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  extPre?: string;
  setExtPre?: React.Dispatch<React.SetStateAction<string>>;
  extAft?: string;
  setExtAft?: React.Dispatch<React.SetStateAction<string>>;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  setMapViewEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  showRefPointLabels: boolean;
  setShowRefPointLabels?: React.Dispatch<React.SetStateAction<boolean>>;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  extractedCorners?: { dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null>>;
}) {
  const { title, page, onBack, mapViewEnabled, setMapViewEnabled } = props;

  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <TopBar
        title={title}
        onBack={onBack}
        mapViewEnabled={mapViewEnabled}
        setMapViewEnabled={setMapViewEnabled}
      />

      {page === "fields" ? <FieldsPage {...props} /> : null}
      {page === "templates" ? (
        <TemplatesPage
          {...props}
          renderPlanPreview={(previewProps) => (
            <PlanPreview
              {...previewProps}
              alignedRefPoints={props.alignedRefPoints}
              telemetryPosN={props.telemetrySnapshot?.pos_n ?? null}
              telemetryPosE={props.telemetrySnapshot?.pos_e ?? null}
              telemetryPosLat={props.telemetrySnapshot?.lat ?? null}
              telemetryPosLon={props.telemetrySnapshot?.lon ?? null}
              telemetryPosAlt={props.telemetrySnapshot?.alt ?? null}
              mapViewEnabled={mapViewEnabled}
              showRefPointLabels={props.showRefPointLabels}
              activeRefPointLabelIndex={props.activeRefPointLabelIndex}
              onToggleRefPointLabel={props.setActiveRefPointLabelIndex}
              isVisualAlignmentMode={props.isVisualAlignmentMode}
              visualAlignmentItem={props.visualAlignmentItem}
              setVisualAlignmentItem={props.setVisualAlignmentItem}
            />
          )}
        />
      ) : null}
      {page === "swozi" ? <SwoziPage {...props} /> : null}
      {page === "status" ? <StatusPage /> : null}
      {page === "positioning" ? <PositioningPage {...props} /> : null}
      {page === "settings" ? <SettingsPage {...props} /> : null}
      {page === "howto" ? <HowToPage /> : null}
      {page === "about" ? <AboutPage /> : null}
    </View>
  );
}

function ConnectionView({
  selectedWs,
  manualHost,
  wsError,
  wsStatus,
  isOffline,
  discoveredRovers,
  onRefresh,
  onSelect,
  onManualHostChange,
  onConnect,
  onOfflinePreview,
}: {
  selectedWs: string;
  manualHost: string;
  wsError: string;
  wsStatus: string;
  isOffline: boolean;
  discoveredRovers: Array<{ id: string; name: string; host: string; port: number; version?: string; responseTime?: number }>;
  onRefresh: () => void;
  onSelect: (value: string) => void;
  onManualHostChange: (value: string) => void;
  onConnect: () => void;
  onOfflinePreview: () => void;
}) {
  const selectedTarget = selectedWs || manualHost;
  const pingState = wsStatus === "scanning" ? "Checking" : isOffline ? "No reply" : "Ready";
  const healthState = selectedWs
    ? wsStatus === "connected"
      ? "Connected"
      : "Selected"
    : "No target";
  const discoverState = discoveredRovers.length > 0 ? `${discoveredRovers.length} found` : "None yet";

  return (
    <View style={{ flex: 1, backgroundColor: "#eef2f7", padding: 16 }}>
      <View
        style={{
          flex: 1,
          maxWidth: 1280,
          width: "100%",
          alignSelf: "center",
          flexDirection: "row",
          gap: 14,
        }}
      >
        <View
          style={{
            flex: 0.95,
            borderRadius: 26,
            backgroundColor: "#0f172a",
            padding: 20,
            justifyContent: "space-between",
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 22,
            shadowOffset: { width: 0, height: 12 },
            elevation: 5,
          }}
        >
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <View
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 999,
                  backgroundColor: isOffline ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)",
                  borderWidth: 1,
                  borderColor: isOffline ? "rgba(239,68,68,0.28)" : "rgba(34,197,94,0.22)",
                }}
              >
                <Text style={{ color: isOffline ? "#fecaca" : "#bbf7d0", fontSize: 12, fontWeight: "800" }}>
                  {isOffline ? "Offline" : "Backend reachable"}
                </Text>
              </View>
              {wsStatus === "scanning" ? (
                <View
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: "rgba(96,165,250,0.12)",
                    borderWidth: 1,
                    borderColor: "rgba(96,165,250,0.22)",
                  }}
                >
                  <Text style={{ color: "#bfdbfe", fontSize: 12, fontWeight: "800" }}>Scanning network</Text>
                </View>
              ) : null}
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ color: "#f8fafc", fontSize: 36, fontWeight: "900", lineHeight: 40 }}>
                Connect to Rover Backend
              </Text>
              <Text style={{ color: "#cbd5e1", fontSize: 15, lineHeight: 22, maxWidth: 440 }}>
                The tablet scans the current Wi-Fi subnet for a reachable backend, then lets you connect to continue into the main app.
              </Text>
            </View>
          </View>

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>1</Text>
                <Text style={connectionStyles.infoLabel}>Ping</Text>
                <Text style={connectionStyles.infoText}>{pingState}</Text>
                <Text style={connectionStyles.infoDetail}>{selectedTarget}</Text>
              </View>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>2</Text>
                <Text style={connectionStyles.infoLabel}>Health</Text>
                <Text style={connectionStyles.infoText}>{healthState}</Text>
                <Text style={connectionStyles.infoDetail}>Socket.IO on port 5001</Text>
              </View>
              <View style={connectionStyles.infoCard}>
                <Text style={connectionStyles.infoValue}>3</Text>
                <Text style={connectionStyles.infoLabel}>Discover</Text>
                <Text style={connectionStyles.infoText}>{discoverState}</Text>
                <Text style={connectionStyles.infoDetail}>Auto-scanned on current Wi-Fi</Text>
              </View>
            </View>

            <View style={{ paddingTop: 8, borderTopWidth: 1, borderTopColor: "rgba(148,163,184,0.18)" }}>
              <Text style={{ color: "#cbd5e1", fontSize: 12, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase" }}>
                How it works
              </Text>
              <Text style={{ color: "#94a3b8", fontSize: 13, lineHeight: 20, marginTop: 6 }}>
                The connection screen auto-scans the network, shows any discovered rover targets, and lets you connect dynamically.
              </Text>
            </View>
          </View>
        </View>

        <View
          style={{
            flex: 1.05,
            borderRadius: 26,
            backgroundColor: "#ffffff",
            padding: 16,
            shadowColor: "#000",
            shadowOpacity: 0.06,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 10 },
            elevation: 3,
            borderWidth: 1,
            borderColor: "#d7dee8",
          }}
        >
          <View style={{ flex: 1, justifyContent: "space-between", gap: 14 }}>
            <View style={{ gap: 12 }}>
              <View>
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "800" }}>Manual backend address</Text>
                <Text style={{ color: "#64748b", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                  Type the rover IP if discovery does not show it.
                </Text>
              </View>

              <TextInput
                value={manualHost}
                onChangeText={onManualHostChange}
                placeholder="http://192.168.1.102:5001"
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  borderRadius: 16,
                  paddingHorizontal: 14,
                  paddingVertical: 14,
                  color: "#0f172a",
                  backgroundColor: "#f8fafc",
                }}
              />

              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => onSelect(manualHost)}
                  style={{
                    backgroundColor: "#0f172a",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>Use manual address</Text>
                </Pressable>
                <Pressable
                  onPress={onConnect}
                  disabled={!manualHost || wsStatus === "connecting"}
                  style={{
                    backgroundColor: !manualHost ? "#94a3b8" : "#2563eb",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                    opacity: wsStatus === "connecting" ? 0.85 : 1,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>
                    {wsStatus === "connecting" ? "Connecting..." : "Connect"}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={{ flex: 1, minHeight: 0 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                <View style={{ flex: 1, minWidth: 150 }}>
                  <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "800" }}>Available Connections</Text>
                  <Text style={{ color: "#64748b", marginTop: 4, fontSize: 13, lineHeight: 18 }}>
                    Select an active rover backend discovered on your network.
                  </Text>
                </View>
                <Pressable
                  onPress={onRefresh}
                  disabled={wsStatus === "scanning"}
                  style={{
                    backgroundColor: "#e2e8f0",
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 12,
                    alignSelf: "flex-start",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800" }}>
                    {wsStatus === "scanning" ? "Scanning..." : "Refresh scan"}
                  </Text>
                </Pressable>
              </View>

              <View style={{ flex: 1, gap: 10, marginTop: 8 }}>
                {discoveredRovers.length > 0 ? (
                  <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                    {discoveredRovers.map((rover) => {
                      const url = `http://${rover.host}:${rover.port}`;
                      const isSelected = selectedWs === url;
                      return (
                        <Pressable
                          key={`${rover.id}-${url}`}
                          onPress={() => onSelect(url)}
                          style={{
                            padding: 12,
                            borderRadius: 16,
                            borderWidth: 1,
                            borderColor: isSelected ? "#0f172a" : "#d7dee8",
                            backgroundColor: isSelected ? "#eef2ff" : "#ffffff",
                          }}
                        >
                          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: "#0f172a", fontWeight: "800", fontSize: 15 }}>{rover.name}</Text>
                              <Text style={{ color: "#64748b", marginTop: 4 }}>{url}</Text>
                            </View>
                            <View
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 999,
                                backgroundColor: isSelected ? "#0f172a" : "#f1f5f9",
                              }}
                            >
                              <Text style={{ color: isSelected ? "#fff" : "#334155", fontSize: 11, fontWeight: "800" }}>
                                {isSelected ? "Selected" : "Tap to select"}
                              </Text>
                            </View>
                          </View>
                          <Text style={{ color: "#64748b", marginTop: 6, fontSize: 12 }}>
                            {rover.version ? `v${rover.version}` : "Socket.IO backend"}
                            {typeof rover.responseTime === "number" ? ` • ${rover.responseTime} ms` : ""}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : (
                  <View
                    style={{
                      flex: 1,
                      borderRadius: 18,
                      borderWidth: 1,
                      borderColor: "#d7dee8",
                      backgroundColor: "#f8fafc",
                      padding: 16,
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#334155", fontSize: 15, lineHeight: 22, textAlign: "center" }}>
                      No active backend found. Ensure the server is running on the laptop and tap "Refresh scan" above.
                    </Text>
                  </View>
                )}
              </View>
            </View>

            <View style={{ gap: 10 }}>
              {wsError ? (
                <View style={{ padding: 12, borderRadius: 14, backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca" }}>
                  <Text style={{ color: "#b91c1c", fontWeight: "700" }}>{wsError}</Text>
                </View>
              ) : null}

              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable
                  onPress={onConnect}
                  disabled={!selectedTarget || wsStatus === "connecting"}
                  style={{
                    flex: 1,
                    backgroundColor: !selectedTarget ? "#94a3b8" : "#2563eb",
                    paddingHorizontal: 16,
                    paddingVertical: 13,
                    borderRadius: 16,
                    opacity: wsStatus === "connecting" ? 0.85 : 1,
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "800" }}>
                    {wsStatus === "connecting" ? "Connecting..." : "Connect"}
                  </Text>
                </Pressable>
              </View>

              <Pressable
                onPress={onOfflinePreview}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 14,
                  borderRadius: 18,
                  borderWidth: 1,
                  borderColor: "#cbd5e1",
                  backgroundColor: "#f8fafc",
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: 12,
                  minHeight: 72,
                  shadowColor: "#0f172a",
                  shadowOpacity: 0.05,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 4 },
                  elevation: 1,
                }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    backgroundColor: "#e2e8f0",
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                  }}
                >
                  <Waves size={19} color="#0f172a" />
                </View>
                <View style={{ flex: 1, paddingRight: 4 }}>
                  <Text style={{ color: "#0f172a", fontWeight: "900", fontSize: 15.5 }}>Offline Preview</Text>
                  <Text style={{ color: "#64748b", fontSize: 12, marginTop: 2, lineHeight: 16 }}>
                    Open the app without connecting to the backend
                  </Text>
                </View>
                <View
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: "#e2e8f0",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 11, fontWeight: "800" }}>Local</Text>
                </View>
              </Pressable>

              <Text style={{ color: "#64748b", fontSize: 12, lineHeight: 18 }}>
                Backend runs on <Text style={{ color: "#334155", fontWeight: "700" }}>server/main.py</Text> via Socket.IO on port <Text style={{ color: "#334155", fontWeight: "700" }}>5001</Text>.
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const connectionStyles = {
  infoCard: {
    flexGrow: 1,
    minWidth: 120,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.16)",
  },
  infoValue: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "900" as const,
  },
  infoLabel: {
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: "800" as const,
    marginTop: 4,
  },
  infoText: {
    color: "#94a3b8",
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  infoDetail: {
    color: "#cbd5e1",
    fontSize: 11,
    marginTop: 8,
    lineHeight: 16,
    opacity: 0.9,
  },
};

type AlignmentResultState = {
  method: unknown;
  scale: number | null;
  rotation_deg: number | null;
  offset_n: number | null;
  offset_e: number | null;
  origin_gps: unknown;
  rmse_m: number | null;
  sample_coords: unknown;
  residuals: unknown;
  warnings: unknown;
};

type StagedPlanResultState = {
  missionId: string;
  numWaypoints: number | null;
  numSegments: number | null;
  totalLengthM: number | null;
  markLengthM: number | null;
  transitLengthM: number | null;
  estimatedPaintL: number | null;
  estimatedRuntimeS: number | null;
  rmseM: number | null;
  warnings: string[];
};

function FieldsPage({
  importedPlan,
  setImportedPlan,
  lines,
  mapSourceLines,
  autoOriginReference = null,
  mapGeometryFrame = "NONE",
  autoOriginEnabled = false,
  setLines,
  previewRoverPoint,
  missionRunning,
  telemetrySnapshot,
  selectedLineId,
  layerVisibility,
  backendPaths,
  selectedPathName,
  onSelectPath,
  onLoadSelectedPath,
  missionActionBusy,
  onSelectLine,
  apiBaseUrl,
  onRefreshPaths,
  onParsePlan,
  onWorkflowStep,
  stagedWorkflow,
  alignmentResult,
  setAlignmentResult,
  verifiedAlignmentRequest,
  setVerifiedAlignmentRequest,
  segmentVerification,
  setSegmentVerification,
  stagedPlanResult,
  setStagedPlanResult,
  stagedMissionInspection,
  setStagedMissionInspection,
  stagedMissionId,
  setStagedMissionId,
  loadedPathInspection,
  onInvalidateWorkflow,
  showRefPointLabels = false,
  extensionsEnabled = false,
  setExtensionsEnabled,
  alignedRefPoints = [],
  setAlignedRefPoints,
  mapViewEnabled = false,
  activeRefPointLabelIndex = null,
  setActiveRefPointLabelIndex,
  isVisualAlignmentMode,
  visualAlignmentItem,
  setVisualAlignmentItem,
  onStartVisualAlignment,
  onConfirmVisualAlignment,
  extractedCorners,
  setExtractedCorners,
}: {
  importedPlan: ImportedPlan | null;
  setImportedPlan: React.Dispatch<React.SetStateAction<ImportedPlan | null>>;
  lines: PlanLine[];
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  setLines: React.Dispatch<React.SetStateAction<PlanLine[]>>;
  previewRoverPoint: { north: number; east: number } | null;
  missionRunning: boolean;
  telemetrySnapshot: TelemetrySnapshot | null;
  selectedLineId: string | null;
  layerVisibility: LayerVisibility;
  backendPaths: any[];
  selectedPathName: string | null;
  onSelectPath: (name: string) => void;
  onLoadSelectedPath: (missionId?: string) => void;
  missionActionBusy: boolean;
  onSelectLine: (id: string | null) => void;
  apiBaseUrl: string;
  onRefreshPaths: () => void;
  onParsePlan?: () => Promise<void>;
  onWorkflowStep?: (step: StagedWorkflowStep, status: StagedWorkflowStatus) => void;
  stagedWorkflow: StagedWorkflowState;
  alignmentResult: AlignmentResultState | null;
  setAlignmentResult: React.Dispatch<React.SetStateAction<AlignmentResultState | null>>;
  verifiedAlignmentRequest: pathApi.AlignPathRequest | null;
  setVerifiedAlignmentRequest: React.Dispatch<React.SetStateAction<pathApi.AlignPathRequest | null>>;
  segmentVerification: pathApi.PathSegmentsResponse | null;
  setSegmentVerification: React.Dispatch<React.SetStateAction<pathApi.PathSegmentsResponse | null>>;
  stagedPlanResult: StagedPlanResultState | null;
  setStagedPlanResult: React.Dispatch<React.SetStateAction<StagedPlanResultState | null>>;
  stagedMissionInspection: pathApi.StagedMissionResponse | null;
  setStagedMissionInspection: React.Dispatch<React.SetStateAction<pathApi.StagedMissionResponse | null>>;
  stagedMissionId: string | null;
  setStagedMissionId: React.Dispatch<React.SetStateAction<string | null>>;
  loadedPathInspection: missionApi.LoadedPathResponse | null;
  onInvalidateWorkflow: (step: "alignment" | "spray" | "staged" | "loaded") => void;
  extensionsEnabled?: boolean;
  setExtensionsEnabled?: React.Dispatch<React.SetStateAction<boolean>>;
  extPre?: string;
  setExtPre?: React.Dispatch<React.SetStateAction<string>>;
  extAft?: string;
  setExtAft?: React.Dispatch<React.SetStateAction<string>>;
  alignedRefPoints?: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  setAlignedRefPoints?: React.Dispatch<React.SetStateAction<{ dxf_x: number; dxf_y: number; lat: number; lon: number }[]>>;
  mapViewEnabled?: boolean;
  activeRefPointLabelIndex?: number | null;
  setActiveRefPointLabelIndex?: React.Dispatch<React.SetStateAction<number | null>>;
  showRefPointLabels?: boolean;
  isVisualAlignmentMode?: boolean;
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
  onStartVisualAlignment?: () => void;
  onConfirmVisualAlignment?: () => void;
  extractedCorners?: { dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null;
  setExtractedCorners?: React.Dispatch<React.SetStateAction<{ dxf_x: number, dxf_y: number, lat: number, lon: number }[] | null>>;
}) {
  const [pickedFile, setPickedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [refPoints, setRefPoints] = useState<{ dxf_x: number; dxf_y: number; lat: string; lon: string }[]>([]);
  const [alignmentMethod, setAlignmentMethod] = useState<"least_squares" | "single_point" | "visual_alignment">("least_squares");
  const [rotationDeg, setRotationDeg] = useState<string>("");
  const [isFixing, setIsFixing] = useState(false);
  const [missionSummary, setMissionSummary] = useState<any | null>(null);

  const [extModalOpen, setExtModalOpen] = useState(false);
  const [extPre, setExtPre] = useState("0.5");
  const [extAft, setExtAft] = useState("0.5");
  const [extPerLine, setExtPerLine] = useState(false);
  const [isExtSetting, setIsExtSetting] = useState(false);

  const [isPathPlanningMode, setIsPathPlanningMode] = useState(false);
  const [pathFilter, setPathFilter] = useState<"All" | "lines" | "arcs" | "transits" | "extensions">("All");
  const [isReordering, setIsReordering] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [isSprayingSet, setIsSprayingSet] = useState(false);
  const [isVerifyingSegments, setIsVerifyingSegments] = useState(false);
  const [isPlanningAndStaging, setIsPlanningAndStaging] = useState(false);
  const [reorderedLines, setReorderedLines] = useState<PlanLine[]>([]);
  const canPlanAndStage =
    !!selectedPathName &&
    stagedWorkflow.alignment === "verified" &&
    stagedWorkflow.spray === "verified";
  const canLoadStagedMission =
    !!stagedMissionId &&
    stagedWorkflow.staged === "verified";
  const protectedResident = isProtectedMissionResident(loadedPathInspection);
  const legacyLoadBlocked = protectedResident && !canLoadStagedMission;
  const blockProtectedWorkflowMutation = (action: string) => {
    if (!protectedResident) return false;
    Alert.alert(
      "Mission conflict",
      `${action} is blocked while protected mission ${getLoadedMissionId(loadedPathInspection) ?? "<unknown>"} is resident.`
    );
    return true;
  };
  const primaryReorderableLines = useMemo(
    () => lines.filter(isPrimaryEditableLine),
    [lines]
  );
  const segmentSummary = useMemo(() => {
    const segments = segmentVerification?.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      return {
        normalized: [] as NormalizedPathSegment[],
        markCount: 0,
        transitCount: 0,
        preExtensionCount: 0,
        aftExtensionCount: 0,
        sprayOnCount: 0,
        sprayOffCount: 0,
      };
    }
    return summarizeNormalizedSegments(segments);
  }, [segmentVerification]);

  const targetPathForExtensions = selectedPathName || importedPlan?.fileName;

  const handleSetExtension = async () => {
    if (blockProtectedWorkflowMutation("Changing extensions")) return;
    if (!targetPathForExtensions || !apiBaseUrl) {
      Alert.alert("Error", "No path selected to save extensions to.");
      return;
    }
    setIsExtSetting(true);
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathForExtensions, {
        enabled: true,
        pre_extension_m: parseFloat(extPre) || 0,
        aft_extension_m: parseFloat(extAft) || 0,
        per_line: extPerLine,
      });
      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Extensions saved successfully.");
        setExtModalOpen(false);
        if (onSelectPath && targetPathForExtensions) onSelectPath(targetPathForExtensions);
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to set extensions");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsExtSetting(false);
    }
  };

  const handleDisableExtension = async () => {
    if (blockProtectedWorkflowMutation("Changing extensions")) return;
    if (!targetPathForExtensions || !apiBaseUrl) {
      Alert.alert("Error", "No path selected to disable extensions.");
      return;
    }
    try {
      const res = await pathApi.saveExtensions(apiBaseUrl, targetPathForExtensions, {
        enabled: false,
        pre_extension_m: 0.5,
        aft_extension_m: 0.5,
      });
      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Extensions disabled.");
        if (onSelectPath && targetPathForExtensions) onSelectPath(targetPathForExtensions);
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to disable extensions");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    }
  };

  const handleSetSpray = async () => {
    if (blockProtectedWorkflowMutation("Changing spray overrides")) return;
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to save overrides to.");
      return;
    }
    setIsSprayingSet(true);
    try {
      const overridesMap = new Map<string, boolean>();
      lines
        .filter(l => l.entity && l.entity.entity_id && l.layer !== "extension" && l.layer !== "transit")
        .forEach(l => {
          overridesMap.set(l.entity!.entity_id, !!l.entity!.is_mark);
        });

      const overrides = Array.from(overridesMap.entries()).map(([entity_id, is_mark]) => ({
        entity_id,
        is_mark
      }));

      const res = await pathApi.saveEntityOverrides(apiBaseUrl, targetPath, overrides);

      if (res.ok) {
        onInvalidateWorkflow("spray");
        Alert.alert("Success", "Spray settings saved successfully.");
      } else {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to save spray settings");
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsSprayingSet(false);
    }
  };

  const handleVerifySpraySegments = async () => {
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      Alert.alert("Error", "No path selected to verify segments.");
      return;
    }
    if (!targetPath.toLowerCase().endsWith(".dxf")) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      Alert.alert("Error", "Segment verification is only available for DXF paths.");
      return;
    }

    setIsVerifyingSegments(true);
    onInvalidateWorkflow("staged");
    try {
      const res = await pathApi.getPathSegments(apiBaseUrl, targetPath);
      if (res.ok) {
        const raw = await res.json();
        const data = parsePathSegmentsResponse(raw);
        if (!data) {
          setSegmentVerification(null);
          onWorkflowStep?.("spray", "failed");
          Alert.alert("Verification Failed", "Response did not include a non-empty segments array.");
          return;
        }
        setSegmentVerification(data);
        onWorkflowStep?.("spray", "verified");
        Alert.alert("Success", "Segment verification complete.");
      } else {
        setSegmentVerification(null);
        onWorkflowStep?.("spray", "failed");
        const errText = await res.text();
        Alert.alert("Verification Failed", errText || "Could not fetch segments.");
      }
    } catch (err) {
      setSegmentVerification(null);
      onWorkflowStep?.("spray", "failed");
      console.log("Error verifying segments:", err);
      Alert.alert("Error", "Could not connect to the rover to verify segments.");
    } finally {
      setIsVerifyingSegments(false);
    }
  };

  const handlePlanAndStage = async () => {
    if (!selectedPathName || !apiBaseUrl) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert("Error", "No path selected to plan and stage.");
      return;
    }
    if (stagedWorkflow.alignment !== "verified" || stagedWorkflow.spray !== "verified") {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert(
        "Prerequisites Required",
        "Complete alignment and spray segment verification before final planning."
      );
      return;
    }

    if (!verifiedAlignmentRequest) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      Alert.alert("Plan & Stage Failed", "Verified alignment inputs are missing. Re-run alignment before staging.");
      return;
    }

    const body: pathApi.PlanAndStageRequest = {
      source: selectedPathName,
      ...verifiedAlignmentRequest,
    };

    setIsPlanningAndStaging(true);
    onInvalidateWorkflow("staged");
    try {
      const planRes = await pathApi.planAndStage(apiBaseUrl, selectedPathName, body);
      if (!planRes.ok) {
        setStagedPlanResult(null);
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        const errText = await planRes.text();
        Alert.alert("Plan & Stage Failed", errText || "Could not plan and stage mission.");
        return;
      }

      const planRaw = await planRes.json();
      const parsed = parsePlanAndStageResponse(planRaw);
      if (!parsed) {
        setStagedPlanResult(null);
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        Alert.alert("Plan & Stage Failed", "Response did not include a staged mission_id.");
        return;
      }

      const { plan, missionId } = parsed;
      const summary = plan.mission_summary;
      setStagedMissionId(missionId);
      setStagedPlanResult({
        missionId,
        numWaypoints: coerceFiniteNumber(plan.num_waypoints ?? summary?.num_waypoints),
        numSegments: coerceFiniteNumber(plan.num_segments),
        totalLengthM: coerceFiniteNumber(plan.total_length_m ?? summary?.total_length_m),
        markLengthM: coerceFiniteNumber(plan.mark_length_m),
        transitLengthM: coerceFiniteNumber(plan.transit_length_m),
        estimatedPaintL: coerceFiniteNumber(summary?.estimated_paint_l),
        estimatedRuntimeS: coerceFiniteNumber(summary?.estimated_runtime_s),
        rmseM: coerceFiniteNumber(summary?.rmse_m),
        warnings: Array.isArray(plan.warnings) ? plan.warnings.map(String) : [],
      });

      const stagedRes = await pathApi.getStagedMission(apiBaseUrl, missionId);
      if (!stagedRes.ok) {
        setStagedMissionInspection(null);
        setStagedMissionId(null);
        onWorkflowStep?.("staged", "failed");
        const errText = await stagedRes.text();
        Alert.alert("Staged Inspection Failed", errText || "Mission staged but inspection fetch failed.");
        return;
      }

      const stagedData = (await stagedRes.json()) as pathApi.StagedMissionResponse;
      setStagedMissionInspection(stagedData);
      setStagedMissionId(missionId);
      onWorkflowStep?.("staged", "verified");
      Alert.alert("Success", "Mission planned and staged successfully.");
    } catch (err) {
      setStagedPlanResult(null);
      setStagedMissionInspection(null);
      setStagedMissionId(null);
      onWorkflowStep?.("staged", "failed");
      console.log("Error planning and staging mission:", err);
      Alert.alert("Error", "Could not connect to the rover to plan and stage mission.");
    } finally {
      setIsPlanningAndStaging(false);
    }
  };

  const handleSetOrder = async () => {
    if (blockProtectedWorkflowMutation("Reordering the path")) return;
    const targetPath = selectedPathName || importedPlan?.fileName;
    if (!apiBaseUrl || !targetPath) {
      Alert.alert("Error", "No path selected to reorder.");
      return;
    }
    setIsSavingOrder(true);
    try {
      // Send only primary entity IDs for the new order
      const entity_order = reorderedLines
        .filter(l => l.entity && l.entity.entity_id)
        .map(l => l.entity!.entity_id);

      const res = await pathApi.saveEntityOrder(apiBaseUrl, targetPath, entity_order);

      if (res.ok) {
        onInvalidateWorkflow("spray");
        setIsReordering(false);
        // Refresh paths list (if needed)
        onRefreshPaths();
        // Fetch the updated entities and transits
        if (onSelectPath && targetPath) {
          onSelectPath(targetPath);
        }
      } else {
        const errJson = await res.json().catch(() => null);
        Alert.alert("Validation Error", errJson?.detail || "Failed to save the new order. The plan might be stale.");
        onRefreshPaths();
        if (onSelectPath && targetPath) {
          onSelectPath(targetPath);
        }
      }
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend");
    } finally {
      setIsSavingOrder(false);
    }
  };

  const handleDeletePath = async (filename: string) => {
    if (blockProtectedWorkflowMutation("Deleting a path")) return;
    Alert.alert(
      "Delete Path",
      `Are you sure you want to delete ${filename}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await pathApi.deletePath(apiBaseUrl, filename);
              if (res.ok) {
                if (selectedPathName === filename) {
                  onSelectPath("");
                }
                onRefreshPaths();
              } else {
                const errText = await res.text();
                Alert.alert("Error", errText || "Failed to delete path");
              }
            } catch (err: any) {
              Alert.alert("Error", err.message || "Failed to connect to backend");
            }
          }
        }
      ]
    );
  };

  const handleSelectPoint = (pt: { x: number; y: number }) => {
    onInvalidateWorkflow("alignment");
    setMissionSummary(null);
    setAlignmentResult(null);
    setVerifiedAlignmentRequest(null);
    setRefPoints(prev => {
      // Toggle if clicked near existing point
      const existingIdx = prev.findIndex(p => Math.abs(p.dxf_y - pt.x) < 0.001 && Math.abs(p.dxf_x - pt.y) < 0.001);
      if (existingIdx >= 0) {
        return prev.filter((_, i) => i !== existingIdx);
      }

      if (alignmentMethod === "single_point") {
        if (prev.length >= 1) return [{ dxf_x: pt.y, dxf_y: pt.x, lat: prev[0].lat, lon: prev[0].lon }];
        return [{ dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
      } else {
        if (prev.length >= 2) return prev; // Limit to 2 points max
        return [...prev, { dxf_x: pt.y, dxf_y: pt.x, lat: "", lon: "" }];
      }
    });
  };

  const handleUpdateRefPoint = (idx: number, field: "lat" | "lon", value: string) => {
    onInvalidateWorkflow("alignment");
    const next = [...refPoints];
    next[idx] = { ...next[idx], [field]: value };
    setRefPoints(next);
  };

  const handleFixAlignment = async () => {
    console.log(`[Align DXF] handleFixAlignment: Starting alignment using method "${alignmentMethod}"`);
    if (blockProtectedWorkflowMutation("Changing GPS alignment")) {
      console.log("[Align DXF] handleFixAlignment: Blocked by protected workflow mutation.");
      return;
    }
    if (!selectedPathName || !apiBaseUrl || (alignmentMethod !== "visual_alignment" && refPoints.length === 0) || (alignmentMethod === "visual_alignment" && !extractedCorners)) {
      console.log("[Align DXF] handleFixAlignment: Missing prerequisites. Path:", selectedPathName, "Method:", alignmentMethod, "ExtractedCorners:", !!extractedCorners);
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      return;
    }
    setIsFixing(true);
    try {
      let validPoints: { dxf_x: number, dxf_y: number, lat: number, lon: number }[] = [];

      if (alignmentMethod === "visual_alignment") {
        validPoints = extractedCorners!.map((p) => ({
          dxf_x: p.dxf_x,
          dxf_y: p.dxf_y,
          lat: p.lat,
          lon: p.lon,
        }));
      } else {
        validPoints = refPoints
          .filter(p => p.lat.trim() !== "" && p.lon.trim() !== "")
          .map(p => ({
            dxf_x: p.dxf_x,
            dxf_y: p.dxf_y,
            lat: parseFloat(p.lat),
            lon: parseFloat(p.lon),
          }));

        if (alignmentMethod === "least_squares" && validPoints.length < 2) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please select 2 points and enter their WGS84 coordinates.");
          setIsFixing(false);
          return;
        }
        if (alignmentMethod === "single_point" && validPoints.length === 0) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please select a point and enter its coordinates.");
          setIsFixing(false);
          return;
        }
      }

      const payload: pathApi.AlignPathRequest = {
        ref_points: validPoints,
      };
      console.log("[Align DXF] handleFixAlignment: Constructed payload reference points:", validPoints);

      if (alignmentMethod === "single_point") {
        const rot = parseFloat(rotationDeg);
        if (isNaN(rot)) {
          onWorkflowStep?.("alignment", "failed");
          setVerifiedAlignmentRequest(null);
          Alert.alert("Validation", "Please enter a valid Heading (Degrees).");
          setIsFixing(false);
          return;
        }
        payload.rotation_deg = rot;
      }

      console.log(`[Align DXF] handleFixAlignment: Sending align_mission request to API for path: ${selectedPathName}`);
      const res = await pathApi.alignPath(apiBaseUrl, selectedPathName, payload);

      if (res.ok) {
        const data = await res.json();
        console.log("[Align DXF] handleFixAlignment: API response success. Data:", data);
        if (data.mission_summary) {
          setMissionSummary(data.mission_summary);

          // Visual preview uses original DXF lines + sticker transform. Backend
          // merged_waypoints are aligned local metres and must not replace lines.
          if (data.merged_waypoints && alignmentMethod !== "visual_alignment") {
            const alignedLines: PlanLine[] = [];
            const pts = Array.isArray(data.merged_waypoints) ? data.merged_waypoints : [];
            const sprayFlags = Array.isArray(data.spray_flags) ? data.spray_flags : [];
            for (let i = 0; i < pts.length - 1; i++) {
              const sprayFlag = sprayFlags[i] ?? true;
              const fromNorth = coerceFiniteNumber(pts[i]?.[0]);
              const fromEast = coerceFiniteNumber(pts[i]?.[1]);
              const toNorth = coerceFiniteNumber(pts[i + 1]?.[0]);
              const toEast = coerceFiniteNumber(pts[i + 1]?.[1]);

              if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
                continue;
              }

              alignedLines.push({
                id: `aligned-line-${i}`,
                label: `Segment ${i + 1}`,
                layer: sprayFlag ? "marking" : "center",
                from: { id: i * 2 + 1, x: fromNorth, y: fromEast },
                to: { id: i * 2 + 2, x: toNorth, y: toEast },
                width: 0.1,
              });
            }
            setLines(sanitizePlanLines(alignedLines));
          }

          Alert.alert("Success", "Alignment applied. Mission is ready to be loaded!");
        } else {
          setMissionSummary(null);
          setVerifiedAlignmentRequest({ ...payload });
          setAlignmentResult({
            method: data.method ?? null,
            scale: enforceAlignmentScale(coerceFiniteNumber(data.scale) ?? 1.0),
            rotation_deg: coerceFiniteNumber(data.rotation_deg),
            offset_n: coerceFiniteNumber(data.offset_n),
            offset_e: coerceFiniteNumber(data.offset_e),
            origin_gps: data.origin_gps ?? null,
            rmse_m: coerceFiniteNumber(data.rmse_m),
            sample_coords: data.sample_coords ?? null,
            residuals: data.residuals ?? null,
            warnings: data.warnings ?? null,
          });
          onWorkflowStep?.("alignment", "verified");

          // Skip frontend transform when lines were already shifted by the visual sticker workflow.
          const isFromLLAReceiver = !isVisualAlignmentMode && alignmentMethod !== "visual_alignment";
          const rotDeg = coerceFiniteNumber(data.rotation_deg);
          const offsetE = coerceFiniteNumber(data.offset_e);
          const offsetN = coerceFiniteNumber(data.offset_n);
          if (isFromLLAReceiver && rotDeg != null && offsetE != null && offsetN != null) {
            const rotRad = (rotDeg * Math.PI) / 180;
            const cos = Math.cos(rotRad);
            const sin = Math.sin(rotRad);

            const applyOriginTransform = (pt: { x: number; y: number }) => {
              return {
                x: pt.x * cos - pt.y * sin + offsetE,
                y: pt.x * sin + pt.y * cos + offsetN,
              };
            };

            setLines((prev) =>
              prev.map((line) => {
                const transformedFrom = applyOriginTransform({ x: line.from.x, y: line.from.y });
                const transformedTo = applyOriginTransform({ x: line.to.x, y: line.to.y });

                let updatedEntity = line.entity;
                if (updatedEntity?.preview_points) {
                  updatedEntity = {
                    ...updatedEntity,
                    preview_points: updatedEntity.preview_points.map((pt: { north: number; east: number }) => {
                      const transformed = applyOriginTransform({ x: pt.north, y: pt.east });
                      return { ...pt, north: transformed.x, east: transformed.y };
                    }),
                  };
                }

                return {
                  ...line,
                  from: { ...line.from, x: transformedFrom.x, y: transformedFrom.y },
                  to: { ...line.to, x: transformedTo.x, y: transformedTo.y },
                  ...(updatedEntity ? { entity: updatedEntity } : {}),
                };
              })
            );
          }

          Alert.alert("Success", "Alignment verified.");
        }
        // Keep latchedOrigin as the visual-preview projection base. Alignment
        // reference points are still sent to the backend for Plan & Stage.
        if (setAlignedRefPoints && alignmentMethod !== "visual_alignment") {
          setAlignedRefPoints(validPoints.map(p => ({
            dxf_x: p.dxf_x, dxf_y: p.dxf_y, lat: p.lat, lon: p.lon
          })));
        }
        setRefPoints([]);
        setExtractedCorners?.(null);
        if (alignmentMethod !== "visual_alignment") {
          setVisualAlignmentItem?.(null);
        }
      } else {
        onWorkflowStep?.("alignment", "failed");
        setVerifiedAlignmentRequest(null);
        const errText = await res.text();
        Alert.alert("Alignment Failed", errText || "Unknown error occurred.");
      }
    } catch (err) {
      onWorkflowStep?.("alignment", "failed");
      setVerifiedAlignmentRequest(null);
      console.log("Error aligning path:", err);
      Alert.alert("Error", "Could not connect to the rover to apply alignment.");
    } finally {
      setIsFixing(false);
    }
  };

  const handlePickFile = async () => {
    if (blockProtectedWorkflowMutation("Uploading a new path")) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["*/*"],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        const ext = asset.name.split('.').pop()?.toLowerCase();
        if (ext === 'dxf' || ext === 'csv' || ext === 'waypoints') {
          setPickedFile(asset);
        } else {
          Alert.alert("Invalid File", "Please select a .dxf, .csv, or .waypoints file.");
        }
      }
    } catch (err) {
      console.log("Error picking file:", err);
    }
  };

  const handleParseFile = async () => {
    if (blockProtectedWorkflowMutation("Parsing a new path")) return;
    if (!pickedFile || !apiBaseUrl) return;
    setIsUploading(true);
    try {
      const ext = pickedFile.name.split('.').pop()?.toLowerCase();

      const formData = new FormData();
      if (Platform.OS === "web") {
        // On web, DocumentPicker exposes the real browser File at `.file`;
        // fall back to materialising a Blob from the blob: URL. The native
        // {uri,name,type} descriptor is invalid in a browser multipart body.
        const webFile = (pickedFile as any).file ?? await (await fetch(pickedFile.uri)).blob();
        formData.append("file", webFile, pickedFile.name);
      } else {
        formData.append("file", {
          uri: pickedFile.uri,
          name: pickedFile.name,
          type: pickedFile.mimeType || "application/octet-stream",
        } as any);
      }

      const res = ext === "dxf"
        ? await pathApi.parseDxf(apiBaseUrl, formData)
        : await pathApi.uploadPath(apiBaseUrl, formData);

      if (res.ok) {
        onInvalidateWorkflow("alignment");
        Alert.alert("Success", `${pickedFile.name} imported successfully.`);
        if (ext === 'dxf') {
          setImportedPlan({ fileName: pickedFile.name, uri: pickedFile.uri, fileType: "dxf", source: "builtin" });
        }
        setPickedFile(null);
        onRefreshPaths();
      } else {
        const errorText = await res.text();
        Alert.alert("Import Failed", errorText || "Unknown error occurred");
      }
    } catch (err) {
      console.log("Error importing file:", err);
      Alert.alert("Error", "Could not connect to the rover to import the file.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ width: "58%", backgroundColor: "transparent", padding: 14 }}>
        <View style={{ flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
          <View style={{ flex: 1, position: "relative" }}>
            <PlanPreview
              lines={lines}
              mapSourceLines={mapSourceLines}
              autoOriginReference={autoOriginReference}
              mapGeometryFrame={mapGeometryFrame}
              autoOriginEnabled={autoOriginEnabled}
              stagedVerified={stagedWorkflow.staged === "verified"}
              visibility={
                isReordering
                  ? { ...layerVisibility, transit: false, extension: false }
                  : layerVisibility
              }
              selectedLineId={selectedLineId}
              onSelectLine={onSelectLine}
              roverPosN={previewRoverPoint?.north ?? null}
              roverPosE={previewRoverPoint?.east ?? null}
              roverHeadingDeg={telemetrySnapshot?.heading_ned_deg ?? null}
              selectedPoints={refPoints.map(p => ({ x: p.dxf_y, y: p.dxf_x }))}
              onSelectPoint={handleSelectPoint}
              alignedRefPoints={alignedRefPoints}
              telemetryPosN={telemetrySnapshot?.pos_n ?? null}
              telemetryPosE={telemetrySnapshot?.pos_e ?? null}
              telemetryPosLat={telemetrySnapshot?.lat ?? null}
              telemetryPosLon={telemetrySnapshot?.lon ?? null}
              telemetryPosAlt={telemetrySnapshot?.alt ?? null}
              mapViewEnabled={mapViewEnabled}
              showRefPointLabels={showRefPointLabels}
              activeRefPointLabelIndex={activeRefPointLabelIndex}
              onToggleRefPointLabel={setActiveRefPointLabelIndex}
              isVisualAlignmentMode={isVisualAlignmentMode}
              visualAlignmentItem={visualAlignmentItem}
              setVisualAlignmentItem={setVisualAlignmentItem}
            />
          </View>
        </View>
      </View>

      {isPathPlanningMode ? (
        <ScrollView
          style={{ width: "42%", height: "100%" }}
          contentContainerStyle={{ padding: 14, paddingLeft: 0, gap: 12, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Path Planning Header */}
          <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
                  Field Workspace
                </Text>
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 5 }}>
                  Path Planning
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  onPress={() => setInfoModalOpen(true)}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#334155",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Info</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setIsPathPlanningMode(false);
                    setIsReordering(false);
                  }}
                  style={{
                    height: 36,
                    paddingHorizontal: 12,
                    backgroundColor: "#ef4444",
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Exit</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* Filters & Actions */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {(["All", "lines", "arcs", "transits", "extensions"] as const).map(f => (
                <Pressable
                  key={f}
                  onPress={() => setPathFilter(f)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 20,
                    backgroundColor: pathFilter === f ? "#0f172a" : "#f1f5f9",
                    borderWidth: 1,
                    borderColor: pathFilter === f ? "#0f172a" : "#e2e8f0"
                  }}
                >
                  <Text style={{ color: pathFilter === f ? "#fff" : "#475569", fontSize: 12, fontWeight: "700", textTransform: "capitalize" }}>
                    {f}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => {
                if (blockProtectedWorkflowMutation("Reordering the path")) return;
                if (isReordering) {
                  handleSetOrder();
                } else {
                  setReorderedLines(primaryReorderableLines);
                  setIsReordering(true);
                  setPathFilter("All");
                }
              }}
              disabled={protectedResident || isSavingOrder}
              style={{
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 8,
                backgroundColor: protectedResident ? "#94a3b8" : isReordering ? "#10b981" : "#8b5cf6",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>
                {isReordering ? (isSavingOrder ? "Saving..." : "Save Order") : "Reorder Path"}
              </Text>
            </Pressable>
          </View>

          {/* List Content */}
          <View style={{ flex: 1, backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0", overflow: "hidden" }}>
            {isReordering ? (
              <ReorderableLineList
                data={reorderedLines}
                onDragEnd={(nextLines) => {
                  onInvalidateWorkflow("spray");
                  setReorderedLines(nextLines);
                }}
              />
            ) : (
              <ScrollView style={{ flex: 1 }}>
                {lines
                  .filter(l => {
                    const entityType = normalizeEntityType(l.entity?.entity_type);
                    if (pathFilter === "All") return true;
                    if (pathFilter === "lines") return entityType === "line" && l.layer !== "transit" && l.layer !== "extension";
                    if (pathFilter === "arcs") return entityType === "arc" || entityType === "circle";
                    if (pathFilter === "transits") return l.layer === "transit";
                    if (pathFilter === "extensions") return l.layer === "extension";
                    return true;
                  })
                  .map(l => {
                    const isPrimary = isPrimaryEditableLine(l);
                    const isSelected = selectedLineId === l.id;
                    return (
                      <Pressable
                        key={l.id}
                        onPress={() => onSelectLine(isSelected ? null : l.id)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          padding: 14,
                          backgroundColor: isSelected ? "#f0fdfa" : "#fff",
                          borderBottomWidth: 1,
                          borderBottomColor: "#f1f5f9"
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: isSelected ? "#0d9488" : "#0f172a", fontSize: 14, fontWeight: "700" }}>
                            {l.label} <Text style={{ color: "#64748b", fontWeight: "500", fontSize: 12 }}>({l.layer === "transit" || l.layer === "extension" ? l.layer : l.entity?.entity_type})</Text>
                          </Text>
                        </View>
                        {isPrimary && l.entity && (
                          <Pressable
                            onPress={() => {
                              onInvalidateWorkflow("spray");
                              const newLines = [...lines];
                              const idx = newLines.findIndex(x => x.id === l.id);
                              if (idx !== -1 && newLines[idx].entity) {
                                newLines[idx].entity!.is_mark = !newLines[idx].entity!.is_mark;
                                setLines(newLines);
                              }
                            }}
                            style={{
                              width: 24, height: 24, borderRadius: 6,
                              borderWidth: 1,
                              borderColor: l.entity.is_mark ? "#0d9488" : "rgba(148,163,184,0.5)",
                              backgroundColor: l.entity.is_mark ? "#0d9488" : "transparent",
                              alignItems: "center", justifyContent: "center"
                            }}
                          >
                            {l.entity.is_mark && <CheckIcon size={14} color="#fff" />}
                          </Pressable>
                        )}
                      </Pressable>
                    );
                  })}
              </ScrollView>
            )}
          </View>

          {!isReordering && (
            <ScrollView style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4 }}>
              <Pressable
                onPress={handleSetSpray}
                disabled={isSprayingSet}
                style={{
                  height: 48,
                  backgroundColor: isSprayingSet ? "#475569" : "#0ea5e9",
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>{isSprayingSet ? "Saving..." : "Save Spray Settings"}</Text>
              </Pressable>

              <View style={{ borderRadius: 12, padding: 12, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 10 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                  Verify Segments
                </Text>
                <Text style={{ color: "#94a3b8", fontSize: 11, lineHeight: 16 }}>
                  Fetch runtime segment roles from the rover before staging.
                </Text>
                <Pressable
                  onPress={handleVerifySpraySegments}
                  disabled={isVerifyingSegments || !selectedPathName}
                  style={{
                    height: 44,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isVerifyingSegments || !selectedPathName ? "#94a3b8" : "#0f988f",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                    {isVerifyingSegments ? "Verifying..." : "Verify Spray Segments"}
                  </Text>
                </Pressable>

                {segmentVerification && (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: "#475569", fontSize: 10, lineHeight: 15 }}>
                      Segments: {formatFinite(segmentVerification.num_segments, 0)} | Waypoints: {formatFinite(segmentVerification.num_waypoints, 0)} | Total: {formatFinite(segmentVerification.total_length_m, 1)} m | Mark: {formatFinite(segmentVerification.mark_length_m, 1)} m | Transit: {formatFinite(segmentVerification.transit_length_m, 1)} m
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {[
                        { label: "MARK", value: segmentSummary.markCount, color: "#166534", bg: "#dcfce7" },
                        { label: "TRANSIT", value: segmentSummary.transitCount, color: "#334155", bg: "#e2e8f0" },
                        { label: "PRE", value: segmentSummary.preExtensionCount, color: "#7c3aed", bg: "#ede9fe" },
                        { label: "AFT", value: segmentSummary.aftExtensionCount, color: "#7c3aed", bg: "#ede9fe" },
                        { label: "Spray ON", value: segmentSummary.sprayOnCount, color: "#0f766e", bg: "#ccfbf1" },
                        { label: "Spray OFF", value: segmentSummary.sprayOffCount, color: "#475569", bg: "#f1f5f9" },
                      ].map((chip) => (
                        <View
                          key={chip.label}
                          style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: chip.bg }}
                        >
                          <Text style={{ color: chip.color, fontSize: 10, fontWeight: "800" }}>
                            {chip.label}: {chip.value}
                          </Text>
                        </View>
                      ))}
                    </View>

                    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: "#e2e8f0", overflow: "hidden" }}>
                      <View style={{ flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" }}>
                        {["#", "Seq", "Type", "Ext", "Spray", "Entity", "Len (m)"].map((heading) => (
                          <Text
                            key={heading}
                            style={{
                              flex: heading === "Entity" ? 2 : 1,
                              color: "#64748b",
                              fontSize: 9,
                              fontWeight: "800",
                              textTransform: "uppercase",
                            }}
                          >
                            {heading}
                          </Text>
                        ))}
                      </View>
                      <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
                        {segmentSummary.normalized.length === 0 ? (
                          <View style={{ paddingVertical: 16, paddingHorizontal: 8, alignItems: "center" }}>
                            <Text style={{ color: "#94a3b8", fontSize: 11, fontStyle: "italic" }}>
                              No segments returned.
                            </Text>
                          </View>
                        ) : (
                          segmentSummary.normalized.map((segment) => {
                            const extLabel = formatExtensionRoleLabel(segment.extensionRole);
                            const typeColor = segment.type === "MARK" ? "#166534" : segment.type === "TRANSIT" ? "#475569" : "#64748b";
                            const sprayColor = segment.sprayOn ? "#0f766e" : "#94a3b8";
                            return (
                              <View
                                key={`${segment.index}-${segment.sequence}`}
                                style={{ flexDirection: "row", paddingVertical: 6, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" }}
                              >
                                <Text style={{ flex: 1, color: "#0f172a", fontSize: 10, fontWeight: "700" }}>{segment.index}</Text>
                                <Text style={{ flex: 1, color: "#0f172a", fontSize: 10 }}>{segment.sequence}</Text>
                                <Text style={{ flex: 1, color: typeColor, fontSize: 10, fontWeight: "700" }}>{segment.type}</Text>
                                <Text style={{ flex: 1, color: extLabel === "none" ? "#94a3b8" : "#7c3aed", fontSize: 10, fontWeight: "700" }}>{extLabel}</Text>
                                <Text style={{ flex: 1, color: sprayColor, fontSize: 10, fontWeight: "700" }}>{segment.sprayOn ? "ON" : "OFF"}</Text>
                                <Text style={{ flex: 2, color: "#334155", fontSize: 10 }} numberOfLines={1}>
                                  {segment.sourceEntity || "—"}
                                </Text>
                                <Text style={{ flex: 1, color: "#334155", fontSize: 10 }}>{formatFinite(segment.lengthM, 1)}</Text>
                              </View>
                            );
                          })
                        )}
                      </ScrollView>
                    </View>

                    {segmentVerification.warnings && segmentVerification.warnings.length > 0 && (
                      <Text style={{ color: "#b45309", fontSize: 10 }} numberOfLines={3}>
                        Warnings: {segmentVerification.warnings.join("; ")}
                      </Text>
                    )}
                  </View>
                )}
              </View>

              <View style={{ borderRadius: 12, padding: 12, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", gap: 10 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                  Plan & Stage
                </Text>
                <Text style={{ color: "#94a3b8", fontSize: 11, lineHeight: 16 }}>
                  Run final planning after alignment and spray verification are complete.
                </Text>
                {!canPlanAndStage && (
                  <Text style={{ color: "#b45309", fontSize: 10, lineHeight: 15 }}>
                    Requires verified alignment and spray segments
                    {selectedPathName ? "" : " plus a selected path"}.
                  </Text>
                )}
                <Pressable
                  onPress={handlePlanAndStage}
                  disabled={isPlanningAndStaging || !canPlanAndStage}
                  style={{
                    height: 44,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isPlanningAndStaging || !canPlanAndStage ? "#94a3b8" : "#2563eb",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                    {isPlanningAndStaging ? "Planning..." : "Plan & Stage Mission"}
                  </Text>
                </Pressable>

                {stagedPlanResult && (
                  <View style={{ marginTop: 4, padding: 12, backgroundColor: "#eff6ff", borderRadius: 8, borderWidth: 1, borderColor: "#bfdbfe", gap: 6 }}>
                    <Text style={{ color: "#1e40af", fontWeight: "800", fontSize: 13 }}>Staged Mission Summary</Text>
                    <Text style={{ color: "#1e3a8a", fontSize: 11 }} numberOfLines={2}>
                      Mission ID: {stagedPlanResult.missionId}
                    </Text>
                    <Text style={{ color: "#1e3a8a", fontSize: 11 }}>
                      Waypoints: {formatFinite(stagedPlanResult.numWaypoints, 0)} | Segments: {formatFinite(stagedPlanResult.numSegments, 0)}
                    </Text>
                    <Text style={{ color: "#1e3a8a", fontSize: 11 }}>
                      Total: {formatFinite(stagedPlanResult.totalLengthM, 1)} m | Mark: {formatFinite(stagedPlanResult.markLengthM, 1)} m | Transit: {formatFinite(stagedPlanResult.transitLengthM, 1)} m
                    </Text>
                    {stagedMissionInspection && (
                      <Text style={{ color: "#1e3a8a", fontSize: 11 }} numberOfLines={2}>
                        Waypoints sample: {formatWaypointPair(stagedMissionInspection.waypoints)}
                      </Text>
                    )}
                    {stagedPlanResult.warnings.length > 0 && (
                      <Text style={{ color: "#b45309", fontSize: 10 }} numberOfLines={4}>
                        Warnings: {stagedPlanResult.warnings.join("; ")}
                      </Text>
                    )}
                    {stagedMissionInspection && (
                      <Text style={{ color: "#1e3a8a", fontSize: 10 }}>
                        Staged inspect: {formatFinite(stagedMissionInspection.num_waypoints, 0)} waypoints, {stagedMissionInspection.segment_runs?.length ?? 0} runs
                      </Text>
                    )}
                  </View>
                )}

                {stagedPlanResult && (
                  <>
                    {!canLoadStagedMission && (
                      <Text style={{ color: "#b45309", fontSize: 10, lineHeight: 15 }}>
                        Requires a verified staged mission before controller load.
                      </Text>
                    )}
                    <Pressable
                      onPress={() => stagedMissionId && onLoadSelectedPath(stagedMissionId)}
                      disabled={missionActionBusy || !canLoadStagedMission}
                      style={{
                        height: 44,
                        borderRadius: 10,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: missionActionBusy || !canLoadStagedMission ? "#94a3b8" : "#7c3aed",
                      }}
                    >
                      <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                        {missionActionBusy ? "Loading..." : "Load Staged Mission to Controller"}
                      </Text>
                    </Pressable>
                  </>
                )}

                {loadedPathInspection?.loaded && stagedMissionId && (
                  <View style={{ marginTop: 4, padding: 12, backgroundColor: "#f5f3ff", borderRadius: 8, borderWidth: 1, borderColor: "#ddd6fe", gap: 6 }}>
                    <Text style={{ color: "#5b21b6", fontWeight: "800", fontSize: 13 }}>Controller Load Confirmed</Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={2}>
                      Staged ID: {stagedMissionId}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={2}>
                      Loaded ID: {getLoadedMissionId(loadedPathInspection) ?? "n/a"}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={2}>
                      Running ID: {loadedPathInspection.running_mission_id ?? "n/a"}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }}>
                      Placement: {loadedPathInspection.placement_mode ?? "unknown"} | {loadedPathInspection.is_staged ? "staged" : "not staged"} | {loadedPathInspection.protected ? "protected" : "unprotected"}
                    </Text>
                    {runningMissionMismatch(getLoadedMissionId(loadedPathInspection), loadedPathInspection.running_mission_id) ? (
                      <Text style={{ color: "#b91c1c", fontSize: 11, fontWeight: "800" }}>
                        {runningMissionMismatch(getLoadedMissionId(loadedPathInspection), loadedPathInspection.running_mission_id)}
                      </Text>
                    ) : null}
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={2}>
                      Path: {selectedPathName || loadedPathInspection.name || "n/a"}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={3}>
                      Anchor: {stagedMissionInspection?.anchor ? JSON.stringify(stagedMissionInspection.anchor) : "n/a"}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }}>
                      Waypoints: {formatFinite(loadedPathInspection.num_waypoints, 0)}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }} numberOfLines={2}>
                      Loaded sample: {formatWaypointPair(loadedPathInspection.sample_coords)}
                      {loadedPathInspection.sample_truncated ? " (truncated)" : ""}
                    </Text>
                    <Text style={{ color: "#6d28d9", fontSize: 11 }}>
                      Spray flags: {formatSprayFlagSample(loadedPathInspection)}
                    </Text>
                  </View>
                )}
              </View>
            </ScrollView>
          )}

          {/* Info Modal */}
          <Modal visible={infoModalOpen} transparent={true} animationType="fade">
            <View style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.6)", justifyContent: "center", alignItems: "center" }}>
              <View style={{ width: 340, backgroundColor: "#fff", borderRadius: 16, padding: 20, elevation: 10 }}>
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900", marginBottom: 16 }}>Path Summary</Text>

                <View style={{ gap: 12, marginBottom: 20 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Primary Lines</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>
                      {lines.filter(l => normalizeEntityType(l.entity?.entity_type) === "line" && l.layer !== "transit" && l.layer !== "extension").length} total
                      ({lines.filter(l => normalizeEntityType(l.entity?.entity_type) === "line" && l.layer !== "transit" && l.layer !== "extension" && l.entity?.is_mark).length} spray ready)
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Arcs/Circles</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>
                      {lines.filter(l => {
                        const entityType = normalizeEntityType(l.entity?.entity_type);
                        return (entityType === "arc" || entityType === "circle") && l.layer !== "transit" && l.layer !== "extension";
                      }).length} total
                      ({lines.filter(l => {
                        const entityType = normalizeEntityType(l.entity?.entity_type);
                        return (entityType === "arc" || entityType === "circle") && l.layer !== "transit" && l.layer !== "extension" && l.entity?.is_mark;
                      }).length} spray ready)
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Transits</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>{lines.filter(l => l.layer === "transit").length} total (No spray)</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#64748b", fontWeight: "700" }}>Extensions</Text>
                    <Text style={{ color: "#0f172a", fontWeight: "800" }}>{lines.filter(l => l.layer === "extension").length} total (No spray)</Text>
                  </View>
                </View>

                <Pressable
                  onPress={() => setInfoModalOpen(false)}
                  style={{ height: 44, backgroundColor: "#f1f5f9", borderRadius: 10, alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "800" }}>Close</Text>
                </Pressable>
              </View>
            </View>
          </Modal>

        </ScrollView>
      ) : (
        <View style={{ width: "42%", height: "100%", padding: 14, paddingLeft: 0, gap: 12 }}>
          <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#0f172a" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
              <View>
                <Text style={{ color: "#94a3b8", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase" }}>
                  Field Workspace
                </Text>
                <Text style={{ color: "#fff", fontSize: 18, fontWeight: "900", marginTop: 5 }}>
                  Select Rover Path
                </Text>
                <Text style={{ color: "#cbd5e1", fontSize: 12, lineHeight: 17, marginTop: 6 }}>
                  Select a path directly from the rover.
                </Text>
              </View>
              {(selectedPathName?.toLowerCase().endsWith(".dxf") || importedPlan?.fileName?.toLowerCase().endsWith(".dxf")) && (
                <View style={{ gap: 8 }}>
                  <Pressable
                    onPress={() => setIsPathPlanningMode(true)}
                    style={{
                      height: 36,
                      paddingHorizontal: 12,
                      backgroundColor: "#eab308",
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "800" }}>Path Planning</Text>
                  </Pressable>

                  <Pressable
                    onPress={async () => {
                      // Load the saved config so the toggles reflect backend state
                      // (per_line is sticky server-side; show its real value).
                      if (apiBaseUrl && targetPathForExtensions) {
                        try {
                          const cfg = await pathApi.getExtensions(apiBaseUrl, targetPathForExtensions);
                          setExtPre(String(cfg.pre_extension_m ?? 0.5));
                          setExtAft(String(cfg.aft_extension_m ?? 0.5));
                          setExtPerLine(!!cfg.per_line);
                        } catch {
                          // offline / not saved yet — keep current modal values
                        }
                      }
                      setExtModalOpen(true);
                    }}
                    style={{
                      height: 36,
                      paddingHorizontal: 12,
                      backgroundColor: "#8b5cf6",
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Enable Extension</Text>
                  </Pressable>

                  {lines.some((l) => l.layer === "extension") && (
                    <Pressable
                      onPress={handleDisableExtension}
                      style={{
                        height: 36,
                        paddingHorizontal: 12,
                        backgroundColor: "#ef4444",
                        borderRadius: 8,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "800" }}>Disable Extension</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </View>

          {/* --- EXTENSION MODAL --- */}
          <Modal visible={extModalOpen} transparent={true} animationType="fade">
            <View style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.6)", justifyContent: "center", alignItems: "center" }}>
              <View style={{ width: 340, backgroundColor: "#fff", borderRadius: 16, padding: 20, elevation: 10 }}>
                <Text style={{ color: "#0f172a", fontSize: 18, fontWeight: "900", marginBottom: 12 }}>
                  Path Extensions
                </Text>
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "700", marginBottom: 4 }}>File Name</Text>
                  <TextInput
                    style={{ backgroundColor: "#f8fafc", borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 8, padding: 10, color: "#64748b", fontWeight: "600" }}
                    value={targetPathForExtensions || ""}
                    editable={false}
                  />
                </View>
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "700", marginBottom: 4 }}>Pre Extension (m)</Text>
                  <TextInput
                    style={{ backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 10, color: "#0f172a" }}
                    value={extPre}
                    onChangeText={(value) => {
                      onInvalidateWorkflow("spray");
                      setExtPre(value);
                    }}
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ marginBottom: 20 }}>
                  <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "700", marginBottom: 4 }}>Aft Extension (m)</Text>
                  <TextInput
                    style={{ backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 10, color: "#0f172a" }}
                    value={extAft}
                    onChangeText={(value) => {
                      onInvalidateWorkflow("spray");
                      setExtAft(value);
                    }}
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ marginBottom: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "800" }}>Per-line extensions</Text>
                    <Text style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>
                      Each line gets its own run-up/run-out (square sides too)
                    </Text>
                  </View>
                  <Switch
                    value={extPerLine}
                    onValueChange={(value) => {
                      onInvalidateWorkflow("spray");
                      setExtPerLine(value);
                    }}
                    trackColor={{ false: "#cbd5e1", true: "#8b5cf6" }}
                  />
                </View>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Pressable
                    onPress={() => setExtModalOpen(false)}
                    style={{ flex: 1, height: 44, backgroundColor: "#e2e8f0", borderRadius: 10, alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ color: "#475569", fontSize: 14, fontWeight: "700" }}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={handleSetExtension}
                    disabled={isExtSetting}
                    style={{ flex: 1, height: 44, backgroundColor: "#8b5cf6", borderRadius: 10, alignItems: "center", justifyContent: "center", opacity: isExtSetting ? 0.7 : 1 }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>{isExtSetting ? "Setting..." : "Set Extension"}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 20 }} style={{ flex: 1 }}>

            {/* --- IMPORT SECTION --- */}
            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
                Import from Device
              </Text>
              {!pickedFile ? (
                <Pressable
                  onPress={handlePickFile}
                  disabled={protectedResident}
                  style={{
                    height: 44,
                    borderRadius: 12,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: protectedResident ? "#cbd5e1" : "#e2e8f0",
                    borderWidth: 1,
                    borderColor: "#cbd5e1",
                  }}
                >
                  <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "700" }}>
                    Select .dxf, .csv, .waypoints
                  </Text>
                </Pressable>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ flex: 1, backgroundColor: "#f8fafc", padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#e2e8f0" }}>
                    <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                      {pickedFile.name}
                    </Text>
                  </View>
                  <Pressable
                    onPress={handleParseFile}
                    disabled={isUploading || protectedResident}
                    style={{
                      height: 40,
                      paddingHorizontal: 16,
                      borderRadius: 8,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isUploading || protectedResident ? "#94a3b8" : "#0f988f",
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
                      {isUploading ? "..." : "Parse"}
                    </Text>
                  </Pressable>
                  <Pressable onPress={() => setPickedFile(null)} style={{ padding: 4 }}>
                    <X size={20} color="#64748b" />
                  </Pressable>
                </View>
              )}
            </View>
            {/* --- END IMPORT SECTION --- */}

            {/* --- ALIGNMENT SECTION --- */}
            <View style={{ borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb" }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" }}>
                  Align DXF
                </Text>
                {refPoints.length > 0 && (
                  <Pressable
                    onPress={() => {
                      onInvalidateWorkflow("alignment");
                      setMissionSummary(null);
                      setAlignmentResult(null);
                      setVerifiedAlignmentRequest(null);
                      setRefPoints([]);
                    }}
                  >
                    <Text style={{ color: "#ef4444", fontSize: 11, fontWeight: "700" }}>Clear Points</Text>
                  </Pressable>
                )}
              </View>

              {/* Toggle Method */}
              <View style={{ flexDirection: "row", backgroundColor: "#f1f5f9", borderRadius: 8, padding: 4, marginBottom: 12 }}>
                <Pressable
                  onPress={() => {
                    onInvalidateWorkflow("alignment");
                    setAlignmentMethod("least_squares");
                    setRefPoints([]);
                    setMissionSummary(null);
                    setAlignmentResult(null);
                    setVerifiedAlignmentRequest(null);
                  }}
                  style={{ flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 6, backgroundColor: alignmentMethod === "least_squares" ? "#ffffff" : "transparent", shadowColor: alignmentMethod === "least_squares" ? "#000" : "transparent", shadowOpacity: 0.05, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}
                >
                  <Text style={{ color: alignmentMethod === "least_squares" ? "#0f172a" : "#64748b", fontSize: 12, fontWeight: "700" }}>2-Point Fit</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    onInvalidateWorkflow("alignment");
                    setAlignmentMethod("single_point");
                    setRefPoints([]);
                    setMissionSummary(null);
                    setAlignmentResult(null);
                    setVerifiedAlignmentRequest(null);
                    setExtractedCorners?.(null);
                    setVisualAlignmentItem?.(null);
                  }}
                  style={{ flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 6, backgroundColor: alignmentMethod === "single_point" ? "#ffffff" : "transparent", shadowColor: alignmentMethod === "single_point" ? "#000" : "transparent", shadowOpacity: 0.05, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}
                >
                  <Text style={{ color: alignmentMethod === "single_point" ? "#0f172a" : "#64748b", fontSize: 12, fontWeight: "700" }}>1-Point + Angle</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    onInvalidateWorkflow("alignment");
                    setAlignmentMethod("visual_alignment");
                    setRefPoints([]);
                    setMissionSummary(null);
                    setAlignmentResult(null);
                    setVerifiedAlignmentRequest(null);
                    setExtractedCorners?.(null);
                    setVisualAlignmentItem?.(null);
                  }}
                  style={{ flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 6, backgroundColor: alignmentMethod === "visual_alignment" ? "#ffffff" : "transparent", shadowColor: alignmentMethod === "visual_alignment" ? "#000" : "transparent", shadowOpacity: 0.05, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }}
                >
                  <Text style={{ color: alignmentMethod === "visual_alignment" ? "#0f172a" : "#64748b", fontSize: 12, fontWeight: "700" }}>Visual</Text>
                </Pressable>
              </View>

              {alignmentMethod === "visual_alignment" ? (
                <View style={{ gap: 12, marginTop: 4 }}>
                  {extractedCorners ? (
                    <View style={{ gap: 8 }}>
                      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "700" }}>Extracted Coordinates</Text>
                      {extractedCorners.map((pt, i) => (
                        <View key={i} style={{ backgroundColor: "#f8fafc", padding: 8, borderRadius: 6, borderWidth: 1, borderColor: "#e2e8f0" }}>
                          <Text style={{ color: "#334155", fontSize: 12, fontWeight: "600" }}>Corner {i + 1}</Text>
                          <Text style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>Lat: {pt.lat.toFixed(6)}</Text>
                          <Text style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>Lon: {pt.lon.toFixed(6)}</Text>
                        </View>
                      ))}
                      <Pressable
                        onPress={handleFixAlignment}
                        disabled={isFixing || !selectedPathName}
                        style={{
                          height: 44,
                          borderRadius: 10,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: isFixing || !selectedPathName ? "#94a3b8" : "#f59e0b",
                          marginTop: 4,
                        }}
                      >
                        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                          {isFixing ? "Fixing..." : "Fix Alignment"}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          console.log("[Align DXF] Visual Alignment UI: 'Clear Alignment' clicked. Resetting visual state.");
                          setExtractedCorners?.(null);
                          setVisualAlignmentItem?.(null);
                        }}
                        style={{ marginTop: 8, padding: 10, alignItems: "center", backgroundColor: "#f1f5f9", borderRadius: 6 }}
                      >
                        <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "600" }}>Clear Alignment</Text>
                      </Pressable>
                    </View>
                  ) : isVisualAlignmentMode ? (
                    <View style={{ gap: 12 }}>
                      <Text style={{ color: "#64748b", fontSize: 12 }}>Drag and rotate the plan on the map to align it, then click Confirm.</Text>
                      <View style={{ backgroundColor: "#f1f5f9", padding: 10, borderRadius: 6 }}>
                        <Text style={{ color: "#334155", fontSize: 12, fontFamily: "monospace" }}>
                          Offset: {visualAlignmentItem?.x?.toFixed(2) ?? "0.00"}m, {visualAlignmentItem?.y?.toFixed(2) ?? "0.00"}m
                        </Text>
                      </View>
                      <Pressable
                        onPress={onConfirmVisualAlignment}
                        style={{ height: 44, backgroundColor: "#10b981", borderRadius: 8, alignItems: "center", justifyContent: "center" }}
                      >
                        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>LLA Receiver (Confirm)</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      onPress={onStartVisualAlignment}
                      style={{ height: 44, borderWidth: 1, borderColor: "#0f172a", borderRadius: 8, alignItems: "center", justifyContent: "center" }}
                    >
                      <Text style={{ color: "#0f172a", fontSize: 14, fontWeight: "700" }}>Coordinate Receiver</Text>
                    </Pressable>
                  )}
                </View>
              ) : refPoints.length === 0 ? (
                <Text style={{ color: "#94a3b8", fontSize: 12, fontStyle: "italic", textAlign: "center", marginVertical: 8 }}>
                  {alignmentMethod === "least_squares" ? "Tap 2 points on the canvas to set alignment." : "Tap 1 point on the canvas to set anchor."}
                </Text>
              ) : (
                <View style={{ gap: 8 }}>
                  {refPoints.map((pt, i) => (
                    <View key={i} style={{ backgroundColor: "#f8fafc", padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#e2e8f0" }}>
                      <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "700", marginBottom: 6 }}>
                        Point {i + 1} <Text style={{ fontWeight: "400", color: "#64748b" }}>(X: {pt.dxf_x.toFixed(2)}, Y: {pt.dxf_y.toFixed(2)})</Text>
                      </Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <TextInput
                          style={{ flex: 1, height: 36, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 10, fontSize: 13 }}
                          placeholder="Latitude"
                          placeholderTextColor="#94a3b8"
                          value={pt.lat}
                          onChangeText={(val) => handleUpdateRefPoint(i, "lat", val)}
                          keyboardType="numeric"
                        />
                        <TextInput
                          style={{ flex: 1, height: 36, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 10, fontSize: 13 }}
                          placeholder="Longitude"
                          placeholderTextColor="#94a3b8"
                          value={pt.lon}
                          onChangeText={(val) => handleUpdateRefPoint(i, "lon", val)}
                          keyboardType="numeric"
                        />
                      </View>
                    </View>
                  ))}

                  {alignmentMethod === "single_point" && refPoints.length === 1 && (
                    <View style={{ backgroundColor: "#f8fafc", padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#e2e8f0" }}>
                      <Text style={{ color: "#0f172a", fontSize: 12, fontWeight: "700", marginBottom: 6 }}>Heading Angle</Text>
                      <TextInput
                        style={{ height: 36, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 6, paddingHorizontal: 10, fontSize: 13 }}
                        placeholder="Degrees (e.g. 45)"
                        placeholderTextColor="#94a3b8"
                        value={rotationDeg}
                        onChangeText={(value) => {
                          onInvalidateWorkflow("alignment");
                          setRotationDeg(value);
                        }}
                        keyboardType="numeric"
                      />
                    </View>
                  )}

                  {alignmentMethod === "least_squares" && refPoints.length === 2 && (
                    <View style={{ backgroundColor: "#e2e8f0", padding: 10, borderRadius: 8, alignItems: "center" }}>
                      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "700" }}>
                        Distance: {Math.hypot(refPoints[1].dxf_x - refPoints[0].dxf_x, refPoints[1].dxf_y - refPoints[0].dxf_y).toFixed(2)} meters
                      </Text>
                    </View>
                  )}

                  <Pressable
                    onPress={handleFixAlignment}
                    disabled={isFixing || !selectedPathName}
                    style={{
                      height: 44,
                      borderRadius: 10,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isFixing || !selectedPathName ? "#94a3b8" : "#f59e0b",
                      marginTop: 4,
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                      {isFixing ? "Fixing..." : "Fix Alignment"}
                    </Text>
                  </Pressable>

                  {alignmentResult && (
                    <View style={{ marginTop: 12, padding: 12, backgroundColor: "#f0fdf4", borderRadius: 8, borderWidth: 1, borderColor: "#bbf7d0" }}>
                      <Text style={{ color: "#166534", fontWeight: "800", marginBottom: 8, fontSize: 13 }}>Alignment Verified</Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        Method: {alignmentResult.method != null ? String(alignmentResult.method) : "n/a"}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        Scale: {formatFinite(alignmentResult.scale, 6)}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        Rotation: {formatFinite(alignmentResult.rotation_deg, 3)} deg
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        Offset: N {formatFinite(alignmentResult.offset_n, 3)} / E {formatFinite(alignmentResult.offset_e, 3)}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        Origin GPS: {alignmentResult.origin_gps ? JSON.stringify(alignmentResult.origin_gps) : "n/a"}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 12, marginBottom: 4 }}>
                        RMSE: {formatFinite(alignmentResult.rmse_m, 3)}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 11, marginBottom: 4 }} numberOfLines={4}>
                        Samples: {alignmentResult.sample_coords ? JSON.stringify(alignmentResult.sample_coords) : "n/a"}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 11, marginBottom: 4 }} numberOfLines={4}>
                        Residuals: {alignmentResult.residuals ? JSON.stringify(alignmentResult.residuals) : "n/a"}
                      </Text>
                      <Text style={{ color: "#166534", fontSize: 11 }} numberOfLines={4}>
                        Warnings: {alignmentResult.warnings ? JSON.stringify(alignmentResult.warnings) : "n/a"}
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            {/* --- END ALIGNMENT SECTION --- */}

            <View style={{ flex: 1, borderRadius: 14, padding: 14, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#d8e1eb", minHeight: 180 }}>
              <Text style={{ color: "#64748b", fontSize: 11, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
                Select Path from Rover
              </Text>
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
                {backendPaths.length === 0 ? (
                  <Text style={{ color: "#64748b", fontSize: 13, fontStyle: "italic", textAlign: "center", marginTop: 20 }}>
                    No paths found on rover or offline.
                  </Text>
                ) : (
                  backendPaths.map((path) => {
                    const isSelected = selectedPathName === path.name;
                    return (
                      <Pressable
                        key={path.name}
                        onPress={() => {
                          if (blockProtectedWorkflowMutation("Selecting another path")) return;
                          setMissionSummary(null);
                          setAlignmentResult(null);
                          setVerifiedAlignmentRequest(null);
                          setSegmentVerification(null);
                          setStagedPlanResult(null);
                          setStagedMissionInspection(null);
                          setStagedMissionId(null);
                          onSelectPath(path.name);
                        }}
                        style={{
                          borderRadius: 10,
                          padding: 10,
                          backgroundColor: isSelected ? "#0b6b68" : "#f8fafc",
                          borderWidth: 1,
                          borderColor: isSelected ? "#0b6b68" : "#e2e8f0",
                          flexDirection: "row",
                          justifyContent: "space-between",
                          alignItems: "center"
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: isSelected ? "#ffffff" : "#0f172a", fontWeight: "800", fontSize: 14 }}>
                            {path.name}
                          </Text>
                          <Text style={{ color: isSelected ? "#d1fae5" : "#64748b", fontSize: 11, marginTop: 2 }}>
                            {path.description || `Points: ${path.num_points}`}
                          </Text>
                        </View>
                        {isSelected && (
                          <Pressable
                            onPress={() => handleDeletePath(path.name)}
                            style={{ padding: 8, backgroundColor: "rgba(239, 68, 68, 0.2)", borderRadius: 8 }}
                          >
                            <Trash2 size={18} color="#fca5a5" />
                          </Pressable>
                        )}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
              {selectedPathName && !missionSummary ? (
                <Pressable
                  onPress={() => onLoadSelectedPath(canLoadStagedMission ? stagedMissionId ?? undefined : undefined)}
                  disabled={missionActionBusy || legacyLoadBlocked}
                  style={{
                    marginTop: 10,
                    height: 44,
                    borderRadius: 12,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: missionActionBusy || legacyLoadBlocked ? "#94a3b8" : "#2563eb",
                  }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
                    {missionActionBusy ? "Loading..." : legacyLoadBlocked ? "Protected Mission Loaded" : canLoadStagedMission ? "Load Staged Mission" : "Load Path"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function LayerRow({ label, value, onToggle }: { label: string; value: boolean; onToggle: () => void }) {
  return (
    <Pressable onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: "#555",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: value ? "#111" : "#fff",
        }}
      >
        {value ? <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>✓</Text> : null}
      </View>
      <Text style={{ color: "#333", fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

function ActionBar({
  title,
  subtitle,
  icon,
  onPress,
  tone,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onPress: () => void;
  tone: "light" | "dark" | "teal";
}) {
  const palette =
    tone === "light"
      ? { bg: "#e2e8f0", fg: "#0f172a", sub: "#475569" }
      : tone === "teal"
        ? { bg: "#0b6b68", fg: "#fff", sub: "#cdeeed" }
        : { bg: "#0f172a", fg: "#fff", sub: "#cbd5e1" };
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: 110,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 12,
        minHeight: 86,
        backgroundColor: palette.bg,
        justifyContent: "space-between",
        borderWidth: 1,
        borderColor: tone === "light" ? "#cbd5e1" : "rgba(255,255,255,0.12)",
      }}
    >
      <View style={{ width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tone === "light" ? "#fff" : "rgba(255,255,255,0.12)" }}>
        {icon}
      </View>
      <View style={{ marginTop: 8 }}>
        <Text style={{ color: palette.fg, fontSize: 13, fontWeight: "800" }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: palette.sub, fontSize: 11, lineHeight: 15, marginTop: 3 }} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <Text style={{ color: "#64748b", fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {label}
      </Text>
      <Text style={{ color: "#0f172a", fontSize: 13, fontWeight: "700", flex: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

function ActionTile({
  title,
  subtitle,
  icon,
  onPress,
  accent,
  foreground,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onPress: () => void;
  accent: string;
  foreground: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        minWidth: 110,
        padding: 14,
        borderRadius: 18,
        backgroundColor: accent,
        borderWidth: 1,
        borderColor: "rgba(148,163,184,0.16)",
        justifyContent: "space-between",
        minHeight: 112,
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 12,
          backgroundColor: foreground === "#fff" ? "rgba(255,255,255,0.16)" : "rgba(15,23,42,0.08)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </View>
      <View style={{ marginTop: 12 }}>
        <Text style={{ color: foreground, fontSize: 14, fontWeight: "800" }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: foreground === "#fff" ? "#cbd5e1" : "#64748b", fontSize: 11, lineHeight: 15, marginTop: 4 }}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

type PreviewViewport = {
  panX: number;
  panY: number;
  zoom: number;
};

type LocalPoint = { x: number; y: number };

function touchDistance(t1: { locationX: number; locationY: number }, t2: { locationX: number; locationY: number }) {
  const dx = t1.locationX - t2.locationX;
  const dy = t1.locationY - t2.locationY;
  return Math.sqrt(dx * dx + dy * dy);
}

function touchAngle(t1: { locationX: number; locationY: number }, t2: { locationX: number; locationY: number }) {
  const dx = t1.locationX - t2.locationX;
  const dy = t1.locationY - t2.locationY;
  return Math.atan2(dy, dx);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDegrees(value: number) {
  const next = value % 360;
  return next < 0 ? next + 360 : next;
}

function shortestAngleDelta(fromDeg: number, toDeg: number) {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function computePlanBounds(lines: PlanLine[]) {
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

function computeAutoFitViewport(
  lines: PlanLine[],
  width: number,
  height: number,
  roverPoint?: { north: number; east: number } | null
): PreviewViewport {
  if (lines.length === 0 || width <= 0 || height <= 0) {
    return { panX: width / 2, panY: height / 2, zoom: 1 };
  }

  // Swap X/Y in bounds: World X is North (Up), World Y is East (Right)
  // minX/maxX will now track the Easting (World Y)
  // minY/maxY will now track the Northing (World X)
  let minE = Number.POSITIVE_INFINITY;
  let maxE = Number.NEGATIVE_INFINITY;
  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;

  for (const line of lines) {
    // line.x = North, line.y = East
    minN = Math.min(minN, line.from.x, line.to.x);
    maxN = Math.max(maxN, line.from.x, line.to.x);
    minE = Math.min(minE, line.from.y, line.to.y);
    maxE = Math.max(maxE, line.from.y, line.to.y);
  }

  if (roverPoint) {
    minN = Math.min(minN, roverPoint.north);
    maxN = Math.max(maxN, roverPoint.north);
    minE = Math.min(minE, roverPoint.east);
    maxE = Math.max(maxE, roverPoint.east);
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

function toScreenPoint(point: { x: number; y: number }, viewport: PreviewViewport): LocalPoint {
  // point.x = North, point.y = East
  // Screen X = East * zoom + panX
  // Screen Y = -North * zoom + panY
  return {
    x: point.y * viewport.zoom + viewport.panX,
    y: -point.x * viewport.zoom + viewport.panY,
  };
}

function rotatePoint(px: number, py: number, cx: number, cy: number, angleDegrees: number): LocalPoint {
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

function buildPreviewArrowheadPoints(from: LocalPoint, to: LocalPoint): string | null {
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

function mapPreviewPointToScreen(
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

function getPreviewArrowSegment(
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

function getPreviewRenderedLayer(line: PlanLine): PreviewRenderedLayer | null {
  if (line.layer === "boundary" || line.layer === "center" || line.layer === "transit" || line.layer === "extension") {
    return line.layer;
  }

  if (line.layer === "marking") {
    return line.entity?.is_mark === false ? "marking_false" : "marking_true";
  }

  return null;
}

function distancePointToSegment(
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

function pickNearestLineId(
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

function getCornerPoints(lines: PlanLine[]): { x: number, y: number }[] {
  const pointMap = new Map<string, { pt: { x: number, y: number }, segments: { dx: number, dy: number }[] }>();

  for (const line of lines) {
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
      if (dotProduct > -0.99) {
        corners.push(pt);
      }
    }
  }

  return corners;
}

function pickNearestPoint(
  lines: PlanLine[],
  viewport: PreviewViewport,
  tap: LocalPoint,
  radiusPx: number,
  rotation: number = 0,
  layoutSize: { width: number; height: number } = { width: 0, height: 0 }
) {
  let nearestPoint: { x: number; y: number } | null = null;
  let nearestDistance = radiusPx;

  const cx = layoutSize.width / 2;
  const cy = layoutSize.height / 2;

  const corners = getCornerPoints(lines);

  for (const pt of corners) {
    let screenPt = toScreenPoint(pt, viewport);

    if (rotation !== 0 && layoutSize.width > 0 && layoutSize.height > 0) {
      screenPt = rotatePoint(screenPt.x, screenPt.y, cx, cy, rotation);
    }

    const dist = Math.hypot(tap.x - screenPt.x, tap.y - screenPt.y);

    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearestPoint = pt;
    }
  }

  return nearestPoint;
}

function PlanPreview({
  lines,
  mapSourceLines,
  autoOriginReference = null,
  mapGeometryFrame = "NONE",
  autoOriginEnabled = false,
  stagedVerified = false,
  visibility,
  selectedLineId,
  onSelectLine,
  originShiftKey = null,
  roverPosN,
  roverPosE,
  roverHeadingDeg,
  missionRunning = false,
  selectedPoints,
  onSelectPoint,
  alignedRefPoints = [],
  telemetryPosN = null,
  telemetryPosE = null,
  telemetryPosLat = null,
  telemetryPosLon = null,
  telemetryPosAlt = null,
  mapViewEnabled = false,
  showRefPointLabels = false,
  activeRefPointLabelIndex = null,
  onToggleRefPointLabel,
  isVisualAlignmentMode,
  visualAlignmentItem,
  setVisualAlignmentItem,
}: {
  lines: PlanLine[];
  mapSourceLines?: PlanLine[];
  autoOriginReference?: AutoOriginReference | null;
  mapGeometryFrame?: MapGeometryFrame;
  autoOriginEnabled?: boolean;
  stagedVerified?: boolean;
  visibility: LayerVisibility;
  selectedLineId: string | null;
  onSelectLine?: (id: string | null) => void;
  originShiftKey?: string | null;
  roverPosN?: number | null;
  roverPosE?: number | null;
  roverHeadingDeg?: number | null;
  missionRunning?: boolean;
  selectedPoints?: { x: number; y: number }[];
  onSelectPoint?: (pt: { x: number; y: number }) => void;
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
  visualAlignmentItem?: PlacedItem | null;
  setVisualAlignmentItem?: React.Dispatch<React.SetStateAction<PlacedItem | null>>;
}) {
  const filtered = useMemo(
    () =>
      sanitizePlanLines(lines).filter((line) => {
        if (line.layer === "boundary") return visibility.boundary;
        if (line.layer === "marking") return visibility.marking;
        if (line.layer === "center") return visibility.center;
        if (line.layer === "transit") return visibility.transit;
        if (line.layer === "extension") return visibility.extension;
        return true;
      }),
    [lines, visibility]
  );

  const filteredPlanSignature = useMemo(() => {
    const len = filtered.length;
    if (len === 0) return '0';
    const first = filtered[0];
    const last = filtered[len - 1];
    const mid = filtered[Math.floor(len / 2)];
    return `${len}:${first.id}:${last.id}:${mid.from.x.toFixed(2)}:${mid.to.y.toFixed(2)}`;
  }, [filtered]);

  const cornerPoints = useMemo(() => getCornerPoints(filtered).slice(0, MAX_PREVIEW_CORNERS), [filtered]);
  const primarySequenceLines = useMemo(
    () => filtered.filter(isPrimaryEditableLine),
    [filtered]
  );
  const selectedLine = useMemo(
    () => filtered.find((line) => line.id === selectedLineId) ?? null,
    [filtered, selectedLineId]
  );
  const pathChunksByLayer = useMemo(
    () => ({
      boundary: buildSvgPathChunks(filtered.filter((line) => line.layer === "boundary")),
      marking_true: buildSvgPathChunks(filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark !== false)),
      marking_false: buildSvgPathChunks(filtered.filter((line) => line.layer === "marking" && line.entity?.is_mark === false)),
      center: buildSvgPathChunks(filtered.filter((line) => line.layer === "center")),
      transit: buildSvgPathChunks(filtered.filter((line) => line.layer === "transit")),
      extension: buildSvgPathChunks(filtered.filter((line) => line.layer === "extension")),
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
  const arrowheadsByLayer = useMemo(() => {
    const result: Record<PreviewRenderedLayer, string[]> = {
      boundary: [],
      center: [],
      transit: [],
      extension: [],
      marking_true: [],
      marking_false: [],
    };

    for (const line of filtered) {
      if (line.id === selectedLineId) continue;

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
  }, [filtered, layoutSize, rotation, selectedLineId, viewport]);

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
  React.useEffect(() => {
    return () => {
      if (rafViewportIdRef.current !== null) cancelAnimationFrame(rafViewportIdRef.current);
    };
  }, []);
  // Track whether user has manually panned so auto-pan doesn't fight them
  const userPannedRef = React.useRef(false);

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
            rafViewportRef.current = next;
            scheduleViewportCommit();
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
            panX: viewportRef.current.panX - dx,
            panY: viewportRef.current.panY - dy,
            zoom: viewportRef.current.zoom,
          };
          lastTouchX = touches[0].pageX;
          lastTouchY = touches[0].pageY;

          rafViewportRef.current = next;
          scheduleViewportCommit();
        }
      },
      onPanResponderRelease: (evt, gestureState) => {
        pinchStartDistance = 0;
        // Tap detection
        if (Math.abs(gestureState.dx) < 5 && Math.abs(gestureState.dy) < 5 && evt.nativeEvent.touches.length === 0) {
          const tapX = evt.nativeEvent.locationX;
          const tapY = evt.nativeEvent.locationY;

          if (showRefPointLabels && alignedRefPoints.length > 0 && onToggleRefPointLabel) {
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
            const ptHit = pickNearestPoint(linesRef.current, viewportRef.current, tap, 28, rotationRef.current, layoutSizeRef.current);
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
            mode={visualAlignmentItem ? "templates" : "fields"}
            placedItems={visualAlignmentItem ? [visualAlignmentItem] : []}
            selectedItemIds={visualAlignmentItem ? ["visual-alignment-group"] : []}
            onUpdatePlacedItem={(id, updates) => {
              if (!isVisualAlignmentMode || id !== "visual-alignment-group") return;
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
            lines={
              visualAlignmentItem
                ? []
                : autoOriginEnabled && mapSourceLines
                  ? mapSourceLines
                  : filtered
            }
            alignedRefPoints={alignedRefPoints}
            autoOriginReference={autoOriginReference}
            mapGeometryFrame={mapGeometryFrame}
            autoOriginEnabled={autoOriginEnabled}
            stagedVerified={stagedVerified}
            visible={true}
            recenterRoverTrigger={recenterRoverCount}
            recenterPlanTrigger={recenterPlanCount}
            onSelectPoint={onSelectPoint}
            onSelectLine={onSelectLine}
            selectedLineId={selectedLineId}
            showCornerPoints={true}
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
                    key={`${layer}-${index}`}
                    d={d}
                    stroke={strokeForLayer(layer)}
                    strokeWidth={2 / viewport.zoom}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    opacity={0.96}
                    {...(layer === "extension" ? { strokeDasharray: `${8 / viewport.zoom} ${6 / viewport.zoom}` } : {})}
                  />
                ))
              )}
              {selectedLine ? (
                <Path
                  d={buildSvgPathForLine(selectedLine)}
                  stroke="#ef4444"
                  strokeWidth={3 / viewport.zoom}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  opacity={1}
                />
              ) : null}
              {/* ── Endpoints / Corners ── */}
              {cornerPoints.map((pt, i) => (
                <Circle key={`ep-${i}`} cx={pt.y} cy={pt.x} r={2.5 / viewport.zoom} fill="#3b82f6" opacity={0.8} />
              ))}
              {/* ── Selected Points ── */}
              {selectedPoints?.map((pt, i) => (
                <Circle
                  key={`sp-${i}`}
                  cx={pt.y}
                  cy={pt.x}
                  r={6 / viewport.zoom}
                  fill="#f97316"
                  stroke="#ffffff"
                  strokeWidth={1.5 / viewport.zoom}
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
            {selectedLine ? (() => {
              const segment = getPreviewArrowSegment(selectedLine, viewport, rotation, layoutSize);
              if (!segment) return null;

              const points = buildPreviewArrowheadPoints(segment.from, segment.to);
              return points ? (
                <Polygon
                  points={points}
                  fill="#ef4444"
                  stroke="#ffffff"
                  strokeWidth={0.9}
                  strokeLinejoin="round"
                />
              ) : null;
            })() : null}
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

            {/* ── Aligned Reference Points with GPS labels ── */}
            {alignedRefPoints?.map((pt, i) => {
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
                  <Circle
                    cx={sx}
                    cy={sy}
                    r={8}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                  {showRefPointLabels && activeRefPointLabelIndex === i && (
                    <>
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
                        fill="#10b981"
                        fontWeight="700"
                      >
                        {`${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}`}
                      </SvgText>
                    </>
                  )}
                </G>
              );
            })}

            {/* ── Rover icon (top-down car shape) ── */}
            {hasRover && layoutSize.width > 0 && (() => {
              const cx = roverScreenX;
              const cy = roverScreenY;
              // Car dimensions in screen pixels
              const carLength = 22;
              const carWidth = 13;
              const noseLength = 7;
              // heading_ned_deg: 0=North(up), 90=East(right), clockwise
              // SVG rotation: 0=up, positive=clockwise, matches NED heading directly.
              // We also add map rotation.
              const headingRot = roverDisplayPose.headingDeg + rotation;
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

      {/* ── Single Heading Compass (always shown) ── */}
      <View
        style={{
          position: "absolute",
          top: 14,
          right: 14,
          width: 62,
          height: 62,
          zIndex: 40,
          elevation: 40,
          backgroundColor: "transparent",
        }}
      >
        <Svg width={62} height={62} viewBox="0 0 62 62">
          {/* Outer ring */}
          <Circle cx={31} cy={31} r={28} fill="rgba(15,23,42,0.88)" stroke="#38bdf8" strokeWidth={1.5} />
          {/* Cardinal labels — fixed */}
          <SvgText x={31} y={13} fontSize={8} fill="#ef4444" fontWeight="900" textAnchor="middle">N</SvgText>
          <SvgText x={31} y={55} fontSize={7} fill="#94a3b8" fontWeight="700" textAnchor="middle">S</SvgText>
          <SvgText x={54} y={34} fontSize={7} fill="#94a3b8" fontWeight="700" textAnchor="middle">E</SvgText>
          <SvgText x={8} y={34} fontSize={7} fill="#94a3b8" fontWeight="700" textAnchor="middle">W</SvgText>
          {/* Tick marks */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
            const r = (deg % 90 === 0) ? 3.5 : 2;
            const rad = (deg * Math.PI) / 180;
            const inner = 22;
            const outer = inner + r;
            return (
              <Line
                key={deg}
                x1={31 + inner * Math.sin(rad)}
                y1={31 - inner * Math.cos(rad)}
                x2={31 + outer * Math.sin(rad)}
                y2={31 - outer * Math.cos(rad)}
                stroke="#475569"
                strokeWidth={deg % 90 === 0 ? 1.5 : 1}
              />
            );
          })}
          {/* Rotating needle — points to rover heading (defaults to 0 / static North if no telemetry) */}
          <G transform={`rotate(${hasRover ? roverDisplayPose.headingDeg : 0} 31 31)`}>
            {/* North pointer (direction rover nose points) */}
            <Polygon points="31,17 34.5,31 27.5,31" fill="#38bdf8" />
            {/* South pointer */}
            <Polygon points="31,45 34.5,31 27.5,31" fill="#475569" />
            {/* Center dot */}
            <Circle cx={31} cy={31} r={3} fill="#0f172a" stroke="#fff" strokeWidth={1.2} />
          </G>
        </Svg>
        {/* Heading label below compass — only shown when telemetry is active */}
        {hasRover && (
          <View style={{ alignItems: "center", marginTop: 3 }}>
            <Text style={{ color: "#0f172a", fontSize: 9.5, fontWeight: "800", backgroundColor: "rgba(255,255,255,0.85)", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6 }}>
              {roverDisplayPose.headingDeg.toFixed(1)}°
            </Text>
          </View>
        )}
      </View>

      {/* ── Map Refocus Controls ── */}
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
        {/* Focus Plan Button */}
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

        {/* Focus Rover Button */}
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
    </View>
  );
}

type SprayParamPayloadValue = string | number | boolean;

type SprayControllerParam = {
  name: string;
  type: string;
  default: unknown;
  current: unknown;
  group?: string | null;
  description?: string | null;
  min?: number | null;
  max?: number | null;
};

const sprayParamTableHeaderStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 10,
  color: "#0f172a",
  fontSize: 12,
  fontWeight: "800",
} as const;

const sprayParamTableTextCellStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 10,
  color: "#334155",
  fontSize: 12,
} as const;

const sprayParamTableInputCellStyle = {
  width: 120,
  paddingHorizontal: 10,
  paddingVertical: 6,
  justifyContent: "center",
} as const;

function formatSprayParamValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function sprayParamKind(param: SprayControllerParam) {
  return String(param.type ?? "").trim().toLowerCase();
}

function isNumericSprayParam(param: SprayControllerParam) {
  const kind = sprayParamKind(param);
  return ["number", "float", "double", "integer", "int"].includes(kind);
}

function parseSprayParamInput(rawValue: string, param: SprayControllerParam): SprayParamPayloadValue {
  const value = rawValue.trim();
  const kind = sprayParamKind(param);

  if (["boolean", "bool"].includes(kind)) {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    throw new Error(`${param.name} must be true or false.`);
  }

  if (["integer", "int"].includes(kind)) {
    if (!/^-?\d+$/.test(value)) throw new Error(`${param.name} must be an integer.`);
    const parsed = Number.parseInt(value, 10);
    validateSprayParamRange(parsed, param);
    return parsed;
  }

  if (["number", "float", "double"].includes(kind)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${param.name} must be a number.`);
    validateSprayParamRange(parsed, param);
    return parsed;
  }

  return rawValue;
}

function validateSprayParamRange(value: number, param: SprayControllerParam) {
  if (typeof param.min === "number" && value < param.min) {
    throw new Error(`${param.name} must be at least ${param.min}.`);
  }
  if (typeof param.max === "number" && value > param.max) {
    throw new Error(`${param.name} must be at most ${param.max}.`);
  }
}

function SwoziPage({
  delayA,
  delayB,
  setDelayA,
  setDelayB,
  toggleA,
  toggleB,
  setToggleA,
  setToggleB,
  apiBaseUrl,
}: {
  delayA: number;
  delayB: number;
  setDelayA: (v: number) => void;
  setDelayB: (v: number) => void;
  toggleA: boolean;
  toggleB: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  apiBaseUrl?: string;
}) {
  const [sprayDuration, setSprayDuration] = useState("2");
  const [sprayStatus, setSprayStatus] = useState(false);
  const [isTestActive, setIsTestActive] = useState(false);
  const [sprayParams, setSprayParams] = useState<SprayControllerParam[]>([]);
  const [editedSprayParams, setEditedSprayParams] = useState<Record<string, string>>({});
  const [isLoadingSprayParams, setIsLoadingSprayParams] = useState(false);
  const [isSavingSprayParams, setIsSavingSprayParams] = useState(false);
  const [isSprayHoldActive, setIsSprayHoldActive] = useState(false);
  const [isSprayHoldChanging, setIsSprayHoldChanging] = useState(false);

  const sprayApiUrl = useCallback((path: string) => {
    if (!apiBaseUrl) return "";
    return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
  }, [apiBaseUrl]);

  const loadSprayParams = useCallback(async () => {
    if (!apiBaseUrl) {
      setSprayParams([]);
      setEditedSprayParams({});
      return;
    }
    setIsLoadingSprayParams(true);
    try {
      const res = await fetch(sprayApiUrl("/api/spray/params"), {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || "Failed to load spray parameters.");
      }
      const data = await res.json();
      const params = Array.isArray(data?.parameters) ? data.parameters : [];
      setSprayParams(params);
      setEditedSprayParams({});
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to load spray parameters.");
    } finally {
      setIsLoadingSprayParams(false);
    }
  }, [apiBaseUrl, sprayApiUrl]);

  useEffect(() => {
    loadSprayParams();
  }, [loadSprayParams]);

  // --- v2 spray params state (used by fetchSprayParams / handleSaveParams) ---
  type SprayParam = {
    name: string;
    type: string;
    default: any;
    current: any;
    group: string;
    desc: string;
    min?: number;
    max?: number;
  };
  const [paramEdits, setParamEdits] = useState<Record<string, string>>({});
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [paramsSaving, setParamsSaving] = useState(false);
  const [paramsSaveStatus, setParamsSaveStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  // --- Manual Hold State ---
  const [manualHoldActive, setManualHoldActive] = useState(false);
  const manualHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Status polling
  useEffect(() => {
    if (!apiBaseUrl) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(sprayApiUrl("/api/spray/status"));
        if (res.ok) {
          const data = await res.json();
          const active = !!(data.spraying || data.manual_override || data.spray_active_desired);
          setSprayStatus(active);
          setIsSprayHoldActive(active);
        }
      } catch (err) {
        // ignore network errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [apiBaseUrl, sprayApiUrl]);

  // Fetch spray params on mount
  useEffect(() => {
    if (!apiBaseUrl) return;
    fetchSprayParams();
  }, [apiBaseUrl]);

  const fetchSprayParams = async () => {
    if (!apiBaseUrl) return;
    setParamsLoading(true);
    setParamsError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/spray/params`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // data may be { parameters: { key: { type, default, current, group, desc, min, max } } }
      const raw: Record<string, any> = data.parameters ?? data;
      const parsed: SprayParam[] = Object.entries(raw).map(([name, meta]: [string, any]) => ({
        name,
        type: meta.type ?? 'string',
        default: meta.default,
        current: meta.current,
        group: meta.group ?? '',
        desc: meta.desc ?? meta.description ?? '',
        min: meta.min,
        max: meta.max,
      }));
      setSprayParams(parsed);
      // Seed edits with current values
      const seeds: Record<string, string> = {};
      parsed.forEach(p => { seeds[p.name] = String(p.current ?? p.default ?? ''); });
      setParamEdits(seeds);
    } catch (err: any) {
      setParamsError(err.message ?? 'Failed to fetch params');
    } finally {
      setParamsLoading(false);
    }
  };

  const handleSaveParams = async () => {
    if (!apiBaseUrl) return;
    setParamsSaving(true);
    setParamsSaveStatus('idle');
    try {
      // Cast values to correct types
      const payload: Record<string, any> = {};
      sprayParams.forEach(p => {
        const raw = paramEdits[p.name] ?? String(p.current ?? p.default ?? '');
        if (p.type === 'bool') payload[p.name] = raw === 'true' || raw === '1';
        else if (p.type === 'int') payload[p.name] = parseInt(raw, 10);
        else if (p.type === 'float') payload[p.name] = parseFloat(raw);
        else payload[p.name] = raw;
      });
      const res = await fetch(`${apiBaseUrl}/api/spray/params`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setParamsSaveStatus('ok');
      // Refresh to get server-confirmed values
      await fetchSprayParams();
    } catch (err: any) {
      setParamsSaveStatus('err');
    } finally {
      setParamsSaving(false);
      setTimeout(() => setParamsSaveStatus('idle'), 3000);
    }
  };

  // Manual spray hold helpers
  const startManualHold = async () => {
    if (!apiBaseUrl || manualHoldActive || manualHeartbeatRef.current) return;
    try {
      await fetch(`${apiBaseUrl}/api/spray/on`, { method: 'POST' });
      setManualHoldActive(true);
      if (manualHeartbeatRef.current) clearInterval(manualHeartbeatRef.current);
      // Send a heartbeat every 7 s to keep the 8 s window alive
      manualHeartbeatRef.current = setInterval(async () => {
        try { await fetch(`${apiBaseUrl}/api/spray/on`, { method: 'POST' }); } catch (_) { }
      }, 7000);
    } catch (err) {
      console.log('Spray ON failed', err);
    }
  };

  const stopManualHold = async () => {
    if (!apiBaseUrl) return;
    if (manualHeartbeatRef.current) {
      clearInterval(manualHeartbeatRef.current);
      manualHeartbeatRef.current = null;
    }
    try {
      await fetch(`${apiBaseUrl}/api/spray/off`, { method: 'POST' });
    } catch (err) {
      console.log('Spray OFF failed', err);
    }
    setManualHoldActive(false);
  };

  // Cleanup heartbeat on unmount
  useEffect(() => {
    return () => {
      if (manualHeartbeatRef.current) clearInterval(manualHeartbeatRef.current);
    };
  }, []);

  const handleSprayToggle = async () => {
    if (!apiBaseUrl) return;
    const isTurningOn = !isTestActive;
    try {
      const res = await fetch(sprayApiUrl("/api/spray/test"), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          on: isTurningOn,
          duration_s: isTurningOn ? Number(sprayDuration) || 2 : 0
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to run spray test.");
        return;
      }
      setIsTestActive(isTurningOn);
      if (isTurningOn) {
        // automatically reset button state after duration
        setTimeout(() => setIsTestActive(false), (Number(sprayDuration) || 2) * 1000);
      }
    } catch (err) {
      console.log("Spray test failed", err);
    }
  };

  const handleSprayParamEdit = (name: string, value: string, current: unknown) => {
    setEditedSprayParams((prev) => {
      const next = { ...prev };
      if (value === formatSprayParamValue(current)) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  const handleSetSprayVariables = async () => {
    if (!apiBaseUrl) return;
    const editedEntries = Object.entries(editedSprayParams);
    if (editedEntries.length === 0) return;

    const paramsByName = new Map(sprayParams.map((param) => [param.name, param]));
    const payloadParams: Record<string, SprayParamPayloadValue> = {};

    try {
      for (const [name, rawValue] of editedEntries) {
        const param = paramsByName.get(name);
        if (!param) continue;
        payloadParams[name] = parseSprayParamInput(rawValue, param);
      }
    } catch (err: any) {
      Alert.alert("Invalid Value", err.message || "Check the edited spray parameter values.");
      return;
    }

    if (Object.keys(payloadParams).length === 0) return;

    setIsSavingSprayParams(true);
    try {
      const res = await fetch(sprayApiUrl("/api/spray/params"), {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ parameters: payloadParams }),
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || "Failed to set spray variables.");
        return;
      }
      Alert.alert("Success", "Spray variables updated.");
      await loadSprayParams();
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSavingSprayParams(false);
    }
  };
  const handleSprayHoldToggle = async () => {
    if (!apiBaseUrl) return;
    const nextHoldActive = !isSprayHoldActive;
    setIsSprayHoldChanging(true);
    try {
      const res = await fetch(sprayApiUrl(nextHoldActive ? "/api/spray/on" : "/api/spray/off"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const errText = await res.text();
        Alert.alert("Error", errText || `Failed to turn spray ${nextHoldActive ? "on" : "off"}.`);
        return;
      }
      setIsSprayHoldActive(nextHoldActive);
      setSprayStatus(nextHoldActive);
      if (!nextHoldActive) setIsTestActive(false);
    } catch (err: any) {
      Alert.alert("Error", err.message || "Failed to connect to backend.");
    } finally {
      setIsSprayHoldChanging(false);
    }
  };

  const hasEditedSprayParams = Object.keys(editedSprayParams).length > 0;

  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>

      <Text style={secH}>Cart</Text>
      <Text style={itemH}>Configured Machine</Text>
      <Text style={itemT}>Not Configured</Text>
      <Text style={itemT}>Searching</Text>
      <Text style={secH}>Pump</Text>
      <Text style={itemH}>Manual Control</Text>
      <Text style={itemT}>Disconnected</Text>

      {/* Spray Test Section */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginVertical: 12 }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center" }}>
          <Text style={{ color: "#334155", fontSize: 16, fontWeight: "600", marginRight: 12 }}>Spray Test</Text>
          {sprayStatus && (
            <View style={{ backgroundColor: "#22c55e", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 }}>
              <Text style={{ color: "#fff", fontSize: 10, fontWeight: "bold" }}>SPRAYING</Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <TextInput
            value={sprayDuration}
            onChangeText={setSprayDuration}
            keyboardType="numeric"
            placeholder="sec"
            style={{
              borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8,
              width: 60, paddingHorizontal: 10, paddingVertical: 8,
              marginRight: 10, color: "#334155", textAlign: "center"
            }}
          />
          <Pressable
            onPress={handleSprayToggle}
            style={{
              backgroundColor: isTestActive ? "#ef4444" : "#0ea5e9",
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 8
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>{isTestActive ? "Stop" : "Start"}</Text>
          </Pressable>
          <Pressable
            onPress={handleSprayHoldToggle}
            disabled={isSprayHoldChanging}
            style={{
              backgroundColor: isSprayHoldChanging ? "#94a3b8" : isSprayHoldActive ? "#ef4444" : "#0f766e",
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 8,
              marginLeft: 10,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>
              {isSprayHoldChanging ? "..." : isSprayHoldActive ? "Spray Off" : "Spray On"}
            </Text>
          </Pressable>
          <Pressable
            onPressIn={startManualHold}
            onPressOut={stopManualHold}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={({ pressed }) => ({
              marginLeft: 14,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ color: manualHoldActive ? "#10b981" : "#0f766e", fontWeight: "700", textDecorationLine: "underline" }}>
              {manualHoldActive ? "SPRAYING..." : "Hold to Spray"}
            </Text>
          </Pressable>
        </View>
      </View>
      {manualHoldActive && (
        <View style={{ backgroundColor: '#dcfce7', borderRadius: 8, padding: 8, marginBottom: 12 }}>
          <Text style={{ color: '#15803d', fontSize: 12, textAlign: 'center', fontWeight: '600' }}>● Manual spray active — heartbeat running</Text>
        </View>
      )}

      <View style={{ marginTop: 4, marginBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Text style={itemH}>Spray Controller Params</Text>
          {hasEditedSprayParams && (
            <Pressable
              onPress={handleSetSprayVariables}
              disabled={isSavingSprayParams}
              style={{
                backgroundColor: isSavingSprayParams ? "#94a3b8" : "#0f988f",
                paddingHorizontal: 14,
                paddingVertical: 9,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "800" }}>
                {isSavingSprayParams ? "Saving..." : "Set Variables"}
              </Text>
            </Pressable>
          )}
        </View>
        {isLoadingSprayParams ? (
          <View style={{ paddingVertical: 16, alignItems: "center" }}>
            <ActivityIndicator color="#0f988f" />
          </View>
        ) : sprayParams.length === 0 ? (
          <Text style={{ color: "#64748b", fontSize: 13 }}>No spray parameters loaded.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={{ borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, overflow: "hidden" }}>
              <View style={{ flexDirection: "row", backgroundColor: "#f1f5f9" }}>
                {["Name", "Group", "Type", "Current", "Default", "Min", "Max", "Description"].map((heading) => (
                  <Text key={heading} style={sprayParamTableHeaderStyle}>{heading}</Text>
                ))}
              </View>
              {sprayParams.map((param, index) => {
                const editedValue = editedSprayParams[param.name];
                return (
                  <View
                    key={param.name}
                    style={{
                      flexDirection: "row",
                      backgroundColor: index % 2 === 0 ? "#fff" : "#f8fafc",
                      borderTopWidth: 1,
                      borderTopColor: "#e2e8f0",
                    }}
                  >
                    <Text style={sprayParamTableTextCellStyle}>{param.name}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.group)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.type)}</Text>
                    <View style={sprayParamTableInputCellStyle}>
                      <TextInput
                        value={editedValue ?? formatSprayParamValue(param.current)}
                        onChangeText={(value) => handleSprayParamEdit(param.name, value, param.current)}
                        keyboardType={isNumericSprayParam(param) ? "numeric" : "default"}
                        autoCapitalize="none"
                        style={{
                          minWidth: 92,
                          borderWidth: 1,
                          borderColor: editedValue == null ? "#cbd5e1" : "#0f988f",
                          borderRadius: 6,
                          paddingHorizontal: 8,
                          paddingVertical: 6,
                          color: "#0f172a",
                          fontSize: 12,
                        }}
                      />
                    </View>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.default)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.min)}</Text>
                    <Text style={sprayParamTableTextCellStyle}>{formatSprayParamValue(param.max)}</Text>
                    <Text style={[sprayParamTableTextCellStyle, { width: 220 }]}>{formatSprayParamValue(param.description)}</Text>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      <RowToggle label="Manual Painting with Long Press" value={toggleA} onChange={setToggleA} />
      <RowToggle label="Paint When Reversing" value={toggleB} onChange={setToggleB} />
      <RowSlider label="Pump Start Delay [s]" value={delayA} onChange={setDelayA} />
      <RowSlider label="Pump Stop Delay [s]" value={delayB} onChange={setDelayB} />
      <Text style={secH}>Paint Rate</Text>
      <Text style={itemT}>Slowest Rate 100%</Text>
      <Text style={itemT}>Fastest Rate 100%</Text>
      <Text style={secH}>Arm Control</Text>
      <Text style={itemH}>Manual Control</Text>
      <Text style={itemT}>Disconnected</Text>
      <Text style={secH}>Dimensions</Text>
      <Text style={itemH}>Offset Sideways</Text>
      <Text style={itemT}>0.085m</Text>
      <Text style={itemH}>Offset Front</Text>
      <Text style={itemT}>0m</Text>
      <Text style={itemH}>Offset Up</Text>
      <Text style={itemT}>0.5m</Text>
      <Text style={itemH}>Mow Deck Cut Width</Text>
      <Text style={itemT}>1m</Text>
    </ScrollView>
  );
}

function StatusPage() {
  return (
    <ScrollView style={{ flex: 1, padding: 12 }}>
      <Text style={itemT}>Tablet not connected to a machine.</Text>
      <Text style={[itemT, { marginTop: 26 }]}>Searching for a machine to connect to.</Text>
      <Text style={[itemT, { marginTop: 26 }]}>Tablet not connected to a machine.</Text>
      <View style={{ marginTop: 26 }}>
        <Text style={itemH}>Current Status:</Text>
        <Text style={itemT}>Tablet App not connected to the machine.</Text>
        <Text style={itemH}>To Proceed:</Text>
        <Text style={[itemT, { fontWeight: "700" }]}>Ensure the tablet is configured and the machine is turned on.</Text>
        <Text style={itemH}>Next Status:</Text>
        <Text style={[itemT, { fontStyle: "italic" }]}>Connected to the machine.</Text>
      </View>
      <Text style={secH}>Field Category</Text>
      {[
        "Football (Soccer)",
        "Rugby",
        "North American Football (Gridiron)",
        "Running Tracks - Grass",
        "Athletics",
        "Ball and Net Sports",
        "Racquet, Bat and Stick Sports",
        "Miscellaneous Fields",
      ].map((x) => (
        <Text key={x} style={itemT}>🔒 {x}</Text>
      ))}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

function PositioningPage({
  toggleA,
  toggleB,
  toggleC,
  toggleD,
  setToggleA,
  setToggleB,
  setToggleC,
  setToggleD,
}: {
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  toggleD: boolean;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  setToggleD: (v: boolean) => void;
}) {
  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>
      <Text style={secH}>Position</Text>
      <RowToggle label="Position Smoothing" value={toggleC} onChange={setToggleC} />
      <RowToggle label="Disable Position Snap with Long Press" value={toggleD} onChange={setToggleD} />
      <RowToggle label="Position Jump Detection" value={toggleA} onChange={setToggleA} />
      <Text style={secH}>Source</Text>
      <Text style={itemT}>◯ GPS</Text>
      <Text style={itemT}>◯ Local Laser Tracker</Text>
      <Text style={secH}>Terrain Correction</Text>
      <Text style={itemT}>Roll</Text>
      <RowToggle label="Terrain Correction" value={toggleA} onChange={setToggleA} />
      <RowToggle label="3D Terrain Correction (Beta)" value={toggleB} onChange={setToggleB} />
      <RowToggle label="3D Terrain Correction Prompts" value={toggleC} onChange={setToggleC} />
    </ScrollView>
  );
}

function SettingsPage({
  toggleA,
  toggleB,
  toggleC,
  delayA,
  setToggleA,
  setToggleB,
  setToggleC,
  setDelayA,
}: {
  toggleA: boolean;
  toggleB: boolean;
  toggleC: boolean;
  delayA: number;
  setToggleA: (v: boolean) => void;
  setToggleB: (v: boolean) => void;
  setToggleC: (v: boolean) => void;
  setDelayA: (v: number) => void;
}) {
  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>
      <Text style={secH}>Field</Text>
      <Text style={itemH}>Ground Quality</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={itemT}>Smooth</Text>
        <View style={{ flex: 1 }}>
          <Slider minimumValue={0} maximumValue={1} value={delayA} onValueChange={setDelayA} minimumTrackTintColor={TEAL} maximumTrackTintColor="#bfc0c3" />
        </View>
        <Text style={itemT}>Bumpy</Text>
      </View>
      <RowToggle label="Auto Line Select" value={toggleA} onChange={setToggleA} />
      <RowToggle label="Hard Surface" value={toggleB} onChange={setToggleB} />
      <Text style={secH}>Display</Text>
      <RowToggle label="Metric" value={toggleC} onChange={setToggleC} />
      <RowToggle label="Dark Mode" value={toggleB} onChange={setToggleB} />
      <Text style={secH}>Account Details</Text>
      <TextInput value="Username" style={{ borderBottomWidth: 1, borderBottomColor: "#c5c6c8", color: "#666", fontSize: 34 / 2, paddingVertical: 6 }} />
      <Text style={secH}>Restore Default Settings</Text>
      <Pressable style={{ width: 92, height: 92, borderWidth: 1, borderColor: "#bbb", backgroundColor: "#d6d6d7", justifyContent: "center", alignItems: "center" }}>
        <Text style={{ fontSize: 28 }}>↺</Text>
      </Pressable>
      <View style={{ height: 26 }} />
    </ScrollView>
  );
}

function HowToPage() {
  const items = [
    "Videos",
    "System Basics",
    "How to create a sports field",
    "How to reference the system",
    "How to change a sports field",
    "How to manually operate the pump or arm?",
    "How does the SWOZI terrain correction work? (Beta)",
  ];
  return (
    <ScrollView style={{ flex: 1, padding: 18 }}>
      <Text style={{ fontSize: 64 / 2, color: "#2c2c2d", fontWeight: "500", marginBottom: 10 }}>
        Welcome to the SWOZI knowledge base
      </Text>
      {items.map((x) => (
        <View key={x} style={{ height: 62 / 2, backgroundColor: "#d7d7d8", borderWidth: 1, borderColor: "#c8c9ca", borderRadius: 4, justifyContent: "center", paddingHorizontal: 12, marginBottom: 8 }}>
          <Text style={{ fontSize: 36 / 2, color: "#2e2f30" }}>{x}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function AboutPage() {
  return (
    <ScrollView style={{ flex: 1 }}>
      <View style={{ height: 52, backgroundColor: "#bcbdbf", flexDirection: "row" }}>
        {["TERMS", "OPEN SOURCE", "PRIVACY", "VERSION"].map((t, i) => (
          <View key={t} style={{ flex: 1, backgroundColor: i === 0 ? "#efefef" : "#bcbdbf", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 28 / 2, color: "#222" }}>{t}</Text>
          </View>
        ))}
      </View>
      <View style={{ padding: 10 }}>
        <Text style={{ fontSize: 62 / 2, color: "#2e2f31", marginBottom: 8 }}>SWOZI AG Terms of Service</Text>
        <Text style={itemT}>Last modified: November 1, 2016</Text>
        <Text style={[itemH, { marginTop: 12 }]}>Using our Services</Text>
        <Text style={itemT}>
          You must follow any policies made available to you within the Services.
        </Text>
        <Text style={[itemH, { marginTop: 12 }]}>Privacy and Copyright Protection</Text>
        <Text style={itemT}>SWOZI Privacy Policy explain how we treat your personal data.</Text>
      </View>
    </ScrollView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: "#0f172a", fontWeight: "700" }}>{label}</Text>
      <Text style={{ color: "#0f172a", flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

function lineLength(line: PlanLine) {
  return Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
}

function lineAngle(line: PlanLine) {
  return (Math.atan2(line.to.y - line.from.y, line.to.x - line.from.x) * 180) / Math.PI;
}

function buildRectangleTemplate(name: string, width: number, height: number): PlanLine[] {
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const cx = x0 + width / 2;

  return [
    {
      id: `${name}-top`,
      label: `${name} Top`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x0, y: y0 },
      to: { id: nextGeneratedPointId(), x: x1, y: y0 },
      width: 0.1,
    },
    {
      id: `${name}-right`,
      label: `${name} Right`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x1, y: y0 },
      to: { id: nextGeneratedPointId(), x: x1, y: y1 },
      width: 0.1,
    },
    {
      id: `${name}-bottom`,
      label: `${name} Bottom`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x1, y: y1 },
      to: { id: nextGeneratedPointId(), x: x0, y: y1 },
      width: 0.1,
    },
    {
      id: `${name}-left`,
      label: `${name} Left`,
      layer: "boundary",
      from: { id: nextGeneratedPointId(), x: x0, y: y1 },
      to: { id: nextGeneratedPointId(), x: x0, y: y0 },
      width: 0.1,
    },
    {
      id: `${name}-center`,
      label: `${name} Center`,
      layer: "center",
      from: { id: nextGeneratedPointId(), x: cx, y: y0 },
      to: { id: nextGeneratedPointId(), x: cx, y: y1 },
      width: 0.08,
    },
  ];
}

function buildTemplate(name: string, width: number, height: number): PlanLine[] {
  resetGeneratedPointIds();
  const key = name.toLowerCase();
  if (key.includes("reference sample")) return buildReferenceSampleTemplate(width, height);
  if (key.includes("football")) return buildFootballTemplate(width, height);
  if (key.includes("hockey")) return buildHockeyTemplate(width, height);
  if (key.includes("cricket")) return buildCricketPitchTemplate(width, height);
  if (key.includes("volleyball")) return buildVolleyballTemplate(width, height);
  if (key.includes("badminton")) return buildBadmintonTemplate(width, height);
  if (key.includes("kabaddi")) return buildKabaddiTemplate(width, height);
  if (key.includes("khokho")) return buildKhoKhoTemplate(width, height);
  return buildRectangleTemplate(name.toLowerCase().replace(/\s+/g, "_"), width, height);
}

function buildFootballTemplate(width: number, height: number): PlanLine[] {
  const name = "football";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const penaltyW = 16.5;
  const penaltyH = 40.32;
  const goalW = 5.5;
  const goalH = 18.32;
  const arcRadius = 9.15;

  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.1, "Center Line"),
    ...buildRect(name, "marking", x0, centerY - penaltyH / 2, x0 + penaltyW, centerY + penaltyH / 2, 0.08, "Left Penalty Box"),
    ...buildRect(name, "marking", x1 - penaltyW, centerY - penaltyH / 2, x1, centerY + penaltyH / 2, 0.08, "Right Penalty Box"),
    ...buildRect(name, "marking", x0, centerY - goalH / 2, x0 + goalW, centerY + goalH / 2, 0.08, "Left Goal Box"),
    ...buildRect(name, "marking", x1 - goalW, centerY - goalH / 2, x1, centerY + goalH / 2, 0.08, "Right Goal Box"),
    ...buildCircle(name, "center", centerX, centerY, arcRadius, 64, "Center Circle"),
    ...buildArcPolyline(x0 + penaltyW, centerY, arcRadius, 305, 55, 24, "marking", `${name}-left-penalty-arc`),
    ...buildArcPolyline(x1 - penaltyW, centerY, arcRadius, 125, 235, 24, "marking", `${name}-right-penalty-arc`),
    ...buildCornerArcs(name, x0, y0, x1, y1, 1, 12),
  ];
}

function buildHockeyTemplate(width: number, height: number): PlanLine[] {
  const name = "hockey";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const dRadius = 14.63;
  const circleX = x0 + 22.9;
  const rightCircleX = x1 - 22.9;

  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.08, "Center Line"),
    line(`${name}-left-23`, "marking", circleX, y0, circleX, y1, 0.06, "23m Line Left"),
    line(`${name}-right-23`, "marking", rightCircleX, y0, rightCircleX, y1, 0.06, "23m Line Right"),
    ...buildArcPolyline(x0 + 14.63, centerY, dRadius, 270, 90, 32, "marking", `${name}-left-d-arc-a`),
    ...buildArcPolyline(x0 + 14.63, centerY, dRadius, 90, 270, 32, "marking", `${name}-left-d-arc-b`),
    ...buildArcPolyline(x1 - 14.63, centerY, dRadius, 90, 270, 32, "marking", `${name}-right-d-arc-a`),
    ...buildArcPolyline(x1 - 14.63, centerY, dRadius, 270, 90, 32, "marking", `${name}-right-d-arc-b`),
  ];
}

function buildCricketPitchTemplate(width: number, height: number): PlanLine[] {
  const name = "cricket_pitch";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-pitch-line-a`, "center", centerX, y0, centerX, y1, 0.08, "Pitch Center"),
    line(`${name}-pitch-line-b`, "center", centerX - 1.525, y0, centerX - 1.525, y1, 0.08, "Pitch Stump Line Left"),
    line(`${name}-pitch-line-c`, "center", centerX + 1.525, y0, centerX + 1.525, y1, 0.08, "Pitch Stump Line Right"),
    ...buildArcPolyline(centerX, centerY, 27.43, 300, 60, 36, "marking", `${name}-left-ring`),
    ...buildArcPolyline(centerX, centerY, 27.43, 120, 240, 36, "marking", `${name}-right-ring`),
  ];
}

function buildVolleyballTemplate(width: number, height: number): PlanLine[] {
  const name = "volleyball";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-line`, "center", centerX, y0, centerX, y1, 0.08, "Center Line"),
    line(`${name}-attack-left`, "marking", centerX - 3, y0, centerX - 3, y1, 0.06, "Attack Line Left"),
    line(`${name}-attack-right`, "marking", centerX + 3, y0, centerX + 3, y1, 0.06, "Attack Line Right"),
  ];
}

function buildBadmintonTemplate(width: number, height: number): PlanLine[] {
  const name = "badminton";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-center-net`, "center", centerX, y0, centerX, y1, 0.05, "Net Line"),
    line(`${name}-short-service`, "marking", x0, y0 + 1.98, x1, y0 + 1.98, 0.05, "Short Service Line"),
    line(`${name}-long-service`, "marking", x0, y1 - 0.76, x1, y1 - 0.76, 0.05, "Long Service Line Doubles"),
    line(`${name}-singles-left`, "marking", x0 + 0.46, y0, x0 + 0.46, y1, 0.04, "Singles Sideline Left"),
    line(`${name}-singles-right`, "marking", x1 - 0.46, y0, x1 - 0.46, y1, 0.04, "Singles Sideline Right"),
  ];
}

function buildKabaddiTemplate(width: number, height: number): PlanLine[] {
  const name = "kabaddi";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerY = y0 + height / 2;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-halfway`, "center", x0, centerY, x1, centerY, 0.08, "Halfway Line"),
    line(`${name}-baulk-a`, "marking", x0, centerY - 3.75, x1, centerY - 3.75, 0.06, "Baulk Line A"),
    line(`${name}-baulk-b`, "marking", x0, centerY + 3.75, x1, centerY + 3.75, 0.06, "Baulk Line B"),
    line(`${name}-bonus-a`, "marking", x0, y0 + 1.75, x1, y0 + 1.75, 0.06, "Bonus Line A"),
    line(`${name}-bonus-b`, "marking", x0, y1 - 1.75, x1, y1 - 1.75, 0.06, "Bonus Line B"),
  ];
}

function buildKhoKhoTemplate(width: number, height: number): PlanLine[] {
  const name = "khokho";
  const x0 = 10;
  const y0 = 10;
  const x1 = x0 + width;
  const y1 = y0 + height;
  const centerX = x0 + width / 2;
  const centerY = y0 + height / 2;
  const laneGap = 2.3;
  return [
    ...buildRectangleTemplate(name, width, height),
    line(`${name}-central-lane`, "center", centerX, y0 + 1.5, centerX, y1 - 1.5, 0.08, "Central Lane"),
    ...Array.from({ length: 8 }, (_, i) => {
      const offset = y0 + 2.55 + laneGap * i;
      return line(`${name}-cross-${i + 1}`, "marking", x0, offset, x1, offset, 0.05, `Cross Lane ${i + 1}`);
    }),
  ];
}

function buildArcPolyline(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  segments: number,
  layer: PlanLine["layer"],
  prefix: string
): PlanLine[] {
  const points: Array<{ x: number; y: number }> = [];
  const sweep = endAngle >= startAngle ? endAngle - startAngle : endAngle + 360 - startAngle;
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + (sweep * i) / segments;
    const rad = (angle * Math.PI) / 180;
    points.push({ x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) });
  }
  const lines: PlanLine[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    lines.push({
      id: `${prefix}-${i}`,
      label: `${prefix} segment ${i + 1}`,
      layer,
      from: { id: nextGeneratedPointId(), x: points[i].x, y: points[i].y },
      to: { id: nextGeneratedPointId(), x: points[i + 1].x, y: points[i + 1].y },
      width: layer === "boundary" ? 0.12 : 0.08,
    });
  }
  return lines;
}

function buildCircle(
  name: string,
  layer: PlanLine["layer"],
  cx: number,
  cy: number,
  radius: number,
  segments: number,
  label: string
) {
  return buildArcPolyline(cx, cy, radius, 0, 360, segments, layer, `${name}-${label.replace(/\s+/g, "-").toLowerCase()}`);
}

function buildRect(
  name: string,
  layer: PlanLine["layer"],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  label: string
) {
  return [
    line(`${name}-${label}-top`, layer, x0, y0, x1, y0, width, `${label} Top`),
    line(`${name}-${label}-right`, layer, x1, y0, x1, y1, width, `${label} Right`),
    line(`${name}-${label}-bottom`, layer, x1, y1, x0, y1, width, `${label} Bottom`),
    line(`${name}-${label}-left`, layer, x0, y1, x0, y0, width, `${label} Left`),
  ];
}

function buildCornerArcs(name: string, x0: number, y0: number, x1: number, y1: number, radius: number, segments = 12) {
  return [
    ...buildArcPolyline(x0, y0, radius, 180, 270, segments, "marking", `${name}-corner-nw`),
    ...buildArcPolyline(x1, y0, radius, 270, 360, segments, "marking", `${name}-corner-ne`),
    ...buildArcPolyline(x1, y1, radius, 0, 90, segments, "marking", `${name}-corner-se`),
    ...buildArcPolyline(x0, y1, radius, 90, 180, segments, "marking", `${name}-corner-sw`),
  ];
}

function buildReferenceSampleTemplate(width: number, height: number): PlanLine[] {
  const x0 = 12;
  const y0 = 10;
  const x1 = 88;
  const y1 = 50;
  const centerX = (x0 + x1) / 2;
  const penaltyW = 14;
  const penaltyH = 24;

  return [
    line("ref-top", "boundary", x0, y0, x1, y0, 0.12, "Touchline North"),
    line("ref-right", "boundary", x1, y0, x1, y1, 0.12, "Goal Line East"),
    line("ref-bottom", "boundary", x1, y1, x0, y1, 0.12, "Touchline South"),
    line("ref-left", "boundary", x0, y1, x0, y0, 0.12, "Goal Line West"),
    line("ref-center", "center", centerX, y0, centerX, y1, 0.1, "Center Split"),
    line("ref-center-guide", "center", centerX - 10, (y0 + y1) / 2, centerX + 10, (y0 + y1) / 2, 0.08, "Center Guide"),
    ...buildRect("ref-left-box", "marking", x0, y0 + 8, x0 + penaltyW, y0 + 32, 0.1, "Penalty Box West"),
    ...buildRect("ref-right-box", "marking", x1 - penaltyW, y0 + 8, x1, y0 + 32, 0.1, "Penalty Box East"),
  ];
}

function line(
  id: string,
  layer: PlanLine["layer"],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  label: string
): PlanLine {
  return {
    id,
    label,
    layer,
    from: { id: nextGeneratedPointId(), x: x1, y: y1 },
    to: { id: nextGeneratedPointId(), x: x2, y: y2 },
    width,
  };
}

let generatedPointIdCounter = 1;

function resetGeneratedPointIds() {
  generatedPointIdCounter = 1;
}

function nextGeneratedPointId() {
  return generatedPointIdCounter++;
}

function defaultDimensions(name: string) {
  const key = name.toLowerCase();
  if (key.includes("volleyball")) return { width: 18, height: 9 };
  if (key.includes("badminton")) return { width: 13.4, height: 6.1 };
  if (key.includes("kabaddi")) return { width: 13, height: 10 };
  if (key.includes("khokho")) return { width: 27, height: 16 };
  if (key.includes("hockey")) return { width: 91.4, height: 55 };
  if (key.includes("cricket")) return { width: 20.12, height: 3.05 };
  return { width: 100, height: 64 };
}

const inputStyle = {
  borderWidth: 1,
  borderColor: "#cbd5e1",
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  color: "#111",
} as const;

const generatorStyles = {
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.22)",
    justifyContent: "center",
    padding: 18,
  },
  sheet: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#d7dee8",
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 14,
  },
  sheetTitle: {
    color: "#0f172a",
    fontSize: 22,
    fontWeight: "800",
  },
  sheetSubtitle: {
    color: "#64748b",
    marginTop: 4,
    lineHeight: 20,
  },
  closePill: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#d7dee8",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
  },
  closeText: {
    color: "#0f172a",
    fontSize: 22,
    lineHeight: 22,
    marginTop: -2,
  },
  toggleRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  toggleChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#d7dee8",
  },
  toggleChipActive: {
    backgroundColor: "#0f172a",
    borderColor: "#0f172a",
  },
  toggleChipText: {
    color: "#334155",
    fontWeight: "700",
  },
  toggleChipTextActive: {
    color: "#fff",
  },
  presetGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  presetCard: {
    width: "48.5%",
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d7dee8",
    backgroundColor: "#f8fafc",
  },
  presetCardActive: {
    borderColor: "#0f172a",
    backgroundColor: "#eef2f7",
  },
  presetTitle: {
    color: "#0f172a",
    fontWeight: "700",
    fontSize: 15,
  },
  presetTitleActive: {},
  presetMeta: {
    color: "#64748b",
    marginTop: 4,
    fontSize: 12,
  },
  presetMetaActive: {},
  inputRow: {
    flexDirection: "row",
    gap: 12,
  },
  inputLabel: {
    color: "#334155",
    fontWeight: "700",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#f8fafc",
    color: "#0f172a",
  },
  generateButton: {
    marginTop: 16,
    backgroundColor: "#0f172a",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  generateButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 15,
  },
} as const;

function linesToDxf(lines: PlanLine[], name: string) {
  const layers = Array.from(new Set(lines.map((line) => line.layer.toUpperCase())));
  const layerTable = layers
    .map((layer) => [
      "0",
      "LAYER",
      "2",
      layer,
      "70",
      "0",
      "62",
      layer === "BOUNDARY" ? "7" : layer === "CENTER" ? "3" : "4",
      "6",
      "CONTINUOUS",
    ].join("\n"))
    .join("\n");

  const entities = lines
    .map((entry) => [
      "0",
      "LINE",
      "8",
      entry.layer.toUpperCase(),
      "370",
      String(mmLineweight(entry.width)),
      "10",
      String(entry.from.y),
      "20",
      String(entry.from.x),
      "11",
      String(entry.to.y),
      "21",
      String(entry.to.x),
    ].join("\n"))
    .join("\n");

  return [
    "0",
    "SECTION",
    "2",
    "HEADER",
    "9",
    "$INSUNITS",
    "70",
    "6",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "TABLES",
    "0",
    "TABLE",
    "2",
    "LAYER",
    "70",
    String(layers.length),
    layerTable,
    "0",
    "ENDTAB",
    "0",
    "ENDSEC",
    "0",
    "SECTION",
    "2",
    "ENTITIES",
    entities,
    "0",
    "ENDSEC",
    "0",
    "EOF",
  ].join("\n");
}

function mmLineweight(widthMeters: number) {
  const mm = Math.round(widthMeters * 1000);
  if (mm <= 0) return -1;
  return Math.min(211, Math.max(0, mm));
}

function RowToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
      <Text style={itemT}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: "#cfd0d2", true: "#95d4cc" }} thumbColor={value ? TEAL : "#e3e3e3"} />
    </View>
  );
}

function RowSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={itemH}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Slider minimumValue={0} maximumValue={1} value={value} onValueChange={onChange} minimumTrackTintColor={TEAL} maximumTrackTintColor="#bfc0c3" />
        </View>
        <Text style={itemT}>{value.toFixed(2)}s</Text>
      </View>
    </View>
  );
}

const secH = { fontSize: 66 / 2, color: "#515254", fontWeight: "700", marginTop: 10 } as const;
const itemH = { fontSize: 50 / 2, color: "#55565a", fontWeight: "700", marginTop: 8 } as const;
const itemT = { fontSize: 46 / 2, color: "#616266", marginTop: 4 } as const;
