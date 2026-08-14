/**
 * Mission path PRE/AFT extensions — pure geometry + config.
 *
 * App-owned: travel runs in plan-trajectory, spray-off by construction.
 * Source-agnostic (CSV + DXF). See docs/CSV_EXTENSIONS_EXECUTION_PLAN.md.
 *
 * Renamed from csvExtensions.ts (DXF_APP_PLANNED_TRAJECTORY_PLAN Phase 0).
 */

import type { PlanLine } from "../types/plan";

/** [north_m, east_m] — local copy to avoid circular import with missionTrajectory. */
type NedPair = [number, number];

/** Engine run-out floor — app AFT becomes the tail when extensions are on. */
export const CSV_EXT_AFT_FLOOR_M = 0.1;

/** Match engine ends_at_start closed-mission threshold (m). */
export const CSV_EXT_CLOSED_LOOP_TOL_M = 0.01;

/** Walk past degenerate terminal segments shorter than this (m). */
export const CSV_EXT_MIN_SEGMENT_M = 0.01;

/** Soft UI warning threshold (m). */
export const CSV_EXT_WARN_M = 2;

/** Hard typo cap (m). */
export const CSV_EXT_MAX_M = 5;

export type CsvExtensionConfig = {
  enabled: boolean;
  preM: number;
  aftM: number;
  /**
   * DXF parity: split a polyline at corners so each side gets its own PRE/AFT
   * (port of backend per_line). CSV keeps false → byte-identical behaviour.
   */
  perLine?: boolean;
};

/** Alias used by DXF local flow (same shape). */
export type ExtensionConfig = CsvExtensionConfig;

export const DEFAULT_CSV_EXTENSION_CONFIG: CsvExtensionConfig = {
  enabled: false,
  preM: 0.5,
  aftM: 0.5,
  // Chain-ends is the right default for a survey CSV: its paths are fitted straights-and-
  // arcs, so run-ups belong at the two ends of each painted path, not at every vertex.
  // The DXF flow seeds `perLine: true` at import instead (see DXF_EXTENSION_CONFIG) — CAD
  // edges genuinely are separate passes, and it is the only mode under which a closed shape
  // grows run-ups at all.
  perLine: false,
};

/** Extension defaults for an app-planned DXF — per-line, matching the rover's DXF mode. */
export const DXF_EXTENSION_CONFIG: CsvExtensionConfig = {
  enabled: false,
  preM: 0.5,
  aftM: 0.5,
  perLine: true,
};

/** Match backend _EXTENSION_JUNCTION_TOL_M (m). */
export const EXT_JUNCTION_TOL_M = 0.05;

/**
 * Match backend `_EXTENSION_COLLINEAR_DOT` (server/routes/path.py). A junction blocks a
 * run-up only when the two directions are near-parallel, because there the run-out and the
 * next run-in lie along the same line and the connector can only retrace straight back over
 * them. 0.94 ≈ 20° — anything sharper than that is a real corner and keeps its run-up.
 */
export const EXT_COLLINEAR_DOT = 0.94;

/**
 * Match engine `_SEGMENT_JOIN_TOL_M`. Two consecutive runs closer than this already touch,
 * so no connector is emitted between them.
 */
export const EXT_SEGMENT_JOIN_TOL_M = 0.01;

/**
 * Normalize operator input. When enabled, aftM is floored at {@link CSV_EXT_AFT_FLOOR_M}.
 * Non-finite lengths fall back to defaults; lengths are capped at {@link CSV_EXT_MAX_M}.
 */
export function normalizeCsvExtensionConfig(
  raw?: Partial<CsvExtensionConfig> | null
): CsvExtensionConfig {
  const enabled = Boolean(raw?.enabled);
  let preM = typeof raw?.preM === "number" && Number.isFinite(raw.preM) ? raw.preM : DEFAULT_CSV_EXTENSION_CONFIG.preM;
  let aftM = typeof raw?.aftM === "number" && Number.isFinite(raw.aftM) ? raw.aftM : DEFAULT_CSV_EXTENSION_CONFIG.aftM;
  const perLine = Boolean(raw?.perLine);

  if (preM < 0) preM = 0;
  if (aftM < 0) aftM = 0;
  if (preM > CSV_EXT_MAX_M) preM = CSV_EXT_MAX_M;
  if (aftM > CSV_EXT_MAX_M) aftM = CSV_EXT_MAX_M;

  if (enabled) {
    aftM = Math.max(CSV_EXT_AFT_FLOOR_M, aftM);
  }

  return { enabled, preM, aftM, perLine };
}

/** True when a PRE/AFT text field is a finished number (not "", "-", or "1."). */
export function isCompleteExtensionDraft(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-" || trimmed.endsWith(".")) return false;
  return Number.isFinite(Number(trimmed));
}

// ── Phase 3: per-edge freeness (port of path.py _extension_endpoint_freeness) ─

export type MarkEdge = {
  /** [north, east] polyline for this edge */
  points: NedPair[];
  startDir: NedPair | null;
  endDir: NedPair | null;
  /** Parent plan-line id (for PRE/AFT ids) */
  parentId: string;
  parentLabel: string;
  /**
   * Curved geometry (ARC / CIRCLE) whose directions came from analytic tangents rather
   * than adjacent vertices. Curves are exempt from the self-closed guard: a full circle's
   * endpoints coincide, but it still has a well-defined tangent to run in and out along.
   */
  curved?: boolean;
};

/**
 * CCW travel tangent at DXF angle θ (0° = East), in (north, east).
 * Single source of truth in the rover is `path_engine/core.py::dxf_arc_tangent`;
 * this is that formula verbatim.
 */
export function dxfArcTangent(angleDeg: number): NedPair {
  const a = (angleDeg * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
}

/**
 * Analytic start/end tangents for curved geometry, or null when the line is not a curve.
 *
 * Port of `entity_extension_directions` (ARC / CIRCLE branch). A CIRCLE is densified from
 * 0° travelling CCW and ends where it began, so both tangents are the one at 0°.
 */
export function analyticCurveTangents(line: PlanLine): [NedPair, NedPair] | null {
  const type = String(line.entity?.entity_type ?? "").trim().toUpperCase();
  const geom = line.entity?.geometry;
  if (type === "CIRCLE") {
    return [dxfArcTangent(0), dxfArcTangent(0)];
  }
  if (type === "ARC") {
    const start = Number(geom?.startAngle);
    const end = Number(geom?.endAngle);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return [dxfArcTangent(start), dxfArcTangent(end)];
  }
  return null;
}

export type EndpointFreeness = { startFree: boolean; endFree: boolean };

/**
 * Port of `_extension_endpoint_freeness`.
 * perLine=false: any shared endpoint blocks (chain ends only).
 * perLine=true: only collinear junctions block (closed square gets 4× PRE/AFT).
 */
export function computeEndpointFreeness(
  edges: MarkEdge[],
  perLine: boolean,
  tolM: number = EXT_JUNCTION_TOL_M
): EndpointFreeness[] {
  const collinear = (d1: NedPair | null, d2: NedPair | null): boolean => {
    if (!d1 || !d2) return false;
    return Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) > EXT_COLLINEAR_DOT;
  };

  const blocked = (
    pt: NedPair,
    myDir: NedPair | null,
    skipIdx: number
  ): boolean => {
    for (let j = 0; j < edges.length; j++) {
      if (j === skipIdx) continue;
      const e = edges[j];
      if (e.points.length < 2) continue;
      const s = e.points[0];
      const end = e.points[e.points.length - 1];
      for (const [otherPt, otherDir] of [
        [s, e.startDir] as const,
        [end, e.endDir] as const,
      ]) {
        if (distM(pt, otherPt) > tolM) continue;
        if (!perLine) return true;
        if (collinear(myDir, otherDir)) return true;
      }
    }
    return false;
  };

  return edges.map((edge, i) => {
    if (edge.points.length < 2) return { startFree: false, endFree: false };
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];
    if (!edge.curved && distM(start, end) <= tolM) {
      // Self-closed LINE-LIKE run (closed polyline): a straight run-up would stub into the
      // shape, so neither end is free.
      //
      // Curves are deliberately exempt. In the rover the closed-run guard lives inside
      // `split_mark_segment_with_extensions`'s `elif _is_line_like_segment(...)` branch —
      // ARC/CIRCLE take the earlier analytic-tangent branch and keep their extensions even
      // though a full circle's endpoints coincide ("Curves keep their analytic-tangent
      // extensions (handled in the branch above)"). The rover drives in along the tangent,
      // paints the ring, and runs off along the same tangent.
      return { startFree: false, endFree: false };
    }
    return {
      startFree: !blocked(start, edge.startDir, i),
      endFree: !blocked(end, edge.endDir, i),
    };
  });
}

/**
 * Split a polyline at corners into straight edges (per_line mode).
 * Curved single-run entities (few points that aren't corner chains) stay whole.
 */
export function splitPolylineAtCorners(
  pts: NedPair[],
  cornerDotMax: number = 0.999
): NedPair[][] {
  if (pts.length < 3) return [pts];
  const edges: NedPair[][] = [];
  let current: NedPair[] = [pts[0], pts[1]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const d1: NedPair = [b[0] - a[0], b[1] - a[1]];
    const d2: NedPair = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(d1[0], d1[1]);
    const l2 = Math.hypot(d2[0], d2[1]);
    if (l1 < 1e-9 || l2 < 1e-9) {
      current.push(c);
      continue;
    }
    const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2);
    if (dot < cornerDotMax) {
      // Corner at b — close current edge, start new
      edges.push(current);
      current = [b, c];
    } else {
      current.push(c);
    }
  }
  if (current.length >= 2) edges.push(current);
  return edges.length > 0 ? edges : [pts];
}

function unitDir(a: NedPair, b: NedPair): NedPair | null {
  const dn = b[0] - a[0];
  const de = b[1] - a[1];
  const len = Math.hypot(dn, de);
  if (len < 1e-9) return null;
  return [dn / len, de / len];
}

/** Build freeness-aware edges from painted plan lines. */
/**
 * Geometry whose direction can be read off adjacent vertices, so its corners are real
 * corners. Port of `_is_line_like_segment` (LINE / LWPOLYLINE / POLYLINE / LINE_CHAIN).
 *
 * A fitted CSV road-marking path is excluded on purpose: its vertices are tessellation of
 * straights-and-arcs, so "corners" there are sampling artefacts, not places to run off.
 */
export function isLineLikePlanLine(line: PlanLine): boolean {
  if (line.entity?.geometry?.road_marking === true) return false;
  const type = String(line.entity?.entity_type ?? "").trim().toUpperCase();
  return (
    type === "LINE" ||
    type === "LWPOLYLINE" ||
    type === "POLYLINE" ||
    type === "LINE_CHAIN"
  );
}

export function buildMarkEdges(
  paintedLines: PlanLine[],
  perLine: boolean
): MarkEdge[] {
  const edges: MarkEdge[] = [];
  for (const line of paintedLines) {
    const pts = planLineToNed(line);
    if (!pts || pts.length < 2) continue;
    const parentId = line.id;
    const parentLabel = line.label ?? line.id;

    // Curves take their directions from analytic tangents, exactly as the rover does
    // (`entity_extension_directions`), never from finite differences over tessellation —
    // and they are never split at their sampled vertices.
    const curveTangents = analyticCurveTangents(line);
    if (curveTangents) {
      edges.push({
        points: pts,
        startDir: curveTangents[0],
        endDir: curveTangents[1],
        parentId,
        parentLabel,
        curved: true,
      });
      continue;
    }

    // Only line-like geometry is decomposed at its corners. A curve's vertices are
    // tessellation, not corners — splitting there would scatter run-ups along an arc.
    // Mirrors `_is_line_like_segment`, which gates the rover's decompose_line_chain_to_edges.
    if (!perLine || pts.length < 3 || !isLineLikePlanLine(line)) {
      edges.push({
        points: pts,
        startDir: unitDir(pts[0], pts[1]),
        endDir: unitDir(pts[pts.length - 2], pts[pts.length - 1]),
        parentId,
        parentLabel,
      });
      continue;
    }
    const parts = splitPolylineAtCorners(pts);
    if (parts.length <= 1) {
      edges.push({
        points: pts,
        startDir: unitDir(pts[0], pts[1]),
        endDir: unitDir(pts[pts.length - 2], pts[pts.length - 1]),
        parentId,
        parentLabel,
      });
    } else {
      parts.forEach((part, idx) => {
        if (part.length < 2) return;
        edges.push({
          points: part,
          startDir: unitDir(part[0], part[1]),
          endDir: unitDir(part[part.length - 2], part[part.length - 1]),
          parentId: `${parentId}#${idx}`,
          parentLabel: `${parentLabel} side ${idx + 1}`,
        });
      });
    }
  }
  return edges;
}

function distM(a: NedPair, b: NedPair): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function isFinitePair(n: number, e: number): boolean {
  return Number.isFinite(n) && Number.isFinite(e);
}

/** Same NED extract rules as planLineToNedPolyline (kept local — no csvTrajectory import). */
function planLineToNed(line: PlanLine): NedPair[] | null {
  const preview = line.entity?.preview_points;
  if (preview && preview.length >= 2) {
    const pts: NedPair[] = [];
    for (const p of preview) {
      if (p == null || !isFinitePair(p.north, p.east)) continue;
      pts.push([p.north, p.east]);
    }
    return pts.length >= 2 ? pts : null;
  }
  const fx = line.from?.x;
  const fy = line.from?.y;
  const tx = line.to?.x;
  const ty = line.to?.y;
  if (!isFinitePair(fx, fy) || !isFinitePair(tx, ty)) return null;
  return [
    [fx, fy],
    [tx, ty],
  ];
}

/**
 * Unit vector along the first usable segment (start) or last usable segment (end).
 * Walks inward past sub-centimetre degenerates.
 */
export function terminalUnitVector(
  pts: NedPair[],
  end: "start" | "end",
  minSegM: number = CSV_EXT_MIN_SEGMENT_M
): NedPair | null {
  if (pts.length < 2) return null;
  if (end === "start") {
    for (let i = 0; i < pts.length - 1; i++) {
      const dn = pts[i + 1][0] - pts[i][0];
      const de = pts[i + 1][1] - pts[i][1];
      const len = Math.hypot(dn, de);
      if (len >= minSegM) return [dn / len, de / len];
    }
  } else {
    for (let i = pts.length - 1; i >= 1; i--) {
      const dn = pts[i][0] - pts[i - 1][0];
      const de = pts[i][1] - pts[i - 1][1];
      const len = Math.hypot(dn, de);
      if (len >= minSegM) return [dn / len, de / len];
    }
  }
  return null;
}

/**
 * PRE: start − preM·û → start. AFT: end → end + aftM·û.
 * Returns null when length is zero or the line has no usable tangent.
 */
export function extensionEndpointsForLine(
  line: PlanLine,
  role: "pre" | "aft",
  lengthM: number
): NedPair[] | null {
  if (!(lengthM > 0) || !Number.isFinite(lengthM)) return null;
  const pts = planLineToNed(line);
  if (!pts || pts.length < 2) return null;

  if (role === "pre") {
    const u = terminalUnitVector(pts, "start");
    if (!u) return null;
    const start = pts[0];
    const from: NedPair = [start[0] - lengthM * u[0], start[1] - lengthM * u[1]];
    return [from, start];
  }

  const u = terminalUnitVector(pts, "end");
  if (!u) return null;
  const end = pts[pts.length - 1];
  const to: NedPair = [end[0] + lengthM * u[0], end[1] + lengthM * u[1]];
  return [end, to];
}

/**
 * Mission-level closed loop: first point of first painted path ≈ last of last.
 * Mirrors engine ends_at_start (0.01 m).
 */
export function isMissionClosedLoop(
  paintedLines: PlanLine[],
  tolM: number = CSV_EXT_CLOSED_LOOP_TOL_M
): boolean {
  if (paintedLines.length === 0) return false;
  const firstPts = planLineToNed(paintedLines[0]);
  const lastPts = planLineToNed(paintedLines[paintedLines.length - 1]);
  if (!firstPts || !lastPts || firstPts.length < 2 || lastPts.length < 2) return false;
  return distM(firstPts[0], lastPts[lastPts.length - 1]) < tolM;
}

/**
 * One mark edge with the run-up / run-out that attach to it.
 *
 * This is the ordered chain the rover executes — `[PRE?, MARK, AFT?]` per edge, in
 * traversal order — and it is deliberately the ONE structure both the map preview and the
 * trajectory sent to the rover are derived from. Building them separately is how the
 * preview and the driven path drift apart.
 */
export type ExtendedMarkEdge = {
  edge: MarkEdge;
  /** `[tip, markStart]`, or null when this end is not free / preM is 0. */
  pre: NedPair[] | null;
  /** `[markEnd, tip]`, or null when this end is not free / aftM is 0. */
  aft: NedPair[] | null;
};

/** Where travel into this edge begins: the PRE tip, else the mark start. */
export function edgeEntryPoint(e: ExtendedMarkEdge): NedPair {
  return e.pre ? e.pre[0] : e.edge.points[0];
}

/** Where travel out of this edge ends: the AFT tip, else the mark end. */
export function edgeExitPoint(e: ExtendedMarkEdge): NedPair {
  return e.aft ? e.aft[e.aft.length - 1] : e.edge.points[e.edge.points.length - 1];
}

/**
 * Decompose painted paths into the ordered extended-edge chain.
 *
 * Mirrors the rover: `_entity_extension_edges` splits line-like geometry at its corners in
 * per-line mode, `_extension_endpoint_freeness` decides which ends may run off, and
 * `offset_point` places the tips. Returns `[]` when extensions are disabled — callers then
 * keep their plain mark-to-mark behaviour.
 */
export function buildExtendedMarkChain(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): ExtendedMarkEdge[] {
  const cfg = normalizeCsvExtensionConfig(config);
  if (!cfg.enabled || paintedLines.length === 0) return [];

  // Chain-ends mode keeps the mission-level closed-loop guard (engine ends_at_start). In
  // per-line mode the chain has already been split into genuinely open edges, so the guard
  // does not apply — that is exactly what lets a closed square grow per-side run-ups.
  //
  // An all-curve mission is exempt in either mode: a circle closes on itself by definition,
  // and the rover still extends it along its analytic tangent.
  const allCurved = paintedLines.every((l) => analyticCurveTangents(l) != null);
  if (!cfg.perLine && !allCurved && isMissionClosedLoop(paintedLines)) return [];

  const edges = buildMarkEdges(paintedLines, Boolean(cfg.perLine));
  const freeness = computeEndpointFreeness(edges, Boolean(cfg.perLine));

  return edges.map((edge, i) => {
    const free = freeness[i];
    let pre: NedPair[] | null = null;
    let aft: NedPair[] | null = null;

    if (free.startFree && cfg.preM > 0 && edge.startDir) {
      const start = edge.points[0];
      pre = [
        [start[0] - cfg.preM * edge.startDir[0], start[1] - cfg.preM * edge.startDir[1]],
        start,
      ];
    }
    if (free.endFree && cfg.aftM > 0 && edge.endDir) {
      const end = edge.points[edge.points.length - 1];
      aft = [
        end,
        [end[0] + cfg.aftM * edge.endDir[0], end[1] + cfg.aftM * edge.endDir[1]],
      ];
    }
    return { edge, pre, aft };
  });
}

/**
 * Connectors that join the chain into one continuous drive.
 *
 * Port of the rover's two passes, which agree on one rule: travel spans **exit tip → next
 * entry tip**, never mark-end → next mark-start.
 *
 *  - `_entity_transit_previews` builds the preview from the same entry/exit tips.
 *  - `_insert_transit_connectors_between_segments` is the only routing pass once extensions
 *    are on, and emits a TRANSIT wherever consecutive runs do not already touch.
 *
 * Getting this wrong is what leaves run-ups floating: connect mark-to-mark and the rover
 * drives out along AFT, back over it, across, then back out along PRE — two reversals per
 * junction with the extensions exactly cancelled.
 */
export function buildExtensionTransitLines(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null,
  tolM: number = EXT_SEGMENT_JOIN_TOL_M
): PlanLine[] {
  const chain = buildExtendedMarkChain(paintedLines, config);
  if (chain.length < 2) return [];

  const out: PlanLine[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i];
    const to = chain[i + 1];
    const start = edgeExitPoint(from);
    const end = edgeEntryPoint(to);
    const length_m = distM(start, end);
    // Already touching (a corner the rover sprays straight through) — no travel to draw.
    if (length_m <= tolM) continue;

    const id = `ext-join-${from.edge.parentId}->${to.edge.parentId}`;
    out.push({
      id,
      label: `Transit: ${from.edge.parentLabel} → ${to.edge.parentLabel}`,
      layer: "transit",
      segmentRole: "none",
      is_mark: false,
      from: { id: 1, x: start[0], y: start[1] },
      to: { id: 2, x: end[0], y: end[1] },
      width: 0.1,
      entity: {
        entity_id: id,
        entity_type: "TRANSIT",
        layer: "TRANSIT",
        color: 0,
        is_mark: false,
        length_m,
        geometry: {},
        preview_points: [
          { north: start[0], east: start[1] },
          { north: end[0], east: end[1] },
        ],
      },
    });
  }
  return out;
}

function makeExtensionPlanLine(
  lineId: string,
  role: "pre" | "aft",
  points: NedPair[],
  parentLabel: string
): PlanLine {
  const id = role === "pre" ? `ext-pre-${lineId}` : `ext-aft-${lineId}`;
  const length_m = distM(points[0], points[points.length - 1]);
  const label =
    role === "pre"
      ? `Pre-ext: ${parentLabel}`
      : `Aft-ext: ${parentLabel}`;
  return {
    id,
    label,
    layer: "extension",
    segmentRole: role,
    is_mark: false,
    from: { id: 1, x: points[0][0], y: points[0][1] },
    to: { id: 2, x: points[points.length - 1][0], y: points[points.length - 1][1] },
    width: 0.1,
    entity: {
      entity_id: id,
      entity_type: "EXTENSION",
      layer: "EXTENSION",
      color: 0,
      is_mark: false,
      length_m,
      geometry: {},
      preview_points: points.map(([north, east]) => ({ north, east })),
    },
  };
}

/**
 * Preview PlanLines for painted paths (map / Path Order).
 *
 * Matches rover `path_entities` + `split_mark_segment_with_extensions` chain-ends
 * policy (per_line=false, the only mode the DXF UI exposes):
 *
 *   PRE: tip = start − preM · û_start  →  mark start
 *        (same as offset_point(start, sdir, −pre_m) → start)
 *   AFT: mark end  →  tip = end + aftM · û_end
 *
 * Only **free** ends get run-ups: an end is free when no other mark edge shares
 * that point within {@link EXT_JUNCTION_TOL_M} (backend `_extension_endpoint_freeness`).
 * Self-closed entities and closed chains therefore get no PRE/AFT — same as rover.
 *
 * perLine=true remains available for tests (corner-split freeness) but is not
 * exposed in the DXF Upload UI.
 */
export function buildCsvExtensionLines(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): PlanLine[] {
  const out: PlanLine[] = [];
  for (const item of buildExtendedMarkChain(paintedLines, config)) {
    if (item.pre) {
      out.push(
        makeExtensionPlanLine(item.edge.parentId, "pre", item.pre, item.edge.parentLabel)
      );
    }
    if (item.aft) {
      out.push(
        makeExtensionPlanLine(item.edge.parentId, "aft", item.aft, item.edge.parentLabel)
      );
    }
  }
  return out;
}

/** Operator-facing extension preview for Path Order interleaving. */
export type CsvExtensionPreview = {
  id: string;
  lineId: string;
  role: "pre" | "aft";
  label: string;
  lengthM: number;
};

export function buildCsvExtensionPreviews(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): CsvExtensionPreview[] {
  return buildCsvExtensionLines(paintedLines, config).map((line) => {
    const role: "pre" | "aft" = line.segmentRole === "aft" ? "aft" : "pre";
    const prefix = role === "pre" ? "ext-pre-" : "ext-aft-";
    const id = String(line.id);
    const lineId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
    return {
      id,
      lineId,
      role,
      label: line.label,
      lengthM: line.entity?.length_m ?? 0,
    };
  });
}

/** Total extension metres for UI totals. */
export function csvExtensionLengthM(
  paintedLines: PlanLine[],
  config?: Partial<CsvExtensionConfig> | null
): number {
  return buildCsvExtensionLines(paintedLines, config).reduce(
    (sum, l) => sum + (l.entity?.length_m ?? 0),
    0
  );
}
