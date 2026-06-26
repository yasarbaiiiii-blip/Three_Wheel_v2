import type { PlanLine } from "../types/plan";

const PRIMARY_ENTITY_TYPES = new Set(["line", "arc", "circle"]);

function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

function normalizeEntityType(entityType: string | undefined): string {
  return (entityType ?? "").trim().toLowerCase();
}

export function isPrimaryEditableLine(line: PlanLine) {
  if (line.layer === "transit" || line.layer === "extension") {
    return false;
  }

  return PRIMARY_ENTITY_TYPES.has(normalizeEntityType(line.entity?.entity_type));
}

export function isRenderablePlanLine(line: PlanLine | null | undefined): line is PlanLine {
  return Boolean(
    line &&
      line.from &&
      line.to &&
      Number.isFinite(line.from.x) &&
      Number.isFinite(line.from.y) &&
      Number.isFinite(line.to.x) &&
      Number.isFinite(line.to.y)
  );
}

export function sanitizePlanLines(lines: PlanLine[]): PlanLine[] {
  return lines.filter(isRenderablePlanLine);
}

/** Plan start in design/local NED: x = north, y = east. */
export function getPlanStartPoint(lines: PlanLine[]) {
  const runtimeStartLine = lines.find((line) => line.id === "runtime-transit-0");
  const fallbackPreExtensionLine = lines.find(
    (line) => line.layer === "extension" && line.id.startsWith("ext-pre-")
  );
  const primaryLine =
    runtimeStartLine ?? fallbackPreExtensionLine ?? lines.find(isPrimaryEditableLine) ?? lines[0];
  if (!primaryLine) return null;

  const north = coerceFiniteNumber(primaryLine.from?.x);
  const east = coerceFiniteNumber(primaryLine.from?.y);
  if (north == null || east == null) return null;

  return { north, east };
}