/**
 * Client-side point-mission CSV parse for Fields upload.
 *
 * Mission Select File (.csv) must NOT hit the rover path APIs. This module
 * reads lat/lon or north/east CSVs on-device and produces local NED points for
 * map preview only (no upload / parse-point-* / /preview).
 */

import { projectGpsToLocalMeters } from "./visualAlignment";
import { splitCsvCells } from "./refPointsCsv";

const LAT_ALIASES = new Set(["lat", "latitude"]);
const LON_ALIASES = new Set(["lon", "lng", "long", "longitude"]);
const NORTH_ALIASES = new Set(["north", "north_m", "n", "y"]);
const EAST_ALIASES = new Set(["east", "east_m", "e", "x"]);
const DWELL_ALIASES = new Set(["dwell_s", "dwell", "dwell_sec"]);
const MARK_ALIASES = new Set(["mark", "is_mark", "spray"]);

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
};

function resolveHeader(cells: string[]): ColMap | null {
  const lower = cells.map((c) => c.trim().toLowerCase());
  const find = (aliases: Set<string>) => lower.findIndex((c) => aliases.has(c));

  const latIdx = find(LAT_ALIASES);
  const lonIdx = find(LON_ALIASES);
  if (latIdx >= 0 && lonIdx >= 0) {
    const dwellIdx = find(DWELL_ALIASES);
    const markIdx = find(MARK_ALIASES);
    return {
      kind: "gps",
      latIdx,
      lonIdx,
      dwellIdx: dwellIdx >= 0 ? dwellIdx : undefined,
      markIdx: markIdx >= 0 ? markIdx : undefined,
    };
  }

  const northIdx = find(NORTH_ALIASES);
  const eastIdx = find(EAST_ALIASES);
  // Prefer explicit north/east headers; avoid treating "y,x" alone as NED when
  // the file is clearly a multi-column survey export without lat/lon.
  if (northIdx >= 0 && eastIdx >= 0) {
    const dwellIdx = find(DWELL_ALIASES);
    const markIdx = find(MARK_ALIASES);
    return {
      kind: "ned",
      northIdx,
      eastIdx,
      dwellIdx: dwellIdx >= 0 ? dwellIdx : undefined,
      markIdx: markIdx >= 0 ? markIdx : undefined,
    };
  }

  return null;
}

function headerlessMap(firstRow: string[]): ColMap | null {
  if (firstRow.length < 2) return null;
  if (!looksNumeric(firstRow[0]) || !looksNumeric(firstRow[1])) return null;
  // Headerless always NED metres (same contract as former /parse-point-csv).
  return {
    kind: "ned",
    northIdx: 0,
    eastIdx: 1,
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
    colMap = headerlessMap(firstCells);
    if (!colMap) {
      throw new Error(
        "Unrecognized CSV. Expected lat/lon (or latitude/longitude) columns, " +
          "north/east columns, or headerless north,east[,dwell_s[,mark]] metres."
      );
    }
    dataStart = 0;
  }

  const warnings: string[] = [];
  const rawGps: { lat: number; lon: number; mark: boolean; dwell_s: number | null; source_index: number }[] = [];
  const rawNed: LocalPointCsvPoint[] = [];

  for (let i = dataStart; i < lines.length; i++) {
    const rowNum = i + 1;
    const cells = splitCsvCells(lines[i]);
    if (cells.every((c) => c === "")) continue;

    try {
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
        rawGps.push({ lat, lon, mark, dwell_s, source_index: rowNum });
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
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(msg);
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
      };
    });
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

  return {
    kind: "ned",
    fileName,
    num_points: rawNed.length,
    points: rawNed,
    anchor: null,
    point_source_frame: "LOCAL_NED",
    warnings,
  };
}
