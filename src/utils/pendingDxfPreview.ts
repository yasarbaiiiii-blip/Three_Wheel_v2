import type { PlanLine } from "../types/plan";
import type { CsvExtensionConfig } from "./missionExtensions";
import {
  applyCsvOrderToPlanLines,
  defaultPathOrder,
  selectMarkPlanLines,
} from "./missionPathOrder";

/**
 * Metric DXFs that are uploaded but still waiting for Fix Alignment are held out of the mission
 * lines. With Extension on, preview each held-out file with its own PRE/AFT runs (in the file's own
 * metres) so the operator sees them as soon as the file is up. They are recomputed in the aligned
 * frame when Fix Alignment commits the file. Returns `pending` untouched when Extension is off.
 */
export function previewPendingWithExtensions<E extends { rawLines?: PlanLine[] }>(
  pending: Record<string, E | undefined>,
  config: CsvExtensionConfig
): Record<string, E | undefined> {
  if (!config.enabled) return pending;
  const out: Record<string, E | undefined> = {};
  for (const [fileId, entry] of Object.entries(pending)) {
    if (!entry?.rawLines?.length) {
      out[fileId] = entry;
      continue;
    }
    const marks = selectMarkPlanLines(entry.rawLines);
    out[fileId] = {
      ...entry,
      rawLines: applyCsvOrderToPlanLines(entry.rawLines, defaultPathOrder(marks), config),
    };
  }
  return out;
}
