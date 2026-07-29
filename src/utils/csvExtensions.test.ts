import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  CSV_EXT_AFT_FLOOR_M,
  buildCsvExtensionLines,
  extensionEndpointsForLine,
  isMissionClosedLoop,
  normalizeCsvExtensionConfig,
  terminalUnitVector,
} from "./csvExtensions";
import { buildTrajectory, findAdjacentMarkViolation, type TrajectoryRun } from "./csvTrajectory";
import { applyCsvOrderToPlanLines, defaultPathOrder } from "./csvPathOrder";
import { relabelHydratedLinesWithExtensions } from "./stagedMissionHydration";

function mark(
  id: string,
  points: Array<{ north: number; east: number }>,
  label?: string
): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: label ?? id,
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

function kinds(runs: TrajectoryRun[]): string[] {
  return runs.map((r) => r.kind);
}

describe("normalizeCsvExtensionConfig", () => {
  it("floors aftM to 0.10 when enabled", () => {
    const cfg = normalizeCsvExtensionConfig({ enabled: true, preM: 0.5, aftM: 0.02 });
    expect(cfg.aftM).toBe(CSV_EXT_AFT_FLOOR_M);
    expect(cfg.preM).toBe(0.5);
  });

  it("does not floor aft when disabled", () => {
    const cfg = normalizeCsvExtensionConfig({ enabled: false, preM: 0.5, aftM: 0.02 });
    expect(cfg.aftM).toBeCloseTo(0.02, 6);
  });
});

describe("extension geometry", () => {
  it("PRE/AFT collinear with terminal segment, correct length and direction", () => {
    const line = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const pre = extensionEndpointsForLine(line, "pre", 0.5)!;
    const aft = extensionEndpointsForLine(line, "aft", 0.5)!;
    expect(pre[1]).toEqual([0, 0]);
    expect(pre[0][0]).toBeCloseTo(-0.5, 6);
    expect(pre[0][1]).toBeCloseTo(0, 6);
    expect(aft[0]).toEqual([10, 0]);
    expect(aft[1][0]).toBeCloseTo(10.5, 6);
    expect(aft[1][1]).toBeCloseTo(0, 6);
  });

  it("walks inward past a degenerate terminal segment", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0, 0], // zero-length first edge
      [5, 0],
    ];
    const u = terminalUnitVector(pts, "start");
    expect(u).not.toBeNull();
    expect(u![0]).toBeCloseTo(1, 6);
    expect(u![1]).toBeCloseTo(0, 6);
  });

  it("closed loop emits no extension lines", () => {
    const line = mark("loop", [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
      { north: 5, east: 5 },
      { north: 0, east: 5 },
      { north: 0, east: 0 },
    ]);
    expect(isMissionClosedLoop([line])).toBe(true);
    expect(
      buildCsvExtensionLines([line], { enabled: true, preM: 0.5, aftM: 0.5 })
    ).toHaveLength(0);
  });
});

describe("buildTrajectory with extensions", () => {
  const speeds = { markSpeedMs: 0.35, travelSpeedMs: 0.5 };

  it("two paths → travel, mark, travel, mark, travel with merged inter-group travel", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const b = mark("b", [
      { north: 10, east: 50 },
      { north: 20, east: 50 },
    ]);
    const { runs } = buildTrajectory([a, b], {
      ...speeds,
      extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
    });
    expect(kinds(runs)).toEqual(["travel", "mark", "travel", "mark", "travel"]);
    // Leading pre ends at mark start
    expect(runs[0].points[runs[0].points.length - 1][0]).toBeCloseTo(0, 5);
    expect(runs[0].points[runs[0].points.length - 1][1]).toBeCloseTo(0, 5);
    // No extension point inside mark runs
    for (const run of runs) {
      if (run.kind !== "mark") continue;
      // mark interior should not include pre tip
      expect(run.points[0][0]).toBeGreaterThanOrEqual(-1e-9);
    }
    // Ground-truth indices still mark-only when attached (match a real mark vertex)
    const gtResult = buildTrajectory([a, b], {
      ...speeds,
      extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
      groundTruthSource: [{ north: 10, east: 0, lat: 1, lon: 2 }],
    });
    expect(gtResult.groundTruth.length).toBe(1);
    expect(gtResult.runs[gtResult.groundTruth[0].run_index].kind).toBe("mark");
    // Leading travel shifted mark run index from 0 → 1
    expect(gtResult.groundTruth[0].run_index).toBe(1);
  });

  it("aftM=0.02 is corrected to 0.10 before payload", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const { runs } = buildTrajectory([a], {
      ...speeds,
      extensions: { enabled: true, preM: 0.5, aftM: 0.02 },
    });
    const aft = runs[runs.length - 1];
    expect(aft.kind).toBe("travel");
    const len = Math.hypot(
      aft.points[1][0] - aft.points[0][0],
      aft.points[1][1] - aft.points[0][1]
    );
    expect(len).toBeCloseTo(CSV_EXT_AFT_FLOOR_M, 5);
  });

  it("every extension-bearing run is travel; no spray in extension geometry", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const b = mark("b", [
      { north: 0, east: 20 },
      { north: 10, east: 20 },
    ]);
    const { runs } = buildTrajectory([a, b], {
      ...speeds,
      extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
    });
    for (const run of runs) {
      if (run.label === "pre-ext" || run.label === "aft-ext") {
        expect(run.kind).toBe("travel");
      }
    }
    // Extension endpoints must not appear only inside mark runs as sole geometry
    const markPts = new Set(
      runs
        .filter((r) => r.kind === "mark")
        .flatMap((r) => r.points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`))
    );
    const preTip = runs[0].points[0];
    expect(markPts.has(`${preTip[0].toFixed(4)},${preTip[1].toFixed(4)}`)).toBe(false);
  });

  it("regression: two mark lines sharing a vertex (e.g. an arrow template) do not crash", () => {
    // Chain-ends mode blocks PRE/AFT on any shared endpoint, so the shaft's end and the
    // wing's start both come back non-free — no travel run bridges them, and without merging
    // the touching edges the two 'mark' runs land adjacent, which used to throw.
    const shaft = mark("shaft", [
      { north: 0, east: 0 },
      { north: 5, east: 0 },
    ]);
    const wing = mark("wing", [
      { north: 5, east: 0 },
      { north: 5, east: 5 },
    ]);

    expect(() =>
      buildTrajectory([shaft, wing], {
        ...speeds,
        extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
      })
    ).not.toThrow();

    const { runs, warnings } = buildTrajectory([shaft, wing], {
      ...speeds,
      extensions: { enabled: true, preM: 0.5, aftM: 0.5 },
    });
    expect(findAdjacentMarkViolation(runs)).toBeNull();
    expect(warnings.some((w) => w.startsWith("INTERNAL:"))).toBe(false);
    // Touching edges merge into one continuous mark run instead of needing a travel bridge.
    expect(kinds(runs)).toEqual(["travel", "mark", "travel"]);
    const merged = runs[1];
    expect(merged.points[0]).toEqual([0, 0]);
    expect(merged.points[merged.points.length - 1]).toEqual([5, 5]);
    expect(merged.label).toBe("shaft + wing");
  });
});

describe("applyCsvOrderToPlanLines extensions", () => {
  it("strips stale extension orphans on rebuild", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const b = mark("b", [
      { north: 0, east: 30 },
      { north: 10, east: 30 },
    ]);
    const order = defaultPathOrder([a, b]);
    const first = applyCsvOrderToPlanLines([a, b], order, {
      enabled: true,
      preM: 0.5,
      aftM: 0.5,
    });
    const stale = [
      ...first,
      {
        id: "ext-pre-orphan",
        label: "orphan",
        layer: "extension" as const,
        segmentRole: "pre" as const,
        from: { id: 1, x: 99, y: 99 },
        to: { id: 2, x: 100, y: 100 },
        width: 0.1,
      },
    ];
    const next = applyCsvOrderToPlanLines(stale, order, {
      enabled: true,
      preM: 0.5,
      aftM: 0.5,
    });
    expect(next.some((l) => l.id === "ext-pre-orphan")).toBe(false);
    expect(next.filter((l) => l.layer === "extension").length).toBeGreaterThan(0);
  });
});

describe("relabelHydratedLinesWithExtensions", () => {
  it("labels a pure pre-ext travel run as extension", () => {
    const a = mark("a", [
      { north: 0, east: 0 },
      { north: 10, east: 0 },
    ]);
    const extLines = buildCsvExtensionLines([a], { enabled: true, preM: 0.5, aftM: 0.5 });
    const pre = extLines.find((l) => l.segmentRole === "pre")!;
    const hydrated: PlanLine[] = [
      {
        id: "rover-transit-1",
        label: "Transit 1",
        layer: "transit",
        segmentRole: "none",
        from: pre.from,
        to: pre.to,
        width: 0.1,
        entity: {
          entity_id: "t1",
          entity_type: "TRANSIT",
          layer: "TRANSIT",
          color: 0,
          is_mark: false,
          length_m: 0.5,
          geometry: {},
          preview_points: pre.entity!.preview_points,
        },
      },
      a,
    ];
    const out = relabelHydratedLinesWithExtensions(hydrated, extLines);
    expect(out.some((l) => l.layer === "extension" && l.segmentRole === "pre")).toBe(true);
  });
});
