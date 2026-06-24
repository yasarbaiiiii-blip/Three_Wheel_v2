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

  for (let i = 0; i < pts.length - 1; i++) {
    const sprayFlag = flags[i] ?? true;
    const fromNorth = coerceFiniteNumber((pts[i] as number[])?.[0]);
    const fromEast = coerceFiniteNumber((pts[i] as number[])?.[1]);
    const toNorth = coerceFiniteNumber((pts[i + 1] as number[])?.[0]);
    const toEast = coerceFiniteNumber((pts[i + 1] as number[])?.[1]);

    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) {
      continue;
    }

    lines.push({
      id: `staged-line-${i}`,
      label: `Segment ${i + 1}`,
      layer: sprayFlag ? "marking" : "transit",
      from: { id: i * 2 + 1, x: fromNorth, y: fromEast },
      to: { id: i * 2 + 2, x: toNorth, y: toEast },
      width: 0.1,
    });
  }

  return lines;
}