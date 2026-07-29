import { describe, expect, it } from "vitest";
import {
  buildCsvTransitLines,
  localCsvPointsToPlanLines,
  localCsvToMapPins,
  metresPerDegree,
  parseLocalPointCsv,
  projectGpsToLocalMetersEllipsoid,
  sampleEvenly,
} from "./localPointCsv";
/**
 * Earth model. These metres go to POST /api/path/plan-trajectory and are used VERBATIM as
 * PX4 local NED anchored at origin_gps — the rover never re-projects them. PX4 defines that
 * frame on a sphere of R = 6 371 000 m, so that is the scale we must produce.
 *
 * History, all three at 13.07 °N:
 *   WGS84 semi-major used as a sphere  111 319.5 m/deg  — 0.6 % long (original app bug)
 *   WGS84 meridional radius            110 627   m/deg  — true ground, 0.52 % short in PX4's frame
 *   PX4 sphere (6 371 000)             111 194.9 m/deg  — what the EKF actually navigates  ✓
 *
 * The middle row was an intermediate fix that overshot; see the field measurement recorded in
 * path_engine/parsers/georef.py::metres_per_degree (2026-07-25 bags).
 */
describe("metresPerDegree / PX4-sphere projection", () => {
  const PX4_R = 6_371_000;
  const WGS84_A = 6_378_137;

  it("matches the PX4 sphere, not WGS84 semi-major or meridional", () => {
    const { mPerDegNorth, mPerDegEast } = metresPerDegree(13.07);

    expect(mPerDegNorth).toBeCloseTo(PX4_R * (Math.PI / 180), 3);

    // Strictly between the two superseded models.
    const semiMajorNorth = WGS84_A * (Math.PI / 180);
    const meridionalNorth = semiMajorNorth / 1.00622;
    expect(mPerDegNorth).toBeLessThan(semiMajorNorth);
    expect(mPerDegNorth).toBeGreaterThan(meridionalNorth);

    // East shrinks by cos(lat) off the same sphere.
    expect(mPerDegEast).toBeCloseTo(
      PX4_R * (Math.PI / 180) * Math.cos((13.07 * Math.PI) / 180),
      3
    );
    expect(mPerDegEast).toBeLessThan(mPerDegNorth);
  });

  it("GPS→NED uses the same sphere as metresPerDegree", () => {
    const originLat = 13.07;
    const originLon = 80.26;
    const projected = projectGpsToLocalMetersEllipsoid(
      originLat + 0.001,
      originLon,
      originLat,
      originLon
    );
    expect(projected.north).toBeCloseTo(0.001 * metresPerDegree(originLat).mPerDegNorth, 6);
    expect(projected.east).toBeCloseTo(0, 9);
  });
});

describe("parseLocalPointCsv", () => {
  it("parses lat,lon GPS header and anchors at first row", () => {
    const text = ["lat,lon", "13.0,80.0", "13.001,80.0"].join("\n");
    const r = parseLocalPointCsv(text, "gps.csv");
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
    expect(r.points[0].north_m).toBeCloseTo(0, 6);
    expect(r.points[0].east_m).toBeCloseTo(0, 6);
    expect(r.points[1].north_m).toBeGreaterThan(100);
    expect(Math.abs(r.points[1].east_m)).toBeLessThan(1);
    // Ellipsoid scale at anchor, not sphere
    const expected = projectGpsToLocalMetersEllipsoid(13.001, 80.0, 13.0, 80.0);
    expect(r.points[1].north_m).toBeCloseTo(expected.north, 6);
  });

  it("accepts latitude/longitude aliases in any order", () => {
    const text = ["longitude,latitude", "80.0,13.0", "80.001,13.0"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor?.lat).toBe(13.0);
    expect(r.anchor?.lon).toBe(80.0);
  });

  it("headerless numeric rows are lat,lon (same as guide CSV)", () => {
    const text = ["13.0,80.0", "13.001,80.0"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(2);
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
    expect(r.points[0].lat).toBe(13.0);
    expect(r.points[0].lon).toBe(80.0);
  });

  it("parses north,east header as NED", () => {
    const text = ["north,east", "0,0", "5,1"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.points.map((p) => [p.north_m, p.east_m])).toEqual([
      [0, 0],
      [5, 1],
    ]);
  });

  it("parses northing,easting headers as NED", () => {
    const text = ["northing,easting", "1,2", "3,4"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("ned");
    expect(r.points[1]).toMatchObject({ north_m: 3, east_m: 4 });
  });

  it("prefers lat/lon when survey file also has northing/easting", () => {
    const text = [
      "Name,Northing,Easting,Latitude,Longitude",
      "1,100,200,13.0,80.0",
      "2,101,201,13.001,80.0",
    ].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.anchor).toEqual({ lat: 13.0, lon: 80.0 });
  });

  it("parses mark column on NED", () => {
    const text = ["north,east,mark", "0,0,true", "1,0,false"].join("\n");
    const r = parseLocalPointCsv(text);
    expect(r.points[0].mark).toBe(true);
    expect(r.points[1].mark).toBe(false);
  });

  it("rejects empty file", () => {
    expect(() => parseLocalPointCsv("")).toThrow(/empty/i);
  });

  it("rejects survey-style header without lat/lon or north/east", () => {
    const text = ["Name,Code,Elevation", "1,L1,10"].join("\n");
    expect(() => parseLocalPointCsv(text)).toThrow(/Unrecognized CSV/i);
  });

  it("strips BOM", () => {
    const text = "\uFEFFlat,lon\n13,80\n";
    const r = parseLocalPointCsv(text);
    expect(r.kind).toBe("gps");
    expect(r.num_points).toBe(1);
  });

  it("round-trips GPS lat/lon through ellipsoidal NED (rover scale)", () => {
    // Preview NED uses ellipsoid metres-per-degree. Inverse with the same scale
    // must recover lat/lon; the shared spherical map helper does not (and pins
    // still draw from source lat/lon, so map markers are unaffected).
    const text = ["lat,lon", "13.07208106,80.26195346", "13.08,80.27"].join("\n");
    const r = parseLocalPointCsv(text);
    const { mPerDegNorth, mPerDegEast } = metresPerDegree(r.anchor!.lat);
    for (const p of r.points) {
      const lat = r.anchor!.lat + p.north_m / mPerDegNorth;
      const lon = r.anchor!.lon + p.east_m / mPerDegEast;
      expect(lat).toBeCloseTo(p.lat!, 8);
      expect(lon).toBeCloseTo(p.lon!, 8);
    }
  });

  it("map pins keep source lat/lon (not re-projected through NED)", () => {
    const text = ["lat,lon", "13.07208106,80.26195346", "13.08,80.27"].join("\n");
    const r = parseLocalPointCsv(text);
    const pins = localCsvToMapPins(r);
    expect(pins[0].lat).toBe(13.07208106);
    expect(pins[0].lon).toBe(80.26195346);
    expect(pins[1].lat).toBe(13.08);
    expect(pins[1].lon).toBe(80.27);
  });
});

describe("localCsvPointsToPlanLines", () => {
  it("builds one open road-marking path (not a closed polygon)", () => {
    const r = parseLocalPointCsv(["lat,lon", "13,80", "13.001,80", "13.002,80.001"].join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
    expect(lines[0].entity?.geometry?.closed).toBe(false);
    expect(lines[0].entity?.geometry?.road_marking).toBe(true);
    const pts = lines[0].entity?.preview_points ?? [];
    expect(pts.length).toBeGreaterThanOrEqual(2);
    // Path starts at the first survey point (anchor).
    expect(lines[0].from.x).toBeCloseTo(r.points[0].north_m, 1);
    expect(lines[0].from.y).toBeCloseTo(r.points[0].east_m, 1);
  });

  it("splits into one PlanLine per feature when the CSV has a grouping column (real bug regression)", () => {
    // Mirrors roundabout_coordinates.csv: two named features in one file, no header for
    // north/east — the parser must never bridge them with a straight teleport line.
    const rows = ["feature,north,east"];
    for (let i = 0; i < 10; i++) rows.push(`West circle,${i * 0.5},${0}`);
    for (let i = 0; i < 10; i++) rows.push(`East circle,${30 + i * 0.5},${30}`);
    const r = parseLocalPointCsv(rows.join("\n"));
    expect(r.points[0].group).toBe("West circle");
    expect(r.points[15].group).toBe("East circle");

    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(2);
    expect(lines[0].id).toBe("local-csv-path");
    expect(lines[1].id).toBe("local-csv-path-2");
    expect(lines[0].label).toContain("West circle");
    expect(lines[1].label).toContain("East circle");
    expect(lines[0].entity?.geometry?.road_marking).toBe(true);
    expect(lines[1].entity?.geometry?.road_marking).toBe(true);

    // No cross-feature bridge: every consecutive sample within a line stays close.
    for (const line of lines) {
      const pts = line.entity?.preview_points ?? [];
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].north - pts[i - 1].north, pts[i].east - pts[i - 1].east);
        expect(d).toBeLessThan(2);
      }
    }
  });

  it("splits via jump-distance fallback when no grouping column exists", () => {
    const rows = ["north,east"];
    for (let i = 0; i < 10; i++) rows.push(`${i * 0.5},0`);
    for (let i = 0; i < 10; i++) rows.push(`${40 + i * 0.5},40`);
    const r = parseLocalPointCsv(rows.join("\n"));
    expect(r.points.every((p) => p.group === undefined)).toBe(true);

    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(2);
    expect(lines[0].id).toBe("local-csv-path");
    expect(lines[1].id).toBe("local-csv-path-2");
  });

  it("keeps a single PlanLine for one continuous feature even with a grouping column present", () => {
    const rows = ["road,north,east"];
    for (let i = 0; i < 15; i++) rows.push(`Main St,${i * 0.5},0`);
    const r = parseLocalPointCsv(rows.join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe("local-csv-path");
    expect(lines[0].label).toContain("Main St");
  });

  it("ignores a 'Name' column with a unique value per row (real bug regression: RTK survey point-ID collision)", () => {
    // Mirrors curve_6_points.csv (Emlid Reach RS3 export): a "Name" column holding a
    // unique per-point ID, not a shared feature label. Must not split into 1-point groups
    // and silently drop every line.
    const rows = ["Name,lat,lon"];
    const ids = [6, 7, 8, 9, 10, 11, 12, 14, 15, 16];
    for (let i = 0; i < ids.length; i++) rows.push(`${ids[i]},13.0${i},80.0${i}`);
    const r = parseLocalPointCsv(rows.join("\n"));
    expect(r.points.every((p) => p.group === undefined)).toBe(true);

    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
    expect(lines[0].entity?.preview_points?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("ignores a recognized grouping column when its values are unique per row (cardinality guard)", () => {
    // Even a genuinely-aliased column (e.g. "road") must not drive grouping if it doesn't
    // actually repeat — protects against the same class of collision for any alias, not
    // just the "name" case above.
    const rows = ["road,north,east"];
    for (let i = 0; i < 10; i++) rows.push(`segment-${i},${i * 0.5},0`);
    const r = parseLocalPointCsv(rows.join("\n"));
    expect(r.points.every((p) => p.group === undefined)).toBe(true);

    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
  });

  it("still groups a recognized column that repeats across many rows", () => {
    const rows = ["road,north,east"];
    for (let i = 0; i < 10; i++) rows.push(`Main St,${i * 0.5},0`);
    for (let i = 0; i < 10; i++) rows.push(`Side St,${20 + i * 0.5},20`);
    const r = parseLocalPointCsv(rows.join("\n"));
    expect(r.points[0].group).toBe("Main St");
    expect(r.points[15].group).toBe("Side St");

    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(2);
  });
});

describe("localCsvPointsToPlanLines — sparse-arc RMS wiring (curve_6_points.csv regression)", () => {
  /**
   * NED metres and Lateral RMS, in file order, transcribed from an operator-reported RTK
   * survey (curve_6_points.csv — 8 usable points after the pipeline's own 2 cm dedupe, plus a
   * trailing 3-sample cluster 2 mm apart that collapses into the 8th). Reproduced here as a
   * literal north/east/hrms CSV so the regression does not depend on that file's continued
   * presence on disk, while still locking in the real numbers.
   *
   * The reported bug: the fitted circle sits 3.4 cm (unconstrained) / 5.18 cm (endpoint-
   * constrained) from these points — genuinely one smooth curve for a survey whose own Lateral
   * RMS is 1.6-1.8 cm — but a fixed 5 cm gate rejected it by 1.8 mm. The fallback (per-vertex
   * fillets, each sized from local turn angle alone) then amplified that same GPS noise into a
   * visible curvature swing between rows 7-11 — an implied radius oscillating 1.48 m to 4.90 m
   * on a curve whose true radius is a near-constant ~2.4 m. That is the "jiggle from point 2 to
   * 6" the operator saw on screen.
   */
  const CURVE_6_POINTS_NED: Array<[north: number, east: number, hrms: number]> = [
    [0.0, 0.0, 0.016],
    [-0.051, 0.546, 0.017],
    [-0.043, 1.178, 0.017],
    [0.244, 2.015, 0.017],
    [0.801, 2.58, 0.017],
    [1.184, 2.879, 0.017],
    [1.834, 3.059, 0.018],
    [2.512, 3.102, 0.017],
    [2.51, 3.104, 0.017],
    [2.511, 3.102, 0.017],
  ];

  function csvWithRms(rows: Array<[number, number, number]>): string {
    return ["north,east,hrms", ...rows.map(([n, e, h]) => `${n},${e},${h}`)].join("\n");
  }

  function csvWithoutRms(rows: Array<[number, number, number]>): string {
    return ["north,east", ...rows.map(([n, e]) => `${n},${e}`)].join("\n");
  }

  function jointTurnsDeg(pts: { north: number; east: number }[]): number[] {
    const out: number[] = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const h1 = Math.atan2(b.east - a.east, b.north - a.north);
      const h2 = Math.atan2(c.east - b.east, c.north - b.north);
      let d = h2 - h1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      out.push(Math.abs((d * 180) / Math.PI));
    }
    return out;
  }

  it("renders one smooth arc, not the per-vertex jiggle, once the survey's own RMS is known", () => {
    const parsed = parseLocalPointCsv(csvWithRms(CURVE_6_POINTS_NED), "curve_6_points.csv");
    expect(parsed.points.some((p) => p.hrms_m != null)).toBe(true);

    const lines = localCsvPointsToPlanLines(parsed.points);
    expect(lines).toHaveLength(1);
    const pts = lines[0].entity?.preview_points ?? [];
    const turns = jointTurnsDeg(pts);

    // Before the RMS-scaled gate: turns ranged 1.01°-2.96° across this same span (a per-vertex
    // implied radius swinging 1.48 m-4.90 m). A true arc turns the same amount at every joint.
    const spread = Math.max(...turns) - Math.min(...turns);
    expect(spread).toBeLessThan(0.1);
  });

  it("without a reported RMS, the same points still fall back to fillets (documents the near miss)", () => {
    const parsed = parseLocalPointCsv(
      csvWithoutRms(CURVE_6_POINTS_NED),
      "curve_6_points_no_rms.csv"
    );
    expect(parsed.points.every((p) => p.hrms_m == null)).toBe(true);

    const lines = localCsvPointsToPlanLines(parsed.points);
    const pts = lines[0].entity?.preview_points ?? [];
    const turns = jointTurnsDeg(pts);
    // The fixed 0.05 m gate rejects this fit by 1.8 mm — still a visible spread, unlike above.
    const spread = Math.max(...turns) - Math.min(...turns);
    expect(spread).toBeGreaterThan(1);
  });
});

describe("buildCsvTransitLines", () => {
  it("connects consecutive group paths with a straight, no-spray-style transit line", () => {
    const rows = ["feature,north,east"];
    for (let i = 0; i < 10; i++) rows.push(`West circle,${i * 0.5},${0}`);
    for (let i = 0; i < 10; i++) rows.push(`East circle,${30 + i * 0.5},${30}`);
    const r = parseLocalPointCsv(rows.join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(2);

    const transit = buildCsvTransitLines(lines);
    expect(transit).toHaveLength(1);
    expect(transit[0].layer).toBe("transit");
    expect(transit[0].segmentRole).toBe("none");
    expect(transit[0].entity?.entity_type).toBe("TRANSIT");
    // FROM = end of the first group's path, TO = start of the second's — same convention
    // as the backend's inter-shape connector (path_engine's transit segments) and the
    // frontend's existing DXF transit overlay (buildRuntimeTransitOverlayFromPlan).
    expect(transit[0].from.x).toBeCloseTo(lines[0].to.x, 6);
    expect(transit[0].from.y).toBeCloseTo(lines[0].to.y, 6);
    expect(transit[0].to.x).toBeCloseTo(lines[1].from.x, 6);
    expect(transit[0].to.y).toBeCloseTo(lines[1].from.y, 6);
  });

  it("produces N-1 transit lines for N groups, in file order", () => {
    const rows = ["road,north,east"];
    for (let i = 0; i < 10; i++) rows.push(`A,${i * 0.5},0`);
    for (let i = 0; i < 10; i++) rows.push(`B,${20 + i * 0.5},20`);
    for (let i = 0; i < 10; i++) rows.push(`C,${40 + i * 0.5},40`);
    const r = parseLocalPointCsv(rows.join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(3);

    const transit = buildCsvTransitLines(lines);
    expect(transit).toHaveLength(2);
    expect(transit[0].label).toContain("A");
    expect(transit[0].label).toContain("B");
    expect(transit[1].label).toContain("B");
    expect(transit[1].label).toContain("C");
  });

  it("produces no transit lines for a single-group (single-path) CSV", () => {
    const rows = ["road,north,east"];
    for (let i = 0; i < 15; i++) rows.push(`Main St,${i * 0.5},0`);
    const r = parseLocalPointCsv(rows.join("\n"));
    const lines = localCsvPointsToPlanLines(r.points);
    expect(lines).toHaveLength(1);
    expect(buildCsvTransitLines(lines)).toHaveLength(0);
  });

  it("skips a connector when two group paths already touch (no real gap)", () => {
    const lines = [
      {
        id: "a",
        label: "A",
        layer: "marking" as const,
        from: { id: 1, x: 0, y: 0 },
        to: { id: 2, x: 10, y: 0 },
        width: 0.1,
      },
      {
        id: "b",
        label: "B",
        layer: "marking" as const,
        from: { id: 3, x: 10, y: 0 },
        to: { id: 4, x: 20, y: 0 },
        width: 0.1,
      },
    ];
    expect(buildCsvTransitLines(lines)).toHaveLength(0);
  });
});

describe("survey quality warnings (Phase 6)", () => {
  it("warns on non-FIX, single-epoch, and high HRMS without blocking parse", () => {
    const text = [
      "lat,lon,solution status,samples,horizontal rms,pdop",
      "13.0,80.0,FIX,10,0.01,1.2",
      "13.001,80.0,FLOAT,1,0.12,2.5",
    ].join("\n");
    const r = parseLocalPointCsv(text, "quality.csv");
    expect(r.num_points).toBe(2);
    expect(r.points[1].fix_status).toMatch(/FLOAT/i);
    expect(r.points[1].samples).toBe(1);
    expect(r.warnings.some((w) => /FIX/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /epoch|sample/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /RMS/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /PDOP/i.test(w))).toBe(true);
  });
});

describe("localCsvToMapPins", () => {
  it("includes lat/lon for GPS pins (direct map draw like guide CSV)", () => {
    const r = parseLocalPointCsv(["lat,lon", "13,80", "13.001,80"].join("\n"));
    const pins = localCsvToMapPins(r);
    expect(pins).toHaveLength(2);
    expect(pins[0].lat).toBe(13);
    expect(pins[0].lon).toBe(80);
  });

  it("samples evenly when over pin cap", () => {
    const rows = ["lat,lon", ...Array.from({ length: 200 }, (_, i) => `${13 + i * 0.0001},80`)];
    const r = parseLocalPointCsv(rows.join("\n"));
    const pins = localCsvToMapPins(r, 50);
    expect(pins.length).toBe(50);
    expect(pins[0].lat).toBeCloseTo(13, 5);
    expect(pins[pins.length - 1].lat).toBeCloseTo(13 + 199 * 0.0001, 5);
  });
});

describe("sampleEvenly", () => {
  it("returns all when under cap", () => {
    expect(sampleEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});
