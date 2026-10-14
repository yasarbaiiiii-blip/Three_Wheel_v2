/**
 * The ONE place a CSV parse becomes plan lines.
 *
 * Upload calls this with no deleted ids; point edits call it with the file's deleted ids, so the
 * preview the operator sees and the geometry that is staged to the rover always come from the
 * same function (docs/CSV_POINT_EDIT_EXECUTION_PLAN.md, D2).
 *
 * The parse's GPS anchor is frozen at parse time and never recomputed from the remaining
 * points, so deleting (or restoring) any row — including row 1 — cannot move the plan origin.
 */

import {
  buildCsvTransitLines,
  localCsvPointsToPlanLines,
  type LocalPointCsvResult,
  type RoadMarkingFitCache,
} from "./localPointCsv";
import { chainMarkLinesByGeometry, reversePlanLineDirection } from "./missionPathOrder";
import { prefixDxfLineIds } from "./dxfLocalImport";
import { rebasePlanLinesToOrigin } from "./planOriginRebase";
import { splitIntoOpenPathGroupsDetailed } from "./roadMarkingCsvPath";
import { remainingPoints } from "./csvPointEdit";
import type { PlanLine } from "../types/plan";

export type CsvFileLinesInput = {
  parse: LocalPointCsvResult;
  fileId: string;
  /** Deleted point ids for THIS file. */
  deletedIds?: ReadonlySet<string>;
  /** Drive the whole file end → start: paths in reverse chain order, each one reversed. */
  reversed?: boolean;
  /** `prefix__` for line ids. Null for the standalone local-NED flow (unprefixed lines). */
  prefix: string | null;
  /** Existing shared plan origin to rebase onto; null when this file establishes it. */
  sharedOrigin?: { lat: number; lon: number } | null;
  /** Shared fit memo so an edit only refits the group(s) it changed. */
  fitCache?: RoadMarkingFitCache;
};

export type CsvFileLinesResult = {
  /** Mark paths + transit connectors, rebased and prefixed — ready to append to `lines`. */
  lines: PlanLine[];
  totalPoints: number;
  remainingCount: number;
  deletedCount: number;
  /** Mark paths produced. */
  pathCount: number;
  /** Groups left with too few points to form a path (silently dropped without this count). */
  pointsOnlyGroups: number;
};

function sameOrigin(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/**
 * Swap one file's lines for `next`, keeping them where the old ones were (so Path Order's
 * default sequence and the map z-order do not jump to the end after every edit). Matches the
 * same `prefix__` / `prefix-` id convention as `replacePrefixedLines`.
 */
export function replacePrefixedLinesInPlace(
  lines: PlanLine[],
  prefix: string,
  next: PlanLine[]
): PlanLine[] {
  const own = (id: string) => id.startsWith(`${prefix}__`) || id.startsWith(`${prefix}-`);
  const firstOwn = lines.findIndex((l) => own(l.id));
  if (firstOwn < 0) return [...lines, ...next];
  const before = lines.slice(0, firstOwn).filter((l) => !own(l.id));
  const after = lines.slice(firstOwn).filter((l) => !own(l.id));
  return [...before, ...next, ...after];
}

export function buildCsvFileLines(input: CsvFileLinesInput): CsvFileLinesResult {
  const { parse, fileId, prefix } = input;
  const deleted = input.deletedIds ?? new Set<string>();
  const points = remainingPoints(parse, fileId, deleted);

  const chained = chainMarkLinesByGeometry(localCsvPointsToPlanLines(points, parse.anchor, { fitCache: input.fitCache }));
  // Reverse AFTER chaining: the chain optimiser is free to pick either end, so reversing the
  // input rows would not reliably reverse the drive.
  const markLines = input.reversed ? chained.slice().reverse().map(reversePlanLineDirection) : chained;
  let lines: PlanLine[] = [...markLines, ...buildCsvTransitLines(markLines)];

  if (parse.kind === "gps" && parse.anchor && input.sharedOrigin && !sameOrigin(parse.anchor, input.sharedOrigin)) {
    lines = rebasePlanLinesToOrigin(lines, parse.anchor, input.sharedOrigin);
  }
  if (prefix) lines = prefixDxfLineIds(lines, prefix);

  let pointsOnlyGroups = 0;
  if (points.length > 0) {
    const groupKeys = points.some((p) => p.group != null) ? points.map((p) => p.group) : undefined;
    const { groups } = splitIntoOpenPathGroupsDetailed(
      points.map((p) => ({ north: p.north_m, east: p.east_m })),
      groupKeys
    );
    pointsOnlyGroups = Math.max(0, groups.filter((g) => g.length > 0).length - markLines.length);
  }

  return {
    lines,
    totalPoints: parse.points.length,
    remainingCount: points.length,
    deletedCount: parse.points.length - points.length,
    pathCount: markLines.length,
    pointsOnlyGroups,
  };
}
