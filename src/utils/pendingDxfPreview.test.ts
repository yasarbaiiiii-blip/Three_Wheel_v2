/**
 * "I upload a DXF, turn Extension on, and nothing shows" — for a metric DXF that is still waiting
 * for Fix Alignment. These steps mirror what App does on upload (handleLocalDxfParsed): parse,
 * chain, build the held-out (pending) lines — then the preview FieldsPage draws.
 */
import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { parseLocalDxf } from "./dxfLocalImport";
import { DXF_EXTENSION_CONFIG, normalizeCsvExtensionConfig } from "./missionExtensions";
import {
  applyCsvOrderToPlanLines,
  chainMarkLinesByGeometry,
  defaultPathOrder,
  selectMarkPlanLines,
} from "./missionPathOrder";
import { previewPendingWithExtensions } from "./pendingDxfPreview";

function polylineDxf(points: [number, number][], closed: boolean): string {
  return [
    "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n",
    "0\nSECTION\n2\nENTITIES\n",
    `0\nLWPOLYLINE\n8\n0\n90\n${points.length}\n70\n${closed ? 1 : 0}\n`,
    ...points.map(([x, y]) => `10\n${x}\n20\n${y}\n`),
    "0\nENDSEC\n0\nEOF\n",
  ].join("");
}

/** What App stores in `pendingDxfAlignment[fileId].rawLines` for a metric (unaligned) DXF. */
function pendingFrom(dxf: string) {
  const data = parseLocalDxf(dxf, "test.dxf");
  const markLinesRaw = data.lines.filter((l) => l.layer !== "transit" && l.layer !== "extension");
  const markLines = chainMarkLinesByGeometry(markLinesRaw);
  const order = defaultPathOrder(selectMarkPlanLines(markLines));
  const withTransit = applyCsvOrderToPlanLines(markLines, order, {
    enabled: false,
    preM: 0.5,
    aftM: 0.5,
    perLine: false,
  });
  return { f1: { fileName: "test.dxf", rawLines: withTransit } };
}

const ext = (lines: PlanLine[]) => lines.filter((l) => l.layer === "extension");
const SQUARE: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
const L_SHAPE: [number, number][] = [[0, 0], [4, 0], [4, 3]];

describe("extension preview for an uploaded, not-yet-aligned DXF", () => {
  it("extension off: the held-out file is left exactly as uploaded", () => {
    const pending = pendingFrom(polylineDxf(SQUARE, true));
    const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: false });
    expect(previewPendingWithExtensions(pending, cfg)).toBe(pending);
    expect(ext(pending.f1.rawLines)).toHaveLength(0);
  });

  it("closed square, per-side mode (the DXF default): a run-in and run-out on every side", () => {
    const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: true });
    const out = previewPendingWithExtensions(pendingFrom(polylineDxf(SQUARE, true)), cfg);
    expect(ext(out.f1!.rawLines!)).toHaveLength(8); // 4 sides x (PRE + AFT)
  });

  it("corners: each join is the diagonal between one side's run-out tip and the next side's run-in tip", () => {
    const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: true });
    const out = previewPendingWithExtensions(pendingFrom(polylineDxf(SQUARE, true)), cfg);
    const joins = out.f1!.rawLines!.filter((l) => l.layer === "transit");
    expect(joins).toHaveLength(3);
    for (const j of joins) {
      // 0.5 m run-out + 0.5 m run-in at a right angle -> hypotenuse of a 0.5/0.5 triangle.
      expect(j.entity?.length_m).toBeCloseTo(Math.hypot(0.5, 0.5), 6);
    }
  });

  it("closed square in chain-ends mode has no open end, so genuinely no extensions", () => {
    const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, perLine: false, enabled: true });
    const out = previewPendingWithExtensions(pendingFrom(polylineDxf(SQUARE, true)), cfg);
    expect(ext(out.f1!.rawLines!)).toHaveLength(0);
  });

  it("open L-shape: extensions appear in both modes (ends exist)", () => {
    for (const perLine of [true, false]) {
      const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, perLine, enabled: true });
      const out = previewPendingWithExtensions(pendingFrom(polylineDxf(L_SHAPE, false)), cfg);
      expect(ext(out.f1!.rawLines!).length).toBeGreaterThan(0);
    }
  });

  it("keeps the marks themselves untouched (only extension / transit lines are added)", () => {
    const pending = pendingFrom(polylineDxf(L_SHAPE, false));
    const cfg = normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: true });
    const out = previewPendingWithExtensions(pending, cfg);
    const marksBefore = selectMarkPlanLines(pending.f1.rawLines).map((l) => `${l.id}:${l.from.x},${l.from.y}`);
    const marksAfter = selectMarkPlanLines(out.f1!.rawLines!).map((l) => `${l.id}:${l.from.x},${l.from.y}`);
    expect(marksAfter).toEqual(marksBefore);
  });
});
