/**
 * Client-side point CSV parse for Fields "Select File" upload.
 *
 * Mission Select File (.csv) must NOT hit the rover path APIs. Parse on-device
 * and produce local NED + original lat/lon (when present) for map preview.
 *
 * GPS header rules match guide/ref CSV (`parseGuidePointsCsv`) so the same file
 * lands at the same map position in both Upload plan and Import guide CSV.
 *
 * Local metres for GPS rows use the shared WGS84 ellipsoidal projection
 * (`visualAlignment.projectGpsToLocalMeters` / rover `georef.metres_per_degree`).
 */

import { metresPerDegreeShared, projectGpsToLocalMeters } from "./visualAlignment";
import { splitCsvCells } from "./refPointsCsv";
import { buildRoadMarkingPreviewPoints, splitIntoOpenPathGroups } from "./roadMarkingCsvPath";
import type { PlanLine } from "../types/plan";

/** Soft cap for map pin markers (polyline still uses full point set). */
export const LOCAL_CSV_MAX_MAP_PINS = 1000;

/** Re-export of shared WGS84 metres-per-degree (rover georef parity). */
export function metresPerDegree(lat0Deg: number): { mPerDegNorth: number; mPerDegEast: number } {
  return metresPerDegreeShared(lat0Deg);
}

/** Alias of shared ellipsoidal GPS→NED (kept for tests that imported this name). */
export function projectGpsToLocalMetersEllipsoid(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  return projectGpsToLocalMeters(lat, lon, originLat, originLon);
}

const LAT_ALIASES = new Set(["lat", "latitude"]);
const LON_ALIASES = new Set(["lon", "lng", "long", "longitude"]);
/** Explicit NED headers only — not bare n/e/x/y (too easy to steal survey columns). */
const NORTH_ALIASES = new Set(["north", "north_m", "northing"]);
const EAST_ALIASES = new Set(["east", "east_m", "easting"]);
const DWELL_ALIASES = new Set(["dwell_s", "dwell", "dwell_sec"]);
const MARK_ALIASES = new Set(["mark", "is_mark", "spray"]);
/** Survey quality columns (Phase 6) — aliases match rover survey CSV reader. */
const FIX_ALIASES = new Set(["solution status", "solution", "fix", "fix type", "quality"]);
const SAMPLES_ALIASES = new Set(["samples", "epochs"]);
const HRMS_ALIASES = new Set(["lateral rms", "horizontal rms", "hrms"]);
const PDOP_ALIASES = new Set(["pdop"]);

/** Operator threshold for horizontal RMS warning (metres). */
export const SURVEY_HRMS_WARN_M = 0.05;
/**
 * Optional grouping column: multiple independent paths (roundabouts, separate roads) are
 * routinely bundled in one survey export. Without this, every row is treated as one
 * continuous path and the row where one feature ends and the next begins gets bridged with
 * a straight line across the real-world gap between them (see
 * docs/csv-road-marking-workflow.md).
 *
 * Deliberately does NOT include "name" — raw RTK/GNSS survey exports (Emlid Reach, Trimble,
 * Leica, …) routinely have a "Name"/"Point Name" column holding a UNIQUE ID per point, not
 * a shared feature label. Matching on it would split every single point into its own
 * one-point "path" (no line, since a line needs ≥2 points) and silently drop every line —
 * exactly what a real curve_6_points.csv-style file exposed. `hasLowCardinalityGrouping`
 * below is a second, column-name-independent guard against the same class of collision for
 * any of the aliases here.
 */
const GROUP_ALIASES = new Set(["feature", "road", "track", "segment", "route", "path"]);

/**
 * A real feature/road grouping column has a handful of distinct values shared across many
 * rows (e.g. 2 features across 288 points). A per-point ID column (whatever it's called)
 * has close to one distinct value per row. Require an average of at least 2 points per
 * distinct value before trusting a detected column as real grouping — otherwise every group
 * degenerates to size 1, produces no line at all, and silently drops the whole path.
 */
function hasLowCardinalityGrouping(groups: (string | undefined)[]): boolean {
  const values = groups.filter((g): g is string => g != null);
  if (values.length < 2) return false;
  const distinct = new Set(values).size;
  return distinct * 2 <= values.length;
}

export type LocalPointCsvKind = "gps" | "ned";

export type LocalPointCsvPoint = {
  north_m: number;
  east_m: number;
  mark: boolean;
  dwell_s: number | null;
  source_index: number;
  /** Present when source row was GPS. */
  lat?: number;
  lon?: number;
  /** Present when the CSV had a feature/road/name-style grouping column. */
  group?: string;
  /** Optional survey quality (Phase 6) — warn only, never block. */
  fix_status?: string;
  samples?: number;
  hrms_m?: number;
  pdop?: number;
};

export type LocalPointCsvResult = {
  kind: LocalPointCsvKind;
  fileName: string;
  num_points: number;
  points: LocalPointCsvPoint[];
  /** First GPS row; only for kind === "gps". */
  anchor: { lat: number; lon: number } | null;
  point_source_frame: "GPS_SURVEYED" | "LOCAL_NED";
  warnings: string[];
};

export type LocalCsvMapPin = {
  /** Plan north (metres) — used when lat/lon absent. */
  x: number;
  /** Plan east (metres). */
  y: number;
  lat?: number;
  lon?: number;
};

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function nonEmptyLines(text: string): string[] {
  return stripBom(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function looksNumeric(cell: string): boolean {
  if (!cell.trim()) return false;
  const n = Number(cell);
  return Number.isFinite(n);
}

function parseMark(raw: string, rowNum: number): boolean {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "1" || t === "true" || t === "yes" || t === "y") return true;
  if (t === "0" || t === "false" || t === "no" || t === "n") return false;
  throw new Error(`Row ${rowNum}: mark must be true/false or 1/0 (got '${raw}')`);
}

function parseOptionalDwell(raw: string | undefined, rowNum: number): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Row ${rowNum}: dwell_s must be a non-negative number`);
  }
  return n;
}

type ColMap = {
  kind: LocalPointCsvKind;
  latIdx?: number;
  lonIdx?: number;
  northIdx?: number;
  eastIdx?: number;
  dwellIdx?: number;
  markIdx?: number;
  groupIdx?: number;
  fixIdx?: number;
  samplesIdx?: number;
  hrmsIdx?: number;
  pdopIdx?: number;
};

function qualityIndices(find: (aliases: Set<string>) => number): Pick<
  ColMap,
  "fixIdx" | "samplesIdx" | "hrmsIdx" | "pdopIdx"
> {
  const fixIdx = find(FIX_ALIASES);
  const samplesIdx = find(SAMPLES_ALIASES);
  const hrmsIdx = find(HRMS_ALIASES);
  const pdopIdx = find(PDOP_ALIASES);
  return {
    fixIdx: fixIdx >= 0 ? fixIdx : undefined,
    samplesIdx: samplesIdx >= 0 ? samplesIdx : undefined,
    hrmsIdx: hrmsIdx >= 0 ? hrmsIdx : undefined,
    pdopIdx: pdopIdx >= 0 ? pdopIdx : undefined,
  };
}

function resolveHeader(cells: string[]): ColMap | null {
  const lower = cells.map((c) => c.trim().toLowerCase());
  const find = (aliases: Set<string>) => lower.findIndex((c) => aliases.has(c));

  // Prefer GPS (same as guide CSV) so multi-column survey exports with Lat/Lon work.
  const latIdx = find(LAT_ALIASES);
  const lonIdx = find(LON_ALIASES);
  if (latIdx >= 0 && lonIdx >= 0) {
    const dwellIdx = find(DWELL_ALIASES);
    const markIdx = find(MARK_ALIASES);
    const groupIdx = find(GROUP_ALIASES);
    return {
      kind: "gps",
      latIdx,
      lonIdx,
      dwellIdx: dwellIdx >= 0 ? dwellIdx : undefined,
      markIdx: markIdx >= 0 ? markIdx : undefined,
      groupIdx: groupIdx >= 0 ? groupIdx : undefined,
      ...qualityIndices(find),
    };
  }

  const northIdx = find(NORTH_ALIASES);
  const eastIdx = find(EAST_ALIASES);
  if (northIdx >= 0 && eastIdx >= 0) {
    const dwellIdx = find(DWELL_ALIASES);
    const markIdx = find(MARK_ALIASES);
    const groupIdx = find(GROUP_ALIASES);
    return {
      kind: "ned",
      northIdx,
      eastIdx,
      dwellIdx: dwellIdx >= 0 ? dwellIdx : undefined,
      markIdx: markIdx >= 0 ? markIdx : undefined,
      groupIdx: groupIdx >= 0 ? groupIdx : undefined,
      ...qualityIndices(find),
    };
  }

  return null;
}

function readOptionalQuality(
  cells: string[],
  colMap: ColMap
): Pick<LocalPointCsvPoint, "fix_status" | "samples" | "hrms_m" | "pdop"> {
  const out: Pick<LocalPointCsvPoint, "fix_status" | "samples" | "hrms_m" | "pdop"> = {};
  if (colMap.fixIdx != null && cells[colMap.fixIdx] != null && cells[colMap.fixIdx].trim() !== "") {
    out.fix_status = cells[colMap.fixIdx].trim();
  }
  if (colMap.samplesIdx != null && cells[colMap.samplesIdx] != null && cells[colMap.samplesIdx].trim() !== "") {
    const n = Number(cells[colMap.samplesIdx]);
    if (Number.isFinite(n)) out.samples = n;
  }
  if (colMap.hrmsIdx != null && cells[colMap.hrmsIdx] != null && cells[colMap.hrmsIdx].trim() !== "") {
    const n = Number(cells[colMap.hrmsIdx]);
    if (Number.isFinite(n)) out.hrms_m = n;
  }
  if (colMap.pdopIdx != null && cells[colMap.pdopIdx] != null && cells[colMap.pdopIdx].trim() !== "") {
    const n = Number(cells[colMap.pdopIdx]);
    if (Number.isFinite(n)) out.pdop = n;
  }
  return out;
}

/**
 * Survey quality warnings (Phase 6). Warn only — matches rover behaviour; never blocks parse.
 */
export function collectSurveyQualityWarnings(
  points: LocalPointCsvPoint[],
  hrmsWarnM: number = SURVEY_HRMS_WARN_M
): string[] {
  const warnings: string[] = [];
  let nonFix = 0;
  let singleEpoch = 0;
  let highHrms = 0;
  let worstHrms = 0;
  let maxPdop: number | null = null;

  for (const p of points) {
    if (p.fix_status != null) {
      const s = p.fix_status.trim().toUpperCase();
      if (s !== "FIX" && s !== "4" && s !== "RTK_FIXED" && s !== "RTK FIXED") {
        nonFix += 1;
      }
    }
    if (p.samples != null && p.samples <= 1) singleEpoch += 1;
    if (p.hrms_m != null && p.hrms_m > hrmsWarnM) {
      highHrms += 1;
      worstHrms = Math.max(worstHrms, p.hrms_m);
    }
    if (p.pdop != null && Number.isFinite(p.pdop)) {
      maxPdop = maxPdop == null ? p.pdop : Math.max(maxPdop, p.pdop);
    }
  }

  if (nonFix > 0) {
    warnings.push(
      `${nonFix} survey point${nonFix === 1 ? "" : "s"} without FIX solution — position may be less reliable.`
    );
  }
  if (singleEpoch > 0) {
    warnings.push(
      `${singleEpoch} point${singleEpoch === 1 ? "" : "s"} with ≤1 average sample/epoch — consider re-averaging.`
    );
  }
  if (highHrms > 0) {
    warnings.push(
      `${highHrms} point${highHrms === 1 ? "" : "s"} with horizontal RMS > ${hrmsWarnM} m (worst ${worstHrms.toFixed(3)} m).`
    );
  }
  if (maxPdop != null) {
    warnings.push(`Survey PDOP (max): ${maxPdop.toFixed(2)}.`);
  }
  return warnings;
}

/**
 * Headerless rows: treat as lat,lon (matches guide/ref CSV), not NED metres.
 * Optional 3rd/4th columns: dwell_s[, mark].
 */
function headerlessGpsMap(firstRow: string[]): ColMap | null {
  if (firstRow.length < 2) return null;
  if (!looksNumeric(firstRow[0]) || !looksNumeric(firstRow[1])) return null;
  const lat = Number(firstRow[0]);
  const lon = Number(firstRow[1]);
  // Guard: pure NED metre files that are clearly not geographic (e.g. 0,0 / 5,1)
  // still parse as GPS if values fit lat/lon range — operators with headerless
  // lat,lon (the common survey drop) must win; headered north,east is the NED path.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    kind: "gps",
    latIdx: 0,
    lonIdx: 1,
    dwellIdx: firstRow.length >= 3 ? 2 : undefined,
    markIdx: firstRow.length >= 4 ? 3 : undefined,
  };
}

/**
 * Parse a point CSV entirely on-device.
 * @throws Error with a human-readable message when the file cannot be used.
 */
export function parseLocalPointCsv(text: string, fileName = "points.csv"): LocalPointCsvResult {
  const lines = nonEmptyLines(text);
  if (lines.length === 0) {
    throw new Error("The CSV file is empty.");
  }

  const firstCells = splitCsvCells(lines[0]);
  let colMap = resolveHeader(firstCells);
  let dataStart = 0;

  if (colMap) {
    dataStart = 1;
  } else {
    colMap = headerlessGpsMap(firstCells);
    if (!colMap) {
      throw new Error(
        "Unrecognized CSV. Expected lat/lon (or latitude/longitude) columns " +
          "(same as guide CSV), north/east headers, or headerless lat,lon rows."
      );
    }
    dataStart = 0;
  }

  const warnings: string[] = [];
  const rawGps: {
    lat: number;
    lon: number;
    mark: boolean;
    dwell_s: number | null;
    source_index: number;
    group?: string;
    fix_status?: string;
    samples?: number;
    hrms_m?: number;
    pdop?: number;
  }[] = [];
  const rawNed: LocalPointCsvPoint[] = [];

  for (let i = dataStart; i < lines.length; i++) {
    const rowNum = i + 1;
    const cells = splitCsvCells(lines[i]);
    if (cells.every((c) => c === "")) continue;

    try {
      const group =
        colMap.groupIdx != null && cells[colMap.groupIdx] != null && cells[colMap.groupIdx].trim() !== ""
          ? cells[colMap.groupIdx].trim()
          : undefined;
      const quality = readOptionalQuality(cells, colMap);

      if (colMap.kind === "gps") {
        const lat = Number(cells[colMap.latIdx!]);
        const lon = Number(cells[colMap.lonIdx!]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error(`Row ${rowNum}: latitude/longitude must be numeric`);
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          throw new Error(`Row ${rowNum}: latitude/longitude out of range`);
        }
        const mark =
          colMap.markIdx != null && cells[colMap.markIdx] != null
            ? parseMark(cells[colMap.markIdx], rowNum)
            : true;
        const dwell_s =
          colMap.dwellIdx != null ? parseOptionalDwell(cells[colMap.dwellIdx], rowNum) : null;
        rawGps.push({ lat, lon, mark, dwell_s, source_index: rowNum, group, ...quality });
      } else {
        const north = Number(cells[colMap.northIdx!]);
        const east = Number(cells[colMap.eastIdx!]);
        if (!Number.isFinite(north) || !Number.isFinite(east)) {
          throw new Error(`Row ${rowNum}: north/east must be numeric`);
        }
        const mark =
          colMap.markIdx != null && cells[colMap.markIdx] != null
            ? parseMark(cells[colMap.markIdx], rowNum)
            : true;
        const dwell_s =
          colMap.dwellIdx != null ? parseOptionalDwell(cells[colMap.dwellIdx], rowNum) : null;
        rawNed.push({
          north_m: north,
          east_m: east,
          mark,
          dwell_s,
          source_index: rowNum,
          group,
          ...quality,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cap warning list so a 5k-row bad file cannot explode memory.
      if (warnings.length < 50) warnings.push(msg);
      else if (warnings.length === 50) warnings.push("…further row errors omitted");
    }
  }

  if (colMap.kind === "gps") {
    if (rawGps.length === 0) {
      throw new Error(
        warnings.length
          ? `No valid GPS points. ${warnings[0]}`
          : "No valid GPS points found in the CSV."
      );
    }
    const anchor = { lat: rawGps[0].lat, lon: rawGps[0].lon };
    const groupingValid = hasLowCardinalityGrouping(rawGps.map((row) => row.group));
    const points: LocalPointCsvPoint[] = rawGps.map((row) => {
      const { north, east } = projectGpsToLocalMeters(row.lat, row.lon, anchor.lat, anchor.lon);
      return {
        north_m: north,
        east_m: east,
        mark: row.mark,
        dwell_s: row.dwell_s,
        source_index: row.source_index,
        lat: row.lat,
        lon: row.lon,
        group: groupingValid ? row.group : undefined,
        fix_status: row.fix_status,
        samples: row.samples,
        hrms_m: row.hrms_m,
        pdop: row.pdop,
      };
    });
    warnings.push(...collectSurveyQualityWarnings(points));
    return {
      kind: "gps",
      fileName,
      num_points: points.length,
      points,
      anchor,
      point_source_frame: "GPS_SURVEYED",
      warnings,
    };
  }

  if (rawNed.length === 0) {
    throw new Error(
      warnings.length
        ? `No valid NED points. ${warnings[0]}`
        : "No valid north/east points found in the CSV."
    );
  }

  const nedGroupingValid = hasLowCardinalityGrouping(rawNed.map((row) => row.group));
  const nedPoints = nedGroupingValid ? rawNed : rawNed.map((row) => ({ ...row, group: undefined }));
  warnings.push(...collectSurveyQualityWarnings(nedPoints));

  return {
    kind: "ned",
    fileName,
    num_points: nedPoints.length,
    points: nedPoints,
    anchor: null,
    point_source_frame: "LOCAL_NED",
    warnings,
  };
}

/** Evenly sample indices so large CSVs still get representative map pins. */
export function sampleEvenly<T>(items: T[], maxCount: number): T[] {
  if (maxCount <= 0 || items.length === 0) return [];
  if (items.length <= maxCount) return items.slice();
  if (maxCount === 1) return [items[0]];
  const out: T[] = [];
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round((i * (items.length - 1)) / (maxCount - 1));
    out.push(items[idx]);
  }
  return out;
}

type RawNedPoint = { north: number; east: number };

function planLineIdForGroup(pathIndex: number): string {
  // pathIndex 1 keeps the exact legacy id — MapViewNative and App.tsx both special-case
  // the literal string "local-csv-path" (in addition to the general road_marking flag), and
  // App.tsx's setSelectedLineId(previewLines[0]?.id) selects whichever line is first.
  return pathIndex === 1 ? "local-csv-path" : `local-csv-path-${pathIndex}`;
}

function planLineLabelForGroup(pathIndex: number, groupCount: number, groupLabel: string | undefined, pointCount: number): string {
  if (groupLabel) return `${groupLabel} (${pointCount} pts)`;
  return groupCount > 1 ? `CSV path ${pathIndex} (${pointCount} pts)` : `CSV path (${pointCount} pts)`;
}

/** Build one open road-marking PlanLine for a single already-split group of points. */
function buildPlanLineForGroup(
  rawNed: RawNedPoint[],
  sourcePointCount: number,
  pathIndex: number,
  groupCount: number,
  groupLabel: string | undefined
): PlanLine | null {
  const id = planLineIdForGroup(pathIndex);
  const label = planLineLabelForGroup(pathIndex, groupCount, groupLabel, sourcePointCount);
  const preview_points = buildRoadMarkingPreviewPoints(rawNed);

  if (preview_points.length < 2) {
    // Degenerate after open/dedupe — fall back to raw open chain (still not a polygon).
    const fallback =
      rawNed.length >= 2
        ? rawNed[0].north === rawNed[rawNed.length - 1].north &&
          rawNed[0].east === rawNed[rawNed.length - 1].east
          ? rawNed.slice(0, -1)
          : rawNed
        : rawNed;
    if (fallback.length < 2) return null;
    const first = fallback[0];
    const last = fallback[fallback.length - 1];
    return {
      id,
      label,
      layer: "marking",
      from: { id: 1, x: first.north, y: first.east },
      to: { id: 2, x: last.north, y: last.east },
      width: 0.1,
      is_mark: true,
      entity: {
        entity_id: id,
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0,
        geometry: {
          closed: false,
          road_marking: true,
          vertexCount: fallback.length,
        },
        preview_points: fallback,
      },
    };
  }

  const first = preview_points[0];
  const last = preview_points[preview_points.length - 1];

  return {
    id,
    label,
    layer: "marking",
    from: { id: 1, x: first.north, y: first.east },
    to: { id: 2, x: last.north, y: last.east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: {
        closed: false,
        /** Road-marking preview: open stroke only (never a polygon ring). */
        road_marking: true,
        vertexCount: preview_points.length,
        source_vertex_count: sourcePointCount,
      },
      preview_points,
    },
  };
}

/**
 * One or more connected OPEN road-marking paths for Mapbox preview — one per detected
 * feature/road (see `splitIntoOpenPathGroups`: an explicit "feature"/"road"-style CSV
 * column, or an abnormally large jump when no such column exists, both start a new path so
 * unrelated features are never bridged with a straight line across the real-world gap
 * between them).
 *
 * Survey points are refined into straights + circular-arc curves only
 * (Hyper fit, segment-then geometric joint fillets; never a closed ring).
 * Pin markers still use the raw CSV points via `localCsvToMapPins`.
 */
export function localCsvPointsToPlanLines(points: LocalPointCsvPoint[]): PlanLine[] {
  if (points.length === 0) return [];

  const rawNed: RawNedPoint[] = points.map((p) => ({
    north: p.north_m,
    east: p.east_m,
  }));
  const groupKeys = points.some((p) => p.group != null) ? points.map((p) => p.group) : undefined;
  const groups = splitIntoOpenPathGroups(rawNed, groupKeys);

  const lines: PlanLine[] = [];
  let cursor = 0;
  let pathIndex = 0;
  for (const group of groups) {
    const groupSourcePoints = points.slice(cursor, cursor + group.length);
    cursor += group.length;
    if (group.length === 0) continue;
    pathIndex++;
    const groupLabel = groupSourcePoints.every((p) => p.group && p.group === groupSourcePoints[0].group)
      ? groupSourcePoints[0].group
      : undefined;
    const line = buildPlanLineForGroup(group, group.length, pathIndex, groups.length, groupLabel);
    if (line) lines.push(line);
  }
  return lines;
}

function csvTransitLineId(i: number): string {
  return `local-csv-transit-${i}`;
}

/** Below this gap (m), two consecutive group paths already touch — no connector needed. */
const CSV_TRANSIT_MIN_GAP_M = 0.02;

/**
 * Straight, unsmoothed "transit" connector lines between consecutive CSV group paths —
 * mirrors the backend's plan-time TRANSIT connector convention (path_engine's
 * `_insert_transit_connectors_between_segments`, already exposed to the DXF upload flow via
 * `buildRuntimeTransitOverlayFromPlan` / the `transit_preview` fallback in App.tsx): FROM =
 * end of one marking path, TO = start of the next, in file order (CSV has no TSP route
 * optimizer to reorder groups). Never smoothed/curve-fit — matches the backend's rule that
 * corner smoothing only ever applies to MARK geometry, never to transit/dead-heading legs.
 *
 * `layer: "transit"` already gets full generic treatment everywhere else in this app (map
 * color, exclusion from length labels / snap points / resize handles / primary-editable
 * classification, its own Path Order row kind) — no further wiring needed beyond appending
 * these to the line list the CSV flow already builds.
 */
export function buildCsvTransitLines(planLines: PlanLine[]): PlanLine[] {
  const transitLines: PlanLine[] = [];
  for (let i = 0; i < planLines.length - 1; i++) {
    const from = planLines[i].to;
    const to = planLines[i + 1].from;
    if (
      from == null ||
      to == null ||
      !Number.isFinite(from.x) ||
      !Number.isFinite(from.y) ||
      !Number.isFinite(to.x) ||
      !Number.isFinite(to.y)
    ) {
      continue;
    }
    const length_m = Math.hypot(to.x - from.x, to.y - from.y);
    if (length_m < CSV_TRANSIT_MIN_GAP_M) continue;

    const id = csvTransitLineId(i + 1);
    transitLines.push({
      id,
      label: `Transit: ${planLines[i].label} → ${planLines[i + 1].label}`,
      layer: "transit",
      segmentRole: "none",
      from: { id: i * 2 + 1, x: from.x, y: from.y },
      to: { id: i * 2 + 2, x: to.x, y: to.y },
      width: 0.1,
      entity: {
        entity_id: id,
        entity_type: "TRANSIT",
        layer: "TRANSIT",
        color: 0,
        is_mark: false,
        length_m,
        geometry: {},
        preview_points: [
          { north: from.x, east: from.y },
          { north: to.x, east: to.y },
        ],
      },
    });
  }
  return transitLines;
}

/**
 * Map pins in the same shape as guide/ref selectedPoints.
 * GPS rows include lat/lon so MapView draws them directly (no plan-origin reproject).
 */
export function localCsvToMapPins(
  result: LocalPointCsvResult,
  maxPins = LOCAL_CSV_MAX_MAP_PINS
): LocalCsvMapPin[] {
  const sampled = sampleEvenly(result.points, maxPins);
  return sampled.map((p) => {
    const pin: LocalCsvMapPin = { x: p.north_m, y: p.east_m };
    if (p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      pin.lat = p.lat;
      pin.lon = p.lon;
    }
    return pin;
  });
}
