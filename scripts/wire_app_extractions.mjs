/**
 * Remove extracted sections from App.tsx and inject imports + telemetry store usage.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(root, "App.tsx");
let src = fs.readFileSync(appPath, "utf8");
const lines = src.split(/\r?\n/);

// Remove line ranges (1-based inclusive), from bottom to top so indices stay valid.
const removeRanges = [
  [482, 581], // FloatingEStop
  [431, 477], // DiscoveredRover..rtkModeFromStatus (types + rtk)
  [297, 430], // MAX_PREVIEW..getLineAnchorPoint (preview helpers that moved)
  [594, 595], // DISCOVERY_REFRESH kept; SOCKET timeout moved - remove only SOCKET line
  [602, 615], // deadband constants + withinDeadband
  [632, 670], // waitForSocketConnect + formatSocketConnectError
  [7292, 7754], // ConnectionView + connectionStyles
  [7895, 11211], // geometry + PlanPreview + secondary pages to EOF helpers
];

// Rebuild carefully: mark lines to keep
const drop = new Array(lines.length).fill(false);
// We'll recompute ranges after reading current file - use content markers instead for robustness.

function dropBetween(startMarker, endMarkerExclusive) {
  const start = lines.findIndex((l) => l.includes(startMarker));
  const end = lines.findIndex((l, i) => i > start && l.includes(endMarkerExclusive));
  if (start < 0 || end < 0) {
    console.warn("marker miss", startMarker, endMarkerExclusive, start, end);
    return;
  }
  for (let i = start; i < end; i++) drop[i] = true;
  console.log("drop", start + 1, "->", end, startMarker);
}

// Drop blocks by unique markers (end is exclusive line content start)
// 1) preview constants through getLineAnchorPoint
dropBetween("const MAX_PREVIEW_CORNERS = 450;", "type DiscoveredRover = {");
// 2) types DiscoveredRover through rtkModeFromStatus function end, keep FLOATING later removed
// Find DiscoveredRover to FLOATING_ESTOP
{
  const start = lines.findIndex((l) => l.startsWith("type DiscoveredRover"));
  const end = lines.findIndex((l) => l.startsWith("const FLOATING_ESTOP_SIZE"));
  if (start >= 0 && end >= 0) {
    for (let i = start; i < end; i++) drop[i] = true;
    console.log("drop types", start + 1, end);
  }
}
// 3) FloatingEStop
{
  const start = lines.findIndex((l) => l.startsWith("const FLOATING_ESTOP_SIZE"));
  const end = lines.findIndex((l) => l.startsWith("const BG = "));
  if (start >= 0 && end >= 0) {
    for (let i = start; i < end; i++) drop[i] = true;
    console.log("drop FloatingEStop", start + 1, end);
  }
}
// 4) SOCKET_CONNECT_TIMEOUT_MS line
{
  const i = lines.findIndex((l) => l.includes("SOCKET_CONNECT_TIMEOUT_MS"));
  if (i >= 0) drop[i] = true;
}
// 5) deadband block
{
  const start = lines.findIndex((l) => l.includes("GPS_DEADBAND_DEG"));
  // go up to comment line before GPS if present
  let s = start;
  while (s > 0 && (lines[s - 1].includes("Deadband") || lines[s - 1].includes("sensor-noisy") || lines[s - 1].includes("fields (armed") || lines[s - 1].trim() === "" || lines[s - 1].startsWith("//"))) {
    // only strip comment block immediately above
    if (lines[s - 1].startsWith("//") || lines[s - 1].trim() === "") s--;
    else break;
  }
  // find end of withinDeadband function
  let end = lines.findIndex((l, idx) => idx > start && l.startsWith("const DISCOVERY_PORT"));
  if (start >= 0 && end >= 0) {
    for (let i = s; i < end; i++) drop[i] = true;
    console.log("drop deadband", s + 1, end);
  }
}
// 6) waitForSocketConnect + formatSocketConnectError
{
  const start = lines.findIndex((l) => l.startsWith("function waitForSocketConnect"));
  const end = lines.findIndex((l) => l.startsWith("export default function App"));
  if (start >= 0 && end >= 0) {
    for (let i = start; i < end; i++) drop[i] = true;
    console.log("drop socket helpers", start + 1, end);
  }
}
// 7) ConnectionView through connectionStyles (before LayerRow)
{
  const start = lines.findIndex((l) => l.startsWith("function ConnectionView("));
  const end = lines.findIndex((l) => l.startsWith("function LayerRow("));
  if (start >= 0 && end >= 0) {
    for (let i = start; i < end; i++) drop[i] = true;
    console.log("drop ConnectionView", start + 1, end);
  }
}
// 8) From PreviewViewport / PlanPreview geometry through end of file after AboutPage helpers
// Keep nothing after ActionTile's closing - actually LayerRow and ActionBar still used?
// Grep: LayerRow, ActionBar, InfoRow, ActionTile used in HomeView?
// Safer: drop from `type PreviewViewport` or `function touchDistance` through EOF, but KEEP if LayerRow used in remaining App.

let kept = lines.filter((_, i) => !drop[i]);

// Now drop from type PreviewViewport / function touchDistance to EOF if still present
{
  let start = kept.findIndex((l) => l.startsWith("type PreviewViewport"));
  if (start < 0) start = kept.findIndex((l) => l.startsWith("function touchDistance"));
  // Prefer dropping PlanPreview and everything after ConnectionView leftovers
  const planStart = kept.findIndex((l) => l.startsWith("function PlanPreview("));
  const sprayStart = kept.findIndex((l) => l.startsWith("type SprayParamPayloadValue"));
  const dropFrom = start >= 0 ? start : planStart >= 0 ? planStart : sprayStart;
  if (dropFrom >= 0) {
    console.log("drop tail from", dropFrom + 1, "to EOF", kept.length);
    kept = kept.slice(0, dropFrom);
  }
}

// Also drop LayerRow/ActionBar/InfoRow/ActionTile if present after ConnectionView removal
// They may still be needed - check later. For now leave if before PlanPreview.

let out = kept.join("\n");

// Inject imports after existing authApi import area
const importBlock = `
import { FloatingEStop } from "./src/components/FloatingEStop";
import { PlanPreview } from "./src/components/PlanPreview";
import { ConnectionView } from "./src/features/connection/ConnectionView";
import {
  applyTelemetryPacket,
  clearTelemetryRuntime,
  getTelemetrySnapshot,
  patchTelemetryMissionState,
  setSystemHealth,
  setTelemetrySnapshot,
  useSystemHealth,
  useTelemetrySelector,
  useTelemetrySnapshot,
} from "./src/features/telemetry/telemetryStore";
import type {
  ActivityEntry,
  AppToast,
  DiscoveredRover,
  RTKMode,
  SystemHealth,
  ToastTone,
} from "./src/types/appRuntime";
import {
  formatSocketConnectError,
  SOCKET_CONNECT_TIMEOUT_MS,
  waitForSocketConnect,
} from "./src/utils/socketConnect";
import { rtkModeFromStatus } from "./src/utils/telemetryDeadband";
import {
  SwoziPage,
  StatusPage,
  PositioningPage,
  SettingsPage,
  HowToPage,
  AboutPage,
  linesToDxf,
} from "./src/screens/SecondaryPages";
import { getLineAnchorPoint, isFiniteNumber } from "./src/utils/planPreviewGeometry";
`;

// Insert after `import type { Page, TelemetrySnapshot, LayerVisibility }`
if (!out.includes('from "./src/components/FloatingEStop"')) {
  out = out.replace(
    /import type \{ Page, TelemetrySnapshot, LayerVisibility \} from "\.\/src\/types\/plan";/,
    (m) => m + "\n" + importBlock
  );
}

// Remove type Socket import usage still needed
// Replace useState telemetry with store hooks inside App - done in second pass

fs.writeFileSync(appPath, out.endsWith("\n") ? out : out + "\n");
console.log("App.tsx lines now", out.split("\n").length);
