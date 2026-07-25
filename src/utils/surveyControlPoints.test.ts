import { describe, expect, it } from "vitest";

import { buildControlPointMarkers } from "./surveyControlPoints";
import type { PlanLine, SurveyControlPoint } from "../types/plan";
// Captured from the Jetson (192.168.1.102) on curve_6_points.csv — a properly
// surveyed 4.8 m curve, 8 RTK shots. Pinned so the contract is tested against
// real backend output rather than an assumed shape.
import live from "./__fixtures__/curve6PreviewLive.json";

/** Stand-in projection: 1 m = 1e-5 deg, so assertions stay readable. */
const project = (north: number, east: number) => ({
  lat: 13.0 + north * 1e-5,
  lon: 80.0 + east * 1e-5,
});

const cp = (over: Partial<SurveyControlPoint> = {}): SurveyControlPoint => ({
  north: 1,
  east: 2,
  lat: 13.07206142,
  lon: 80.26193876,
  name: "6",
  code: "P",
  ...over,
});

const line = (
  from: { x: number; y: number; mustHit?: boolean },
  to: { x: number; y: number; mustHit?: boolean }
): PlanLine =>
  ({
    id: `${from.x},${from.y}-${to.x},${to.y}`,
    label: "seg",
    layer: "marking",
    width: 0.1,
    from: { id: 1, ...from },
    to: { id: 2, ...to },
  }) as unknown as PlanLine;

describe("buildControlPointMarkers", () => {
  it("uses the backend control points when present", () => {
    const out = buildControlPointMarkers([cp(), cp({ name: "7" })], [], project);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.source === "control_points")).toBe(true);
    expect(out.map((m) => m.label)).toEqual(["6", "7"]);
  });

  it("uses the SOURCE lat/lon, not a re-projection of north/east", () => {
    // north/east here would project to 13.00001/80.00002 — a totally different
    // place. The source lat/lon must win.
    const [m] = buildControlPointMarkers([cp()], [], project);
    expect(m.lat).toBe(13.07206142);
    expect(m.lon).toBe(80.26193876);
  });

  it("falls back to north/east when the export has no geographic anchor", () => {
    // Grid-only (Northing/Easting) survey: backend sends lat/lon as null.
    const [m] = buildControlPointMarkers(
      [cp({ lat: null, lon: null, north: 3, east: 4 })],
      [],
      project
    );
    expect(m.lat).toBeCloseTo(13.00003, 10);
    expect(m.lon).toBeCloseTo(80.00004, 10);
    expect(m.source).toBe("control_points");
  });

  it("carries name and code through for labels and layer grouping", () => {
    const [m] = buildControlPointMarkers(
      [cp({ name: "12", code: "College Road" })],
      [],
      project
    );
    expect(m.label).toBe("12");
    expect(m.code).toBe("College Road");
  });

  it("prefers control points over the mustHit scan when both exist", () => {
    // This is the regression the whole module exists for: after arc fitting,
    // mustHit marks the fitted arc ENDPOINTS (2) while the survey had 8 shots.
    const fitted = [
      line({ x: 0, y: 0, mustHit: true }, { x: 1, y: 1 }),
      line({ x: 1, y: 1 }, { x: 2, y: 2, mustHit: true }),
    ];
    const shots = Array.from({ length: 8 }, (_, i) => cp({ name: String(i) }));
    const out = buildControlPointMarkers(shots, fitted, project);
    expect(out).toHaveLength(8);
    expect(out.every((m) => m.source === "control_points")).toBe(true);
  });

  it("falls back to the mustHit scan when the backend sent none", () => {
    const lines = [
      line({ x: 0, y: 0, mustHit: true }, { x: 1, y: 0 }),
      line({ x: 1, y: 0 }, { x: 2, y: 0, mustHit: true }),
    ];
    for (const empty of [null, undefined, [] as SurveyControlPoint[]]) {
      const out = buildControlPointMarkers(empty, lines, project);
      expect(out).toHaveLength(2);
      expect(out.every((m) => m.source === "must_hit")).toBe(true);
    }
  });

  it("dedupes the shared vertex between adjacent lines in the fallback", () => {
    // Each line's `to` is the next line's `from` — one physical vertex.
    const lines = [
      line({ x: 0, y: 0, mustHit: true }, { x: 1, y: 0, mustHit: true }),
      line({ x: 1, y: 0, mustHit: true }, { x: 2, y: 0, mustHit: true }),
    ];
    expect(buildControlPointMarkers(null, lines, project)).toHaveLength(3);
  });

  it("returns nothing when there is no source at all", () => {
    expect(buildControlPointMarkers(null, null, project)).toEqual([]);
    expect(buildControlPointMarkers([], [], project)).toEqual([]);
  });

  it("skips non-finite coordinates in the fallback", () => {
    const lines = [
      line({ x: Number.NaN, y: 0, mustHit: true }, { x: 1, y: 0, mustHit: true }),
    ];
    expect(buildControlPointMarkers(null, lines, project)).toHaveLength(1);
  });
});

// ── Against the REAL backend wire format ─────────────────────────────────────

describe("against the live backend payload (curve_6_points.csv)", () => {
  it("draws all 8 surveyed shots, not the 2 fitted arc endpoints", () => {
    // The regression in one assertion: the backend arc-fits this curve, so only
    // 2 of its 97 waypoints are must_hit. Deriving the layer from must_hit would
    // draw 2 dots where the operator surveyed 8.
    expect(live.must_hit_waypoint_count).toBe(2);

    const out = buildControlPointMarkers(
      live.control_points as SurveyControlPoint[],
      [],
      project
    );
    expect(out).toHaveLength(8);
    expect(out.every((m) => m.source === "control_points")).toBe(true);
  });

  it("places them at the exact surveyed lat/lon from the file", () => {
    const out = buildControlPointMarkers(
      live.control_points as SurveyControlPoint[],
      [],
      project
    );
    // First shot: row "6" of curve_6_points.csv.
    expect(out[0].lat).toBe(13.07206142);
    expect(out[0].lon).toBe(80.26193876);
    expect(out[0].label).toBe("6");
    expect(out.map((m) => m.label)).toEqual(["6", "7", "8", "9", "10", "11", "12", "14"]);
  });

  it("exposes code so the layer can be grouped per surveyed feature", () => {
    const out = buildControlPointMarkers(
      live.control_points as SurveyControlPoint[],
      [],
      project
    );
    expect(new Set(out.map((m) => m.code))).toEqual(new Set(["P"]));
  });
});
