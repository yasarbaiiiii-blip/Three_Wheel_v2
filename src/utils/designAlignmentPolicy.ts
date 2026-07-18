/**
 * designAlignmentPolicy.ts — alignment scale policy.
 *
 * Multi-Point Fit scale-to-ref and manual sticker scale must survive Fix Alignment
 * and rehydrate. Scale is clamped to a physical range so a bad fit cannot send
 * the plan to absurd sizes.
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
