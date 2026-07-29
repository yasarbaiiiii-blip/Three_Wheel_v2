import { describe, expect, it } from "vitest";
import type { PlanLine } from "../types/plan";
import {
  buildCsvExtensionLines,
  buildMarkEdges,
  computeEndpointFreeness,
  splitPolylineAtCorners,
} from "./missionExtensions";

function polyLine(
  id: string,
  pts: Array<[number, number]>,
  closed = false
): PlanLine {
  const points = closed && pts.length >= 2 ? [...pts, pts[0]] : pts;
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: points[0][0], y: points[0][1] },
    to: {
      id: 2,
      x: points[points.length - 1][0],
      y: points[points.length - 1][1],
    },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: { closed },
      preview_points: points.map(([n, e]) => ({ north: n, east: e })),
    },
  };
}

describe("extension freeness (Phase 3)", () => {
  it("closed square perLine=false → no extensions (mission closed loop)", () => {
    const square = polyLine("sq", [
      [0, 0],
      [0, 2],
      [2, 2],
      [2, 0],
    ], true);
    const lines = buildCsvExtensionLines([square], {
      enabled: true,
      preM: 0.5,
      aftM: 0.5,
      perLine: false,
    });
    expect(lines).toHaveLength(0);
  });

  it("closed square perLine=true → 4 PRE + 4 AFT at corners", () => {
    // Open polyline of 4 sides (not self-closed single edge) — four separate sides
    // as one polyline that starts≠ends would still freeness-block without split;
    // use closed with corner split:
    const square = polyLine(
      "sq",
      [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ],
      true
    );
    // Closed polyline has start=end so whole-entity freeness is (false,false).
    // Corner split creates 4 open edges whose corners touch non-collinearly → free.
    const edges = buildMarkEdges([square], true);
    expect(edges.length).toBeGreaterThanOrEqual(4);
    const free = computeEndpointFreeness(edges, true);
    const freeStarts = free.filter((f) => f.startFree).length;
    const freeEnds = free.filter((f) => f.endFree).length;
    // Each corner is a shared non-collinear junction → free under perLine
    expect(freeStarts + freeEnds).toBeGreaterThanOrEqual(8);

    const lines = buildCsvExtensionLines([square], {
      enabled: true,
      preM: 0.5,
      aftM: 0.5,
      perLine: true,
    });
    const pres = lines.filter((l) => l.segmentRole === "pre");
    const afts = lines.filter((l) => l.segmentRole === "aft");
    expect(pres.length).toBe(4);
    expect(afts.length).toBe(4);
  });

  it("open L-shape → run-ups only at two free ends (perLine=false)", () => {
    const L = polyLine("L", [
      [0, 0],
      [0, 2],
      [2, 2],
    ]);
    const lines = buildCsvExtensionLines([L], {
      enabled: true,
      preM: 0.5,
      aftM: 0.5,
      perLine: false,
    });
    // Single path open: PRE at start + AFT at end
    expect(lines.filter((l) => l.segmentRole === "pre")).toHaveLength(1);
    expect(lines.filter((l) => l.segmentRole === "aft")).toHaveLength(1);
  });

  it("splitPolylineAtCorners splits square into 4 sides", () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [0, 2],
      [2, 2],
      [2, 0],
      [0, 0],
    ];
    const parts = splitPolylineAtCorners(pts);
    expect(parts.length).toBe(4);
  });
});
