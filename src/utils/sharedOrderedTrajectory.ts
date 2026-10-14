/**
 * Path Order and the Stage panel both show the ordered trajectory for the same plan, order and
 * speeds, and each used to build it. This one-entry memo lets the second caller reuse the first
 * caller's result. Inputs match when the mark lines and order entries are the same objects in
 * the same order, the speeds are equal, and the extension configs normalize to the same values
 * (buildOrderedTrajectory only reads extensions through normalizeCsvExtensionConfig).
 *
 * The result is shared: callers must treat it as read-only.
 */
import type { PlanLine } from "../types/plan";
import {
  buildOrderedTrajectory,
  normalizeCsvExtensionConfig,
  type CsvExtensionConfig,
  type CsvPathOrderEntry,
} from "./missionPathOrder";
import { perfCount } from "./perfCounters";

type SharedTrajectoryOpts = {
  markSpeedMs: number;
  travelSpeedMs: number;
  extensions?: Partial<CsvExtensionConfig> | null;
};

type OrderedTrajectory = ReturnType<typeof buildOrderedTrajectory>;

let last: {
  markLines: readonly PlanLine[];
  order: readonly CsvPathOrderEntry[];
  markSpeedMs: number;
  travelSpeedMs: number;
  extensionsKey: string;
  result: OrderedTrajectory;
} | null = null;

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function buildOrderedTrajectoryShared(
  markLines: PlanLine[],
  order: CsvPathOrderEntry[],
  opts: SharedTrajectoryOpts
): OrderedTrajectory {
  const extensionsKey = JSON.stringify(normalizeCsvExtensionConfig(opts.extensions));
  if (
    last &&
    last.markSpeedMs === opts.markSpeedMs &&
    last.travelSpeedMs === opts.travelSpeedMs &&
    last.extensionsKey === extensionsKey &&
    sameItems(last.markLines, markLines) &&
    sameItems(last.order, order)
  ) {
    return last.result;
  }
  perfCount("trajectory.build");
  const result = buildOrderedTrajectory(markLines, order, opts);
  last = {
    markLines,
    order,
    markSpeedMs: opts.markSpeedMs,
    travelSpeedMs: opts.travelSpeedMs,
    extensionsKey,
    result,
  };
  return result;
}

/** Test hook. */
export function resetSharedOrderedTrajectory(): void {
  last = null;
}
