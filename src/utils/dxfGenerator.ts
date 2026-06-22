import type { PlanLine } from "../types/plan";

// generateDXF() was removed — it was a duplicate of linesToDxf() with the same coordinate bug.
// Use linesToDxf() instead.

export function linesToDxf(lines: PlanLine[], name: string): string {
  const layers = Array.from(new Set(lines.map((line) => line.layer.toUpperCase())));
  const layerTable = layers
    .map((layer) => [
      "0",
      "LAYER",
      "2",
      layer,
      "70",
      "0",
      "62",
      layer === "BOUNDARY" ? "7" : layer === "CENTER" ? "3" : "4",
      "6",
      "CONTINUOUS",
    ].join("\n"))
    .join("\n");

  const entities = lines
    .map((entry) => [
      "0",
      "LINE",
      "8",
      entry.layer.toUpperCase(),
      "370",
      String(mmLineweight(entry.width)),
      "10",
      String(entry.from.y),
      "20",
      String(entry.from.x),
      "11",
      String(entry.to.y),
      "21",
      String(entry.to.x),
    ].join("\n"))
    .join("\n");

  return [
    "0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "6", "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER", "70", String(layers.length),
    layerTable,
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    entities,
    "0", "ENDSEC", "0", "EOF",
  ].join("\n");
}

export function mmLineweight(widthMeters: number): number {
  const mm = Math.round(widthMeters * 1000);
  if (mm <= 0) return -1;
  return Math.min(211, Math.max(0, mm));
}
