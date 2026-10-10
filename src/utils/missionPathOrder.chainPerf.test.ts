import { describe, expect, it } from "vitest";
import { parseLocalDxf } from "./dxfLocalImport";
import { chainMarkLinesByGeometry, selectMarkPlanLines, totalGapM } from "./missionPathOrder";
import { localCsvPointsToPlanLines, parseLocalPointCsv } from "./localPointCsv";

/**
 * Upload latency regression: chaining used to rebuild every candidate chain and re-sample
 * every polyline inside an O(n^3) loop — ~4 s for 190 paths on a desktop, 10-30 s on a phone.
 * These bounds are ~10x the current desktop time, so they only trip on a real regression.
 */
function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function syntheticDxf(nLines: number, nPolys: number, nCircles: number): string {
  const rnd = lcg(11);
  const r: string[] = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  for (let i = 0; i < nLines; i++) {
    const x = rnd() * 20000;
    const y = rnd() * 20000;
    r.push("0", "LINE", "8", "M", "10", String(x), "20", String(y), "11", String(x + 1000), "21", String(y + 1000));
  }
  for (let i = 0; i < nPolys; i++) {
    r.push("0", "LWPOLYLINE", "8", "M", "90", "4", "70", "0");
    let x = rnd() * 20000;
    let y = rnd() * 20000;
    for (let k = 0; k < 4; k++) {
      r.push("10", String(x), "20", String(y), "42", k % 2 ? "0.3" : "0");
      x += rnd() * 800;
      y += rnd() * 800;
    }
  }
  for (let i = 0; i < nCircles; i++) {
    r.push("0", "CIRCLE", "8", "M", "10", String(rnd() * 20000), "20", String(rnd() * 20000), "40", String(300 + rnd() * 800));
  }
  r.push("0", "ENDSEC", "0", "EOF");
  return r.join("\n");
}

describe("chainMarkLinesByGeometry performance + invariants", () => {
  it("chains ~190 CAD paths quickly, keeps every path once, never worse than file order", () => {
    const lines = parseLocalDxf(syntheticDxf(150, 30, 10), "x.dxf").lines;
    const marks = selectMarkPlanLines(lines);
    expect(marks.length).toBeGreaterThanOrEqual(190);

    const t0 = performance.now();
    const chained = chainMarkLinesByGeometry(lines);
    const ms = performance.now() - t0;

    const out = selectMarkPlanLines(chained);
    expect(out.map((l) => l.id).sort()).toEqual(marks.map((l) => l.id).sort());
    expect(totalGapM(out)).toBeLessThanOrEqual(totalGapM(marks) + 1e-9);
    expect(ms).toBeLessThan(2500);
  });

  it("chains a many-path survey CSV quickly", () => {
    const rnd = lcg(7);
    const rows = ["lat,lon"];
    for (let p = 0; p < 120; p++) {
      const la = 13 + rnd() * 0.002;
      const lo = 80 + rnd() * 0.002;
      for (let i = 0; i < 25; i++) {
        rows.push(`${(la + i * 2e-6).toFixed(8)},${(lo + i * 3e-6 + (p % 3 === 0 ? i * i * 1e-8 : 0)).toFixed(8)}`);
      }
    }
    const parsed = parseLocalPointCsv(rows.join("\n"), "x.csv");
    const planLines = localCsvPointsToPlanLines(parsed.points, parsed.anchor);
    expect(planLines.length).toBeGreaterThan(50);

    const t0 = performance.now();
    const chained = chainMarkLinesByGeometry(planLines);
    const ms = performance.now() - t0;

    expect(chained.length).toBe(planLines.length);
    expect(ms).toBeLessThan(1500);
  });

  it("walks a shuffled square perimeter into one continuous loop (tie-break unchanged)", () => {
    // Four unit edges stored out of order and with one drawn backwards.
    const text = [
      "0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "6", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
      "0", "LINE", "8", "M", "10", "1", "20", "0", "11", "1", "21", "1",
      "0", "LINE", "8", "M", "10", "0", "20", "0", "11", "1", "21", "0",
      "0", "LINE", "8", "M", "10", "0", "20", "1", "11", "0", "21", "0",
      "0", "LINE", "8", "M", "10", "0", "20", "1", "11", "1", "21", "1",
      "0", "ENDSEC", "0", "EOF",
    ].join("\n");
    const chained = selectMarkPlanLines(chainMarkLinesByGeometry(parseLocalDxf(text, "sq.dxf").lines));
    expect(chained).toHaveLength(4);
    expect(totalGapM(chained)).toBeCloseTo(0, 9);
  });
});
