/**
 * Read the spray safety gate out of GET /api/spray/status.
 *
 * Why this exists: `spraying: false` is ambiguous. The valve is shut both when
 * the geometry says "no paint here" (working exactly as intended) and when a
 * gate refuses (cross-track too large, GPS not good enough, not in OFFBOARD).
 * The app used to collapse the whole response to one boolean, so a refusing
 * gate and a dry stretch of path looked identical and the operator had nothing
 * to act on.
 *
 * The backend passes the spray node's own sentence through verbatim. So do we:
 * `reason` is never reformatted, truncated or prettified. It names the gate
 * and, for cross-track, whether the limit came from the ROS param or a
 * per-mission override — e.g.
 *
 *     xtrack error 0.062m gate trip>0.080m clear<=0.050m (mission)
 *
 * An operator who cannot tell WHICH knob refused cannot fix it, and that suffix
 * is the only thing that says so. `source` is parsed out for emphasis (a badge
 * beside the text), never by rewriting the sentence.
 */

export type SprayStatusDto = {
  spraying?: unknown;
  safety_ok?: unknown;
  safety_reason?: unknown;
  fsm_state?: unknown;
  xtrack_error_m?: unknown;
  gps_fix_ok?: unknown;
  gps_fix_name?: unknown;
};

export type SprayGateSource = "param" | "mission";

export type SprayGateNotice = {
  /** A gate is actively refusing. Show the reason. */
  blocked: boolean;
  /**
   * The spray node has not reported at all (`safety_ok` is null/absent), so the
   * gate state is genuinely unknown. Distinct from `blocked: false`, which is a
   * positive "the gate is happy" — never claim that on missing data.
   */
  unknown: boolean;
  /** The node's sentence, VERBATIM. Null when there is nothing to show. */
  reason: string | null;
  /** Which knob set the limit, for a badge. Null when the reason names none. */
  source: SprayGateSource | null;
  /** Live cross-track in metres, when the node reported a finite one. */
  xtrackErrorM: number | null;
};

const SOURCE_RE = /\((param|mission)\)\s*$/i;

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Which knob the limit came from, or null. Read-only — does not alter reason. */
export function parseGateSource(reason: string | null): SprayGateSource | null {
  if (!reason) return null;
  const m = SOURCE_RE.exec(reason.trim());
  return m ? (m[1].toLowerCase() as SprayGateSource) : null;
}

export function readSprayGate(data: SprayStatusDto | null | undefined): SprayGateNotice {
  const reason = asNonEmptyString(data?.safety_reason);
  const xtrackErrorM = asFiniteNumber(data?.xtrack_error_m);
  const okRaw = data?.safety_ok;

  // Strictly boolean. null/undefined (node silent) and any unexpected type are
  // "unknown" — treating a missing field as `true` would render a confident
  // "gate OK" the app has no basis for.
  if (typeof okRaw !== "boolean") {
    return { blocked: false, unknown: true, reason, source: parseGateSource(reason), xtrackErrorM };
  }

  if (okRaw) {
    // Gate is happy. Some builds still carry a stale/no-op reason string; do not
    // surface it as a problem.
    return { blocked: false, unknown: false, reason: null, source: null, xtrackErrorM };
  }

  return { blocked: true, unknown: false, reason, source: parseGateSource(reason), xtrackErrorM };
}

/**
 * True when the rover is actually putting paint down, by any route.
 * Unchanged behaviour — kept here so both callers share one definition.
 */
export function isSprayActive(data: SprayStatusDto | null | undefined): boolean {
  const d = data as Record<string, unknown> | null | undefined;
  return !!(d?.spraying || d?.manual_override || d?.spray_active_desired);
}
