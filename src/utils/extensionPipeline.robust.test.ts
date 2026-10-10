/**
 * Safety invariants for the extension (PRE run-in / AFT run-out) pipeline, end to end:
 * DXF text → parse → chain → paint order → buildTrajectory → the runs that get POSTed.
 *
 * What the operator relies on when they flip Extension on and press Send:
 *   - an extension NEVER paints (it is a travel run),
 *   - painted length is exactly the drawing's length — extensions add travel only,
 *   - the rover can drive the runs as one connected path (no teleporting gaps),
 *   - the run-in lines up with the path's first tangent, so the rover arrives on heading,
 *   - turning Extension off removes every extension run.
 */
import { describe, expect, it } from "vitest";

import { parseLocalDxf } from "./dxfLocalImport";
import { DXF_EXTENSION_CONFIG, normalizeCsvExtensionConfig } from "./missionExtensions";
import {
  chainMarkLinesByGeometry,
  defaultPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
} from "./missionPathOrder";
import { buildTrajectory, type TrajectoryRun } from "./missionTrajectory";

const HEAD = "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n";
const TAIL = "0\nENDSEC\n0\nEOF\n";
const dxf = (...entities: string[]) => HEAD + entities.join("") + TAIL;

const line = (x1: number, y1: number, x2: number, y2: number) =>
  `0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
const poly = (closed: boolean, pts: [number, number][]) =>
  `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n` +
  pts.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("");
const circle = (cx: number, cy: number, r: number) =>
  `0\nCIRCLE\n8\n0\n10\n${cx}\n20\n${cy}\n40\n${r}\n`;
const arc = (cx: number, cy: number, r: number, a0: number, a1: number) =>
  `0\nARC\n8\n0\n10\n${cx}\n20\n${cy}\n40\n${r}\n50\n${a0}\n51\n${a1}\n`;

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const runLen = (r: TrajectoryRun) => {
  let s = 0;
  for (let i = 1; i < r.points.length; i++) s += dist(r.points[i - 1], r.points[i]);
  return s;
};

function build(text: string, ext: { enabled: boolean; preM?: number; aftM?: number }) {
  const parsed = parseLocalDxf(text, "t.dxf");
  const chained = chainMarkLinesByGeometry(parsed.lines);
  const marks = selectMarkPlanLines(chained);
  const painted = resolveOrderedPaintedLines(marks, defaultPathOrder(marks));
  const extensions = normalizeCsvExtensionConfig({
    ...DXF_EXTENSION_CONFIG,
    enabled: ext.enabled,
    preM: ext.preM ?? 0.5,
    aftM: ext.aftM ?? 0.5,
  });
  const built = buildTrajectory(painted, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions,
    includeEntryTransit: false,
  });
  const paintedLenNoExt = buildTrajectory(painted, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions: normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: false }),
    includeEntryTransit: false,
  }).runs
    .filter((r) => r.kind === "mark")
    .reduce((s, r) => s + runLen(r), 0);
  return { built, painted, paintedLenNoExt, extensions };
}

const SHAPES: Record<string, string> = {
  "closed 2x2 square (one polyline)": dxf(poly(true, [[0, 0], [2, 0], [2, 2], [0, 2]])),
  "single straight line": dxf(line(0, 0, 5, 0)),
  "two separate lines": dxf(line(0, 0, 4, 0), line(0, 3, 4, 3)),
  "open L polyline": dxf(poly(false, [[0, 0], [3, 0], [3, 3]])),
  "full circle r=1.5": dxf(circle(0, 0, 1.5)),
  "quarter arc r=2": dxf(arc(0, 0, 2, 0, 90)),
  "line + circle + arc mix": dxf(line(0, 0, 3, 0), circle(6, 0, 1), arc(0, 5, 2, 0, 180)),
};

describe("extension pipeline invariants", () => {
  for (const [name, text] of Object.entries(SHAPES)) {
    describe(name, () => {
      const on = build(text, { enabled: true, preM: 0.5, aftM: 0.5 });
      const runs = on.built.runs;

      it("produces runs and no non-finite coordinates", () => {
        expect(runs.length).toBeGreaterThan(0);
        for (const r of runs) {
          expect(r.points.length).toBeGreaterThanOrEqual(2);
          for (const p of r.points) {
            expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
          }
        }
      });

      it("never paints an extension: painted length equals the drawing's own length", () => {
        const markLen = runs.filter((r) => r.kind === "mark").reduce((s, r) => s + runLen(r), 0);
        expect(markLen).toBeCloseTo(on.paintedLenNoExt, 3);
      });

      it("starts with a run-in and ends with a run-out of the requested length", () => {
        expect(runs[0].kind).toBe("travel");
        expect(runs[0].label).toBe("pre-ext");
        expect(runLen(runs[0])).toBeCloseTo(0.5, 2);
        const last = runs[runs.length - 1];
        expect(last.kind).toBe("travel");
        expect(last.label).toBe("aft-ext");
        expect(runLen(last)).toBeGreaterThanOrEqual(0.5 - 1e-6);
      });

      it("is one connected drive: each run starts where the previous one ended", () => {
        for (let i = 1; i < runs.length; i++) {
          const prevEnd = runs[i - 1].points[runs[i - 1].points.length - 1];
          expect(dist(prevEnd, runs[i].points[0])).toBeLessThan(0.011);
        }
      });

      it("never has two adjacent runs of the same kind", () => {
        for (let i = 1; i < runs.length; i++) {
          // Sharp-corner teardrops are travel between marks, so mark/travel alternate.
          expect(runs[i].kind === runs[i - 1].kind).toBe(false);
        }
      });

      it("arrives on the path's heading: run-in direction matches the first mark tangent", () => {
        const pre = runs[0].points;
        const mark = runs[1].points;
        const a = pre[pre.length - 2];
        const b = pre[pre.length - 1];
        const c = mark[0];
        const d = mark[Math.min(mark.length - 1, 1)];
        // Run-in ends where the mark starts.
        expect(dist(b, c)).toBeLessThan(0.011);
        const inDir = [b[0] - a[0], b[1] - a[1]];
        const markDir = [d[0] - c[0], d[1] - c[1]];
        const dot =
          (inDir[0] * markDir[0] + inDir[1] * markDir[1]) /
          (Math.hypot(inDir[0], inDir[1]) * Math.hypot(markDir[0], markDir[1]));
        // Straight and arc/circle starts line up within a few degrees.
        expect(dot).toBeGreaterThan(0.98);
      });

      it("Extension off → no extension runs at all", () => {
        const off = build(text, { enabled: false });
        expect(off.built.runs.some((r) => r.label === "pre-ext" || r.label === "aft-ext")).toBe(false);
        expect(off.built.runs.filter((r) => r.kind === "mark").length).toBeGreaterThan(0);
      });
    });
  }

  it("honours custom lengths (PRE 1.2 m, AFT 0.8 m)", () => {
    const { built } = build(SHAPES["single straight line"], { enabled: true, preM: 1.2, aftM: 0.8 });
    const first = built.runs[0];
    const last = built.runs[built.runs.length - 1];
    expect(runLen(first)).toBeCloseTo(1.2, 2);
    expect(runLen(last)).toBeCloseTo(0.8, 2);
  });

  it("clamps absurd lengths to the 5 m cap instead of sending them", () => {
    const { extensions, built } = build(SHAPES["single straight line"], { enabled: true, preM: 999, aftM: 999 });
    expect(extensions.preM).toBe(5);
    expect(extensions.aftM).toBe(5);
    expect(runLen(built.runs[0])).toBeCloseTo(5, 2);
  });

  it("enforces the minimum run-out when enabled", () => {
    const { extensions } = build(SHAPES["single straight line"], { enabled: true, preM: 0.5, aftM: 0 });
    expect(extensions.aftM).toBeGreaterThan(0);
  });
});
