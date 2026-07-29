/**
 * Curved geometry keeps its extensions even though it closes on itself.
 *
 * Field report: `circle_3m_diameter.dxf` with Enable Extension on produced nothing. The
 * self-closed guard was being applied to every geometry, but in the rover that guard lives
 * inside `split_mark_segment_with_extensions`'s `elif _is_line_like_segment(...)` branch —
 * ARC and CIRCLE take the earlier analytic-tangent branch and keep their run-ups
 * ("Curves keep their analytic-tangent extensions (handled in the branch above)").
 *
 * Directions come from `entity_extension_directions`:
 *   ARC    → dxf_arc_tangent(start_angle), dxf_arc_tangent(end_angle)
 *   CIRCLE → dxf_arc_tangent(0) for both — densified from 0° CCW, ending where it began.
 */

import { describe, expect, it } from "vitest";

import { parseLocalDxf } from "./dxfLocalImport";
import {
  analyticCurveTangents,
  buildCsvExtensionLines,
  buildExtendedMarkChain,
  dxfArcTangent,
} from "./missionExtensions";
import {
  defaultPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
} from "./missionPathOrder";
import { buildTrajectory } from "./missionTrajectory";

const PER_LINE = { enabled: true, preM: 0.5, aftM: 0.5, perLine: true };
const CHAIN_ENDS = { enabled: true, preM: 0.5, aftM: 0.5, perLine: false };

/** A 3 m diameter circle, declared in metres. */
function circleDxf(radiusMetres = 1.5): string {
  return [
    "0\nSECTION\n2\nHEADER\n",
    "9\n$INSUNITS\n70\n6\n",
    "0\nENDSEC\n",
    "0\nSECTION\n2\nENTITIES\n",
    `0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n${radiusMetres}\n`,
    "0\nENDSEC\n",
    "0\nEOF\n",
  ].join("");
}

function paintedFrom(text: string, name = "circle_3m_diameter.dxf") {
  const parsed = parseLocalDxf(text, name);
  const marks = selectMarkPlanLines(parsed.lines);
  return resolveOrderedPaintedLines(marks, defaultPathOrder(marks));
}

describe("dxfArcTangent", () => {
  it("matches path_engine/core.py: (cos θ, −sin θ) in north/east", () => {
    const [n0, e0] = dxfArcTangent(0);
    expect(n0).toBeCloseTo(1, 9);
    expect(e0).toBeCloseTo(0, 9);

    const [n90, e90] = dxfArcTangent(90);
    expect(n90).toBeCloseTo(0, 9);
    expect(e90).toBeCloseTo(-1, 9);
  });
});

describe("circle extensions", () => {
  it("parses a CIRCLE whose endpoints coincide", () => {
    const painted = paintedFrom(circleDxf());
    expect(painted).toHaveLength(1);

    const pts = painted[0].entity!.preview_points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(Math.hypot(last.north - first.north, last.east - first.east)).toBeLessThan(0.01);
    expect(analyticCurveTangents(painted[0])).not.toBeNull();
  });

  it("still gets PRE and AFT despite closing on itself", () => {
    const painted = paintedFrom(circleDxf());

    for (const cfg of [PER_LINE, CHAIN_ENDS]) {
      const chain = buildExtendedMarkChain(painted, cfg);
      expect(chain).toHaveLength(1);
      expect(chain[0].edge.curved).toBe(true);
      expect(chain[0].pre).not.toBeNull();
      expect(chain[0].aft).not.toBeNull();

      const built = buildCsvExtensionLines(painted, cfg);
      expect(built.filter((l) => l.segmentRole === "pre")).toHaveLength(1);
      expect(built.filter((l) => l.segmentRole === "aft")).toHaveLength(1);
    }
  });

  it("runs in and out along the tangent at 0°, not across the ring", () => {
    const painted = paintedFrom(circleDxf(1.5));
    const chain = buildExtendedMarkChain(painted, PER_LINE);
    const start = chain[0].edge.points[0];

    // Tangent at 0° is +north, so PRE approaches from the south and AFT leaves to the north.
    const preTip = chain[0].pre![0];
    const aftTip = chain[0].aft![1];
    expect(preTip[0]).toBeCloseTo(start[0] - 0.5, 6);
    expect(preTip[1]).toBeCloseTo(start[1], 6);
    expect(aftTip[0]).toBeCloseTo(start[0] + 0.5, 6);
    expect(aftTip[1]).toBeCloseTo(start[1], 6);
  });

  it("trajectory is travel → mark → travel with every boundary touching", () => {
    const painted = paintedFrom(circleDxf());
    const { runs, warnings } = buildTrajectory(painted, {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
      extensions: PER_LINE,
    });

    expect(runs.map((r) => r.kind)).toEqual(["travel", "mark", "travel"]);
    for (let i = 0; i < runs.length - 1; i++) {
      const end = runs[i].points[runs[i].points.length - 1];
      const next = runs[i + 1].points[0];
      expect(Math.hypot(end[0] - next[0], end[1] - next[1])).toBeLessThanOrEqual(0.05);
    }
    expect(warnings.filter((w) => w.startsWith("INTERNAL"))).toHaveLength(0);
  });

  it("an ARC uses its own start and end angles", () => {
    const arcDxf = [
      "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n",
      "0\nSECTION\n2\nENTITIES\n",
      "0\nARC\n8\n0\n10\n0\n20\n0\n40\n2\n50\n0\n51\n90\n",
      "0\nENDSEC\n0\nEOF\n",
    ].join("");
    const painted = paintedFrom(arcDxf, "quarter_arc.dxf");
    const tangents = analyticCurveTangents(painted[0])!;

    expect(tangents[0][0]).toBeCloseTo(1, 6); // tangent at 0°  → +north
    expect(tangents[1][1]).toBeCloseTo(-1, 6); // tangent at 90° → −east

    const chain = buildExtendedMarkChain(painted, PER_LINE);
    expect(chain).toHaveLength(1);
    expect(chain[0].pre).not.toBeNull();
    expect(chain[0].aft).not.toBeNull();
  });
});
