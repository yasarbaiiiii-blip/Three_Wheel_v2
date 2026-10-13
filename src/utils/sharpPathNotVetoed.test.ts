/**
 * A short survey path with a sharp turn (like "Pudupet_test-2: CSV path (3 pts)", 133.5° at the
 * middle point) used to be flagged non-paintable: warnings on the path, Send blocked until
 * acknowledged, and Start refused. Whether to paint it is now the operator's choice.
 */
import { describe, expect, it } from "vitest";

import { localCsvPointsToPlanLines, parseLocalPointCsv } from "./localPointCsv";
import { buildTrajectory } from "./missionTrajectory";
import { buildRoadMarkingFittedPath } from "./roadMarkingCsvPath";
import { evaluateCsvSendReadiness, getLineFitMeta } from "./missionReadiness";

// 3 points; the heading changes ~133° at the middle point (north 6 m, then back toward the start).
const CSV = ["north,east", "0,0", "6,0", "1.7,4.5"].join("\n");

describe("a 3-point CSV path with a sharp turn", () => {
  const data = parseLocalPointCsv(CSV, "sharp.csv");
  const lines = localCsvPointsToPlanLines(data.points, data.anchor);

  it("fixture check: the fitter itself still calls this path undrivable (so the test is meaningful)", () => {
    const fit = buildRoadMarkingFittedPath(data.points.map((p) => ({ north: p.north_m, east: p.east_m })));
    expect(fit.paintable).toBe(false);
    expect(fit.warnings.join(" | ")).toMatch(/exceeds 120|reversal/i);
  });

  it("is imported as a path with no 'non-paintable' / 'fix the survey' verdict attached", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.entity?.geometry?.paintable).toBeUndefined();
      const text = getLineFitMeta(line).warnings.join(" | ");
      expect(text).not.toMatch(/non-paintable|fix the survey|skip this path|Waypoint path validation/i);
    }
  });

  it("can be sent without any acknowledgement and is included in the trajectory", () => {
    const readiness = evaluateCsvSendReadiness({ lines });
    expect(readiness.canSend).toBe(true);
    expect(readiness.needsAck).toEqual([]);

    const { runs, warnings } = buildTrajectory(lines, { markSpeedMs: 0.35, travelSpeedMs: 0.5 });
    expect(runs.some((r) => r.kind === "mark")).toBe(true);
    expect(warnings.some((w) => /refused|non-paintable/i.test(w))).toBe(false);
  });

  it("the operator can still skip it with the paint tick", () => {
    const order = lines.map((l) => ({ lineId: l.id, label: l.label, paint: false }));
    const readiness = evaluateCsvSendReadiness({ lines, pathOrder: order });
    expect(readiness.canSend).toBe(false);
    expect(readiness.hardBlocks.join(" ")).toMatch(/Paint at least one path/);
  });
});
