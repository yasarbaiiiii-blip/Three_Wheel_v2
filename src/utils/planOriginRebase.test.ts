import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { projectGpsToLocalMeters, projectLocalMetersToGps } from "./geoProjection";
import {
  rebasePlanLineToOrigin,
  rebasePlanLinesToOrigin,
} from "./planOriginRebase";

function lineAt(north: number, east: number, id = "L0"): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: north, y: east },
    to: { id: 2, x: north + 1, y: east },
    width: 0.1,
  };
}

describe("rebasePlanLineToOrigin", () => {
  it("returns the same line when origins match", () => {
    const origin = { lat: 13.05, lon: 80.25 };
    const line = lineAt(10, 20);
    const out = rebasePlanLineToOrigin(line, origin, origin);
    expect(out).toBe(line);
  });

  it("round-trips geometry into a new origin frame", () => {
    const from = { lat: 13.05, lon: 80.25 };
    const to = { lat: 13.051, lon: 80.25 };
    const line = lineAt(0, 0);
    const rebased = rebasePlanLineToOrigin(line, from, to);

    // Point that was at from-origin local (0,0) is GPS(from); in to-frame that is
    // approximately −Δnorth of to.
    const expected = projectGpsToLocalMeters(from.lat, from.lon, to.lat, to.lon);
    expect(rebased.from.x).toBeCloseTo(expected.north, 5);
    expect(rebased.from.y).toBeCloseTo(expected.east, 5);

    // Inverse of forward GPS map should recover original.
    const backGps = projectLocalMetersToGps(
      rebased.from.x,
      rebased.from.y,
      to.lat,
      to.lon
    );
    expect(backGps.lat).toBeCloseTo(from.lat, 7);
    expect(backGps.lon).toBeCloseTo(from.lon, 7);
  });

  it("rebasePlanLinesToOrigin maps every line", () => {
    const from = { lat: 13.0, lon: 80.0 };
    const to = { lat: 13.0, lon: 80.001 };
    const lines = [lineAt(0, 0, "a"), lineAt(5, 0, "b")];
    const out = rebasePlanLinesToOrigin(lines, from, to);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("a");
    expect(out[1].from.x).toBeCloseTo(
      projectGpsToLocalMeters(
        projectLocalMetersToGps(5, 0, from.lat, from.lon).lat,
        projectLocalMetersToGps(5, 0, from.lat, from.lon).lon,
        to.lat,
        to.lon
      ).north,
      4
    );
  });
});
