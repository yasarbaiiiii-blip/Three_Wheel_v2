import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  evaluateCsvSendReadiness,
  getLineFitMeta,
  isCriticalParseWarning,
  isGeometryNonPaintable,
  partitionParseWarnings,
} from "./csvGeometryReadiness";
import { buildTrajectory } from "./csvTrajectory";

function markLine(
  id: string,
  opts?: { paintable?: boolean; warnings?: string[]; paintPts?: boolean }
): PlanLine {
  const paintable = opts?.paintable !== false;
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: 0, y: 5 },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 5,
      geometry: {
        closed: false,
        road_marking: true,
        paintable,
        fit_warnings: opts?.warnings ?? (paintable ? [] : ["undrivable corner"]),
        fit_mode: paintable ? "waypoint-fillet" : "degraded-fillet",
      },
      preview_points: [
        { north: 0, east: 0 },
        { north: 0, east: 5 },
      ],
    },
  };
}

describe("csvGeometryReadiness", () => {
  it("reads paintable and fit_warnings from geometry", () => {
    const line = markLine("a", { paintable: false, warnings: ["too tight"] });
    const meta = getLineFitMeta(line);
    expect(meta.paintable).toBe(false);
    expect(meta.warnings).toEqual(["too tight"]);
    expect(isGeometryNonPaintable(line)).toBe(true);
  });

  it("treats missing paintable flag as paintable (legacy)", () => {
    const line = markLine("a");
    delete (line.entity!.geometry as { paintable?: boolean }).paintable;
    expect(getLineFitMeta(line).paintable).toBe(true);
  });

  it("classifies critical parse warnings", () => {
    expect(isCriticalParseWarning("Headerless CSV interpreted as lat/lon")).toBe(true);
    expect(isCriticalParseWarning("Row order looks jumbled")).toBe(true);
    expect(isCriticalParseWarning("2 survey points without FIX")).toBe(false);
    const parts = partitionParseWarnings([
      "Headerless CSV interpreted as lat/lon",
      "2 survey points without FIX",
    ]);
    expect(parts.critical).toHaveLength(1);
    expect(parts.advisory).toHaveLength(1);
  });

  it("blocks Send when a painted path is non-paintable until acknowledged", () => {
    const lines = [markLine("good"), markLine("bad", { paintable: false })];
    const blocked = evaluateCsvSendReadiness({
      lines,
      pathOrder: [
        { lineId: "good", label: "good", paint: true },
        { lineId: "bad", label: "bad", paint: true },
      ],
      parseWarnings: [],
      geometryAcknowledged: false,
      parseAcknowledged: false,
    });
    expect(blocked.canSend).toBe(false);
    expect(blocked.needsGeometryAck).toBe(true);
    expect(blocked.nonPaintablePainted).toHaveLength(1);

    const acked = evaluateCsvSendReadiness({
      lines,
      pathOrder: [
        { lineId: "good", label: "good", paint: true },
        { lineId: "bad", label: "bad", paint: true },
      ],
      geometryAcknowledged: true,
      parseAcknowledged: true,
    });
    expect(acked.canSend).toBe(true);
    expect(acked.needsGeometryAck).toBe(false);
  });

  it("allows Send after skipping non-paintable path without ack", () => {
    const lines = [markLine("good"), markLine("bad", { paintable: false })];
    const r = evaluateCsvSendReadiness({
      lines,
      pathOrder: [
        { lineId: "good", label: "good", paint: true },
        { lineId: "bad", label: "bad", paint: false },
      ],
      geometryAcknowledged: false,
    });
    expect(r.canSend).toBe(true);
    expect(r.nonPaintablePainted).toHaveLength(0);
  });

  it("blocks Send on critical parse warnings until acknowledged", () => {
    const lines = [markLine("a")];
    const blocked = evaluateCsvSendReadiness({
      lines,
      parseWarnings: ["Headerless CSV interpreted as lat/lon — confirm."],
      parseAcknowledged: false,
    });
    expect(blocked.canSend).toBe(false);
    expect(blocked.needsParseAck).toBe(true);

    const acked = evaluateCsvSendReadiness({
      lines,
      parseWarnings: ["Headerless CSV interpreted as lat/lon — confirm."],
      parseAcknowledged: true,
    });
    expect(acked.canSend).toBe(true);
  });

  it("hard-blocks when every painted path is non-paintable even after ack", () => {
    const lines = [markLine("bad", { paintable: false })];
    const r = evaluateCsvSendReadiness({
      lines,
      geometryAcknowledged: true,
      parseAcknowledged: true,
    });
    expect(r.canSend).toBe(false);
    expect(r.hardBlocks.length).toBeGreaterThan(0);
  });
});

describe("buildTrajectory refuses non-paintable", () => {
  it("excludes non-paintable marks and warns", () => {
    const good = markLine("good");
    const bad = markLine("bad", { paintable: false });
    const { runs, warnings } = buildTrajectory([good, bad], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.some((r) => r.kind === "mark")).toBe(true);
    expect(runs.filter((r) => r.kind === "mark")).toHaveLength(1);
    expect(warnings.some((w) => /non-paintable/i.test(w))).toBe(true);
  });

  it("returns no marks when only non-paintable paths are provided", () => {
    const bad = markLine("bad", { paintable: false });
    const { runs, warnings } = buildTrajectory([bad], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs).toHaveLength(0);
    expect(warnings.some((w) => /non-paintable/i.test(w))).toBe(true);
  });
});
