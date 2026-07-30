import type { PlanLine } from "../types/plan";
import {
  appendExtensionLegsFromPlanLines,
  EXTENSION_ENDPOINT_MATCH_EPS_M,
  matchNonSprayToExtensionRole,
  type ExtensionSegmentRole,
} from "./extensionTransitClassify";

export type StagedAlignedRefPoint = {
  dxf_x: number;
  dxf_y: number;
  lat: number;
  lon: number;
};

export type StagedMissionArtifact = {
  mission_id?: string;
  anchor?: Record<string, unknown> | null;
  waypoints?: unknown[];
  spray_flags?: unknown[];
};

function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

const COLLINEAR_DEVIATION_M = 0.002;
const COLLINEAR_HEADING_DEG = 0.25;
const MIN_SEGMENT_LENGTH_M = 1e-9;

type LocalPoint = {
  north: number;
  east: number;
};

type PendingLine = {
  start: LocalPoint;
  end: LocalPoint;
  layer: PlanLine["layer"];
};

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.north - a.north, b.east - a.east);
}

function headingDeltaDeg(a: LocalPoint, b: LocalPoint, c: LocalPoint): number {
  const ux = b.north - a.north;
  const uy = b.east - a.east;
  const vx = c.north - b.north;
  const vy = c.east - b.east;
  const cross = ux * vy - uy * vx;
  const dot = ux * vx + uy * vy;
  return Math.abs(Math.atan2(cross, dot) * 180 / Math.PI);
}

function perpendicularDeviationM(a: LocalPoint, b: LocalPoint, p: LocalPoint): number {
  const len = distance(a, b);
  if (len <= MIN_SEGMENT_LENGTH_M) return 0;
  const cross = (b.north - a.north) * (a.east - p.east) - (a.north - p.north) * (b.east - a.east);
  return Math.abs(cross) / len;
}

function canMergeCollinear(run: PendingLine, nextEnd: LocalPoint): boolean {
  if (distance(run.end, nextEnd) <= MIN_SEGMENT_LENGTH_M) return true;
  return (
    headingDeltaDeg(run.start, run.end, nextEnd) <= COLLINEAR_HEADING_DEG &&
    perpendicularDeviationM(run.start, run.end, nextEnd) <= COLLINEAR_DEVIATION_M
  );
}

function makePlanLine(run: PendingLine, index: number): PlanLine {
  return {
    id: `staged-line-${index}`,
    label: `Segment ${index + 1}`,
    layer: run.layer,
    from: { id: index * 2 + 1, x: run.start.north, y: run.start.east },
    to: { id: index * 2 + 2, x: run.end.north, y: run.end.east },
    width: 0.1,
  };
}

/**
 * True when a PlanLine id was minted by staged-mission hydration — i.e. the
 * line's geometry is the ROVER'S densified output (5 cm waypoints) redrawn on
 * the map, not a fresh file import.
 *
 * Send paths must refuse these as source geometry: re-sending them re-plans
 * rover output as survey input, so every 5 cm waypoint becomes a "source
 * vertex". Field 2026-07-29: one such re-send staged a mission with
 * must_hit=122 of 123 waypoints and scored the worst curve RMS of the day
 * (4.88 cm) — the RPP lookahead was clipped to the 5 cm segment length.
 *
 * Keep the prefix list in sync with the ids minted in this module:
 * makePlanLine (`staged-line-`), pointMissionPointsToPlanLines (`pt-`),
 * polylineSliceToPlanLine (`rover-ext-`, `rover-transit-`), and
 * sprayRunsToPlanLines (`rover-path-`, `rover-transit-`).
 */
export function isStagedHydrationLineId(id: string): boolean {
  return /^(staged-line-|rover-path-|rover-transit-|rover-ext-|pt-)/.test(id);
}

export function stagedMissionMatchesId(
  artifact: StagedMissionArtifact | null | undefined,
  missionId: string
): boolean {
  const expected = missionId.trim();
  const actual = typeof artifact?.mission_id === "string" ? artifact.mission_id.trim() : "";
  return expected !== "" && actual === expected;
}

/** Staged waypoints are surveyed/local NED metres; MapView origin uses anchor GPS at local (0,0). */
export function anchorToAlignedRefPoints(
  anchor: Record<string, unknown> | null | undefined
): StagedAlignedRefPoint[] {
  if (!anchor) return [];
  const lat = coerceFiniteNumber(anchor.lat);
  const lon = coerceFiniteNumber(anchor.lon);
  if (lat == null || lon == null) return [];
  return [{ dxf_x: 0, dxf_y: 0, lat, lon }];
}

export type PointMissionPointLike = {
  north_m: number;
  east_m: number;
  mark?: boolean;
};

/** Point missions have no line geometry — render each point as a zero-length
 * marker segment so the map preview shows something at every stop. */
export function pointMissionPointsToPlanLines(
  points: PointMissionPointLike[] | null | undefined
): PlanLine[] {
  const pts = Array.isArray(points) ? points : [];
  return pts.map((pt, i) => ({
    id: `pt-${i}`,
    label: `Point ${i + 1}`,
    layer: pt.mark !== false ? "marking" : "center",
    from: { id: 500000 + i * 2, x: pt.north_m, y: pt.east_m },
    to: { id: 500000 + i * 2 + 1, x: pt.north_m, y: pt.east_m },
    width: 0.1,
  }));
}

/**
 * Single map hydration for a staged mission: geometry + origin together.
 *
 * Call sites must never set lines and alignedRefPoints independently — that was the
 * Send-to-Rover frame desync (panel updated lines from plan.merged_waypoints without
 * the staged anchor). One artifact in → consistent triple out, or null when nothing
 * is drawable.
 *
 * LOCAL_NED / missing anchor: `alignedRefPoints` is [] (explicit parity with prior
 * `anchorToAlignedRefPoints(null)` behaviour at load/recovery).
 */
export type StagedMissionHydrationInput = {
  waypoints?: unknown[] | null;
  spray_flags?: unknown[] | null;
  point_mission_points?: PointMissionPointLike[] | null;
  anchor?: Record<string, unknown> | null;
};

export type StagedMissionMapHydration = {
  lines: PlanLine[];
  alignedRefPoints: StagedAlignedRefPoint[];
  selectedLineId: string | null;
};

export type HydrateStagedMissionOpts = {
  /**
   * Pre-send `layer:"extension"` PlanLines. Used to relabel non-spray runs after
   * hydrate (artifact only has spray_flags — no third run type).
   */
  extensionLines?: PlanLine[] | null;
};

export function hydrateStagedMissionForMap(
  artifact: StagedMissionHydrationInput | null | undefined,
  opts?: HydrateStagedMissionOpts
): StagedMissionMapHydration | null {
  if (!artifact) return null;

  let lines = sprayRunsToPlanLines(
    (artifact.waypoints as unknown[]) ?? [],
    (artifact.spray_flags as unknown[]) ?? []
  );

  if (lines.length === 0 && artifact.point_mission_points?.length) {
    lines = pointMissionPointsToPlanLines(artifact.point_mission_points);
  }

  if (lines.length === 0) return null;

  if (opts?.extensionLines && opts.extensionLines.length > 0) {
    lines = relabelHydratedLinesWithExtensions(lines, opts.extensionLines);
  }

  // Always derive origin from the same artifact as geometry — never leave the
  // caller free to pair plan.merged_waypoints with a stale/missing anchor.
  const alignedRefPoints = anchorToAlignedRefPoints(artifact.anchor ?? null);

  return {
    lines,
    alignedRefPoints,
    selectedLineId: lines[0]?.id ?? null,
  };
}

function pointNear(
  n1: number,
  e1: number,
  n2: number,
  e2: number,
  epsM: number
): boolean {
  return Math.hypot(n1 - n2, e1 - e2) <= epsM;
}

function nearestVertexIndex(
  pts: Array<{ north: number; east: number }>,
  north: number,
  east: number
): number {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].north - north, pts[i].east - east);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function polylineSliceToPlanLine(
  pts: Array<{ north: number; east: number }>,
  fromI: number,
  toI: number,
  kind: "extension" | "transit",
  role: ExtensionSegmentRole | "none",
  ordinal: number
): PlanLine | null {
  if (toI <= fromI) return null;
  const slice = pts.slice(fromI, toI + 1);
  if (slice.length < 2) return null;
  let lengthM = 0;
  for (let i = 1; i < slice.length; i++) {
    lengthM += Math.hypot(slice[i].north - slice[i - 1].north, slice[i].east - slice[i - 1].east);
  }
  const first = slice[0];
  const last = slice[slice.length - 1];
  const id =
    kind === "extension"
      ? `rover-ext-${role}-${ordinal}`
      : `rover-transit-${ordinal}`;
  const label =
    kind === "extension"
      ? `${role === "pre" ? "Pre" : "Aft"}-ext ${ordinal} (${lengthM.toFixed(1)} m)`
      : `Transit ${ordinal} (${lengthM.toFixed(1)} m)`;
  return {
    id,
    label,
    layer: kind === "extension" ? "extension" : "transit",
    segmentRole: role === "none" ? "none" : role,
    ...(kind === "extension" ? { is_mark: false } : {}),
    from: { id: ordinal * 2 + 1, x: first.north, y: first.east },
    to: { id: ordinal * 2 + 2, x: last.north, y: last.east },
    width: 0.1,
    entity: {
      entity_id: id,
      entity_type: kind === "extension" ? "EXTENSION" : "TRANSIT",
      layer: kind === "extension" ? "EXTENSION" : "TRANSIT",
      color: 0,
      is_mark: false,
      length_m: lengthM,
      geometry: {},
      preview_points: slice.map((p) => ({ north: p.north, east: p.east })),
    },
  };
}

/**
 * Recover extension labels on post-send map redraw.
 * Full-segment match → one extension line. Merged aft|connector|pre peels ends
 * when catalog endpoints land on the polyline (middle stays transit).
 */
export function relabelHydratedLinesWithExtensions(
  lines: PlanLine[],
  extensionSourceLines: PlanLine[],
  epsM: number = EXTENSION_ENDPOINT_MATCH_EPS_M
): PlanLine[] {
  const catalog = appendExtensionLegsFromPlanLines([], extensionSourceLines);
  if (catalog.length === 0) return lines;

  const out: PlanLine[] = [];
  let extN = 0;
  let transitN = 0;

  for (const line of lines) {
    if (line.layer === "marking" || line.is_mark === true) {
      out.push(line);
      continue;
    }

    const pts =
      line.entity?.preview_points?.filter(
        (p) => p != null && Number.isFinite(p.north) && Number.isFinite(p.east)
      ) ?? null;
    if (!pts || pts.length < 2) {
      out.push(line);
      continue;
    }

    const fullRole = matchNonSprayToExtensionRole(
      pts[0].north,
      pts[0].east,
      pts[pts.length - 1].north,
      pts[pts.length - 1].east,
      catalog,
      epsM
    );
    if (fullRole) {
      extN += 1;
      const relabeled = polylineSliceToPlanLine(pts, 0, pts.length - 1, "extension", fullRole, extN);
      out.push(relabeled ?? line);
      continue;
    }

    let lo = 0;
    let hi = pts.length - 1;
    let leadRole: ExtensionSegmentRole | null = null;
    let trailRole: ExtensionSegmentRole | null = null;
    let leadEnd = 0;
    let trailStart = hi;

    for (const leg of catalog) {
      if (
        leg.role === "aft" &&
        pointNear(pts[0].north, pts[0].east, leg.fromNorth, leg.fromEast, epsM)
      ) {
        const idx = nearestVertexIndex(pts, leg.toNorth, leg.toEast);
        if (idx > lo && idx < hi) {
          leadRole = "aft";
          leadEnd = idx;
        }
      }
      if (
        leg.role === "pre" &&
        pointNear(pts[hi].north, pts[hi].east, leg.toNorth, leg.toEast, epsM)
      ) {
        const idx = nearestVertexIndex(pts, leg.fromNorth, leg.fromEast);
        if (idx > lo && idx < hi) {
          trailRole = "pre";
          trailStart = idx;
        }
      }
    }

    // Leading pure-pre travel (mission start): catalog pre from tip → mark start.
    if (!leadRole) {
      for (const leg of catalog) {
        if (
          leg.role === "pre" &&
          pointNear(pts[0].north, pts[0].east, leg.fromNorth, leg.fromEast, epsM) &&
          pointNear(pts[hi].north, pts[hi].east, leg.toNorth, leg.toEast, epsM)
        ) {
          leadRole = "pre";
          leadEnd = hi;
          break;
        }
      }
    }
    if (!trailRole && leadEnd < hi) {
      for (const leg of catalog) {
        if (
          leg.role === "aft" &&
          pointNear(pts[0].north, pts[0].east, leg.fromNorth, leg.fromEast, epsM) &&
          pointNear(pts[hi].north, pts[hi].east, leg.toNorth, leg.toEast, epsM)
        ) {
          trailRole = "aft";
          trailStart = 0;
          break;
        }
      }
    }

    if (!leadRole && !trailRole) {
      out.push(line);
      continue;
    }

    if (leadRole && leadEnd > 0) {
      extN += 1;
      const piece = polylineSliceToPlanLine(pts, 0, leadEnd, "extension", leadRole, extN);
      if (piece) out.push(piece);
      lo = leadEnd;
    }
    const midEnd = trailRole && trailStart > lo ? trailStart : hi;
    if (midEnd > lo) {
      transitN += 1;
      const mid = polylineSliceToPlanLine(pts, lo, midEnd, "transit", "none", transitN);
      if (mid) out.push(mid);
      lo = midEnd;
    }
    if (trailRole && hi > lo) {
      extN += 1;
      const piece = polylineSliceToPlanLine(pts, lo, hi, "extension", trailRole, extN);
      if (piece) out.push(piece);
    }
  }

  return out;
}

/** Below this the two points are the same place — no bridging point needed. */
const RUN_JOIN_TOL_M = 1e-9;

function runPolylineLengthM(points: LocalPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

/**
 * Planned waypoints → ONE PlanLine per continuous painted (or transit) run, carrying the
 * run's whole polyline in `entity.preview_points`.
 *
 * Distinct from `waypointsToPlanLines`, which emits a line per *collinear* stretch. That is
 * the right shape for a mission the operator inspects segment by segment, but a surveyed
 * road arrives from the planner tessellated at ~10 cm with about half a degree of turn per
 * step — never collinear — so a 70 m curve becomes ~700 two-point lines. Grouping by spray
 * state instead keeps the map at one stroke per path and the Path Order list at one row per
 * path, which is what the CSV preview already showed before staging.
 *
 * Each run reaches one point into the next so the strokes visibly join: the planner emits
 * the shared junction point twice (its de-duplication only collapses coincident points that
 * agree on spray state), but a connector whose first point merely sits close would
 * otherwise leave a visible gap.
 */
export function sprayRunsToPlanLines(
  waypoints: unknown[],
  sprayFlags: unknown[] = []
): PlanLine[] {
  const rawPoints = Array.isArray(waypoints) ? waypoints : [];
  const rawFlags = Array.isArray(sprayFlags) ? sprayFlags : [];

  const pts: { point: LocalPoint; spray: boolean }[] = [];
  for (let i = 0; i < rawPoints.length; i++) {
    const north = coerceFiniteNumber((rawPoints[i] as number[])?.[0]);
    const east = coerceFiniteNumber((rawPoints[i] as number[])?.[1]);
    if (north == null || east == null) continue;
    pts.push({ point: { north, east }, spray: rawFlags[i] !== false });
  }
  if (pts.length < 2) return [];

  const runs: { spray: boolean; points: LocalPoint[] }[] = [];
  for (const entry of pts) {
    const current = runs[runs.length - 1];
    if (current && current.spray === entry.spray) current.points.push(entry.point);
    else runs.push({ spray: entry.spray, points: [entry.point] });
  }

  const lines: PlanLine[] = [];
  let markCount = 0;
  let transitCount = 0;

  runs.forEach((run, index) => {
    const polyline = run.points.slice();
    const next = runs[index + 1];
    if (next?.points.length) {
      const bridge = next.points[0];
      if (distance(polyline[polyline.length - 1], bridge) > RUN_JOIN_TOL_M) polyline.push(bridge);
    }
    if (polyline.length < 2) return;

    const lengthM = runPolylineLengthM(polyline);
    const first = polyline[0];
    const last = polyline[polyline.length - 1];
    const ordinal = run.spray ? (markCount += 1) : (transitCount += 1);
    const id = run.spray ? `rover-path-${ordinal}` : `rover-transit-${ordinal}`;
    const previewPoints = polyline.map((p) => ({ north: p.north, east: p.east }));

    lines.push({
      id,
      label: `${run.spray ? "Path" : "Transit"} ${ordinal} (${lengthM.toFixed(1)} m)`,
      layer: run.spray ? "marking" : "transit",
      ...(run.spray ? { is_mark: true } : { segmentRole: "none" as const }),
      from: { id: index * 2 + 1, x: first.north, y: first.east },
      to: { id: index * 2 + 2, x: last.north, y: last.east },
      width: 0.1,
      entity: {
        entity_id: id,
        entity_type: run.spray ? "LWPOLYLINE" : "TRANSIT",
        layer: run.spray ? "MARK" : "TRANSIT",
        color: run.spray ? 7 : 0,
        is_mark: run.spray,
        length_m: lengthM,
        geometry: run.spray
          ? { closed: false, road_marking: true, vertexCount: previewPoints.length }
          : {},
        preview_points: previewPoints,
      },
    });
  });

  return lines;
}

export function waypointsToPlanLines(
  waypoints: unknown[],
  sprayFlags: unknown[] = []
): PlanLine[] {
  const pts = Array.isArray(waypoints) ? waypoints : [];
  const flags = Array.isArray(sprayFlags) ? sprayFlags : [];
  const lines: PlanLine[] = [];
  let pending: PendingLine | null = null;

  const flush = () => {
    if (!pending || distance(pending.start, pending.end) <= MIN_SEGMENT_LENGTH_M) return;
    lines.push(makePlanLine(pending, lines.length));
    pending = null;
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const sprayFlag = flags[i] ?? true;
    const fromNorth = coerceFiniteNumber((pts[i] as number[])?.[0]);
    const fromEast = coerceFiniteNumber((pts[i] as number[])?.[1]);
    const toNorth = coerceFiniteNumber((pts[i + 1] as number[])?.[0]);
    const toEast = coerceFiniteNumber((pts[i + 1] as number[])?.[1]);

    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
      flush();
      continue;
    }

    const from = { north: fromNorth, east: fromEast };
    const to = { north: toNorth, east: toEast };
    const layer: PlanLine["layer"] = sprayFlag ? "marking" : "transit";

    if (distance(from, to) <= MIN_SEGMENT_LENGTH_M) {
      continue;
    }

    if (
      pending &&
      pending.layer === layer &&
      distance(pending.end, from) <= COLLINEAR_DEVIATION_M &&
      canMergeCollinear(pending, to)
    ) {
      pending.end = to;
      continue;
    }

    flush();
    pending = { start: from, end: to, layer };
  }

  flush();
  return lines;
}
