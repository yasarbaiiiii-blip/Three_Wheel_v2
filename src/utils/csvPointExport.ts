/**
 * CSV point edit — export the CURRENT edited points (deletions applied, reversed files written
 * last row first) as a CSV that `parseLocalPointCsv` reads back. Pure: no file system.
 */

import type { LocalPointCsvPoint, LocalPointCsvResult } from "./localPointCsv";

/** Column names chosen from the parser's aliases so the export re-imports as-is. */
const COL = {
  lat: "lat",
  lon: "lon",
  north: "north",
  east: "east",
  mark: "mark",
  dwell: "dwell_s",
  group: "feature",
  fix: "fix",
  samples: "samples",
  hrms: "hrms",
  pdop: "pdop",
} as const;

function num(n: number, decimals: number): string {
  // Fixed precision, then drop trailing zeros: 13.00002000 → 13.00002.
  return String(Number(n.toFixed(decimals)));
}

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize `points` (already in the order to write) using `parse.kind` for the coordinate
 * columns. Optional columns are written only when at least one point has a value.
 */
export function buildEditedCsvText(
  parse: Pick<LocalPointCsvResult, "kind">,
  points: readonly LocalPointCsvPoint[]
): string {
  const gps = parse.kind === "gps";
  const has = {
    dwell: points.some((p) => p.dwell_s != null),
    group: points.some((p) => p.group != null),
    fix: points.some((p) => p.fix_status != null),
    samples: points.some((p) => p.samples != null),
    hrms: points.some((p) => p.hrms_m != null),
    pdop: points.some((p) => p.pdop != null),
  };

  const header: string[] = [gps ? COL.lat : COL.north, gps ? COL.lon : COL.east, COL.mark];
  if (has.dwell) header.push(COL.dwell);
  if (has.group) header.push(COL.group);
  if (has.fix) header.push(COL.fix);
  if (has.samples) header.push(COL.samples);
  if (has.hrms) header.push(COL.hrms);
  if (has.pdop) header.push(COL.pdop);

  const rows = points.map((p) => {
    const row =
      gps && p.lat != null && p.lon != null
        ? [num(p.lat, 9), num(p.lon, 9)]
        : [num(p.north_m, 4), num(p.east_m, 4)];
    row.push(p.mark ? "1" : "0");
    if (has.dwell) row.push(p.dwell_s != null ? num(p.dwell_s, 3) : "");
    if (has.group) row.push(cell(p.group ?? ""));
    if (has.fix) row.push(cell(p.fix_status ?? ""));
    if (has.samples) row.push(p.samples != null ? String(p.samples) : "");
    if (has.hrms) row.push(p.hrms_m != null ? num(p.hrms_m, 4) : "");
    if (has.pdop) row.push(p.pdop != null ? num(p.pdop, 2) : "");
    return row.join(",");
  });

  return [header.join(","), ...rows].join("\n") + "\n";
}

/**
 * Operator-typed export name → safe base name (no extension, no path separators or characters
 * Android's file providers reject). Null when nothing usable is left.
 */
export function sanitizeExportBaseName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/\.csv$/i, "")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

/** Default name offered in the export prompt: `survey.csv` → `survey_edited`. */
export function defaultExportBaseName(fileNames: readonly string[]): string {
  const first = fileNames[0]?.replace(/\.[^.]+$/, "") ?? "";
  const base = sanitizeExportBaseName(first) ?? "points";
  return fileNames.length > 1 ? `${base}_and_more_edited` : `${base}_edited`;
}

/** One name for one file; `name_1`, `name_2`, … when several CSV files are exported together. */
export function exportFileNames(baseName: string, count: number): string[] {
  if (count <= 1) return [`${baseName}.csv`];
  return Array.from({ length: count }, (_, i) => `${baseName}_${i + 1}.csv`);
}
