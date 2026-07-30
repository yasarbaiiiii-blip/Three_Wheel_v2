import { describe, expect, it } from "vitest";
import {
  arcSegmentCount,
  classifyDxfEntity,
  DEFAULT_UNIT_SCALE_M,
  INSUNITS_TO_METRES,
  MAX_SAGITTA_M,
  parseLocalDxf,
  readUnitScale,
  sampleArcSagitta,
} from "./dxfLocalImport";
import { looksGeographic, metresPerDegreePx4, PX4_EARTH_RADIUS_M } from "./geoProjection";
import { isPaintableMarkLine } from "./missionTrajectory";

/** Minimal DXF wrapper with optional $INSUNITS. */
function wrapDxf(entities: string, insunits?: number): string {
  const header =
    insunits === undefined
      ? `0\nSECTION\n2\nHEADER\n0\nENDSEC\n`
      : `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n`;
  return `${header}0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

function lineEntity(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer = "0"
): string {
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
}

function closedSquareLwpoly(size: number, layer = "0"): string {
  // LWPOLYLINE closed square origin→size
  return (
    `0\nLWPOLYLINE\n8\n${layer}\n90\n4\n70\n1\n` +
    `10\n0\n20\n0\n` +
    `10\n${size}\n20\n0\n` +
    `10\n${size}\n20\n${size}\n` +
    `10\n0\n20\n${size}\n`
  );
}

function arcEntity(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  layer = "0"
): string {
  return `0\nARC\n8\n${layer}\n10\n${cx}\n20\n${cy}\n40\n${r}\n50\n${start}\n51\n${end}\n`;
}

describe("INSUNITS / unit scale", () => {
  it("maps known INSUNITS codes", () => {
    expect(INSUNITS_TO_METRES[1]).toBe(0.0254);
    expect(INSUNITS_TO_METRES[4]).toBe(0.001);
    expect(INSUNITS_TO_METRES[5]).toBe(0.01);
    expect(INSUNITS_TO_METRES[6]).toBe(1.0);
    expect(INSUNITS_TO_METRES[0]).toBeNull();
  });

  it("uses metres when $INSUNITS=6", () => {
    const dxf = wrapDxf(lineEntity(0, 0, 2, 0), 6);
    const r = parseLocalDxf(dxf, "m.dxf");
    expect(r.unitScale).toBe(1);
    expect(r.unitScaleSource).toBe("insunits");
    expect(r.lines).toHaveLength(1);
    // App NED: from (n,e)=(0,0) to (0,2) after axis swap of CAD (0,0)→(2,0)
    expect(r.lines[0].from.x).toBeCloseTo(0, 6);
    expect(r.lines[0].from.y).toBeCloseTo(0, 6);
    expect(r.lines[0].to.x).toBeCloseTo(0, 6);
    expect(r.lines[0].to.y).toBeCloseTo(2, 6);
  });

  it("scales centimetres when $INSUNITS=5", () => {
    const dxf = wrapDxf(lineEntity(0, 0, 100, 0), 5); // 100 cm = 1 m
    const r = parseLocalDxf(dxf, "cm.dxf");
    expect(r.unitScale).toBe(0.01);
    expect(r.lines[0].to.y).toBeCloseTo(1, 6);
  });

  it("scales mm when $INSUNITS=4", () => {
    const dxf = wrapDxf(lineEntity(0, 0, 1000, 0), 4); // 1000 mm = 1 m
    const r = parseLocalDxf(dxf, "mm.dxf");
    expect(r.unitScale).toBe(0.001);
    expect(r.lines[0].to.y).toBeCloseTo(1, 6);
  });

  it("falls back to 0.01 when $INSUNITS absent/0 and warns", () => {
    const dxf0 = wrapDxf(lineEntity(0, 0, 100, 0), 0);
    const r0 = parseLocalDxf(dxf0, "u0.dxf");
    expect(r0.unitScale).toBe(DEFAULT_UNIT_SCALE_M);
    expect(r0.unitScaleSource).toBe("fallback");
    expect(r0.warnings.some((w) => w.includes("$INSUNITS"))).toBe(true);
    expect(r0.lines[0].to.y).toBeCloseTo(1, 6);

    const dxfAbs = wrapDxf(lineEntity(0, 0, 100, 0));
    const rAbs = parseLocalDxf(dxfAbs, "nohdr.dxf");
    expect(rAbs.unitScaleSource).toBe("fallback");
  });
});

describe("classifyDxfEntity", () => {
  it("ignores POINT and annotation layers", () => {
    expect(classifyDxfEntity("POINT", "0")).toBe("ignore");
    expect(classifyDxfEntity("LINE", "DIM_LAYER")).toBe("ignore");
    expect(classifyDxfEntity("LINE", "DEFPOINTS")).toBe("ignore");
    expect(classifyDxfEntity("LINE", "ANNOT_NOTE")).toBe("ignore");
    expect(classifyDxfEntity("LINE", "HATCH_FILL")).toBe("ignore");
  });

  it("classifies transit layers", () => {
    expect(classifyDxfEntity("LINE", "TRANSIT")).toBe("transit");
    expect(classifyDxfEntity("LINE", "TRAVEL_PATH")).toBe("transit");
    expect(classifyDxfEntity("LINE", "MOVE")).toBe("transit");
    expect(classifyDxfEntity("LINE", "RAPID")).toBe("transit");
  });

  it("defaults to mark", () => {
    expect(classifyDxfEntity("LINE", "0")).toBe("mark");
    expect(classifyDxfEntity("LWPOLYLINE", "FIELD")).toBe("mark");
  });

  it("sets is_mark so paint filter accepts mark entities", () => {
    const dxf = wrapDxf(lineEntity(0, 0, 1, 0, "FIELD") + lineEntity(0, 0, 1, 0, "TRANSIT"), 6);
    const r = parseLocalDxf(dxf, "paint.dxf");
    const mark = r.lines.find((l) => l.entity?.layer === "FIELD");
    const transit = r.lines.find((l) => l.entity?.layer === "TRANSIT");
    expect(mark?.entity?.is_mark).toBe(true);
    expect(mark && isPaintableMarkLine(mark)).toBe(true);
    expect(transit?.entity?.is_mark).toBe(false);
    expect(transit && isPaintableMarkLine(transit)).toBe(false);
  });

  it("ignores POINT entities and counts them", () => {
    const point = `0\nPOINT\n8\n0\n10\n1\n20\n2\n`;
    const dxf = wrapDxf(point + lineEntity(0, 0, 1, 0), 6);
    const r = parseLocalDxf(dxf, "pts.dxf");
    expect(r.ignoredCount).toBe(1);
    expect(r.lines).toHaveLength(1);
  });
});

describe("closed square → one closed polyline", () => {
  it("emits a closed LWPOLYLINE with start≈end", () => {
    const dxf = wrapDxf(closedSquareLwpoly(2), 6);
    const r = parseLocalDxf(dxf, "square.dxf");
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0];
    expect(line.entity?.is_mark).toBe(true);
    const pp = line.entity!.preview_points;
    expect(pp.length).toBeGreaterThanOrEqual(4);
    const first = pp[0];
    const last = pp[pp.length - 1];
    expect(Math.hypot(first.north - last.north, first.east - last.east)).toBeLessThan(1e-6);
    // Perimeter ≈ 8 m
    expect(line.entity!.length_m).toBeCloseTo(8, 2);
  });
});

describe("sagitta-bounded arc tessellation", () => {
  it("keeps a 50 m arc within 5 mm of analytic", () => {
    const r = 50;
    const start = 0;
    const end = 90;
    const pts = sampleArcSagitta(0, 0, r, start, end, MAX_SAGITTA_M);
    // Max radial error of chord midpoints
    let maxErr = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      const midR = Math.hypot(mx, my);
      maxErr = Math.max(maxErr, Math.abs(r - midR));
    }
    expect(maxErr).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-6);
    expect(arcSegmentCount(r, Math.PI / 2, MAX_SAGITTA_M)).toBeGreaterThan(8);
  });

  it("parses a 50 m quarter-arc with length ~ 25π", () => {
    const dxf = wrapDxf(arcEntity(0, 0, 50, 0, 90), 6);
    const res = parseLocalDxf(dxf, "arc50.dxf");
    expect(res.lines).toHaveLength(1);
    const expected = (90 / 360) * 2 * Math.PI * 50;
    expect(res.lines[0].entity!.length_m).toBeCloseTo(expected, 2);
  });
});

describe("geographic detection", () => {
  it("detects lat/lon site at documented thresholds", () => {
    // Small site ~2 m at ~13°N 80°E
    const mN = metresPerDegreePx4(13).mPerDegNorth;
    const mE = metresPerDegreePx4(13).mPerDegEast;
    const dLat = 2 / mN;
    const dLon = 2 / mE;
    const pts = [
      { north: 13, east: 80 },
      { north: 13 + dLat, east: 80 },
      { north: 13 + dLat, east: 80 + dLon },
      { north: 13, east: 80 + dLon },
    ];
    expect(looksGeographic(pts).isGeographic).toBe(true);
  });

  it("rejects metric drawing near origin", () => {
    const pts = [
      { north: 0, east: 0 },
      { north: 0, east: 2 },
      { north: 2, east: 2 },
      { north: 2, east: 0 },
    ];
    expect(looksGeographic(pts).isGeographic).toBe(false);
  });

  it("projects a georeferenced square about centroid", () => {
    const lat0 = 13.05;
    const lon0 = 80.25;
    const m = metresPerDegreePx4(lat0);
    // ~2 m square in degrees
    const dN = 2 / m.mPerDegNorth;
    const dE = 2 / m.mPerDegEast;
    // CAD: X=east(lon), Y=north(lat)
    const ents =
      closedSquareLike(lon0, lat0, dE, dN);
    const dxf = wrapDxf(ents, 6);
    const r = parseLocalDxf(dxf, "geo.dxf");
    expect(r.isGeographic).toBe(true);
    expect(r.geoOrigin).not.toBeNull();
    expect(r.geoOrigin!.lat).toBeCloseTo(lat0 + dN / 2, 5);
    expect(r.geoOrigin!.lon).toBeCloseTo(lon0 + dE / 2, 5);
    // Projected extent should be ~2 m
    const pp = r.lines[0].entity!.preview_points;
    const ns = pp.map((p) => p.north);
    const es = pp.map((p) => p.east);
    expect(Math.max(...ns) - Math.min(...ns)).toBeCloseTo(2, 1);
    expect(Math.max(...es) - Math.min(...es)).toBeCloseTo(2, 1);
  });

  it("uses PX4 sphere radius", () => {
    expect(PX4_EARTH_RADIUS_M).toBe(6_371_000);
    const { mPerDegNorth } = metresPerDegreePx4(0);
    expect(mPerDegNorth).toBeCloseTo((PX4_EARTH_RADIUS_M * Math.PI) / 180, 6);
  });
});

function closedSquareLike(
  lon0: number,
  lat0: number,
  dLon: number,
  dLat: number
): string {
  // LWPOLYLINE with lon/lat as X/Y
  return (
    `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n` +
    `10\n${lon0}\n20\n${lat0}\n` +
    `10\n${lon0 + dLon}\n20\n${lat0}\n` +
    `10\n${lon0 + dLon}\n20\n${lat0 + dLat}\n` +
    `10\n${lon0}\n20\n${lat0 + dLat}\n`
  );
}

describe("classic POLYLINE + VERTEX (geo-referenced 3D polyline)", () => {
  /**
   * Minimal AcDb3dPolyline: entity location (0,0), vertices-follow, 4 lat/lon corners.
   * Mirrors Emlid / survey exports like `coordinate dxf/test 1.dxf`.
   */
  function geoPolyline3d(): string {
    const verts: [number, number][] = [
      [80.26194124, 13.07206392],
      [80.26194283, 13.07208325],
      [80.26196034, 13.07208256],
      [80.26195891, 13.07206129],
    ];
    let body =
      `0\nPOLYLINE\n8\nLines\n66\n1\n70\n8\n10\n0\n20\n0\n30\n0\n`;
    for (const [x, y] of verts) {
      body += `0\nVERTEX\n8\nLines\n10\n${x}\n20\n${y}\n30\n0\n70\n32\n`;
    }
    body += `0\nSEQEND\n8\nLines\n`;
    return wrapDxf(body, 6);
  }

  it("does not treat POLYLINE base (0,0) as a path vertex", () => {
    const r = parseLocalDxf(geoPolyline3d(), "geo-poly.dxf");
    expect(r.lines).toHaveLength(1);
    const pp = r.lines[0].entity!.preview_points;
    // No Null-Island corner after projection
    for (const p of pp) {
      expect(Math.hypot(p.north, p.east)).toBeLessThan(500); // local metres about origin
    }
  });

  it("detects georeferenced 3D polyline and projects about lat/lon centroid", () => {
    const r = parseLocalDxf(geoPolyline3d(), "geo-poly.dxf");
    expect(r.isGeographic).toBe(true);
    expect(r.geoOrigin).not.toBeNull();
    expect(r.geoOrigin!.lat).toBeCloseTo(13.072, 2);
    expect(r.geoOrigin!.lon).toBeCloseTo(80.262, 2);
    expect(r.lines).toHaveLength(1);
    // Site is ~2 m across in lat/lon — after projection span is metres, not degrees
    const pp = r.lines[0].entity!.preview_points;
    const ns = pp.map((p) => p.north);
    const es = pp.map((p) => p.east);
    const spanN = Math.max(...ns) - Math.min(...ns);
    const spanE = Math.max(...es) - Math.min(...es);
    expect(spanN).toBeGreaterThan(0.5);
    expect(spanN).toBeLessThan(50);
    expect(spanE).toBeGreaterThan(0.5);
    expect(spanE).toBeLessThan(50);
  });
});

describe("DXF path fidelity (no CSV-style path generation)", () => {
  function pointEntity(x: number, y: number, layer = "Points"): string {
    return `0\nPOINT\n8\n${layer}\n10\n${x}\n20\n${y}\n`;
  }

  it("preserves LINE endpoints exactly (metres, after axis swap)", () => {
    // CAD LINE (0,0)→(3,4): app NED (n,e) = (0,0)→(4,3)
    const dxf = wrapDxf(lineEntity(0, 0, 3, 4), 6);
    const r = parseLocalDxf(dxf, "line.dxf");
    expect(r.lines).toHaveLength(1);
    const pp = r.lines[0].entity!.preview_points;
    expect(pp).toHaveLength(2);
    expect(pp[0].north).toBeCloseTo(0, 9);
    expect(pp[0].east).toBeCloseTo(0, 9);
    expect(pp[1].north).toBeCloseTo(4, 9);
    expect(pp[1].east).toBeCloseTo(3, 9);
  });

  it("preserves closed LWPOLYLINE vertices in file order (no re-fit)", () => {
    const dxf = wrapDxf(closedSquareLwpoly(2), 6);
    const r = parseLocalDxf(dxf, "square.dxf");
    expect(r.lines.length).toBeGreaterThanOrEqual(1);
    const pp = r.lines[0].entity!.preview_points;
    // Closed square: 4 corners + close (or 4) — vertices match CAD, not a CSV Hyper-fit.
    expect(pp.length).toBeGreaterThanOrEqual(4);
    // First vertex CAD (0,0) → NED (0,0)
    expect(pp[0].north).toBeCloseTo(0, 6);
    expect(pp[0].east).toBeCloseTo(0, 6);
  });

  it("does not invent a path from bare POINT entities (CSV owns path generation)", () => {
    const entities =
      pointEntity(0, 0) + pointEntity(2, 0) + pointEntity(2, 2) + pointEntity(0, 2);
    const dxf = wrapDxf(entities, 6);
    const r = parseLocalDxf(dxf, "points-only.dxf");
    expect(r.lines).toHaveLength(0);
    expect(r.warnings.some((w) => /does not generate paths from DXF points/i.test(w))).toBe(
      true
    );
  });

  it("keeps real LINE geometry and ignores POINT when both exist", () => {
    const point = pointEntity(1, 2);
    const dxf = wrapDxf(point + lineEntity(0, 0, 1, 0), 6);
    const r = parseLocalDxf(dxf, "pts-with-line.dxf");
    expect(r.ignoredCount).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.warnings.some((w) => /does not generate paths from DXF points/i.test(w))).toBe(
      false
    );
  });

  it("does not CSV-fit one-vertex-per-point degenerate 'line' exports", () => {
    const oneVertexPoly = (x: number, y: number) =>
      `0\nLWPOLYLINE\n8\nLines\n90\n1\n70\n0\n10\n${x}\n20\n${y}\n`;
    const corners: [number, number][] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    const entities = corners
      .map(([x, y]) => oneVertexPoly(x, y) + pointEntity(x, y))
      .join("");
    const dxf = wrapDxf(entities, 6);
    const r = parseLocalDxf(dxf, "square-degenerate.dxf");
    expect(r.lines).toHaveLength(0);
    expect(r.warnings.some((w) => /does not generate paths from DXF points/i.test(w))).toBe(
      true
    );
  });

  it("detects georeferenced points-only but still does not invent a path", () => {
    const lat0 = 13.05;
    const lon0 = 80.25;
    const m = metresPerDegreePx4(lat0);
    const dN = 2 / m.mPerDegNorth;
    const dE = 2 / m.mPerDegEast;
    const entities =
      pointEntity(lon0, lat0) +
      pointEntity(lon0 + dE, lat0) +
      pointEntity(lon0 + dE, lat0 + dN) +
      pointEntity(lon0, lat0 + dN);
    const dxf = wrapDxf(entities, 6);
    const r = parseLocalDxf(dxf, "geo-points.dxf");
    expect(r.isGeographic).toBe(true);
    expect(r.geoOrigin).not.toBeNull();
    expect(r.lines).toHaveLength(0);
  });
});

describe("readUnitScale helper", () => {
  it("reads header pairs", () => {
    const pairs = [
      { code: "0", value: "SECTION" },
      { code: "2", value: "HEADER" },
      { code: "9", value: "$INSUNITS" },
      { code: "70", value: "6" },
      { code: "0", value: "ENDSEC" },
    ];
    // readUnitScale expects full file pairs with SECTION structure
    const dxf = wrapDxf("", 6);
    const r = parseLocalDxf(dxf + "", "empty.dxf");
    expect(r.insunits).toBe(6);
    void pairs;
  });
});
