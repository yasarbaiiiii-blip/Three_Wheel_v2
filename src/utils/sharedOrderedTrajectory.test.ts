import { beforeEach, describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { buildOrderedTrajectory, defaultPathOrder, normalizeCsvExtensionConfig, setPathPaint } from "./missionPathOrder";
import { buildOrderedTrajectoryShared, resetSharedOrderedTrajectory } from "./sharedOrderedTrajectory";

function mark(id: string, points: Array<{ north: number; east: number }>): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: id,
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
      geometry: {},
      preview_points: points,
    },
  };
}

const lines = [
  mark("a", [{ north: 0, east: 0 }, { north: 10, east: 0 }]),
  mark("b", [{ north: 12, east: 0 }, { north: 22, east: 0 }]),
  mark("c", [{ north: 22, east: 5 }, { north: 12, east: 5 }]),
];
const speeds = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };
const extensions = { enabled: true, preM: 1, aftM: 1 };

describe("buildOrderedTrajectoryShared", () => {
  beforeEach(() => resetSharedOrderedTrajectory());

  it("returns exactly what buildOrderedTrajectory returns", () => {
    const order = defaultPathOrder(lines);
    expect(buildOrderedTrajectoryShared(lines, order, { ...speeds, extensions })).toEqual(
      buildOrderedTrajectory(lines, order, { ...speeds, extensions })
    );
  });

  it("the second caller with the same inputs reuses the first build", () => {
    const order = defaultPathOrder(lines);
    const first = buildOrderedTrajectoryShared(lines, order, { ...speeds, extensions });
    // Stage panel: its own markLines array (same line objects) and a normalized config.
    const second = buildOrderedTrajectoryShared([...lines], order, {
      ...speeds,
      extensions: normalizeCsvExtensionConfig(extensions),
    });
    expect(second).toBe(first);
  });

  it("rebuilds when the order, a paint flag, a speed, an extension or a line changes", () => {
    const order = defaultPathOrder(lines);
    const base = buildOrderedTrajectoryShared(lines, order, { ...speeds, extensions });

    const reordered = [order[1], order[0], order[2]];
    expect(buildOrderedTrajectoryShared(lines, reordered, { ...speeds, extensions })).not.toBe(base);

    const skipped = setPathPaint(order, "b", false);
    const skippedResult = buildOrderedTrajectoryShared(lines, skipped, { ...speeds, extensions });
    expect(skippedResult.paintedLines.map((l) => l.id)).toEqual(["a", "c"]);

    expect(buildOrderedTrajectoryShared(lines, order, { ...speeds, markSpeedMs: 0.4, extensions })).not.toBe(base);
    expect(buildOrderedTrajectoryShared(lines, order, { ...speeds, extensions: { ...extensions, aftM: 2 } })).not.toBe(base);

    const edited = [lines[0], mark("b", [{ north: 12, east: 0 }, { north: 23, east: 0 }]), lines[2]];
    expect(buildOrderedTrajectoryShared(edited, order, { ...speeds, extensions })).not.toBe(base);
  });
});
