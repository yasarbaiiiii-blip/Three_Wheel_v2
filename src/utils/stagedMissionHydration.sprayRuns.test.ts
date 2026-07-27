import { describe, expect, it } from "vitest";

import { sprayRunsToPlanLines, waypointsToPlanLines } from "./stagedMissionHydration";

/** Points along a circle of `r` metres, `steps` chords, centred at the origin. */
function arcPoints(r: number, steps: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    pts.push([r * Math.sin(a), r * Math.cos(a)]);
  }
  return pts;
}

describe("sprayRunsToPlanLines", () => {
  it("emits one line per continuous spray run, not one per chord", () => {
    const waypoints = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]];
    const lines = sprayRunsToPlanLines(waypoints, [true, true, true, false, false]);

    expect(lines).toHaveLength(2);
    expect(lines[0].layer).toBe("marking");
    expect(lines[1].layer).toBe("transit");
  });

  it("keeps a tessellated curve as ONE line where the collinear splitter makes hundreds", () => {
    // 60 chords around a half-circle: no two are collinear, which is exactly the shape a
    // planner-tessellated survey arrives in.
    const waypoints = arcPoints(11.5, 60);
    const flags = waypoints.map(() => true);

    const runs = sprayRunsToPlanLines(waypoints, flags);
    const collinear = waypointsToPlanLines(waypoints, flags);

    expect(runs).toHaveLength(1);
    expect(runs[0].entity?.preview_points).toHaveLength(61);
    expect(collinear.length).toBeGreaterThan(50);
  });

  it("carries the full polyline so the map draws the planned geometry, not a chord", () => {
    const waypoints = arcPoints(5, 8);
    const lines = sprayRunsToPlanLines(waypoints, waypoints.map(() => true));

    const preview = lines[0].entity?.preview_points ?? [];
    expect(preview[0]).toEqual({ north: waypoints[0][0], east: waypoints[0][1] });
    expect(preview[preview.length - 1]).toEqual({
      north: waypoints[waypoints.length - 1][0],
      east: waypoints[waypoints.length - 1][1],
    });
    // from/to are the run's ends — the polyline is what actually renders.
    expect(lines[0].from.x).toBeCloseTo(waypoints[0][0], 9);
    expect(lines[0].to.x).toBeCloseTo(waypoints[waypoints.length - 1][0], 9);
  });

  it("reports the polyline's own length, not the straight-line distance", () => {
    // A right-angle path: 3 m + 4 m along the polyline, 5 m end to end.
    const lines = sprayRunsToPlanLines([[0, 0], [3, 0], [3, 4]], [true, true, true]);
    expect(lines[0].entity?.length_m).toBeCloseTo(7, 6);
  });

  it("leaves no gap between consecutive strokes", () => {
    // A spray flag describes the segment STARTING at its point, so a run owns the step into
    // the next run's first point. Reaching one point forward is what makes the strokes meet.
    const lines = sprayRunsToPlanLines(
      [[0, 0], [1, 0], [3, 0], [3, 2], [3, 4]],
      [true, true, false, false, false]
    );

    expect(lines.map((l) => l.layer)).toEqual(["marking", "transit"]);
    const markPreview = lines[0].entity?.preview_points ?? [];
    const transitPreview = lines[1].entity?.preview_points ?? [];
    expect(markPreview[markPreview.length - 1]).toEqual(transitPreview[0]);
  });

  it("drops a trailing point that has no segment of its own", () => {
    // Only two segments exist here (0→1, 1→2), both flagged marking; the final point's own
    // flag describes a step that never happens, so it must not become a zero-length line.
    const lines = sprayRunsToPlanLines([[0, 0], [1, 0], [5, 0]], [true, true, false]);

    expect(lines).toHaveLength(1);
    expect(lines[0].layer).toBe("marking");
    expect(lines[0].entity?.length_m).toBeCloseTo(5, 6);
  });

  it("does not duplicate an already-shared junction point", () => {
    // The planner keeps the coincident point on both sides of a spray change.
    const lines = sprayRunsToPlanLines([[0, 0], [1, 0], [1, 0], [4, 0]], [true, true, false, false]);
    expect(lines[0].entity?.preview_points).toHaveLength(2);
  });

  it("tags transit runs so they list under Path Order's Transit group", () => {
    const lines = sprayRunsToPlanLines([[0, 0], [1, 0], [4, 0]], [false, false, false]);
    expect(lines[0].layer).toBe("transit");
    expect(lines[0].segmentRole).toBe("none");
    expect(lines[0].entity?.is_mark).toBe(false);
  });

  it("numbers marking and transit runs independently", () => {
    const lines = sprayRunsToPlanLines(
      [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]],
      [true, true, false, false, true, true]
    );
    expect(lines.map((l) => l.id)).toEqual(["rover-path-1", "rover-transit-1", "rover-path-2"]);
  });

  it("skips unusable coordinate pairs instead of emitting NaN geometry", () => {
    const lines = sprayRunsToPlanLines([[0, 0], ["bad", 1], [2, 0]], [true, true, true]);
    expect(lines).toHaveLength(1);
    expect(Number.isFinite(lines[0].to.x)).toBe(true);
  });

  it("returns nothing for a mission with fewer than two usable points", () => {
    expect(sprayRunsToPlanLines([], [])).toEqual([]);
    expect(sprayRunsToPlanLines([[0, 0]], [true])).toEqual([]);
    expect(sprayRunsToPlanLines(null as unknown as unknown[], [])).toEqual([]);
  });

  it("treats a missing spray flag as marking, matching the planner's default", () => {
    const lines = sprayRunsToPlanLines([[0, 0], [1, 0]], []);
    expect(lines[0].layer).toBe("marking");
    expect(lines[0].is_mark).toBe(true);
  });
});
