/**
 * Local DXF alignment → origin_gps (the mission anchor).
 *
 * Three offline sources:
 *  - geographic DXF: geoOrigin from parseLocalDxf
 *  - visual / multi-point: reduce ref points to origin + rotation + scale
 *  - auto-origin (telemetry) can feed originGps directly
 */

import type { PlanLine } from "../types/plan";
import { enforceAlignmentScale } from "./designAlignmentPolicy";
import { projectGpsToLocalMeters, projectLocalMetersToGps } from "./geoProjection";
import {
  similarityTransform,
  transformPlanLinesGeometry,
} from "./planLineTransform";

export type DxfAlignment = {
  method: "geographic" | "visual" | "multi_point" | "auto_origin";
  originGps: [number, number];
  rotationDeg: number;
  scale: number;
  rmseM: number | null;
  residualsM: number[];
  /**
   * Operator-visible caveats that do not block the alignment (for example a
   * single reference point fixes translation only).
   */
  warnings: string[];
  /**
   * Distance (m) from the reference centroid to `originGps`. Guards against an
   * origin that was extrapolated far away from the site.
   */
  originOffsetM: number;
};

export type AlignmentRefPoint = {
  /** Design / DXF north (m or pre-alignment units) */
  designNorth: number;
  designEast: number;
  lat: number;
  lon: number;
};

/**
 * Geographic DXF: already projected about geoOrigin; bake is identity in NED,
 * origin_gps = geoOrigin.
 */
export function alignmentFromGeographic(geoOrigin: {
  lat: number;
  lon: number;
}): DxfAlignment {
  return {
    method: "geographic",
    originGps: [geoOrigin.lat, geoOrigin.lon],
    rotationDeg: 0,
    scale: 1,
    rmseM: 0,
    residualsM: [],
    warnings: [],
    originOffsetM: 0,
  };
}

/**
 * Auto-origin: rover live position is the plan origin.
 */
export function alignmentFromAutoOrigin(lat: number, lon: number): DxfAlignment {
  return {
    method: "auto_origin",
    originGps: [lat, lon],
    rotationDeg: 0,
    scale: 1,
    rmseM: null,
    residualsM: [],
    warnings: [],
    originOffsetM: 0,
  };
}

/**
 * Umeyama-style 2D similarity from design NED points to GPS-projected NED
 * about the mean GPS point (treated as temporary origin), then report that
 * centroid as origin_gps with residual rotation/scale about it.
 *
 * refs must have ≥ 2 points. For a single visual corner pair use
 * alignmentFromVisualOrigin.
 */
export function solveMultiPointAlignment(refs: AlignmentRefPoint[]): DxfAlignment {
  if (refs.length < 1) {
    throw new Error("solveMultiPointAlignment requires at least one ref point");
  }

  const lat0 = refs.reduce((s, r) => s + r.lat, 0) / refs.length;
  const lon0 = refs.reduce((s, r) => s + r.lon, 0) / refs.length;

  const world = refs.map((r) => {
    const p = projectGpsToLocalMeters(r.lat, r.lon, lat0, lon0);
    return { n: p.north, e: p.east };
  });
  const design = refs.map((r) => ({ n: r.designNorth, e: r.designEast }));

  if (refs.length === 1) {
    // Translation only: design point D lands on GPS G, so the GPS of design
    // (0, 0) is G shifted by -D. Rotation cannot be observed from one point.
    const origin = projectLocalMetersToGps(
      -design[0].n,
      -design[0].e,
      refs[0].lat,
      refs[0].lon
    );
    return {
      method: "visual",
      originGps: [origin.lat, origin.lon],
      rotationDeg: 0,
      scale: 1,
      rmseM: 0,
      residualsM: [0],
      warnings: [
        "Single reference point: translation only. Rotation is unverified (north is assumed). Add a second reference point to fit rotation and scale.",
      ],
      originOffsetM: Math.hypot(design[0].n, design[0].e),
    };
  }

  // Centroids
  const dMean = {
    n: design.reduce((s, p) => s + p.n, 0) / design.length,
    e: design.reduce((s, p) => s + p.e, 0) / design.length,
  };
  const wMean = {
    n: world.reduce((s, p) => s + p.n, 0) / world.length,
    e: world.reduce((s, p) => s + p.e, 0) / world.length,
  };

  // Covariance for rotation (Umeyama)
  let sxx = 0,
    sxy = 0,
    syx = 0,
    syy = 0;
  let varD = 0;
  for (let i = 0; i < design.length; i++) {
    const dn = design[i].n - dMean.n;
    const de = design[i].e - dMean.e;
    const wn = world[i].n - wMean.n;
    const we = world[i].e - wMean.e;
    sxx += dn * wn;
    sxy += dn * we;
    syx += de * wn;
    syy += de * we;
    varD += dn * dn + de * de;
  }

  // atan2 for rotation of design→world
  const rotationRad = Math.atan2(sxy - syx, sxx + syy);
  const rotationDeg = (rotationRad * 180) / Math.PI;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);

  // Fitted scale, reported as fitted: the trust gate (designAlignmentPolicy)
  // decides whether it is acceptable. Coincident design points leave scale at 1.
  let scale = 1;
  if (varD > 1e-12) {
    let num = 0;
    for (let i = 0; i < design.length; i++) {
      const dn = design[i].n - dMean.n;
      const de = design[i].e - dMean.e;
      const rn = dn * cos - de * sin;
      const re = dn * sin + de * cos;
      const wn = world[i].n - wMean.n;
      const we = world[i].e - wMean.e;
      num += rn * wn + re * we;
    }
    scale = num / varD;
  }

  // Residuals in world frame after similarity about design centroid, then
  // translate so design centroid maps to world centroid.
  const residuals: number[] = [];
  for (let i = 0; i < design.length; i++) {
    const dn = design[i].n - dMean.n;
    const de = design[i].e - dMean.e;
    const pn = (dn * cos - de * sin) * scale + wMean.n;
    const pe = (dn * sin + de * cos) * scale + wMean.e;
    residuals.push(Math.hypot(pn - world[i].n, pe - world[i].e));
  }
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);

  // GPS of design (0, 0) after the transform: world = R*scale*(design - dMean) + wMean.
  const oN = (-dMean.n * cos + dMean.e * sin) * scale + wMean.n;
  const oE = (-dMean.n * sin - dMean.e * cos) * scale + wMean.e;
  const origin = projectLocalMetersToGps(oN, oE, lat0, lon0);

  return {
    method: "multi_point",
    originGps: [origin.lat, origin.lon],
    rotationDeg,
    scale,
    rmseM: rmse,
    residualsM: residuals,
    warnings: [],
    originOffsetM: Math.hypot(oN, oE),
  };
}

/**
 * Visual single-origin placement: origin_gps is the GPS of design (0,0)
 * after the visual sticker transform.
 */
export function alignmentFromVisualOrigin(opts: {
  originLat: number;
  originLon: number;
  /** Sticker translation: item.y = north, item.x = east (visualAlignment contract) */
  offsetNorth: number;
  offsetEast: number;
  rotationDeg: number;
  scale?: number;
}): DxfAlignment {
  const scale = enforceAlignmentScale(opts.scale ?? 1);

  // The mission anchor is the GPS of NED (0,0). Visual sticker places
  // design (0,0) at (offsetNorth, offsetEast) relative to latched GPS origin.
  // So plan origin_gps = latched origin (design is already in that frame after bake).
  // When baking, we apply rotation/scale/offset so NED matches rover frame about origin_gps.
  return {
    method: "visual",
    originGps: [opts.originLat, opts.originLon],
    rotationDeg: opts.rotationDeg,
    scale,
    rmseM: null,
    residualsM: [],
    warnings: [],
    originOffsetM: 0,
  };
}

/**
 * Bake alignment into lines: NED = scale·R(θ)·DXF + offset, about origin.
 * For geographic (identity) this is a no-op when scale=1 rotation=0 offset=0.
 */
export function applyAlignmentToLines(
  lines: PlanLine[],
  a: DxfAlignment,
  offsetNorth: number = 0,
  offsetEast: number = 0
): PlanLine[] {
  if (
    a.rotationDeg === 0 &&
    a.scale === 1 &&
    offsetNorth === 0 &&
    offsetEast === 0
  ) {
    return lines;
  }
  return transformPlanLinesGeometry(
    lines,
    similarityTransform({
      rotationDeg: a.rotationDeg,
      scale: a.scale,
      offsetN: offsetNorth,
      offsetE: offsetEast,
    })
  );
}
