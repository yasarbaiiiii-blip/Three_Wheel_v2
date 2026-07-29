import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { buildTrajectory } from "./csvTrajectory";
import {
  csvFrameExtents,
  makeAsymmetricLTemplate,
  placeTemplateLinesInCsvFrame,
} from "./csvTemplatePlacement";

describe("placeTemplateLinesInCsvFrame", () => {
  it("converts template local x/y into CSV north/east without transpose", () => {
    // Local drawing: vertical stem along +y, base along +x.
    // After placement at origin: stem grows in +north, base in +east.
    const local = makeAsymmetricLTemplate(10);
    const placed = placeTemplateLinesInCsvFrame(local, {
      roverNorth: 0,
      roverEast: 0,
      offsetEast: 0,
      offsetNorth: 0,
    });

    const ext = csvFrameExtents(placed);
    expect(ext).not.toBeNull();
    // Stem is 10 m north, base is 5 m east → north extent > east extent.
    const northSpan = ext!.northMax - ext!.northMin;
    const eastSpan = ext!.eastMax - ext!.eastMin;
    expect(northSpan).toBeCloseTo(10, 5);
    expect(eastSpan).toBeCloseTo(5, 5);
    // Transpose guard: if we had swapped axes, east would be 10 and north 5.
    expect(northSpan).toBeGreaterThan(eastSpan);
  });

  it("applies rover offset like TemplatePanel (east to drawing-x, north to drawing-y)", () => {
    const local = makeAsymmetricLTemplate(2);
    const placed = placeTemplateLinesInCsvFrame(local, {
      roverNorth: 100,
      roverEast: 200,
      offsetEast: 2,
      offsetNorth: 0,
    });
    // Corner at local (0,0) → north=100, east=202
    const pts = placed[0].entity!.preview_points;
    expect(pts[0].north).toBeCloseTo(100, 6);
    expect(pts[0].east).toBeCloseTo(202, 6);
    // CSV PlanPoint convention
    expect(placed[0].from.x).toBeCloseTo(100, 6);
    expect(placed[0].from.y).toBeCloseTo(202, 6);
  });

  it("places dense preview_points polyline, not just from/to chord", () => {
    // Arc-like local polyline: three points, not colinear with from→to alone.
    const curved: PlanLine = {
      id: "arc",
      label: "Arc",
      layer: "marking",
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 4, y: 0 },
      entity: {
        entity_id: "arc",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0,
        geometry: {},
        // localX→east field, localY→north field (matches from.x/from.y as east/north local)
        preview_points: [
          { north: 0, east: 0 },
          { north: 2, east: 2 },
          { north: 0, east: 4 },
        ],
      },
    };
    const placed = placeTemplateLinesInCsvFrame([curved], {
      roverNorth: 0,
      roverEast: 0,
      offsetEast: 0,
      offsetNorth: 0,
    });
    expect(placed).toHaveLength(1);
    expect(placed[0].entity!.preview_points).toHaveLength(3);
    // Mid vertex must survive (would be lost if only from/to chord used).
    expect(placed[0].entity!.preview_points[1].north).toBeCloseTo(2, 5);
    expect(placed[0].entity!.preview_points[1].east).toBeCloseTo(2, 5);
  });

  it("CSV path + asymmetric template produce one trajectory with travel between", () => {
    const csvMark = {
      id: "csv-1",
      label: "Road A",
      layer: "marking" as const,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 20, y: 0 },
      width: 0.1,
      is_mark: true,
      entity: {
        entity_id: "csv-1",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 20,
        geometry: {},
        preview_points: [
          { north: 0, east: 0 },
          { north: 20, east: 0 },
        ],
      },
    };
    const template = placeTemplateLinesInCsvFrame(makeAsymmetricLTemplate(4), {
      roverNorth: 20,
      roverEast: 30,
      offsetEast: 0,
      offsetNorth: 0,
    });
    // template first stroke starts at (20, 30) — 30 m east of road end (20,0)
    const { runs } = buildTrajectory([csvMark, ...template], {
      markSpeedMs: 0.35,
      travelSpeedMs: 0.5,
    });
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs[0].kind).toBe("mark");
    expect(runs.some((r) => r.kind === "travel")).toBe(true);
    // Asymmetric L keeps taller north span after placement at N=20
    const ext = csvFrameExtents(template);
    expect(ext!.northMax - ext!.northMin).toBeCloseTo(4, 5);
    expect(ext!.eastMax - ext!.eastMin).toBeCloseTo(2, 5);
  });
});
