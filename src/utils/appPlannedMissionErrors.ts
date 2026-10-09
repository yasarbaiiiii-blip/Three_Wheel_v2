/**
 * Human-readable mapping for POST /api/missions/plan 422 error codes.
 * Contract: docs/contracts/app_planned_mission.md (v1.1)
 */

export const MISSION_PLAN_ERROR_DESCRIPTIONS: Record<string, string> = {
  mixed_spray_in_run:
    "Mixed spray states within a run: all points in a mark run must have spray ON (bit0=1), and all points in a travel run must have spray OFF (bit0=0).",
  adjacent_runs_same_type:
    "Adjacent runs have the same type: runs must strictly alternate between mark and travel. Same-type runs must be merged.",
  runs_not_contiguous:
    "Gap between runs: each run must start exactly at the previous run's end (within 1mm). All transit between runs must be an explicit travel run.",
  run_too_short:
    "A run has fewer than 2 points: every run must define at least a start and an end point.",
  step_too_large:
    "Step length exceeds limit: consecutive points are farther than 5.0m apart. Segment must be densified.",
  out_of_bounds:
    "Point coordinates exceed the ±10,000m local NED envelope.",
  point_limit_exceeded:
    "Mission exceeds the 50,000 point limit.",
  empty_mission:
    "The mission contains no runs or zero valid points.",
  non_finite_coordinate:
    "Point coordinates contain NaN or infinity.",
  bad_frame:
    "Unsupported coordinate frame: frame must be 'local_ned'.",
};

export function formatMissionPlanError(code: string, reason?: string): string {
  const normalizedCode = code.toLowerCase().trim();
  const description = MISSION_PLAN_ERROR_DESCRIPTIONS[normalizedCode];
  if (description) {
    return reason ? `${description}\n(${reason})` : description;
  }
  return reason || `Mission validation rejected with code: ${code}`;
}
