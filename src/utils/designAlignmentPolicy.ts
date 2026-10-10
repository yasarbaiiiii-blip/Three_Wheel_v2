/**
 * designAlignmentPolicy.ts — alignment scale policy and trust gate.
 *
 * Manual sticker scale must survive rehydrate. Scale is clamped to a physical
 * range so a bad value cannot send the plan to absurd sizes. A fitted
 * Multi-Point alignment is accepted only through {@link assessAlignmentTrust}.
 */

export const allowAlignmentScale = true;

export const MIN_ALIGNMENT_SCALE = 0.01;
export const MAX_ALIGNMENT_SCALE = 100;

/**
 * Enforces the scale policy on a given alignment scale factor.
 * When allowAlignmentScale is false, returns 1.0. Otherwise clamps to a safe range.
 */
export function enforceAlignmentScale(scale: number): number {
  if (!allowAlignmentScale) return 1.0;
  if (!Number.isFinite(scale) || scale <= 0) return 1.0;
  return Math.min(MAX_ALIGNMENT_SCALE, Math.max(MIN_ALIGNMENT_SCALE, scale));
}

// ── Alignment trust gate ────────────────────────────────────────────────────
//
// A fit that does not reproduce the surveyed reference points must never
// become "Alignment applied": the rover paints exactly where the plan lands.

/** Blocks when the RMS of the reference-point residuals exceeds this (m). */
export const ALIGNMENT_MAX_RMSE_M = 0.03;
/** Blocks when any single reference-point residual exceeds this (m). */
export const ALIGNMENT_MAX_RESIDUAL_M = 0.05;
/**
 * A metric design fits the survey at scale 1. A fitted scale further than this
 * (fraction) from 1 points to a unit or survey error, not a real stretch.
 */
export const ALIGNMENT_SCALE_TOLERANCE = 0.005;
/**
 * The plan origin must stay within this distance (m) of the reference points.
 * Same bound as the mission admission limit (+-10 km), so an origin can never
 * be extrapolated to another region.
 */
export const ALIGNMENT_MAX_ORIGIN_OFFSET_M = 10_000;

export type AlignmentTrustInput = {
  scale: number;
  rmseM: number | null;
  residualsM: number[];
  warnings: string[];
  originOffsetM: number;
  originGps: [number, number];
};

export type AlignmentTrust = {
  ok: boolean;
  /** Reasons the alignment must not be applied. Empty when ok. */
  blockers: string[];
  /** Caveats shown to the operator that do not block. */
  warnings: string[];
};

/** Evaluate a fitted alignment against the residual, scale and envelope limits. */
export function assessAlignmentTrust(a: AlignmentTrustInput): AlignmentTrust {
  const blockers: string[] = [];
  const maxResidual = a.residualsM.reduce((m, r) => Math.max(m, r), 0);

  if (
    !Number.isFinite(a.scale) ||
    !a.originGps.every(Number.isFinite) ||
    (a.rmseM != null && !Number.isFinite(a.rmseM))
  ) {
    blockers.push("The alignment fit produced a non-finite result. Check the reference points.");
  } else {
    if (a.rmseM != null && a.rmseM > ALIGNMENT_MAX_RMSE_M) {
      blockers.push(
        `RMSE ${a.rmseM.toFixed(3)} m is above the ${ALIGNMENT_MAX_RMSE_M.toFixed(3)} m limit. Re-check the reference points.`
      );
    }
    if (maxResidual > ALIGNMENT_MAX_RESIDUAL_M) {
      blockers.push(
        `A reference point misses by ${maxResidual.toFixed(3)} m, above the ${ALIGNMENT_MAX_RESIDUAL_M.toFixed(3)} m limit.`
      );
    }
    const scaleError = Math.abs(a.scale - 1);
    if (scaleError > ALIGNMENT_SCALE_TOLERANCE) {
      blockers.push(
        `Fitted scale ${a.scale.toFixed(4)} differs from 1 by ${(scaleError * 100).toFixed(2)} % (limit ${(ALIGNMENT_SCALE_TOLERANCE * 100).toFixed(1)} %). Probable unit or survey error in the design or the reference points.`
      );
    }
    if (a.originOffsetM > ALIGNMENT_MAX_ORIGIN_OFFSET_M) {
      blockers.push(
        `The plan origin would sit ${(a.originOffsetM / 1000).toFixed(1)} km from the reference points (limit ${(ALIGNMENT_MAX_ORIGIN_OFFSET_M / 1000).toFixed(0)} km). The design is not a local drawing for this site.`
      );
    }
  }

  return { ok: blockers.length === 0, blockers, warnings: [...a.warnings] };
}
