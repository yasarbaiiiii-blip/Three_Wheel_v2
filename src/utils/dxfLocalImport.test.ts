import { describe, expect, it } from "vitest";
import {
  arcSegmentCount,
  classifyDxfEntity,
  DEFAULT_UNIT_SCALE_M,
  fitPointNurbs,
  INSUNITS_TO_METRES,
  MAX_DXF_ENTITIES,
  MAX_SAGITTA_M,
  mergeLocalDxfResults,
  nurbsPoint,
  parseLocalDxf,
  readUnitScale,
  tessellateEllipseArc,
} from "./dxfLocalImport";
import { getCurveGeometry } from "./curveGeometry";
import {
  groundDistanceMeters,
  looksGeographic,
  metresPerDegree,
  projectGpsToLocalMeters,
} from "./geoProjection";
import { evaluateCsvSendReadiness, isCriticalParseWarning } from "./missionReadiness";
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
    expect(r0.blockingWarnings.some((w) => w.includes("$INSUNITS"))).toBe(true);
    expect(r0.warnings.some((w) => w.includes("$INSUNITS"))).toBe(false);
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
    const pts = tessellateEllipseArc(
      { cx: 0, cy: 0, ux: r, uy: 0, vx: 0, vy: r, t0: (start * Math.PI) / 180, t1: (end * Math.PI) / 180 },
      MAX_SAGITTA_M
    );
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

describe("sagitta bound is metres regardless of $INSUNITS", () => {
  /** The same physical 50 m quarter arc, declared in five different unit systems. */
  const FIFTY_METRE_ARC: Array<{ label: string; insunits: number; radius: number }> = [
    { label: "mm", insunits: 4, radius: 50000 },
    { label: "cm", insunits: 5, radius: 5000 },
    { label: "m", insunits: 6, radius: 50 },
    { label: "km", insunits: 7, radius: 0.05 },
    { label: "inch", insunits: 1, radius: 50 / 0.0254 },
  ];

  /** Worst chord-midpoint radial error, in metres, against a 50 m arc centred on the origin. */
  function achievedSagitta(pts: Array<{ north: number; east: number }>): number {
    let worst = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const mN = (pts[i].north + pts[i + 1].north) / 2;
      const mE = (pts[i].east + pts[i + 1].east) / 2;
      worst = Math.max(worst, Math.abs(50 - Math.hypot(mN, mE)));
    }
    return worst;
  }

  it.each(FIFTY_METRE_ARC)(
    "$label drawing tessellates the same 50 m arc identically",
    ({ insunits, radius }) => {
      const r = parseLocalDxf(wrapDxf(arcEntity(0, 0, radius, 0, 90), insunits), "arc.dxf");
      const pp = r.lines[0].entity!.preview_points;
      // 56 chords is what a 5 mm sagitta costs on r = 50 m; the unit system is
      // irrelevant to that, which is the whole point. Comparing the 0.005 bound
      // against a radius in file units instead gave 1758 points for mm and 5 for km.
      expect(pp.length).toBe(57);
      const sagitta = achievedSagitta(pp);
      expect(sagitta).toBeLessThanOrEqual(MAX_SAGITTA_M);
      // Two-sided: an over-dense tessellation (mm was 5 µm) is a defect too.
      expect(sagitta).toBeGreaterThan(MAX_SAGITTA_M / 2);
      expect(r.lines[0].entity!.length_m).toBeCloseTo((90 / 360) * 2 * Math.PI * 50, 1);
    }
  );

  it("does not under-sample a km drawing", () => {
    // Was arcSegmentCount's 4-segment floor: 5 points at a 0.96 m sagitta, 192x over spec.
    const r = parseLocalDxf(wrapDxf(arcEntity(0, 0, 0.05, 0, 90), 7), "arc-km.dxf");
    const pp = r.lines[0].entity!.preview_points;
    expect(pp.length).toBeGreaterThan(5);
    expect(achievedSagitta(pp)).toBeLessThan(0.01);
  });

  it("does not over-sample a mm drawing", () => {
    // Was 1758 points — a 0.005 mm bound, ~32x denser than the 5 mm spec asks for.
    const r = parseLocalDxf(wrapDxf(arcEntity(0, 0, 50000, 0, 90), 4), "arc-mm.dxf");
    expect(r.lines[0].entity!.preview_points.length).toBeLessThan(200);
  });
});

describe("geographic ARC/CIRCLE tessellation", () => {
  /**
   * Real geo-DXF chain (verified 2026-08-01): LINE → ARC → LINE authored
   * tangent-continuous in WGS84 degrees at ~13.0721 N / 80.2620 E.
   * Arc radius 9.9596381450e-06 deg = 1.1075 m; each LINE is 0.906 m.
   */
  function geoTangentChainDxf(): string {
    return wrapDxf(
      lineEntity(80.26194119, 13.07206386, 80.2619495372, 13.0720633206) +
        arcEntity(80.2619502141, 13.0720732584, 9.959638145e-6, 266.2044, 356.2044) +
        lineEntity(80.2619604162, 13.0720725991, 80.26196097, 13.07208073),
      6
    );
  }

  /** Max radial deviation of chord midpoints — the sagitta the tessellation actually achieves. */
  function maxSagittaOf(
    pts: Array<{ north: number; east: number }>,
    centerNorth: number,
    centerEast: number,
    radius: number
  ): number {
    let worst = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const mN = (pts[i].north + pts[i + 1].north) / 2;
      const mE = (pts[i].east + pts[i + 1].east) / 2;
      worst = Math.max(worst, Math.abs(radius - Math.hypot(mN - centerNorth, mE - centerEast)));
    }
    return worst;
  }

  function polyLen(pts: Array<{ north: number; east: number }>): number {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].north - pts[i - 1].north, pts[i].east - pts[i - 1].east);
    }
    return len;
  }

  it("bounds the sagitta in metres, not degrees", () => {
    const r = parseLocalDxf(geoTangentChainDxf(), "geo-arc-chain.dxf");
    expect(r.isGeographic).toBe(true);
    expect(r.lines).toHaveLength(3);

    const arc = r.lines[1];
    expect(arc.entity!.entity_type).toBe("ARC");
    const pp = arc.entity!.preview_points;
    // The degree-space bug clamped to arcSegmentCount's 4-segment floor (5 points).
    expect(pp.length).toBeGreaterThanOrEqual(10);

    const geom = arc.entity!.geometry as {
      centerNorth: number;
      centerEast: number;
      radius: number;
    };
    expect(maxSagittaOf(pp, geom.centerNorth, geom.centerEast, geom.radius)).toBeLessThanOrEqual(
      MAX_SAGITTA_M + 1e-6
    );
    // Radius is 9.959638145e-6 deg scaled by the WGS84 north rate; the inscribed
    // polyline sits just inside the true quarter-circle length.
    const mN = metresPerDegree(r.geoOrigin!.lat).mPerDegNorth;
    expect(polyLen(pp)).toBeCloseTo((9.959638145e-6 * mN * Math.PI) / 2, 2);
  });

  it("keeps entities that touch in the source touching after projection", () => {
    const r = parseLocalDxf(geoTangentChainDxf(), "geo-arc-chain.dxf");
    const [line1, arc, line2] = r.lines;
    const arcPp = arc.entity!.preview_points;
    const l1Pp = line1.entity!.preview_points;
    const l2Pp = line2.entity!.preview_points;

    const gapIn = Math.hypot(
      l1Pp[l1Pp.length - 1].north - arcPp[0].north,
      l1Pp[l1Pp.length - 1].east - arcPp[0].east
    );
    const gapOut = Math.hypot(
      arcPp[arcPp.length - 1].north - l2Pp[0].north,
      arcPp[arcPp.length - 1].east - l2Pp[0].east
    );
    // Sampling in degree space and projecting the samples left 1.9 mm / 28.6 mm here.
    // The file was authored on a spherical-earth model, whose north/east rate ratio
    // differs from WGS84 by 0.56%, so the arc end (radius scaled by the north rate)
    // and the east-projected LINE start now differ by up to ~7 mm over this 1.1 m arc.
    expect(gapIn).toBeLessThan(1e-2);
    expect(gapOut).toBeLessThan(1e-2);

    // Straights are untouched by the curve pass and stay true to the file.
    expect(polyLen(l1Pp)).toBeCloseTo(
      groundDistanceMeters(13.07206386, 80.26194119, 13.0720633206, 80.2619495372),
      6
    );
    expect(polyLen(l2Pp)).toBeCloseTo(
      groundDistanceMeters(13.0720725991, 80.2619604162, 13.07208073, 80.26196097),
      6
    );
  });

  it("stores curve geometry in the same metre frame as preview_points", () => {
    const r = parseLocalDxf(geoTangentChainDxf(), "geo-arc-chain.dxf");
    const arc = r.lines[1];
    const geom = arc.entity!.geometry as {
      centerNorth: number;
      centerEast: number;
      radius: number;
      startAngle: number;
      endAngle: number;
    };
    // georef.py scales the radius by the NORTH rate: 9.959638145e-6 deg * WGS84 north rate.
    const mN = metresPerDegree(r.geoOrigin!.lat).mPerDegNorth;
    expect(geom.radius).toBeCloseTo(9.959638145e-6 * mN, 9);
    expect(geom.startAngle).toBeCloseTo(266.2044, 6);
    expect(geom.endAngle).toBeCloseTo(356.2044, 6);
    // Centre is metres about the geo origin — a degree-space centre would be ~80.
    expect(Math.hypot(geom.centerNorth, geom.centerEast)).toBeLessThan(50);
    for (const p of arc.entity!.preview_points) {
      expect(Math.hypot(p.north - geom.centerNorth, p.east - geom.centerEast)).toBeCloseTo(
        geom.radius,
        6
      );
    }
    // getCurveGeometry (map/SVG rendering) must agree with the samples.
    const curve = getCurveGeometry(arc)!;
    expect(curve.radius).toBeCloseTo(geom.radius, 9);
    expect(curve.centerNorth).toBeCloseTo(geom.centerNorth, 9);
  });

  it("re-derives geographic bulge segments from projected endpoints", () => {
    // Same 90° arc expressed as an LWPOLYLINE bulge: tan(sweep/4) = tan(22.5°).
    const bulge = Math.tan((Math.PI / 180) * 22.5);
    const dxf = wrapDxf(
      `0\nLWPOLYLINE\n8\n0\n90\n2\n70\n0\n` +
        `10\n80.26194955461\n20\n13.07206332063\n42\n${bulge}\n` +
        `10\n80.2619604162\n20\n13.0720725991\n`,
      6
    );
    const r = parseLocalDxf(dxf, "geo-bulge.dxf");
    expect(r.isGeographic).toBe(true);
    const pp = r.lines[0].entity!.preview_points;
    expect(pp.length).toBeGreaterThanOrEqual(10);
    let maxChord = 0;
    for (let i = 1; i < pp.length; i++) {
      maxChord = Math.max(
        maxChord,
        Math.hypot(pp[i].north - pp[i - 1].north, pp[i].east - pp[i - 1].east)
      );
    }
    expect(maxChord).toBeLessThan(0.25);
    expect(polyLen(pp)).toBeCloseTo(1.736, 2);
  });

  it("leaves metric arcs alone (mm drawing stays dense and correctly scaled)", () => {
    // 50 000 mm = 50 m quarter arc.
    const r = parseLocalDxf(wrapDxf(arcEntity(0, 0, 50000, 0, 90), 4), "arc-mm.dxf");
    expect(r.isGeographic).toBe(false);
    expect(r.unitScale).toBe(0.001);
    const entity = r.lines[0].entity!;
    const geom = entity.geometry as { centerNorth: number; centerEast: number; radius: number };
    expect(geom.radius).toBeCloseTo(50, 9);
    expect(geom.centerNorth).toBeCloseTo(0, 9);
    expect(entity.length_m).toBeCloseTo((90 / 360) * 2 * Math.PI * 50, 2);
    // 57 points: the sagitta bound is metres, so this matches the identical arc
    // declared in metres/km/inches (see "sagitta bound is metres regardless of
    // $INSUNITS"). Before that fix a mm drawing produced 1758.
    expect(entity.preview_points.length).toBe(57);
    expect(maxSagittaOf(entity.preview_points, 0, 0, 50)).toBeLessThanOrEqual(MAX_SAGITTA_M);
  });
});

describe("geographic detection", () => {
  it("detects lat/lon site at documented thresholds", () => {
    // Small site ~2 m at ~13°N 80°E
    const mN = metresPerDegree(13).mPerDegNorth;
    const mE = metresPerDegree(13).mPerDegEast;
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
    const m = metresPerDegree(lat0);
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

  it("uses WGS84 ellipsoid rates, not a sphere", () => {
    // WGS84: 110574.28 m per degree of latitude at the equator, 111319.49 m per degree of longitude.
    const eq = metresPerDegree(0);
    expect(eq.mPerDegNorth).toBeCloseTo(110574.2758, 3);
    expect(eq.mPerDegEast).toBeCloseTo(111319.4908, 2);
    // Rates vary with latitude on the ellipsoid (a sphere would give 111194.93 everywhere).
    expect(metresPerDegree(60).mPerDegNorth).toBeGreaterThan(111400);
  });

  it("projects a geographic file with the WGS84 module (true ground metres)", () => {
    const lat0 = 60;
    const lon0 = 10;
    const dLat = 0.0001;
    const dLon = 0.0002;
    const dxf = wrapDxf(lineEntity(lon0, lat0, lon0 + dLon, lat0 + dLat), 6);
    const r = parseLocalDxf(dxf, "geo-wgs84.dxf");
    expect(r.isGeographic).toBe(true);
    const pp = r.lines[0].entity!.preview_points;
    const rates = metresPerDegree(lat0 + dLat / 2);
    expect(pp[1].north - pp[0].north).toBeCloseTo(dLat * rates.mPerDegNorth, 6);
    expect(pp[1].east - pp[0].east).toBeCloseTo(dLon * rates.mPerDegEast, 6);
    expect(r.warnings.some((w) => /WGS84/.test(w))).toBe(true);
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
    const m = metresPerDegree(lat0);
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

describe("mergeLocalDxfResults (multi-file Select File)", () => {
  it("returns single result unchanged", () => {
    const a = parseLocalDxf(wrapDxf(lineEntity(0, 0, 2, 0), 6), "a.dxf");
    expect(mergeLocalDxfResults([a])).toBe(a);
  });

  it("merges metric DXFs with unique line ids", () => {
    const a = parseLocalDxf(wrapDxf(lineEntity(0, 0, 2, 0), 6), "part_a.dxf");
    const b = parseLocalDxf(wrapDxf(lineEntity(0, 0, 0, 3), 6), "part_b.dxf");
    const m = mergeLocalDxfResults([a, b]);
    expect(m.isGeographic).toBe(false);
    expect(m.lines).toHaveLength(2);
    expect(m.fileName).toBe("part_a_x2.dxf");
    expect(m.lines[0].id).toContain("part_a");
    expect(m.lines[1].id).toContain("part_b");
    // Distinct ids even though both parses start at LINE-0.
    expect(m.lines[0].id).not.toBe(m.lines[1].id);
  });

  it("merges georeferenced DXFs onto the first file's origin", () => {
    const lat0 = 13.05;
    const lon0 = 80.25;
    const mpd = metresPerDegree(lat0);
    // Small square-ish lines in geographic degrees near lat0/lon0.
    const dN = 0.0002; // ~22 m
    const dE = 0.0002;
    const geoA = wrapDxf(
      lineEntity(lon0, lat0, lon0 + dE, lat0) + lineEntity(lon0 + dE, lat0, lon0 + dE, lat0 + dN),
      6
    );
    const lat1 = lat0 + 0.001;
    const lon1 = lon0;
    const geoB = wrapDxf(
      lineEntity(lon1, lat1, lon1 + dE, lat1),
      6
    );
    const a = parseLocalDxf(geoA, "geo_a.dxf");
    const b = parseLocalDxf(geoB, "geo_b.dxf");
    expect(a.isGeographic).toBe(true);
    expect(b.isGeographic).toBe(true);

    const merged = mergeLocalDxfResults([a, b]);
    expect(merged.isGeographic).toBe(true);
    expect(merged.geoOrigin).toEqual(a.geoOrigin);
    expect(merged.lines.length).toBe(a.lines.length + b.lines.length);
    // Second file's geometry should land roughly 0.001° north of origin ≈ 111 m.
    const secondFrom = merged.lines[a.lines.length].from;
    expect(secondFrom.x).toBeGreaterThan(100);
    void mpd;
  });

  it("rejects mix of metric and geographic DXF", () => {
    const metric = parseLocalDxf(wrapDxf(lineEntity(0, 0, 2, 0), 6), "m.dxf");
    const lat0 = 13.05;
    const lon0 = 80.25;
    const geo = parseLocalDxf(
      wrapDxf(lineEntity(lon0, lat0, lon0 + 0.0002, lat0), 6),
      "g.dxf"
    );
    expect(metric.isGeographic).toBe(false);
    expect(geo.isGeographic).toBe(true);
    expect(() => mergeLocalDxfResults([metric, geo])).toThrow(
      /Cannot mix metric and georeferenced/i
    );
  });
});

// ── Shared builders for the correctness suites below ────────────────────────

type Ext = [number, number, number];

function extCodes(ext?: Ext): string {
  return ext ? `210\n${ext[0]}\n220\n${ext[1]}\n230\n${ext[2]}\n` : "";
}

function circleEntity(cx: number, cy: number, r: number, ext?: Ext, layer = "0"): string {
  return `0\nCIRCLE\n8\n${layer}\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n${extCodes(ext)}`;
}

function arcEntityExt(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  ext?: Ext
): string {
  return `0\nARC\n8\n0\n10\n${cx}\n20\n${cy}\n30\n0\n40\n${r}\n50\n${start}\n51\n${end}\n${extCodes(ext)}`;
}

function lwpoly(
  verts: Array<[number, number, number?]>,
  o: { closed?: boolean; elevation?: number; ext?: Ext; layer?: string } = {}
): string {
  let s = `0\nLWPOLYLINE\n8\n${o.layer ?? "0"}\n90\n${verts.length}\n70\n${o.closed ? 1 : 0}\n`;
  if (o.elevation !== undefined) s += `38\n${o.elevation}\n`;
  s += extCodes(o.ext);
  for (const [x, y, b] of verts) s += `10\n${x}\n20\n${y}\n` + (b ? `42\n${b}\n` : "");
  return s;
}

function ellipseEntity(o: {
  cx: number;
  cy: number;
  mx: number;
  my: number;
  ratio: number;
  start?: number;
  end?: number;
  ext?: Ext;
}): string {
  return (
    `0\nELLIPSE\n8\n0\n10\n${o.cx}\n20\n${o.cy}\n30\n0\n11\n${o.mx}\n21\n${o.my}\n31\n0\n` +
    extCodes(o.ext) +
    `40\n${o.ratio}\n` +
    (o.start !== undefined ? `41\n${o.start}\n` : "") +
    (o.end !== undefined ? `42\n${o.end}\n` : "")
  );
}

function insertEntity(
  name: string,
  x: number,
  y: number,
  o: {
    sx?: number;
    sy?: number;
    sz?: number;
    rot?: number;
    cols?: number;
    rows?: number;
    colSp?: number;
    rowSp?: number;
    ext?: Ext;
    layer?: string;
  } = {}
): string {
  return (
    `0\nINSERT\n8\n${o.layer ?? "0"}\n2\n${name}\n10\n${x}\n20\n${y}\n30\n0\n` +
    (o.sx !== undefined ? `41\n${o.sx}\n` : "") +
    (o.sy !== undefined ? `42\n${o.sy}\n` : "") +
    (o.sz !== undefined ? `43\n${o.sz}\n` : "") +
    (o.rot !== undefined ? `50\n${o.rot}\n` : "") +
    (o.cols !== undefined ? `70\n${o.cols}\n` : "") +
    (o.rows !== undefined ? `71\n${o.rows}\n` : "") +
    (o.colSp !== undefined ? `44\n${o.colSp}\n` : "") +
    (o.rowSp !== undefined ? `45\n${o.rowSp}\n` : "") +
    extCodes(o.ext)
  );
}

function blockDef(name: string, base: [number, number] | null, entities: string): string {
  return (
    `0\nBLOCK\n8\n0\n2\n${name}\n70\n0\n` +
    (base ? `10\n${base[0]}\n20\n${base[1]}\n30\n0\n` : "") +
    `${entities}0\nENDBLK\n8\n0\n`
  );
}

function wrapDxfBlocks(blocks: string, entities: string, insunits = 6): string {
  return (
    `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${insunits}\n0\nENDSEC\n` +
    `0\nSECTION\n2\nBLOCKS\n${blocks}0\nENDSEC\n` +
    `0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`
  );
}

type PP = { north: number; east: number };
type Xy2 = { x: number; y: number };
/** Preview point as CAD [x, y] (x = east, y = north). */
const cad = (p: PP): [number, number] => [p.east, p.north];

function expectXy(p: PP, x: number, y: number, tol = 1e-9): void {
  expect(Math.abs(p.east - x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(p.north - y)).toBeLessThanOrEqual(tol);
}

function distToSegment(px: number, py: number, a: PP, b: PP): number {
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a.east) * dx + (py - a.north) * dy) / len2));
  return Math.hypot(px - (a.east + t * dx), py - (a.north + t * dy));
}

/** Distance from a point to a polyline. */
function distToPolyline(px: number, py: number, pts: PP[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distToSegment(px, py, pts[i], pts[i + 1]));
  }
  return best;
}

/** Worst distance from a dense reference curve to the tessellated polyline. */
function chordError(ref: Array<[number, number]>, pts: PP[]): number {
  let worst = 0;
  for (const [x, y] of ref) worst = Math.max(worst, distToPolyline(x, y, pts));
  return worst;
}

// ── NURBS SPLINE ────────────────────────────────────────────────────────────

/** Independent Cox-de Boor definition of a rational B-spline point (test oracle). */
function refNurbs(
  degree: number,
  U: number[],
  ctrl: Array<[number, number]>,
  weights: number[],
  t: number
): [number, number] {
  const basis = (i: number, p: number): number => {
    if (p === 0) return U[i] <= t && t < U[i + 1] ? 1 : 0;
    const d1 = U[i + p] - U[i];
    const d2 = U[i + p + 1] - U[i + 1];
    return (
      (d1 > 0 ? ((t - U[i]) / d1) * basis(i, p - 1) : 0) +
      (d2 > 0 ? ((U[i + p + 1] - t) / d2) * basis(i + 1, p - 1) : 0)
    );
  };
  let x = 0;
  let y = 0;
  let w = 0;
  for (let i = 0; i < ctrl.length; i++) {
    const b = basis(i, degree) * weights[i];
    x += b * ctrl[i][0];
    y += b * ctrl[i][1];
    w += b;
  }
  return [x / w, y / w];
}

function refCurve(
  degree: number,
  U: number[],
  ctrl: Array<[number, number]>,
  weights: number[],
  samples = 1500
): Array<[number, number]> {
  const t0 = U[degree];
  const t1 = U[ctrl.length];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < samples; i++) {
    out.push(refNurbs(degree, U, ctrl, weights, t0 + ((t1 - t0) * i) / samples));
  }
  out.push(refNurbs(degree, U, ctrl, weights, t1 - 1e-12));
  return out;
}

function splineEntity(o: {
  degree: number;
  knots: number[];
  ctrl: Array<[number, number]>;
  weights?: number[];
  fit?: Array<[number, number]>;
  flags?: number;
}): string {
  const fit = o.fit ?? [];
  let s =
    `0\nSPLINE\n8\n0\n70\n${o.flags ?? 8}\n71\n${o.degree}\n72\n${o.knots.length}\n` +
    `73\n${o.ctrl.length}\n74\n${fit.length}\n`;
  for (const k of o.knots) s += `40\n${k}\n`;
  for (const w of o.weights ?? []) s += `41\n${w}\n`;
  for (const [x, y] of o.ctrl) s += `10\n${x}\n20\n${y}\n30\n0\n`;
  for (const [x, y] of fit) s += `11\n${x}\n21\n${y}\n31\n0\n`;
  return s;
}

/**
 * Exact circle of radius R as ONE rational cubic B-spline: each quarter is the
 * degree-elevated rational quadratic (weights 1, sqrt(2)/2, 1); 13 control points,
 * knots 0 0 0 0 1 1 1 2 2 2 3 3 3 4 4 4 4.
 */
function rationalCubicCircle(R: number) {
  const w1 = Math.SQRT1_2;
  const ctrl: Array<[number, number]> = [];
  const weights: number[] = [];
  for (let q = 0; q < 4; q++) {
    const rot = (x: number, y: number): [number, number] => {
      let a = x;
      let b = y;
      for (let k = 0; k < q; k++) [a, b] = [-b, a];
      return [a, b];
    };
    // Homogeneous quadratic control points (x w, y w, w).
    const [p0x, p0y] = rot(R, 0);
    const [p1x, p1y] = rot(R, R);
    const [p2x, p2y] = rot(0, R);
    const P0 = [p0x, p0y, 1];
    const P1 = [p1x * w1, p1y * w1, w1];
    const P2 = [p2x, p2y, 1];
    const Q = [
      P0,
      P0.map((v, i) => (v + 2 * P1[i]) / 3),
      P1.map((v, i) => (2 * v + P2[i]) / 3),
      P2,
    ];
    for (const [i, h] of Q.entries()) {
      if (q > 0 && i === 0) continue; // shared with the previous quarter
      ctrl.push([h[0] / h[2], h[1] / h[2]]);
      weights.push(h[2]);
    }
  }
  return { ctrl, weights, knots: [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4] };
}

describe("SPLINE (NURBS)", () => {
  it("evaluates a degree-3 rational circle against its analytic radius within 5 mm", () => {
    const R = 10;
    const c = rationalCubicCircle(R);
    expect(c.ctrl).toHaveLength(13);
    for (const flags of [4 | 8, 1 | 4 | 8]) {
      const r = parseLocalDxf(
        wrapDxf(splineEntity({ degree: 3, flags, ...c }), 6),
        "nurbs-circle.dxf"
      );
      expect(r.lines).toHaveLength(1);
      const e = r.lines[0].entity!;
      expect(e.entity_type).toBe("SPLINE");
      const pp = e.preview_points;
      // Vertices lie exactly on the circle (exact rational evaluation).
      for (const p of pp) expect(Math.abs(Math.hypot(p.east, p.north) - R)).toBeLessThan(1e-9);
      // Chord error: midpoints sit at most MAX_SAGITTA_M inside the circle.
      for (let i = 0; i + 1 < pp.length; i++) {
        const mx = (pp[i].east + pp[i + 1].east) / 2;
        const my = (pp[i].north + pp[i + 1].north) / 2;
        expect(R - Math.hypot(mx, my)).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-9);
      }
      // Not over-sampled: a uniform spline density of 5 mm on R = 10 needs ~ 400 chords.
      expect(pp.length).toBeLessThan(900);
      expect(e.length_m).toBeGreaterThan(2 * Math.PI * R - 0.05);
      expect(e.length_m).toBeLessThanOrEqual(2 * Math.PI * R + 1e-9);
      expect(e.geometry.rational).toBe(true);
    }
  });

  it("honours non-uniform knots (quadratic, knots 0 0 0 1 3 3 3)", () => {
    const ctrl: Array<[number, number]> = [
      [0, 0],
      [4, 8],
      [10, 6],
      [14, -2],
    ];
    const U = [0, 0, 0, 1, 3, 3, 3];
    const r = parseLocalDxf(
      wrapDxf(splineEntity({ degree: 2, knots: U, ctrl }), 6),
      "nonuniform.dxf"
    );
    const pp = r.lines[0].entity!.preview_points;
    expectXy(pp[0], 0, 0);
    expectXy(pp[pp.length - 1], 14, -2);
    // The interior knot t = 1 is a tessellation vertex and matches the oracle.
    const knotPoint = refNurbs(2, U, ctrl, [1, 1, 1, 1], 1);
    expect(pp.some((p) => Math.hypot(p.east - knotPoint[0], p.north - knotPoint[1]) < 1e-9)).toBe(
      true
    );
    // A uniform parametrisation puts that vertex somewhere else: knots matter.
    const uniformPoint = refNurbs(2, [0, 0, 0, 1.5, 3, 3, 3], ctrl, [1, 1, 1, 1], 1.5);
    expect(Math.hypot(uniformPoint[0] - knotPoint[0], uniformPoint[1] - knotPoint[1])).toBeGreaterThan(0.1);
    expect(chordError(refCurve(2, U, ctrl, [1, 1, 1, 1]), pp)).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-9);
  });

  it("applies weights (rational quadratic Bezier)", () => {
    const ctrl: Array<[number, number]> = [
      [0, 0],
      [5, 10],
      [10, 0],
    ];
    const U = [0, 0, 0, 1, 1, 1];
    const run = (weights: number[]) =>
      parseLocalDxf(
        wrapDxf(splineEntity({ degree: 2, knots: U, ctrl, weights, flags: 8 | (weights.some((w) => w !== 1) ? 4 : 0) }), 6),
        "w.dxf"
      ).lines[0].entity!.preview_points;
    // t = 0.5: (P0 + 2 w P1 + P2) / (2 + 2 w).
    const heavy = run([1, 3, 1]);
    expect(distToPolyline(5, 7.5, heavy)).toBeLessThanOrEqual(MAX_SAGITTA_M);
    const plain = run([1, 1, 1]);
    expect(distToPolyline(5, 5, plain)).toBeLessThanOrEqual(MAX_SAGITTA_M);
    expect(distToPolyline(5, 7.5, plain)).toBeGreaterThan(1);
    expect(chordError(refCurve(2, U, ctrl, [1, 3, 1]), heavy)).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-9);
  });

  it("keeps the chord error <= 5 mm on a tight S-bend (adaptive subdivision)", () => {
    const ctrl: Array<[number, number]> = [
      [0, 0],
      [0.5, 3],
      [1, -3],
      [6, 3],
      [6.5, -3],
      [7, 0],
    ];
    const U = [0, 0, 0, 0, 1, 2, 3, 3, 3, 3];
    const r = parseLocalDxf(wrapDxf(splineEntity({ degree: 3, knots: U, ctrl }), 6), "s.dxf");
    const pp = r.lines[0].entity!.preview_points;
    expect(chordError(refCurve(3, U, ctrl, ctrl.map(() => 1), 4000), pp)).toBeLessThanOrEqual(
      MAX_SAGITTA_M + 1e-9
    );
    // Adaptive: a gentle curve needs far fewer points than this tight one.
    const gentle = parseLocalDxf(
      wrapDxf(
        splineEntity({
          degree: 3,
          knots: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3],
          ctrl: [[0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0], [5, 0]],
        }),
        6
      ),
      "gentle.dxf"
    );
    expect(gentle.lines[0].entity!.preview_points.length).toBeLessThan(pp.length);
  });

  it("passes a clamped interpolation through fit-point-only splines and says so", () => {
    const fit: Array<[number, number]> = [
      [0, 0],
      [3, 4],
      [7, 5],
      [10, 1],
      [14, -2],
      [18, 3],
    ];
    const r = parseLocalDxf(
      wrapDxf(splineEntity({ degree: 3, knots: [], ctrl: [], fit, flags: 8 }), 6),
      "fit.dxf"
    );
    expect(r.lines).toHaveLength(1);
    const pp = r.lines[0].entity!.preview_points;
    for (const [x, y] of fit) {
      expect(distToPolyline(x, y, pp)).toBeLessThanOrEqual(MAX_SAGITTA_M);
    }
    expectXy(pp[0], 0, 0);
    expectXy(pp[pp.length - 1], 18, 3);
    expect(r.lines[0].entity!.geometry.fit_points_only).toBe(true);
    expect(r.warnings.some((w) => /Interpolated 1 fit-point-only SPLINE/.test(w))).toBe(true);
  });

  it("interpolates fit points exactly at their chord-length parameters", () => {
    const fit: Xy2[] = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 7, y: 5 },
      { x: 10, y: 1 },
      { x: 14, y: -2 },
    ];
    const nb = fitPointNurbs(fit)!;
    expect(nb.degree).toBe(3);
    expect(nb.knots).toHaveLength(nb.ctrl.length + nb.degree + 1);
    let total = 0;
    const ubar = [0];
    for (let i = 1; i < fit.length; i++) {
      total += Math.hypot(fit[i].x - fit[i - 1].x, fit[i].y - fit[i - 1].y);
      ubar.push(total);
    }
    fit.forEach((f, i) => {
      const p = nurbsPoint(nb, i === fit.length - 1 ? 1 : ubar[i] / total);
      expect(Math.abs(p.x - f.x)).toBeLessThan(1e-9);
      expect(Math.abs(p.y - f.y)).toBeLessThan(1e-9);
    });
    // Two and three fit points use degree 1 and 2.
    expect(fitPointNurbs(fit.slice(0, 2))!.degree).toBe(1);
    expect(fitPointNurbs(fit.slice(0, 3))!.degree).toBe(2);
    expect(fitPointNurbs([fit[0], fit[0]])).toBeNull();
  });

  it("counts a wrong knot vector length instead of dropping the spline silently", () => {
    const c = rationalCubicCircle(1);
    const bad = splineEntity({ degree: 3, ...c, knots: c.knots.slice(0, -1) });
    const r = parseLocalDxf(wrapDxf(bad + lineEntity(0, 0, 1, 0), 6), "badknots.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain(
      "Skipped 1 SPLINE entity (invalid knot vector: the knot count must equal control points + degree + 1)."
    );
  });

  it("rejects decreasing knots, bad weights and closed flags that do not close", () => {
    const ctrl: Array<[number, number]> = [[0, 0], [1, 2], [3, 3], [4, 0]];
    const good = [0, 0, 0, 0, 1, 1, 1, 1];
    const cases: Array<[string, string]> = [
      [splineEntity({ degree: 3, ctrl, knots: [0, 0, 0, 1, 0, 1, 1, 1] }), "invalid knot vector: knots decrease"],
      [splineEntity({ degree: 3, ctrl, knots: good, weights: [1, 0, 1, 1], flags: 12 }), "weights are inconsistent"],
      [splineEntity({ degree: 3, ctrl, knots: good, flags: 1 | 8 }), "flagged closed or periodic but its control data does not close"],
    ];
    for (const [entity, reason] of cases) {
      const r = parseLocalDxf(wrapDxf(entity + lineEntity(0, 0, 1, 0), 6), "bad.dxf");
      expect(r.lines).toHaveLength(1);
      expect(r.warnings.some((w) => w.includes(reason))).toBe(true);
    }
  });

  it("rejects closed fit-point-only splines with a counted warning", () => {
    const r = parseLocalDxf(
      wrapDxf(
        splineEntity({ degree: 3, knots: [], ctrl: [], flags: 1 | 8, fit: [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]] }) +
          lineEntity(0, 0, 1, 0),
        6
      ),
      "closedfit.dxf"
    );
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain(
      "Skipped 1 SPLINE entity (closed or periodic fit-point-only spline is not supported)."
    );
  });

  it("tessellates a geographic spline in metres about the projected control polygon", () => {
    const lat0 = 13.05;
    const lon0 = 80.25;
    const dLat = 0.0002; // ~22 m
    const dLon = 0.0002;
    const ctrlDeg: Array<[number, number]> = [
      [lon0, lat0],
      [lon0 + dLon * 0.3, lat0 + dLat * 1.2],
      [lon0 + dLon * 0.7, lat0 - dLat * 0.4],
      [lon0 + dLon, lat0 + dLat * 0.8],
    ];
    const U = [0, 0, 0, 0, 1, 1, 1, 1];
    const r = parseLocalDxf(wrapDxf(splineEntity({ degree: 3, knots: U, ctrl: ctrlDeg }), 6), "geo-spline.dxf");
    expect(r.isGeographic).toBe(true);
    const o = r.geoOrigin!;
    const ctrlM = ctrlDeg.map(([lon, lat]) => {
      const m = projectGpsToLocalMeters(lat, lon, o.lat, o.lon);
      return [m.east, m.north] as [number, number];
    });
    const pp = r.lines[0].entity!.preview_points;
    expect(chordError(refCurve(3, U, ctrlM, [1, 1, 1, 1], 3000), pp)).toBeLessThanOrEqual(
      MAX_SAGITTA_M + 1e-9
    );
    // A degree-space bound would have produced the 4-chord floor; metres need many more.
    expect(pp.length).toBeGreaterThan(10);
  });
});

// ── INSERT / blocks ─────────────────────────────────────────────────────────

describe("INSERT and blocks", () => {
  const unitLine = lineEntity(0, 0, 1, 0);

  it("subtracts the BLOCK base point", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", [10, 10], lineEntity(10, 10, 12, 10)),
      insertEntity("B", 100, 200)
    );
    const r = parseLocalDxf(dxf, "base.dxf");
    expect(r.lines).toHaveLength(1);
    const pp = r.lines[0].entity!.preview_points;
    expectXy(pp[0], 100, 200);
    expectXy(pp[1], 102, 200);
  });

  it("applies base point, scale, rotation and translation in that order", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", [1, 1], lineEntity(1, 1, 3, 1)),
      insertEntity("B", 5, 7, { sx: 2, sy: 2, rot: 90 })
    );
    const pp = parseLocalDxf(dxf, "order.dxf").lines[0].entity!.preview_points;
    // (1,1)->(0,0)->scale->(0,0)->rot->(0,0)->+ins (5,7); (3,1)->(2,0)->(4,0)->(0,4)->(5,11).
    expectXy(pp[0], 5, 7);
    expectXy(pp[1], 5, 11);
  });

  it("composes nested INSERT transforms with the parent", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, unitLine) +
        blockDef("A", null, unitLine + insertEntity("B", 5, 0, { sx: 2, sy: 2, rot: 90 })),
      insertEntity("A", 10, 10, { rot: 90 })
    );
    const r = parseLocalDxf(dxf, "nested.dxf");
    expect(r.lines).toHaveLength(2);
    // A's own line: (0,0)-(1,0) -> rot 90 -> (0,0)-(0,1) -> +(10,10).
    let pp = r.lines[0].entity!.preview_points;
    expectXy(pp[0], 10, 10);
    expectXy(pp[1], 10, 11);
    // B inside A: x2 -> (0,0)-(2,0), rot 90 -> (0,0)-(0,2), +(5,0) -> (5,0)-(5,2);
    // then A: rot 90 -> (0,5)-(-2,5), +(10,10) -> (10,15)-(8,15).
    pp = r.lines[1].entity!.preview_points;
    expectXy(pp[0], 10, 15);
    expectXy(pp[1], 8, 15);
  });

  it("defaults Y scale and Z scale to 1, not to the X scale", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, lineEntity(0, 0, 1, 1)),
      insertEntity("B", 0, 0, { sx: 3 })
    );
    const pp = parseLocalDxf(dxf, "yscale.dxf").lines[0].entity!.preview_points;
    expectXy(pp[1], 3, 1);
  });

  it("mirrors an arc under a negative X scale and keeps geometry CCW", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, arcEntity(0, 0, 1, 0, 90)),
      insertEntity("B", 0, 0, { sx: -1 })
    );
    const line = parseLocalDxf(dxf, "mirror.dxf").lines[0];
    const e = line.entity!;
    expect(e.entity_type).toBe("ARC");
    const g = e.geometry as { centerNorth: number; centerEast: number; radius: number; startAngle: number; endAngle: number };
    // The mirror image of the 0..90 degree arc is the 90..180 degree arc.
    expect(g.centerEast).toBeCloseTo(0, 9);
    expect(g.centerNorth).toBeCloseTo(0, 9);
    expect(g.radius).toBeCloseTo(1, 9);
    expect(g.startAngle).toBeCloseTo(90, 9);
    expect(g.endAngle).toBeCloseTo(180, 9);
    // Samples run CCW from the geometry start, so from/to agree with the geometry.
    const pp = e.preview_points;
    expectXy(pp[0], 0, 1);
    expectXy(pp[pp.length - 1], -1, 0);
    for (const p of pp) expect(Math.hypot(p.east, p.north)).toBeCloseTo(1, 9);
    expect(line.from.x).toBeCloseTo(1, 9); // north of the start point
    expect(line.to.y).toBeCloseTo(-1, 9); // east of the end point
  });

  it("treats a negative uniform scale as a point reflection (arc stays counter-clockwise)", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, arcEntity(0, 0, 1, 0, 90)),
      insertEntity("B", 0, 0, { sx: -1, sy: -1 })
    );
    const e = parseLocalDxf(dxf, "negunif.dxf").lines[0].entity!;
    const g = e.geometry as { startAngle: number; endAngle: number };
    expect(e.entity_type).toBe("ARC");
    expect(g.startAngle).toBeCloseTo(180, 9);
    expect(g.endAngle).toBeCloseTo(270, 9);
    expectXy(e.preview_points[0], -1, 0);
    const last = e.preview_points[e.preview_points.length - 1];
    expectXy(last, 0, -1);
  });

  it("turns a non-uniformly scaled arc into an exact ELLIPSE", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, circleEntity(0, 0, 1)),
      insertEntity("B", 10, 0, { sx: 2, sy: 1 })
    );
    const e = parseLocalDxf(dxf, "nonuniform.dxf").lines[0].entity!;
    expect(e.entity_type).toBe("ELLIPSE");
    const g = e.geometry as { cx: number; cy: number; majorLen: number; minorLen: number };
    expect(g.cx).toBeCloseTo(10, 9);
    expect(g.majorLen).toBeCloseTo(2, 9);
    expect(g.minorLen).toBeCloseTo(1, 9);
    for (const p of e.preview_points) {
      expect(((p.east - 10) / 2) ** 2 + p.north ** 2).toBeCloseTo(1, 9);
    }
    const first = e.preview_points[0];
    const last = e.preview_points[e.preview_points.length - 1];
    expect(Math.hypot(first.east - last.east, first.north - last.north)).toBeLessThan(1e-12);
  });

  it("mirrors bulge arcs under a negative scale", () => {
    // Semicircle below the chord (positive bulge, CCW) mirrored in X.
    const dxf = wrapDxfBlocks(
      blockDef("B", null, lwpoly([[0, 0, 1], [2, 0]])),
      insertEntity("B", 0, 0, { sx: -1 })
    );
    const pp = parseLocalDxf(dxf, "mirror-bulge.dxf").lines[0].entity!.preview_points;
    expectXy(pp[0], 0, 0);
    expectXy(pp[pp.length - 1], -2, 0);
    for (const p of pp) expect(Math.hypot(p.east + 1, p.north)).toBeCloseTo(1, 9);
    expect(Math.min(...pp.map((p) => p.north))).toBeCloseTo(-1, 4);
    expect(distToPolyline(-1, -1, pp)).toBeLessThan(1e-3);
  });

  it("turns bulge arcs under a non-uniform scale into exact elliptical arcs", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, lwpoly([[0, 0, 1], [2, 0]])),
      insertEntity("B", 0, 0, { sx: 2, sy: 1 })
    );
    const e = parseLocalDxf(dxf, "ell-bulge.dxf").lines[0].entity!;
    expect(e.entity_type).toBe("LWPOLYLINE");
    // Original circle: centre (1,0), r 1 -> ellipse centre (2,0), semi-axes 2 and 1.
    for (const p of e.preview_points) {
      expect(((p.east - 2) / 2) ** 2 + p.north ** 2).toBeCloseTo(1, 9);
    }
    expectXy(e.preview_points[0], 0, 0);
    expectXy(e.preview_points[e.preview_points.length - 1], 4, 0);
  });

  it("refuses a block that contains itself (cycle) with a clear error", () => {
    const direct = wrapDxfBlocks(
      blockDef("A", null, unitLine + insertEntity("A", 1, 0)),
      insertEntity("A", 0, 0)
    );
    expect(() => parseLocalDxf(direct, "self.dxf")).toThrow(/Block "A" contains itself/);
    const indirect = wrapDxfBlocks(
      blockDef("A", null, insertEntity("B", 0, 0)) + blockDef("B", null, insertEntity("A", 0, 0)),
      insertEntity("A", 0, 0)
    );
    expect(() => parseLocalDxf(indirect, "cycle.dxf")).toThrow(/A -> B -> A/);
  });

  it("limits block nesting to 16 levels with a clear error", () => {
    const chain = (depth: number) => {
      let blocks = "";
      for (let i = 1; i <= depth; i++) {
        blocks += blockDef(`L${i}`, null, i === depth ? unitLine : insertEntity(`L${i + 1}`, 1, 0));
      }
      return wrapDxfBlocks(blocks, insertEntity("L1", 0, 0));
    };
    const ok = parseLocalDxf(chain(16), "depth16.dxf");
    expect(ok.lines).toHaveLength(1);
    // Fifteen unit translations accumulate along the chain.
    expectXy(ok.lines[0].entity!.preview_points[0], 15, 0);
    expect(() => parseLocalDxf(chain(17), "depth17.dxf")).toThrow(/nested more than 16 levels/);
  });

  it("expands column/row arrays in the rotated insert frame without scaling the spacing", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, unitLine),
      insertEntity("B", 0, 0, { rot: 90, cols: 3, rows: 2, colSp: 10, rowSp: 5, sx: 2, sy: 2 })
    );
    const r = parseLocalDxf(dxf, "array.dxf");
    expect(r.lines).toHaveLength(6);
    // Offsets (10 c, 5 r) rotate 90 degrees to (-5 r, 10 c); the unit line becomes (0,0)-(0,2).
    let i = 0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const pp = r.lines[i++].entity!.preview_points;
        expectXy(pp[0], -5 * row, 10 * col);
        expectXy(pp[1], -5 * row, 10 * col + 2);
      }
    }
  });

  it("counts an INSERT with an invalid array count or zero scale instead of dropping it silently", () => {
    const blocks = blockDef("B", null, unitLine);
    const r = parseLocalDxf(
      wrapDxfBlocks(
        blocks,
        insertEntity("B", 0, 0, { cols: 0 }) +
          insertEntity("B", 0, 0, { cols: 1.5 }) +
          insertEntity("B", 0, 0, { sx: 0 }) +
          insertEntity("B", 0, 0)
      ),
      "badinsert.dxf"
    );
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 2 INSERT entities (invalid column/row count).");
    expect(r.warnings).toContain("Skipped 1 INSERT entity (zero scale factor).");
  });

  it("counts an INSERT of a missing block", () => {
    const r = parseLocalDxf(wrapDxf(insertEntity("NOPE", 0, 0) + unitLine, 6), "missing.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 1 INSERT entity (block definition not found).");
  });

  it("inherits the INSERT layer for block content on layer 0", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, lineEntity(0, 0, 1, 0, "0") + lineEntity(0, 0, 2, 0, "FIELD")),
      insertEntity("B", 0, 0, { layer: "TRANSIT" })
    );
    const r = parseLocalDxf(dxf, "layer0.dxf");
    expect(r.lines[0].entity!.layer).toBe("TRANSIT");
    expect(r.lines[0].entity!.is_mark).toBe(false);
    expect(r.lines[1].entity!.layer).toBe("FIELD");
    expect(r.lines[1].entity!.is_mark).toBe(true);
  });

  it("counts entities skipped inside blocks, once per insert", () => {
    const hatch = `0\nHATCH\n8\n0\n`;
    const point = `0\nPOINT\n8\n0\n10\n1\n20\n2\n`;
    const dxf = wrapDxfBlocks(
      blockDef("B", null, unitLine + hatch + point + lineEntity(0, 0, 1, 0, "DIM")),
      insertEntity("B", 0, 0) + insertEntity("B", 5, 0)
    );
    const r = parseLocalDxf(dxf, "inblock.dxf");
    expect(r.lines).toHaveLength(2);
    expect(r.warnings).toContain("Skipped 2 HATCH entities (unsupported).");
    expect(r.ignoredCount).toBe(4); // one POINT + one DIM-layer line, twice
  });
});

// ── OCS / extrusion ─────────────────────────────────────────────────────────

describe("OCS / extrusion (arbitrary-axis algorithm)", () => {
  it("places a CIRCLE at OCS centre (10, 0) with extrusion (0,0,-1) at world X = -10", () => {
    const dxf = wrapDxf(circleEntity(10, 0, 2, [0, 0, -1]), 6);
    const e = parseLocalDxf(dxf, "flip-circle.dxf").lines[0].entity!;
    const g = e.geometry as { centerEast: number; centerNorth: number; radius: number };
    expect(g.centerEast).toBeCloseTo(-10, 9);
    expect(g.centerNorth).toBeCloseTo(0, 9);
    expect(g.radius).toBeCloseTo(2, 9);
    for (const p of e.preview_points) {
      expect(Math.hypot(p.east + 10, p.north)).toBeCloseTo(2, 9);
    }
    // Extremes are vertices up to the 5 mm sagitta.
    expect(Math.abs(Math.min(...e.preview_points.map((p) => p.east)) + 12)).toBeLessThanOrEqual(MAX_SAGITTA_M);
    expect(Math.abs(Math.max(...e.preview_points.map((p) => p.east)) + 8)).toBeLessThanOrEqual(MAX_SAGITTA_M);
  });

  it("mirrors an ARC in a flipped OCS and reports it counter-clockwise", () => {
    const e = parseLocalDxf(wrapDxf(arcEntityExt(0, 0, 1, 0, 90, [0, 0, -1]), 6), "flip-arc.dxf").lines[0]
      .entity!;
    const g = e.geometry as { startAngle: number; endAngle: number };
    // OCS 0..90 about -Z is world 180..90 clockwise = the 90..180 arc counter-clockwise.
    expect(g.startAngle).toBeCloseTo(90, 9);
    expect(g.endAngle).toBeCloseTo(180, 9);
    expectXy(e.preview_points[0], 0, 1);
    expectXy(e.preview_points[e.preview_points.length - 1], -1, 0);
  });

  it("uses Ax = Wz x N for a tilted extrusion and keeps the plan-view image exact", () => {
    // N = (0.6, 0, 0.8): Ax = (0,1,0), Ay = N x Ax = (-0.8, 0, 0.6), so OCS (x, y) maps to plan (-0.8 y, x).
    const dxf = wrapDxf(lwpoly([[0, 0], [10, 0], [10, 5]], { ext: [0.6, 0, 0.8] }), 6);
    const pp = parseLocalDxf(dxf, "tilt.dxf").lines[0].entity!.preview_points;
    expectXy(pp[0], 0, 0);
    expectXy(pp[1], 0, 10);
    expectXy(pp[2], -4, 10);
  });

  it("handles an LWPOLYLINE with a bulge in a flipped OCS (with elevation)", () => {
    // OCS semicircle below the chord, through (1,-1); world x = -x gives centre (-1,0), through (-1,-1).
    const dxf = wrapDxf(lwpoly([[0, 0, 1], [2, 0]], { ext: [0, 0, -1], elevation: 5 }), 6);
    const pp = parseLocalDxf(dxf, "flip-bulge.dxf").lines[0].entity!.preview_points;
    expectXy(pp[0], 0, 0);
    expectXy(pp[pp.length - 1], -2, 0);
    for (const p of pp) expect(Math.hypot(p.east + 1, p.north)).toBeCloseTo(1, 9);
    expect(distToPolyline(-1, -1, pp)).toBeLessThan(1e-3);
    expect(Math.max(...pp.map((p) => p.north))).toBeLessThanOrEqual(1e-9);
  });

  it("closes a two-vertex bulge polyline into a full circle", () => {
    const dxf = wrapDxf(lwpoly([[0, 0, 1], [2, 0, 1]], { closed: true }), 6);
    const pp = parseLocalDxf(dxf, "two-arcs.dxf").lines[0].entity!.preview_points;
    for (const p of pp) expect(Math.hypot(p.east - 1, p.north)).toBeCloseTo(1, 9);
    expect(Math.min(...pp.map((p) => p.north))).toBeCloseTo(-1, 4);
    expect(Math.max(...pp.map((p) => p.north))).toBeCloseTo(1, 4);
    expectXy(pp[pp.length - 1], 0, 0);
  });

  it("flips the sweep direction of an ELLIPSE with extrusion (0,0,-1)", () => {
    const base = { cx: 0, cy: 0, mx: 4, my: 0, ratio: 0.5, start: 0, end: Math.PI / 2 };
    const up = parseLocalDxf(wrapDxf(ellipseEntity(base), 6), "ell-up.dxf").lines[0].entity!;
    const down = parseLocalDxf(
      wrapDxf(ellipseEntity({ ...base, ext: [0, 0, -1] }), 6),
      "ell-down.dxf"
    ).lines[0].entity!;
    // Minor axis = ratio * (N x major): +Y for N = +Z, -Y for N = -Z.
    expectXy(up.preview_points[0], 4, 0);
    expectXy(up.preview_points[up.preview_points.length - 1], 0, 2);
    expectXy(down.preview_points[0], 4, 0);
    expectXy(down.preview_points[down.preview_points.length - 1], 0, -2);
    for (const p of down.preview_points) {
      expect((p.east / 4) ** 2 + (p.north / 2) ** 2).toBeCloseTo(1, 9);
      expect(p.north).toBeLessThanOrEqual(1e-9);
    }
    expect((down.geometry as { clockwise: boolean }).clockwise).toBe(true);
    expect((up.geometry as { clockwise: boolean }).clockwise).toBe(false);
  });

  it("keeps the ELLIPSE centre and major axis in WCS (not mirrored by the extrusion)", () => {
    const dxf = wrapDxf(
      ellipseEntity({ cx: 10, cy: 3, mx: 0, my: 4, ratio: 0.5, ext: [0, 0, -1] }),
      6
    );
    const e = parseLocalDxf(dxf, "ell-wcs.dxf").lines[0].entity!;
    const g = e.geometry as { cx: number; cy: number; majorLen: number; minorLen: number };
    expect(g.cx).toBeCloseTo(10, 9);
    expect(g.cy).toBeCloseTo(3, 9);
    expect(g.majorLen).toBeCloseTo(4, 9);
    expect(g.minorLen).toBeCloseTo(2, 9);
    // Start at the end of the major axis (10, 7); the minor axis points to +X for N = -Z.
    expectXy(e.preview_points[0], 10, 7);
    expect(Math.abs(Math.max(...e.preview_points.map((p) => p.east)) - 12)).toBeLessThanOrEqual(MAX_SAGITTA_M);
  });

  it("composes an INSERT in a flipped OCS (insertion point is in the INSERT's OCS)", () => {
    const blocks = blockDef("B", null, lineEntity(0, 0, 1, 0));
    const flat = parseLocalDxf(
      wrapDxfBlocks(blocks, insertEntity("B", 10, 0, { ext: [0, 0, -1] })),
      "ins-flip.dxf"
    ).lines[0].entity!.preview_points;
    expectXy(flat[0], -10, 0);
    expectXy(flat[1], -11, 0);
    const rotated = parseLocalDxf(
      wrapDxfBlocks(blocks, insertEntity("B", 10, 0, { ext: [0, 0, -1], rot: 90 })),
      "ins-flip-rot.dxf"
    ).lines[0].entity!.preview_points;
    // Rotation is about the OCS Z axis: (0,0)-(0,1) in OCS, mirrored in X into world.
    expectXy(rotated[0], -10, 0);
    expectXy(rotated[1], -10, 1);
    const arc = parseLocalDxf(
      wrapDxfBlocks(blockDef("C", null, arcEntity(0, 0, 1, 0, 90)), insertEntity("C", 10, 0, { ext: [0, 0, -1] })),
      "ins-flip-arc.dxf"
    ).lines[0].entity!;
    const g = arc.geometry as { centerEast: number; startAngle: number; endAngle: number };
    expect(g.centerEast).toBeCloseTo(-10, 9);
    expect(g.startAngle).toBeCloseTo(90, 9);
    expect(g.endAngle).toBeCloseTo(180, 9);
  });

  it("mirrors a 2-D POLYLINE through its extrusion and elevation", () => {
    const poly =
      `0\nPOLYLINE\n8\n0\n66\n1\n10\n0\n20\n0\n30\n3\n70\n0\n210\n0\n220\n0\n230\n-1\n` +
      `0\nVERTEX\n8\n0\n10\n1\n20\n0\n30\n3\n` +
      `0\nVERTEX\n8\n0\n10\n2\n20\n1\n30\n3\n` +
      `0\nSEQEND\n8\n0\n`;
    const pp = parseLocalDxf(wrapDxf(poly, 6), "poly-flip.dxf").lines[0].entity!.preview_points;
    expect(pp).toHaveLength(2);
    expectXy(pp[0], -1, 0);
    expectXy(pp[1], -2, 1);
  });

  it("counts a zero-length extrusion vector instead of guessing", () => {
    const r = parseLocalDxf(wrapDxf(circleEntity(0, 0, 1, [0, 0, 0]) + lineEntity(0, 0, 1, 0), 6), "zeroN.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 1 CIRCLE entity (zero-length extrusion vector).");
  });
});

// ── Nothing is dropped silently ─────────────────────────────────────────────

describe("skipped entities are counted and reported", () => {
  const hatch = `0\nHATCH\n8\n0\n`;

  it("counts unsupported entity types per type", () => {
    const dxf = wrapDxf(
      hatch + hatch + hatch + `0\nDIMENSION\n8\n0\n` + `0\nSOLID\n8\n0\n` + lineEntity(0, 0, 1, 0),
      6
    );
    const r = parseLocalDxf(dxf, "unsupported.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 3 HATCH entities (unsupported).");
    expect(r.warnings).toContain("Skipped 1 DIMENSION entity (unsupported).");
    expect(r.warnings).toContain("Skipped 1 SOLID entity (unsupported).");
  });

  it("warns that DXF text is not painted and points to the text tool", () => {
    const text = `0\nTEXT\n8\n0\n10\n0\n20\n0\n1\nHELLO\n`;
    const mtext = `0\nMTEXT\n8\n0\n10\n0\n20\n0\n1\nWORLD\n`;
    const r = parseLocalDxf(wrapDxf(text + text + mtext + lineEntity(0, 0, 1, 0), 6), "text.dxf");
    expect(r.lines).toHaveLength(1);
    const msg = r.warnings.find((w) => /text/i.test(w) && /not painted/.test(w));
    expect(msg).toBeDefined();
    expect(msg).toContain("3 text entities");
    expect(msg).toContain("built-in text tool");
    expect(r.ignoredCount).toBe(3);
    // Text is not double-reported by the generic ignored-entity message.
    expect(r.warnings.some((w) => /^Ignored /.test(w))).toBe(false);
  });

  it("does not let INSERT attributes swallow or invent entities", () => {
    const insert =
      insertEntity("B", 0, 0).replace("10\n0\n20", "66\n1\n10\n0\n20") +
      `0\nATTRIB\n8\n0\n1\nVAL\n2\nTAG\n10\n0\n20\n0\n0\nSEQEND\n8\n0\n`;
    const r = parseLocalDxf(
      wrapDxfBlocks(blockDef("B", null, lineEntity(0, 0, 1, 0)), insert + lineEntity(5, 0, 6, 0)),
      "attrib.dxf"
    );
    expect(r.lines).toHaveLength(2);
    expect(r.warnings.some((w) => /text entity/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /ATTRIB|SEQEND/.test(w) && /unsupported/.test(w))).toBe(false);
  });

  it("counts degenerate entities instead of dropping them", () => {
    const dxf = wrapDxf(
      lwpoly([[0, 0]]) +
        lwpoly([[1, 1]]) +
        lineEntity(2, 2, 2, 2) +
        `0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n0\n` +
        arcEntity(0, 0, 1, 30, 30) +
        lineEntity(0, 0, 1, 0),
      6
    );
    const r = parseLocalDxf(dxf, "degenerate.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 2 LWPOLYLINE entities (fewer than 2 vertices).");
    expect(r.warnings).toContain("Skipped 1 LINE entity (zero length).");
    expect(r.warnings).toContain("Skipped 1 CIRCLE entity (radius is not positive).");
    expect(r.warnings).toContain("Skipped 1 ARC entity (start and end angle are equal).");
  });

  it("counts polygon/polyface meshes and incomplete entities", () => {
    const mesh = `0\nPOLYLINE\n8\n0\n66\n1\n70\n64\n0\nVERTEX\n8\n0\n10\n0\n20\n0\n0\nSEQEND\n8\n0\n`;
    const r = parseLocalDxf(wrapDxf(mesh + `0\nLINE\n8\n0\n10\n0\n20\n0\n` + lineEntity(0, 0, 1, 0), 6), "mesh.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 1 POLYLINE entity (polygon/polyface mesh is not a path).");
    expect(r.warnings).toContain("Skipped 1 LINE entity (missing end-point coordinates).");
  });

  it("a missing SEQEND cannot swallow the entities that follow a POLYLINE", () => {
    const poly =
      `0\nPOLYLINE\n8\n0\n66\n1\n70\n0\n` +
      `0\nVERTEX\n8\n0\n10\n0\n20\n0\n` +
      `0\nVERTEX\n8\n0\n10\n1\n20\n0\n`;
    const r = parseLocalDxf(wrapDxf(poly + lineEntity(5, 5, 6, 5), 6), "noseqend.dxf");
    expect(r.lines).toHaveLength(2);
  });

  it("counts paper-space layout entities instead of importing them as ground geometry", () => {
    const paper = `0\nLINE\n8\n0\n67\n1\n10\n0\n20\n0\n11\n100\n21\n0\n`;
    const r = parseLocalDxf(wrapDxf(paper + paper + lineEntity(0, 0, 1, 0), 6), "paper.dxf");
    expect(r.lines).toHaveLength(1);
    expect(r.warnings).toContain("Skipped 2 LINE entities (paper-space layout entity).");
  });

  it("warns when a file has no importable geometry at all", () => {
    const r = parseLocalDxf(wrapDxf(`0\nHATCH\n8\n0\n`, 6), "nothing.dxf");
    expect(r.lines).toHaveLength(0);
    expect(r.warnings.some((w) => /No importable path geometry/.test(w))).toBe(true);
  });
});

describe("non-finite coordinates refuse the file", () => {
  it("throws naming the entity type and count", () => {
    const bad = (v: string) => `0\nLINE\n8\n0\n10\n0\n20\n0\n11\n${v}\n21\n1\n`;
    expect(() => parseLocalDxf(wrapDxf(bad("nan") + lineEntity(0, 0, 1, 0), 6), "nan.dxf")).toThrow(
      /non-finite.*1 LINE/
    );
    expect(() => parseLocalDxf(wrapDxf(bad("1e999"), 6), "inf.dxf")).toThrow(/non-finite/);
    expect(() => parseLocalDxf(wrapDxf(bad("abc"), 6), "text.dxf")).toThrow(/non-finite/);
    expect(() => parseLocalDxf(wrapDxf(bad(""), 6), "empty.dxf")).toThrow(/non-finite/);
    const polys =
      `0\nLWPOLYLINE\n8\n0\n90\n2\n70\n0\n10\n0\n20\n0\n10\ninfinity\n20\n1\n` +
      `0\nLWPOLYLINE\n8\n0\n90\n2\n70\n0\n10\n0\n20\n0\n10\n1\n20\nNaN\n`;
    expect(() => parseLocalDxf(wrapDxf(polys + bad("x"), 6), "mixed.dxf")).toThrow(
      /2 LWPOLYLINE, 1 LINE/
    );
  });

  it("also refuses a malformed number inside a block, a SPLINE, a POLYLINE vertex and a POINT", () => {
    const blk = wrapDxfBlocks(
      blockDef("B", null, `0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\nxx\n`),
      insertEntity("B", 0, 0)
    );
    expect(() => parseLocalDxf(blk, "blk.dxf")).toThrow(/1 CIRCLE/);
    const spline = splineEntity({ degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [[0, 0], [1, 1], [2, 0]] }).replace(
      "10\n1\n",
      "10\noops\n"
    );
    expect(() => parseLocalDxf(wrapDxf(spline, 6), "spl.dxf")).toThrow(/1 SPLINE/);
    const poly =
      `0\nPOLYLINE\n8\n0\n66\n1\n70\n0\n0\nVERTEX\n8\n0\n10\n0\n20\n0\n0\nVERTEX\n8\n0\n10\nbad\n20\n0\n0\nSEQEND\n8\n0\n`;
    expect(() => parseLocalDxf(wrapDxf(poly, 6), "poly.dxf")).toThrow(/1 POLYLINE/);
    expect(() => parseLocalDxf(wrapDxf(`0\nPOINT\n8\n0\n10\nnan\n20\n0\n`, 6), "pt.dxf")).toThrow(/1 POINT/);
  });

  it("does not refuse a malformed number in an entity the importer ignores", () => {
    const hatchLike = `0\nHATCH\n8\n0\n10\nnan\n20\n0\n`;
    const r = parseLocalDxf(wrapDxf(hatchLike + lineEntity(0, 0, 1, 0), 6), "hatch-nan.dxf");
    expect(r.lines).toHaveLength(1);
  });
});

describe("projected-coordinate guard", () => {
  it("blocks UTM / state-plane values with a clear error", () => {
    const utm = wrapDxf(lineEntity(500000, 4649776, 500010, 4649776), 6);
    expect(() => parseLocalDxf(utm, "utm.dxf")).toThrow(
      /Coordinates look like a projected CRS \(values up to 4649776 m\)/
    );
    // The limit is on metres after unit scaling: 6e6 cm is only 60 km.
    expect(() => parseLocalDxf(wrapDxf(lineEntity(0, 0, 6e6, 0), 5), "cm-ok.dxf")).not.toThrow();
    expect(() => parseLocalDxf(wrapDxf(lineEntity(0, 0, 2e7, 0), 5), "cm-bad.dxf")).toThrow(
      /projected CRS/
    );
    expect(() => parseLocalDxf(wrapDxf(lineEntity(-250000, 0, 0, 0), 6), "neg.dxf")).toThrow(
      /projected CRS/
    );
  });

  it("accepts a legitimate 50 km local drawing", () => {
    const r = parseLocalDxf(wrapDxf(lineEntity(0, 0, 50_000, 30_000), 6), "50km.dxf");
    expect(r.isGeographic).toBe(false);
    expect(r.lines).toHaveLength(1);
    expectXy(r.lines[0].entity!.preview_points[1], 50_000, 30_000);
    expect(parseLocalDxf(wrapDxf(lineEntity(0, 0, 99_999, 0), 6), "edge.dxf").lines).toHaveLength(1);
  });

  it("catches curves whose extent leaves the limit, and never blocks a geographic file", () => {
    expect(() => parseLocalDxf(wrapDxf(circleEntity(0, 0, 150_000), 6), "bigcircle.dxf")).toThrow(
      /projected CRS/
    );
    const geo = parseLocalDxf(wrapDxf(lineEntity(80.25, 13.05, 80.2502, 13.0502), 6), "geo.dxf");
    expect(geo.isGeographic).toBe(true);
  });
});

describe("$INSUNITS blocking warning", () => {
  const critical = (w: string) => isCriticalParseWarning(w);

  it("returns the assumed centimetre scale as a blocking warning when $INSUNITS is absent or 0", () => {
    for (const dxf of [wrapDxf(lineEntity(0, 0, 100, 0)), wrapDxf(lineEntity(0, 0, 100, 0), 0)]) {
      const r = parseLocalDxf(dxf, "nounits.dxf");
      expect(r.unitScale).toBe(DEFAULT_UNIT_SCALE_M);
      expect(r.blockingWarnings).toHaveLength(1);
      expect(r.blockingWarnings[0]).toMatch(/assumed centimetres/);
      // The send-readiness gate treats it as critical, i.e. it needs an acknowledgement.
      expect(critical(r.blockingWarnings[0])).toBe(true);
    }
  });

  it("treats an unmapped $INSUNITS code the same way", () => {
    const r = parseLocalDxf(wrapDxf(lineEntity(0, 0, 100, 0), 99), "weird.dxf");
    expect(r.unitScaleSource).toBe("fallback");
    expect(r.blockingWarnings[0]).toMatch(/\$INSUNITS=99 is not a recognised unit/);
    expect(critical(r.blockingWarnings[0])).toBe(true);
  });

  it("has no blocking warning for a declared unit or a georeferenced file", () => {
    expect(parseLocalDxf(wrapDxf(lineEntity(0, 0, 100, 0), 4), "mm.dxf").blockingWarnings).toEqual([]);
    const geo = parseLocalDxf(wrapDxf(lineEntity(80.25, 13.05, 80.2502, 13.0502)), "geo-nounits.dxf");
    expect(geo.isGeographic).toBe(true);
    expect(geo.blockingWarnings).toEqual([]);
  });

  it("the Send gate stays closed until the operator acknowledges it", () => {
    const r = parseLocalDxf(wrapDxf(lineEntity(0, 0, 100, 0)), "gate.dxf");
    const lines = r.lines;
    const gate = (parseAcknowledged: boolean) =>
      evaluateCsvSendReadiness({
        lines,
        parseWarnings: [...r.blockingWarnings, ...r.warnings],
        parseAcknowledged,
      });
    expect(gate(false).needsParseAck).toBe(true);
    expect(gate(false).canSend).toBe(false);
    expect(gate(true).canSend).toBe(true);
    // A file with a declared unit needs no acknowledgement.
    const ok = parseLocalDxf(wrapDxf(lineEntity(0, 0, 1, 0), 6), "ok.dxf");
    expect(
      evaluateCsvSendReadiness({ lines: ok.lines, parseWarnings: [...ok.blockingWarnings, ...ok.warnings] })
        .needsParseAck
    ).toBe(false);
  });
});

describe("caps", () => {
  it("fails with a clear error above 20,000 entities and accepts exactly 20,000", () => {
    const lines = (n: number) => {
      let s = "";
      for (let i = 0; i < n; i++) s += `0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n${i % 7}\n`;
      return wrapDxf(s, 6);
    };
    expect(parseLocalDxf(lines(MAX_DXF_ENTITIES), "cap-ok.dxf").lines).toHaveLength(MAX_DXF_ENTITIES);
    expect(() => parseLocalDxf(lines(MAX_DXF_ENTITIES + 1), "cap.dxf")).toThrow(
      /more than 20,000 entities/
    );
  });

  it("counts entities after block expansion and bounds array and nesting blow-ups", () => {
    const lineBlock = blockDef("B", null, lineEntity(0, 0, 1, 0));
    const expanded = wrapDxfBlocks(lineBlock, insertEntity("B", 0, 0, { cols: 101, rows: 100 }));
    expect(() => parseLocalDxf(expanded, "array-cap.dxf")).toThrow(/more than 20,000 entities/);
    const huge = wrapDxfBlocks(lineBlock, insertEntity("B", 0, 0, { cols: 100000, rows: 100000 }));
    expect(() => parseLocalDxf(huge, "huge-array.dxf")).toThrow(/exceeds the 20,000 entity limit/);
    // Empty blocks produce no geometry but their instances still count, so a fan-out terminates.
    const fan = wrapDxfBlocks(
      blockDef("E", null, "") +
        blockDef("M", null, insertEntity("E", 0, 0, { cols: 100, rows: 100 })),
      insertEntity("M", 0, 0, { cols: 2, rows: 1 })
    );
    expect(() => parseLocalDxf(fan, "fan.dxf")).toThrow(/more than 20,000 entities/);
  });

  it("fails with a clear error above 500,000 tessellated points", () => {
    // r = 20 km circles need ~4,400 chords each; 120 of them exceed the cap.
    let circles = "";
    for (let i = 0; i < 120; i++) circles += circleEntity(0, 0, 20_000);
    expect(() => parseLocalDxf(wrapDxf(circles, 6), "points-cap.dxf")).toThrow(
      /more than 500,000 path points/
    );
    expect(parseLocalDxf(wrapDxf(circleEntity(0, 0, 20_000) + circleEntity(0, 0, 20_000), 6), "ok.dxf").lines).toHaveLength(2);
  });
});

describe("tessellation of ellipses and bounds", () => {
  it("bounds the chord error of an eccentric ELLIPSE by its largest semi-axis", () => {
    const dxf = wrapDxf(ellipseEntity({ cx: 0, cy: 0, mx: 30, my: 0, ratio: 0.1 }), 6);
    const pp = parseLocalDxf(dxf, "ecc.dxf").lines[0].entity!.preview_points;
    const ref: Array<[number, number]> = [];
    for (let i = 0; i < 6000; i++) {
      const t = (2 * Math.PI * i) / 6000;
      ref.push([30 * Math.cos(t), 3 * Math.sin(t)]);
    }
    expect(chordError(ref, pp)).toBeLessThanOrEqual(MAX_SAGITTA_M + 1e-9);
    // Closed ellipse ends exactly where it starts.
    expect(pp[0].east).toBe(pp[pp.length - 1].east);
    expect(pp[0].north).toBe(pp[pp.length - 1].north);
  });

  it("closes a CIRCLE exactly and sweeps an ELLIPSE with end parameter below start", () => {
    const c = parseLocalDxf(wrapDxf(circleEntity(3, 4, 5), 6), "c.dxf").lines[0].entity!.preview_points;
    expect(c[0].east).toBe(c[c.length - 1].east);
    expect(c[0].north).toBe(c[c.length - 1].north);
    const e = parseLocalDxf(
      wrapDxf(ellipseEntity({ cx: 0, cy: 0, mx: 2, my: 0, ratio: 1, start: 5, end: 1 }), 6),
      "wrap.dxf"
    ).lines[0].entity!.preview_points;
    // Start param 5 rad, end param 1 + 2 pi: sweeps through angle 0.
    expectXy(e[0], 2 * Math.cos(5), 2 * Math.sin(5));
    expect(distToPolyline(2, 0, e)).toBeLessThanOrEqual(MAX_SAGITTA_M);
  });
});

describe("geographic files keep the circle convention through the new structure", () => {
  const lat0 = 13.05;
  const lon0 = 80.25;
  const rDeg = 1e-5;
  /** A short LINE keeps the file recognisably geographic. */
  const anchor = lineEntity(lon0, lat0, lon0 + 2e-5, lat0 + 2e-5);

  it("scales a block ARC by the INSERT scale and rotation about a projected centre", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, arcEntity(0, 0, rDeg, 0, 90)),
      anchor + insertEntity("B", lon0, lat0, { sx: 2, sy: 2, rot: 90 })
    );
    const r = parseLocalDxf(dxf, "geo-insert-arc.dxf");
    expect(r.isGeographic).toBe(true);
    const arc = r.lines.find((l) => l.entity!.entity_type === "ARC")!.entity!;
    const g = arc.geometry as { centerNorth: number; centerEast: number; radius: number; startAngle: number; endAngle: number };
    const o = r.geoOrigin!;
    const centre = projectGpsToLocalMeters(lat0, lon0, o.lat, o.lon);
    expect(g.centerNorth).toBeCloseTo(centre.north, 9);
    expect(g.centerEast).toBeCloseTo(centre.east, 9);
    expect(g.radius).toBeCloseTo(2 * rDeg * metresPerDegree(o.lat).mPerDegNorth, 9);
    expect(g.startAngle).toBeCloseTo(90, 6);
    expect(g.endAngle).toBeCloseTo(180, 6);
    for (const p of arc.preview_points) {
      expect(Math.hypot(p.north - g.centerNorth, p.east - g.centerEast)).toBeCloseTo(g.radius, 9);
    }
    expect(arc.preview_points.length).toBeGreaterThan(4);
  });

  it("projects an INSERTed LINE vertex-for-vertex through projectGpsToLocalMeters", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", [0, 0], lineEntity(0, 0, 3e-5, 1e-5)),
      anchor + insertEntity("B", lon0, lat0)
    );
    const r = parseLocalDxf(dxf, "geo-insert-line.dxf");
    const o = r.geoOrigin!;
    const line = r.lines[1];
    const end = projectGpsToLocalMeters(lat0 + 1e-5, lon0 + 3e-5, o.lat, o.lon);
    expectXy(line.entity!.preview_points[1], end.east, end.north, 1e-9);
    // LINE geometry is in the same metre frame as its preview points.
    expect((line.entity!.geometry as { end: number[] }).end[0]).toBeCloseTo(end.north, 9);
  });

  it("refuses non-uniformly scaled arcs it cannot project exactly instead of guessing", () => {
    const dxf = wrapDxfBlocks(
      blockDef("B", null, lwpoly([[0, 0, 1], [2e-5, 0]])),
      anchor + insertEntity("B", lon0, lat0, { sx: 2, sy: 1 })
    );
    expect(() => parseLocalDxf(dxf, "geo-ell.dxf")).toThrow(/non-uniformly scaled INSERT with arc segments/);
  });
});

describe("mergeLocalDxfResults carries warnings", () => {
  it("prefixes warnings and blocking warnings with the file name", () => {
    const a = parseLocalDxf(wrapDxf(lineEntity(0, 0, 100, 0)), "nounits.dxf");
    const b = parseLocalDxf(wrapDxf(`0\nHATCH\n8\n0\n` + lineEntity(0, 0, 1, 0), 6), "hatch.dxf");
    expect(a.blockingWarnings).toHaveLength(1);
    const m = mergeLocalDxfResults([a, b]);
    expect(m.blockingWarnings).toEqual([`nounits.dxf: ${a.blockingWarnings[0]}`]);
    expect(m.warnings).toContain("hatch.dxf: Skipped 1 HATCH entity (unsupported).");
    expect(m.unitScaleSource).toBe("fallback");
    expect(isCriticalParseWarning(m.blockingWarnings[0])).toBe(true);
  });

  it("carries blocking warnings through a geographic merge too", () => {
    const geoWithText = (lat: number) =>
      wrapDxf(`0\nTEXT\n8\n0\n10\n0\n20\n0\n1\nx\n` + lineEntity(80.25, lat, 80.2502, lat + 0.0002), 6);
    const a = parseLocalDxf(geoWithText(13.05), "ga.dxf");
    const b = parseLocalDxf(geoWithText(13.051), "gb.dxf");
    const m = mergeLocalDxfResults([a, b]);
    expect(m.isGeographic).toBe(true);
    expect(m.blockingWarnings).toEqual([]);
    expect(m.warnings.filter((w) => /not painted/.test(w))).toHaveLength(2);
  });
});
