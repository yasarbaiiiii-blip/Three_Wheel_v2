/**
 * Phase 2 golden differential (client-side gate).
 * Live rover comparison is scripts/dxfGoldenDiff.ts; these fixtures prove
 * geometry invariants without a rover.
 */
import { describe, expect, it } from "vitest";
import {
  ARC_50M_DXF,
  MIXED_LAYERS_DXF,
  SQUARE_2X2_CM_DXF,
  SQUARE_2X2_DXF,
} from "./dxfGoldenFixtures";
import { MAX_SAGITTA_M, parseLocalDxf } from "./dxfLocalImport";
import { isPaintableMarkLine } from "./missionTrajectory";

function markLength(lines: ReturnType<typeof parseLocalDxf>["lines"]): number {
  return lines
    .filter((l) => l.entity?.is_mark)
    .reduce((s, l) => s + (l.entity?.length_m ?? 0), 0);
}

describe("Phase 2 golden fixtures", () => {
  it("square_2x2 metres: 1 closed entity, perimeter 8 m, is_mark true", () => {
    const r = parseLocalDxf(SQUARE_2X2_DXF, "square_2x2.dxf");
    expect(r.entityCount).toBe(1);
    expect(r.ignoredCount).toBe(0);
    expect(r.unitScale).toBe(1);
    expect(r.lines[0].entity?.is_mark).toBe(true);
    expect(isPaintableMarkLine(r.lines[0])).toBe(true);
    expect(markLength(r.lines)).toBeCloseTo(8, 2);
    const pp = r.lines[0].entity!.preview_points;
    const gap = Math.hypot(
      pp[0].north - pp[pp.length - 1].north,
      pp[0].east - pp[pp.length - 1].east
    );
    expect(gap).toBeLessThan(1e-6);
  });

  it("square_2x2 cm: same geometry as metres after scale", () => {
    const m = parseLocalDxf(SQUARE_2X2_DXF, "m.dxf");
    const c = parseLocalDxf(SQUARE_2X2_CM_DXF, "cm.dxf");
    expect(c.unitScale).toBe(0.01);
    expect(markLength(c.lines)).toBeCloseTo(markLength(m.lines), 2);
    expect(c.entityCount).toBe(m.entityCount);
  });

  it("mixed layers: mark paints, transit does not, DIM+POINT ignored", () => {
    const r = parseLocalDxf(MIXED_LAYERS_DXF, "mixed.dxf");
    expect(r.ignoredCount).toBe(2); // DIM + POINT
    expect(r.entityCount).toBe(2); // FIELD + TRANSIT
    const mark = r.lines.find((l) => l.entity?.layer === "FIELD")!;
    const transit = r.lines.find((l) => l.entity?.layer === "TRANSIT")!;
    expect(mark.entity?.is_mark).toBe(true);
    expect(transit.entity?.is_mark).toBe(false);
    expect(isPaintableMarkLine(mark)).toBe(true);
    expect(isPaintableMarkLine(transit)).toBe(false);
  });

  it("50 m arc: chord error ≤ 5 mm sagitta", () => {
    const r = parseLocalDxf(ARC_50M_DXF, "arc50.dxf");
    expect(r.entityCount).toBe(1);
    const pp = r.lines[0].entity!.preview_points;
    // Circle centre at CAD (0,0) → after axis swap preview north=y east=x → still origin
    // Arc 0→90 CAD: (50,0)→(0,50) in CAD xy → preview east/north
    let maxErr = 0;
    const radius = 50;
    for (let i = 0; i < pp.length - 1; i++) {
      const mx = (pp[i].east + pp[i + 1].east) / 2;
      const my = (pp[i].north + pp[i + 1].north) / 2;
      maxErr = Math.max(maxErr, Math.abs(radius - Math.hypot(mx, my)));
    }
    expect(maxErr).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-4);
    const expectedLen = (Math.PI / 2) * 50;
    expect(r.lines[0].entity!.length_m).toBeCloseTo(expectedLen, 1);
  });
});
