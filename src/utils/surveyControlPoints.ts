/**
 * Which points to draw as the "Control Points" map layer, and where.
 *
 * Two sources, in strict preference order:
 *
 * 1. `controlPoints` — the backend preview's `control_points`: the ORIGINAL
 *    surveyed shots, each carrying the lat/lon parsed from the source file.
 * 2. `PlanLine.from/to` with `mustHit` — the legacy scan.
 *
 * The order matters and is not cosmetic. Once the backend fits arcs through a
 * survey, `mustHit` marks the FITTED ARC ENDPOINTS rather than the measurements,
 * so the scan under-reports badly: 2 dots for an 8-shot curve, 4 for a 288-shot
 * roundabout. The scan is still correct for sources the backend does not fit
 * (DXF, legacy NED CSV) and for backends predating `control_points`, so it stays
 * as the fallback.
 */
import type { PlanLine, SurveyControlPoint } from "../types/plan";

export interface ControlPointMarker {
  lat: number;
  lon: number;
  label: string;
  code: string;
  /** Which source produced it — surfaced for tests and debugging. */
  source: "control_points" | "must_hit";
}

type ProjectFn = (north: number, east: number) => { lat: number; lon: number };

/**
 * @param controlPoints backend `control_points`, or null/empty when unavailable
 * @param lines         plan lines, used only for the mustHit fallback
 * @param project       NED -> GPS, using the same origin as the plan stroke
 */
export function buildControlPointMarkers(
  controlPoints: SurveyControlPoint[] | null | undefined,
  lines: PlanLine[] | null | undefined,
  project: ProjectFn
): ControlPointMarker[] {
  if (controlPoints && controlPoints.length > 0) {
    return controlPoints.map((c) => {
      // Prefer the SOURCE lat/lon over re-projecting north/east through our own
      // projection — it is the same point either way (the backend verifies the
      // two agree to 0.0000 mm) but the source values are lossless. They are
      // null only for a grid-only export, which carries no geographic anchor.
      const useGeo = Number.isFinite(c.lat as number) && Number.isFinite(c.lon as number);
      const { lat, lon } = useGeo
        ? { lat: c.lat as number, lon: c.lon as number }
        : project(c.north, c.east);
      return {
        lat,
        lon,
        label: c.name ?? "",
        code: c.code ?? "",
        source: "control_points" as const,
      };
    });
  }

  if (!lines || lines.length === 0) return [];

  const out: ControlPointMarker[] = [];
  const seen = new Set<string>();
  const add = (pt: { x: number; y: number; mustHit?: boolean } | undefined) => {
    if (!pt || pt.mustHit !== true) return;
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    // Adjacent PlanLines share a vertex (each line's `to` is the next `from`).
    const key = `${pt.x.toFixed(4)}|${pt.y.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { lat, lon } = project(pt.x, pt.y);   // PlanPoint.x = north, .y = east
    out.push({ lat, lon, label: "", code: "", source: "must_hit" });
  };
  for (const line of lines) {
    add(line.from);
    add(line.to);
  }
  return out;
}
