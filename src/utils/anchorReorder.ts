import type { AnchorCandidatePoint } from "../components/mapViewTypes";
import type { PlanLine } from "../types/plan";
import { anchorSeedFromEnd, chainMarkLinesFromSeed } from "./missionPathOrder";
import { splitRoadMarkingPathAtAnchor } from "./roadMarkingCsvPath";

export type ReanchorResult =
  | { ok: true; chained: PlanLine[] }
  | { ok: false; reason: "seed-missing" | "no-geometry" };

/**
 * Re-anchor an isolated target: the plan's path sequence is re-chained so it starts at the tapped
 * anchor. CSV lines are split at the tapped point first (both arms start at the anchor); DXF
 * lines start from whichever endpoint was tapped. Only `targetLines` are touched.
 */
export function reanchorTargetLines(
  targetLines: PlanLine[],
  anchor: AnchorCandidatePoint
): ReanchorResult {
  const seedLine = targetLines.find((l) => l.id === anchor.lineId);
  if (!seedLine) return { ok: false, reason: "seed-missing" };

  let reordered = targetLines;
  let seedId = anchor.lineId;

  if (anchor.kind === "csv") {
    const split = splitRoadMarkingPathAtAnchor(seedLine, anchor.north, anchor.east);
    if (!split) return { ok: false, reason: "no-geometry" };
    // near === null: the anchor was the path's own current start or end — `far` alone covers the
    // whole path (unchanged, or fully reversed), no split/transit needed.
    const seedArm = split.near ?? split.far;
    reordered = targetLines.flatMap((l) => {
      if (l.id !== seedLine.id) return [l];
      return split.near ? [split.near, split.far] : [split.far];
    });
    seedId = seedArm.id;
  }

  const seedFromEnd =
    anchor.kind === "dxf" && anchorSeedFromEnd(seedLine, anchor.north, anchor.east);
  return { ok: true, chained: chainMarkLinesFromSeed(reordered, seedId, seedFromEnd) };
}
