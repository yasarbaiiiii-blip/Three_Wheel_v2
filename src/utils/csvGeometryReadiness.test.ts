import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  evaluateCsvSendReadiness,
  getLineFitMeta,
  isCriticalParseWarning,
  partitionParseWarnings,
} from "./csvGeometryReadiness";
import { buildTrajectory } from "./missionTrajectory";

/** A path with a sharp reversal corner, as an older fit would have flagged "undrivable". */
function markLine(id: string, opts?: { warnings?: string[]; legacyUnpaintable?: boolean }): PlanLine {
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
        ...(opts?.legacyUnpaintable ? { paintable: false } : {}),
        fit_warnings: opts?.warnings ?? [],
        fit_mode: "waypoint-fillet",
        corners: opts?.legacyUnpaintable ? [{ atIndex: 1, turnDeg: 150, class: "reversal" }] : [],
      },
      preview_points: [
        { north: 0, east: 0 },
        { north: 0, east: 5 },
      ],
    },
  };
}

const order = (...entries: Array<[string, boolean]>) =>
  entries.map(([lineId, paint]) => ({ lineId, label: lineId, paint }));

describe("csvGeometryReadiness", () => {
  it("reads fit_warnings from geometry", () => {
    const meta = getLineFitMeta(markLine("a", { warnings: ["too tight"] }));
    expect(meta.warnings).toEqual(["too tight"]);
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

  it("never vetoes a painted path for its shape — the paint tick is the operator's choice", () => {
    const lines = [markLine("good"), markLine("sharp", { legacyUnpaintable: true })];
    const r = evaluateCsvSendReadiness({
      lines,
      pathOrder: order(["good", true], ["sharp", true]),
    });
    expect(r.canSend).toBe(true);
    expect(r.hardBlocks).toEqual([]);
    expect(r.needsAck).toEqual([]);
  });

  it("a path that is the only painted one and has a sharp corner can still be sent", () => {
    const r = evaluateCsvSendReadiness({
      lines: [markLine("sharp", { legacyUnpaintable: true })],
    });
    expect(r.canSend).toBe(true);
  });

  it("skipping a path still removes it, and sending needs at least one painted path", () => {
    const lines = [markLine("good"), markLine("other")];
    expect(
      evaluateCsvSendReadiness({ lines, pathOrder: order(["good", true], ["other", false]) }).canSend
    ).toBe(true);
    const none = evaluateCsvSendReadiness({ lines, pathOrder: order(["good", false], ["other", false]) });
    expect(none.canSend).toBe(false);
    expect(none.hardBlocks.join(" ")).toMatch(/Paint at least one path/);
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
});

describe("buildTrajectory paints what the operator ticked", () => {
  it("includes every painted path, including one with a sharp corner, with no refusal warning", () => {
    const good = markLine("good");
    const sharp = markLine("sharp", { legacyUnpaintable: true });
    const { runs, warnings } = buildTrajectory([good, sharp], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.filter((r) => r.kind === "mark")).toHaveLength(2);
    expect(warnings.some((w) => /non-paintable|refused/i.test(w))).toBe(false);
  });
});
