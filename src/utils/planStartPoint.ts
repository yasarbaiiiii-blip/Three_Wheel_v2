import type { PlanLine } from "../types/plan";
import { coerceFiniteNumber, isPrimaryEditableLine } from "./pathWorkflow";

/** First executed plan start in N/E meters (runtime transit preferred). */
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
