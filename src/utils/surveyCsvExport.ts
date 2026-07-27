/**
 * Canonical survey-CSV export for the Fields "Select File" CSV flow.
 *
 * The rover plans a CSV mission from a file in its own missions dir — there is no
 * endpoint that accepts a waypoint array for a line mission. So "send the path to the
 * rover" means "write a file the rover's survey parser reads the same way we did".
 *
 * That parser (`path_engine/parsers/survey_csv.py`) is stricter and differently-spelled
 * than ours, so uploading the operator's raw file is not safe:
 *
 *   - it needs a NAMED coordinate header. A headerless `lat,lon` file — which
 *     `parseLocalPointCsv` accepts — falls through to the legacy NED reader, which
 *     would read latitude 13.07 as *13 metres north*.
 *   - it groups by `Code`/`Description`; we group by `feature`/`road`/`track`/… and by
 *     jump distance. Same file, two different sets of paths.
 *   - it orders points within a group by a numeric `Name`; we keep file order.
 *
 * Re-emitting the parse as `Name,Code,Latitude,Longitude` closes all three: `Code` carries
 * OUR grouping decision and `Name` carries OUR order, so the rover reproduces the paths the
 * operator just confirmed on screen, by construction.
 *
 * Coordinates are written STRAIGHT FROM THE SOURCE ROWS — never from `north_m`/`east_m`.
 * On-device local metres now use the ellipsoidal scale (matching the rover), but degrees
 * remain the handoff so the rover still projects with its own code and
 * `tools/analyze_mission.py` §8 can re-read Latitude/Longitude as ground truth.
 *
 * `Mark` column: when any source point has mark=false, a Mark column is written
 * (1/0). The rover survey parser splits those into TRANSIT vs MARK runs.
 */

import { splitIntoOpenPathGroups } from "./roadMarkingCsvPath";
import type { LocalPointCsvPoint, LocalPointCsvResult } from "./localPointCsv";

/** WGS84 degrees: 8 dp ≈ 1.1 mm, comfortably finer than RTK noise. */
const LATLON_DECIMALS = 8;
/** Local metres: 4 dp = 0.1 mm. */
const METRE_DECIMALS = 4;
/** Keep the rover-side filename short enough to stay readable in path listings. */
const MAX_BASENAME_CHARS = 80;

export type SurveyCsvExport = {
  /** Sanitised name the file takes in the rover's missions dir (always `.csv`). */
  fileName: string;
  /** Full canonical CSV text, newline-terminated. */
  text: string;
  /** Rows written (may be below `result.num_points` if a row lacked coordinates). */
  numPoints: number;
  /** Distinct `Code` values written — one per path the preview drew. */
  numPaths: number;
  kind: "gps" | "ned";
  /**
   * Anchor of the on-device preview, for display only. NOT sent to the rover: for a
   * lat/lon export the rover derives its own anchor from the file (the point centroid),
   * which is a different number describing the same ground position.
   */
  previewAnchor: { lat: number; lon: number } | null;
};

/**
 * Rover-side filename. The uploaded file lands in the missions dir under this name, so it
 * has to survive a URL path segment and a `os.path.basename` round-trip.
 */
export function sanitizeUploadFileName(raw: string): string {
  const base = (raw || "").split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.[^.]*$/, "");
  const safe = stem
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[_.]+|_+$/g, "")
    .slice(0, MAX_BASENAME_CHARS);
  return `${safe || "survey"}.csv`;
}

/**
 * A group label reduced to something safe for an unquoted CSV cell.
 * Returns "" when nothing usable survives, so the caller falls back to a positional code.
 */
function sanitizeCode(label: string | undefined): string {
  if (!label) return "";
  return label
    .replace(/["\r\n]+/g, " ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * One `Code` per point, naming exactly the paths `localCsvPointsToPlanLines` draws.
 *
 * The operator's own feature label is used where there is one ("Haddows Road"), because it
 * becomes the rover-side segment name and shows up again in the staged mission — a
 * positional code would throw away information the source file already carried.
 *
 * The label alone is not enough, though: a single labelled feature can still be split into
 * several paths by the jump-distance rule, and re-using one label across both halves would
 * have the rover merge them back into one segment — bridging the very gap the split exists
 * to preserve. So a repeated label is suffixed, and the result is unique per drawn path
 * either way.
 */
export function assignPathCodes(points: LocalPointCsvPoint[]): string[] {
  const codes: string[] = new Array(points.length).fill("path_1");
  if (points.length === 0) return codes;

  const rawNed = points.map((p) => ({ north: p.north_m, east: p.east_m }));
  const groupKeys = points.some((p) => p.group != null) ? points.map((p) => p.group) : undefined;
  const groups = splitIntoOpenPathGroups(rawNed, groupKeys);

  const taken = new Set<string>();
  let cursor = 0;
  groups.forEach((group, index) => {
    const groupPoints = points.slice(cursor, cursor + group.length);
    const shared =
      groupPoints.length > 0 && groupPoints.every((p) => p.group && p.group === groupPoints[0].group)
        ? sanitizeCode(groupPoints[0].group)
        : "";
    const base = shared || `path_${index + 1}`;
    let code = base;
    for (let n = 2; taken.has(code); n++) code = `${base} (${n})`;
    taken.add(code);

    for (let i = 0; i < group.length && cursor < codes.length; i++, cursor++) {
      codes[cursor] = code;
    }
  });
  return codes;
}

function csvRow(cells: (string | number)[]): string {
  return cells.join(",");
}

/** Turn an on-device CSV parse into the canonical survey CSV the rover reads. */
export function buildSurveyCsvExport(result: LocalPointCsvResult): SurveyCsvExport {
  const codes = assignPathCodes(result.points);
  const isGps = result.kind === "gps";
  const includeMark = result.points.some((p) => p.mark === false);
  const header = isGps
    ? includeMark
      ? ["Name", "Code", "Latitude", "Longitude", "Mark"]
      : ["Name", "Code", "Latitude", "Longitude"]
    : includeMark
      ? ["Name", "Code", "Northing", "Easting", "Mark"]
      : ["Name", "Code", "Northing", "Easting"];
  const rows: string[] = [csvRow(header)];

  const usedCodes = new Set<string>();
  let written = 0;

  result.points.forEach((point, i) => {
    let a: number;
    let b: number;
    if (isGps) {
      // A "gps" parse always carries lat/lon, but guard rather than emit NaN — a NaN row
      // would be dropped by the rover's parser and silently shorten the path.
      if (point.lat == null || point.lon == null) return;
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
      a = point.lat;
      b = point.lon;
    } else {
      if (!Number.isFinite(point.north_m) || !Number.isFinite(point.east_m)) return;
      a = point.north_m;
      b = point.east_m;
    }
    const decimals = isGps ? LATLON_DECIMALS : METRE_DECIMALS;
    written += 1;
    usedCodes.add(codes[i]);
    // Name is the emitted row number, not the source index: the rover sorts points within
    // a Code numerically by Name, so it only has to be increasing to preserve our order.
    const cells: (string | number)[] = [written, codes[i], a.toFixed(decimals), b.toFixed(decimals)];
    if (includeMark) cells.push(point.mark === false ? 0 : 1);
    rows.push(csvRow(cells));
  });

  return {
    fileName: sanitizeUploadFileName(result.fileName),
    text: `${rows.join("\n")}\n`,
    numPoints: written,
    numPaths: usedCodes.size,
    kind: result.kind,
    previewAnchor: result.anchor,
  };
}
