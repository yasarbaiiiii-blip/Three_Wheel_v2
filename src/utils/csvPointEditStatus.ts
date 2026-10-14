/**
 * Operator-facing wording for CSV point edit mode (pure, so the "never silent" rules are tested:
 * points-only groups and an empty plan are always called out).
 */

export type CsvEditStatusInput = {
  editMode: boolean;
  rangeMode: boolean;
  selectedCount: number;
  deletedCount: number;
  remainingTotal: number;
  summaries: { fileName: string; pointsOnlyGroups: number; remainingCount: number; totalPoints: number }[];
};

export type CsvEditNotice = { level: "warning" | "error"; text: string };

export type CsvEditStatus = {
  headline: string;
  hint: string;
  notices: CsvEditNotice[];
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeCsvEditStatus(input: CsvEditStatusInput): CsvEditStatus {
  const total = input.summaries.reduce((n, s) => n + s.totalPoints, 0);

  const headline =
    input.deletedCount === 0
      ? `${plural(total, "point")} · none removed`
      : `${input.remainingTotal} of ${total} points kept · ${plural(input.deletedCount, "point")} removed`;

  const hint = input.rangeMode
    ? "Range: tap the first point, then the last — everything between is selected."
    : input.selectedCount > 0
      ? `${plural(input.selectedCount, "point")} selected. Tap again to deselect, or Delete.`
      : "Tap points on the map to select them. The original CSV is not changed.";

  const notices: CsvEditNotice[] = [];
  if (total > 0 && input.remainingTotal === 0) {
    notices.push({
      level: "error",
      text: "All points are deleted — there is nothing to send. Undo or Restore all to continue.",
    });
  }
  for (const s of input.summaries) {
    if (s.pointsOnlyGroups > 0) {
      notices.push({
        level: "warning",
        text: `${s.fileName}: ${plural(s.pointsOnlyGroups, "group")} left with a single point — ${
          s.pointsOnlyGroups === 1 ? "it has" : "they have"
        } no path and will not be painted.`,
      });
    }
  }
  return { headline, hint, notices };
}

/** Send is refused when edits left a CSV with no points at all (null = no CSV edit in play). */
export function isSendBlockedByEmptyEdit(csvPointsRemaining: number | null | undefined): boolean {
  return csvPointsRemaining === 0;
}

/**
 * A Send stamps the plan revision before uploading; if it moved by the time the rover answers,
 * the stored mission was built from geometry that is no longer on the map. Unknown revisions
 * (no edit hook wired) are never treated as stale.
 */
export function isStaleSend(
  revisionAtSend: number | undefined,
  revisionNow: number | undefined
): boolean {
  if (revisionAtSend == null || revisionNow == null) return false;
  return revisionAtSend !== revisionNow;
}
