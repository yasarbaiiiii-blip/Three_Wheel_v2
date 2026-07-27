/**
 * Phase 4 — verify plan-trajectory response against what we sent.
 *
 * Always compare against `run_echo`, never `staged.segment_runs` (adjacent MARKs
 * collapse in segment_runs derived from spray_flags).
 *
 * Also spot-checks `must_hit` on staged waypoints for our sent vertices (plan Phase 4 table).
 */

import type { PlanTrajectoryResponse, RunEchoEntry } from "../api/planTrajectory";
import {
  trajectoryRunLengthM,
  trajectoryTotals,
  type TrajectoryRun,
} from "./csvTrajectory";

/** Per-run and total length relative tolerance (plan: 1 %). */
export const LENGTH_TOL_FRAC = 0.01;

/** Max distance (m) from a sent vertex to a densified waypoint for must_hit match. */
export const MUST_HIT_MATCH_M = 0.08;

export type TrajectoryVerifyIssue = {
  code:
    | "missing_run_echo"
    | "run_count"
    | "run_kind"
    | "run_length"
    | "mark_total"
    | "travel_total"
    | "must_hit_missing"
    | "must_hit_false"
    | "must_hit_unmatched"
    | "backend_warning";
  message: string;
};

export type TrajectoryVerifyResult = {
  ok: boolean;
  /** Load must stay blocked when false. */
  issues: TrajectoryVerifyIssue[];
  /** Backend warnings surfaced even when structure matches. */
  backendWarnings: string[];
  /** run_echo after dropping generated:true (terminal run-out). */
  comparableEcho: RunEchoEntry[];
};

function isRunEchoEntry(v: unknown): v is RunEchoEntry {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.kind === "string" &&
    typeof o.num_points === "number" &&
    typeof o.length_m === "number"
  );
}

export function filterComparableRunEcho(echo: RunEchoEntry[] | undefined | null): RunEchoEntry[] {
  if (!Array.isArray(echo)) return [];
  return echo.filter((e) => isRunEchoEntry(e) && e.generated !== true);
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom;
}

/**
 * Collect representative vertices we authored: first/last of every run
 * (mark and travel endpoints are the contract vertices densification must hit).
 */
export function sentVertexSpotSamples(sentRuns: TrajectoryRun[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<string>();
  const push = (p: [number, number]) => {
    const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const run of sentRuns) {
    if (run.points.length < 1) continue;
    push(run.points[0]);
    push(run.points[run.points.length - 1]);
  }
  return out;
}

/**
 * Spot-check staged `must_hit` flags against vertices we sent.
 *
 * - If `must_hit` is absent: non-blocking issue (older backends) — recorded, does not fail alone.
 * - If present: each sample must land on a densified waypoint with must_hit=true (blocking).
 */
export function verifyMustHitSpotCheck(args: {
  sentRuns: TrajectoryRun[];
  waypoints: unknown;
  mustHit: unknown;
  tolM?: number;
}): { issues: TrajectoryVerifyIssue[]; blocking: TrajectoryVerifyIssue[] } {
  const tol = args.tolM ?? MUST_HIT_MATCH_M;
  const issues: TrajectoryVerifyIssue[] = [];
  const samples = sentVertexSpotSamples(args.sentRuns);
  if (samples.length === 0) return { issues, blocking: [] };

  const wps = Array.isArray(args.waypoints) ? args.waypoints : null;
  if (!wps || wps.length === 0) {
    issues.push({
      code: "must_hit_unmatched",
      message: "Staged mission has no waypoints — cannot spot-check must_hit.",
    });
    return { issues, blocking: issues };
  }

  const flags = Array.isArray(args.mustHit) ? args.mustHit : null;
  if (!flags) {
    // Non-blocking: backend may not have shipped must_hit yet.
    issues.push({
      code: "must_hit_missing",
      message:
        "Staged mission has no must_hit array — skipped spot-check (backend should provide it).",
    });
    return { issues, blocking: [] };
  }

  const ned: Array<{ n: number; e: number; i: number }> = [];
  for (let i = 0; i < wps.length; i++) {
    const p = wps[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    const n = Number(p[0]);
    const e = Number(p[1]);
    if (!Number.isFinite(n) || !Number.isFinite(e)) continue;
    ned.push({ n, e, i });
  }

  const blocking: TrajectoryVerifyIssue[] = [];
  let unmatched = 0;
  let falseHit = 0;

  for (const [sn, se] of samples) {
    let bestI = -1;
    let bestD = tol;
    for (const wp of ned) {
      const d = Math.hypot(wp.n - sn, wp.e - se);
      if (d <= bestD) {
        bestD = d;
        bestI = wp.i;
      }
    }
    if (bestI < 0) {
      unmatched += 1;
      continue;
    }
    if (flags[bestI] !== true) {
      falseHit += 1;
    }
  }

  if (unmatched > 0) {
    const issue: TrajectoryVerifyIssue = {
      code: "must_hit_unmatched",
      message: `${unmatched} sent vertex sample(s) have no densified waypoint within ${tol} m.`,
    };
    issues.push(issue);
    blocking.push(issue);
  }
  if (falseHit > 0) {
    const issue: TrajectoryVerifyIssue = {
      code: "must_hit_false",
      message: `${falseHit} sent vertex sample(s) map to densified waypoints with must_hit=false.`,
    };
    issues.push(issue);
    blocking.push(issue);
  }

  return { issues, blocking };
}

/**
 * Verify densified mission matches the operator's run list.
 * Does NOT prove our geometry is right — only that the backend densified what we sent.
 */
export function verifyTrajectoryResponse(
  sentRuns: TrajectoryRun[],
  response: PlanTrajectoryResponse
): TrajectoryVerifyResult {
  const issues: TrajectoryVerifyIssue[] = [];
  const backendWarnings = Array.isArray(response.warnings)
    ? response.warnings.filter((w): w is string => typeof w === "string" && w.trim() !== "")
    : [];

  for (const w of backendWarnings) {
    issues.push({ code: "backend_warning", message: w });
  }

  const rawEcho = response.run_echo;
  if (!Array.isArray(rawEcho)) {
    issues.push({
      code: "missing_run_echo",
      message: "Response has no run_echo — cannot verify densified runs against what we sent.",
    });
    return { ok: false, issues, backendWarnings, comparableEcho: [] };
  }

  const echo = filterComparableRunEcho(rawEcho);
  if (echo.length !== sentRuns.length) {
    issues.push({
      code: "run_count",
      message: `run_echo has ${echo.length} operator runs, we sent ${sentRuns.length}.`,
    });
  }

  const n = Math.min(echo.length, sentRuns.length);
  for (let i = 0; i < n; i++) {
    const sent = sentRuns[i];
    const got = echo[i];
    if (String(got.kind).toLowerCase() !== sent.kind) {
      issues.push({
        code: "run_kind",
        message: `runs[${i}] kind mismatch: sent ${sent.kind}, echo ${got.kind}.`,
      });
    }
    const sentLen = trajectoryRunLengthM(sent);
    if (relDiff(sentLen, got.length_m) > LENGTH_TOL_FRAC) {
      issues.push({
        code: "run_length",
        message: `runs[${i}] length ${got.length_m.toFixed(3)} m vs sent ${sentLen.toFixed(3)} m (>${(LENGTH_TOL_FRAC * 100).toFixed(0)}%).`,
      });
    }
  }

  const our = trajectoryTotals(sentRuns);
  const markResp = typeof response.mark_length_m === "number" ? response.mark_length_m : null;
  const travelResp = typeof response.transit_length_m === "number" ? response.transit_length_m : null;

  if (markResp != null && relDiff(our.markLengthM, markResp) > LENGTH_TOL_FRAC) {
    issues.push({
      code: "mark_total",
      message: `mark_length_m ${markResp.toFixed(3)} vs our ${our.markLengthM.toFixed(3)} m.`,
    });
  }
  if (travelResp != null && relDiff(our.travelLengthM, travelResp) > LENGTH_TOL_FRAC) {
    issues.push({
      code: "travel_total",
      message: `transit_length_m ${travelResp.toFixed(3)} vs our ${our.travelLengthM.toFixed(3)} m.`,
    });
  }

  // Optional must_hit on the plan body itself (some backends echo it here).
  if (response.must_hit != null || response.merged_waypoints != null) {
    const mh = verifyMustHitSpotCheck({
      sentRuns,
      waypoints: response.merged_waypoints,
      mustHit: response.must_hit,
    });
    issues.push(...mh.issues);
  }

  const nonBlocking = new Set(["backend_warning", "must_hit_missing"]);
  const blocking = issues.filter((i) => !nonBlocking.has(i.code));
  return {
    ok: blocking.length === 0,
    issues,
    backendWarnings,
    comparableEcho: echo,
  };
}

/**
 * Merge staged-artifact must_hit spot-check into a prior echo verification result.
 * Call after GET staged/{mission_id}.
 */
export function mergeStagedMustHitCheck(
  prior: TrajectoryVerifyResult,
  args: { sentRuns: TrajectoryRun[]; waypoints: unknown; mustHit: unknown }
): TrajectoryVerifyResult {
  const mh = verifyMustHitSpotCheck(args);
  const issues = [...prior.issues, ...mh.issues];
  const nonBlocking = new Set(["backend_warning", "must_hit_missing"]);
  const blocking = issues.filter((i) => !nonBlocking.has(i.code));
  return {
    ok: blocking.length === 0,
    issues,
    backendWarnings: prior.backendWarnings,
    comparableEcho: prior.comparableEcho,
  };
}
