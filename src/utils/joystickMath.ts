export function applyDeadZone(value: number, threshold: number): number {
  if (Math.abs(value) < threshold) return 0;
  const sign = value > 0 ? 1 : -1;
  return (sign * (Math.abs(value) - threshold)) / (1 - threshold);
}

export function applyResponseCurve(value: number, exponent: number): number {
  const sign = value > 0 ? 1 : -1;
  return sign * Math.pow(Math.abs(value), exponent);
}

export function clampAxis(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function processAxis(
  raw: number,
  deadZone: number,
  curveExponent: number,
  maxLimit: number
): number {
  const withDeadZone = applyDeadZone(raw, deadZone);
  const withCurve = applyResponseCurve(withDeadZone, curveExponent);
  return clampAxis(withCurve, -maxLimit, maxLimit);
}