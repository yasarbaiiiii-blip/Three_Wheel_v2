/**
 * Client-side point CSV parse for Fields "Select File" upload.
 *
 * Mission Select File (.csv) must NOT hit the rover path APIs. Parse on-device
 * and produce local NED + original lat/lon (when present) for map preview.
 *
 * GPS header rules match guide/ref CSV (`parseGuidePointsCsv`) so the same file
 * lands at the same map position in both Upload plan and Import guide CSV.
 *
 * Local metres for GPS rows use the shared PX4-sphere projection
 * (`geoProjection.projectGpsToLocalMeters` / rover `georef.metres_per_degree`).
 *
 * On the earth model: these metres are sent to `POST /api/path/plan-trajectory`, which uses
 * them VERBATIM as PX4 local NED anchored at `origin_gps` — the rover never re-projects them.
 * PX4 defines that frame on a sphere of R = 6 371 000 m (geo.cpp CONSTANTS_RADIUS_OF_EARTH),
 * so that is the only scale under which the rover lands on the surveyed lat/lon. See
 * `path_engine/parsers/georef.py::metres_per_degree`, which records the 2026-07-25 field
 * measurement: the WGS84 meridional radius is true-to-ground but 0.52 % short *in the frame
 * the EKF navigates*, seen as a −0.51 cm-per-metre-north placement walk at 13 °N.
 */

import { metresPerDegreePx4, projectGpsToLocalMeters } from "./geoProjection";
import { MARK_CONTIGUOUS_GAP_M } from "./missionTrajectory";
import { splitCsvCells } from "./refPointsCsv";
import {
  buildRoadMarkingFittedPath,
  polylineLengthM,
  splitIntoOpenPathGroups,
} from "./roadMarkingCsvPath";
import type { PlanLine } from "../types/plan";

/** NED metres larger than this are almost certainly projected CRS, not local site metres. */
export const PROJECTED_COORD_BLOCK_M = 10_000;

/** Soft cap for map pin markers (polyline still uses full point set). */
export const LOCAL_CSV_MAX_MAP_PINS = 1000;

/** Re-export of shared PX4-sphere metres-per-degree (rover georef parity). */
export function metresPerDegree(lat0Deg: number): { mPerDegNorth: number; mPerDegEast: number } {
  return metresPerDegreePx4(lat0Deg);
}

/**
 * @deprecated Misleading name — this has never been ellipsoidal since the move to the shared
 * PX4-sphere projection. Import `projectGpsToLocalMeters` from `./geoProjection` instead.
 * Kept only so existing callers/tests keep compiling.
 */
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

/**
 * Non-empty lines, with a LEADING comment block stripped.
 *
 * `#` is only a comment marker before the header. Applying it to the whole file
 * deleted data rows: Emlid `Name` is operator-typed, so points named `#1`, `#3`
 * vanished with an empty `warnings` array while `#`-free rows loaded normally.
 * Anything at or after the first non-comment line is kept — a stray `#` line there
 * now reaches the row parser and is rejected loudly instead of disappearing.
 */
function nonEmptyLines(text: string): string[] {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  let start = 0;
  while (start < lines.length && lines[start].startsWith("#")) start++;
  return lines.slice(start);
}

function looksNumeric(cell: string): boolean {
  if (!cell.trim()) return false;
  const n = Number(cell.replace(",", "."));
  return Number.isFinite(n);
}

/** Detect `,` / `;` / tab from the first non-empty line (European Excel often uses `;`). */
export function detectCsvDelimiter(line: string): "," | ";" | "\t" {
  let inQuotes = false;
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === ",") commas += 1;
    else if (ch === ";") semis += 1;
    else if (ch === "\t") tabs += 1;
  }
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/** Split one CSV line with the given delimiter (quoted fields supported). */
export function splitDelimitedCells(line: string, delimiter: "," | ";" | "\t" = ","): string[] {
  if (delimiter === ",") return splitCsvCells(line);
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  // Decimal-comma: when delimiter is `;`, numeric cells may use `,` as decimal.
  return cells.map((cell) => {
    const t = cell.trim();
    if (delimiter === ";" && /^-?\d+,\d+$/.test(t)) return t.replace(",", ".");
    return t;
  });
}

function parseFiniteNumber(raw: string, rowNum: number, label: string): number {
  const trimmed = String(raw).trim();
  // `Number("")` is 0 and passes Number.isFinite, so a blank cell used to parse as a
  // coordinate of zero. An Emlid export in a projected CS has Easting/Northing filled
  // and Latitude/Longitude blank; that file resolved as GPS (the headers exist), every
  // point collapsed onto lat 0 / lon 0, and the warnings were identical to a good file.
  if (trimmed === "") {
    throw new Error(`Row ${rowNum}: ${label} is empty`);
  }
  const n = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(n)) {
    throw new Error(`Row ${rowNum}: ${label} must be numeric`);
  }
  return n;
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
 * Pick a robust GPS anchor: median of the densest spatial cluster, not blindly row 1
 * (a garbage first row used to throw every real point thousands of km away).
 */
function robustGpsAnchor(
  rows: { lat: number; lon: number }[]
): { lat: number; lon: number; outlierCount: number } {
  if (rows.length === 1) return { lat: rows[0].lat, lon: rows[0].lon, outlierCount: 0 };
  // Score each candidate by how many points lie within ~2 km (approx deg).
  const radiusDeg = 2 / 111; // ~2 km
  let bestIdx = 0;
  let bestCount = 0;
  for (let i = 0; i < rows.length; i++) {
    let c = 0;
    for (let j = 0; j < rows.length; j++) {
      const dlat = rows[i].lat - rows[j].lat;
      const dlon = rows[i].lon - rows[j].lon;
      if (dlat * dlat + dlon * dlon <= radiusDeg * radiusDeg) c += 1;
    }
    if (c > bestCount) {
      bestCount = c;
      bestIdx = i;
    }
  }
  const cluster = rows.filter((r) => {
    const dlat = r.lat - rows[bestIdx].lat;
    const dlon = r.lon - rows[bestIdx].lon;
    return dlat * dlat + dlon * dlon <= radiusDeg * radiusDeg;
  });
  const lats = cluster.map((r) => r.lat).sort((a, b) => a - b);
  const lons = cluster.map((r) => r.lon).sort((a, b) => a - b);
  const mid = Math.floor(cluster.length / 2);
  return {
    lat: lats[mid],
    lon: lons[mid],
    outlierCount: rows.length - cluster.length,
  };
}

/** Row-order sanity: source polyline vs nearest-neighbour tour (large ratio ⇒ jumbled order). */
function rowOrderSanityWarning(points: { north_m: number; east_m: number }[]): string | null {
  if (points.length < 6) return null;
  let pathLen = 0;
  for (let i = 1; i < points.length; i++) {
    pathLen += Math.hypot(
      points[i].north_m - points[i - 1].north_m,
      points[i].east_m - points[i - 1].east_m
    );
  }
  // Greedy NN tour length from first point (cheap upper-bound proxy for "drive order").
  const remaining = new Set(Array.from({ length: points.length }, (_, i) => i));
  let cur = 0;
  remaining.delete(0);
  let nnLen = 0;
  while (remaining.size > 0) {
    let best = -1;
    let bestD = Infinity;
    for (const j of remaining) {
      const d = Math.hypot(points[j].north_m - points[cur].north_m, points[j].east_m - points[cur].east_m);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    nnLen += bestD;
    remaining.delete(best);
    cur = best;
  }
  if (nnLen > 1e-6 && pathLen > 2.5 * nnLen) {
    return (
      `Row order looks jumbled: file-order path is ${(pathLen / nnLen).toFixed(1)}× a nearest-neighbour tour. ` +
      `Check point order before painting (order is never auto-rewritten).`
    );
  }
  return null;
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

  const delimiter = detectCsvDelimiter(lines[0]);
  const firstCells = splitDelimitedCells(lines[0], delimiter);
  let colMap = resolveHeader(firstCells);
  let dataStart = 0;
  let headerless = false;

  if (colMap) {
    dataStart = 1;
  } else {
    colMap = headerlessGpsMap(firstCells);
    if (!colMap) {
      throw new Error(
        "Unrecognized CSV. Expected lat/lon (or latitude/longitude) columns " +
          "(same as guide CSV), north/east headers, or headerless lat,lon rows. " +
          "Also accepts semicolon- or tab-delimited exports."
      );
    }
    dataStart = 0;
    headerless = true;
  }

  const warnings: string[] = [];
  if (delimiter !== ",") {
    warnings.push(`Detected ${delimiter === "\t" ? "tab" : "semicolon"}-delimited CSV.`);
  }

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
    const cells = splitDelimitedCells(lines[i], delimiter);
    if (cells.every((c) => c === "")) continue;

    try {
      const group =
        colMap.groupIdx != null && cells[colMap.groupIdx] != null && cells[colMap.groupIdx].trim() !== ""
          ? cells[colMap.groupIdx].trim()
          : undefined;
      const quality = readOptionalQuality(cells, colMap);

      if (colMap.kind === "gps") {
        const lat = parseFiniteNumber(cells[colMap.latIdx!] ?? "", rowNum, "latitude");
        const lon = parseFiniteNumber(cells[colMap.lonIdx!] ?? "", rowNum, "longitude");
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
        const north = parseFiniteNumber(cells[colMap.northIdx!] ?? "", rowNum, "north");
        const east = parseFiniteNumber(cells[colMap.eastIdx!] ?? "", rowNum, "east");
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

    // Headerless near Null Island with tiny "lat/lon" that are really local metres.
    if (headerless) {
      const maxAbs = Math.max(...rawGps.flatMap((r) => [Math.abs(r.lat), Math.abs(r.lon)]));
      const spanLat = Math.max(...rawGps.map((r) => r.lat)) - Math.min(...rawGps.map((r) => r.lat));
      const spanLon = Math.max(...rawGps.map((r) => r.lon)) - Math.min(...rawGps.map((r) => r.lon));
      if (maxAbs < 1 && (spanLat > 0.01 || spanLon > 0.01)) {
        // ~1 km+ span near 0,0 from values that look like metres misread as degrees.
        const approxM = Math.hypot(spanLat * 111_000, spanLon * 111_000);
        warnings.push(
          `Headerless file read as lat/lon near 0°N 0°E (~${approxM.toFixed(0)} m across). ` +
            `If these are local metres, add a north,east header — do not paint until confirmed.`
        );
      } else {
        warnings.push(
          `Headerless CSV interpreted as lat/lon (${rawGps.length} points near ${rawGps[0].lat.toFixed(4)}°, ${rawGps[0].lon.toFixed(4)}°). Confirm this is correct.`
        );
      }
    }

    // Lat/lon swap heuristic: if swapping both columns lands every row in-range and
    // shrinks the geographic span dramatically when current span is absurd, warn.
    {
      const spanLat = Math.max(...rawGps.map((r) => r.lat)) - Math.min(...rawGps.map((r) => r.lat));
      const spanLon = Math.max(...rawGps.map((r) => r.lon)) - Math.min(...rawGps.map((r) => r.lon));
      const swappedOk = rawGps.every(
        (r) => r.lon >= -90 && r.lon <= 90 && r.lat >= -180 && r.lat <= 180
      );
      // Typical swap: lon in lat column (~80) and lat in lon (~13) still both "in range".
      if (swappedOk && spanLat > 5 && spanLon < 2) {
        warnings.push(
          "Latitude span is very large compared to longitude — columns may be swapped (lon,lat). Verify before painting."
        );
      }
    }

    // Prefer first-row origin (historical / rover parity) unless row 1 is an outlier
    // relative to the densest cluster — then re-anchor so one garbage row cannot
    // throw the whole survey thousands of km away.
    const cluster = robustGpsAnchor(rawGps);
    const first = rawGps[0];
    const firstIsOutlier = (() => {
      const dlat = first.lat - cluster.lat;
      const dlon = first.lon - cluster.lon;
      const radiusDeg = 2 / 111;
      return dlat * dlat + dlon * dlon > radiusDeg * radiusDeg;
    })();
    const anchor = firstIsOutlier
      ? { lat: cluster.lat, lon: cluster.lon }
      : { lat: first.lat, lon: first.lon };
    if (firstIsOutlier || cluster.outlierCount > 0) {
      warnings.push(
        firstIsOutlier
          ? `First GPS row is far from the main cluster — origin set to cluster median (${cluster.outlierCount} outlier row(s)).`
          : `${cluster.outlierCount} GPS row(s) lie far from the main cluster (origin remains first in-cluster row).`
      );
    }
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
    const orderWarn = rowOrderSanityWarning(points);
    if (orderWarn) warnings.push(orderWarn);
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

  // Block silent UTM/state-plane values parsed as local site metres.
  const maxAbsNed = Math.max(...rawNed.flatMap((p) => [Math.abs(p.north_m), Math.abs(p.east_m)]));
  if (maxAbsNed > PROJECTED_COORD_BLOCK_M) {
    throw new Error(
      `Coordinates look like a projected CRS (values up to ${maxAbsNed.toFixed(0)} m), not local site metres. ` +
        `Export lat/lon, or subtract a site origin so north/east are local metres within ~${PROJECTED_COORD_BLOCK_M / 1000} km of zero.`
    );
  }

  const nedGroupingValid = hasLowCardinalityGrouping(rawNed.map((row) => row.group));
  const nedPoints = nedGroupingValid ? rawNed : rawNed.map((row) => ({ ...row, group: undefined }));
  warnings.push(...collectSurveyQualityWarnings(nedPoints));
  const orderWarn = rowOrderSanityWarning(nedPoints);
  if (orderWarn) warnings.push(orderWarn);

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

/** Stem of a file name for path-group labels when merging multi-file imports. */
function fileStem(fileName: string): string {
  const base = (fileName || "").split(/[\\/]/).pop() || "file";
  return base.replace(/\.[^.]+$/, "") || base;
}

/**
 * Combined display / upload name for multi-file Select File imports.
 * Single file keeps its original name; multiple becomes `first_xN.ext`.
 */
export function combinedImportFileName(fileNames: string[], ext: string): string {
  if (fileNames.length === 0) return `combined.${ext}`;
  if (fileNames.length === 1) return fileNames[0];
  const stem = fileStem(fileNames[0]);
  return `${stem}_x${fileNames.length}.${ext}`;
}

/**
 * Tag every point so each source file (and its own feature groups) stay separate
 * open paths after {@link localCsvPointsToPlanLines} / jump-split.
 */
function tagPointsWithFileGroup(
  points: LocalPointCsvPoint[],
  fileName: string
): LocalPointCsvPoint[] {
  const stem = fileStem(fileName);
  return points.map((p) => ({
    ...p,
    group: p.group ? `${stem}/${p.group}` : stem,
  }));
}

/**
 * Re-project GPS points so NED metres share a single anchor (first file's origin).
 * Lat/lon on each point are preserved for map pins.
 */
function reprojectCsvPointsToAnchor(
  points: LocalPointCsvPoint[],
  anchor: { lat: number; lon: number }
): LocalPointCsvPoint[] {
  return points.map((p) => {
    if (p.lat == null || p.lon == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      return p;
    }
    const { north, east } = projectGpsToLocalMeters(p.lat, p.lon, anchor.lat, anchor.lon);
    return { ...p, north_m: north, east_m: east };
  });
}

/**
 * Merge several already-parsed mission CSVs into one plan (multi-file Select File).
 *
 * Rules:
 * - All files must share the same kind (GPS or NED).
 * - GPS: first non-null anchor wins; every file is re-projected into that frame.
 * - NED: points are concatenated as-is (same local site metres assumed).
 * - Each source file is tagged as its own path group so features never bridge
 *   across file boundaries.
 */
export function mergeLocalPointCsvResults(
  results: LocalPointCsvResult[]
): LocalPointCsvResult {
  if (results.length === 0) {
    throw new Error("No CSV files to merge.");
  }
  if (results.length === 1) return results[0];

  const kind = results[0].kind;
  for (const r of results) {
    if (r.kind !== kind) {
      throw new Error(
        `Cannot mix GPS and local NED CSVs in one import (${results[0].fileName} is ${kind.toUpperCase()}, ${r.fileName} is ${r.kind.toUpperCase()}).`
      );
    }
  }

  const warnings: string[] = [
    `Merged ${results.length} CSV files into one plan.`,
  ];
  const allPoints: LocalPointCsvPoint[] = [];
  let sourceIndex = 1;

  if (kind === "gps") {
    const anchor =
      results.find((r) => r.anchor != null)?.anchor ?? null;
    if (!anchor) {
      throw new Error("No GPS anchor found in the selected CSV files.");
    }

    for (const r of results) {
      warnings.push(...r.warnings.map((w) => `${r.fileName}: ${w}`));
      const reprojected = reprojectCsvPointsToAnchor(r.points, anchor);
      const tagged = tagPointsWithFileGroup(reprojected, r.fileName);
      for (const p of tagged) {
        allPoints.push({ ...p, source_index: sourceIndex++ });
      }
    }

    return {
      kind: "gps",
      fileName: combinedImportFileName(
        results.map((r) => r.fileName),
        "csv"
      ),
      num_points: allPoints.length,
      points: allPoints,
      anchor,
      point_source_frame: "GPS_SURVEYED",
      warnings,
    };
  }

  // NED — same local frame assumed across files.
  for (const r of results) {
    warnings.push(...r.warnings.map((w) => `${r.fileName}: ${w}`));
    const tagged = tagPointsWithFileGroup(r.points, r.fileName);
    for (const p of tagged) {
      allPoints.push({ ...p, source_index: sourceIndex++ });
    }
  }

  return {
    kind: "ned",
    fileName: combinedImportFileName(
      results.map((r) => r.fileName),
      "csv"
    ),
    num_points: allPoints.length,
    points: allPoints,
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

function measurePreviewLengthM(pts: { north: number; east: number }[]): number {
  return polylineLengthM(pts);
}

/**
 * Worst (largest) reported horizontal RMS across a group's source points, for
 * {@link sparseArcResidualGateM} — the residual gate is a MAX over the group's points, so it
 * should be judged against the noisiest point in that same group, not an average that a single
 * bad fix could hide. Returns null when no point in the group reports a usable RMS, which
 * leaves the fitter on its fixed default gate exactly as before this existed.
 */
function groupSurveyRmsM(points: LocalPointCsvPoint[]): number | null {
  let worst: number | null = null;
  for (const p of points) {
    if (p.hrms_m != null && Number.isFinite(p.hrms_m) && p.hrms_m > 0) {
      worst = worst == null ? p.hrms_m : Math.max(worst, p.hrms_m);
    }
  }
  return worst;
}

/** Build one open road-marking PlanLine for a single already-split group of points. */
function buildPlanLineForGroup(
  rawNed: RawNedPoint[],
  sourcePointCount: number,
  pathIndex: number,
  groupCount: number,
  groupLabel: string | undefined,
  surveyRmsM: number | null
): PlanLine | null {
  const id = planLineIdForGroup(pathIndex);
  const label = planLineLabelForGroup(pathIndex, groupCount, groupLabel, sourcePointCount);
  const fitted = buildRoadMarkingFittedPath(rawNed, { surveyRmsM });
  const preview_points = fitted.samples;

  if (preview_points.length < 2) {
    // Degenerate after open/dedupe — emit open chain only when nothing else is possible.
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
    const length_m = measurePreviewLengthM(fallback);
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
        length_m,
        geometry: {
          closed: false,
          road_marking: true,
          vertexCount: fallback.length,
          fit_mode: "degenerate",
          paintable: false,
          fit_warnings: ["Path degenerated to raw vertices after cleanup.", ...fitted.warnings],
        },
        preview_points: fallback,
      },
    };
  }

  const first = preview_points[0];
  const last = preview_points[preview_points.length - 1];
  const length_m = measurePreviewLengthM(preview_points);
  const corners = fitted.quality.corners ?? [];

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
      length_m,
      geometry: {
        closed: false,
        /** Road-marking preview: open stroke only (never a polygon ring). */
        road_marking: true,
        vertexCount: preview_points.length,
        source_vertex_count: sourcePointCount,
        fit_mode: fitted.mode,
        paintable: fitted.paintable,
        fit_warnings: fitted.warnings,
        max_joint_turn_deg: fitted.quality.maxJointTurnDeg,
        length_ratio: fitted.quality.lengthRatio,
        max_source_deviation_m: fitted.quality.maxSourceDeviationM,
        /** First-class corner metadata (Track C1) — survives Path Order / Send. */
        corners: corners.map((c) => ({
          atIndex: c.atIndex,
          turnDeg: c.turnDeg,
          class: c.class,
          radiusM: c.radiusM,
          cutM: c.cutM,
          overBudget: c.overBudget,
          undrivable: c.undrivable,
          north: c.north,
          east: c.east,
        })),
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
    const line = buildPlanLineForGroup(
      group,
      group.length,
      pathIndex,
      groups.length,
      groupLabel,
      groupSurveyRmsM(groupSourcePoints)
    );
    if (line) lines.push(line);
  }
  return lines;
}

function csvTransitLineId(i: number): string {
  return `local-csv-transit-${i}`;
}

/**
 * Below this gap (m), two consecutive group paths already touch — no connector needed.
 * Same threshold as trajectory merge (`MARK_CONTIGUOUS_GAP_M`) so the map/list never
 * show a transit hop the rover will silently fold into continuous paint.
 */
const CSV_TRANSIT_MIN_GAP_M = MARK_CONTIGUOUS_GAP_M;

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
// Re-export extension helpers (CSV_EXTENSIONS_EXECUTION_PLAN) so callers can import
// alongside buildCsvTransitLines from one module.
export {
  buildCsvExtensionLines,
  buildCsvExtensionPreviews,
  csvExtensionLengthM,
  DEFAULT_CSV_EXTENSION_CONFIG,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
  type CsvExtensionPreview,
} from "./csvExtensions";

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
