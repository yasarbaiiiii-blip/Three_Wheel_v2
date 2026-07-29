/**
 * End-to-end guard for the field report "upload a 2 x 2 square DXF, turn Enable Extension
 * on, nothing appears".
 *
 * The geometry was never wrong — a closed shape genuinely has no open end to run off, so
 * chain-ends mode correctly produces zero. What was wrong was the UI: the Enable switch
 * passed `perLine: false` on every change, so the one mode that DOES grow run-ups on a
 * closed shape could not be reached, and nothing told the operator why.
 *
 * These tests pin the parse → paint-order → extension chain the panel drives, so a future
 * change cannot make "square in, no extensions out" the only reachable outcome again.
 */

import { describe, expect, it } from "vitest";

import { parseLocalDxf } from "./dxfLocalImport";
import {
  buildCsvExtensionLines,
  isMissionClosedLoop,
  normalizeCsvExtensionConfig,
} from "./missionExtensions";
import {
  defaultPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
} from "./missionPathOrder";

/** Minimal DXF holding one closed 2 x 2 m square, declared in metres ($INSUNITS 6). */
function squareDxf(sizeMetres: number): string {
  return [
    "0\nSECTION\n2\nHEADER\n",
    "9\n$INSUNITS\n70\n6\n",
    "0\nENDSEC\n",
    "0\nSECTION\n2\nENTITIES\n",
    `0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n`,
    `10\n0\n20\n0\n`,
    `10\n${sizeMetres}\n20\n0\n`,
    `10\n${sizeMetres}\n20\n${sizeMetres}\n`,
    `10\n0\n20\n${sizeMetres}\n`,
    "0\nENDSEC\n",
    "0\nEOF\n",
  ].join("");
}

/** The exact chain FieldsPage runs: parsed lines → mark selection → paint order → painted. */
function paintedFrom(dxfText: string) {
  const parsed = parseLocalDxf(dxfText, "2x2 square.dxf");
  const marks = selectMarkPlanLines(parsed.lines);
  return {
    parsed,
    painted: resolveOrderedPaintedLines(marks, defaultPathOrder(marks)),
  };
}

describe("2 x 2 square DXF → extensions", () => {
  it("parses at true scale and yields a paintable closed path", () => {
    const { parsed, painted } = paintedFrom(squareDxf(2));

    expect(parsed.lines.length).toBeGreaterThan(0);
    expect(painted.length).toBeGreaterThan(0);
    // $INSUNITS 6 = metres, so a 2-unit square must stay 2 m — not 0.02 m (cm fallback).
    const pts = painted[0].entity!.preview_points;
    const norths = pts.map((p) => p.north);
    const easts = pts.map((p) => p.east);
    expect(Math.max(...norths) - Math.min(...norths)).toBeCloseTo(2, 6);
    expect(Math.max(...easts) - Math.min(...easts)).toBeCloseTo(2, 6);
    expect(isMissionClosedLoop(painted)).toBe(true);
  });

  it("perLine off → no extensions, and that is the closed-shape case the UI must explain", () => {
    const { painted } = paintedFrom(squareDxf(2));
    const built = buildCsvExtensionLines(
      painted,
      normalizeCsvExtensionConfig({ enabled: true, preM: 0.5, aftM: 0.5, perLine: false })
    );
    expect(built).toHaveLength(0);
    // The condition FieldsPage keys its operator hint off.
    expect(isMissionClosedLoop(painted)).toBe(true);
  });

  it("perLine on → a run-up and run-out on each of the four sides", () => {
    const { painted } = paintedFrom(squareDxf(2));
    const built = buildCsvExtensionLines(
      painted,
      normalizeCsvExtensionConfig({ enabled: true, preM: 0.5, aftM: 0.5, perLine: true })
    );

    expect(built.filter((l) => l.segmentRole === "pre")).toHaveLength(4);
    expect(built.filter((l) => l.segmentRole === "aft")).toHaveLength(4);
    for (const line of built) {
      expect(line.layer).toBe("extension");
      // Spray-off by construction — an extension must never paint.
      expect(line.is_mark).toBe(false);
      const p = line.entity!.preview_points;
      expect(Math.hypot(p[1].north - p[0].north, p[1].east - p[0].east)).toBeCloseTo(0.5, 6);
    }
  });

  it("normalize preserves perLine, so re-enabling does not silently reset it", () => {
    // The regression: the Enable switch used to send `perLine: false` on every change.
    const chosen = normalizeCsvExtensionConfig({
      enabled: false,
      preM: 0.5,
      aftM: 0.5,
      perLine: true,
    });
    const reEnabled = normalizeCsvExtensionConfig({ ...chosen, enabled: true });
    expect(reEnabled.perLine).toBe(true);
  });

  it("a filename with spaces changes nothing about the geometry", () => {
    const spaced = parseLocalDxf(squareDxf(2), "2x2 square.dxf");
    const underscored = parseLocalDxf(squareDxf(2), "square_2m.dxf");
    expect(spaced.lines.length).toBe(underscored.lines.length);
    expect(spaced.unitScale).toBe(underscored.unitScale);
    expect(spaced.lines[0].entity!.preview_points).toEqual(
      underscored.lines[0].entity!.preview_points
    );
  });
});
