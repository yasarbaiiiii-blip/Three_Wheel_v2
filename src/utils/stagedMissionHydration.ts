import type { PlanLine } from "../types/plan";

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
