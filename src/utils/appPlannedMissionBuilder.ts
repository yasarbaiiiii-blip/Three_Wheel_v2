/**
 * App-planned mission builder (contract v2, `POST /api/missions/plan`).
 *
 * The tablet is the single geometry author: this module turns the ordered
 * mark/travel runs from `buildTrajectory` into the exact payload the backend
 * stores. The backend only admits it (validation, a lossless 5 m densify and a
 * 10 mm boundary snap); the rover places it with the anchor. The app therefore
 * densifies to <= 5 m and snaps run boundaries itself, so the payload it sends
 * is the artifact that is stored, and the admission report must read
 * `densified_steps = 0` and `max_boundary_snap_m = 0`.
 *
 * Payload rules (docs/contracts/app_planned_mission.md):
 *  - frame `local_ned` with a required `anchor {lat, lon, alt?}`; points are
 *    true ground metres north/east of the anchor (WGS84 tangent plane,
 *    geoProjection). No `origin_ne_m`.
 *  - flags: bit0 = spray, bit1 = must-hit.
 *  - R1 every point of a mark run has spray, every point of a travel run none.
 *  - R2 runs alternate. R3 each run starts where the previous one ended
 *    (the builder bridges real gaps with explicit travel runs and snaps
 *    gaps of up to 10 mm). R4 the shared boundary point is must-hit if either
 *    copy is.
 *
 * Corner policy belongs to the rover's controller: sharp corners are plain
 * vertices with the must-hit bit, never filleted and never given pivot legs.
 */

import {
  ANCHOR_ALT_LIMIT_M,
  APP_MISSION_FRAME,
  BOUNDARY_SNAP_M,
  FLAG_MUST_HIT,
  FLAG_SPRAY_INTENT,
  MAX_MISSION_POINTS,
  MAX_MISSION_STEP_M,
  MAX_STORED_POINTS,
  MISSION_ENVELOPE_M,
  type AppPlannedMissionRequest,
  type AppPlannedPointTuple,
  type AppPlannedRun,
  type MissionAnchor,
} from "../contract/prod/missionPlan";
import type { PlanLine } from "../types/plan";
import type { CsvExtensionConfig } from "./missionExtensions";
import { buildTrajectory, type NedPair, type TrajectoryRun } from "./missionTrajectory";

export const APP_CLIENT_NAME = "Three_Wheel_v2";
export const APP_CLIENT_VERSION = "2.0.0";
/** Mission names longer than this are cut (backend limit). */
export const MAX_MISSION_NAME_CHARS = 128;

/**
 * Largest step the app emits. A hair under the backend's 5 m so the equal
 * sub-steps of a long segment can never measure above 5.0 after rounding (the
 * backend re-densifies anything strictly longer than 5 m).
 */
export const DENSIFY_STEP_M = MAX_MISSION_STEP_M - 1e-6;

/** Max path error (m) of the retained must-hit polyline vs every skipped sample. */
export const MUST_HIT_PATH_ERROR_M = 0.015;
/** Force-keep any vertex whose instantaneous turn exceeds this (deg). */
export const MUST_HIT_FORCE_TURN_DEG = 25;

export type DashPattern = {
  /** Painted length of one dash (m). */
  onM: number;
  /** Gap between dashes (m). */
  offM: number;
};

export const MIN_DASH_LENGTH_M = 0.05;
export const MAX_DASH_LENGTH_M = 100;

export class MissionPlanValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "MissionPlanValidationError";
    this.code = code;
  }
}

// ── Anchor ──────────────────────────────────────────────────────────────────

/**
 * Validate the GPS origin. A missing anchor is refused in the app: points are
 * relative to the app's GPS origin and must never be sent as EKF-local.
 */
export function normalizeMissionAnchor(
  anchor: MissionAnchor | [number, number] | null | undefined
): MissionAnchor {
  if (anchor == null) {
    throw new MissionPlanValidationError(
      "ANCHOR_REQUIRED",
      "The mission has no GPS origin (anchor). Align the plan on the map or load a georeferenced file before sending."
    );
  }
  const lat = Array.isArray(anchor) ? anchor[0] : anchor.lat;
  const lon = Array.isArray(anchor) ? anchor[1] : anchor.lon;
  const alt = Array.isArray(anchor) ? undefined : anchor.alt;
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new MissionPlanValidationError(
      "INVALID_ANCHOR",
      `GPS origin (${String(lat)}, ${String(lon)}) is not a valid latitude/longitude.`
    );
  }
  if (alt !== undefined && (!Number.isFinite(alt) || Math.abs(alt) > ANCHOR_ALT_LIMIT_M)) {
    throw new MissionPlanValidationError("INVALID_ANCHOR", `GPS origin altitude ${String(alt)} is not valid.`);
  }
  return alt === undefined ? { lat, lon } : { lat, lon, alt };
}

// ── Must-hit ────────────────────────────────────────────────────────────────

function pointToSegmentDistM(p: NedPair, a: NedPair, b: NedPair): number {
  const ab0 = b[0] - a[0];
  const ab1 = b[1] - a[1];
  const len2 = ab0 * ab0 + ab1 * ab1;
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * ab0 + (p[1] - a[1]) * ab1) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + ab0 * t), p[1] - (a[1] + ab1 * t));
}

/**
 * Indices the rover must hit: run endpoints, every vertex whose turn exceeds
 * {@link MUST_HIT_FORCE_TURN_DEG}, and the fewest interior points that keep the
 * retained polyline within {@link MUST_HIT_PATH_ERROR_M} of every skipped
 * sample (Douglas-Peucker). Collinear fill is never declared: over-declaring
 * collapses the controller's pure-pursuit lookahead (field 2026-07-29/30).
 * Sharp corners are plain must-hit vertices here, nothing more.
 */
export function collinearAwareMustHitIndices(points: NedPair[]): number[] {
  const n = points.length;
  if (n <= 2) return points.map((_, i) => i);

  const keep = new Set<number>([0, n - 1]);
  for (let i = 1; i < n - 1; i++) {
    const ux = points[i][0] - points[i - 1][0];
    const uy = points[i][1] - points[i - 1][1];
    const vx = points[i + 1][0] - points[i][0];
    const vy = points[i + 1][1] - points[i][1];
    if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) continue;
    const turnDeg = Math.abs((Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI);
    if (turnDeg > MUST_HIT_FORCE_TURN_DEG) keep.add(i);
  }

  // Iterative Douglas-Peucker between the sorted seeds (no recursion: a long
  // spiral would otherwise be bounded by the call stack).
  const seeds = Array.from(keep).sort((a, b) => a - b);
  const stack: Array<[number, number]> = [];
  for (let s = 0; s < seeds.length - 1; s++) stack.push([seeds[s], seeds[s + 1]]);
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    if (i1 - i0 <= 1) continue;
    let bestIdx = -1;
    let bestD = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = pointToSegmentDistM(points[i], points[i0], points[i1]);
      if (d > bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestD > MUST_HIT_PATH_ERROR_M) {
      keep.add(bestIdx);
      stack.push([i0, bestIdx], [bestIdx, i1]);
    }
  }
  return Array.from(keep).sort((a, b) => a - b);
}

// ── Dashes ──────────────────────────────────────────────────────────────────

export function validateDashPattern(pattern: DashPattern): void {
  const ok = (v: number) => Number.isFinite(v) && v >= MIN_DASH_LENGTH_M && v <= MAX_DASH_LENGTH_M;
  if (!ok(pattern.onM) || !ok(pattern.offM)) {
    throw new MissionPlanValidationError(
      "INVALID_DASH",
      `Dash lengths must be between ${MIN_DASH_LENGTH_M} m and ${MAX_DASH_LENGTH_M} m (ON ${String(pattern.onM)}, OFF ${String(pattern.offM)}).`
    );
  }
}

/**
 * Express a dashed line as alternating mark / travel runs. Each mark run
 * restarts with a dash at its first point. Cuts fall on exact positions along
 * the polyline; its original vertices (corners) stay in the pieces.
 */
export function applyDashPattern(runs: TrajectoryRun[], pattern: DashPattern): TrajectoryRun[] {
  validateDashPattern(pattern);
  const out: TrajectoryRun[] = [];
  for (const run of runs) {
    if (run.kind !== "mark" || run.points.length < 2) {
      out.push(run);
      continue;
    }
    let on = true;
    let remaining = pattern.onM;
    let current: NedPair[] = [run.points[0]];
    const flush = (closing: NedPair | null) => {
      if (closing) current.push(closing);
      if (current.length >= 2) {
        out.push({ ...run, kind: on ? "mark" : "travel", points: current });
      }
      current = closing ? [closing] : [];
    };
    for (let i = 1; i < run.points.length; i++) {
      const a = run.points[i - 1];
      const b = run.points[i];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let pos = 0;
      while (segLen - pos > remaining + 1e-9) {
        pos += remaining;
        const t = pos / segLen;
        const cut: NedPair = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        flush(cut);
        on = !on;
        remaining = on ? pattern.onM : pattern.offM;
      }
      remaining -= segLen - pos;
      current.push(b);
      if (remaining <= 1e-9 && i < run.points.length - 1) {
        flush(null);
        current = [b];
        on = !on;
        remaining = on ? pattern.onM : pattern.offM;
      }
    }
    flush(null);
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validates an AppPlannedMissionRequest against the backend admission rules and
 * against the extra requirement that admission is a no-op (no step above 5 m,
 * no gap between runs): the stored artifact must equal what was sent.
 * Throws MissionPlanValidationError carrying the backend's error code.
 */
export function validateAppPlannedMissionRequest(payload: AppPlannedMissionRequest): void {
  if (payload.frame !== APP_MISSION_FRAME) {
    throw new MissionPlanValidationError(
      "INVALID_FRAME",
      `Invalid frame '${String(payload.frame)}'. Must be '${APP_MISSION_FRAME}'.`
    );
  }
  normalizeMissionAnchor(payload.anchor);
  if ("origin_ne_m" in (payload as unknown as Record<string, unknown>)) {
    throw new MissionPlanValidationError(
      "ORIGIN_WITH_ANCHOR",
      "origin_ne_m must be absent: the anchor is the origin."
    );
  }

  const runs = payload.runs;
  if (!runs || runs.length === 0) {
    throw new MissionPlanValidationError("EMPTY_MISSION", "Mission has no runs.");
  }

  let submitted = 0;
  let stored = 0;

  for (let rIdx = 0; rIdx < runs.length; rIdx++) {
    const run = runs[rIdx];
    const pts = run.points;
    if (run.type !== "mark" && run.type !== "travel") {
      throw new MissionPlanValidationError("INVALID_RUN_TYPE", `Run ${rIdx} type '${String(run.type)}' is neither mark nor travel.`);
    }
    if (!pts || pts.length < 2) {
      throw new MissionPlanValidationError(
        "RUN_TOO_SHORT",
        `Run index ${rIdx} has ${pts?.length ?? 0} points; minimum is 2.`
      );
    }
    const isMark = run.type === "mark";

    for (let pIdx = 0; pIdx < pts.length; pIdx++) {
      const [north, east, flags] = pts[pIdx];
      if (!Number.isFinite(north) || !Number.isFinite(east)) {
        throw new MissionPlanValidationError(
          "NON_FINITE_COORDINATE",
          `Run ${rIdx} point ${pIdx} has non-finite coordinates: [${north}, ${east}].`
        );
      }
      if (Math.abs(north) > MISSION_ENVELOPE_M || Math.abs(east) > MISSION_ENVELOPE_M) {
        throw new MissionPlanValidationError(
          "OUT_OF_BOUNDS",
          `Run ${rIdx} point ${pIdx} [${north.toFixed(2)}, ${east.toFixed(2)}] is more than ${MISSION_ENVELOPE_M} m from the GPS origin.`
        );
      }
      if (!Number.isInteger(flags) || flags < 0 || flags > 3) {
        throw new MissionPlanValidationError("INVALID_FLAGS", `Run ${rIdx} point ${pIdx} flags ${String(flags)} must be an integer 0..3.`);
      }
      const spray = (flags & FLAG_SPRAY_INTENT) !== 0;
      if (spray !== isMark) {
        throw new MissionPlanValidationError(
          "mixed_spray_in_run",
          `${isMark ? "Mark" : "Travel"} run index ${rIdx} point ${pIdx} has spray bit ${spray ? 1 : 0}.`
        );
      }
      if (pIdx > 0) {
        const prev = pts[pIdx - 1];
        const step = Math.hypot(north - prev[0], east - prev[1]);
        if (step > MAX_MISSION_STEP_M) {
          throw new MissionPlanValidationError(
            "STEP_NOT_DENSIFIED",
            `Run ${rIdx} step ${pIdx - 1} to ${pIdx} is ${step.toFixed(3)} m: the app must densify to ${MAX_MISSION_STEP_M} m so admission changes nothing.`
          );
        }
      }
    }

    submitted += pts.length;
    stored += pts.length - (rIdx > 0 ? 1 : 0);

    if (rIdx > 0) {
      const prevRun = runs[rIdx - 1];
      if (run.type === prevRun.type) {
        throw new MissionPlanValidationError(
          "adjacent_runs_same_type",
          `Adjacent runs ${rIdx - 1} and ${rIdx} are both '${run.type}'.`
        );
      }
      const prevEnd = prevRun.points[prevRun.points.length - 1];
      const gap = Math.hypot(pts[0][0] - prevEnd[0], pts[0][1] - prevEnd[1]);
      if (gap > 1e-9) {
        throw new MissionPlanValidationError(
          "runs_not_contiguous",
          `Run ${rIdx} starts ${(gap * 1000).toFixed(1)} mm from the end of run ${rIdx - 1}; the app snaps boundaries before sending.`
        );
      }
    }
  }

  if (submitted > MAX_MISSION_POINTS) {
    throw new MissionPlanValidationError(
      "POINTS_LIMIT_EXCEEDED",
      `Mission has ${submitted} points; the limit is ${MAX_MISSION_POINTS}.`
    );
  }
  if (stored > MAX_STORED_POINTS) {
    throw new MissionPlanValidationError(
      "POINTS_LIMIT_EXCEEDED",
      `Mission would store ${stored} points; the limit is ${MAX_STORED_POINTS}.`
    );
  }
}

// ── Expected admission ──────────────────────────────────────────────────────

export type ExpectedAdmission = {
  numRuns: number;
  /** Points the artifact stores (the shared boundary point appears once). */
  numPoints: number;
  numSprayPoints: number;
  markLengthM: number;
  transitLengthM: number;
  bboxNeM: [number, number, number, number];
  /** The stored point list, in order, as the backend writes it (rule R4). */
  storedPoints: AppPlannedPointTuple[];
};

/**
 * What the backend stores for a payload that needs no normalisation: the
 * artifact point list (R4 merge of shared boundary points), the point and
 * spray counts, the mark/transit lengths and the bounding box.
 */
export function computeExpectedAdmission(payload: AppPlannedMissionRequest): ExpectedAdmission {
  const stored: AppPlannedPointTuple[] = [];
  let markLengthM = 0;
  let transitLengthM = 0;
  payload.runs.forEach((run, rIdx) => {
    for (let i = 1; i < run.points.length; i++) {
      const d = Math.hypot(
        run.points[i][0] - run.points[i - 1][0],
        run.points[i][1] - run.points[i - 1][1]
      );
      if (run.type === "mark") markLengthM += d;
      else transitLengthM += d;
    }
    if (rIdx === 0) {
      for (const p of run.points) stored.push([p[0], p[1], p[2]]);
    } else {
      const last = stored[stored.length - 1];
      last[2] |= run.points[0][2] & FLAG_MUST_HIT;
      for (let i = 1; i < run.points.length; i++) {
        const p = run.points[i];
        stored.push([p[0], p[1], p[2]]);
      }
    }
  });
  let minN = Infinity;
  let minE = Infinity;
  let maxN = -Infinity;
  let maxE = -Infinity;
  let spray = 0;
  for (const [n, e, f] of stored) {
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if ((f & FLAG_SPRAY_INTENT) !== 0) spray++;
  }
  return {
    numRuns: payload.runs.length,
    numPoints: stored.length,
    numSprayPoints: spray,
    markLengthM,
    transitLengthM,
    bboxNeM: [minN, minE, maxN, maxE],
    storedPoints: stored,
  };
}

// ── Builder ─────────────────────────────────────────────────────────────────

export interface BuildAppPlannedMissionOptions {
  runs: TrajectoryRun[];
  /** WGS84 position of the trajectory's local origin. Required. */
  anchor: MissionAnchor | [number, number] | null | undefined;
  missionName?: string;
  clientName?: string;
  clientVersion?: string;
  /** Alternating ON/OFF dashes along every mark run (spray pattern). */
  dash?: DashPattern | null;
}

type RawRun = { kind: "mark" | "travel"; points: NedPair[] };

/**
 * Builds the canonical AppPlannedMissionRequest from TrajectoryRuns:
 * - bridges spatial gaps over 10 mm with explicit travel runs;
 * - merges neighbouring runs of the same type;
 * - snaps gaps of up to 10 mm onto the previous run's end (the backend's rule,
 *   applied here so the payload is stored unchanged);
 * - sets spray bits per run type, must-hit bits per {@link collinearAwareMustHitIndices};
 * - densifies steps above 5 m into equal collinear sub-steps.
 */
export function buildAppPlannedMissionPayload(
  options: BuildAppPlannedMissionOptions
): AppPlannedMissionRequest {
  const anchor = normalizeMissionAnchor(options.anchor);
  const {
    missionName = "app_planned_mission",
    clientName = APP_CLIENT_NAME,
    clientVersion = APP_CLIENT_VERSION,
  } = options;

  if (!options.runs || options.runs.length === 0) {
    throw new MissionPlanValidationError("EMPTY_MISSION", "Mission has no runs.");
  }
  const inputRuns = options.dash ? applyDashPattern(options.runs, options.dash) : options.runs;

  // Phase 1: validate geometry. Nothing is dropped silently.
  const sanitized: RawRun[] = [];
  for (let i = 0; i < inputRuns.length; i++) {
    const r = inputRuns[i];
    if (!r.points || r.points.length < 2) {
      throw new MissionPlanValidationError(
        "RUN_TOO_SHORT",
        `Run ${i} has ${r.points?.length ?? 0} point(s); every run needs at least 2.`
      );
    }
    for (let pIdx = 0; pIdx < r.points.length; pIdx++) {
      const pt = r.points[pIdx];
      if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        throw new MissionPlanValidationError(
          "NON_FINITE_COORDINATE",
          `Run ${i} point ${pIdx} has non-finite coordinates: [${pt[0]}, ${pt[1]}].`
        );
      }
      if (Math.abs(pt[0]) > MISSION_ENVELOPE_M || Math.abs(pt[1]) > MISSION_ENVELOPE_M) {
        throw new MissionPlanValidationError(
          "OUT_OF_BOUNDS",
          `Run ${i} point ${pIdx} [${pt[0].toFixed(2)}, ${pt[1].toFixed(2)}] is more than ${MISSION_ENVELOPE_M} m from the GPS origin.`
        );
      }
    }
    sanitized.push({ kind: r.kind, points: r.points.map((p) => [p[0], p[1]] as NedPair) });
  }

  // Phase 2: contiguity (R3) and alternation (R2).
  const connected: RawRun[] = [];
  for (const curr of sanitized) {
    if (connected.length === 0) {
      connected.push({ kind: curr.kind, points: curr.points.slice() });
      continue;
    }
    const prev = connected[connected.length - 1];
    const prevEnd = prev.points[prev.points.length - 1];
    const currStart = curr.points[0];
    const gap = Math.hypot(currStart[0] - prevEnd[0], currStart[1] - prevEnd[1]);

    if (gap > BOUNDARY_SNAP_M) {
      if (prev.kind === "travel") {
        prev.points.push([currStart[0], currStart[1]]);
      } else {
        connected.push({
          kind: "travel",
          points: [[prevEnd[0], prevEnd[1]], [currStart[0], currStart[1]]],
        });
      }
    }

    const last = connected[connected.length - 1];
    const lastEnd = last.points[last.points.length - 1];
    // Snap: the run starts exactly at the previous end.
    const snapped: NedPair[] = [[lastEnd[0], lastEnd[1]], ...curr.points.slice(1)];
    if (curr.kind === last.kind) {
      for (let k = 1; k < snapped.length; k++) last.points.push(snapped[k]);
    } else {
      connected.push({ kind: curr.kind, points: snapped });
    }
  }

  // Phase 3: flags, must-hit, densify.
  const finalRuns: AppPlannedRun[] = [];
  for (let rIdx = 0; rIdx < connected.length; rIdx++) {
    const run = connected[rIdx];
    const sprayBit = run.kind === "mark" ? FLAG_SPRAY_INTENT : 0;
    const raw = run.points;
    // Travel is deadhead: only its endpoints are shape-bearing. Sending more
    // must-hit points on extension legs collapses the controller's lookahead.
    const mustHit = new Set(
      run.kind === "mark" ? collinearAwareMustHitIndices(raw) : [0, raw.length - 1]
    );
    const tuples: AppPlannedPointTuple[] = [];
    for (let i = 0; i < raw.length; i++) {
      const [north, east] = raw[i];
      if (i > 0) {
        const prev = raw[i - 1];
        const dn = north - prev[0];
        const de = east - prev[1];
        const dist = Math.hypot(dn, de);
        if (dist > DENSIFY_STEP_M) {
          const parts = Math.ceil(dist / DENSIFY_STEP_M);
          for (let s = 1; s < parts; s++) {
            tuples.push([prev[0] + (dn * s) / parts, prev[1] + (de * s) / parts, sprayBit]);
          }
        }
      }
      tuples.push([north, east, sprayBit | (mustHit.has(i) ? FLAG_MUST_HIT : 0)]);
    }
    if (tuples.length < 2) {
      throw new MissionPlanValidationError("RUN_TOO_SHORT", `Run index ${rIdx} has fewer than 2 points.`);
    }
    finalRuns.push({ type: run.kind, points: tuples });
  }

  // R4: the shared boundary point is must-hit when either copy is.
  for (let k = 1; k < finalRuns.length; k++) {
    const prevEnd = finalRuns[k - 1].points[finalRuns[k - 1].points.length - 1];
    const currStart = finalRuns[k].points[0];
    if (((prevEnd[2] | currStart[2]) & FLAG_MUST_HIT) !== 0) {
      prevEnd[2] |= FLAG_MUST_HIT;
      currStart[2] |= FLAG_MUST_HIT;
    }
  }

  const payload: AppPlannedMissionRequest = {
    client: clientName,
    client_version: clientVersion,
    name: missionName.slice(0, MAX_MISSION_NAME_CHARS),
    frame: APP_MISSION_FRAME,
    anchor,
    runs: finalRuns,
  };
  validateAppPlannedMissionRequest(payload);
  return payload;
}

/**
 * Builds an AppPlannedMissionRequest directly from PlanLine[] geometry.
 */
export function buildAppPlannedMissionFromLines(args: {
  lines: PlanLine[];
  anchor: MissionAnchor | [number, number] | null | undefined;
  missionName?: string;
  extensionConfig?: CsvExtensionConfig | null;
  dash?: DashPattern | null;
}): AppPlannedMissionRequest {
  const trajectory = buildTrajectory(args.lines, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions: args.extensionConfig,
    includeEntryTransit: false,
  });
  return buildAppPlannedMissionPayload({
    runs: trajectory.runs,
    anchor: args.anchor,
    missionName: args.missionName,
    dash: args.dash,
  });
}
