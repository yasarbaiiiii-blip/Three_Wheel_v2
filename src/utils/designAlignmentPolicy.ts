/**
 * designAlignmentPolicy.ts — Phase 1 alignment scale policy.
 *
 * Defaults to scale = 1.0 unless explicit opt-in is configured.
 */

export const allowAlignmentScale = false;

/**
 * Enforces the scale policy on a given alignment scale factor.
 * If allowAlignmentScale is false, returns 1.0. Otherwise, returns the scale.
 */
export function enforceAlignmentScale(scale: number): number {
  return allowAlignmentScale ? scale : 1.0;
}
