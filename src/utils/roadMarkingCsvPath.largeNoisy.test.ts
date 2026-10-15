import { describe, expect, it } from "vitest";

import { dampenOppositeJogs, maxSourceDeviationM } from "./roadMarkingCsvPath";
import { localCsvPointsToPlanLines, parseLocalPointCsv } from "./localPointCsv";

// APP-03: importing a large, noisy survey CSV froze the UI. Measured on the Mac before the fix
// (single 0.1 m-noise path, one synchronous fit): 5k pts 659 ms, 10k 3.5 s, 20k 15.1 s (quadratic);
// after: 41 ms / 134 ms / 406 ms. Two quadratic spots in the fit: dampenOppositeJogs restarted its
// scan from vertex 1 after every dropped vertex, and maxSourceDeviationM scanned every fitted
// segment for every source vertex.

function rnd(seed: number) {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function noisyPath(seed: number, n: number, noise: number) {
  const r = rnd(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    pts.push({ north: 2 * Math.sin(u * 12) + (r() - 0.5) * noise, east: u * 60 + (r() - 0.5) * noise });
  }
  return pts;
}

function fingerprint(pts: Array<{ north: number; east: number }>) {
  let sum = 0;
  pts.forEach((p, i) => (sum += (p.north * 31 + p.east * 17) * ((i % 7) + 1)));
  return { length: pts.length, sum: Number(sum.toFixed(6)) };
}

describe("dampenOppositeJogs: output unchanged by the resumed scan", () => {
  // Fingerprints taken from the pre-fix implementation (c999c59).
  const golden: Array<[number, number, number, { length: number; sum: number }]> = [
    [11, 1500, 0.1, { length: 750, sum: 1881659.653294 }],
    [12, 800, 0.04, { length: 509, sum: 1039949.845632 }],
    [13, 2500, 0.1, { length: 1250, sum: 3184314.4865 }],
  ];
  for (const [seed, n, noise, expected] of golden) {
    it(`seed ${seed}, ${n} pts, noise ${noise}`, () => {
      expect(fingerprint(dampenOppositeJogs(noisyPath(seed, n, noise), 8, 3.5, 40))).toEqual(expected);
    });
  }
});

describe("maxSourceDeviationM: grid search equals the plain scan", () => {
  function naive(source: Array<{ north: number; east: number }>, fitted: Array<{ north: number; east: number }>) {
    let maxD = 0;
    for (const s of source) {
      let best = Infinity;
      for (let i = 0; i < fitted.length - 1; i++) {
        const a = fitted[i];
        const b = fitted[i + 1];
        const abN = b.north - a.north;
        const abE = b.east - a.east;
        const len2 = abN * abN + abE * abE;
        let t = 0;
        if (len2 > 1e-18) t = Math.max(0, Math.min(1, ((s.north - a.north) * abN + (s.east - a.east) * abE) / len2));
        best = Math.min(best, Math.hypot(s.north - (a.north + abN * t), s.east - (a.east + abE * t)));
      }
      maxD = Math.max(maxD, best);
    }
    return maxD;
  }

  it("random clouds at several scales, including sources outside the fitted box", () => {
    for (let k = 0; k < 60; k++) {
      const r = rnd(k + 1);
      const sc = [0.5, 5, 80][k % 3];
      const fitted = Array.from({ length: 2 + Math.floor(r() * 400) }, () => ({ north: r() * sc, east: r() * sc }));
      const source = Array.from({ length: 1 + Math.floor(r() * 500) }, () => ({
        north: (r() * 1.6 - 0.3) * sc,
        east: (r() * 1.6 - 0.3) * sc,
      }));
      expect(maxSourceDeviationM(source, fitted)).toBe(naive(source, fitted));
    }
  });

  it("degenerate and collinear inputs", () => {
    const same = Array.from({ length: 100 }, () => ({ north: 1, east: 1 }));
    expect(maxSourceDeviationM(same, same)).toBe(naive(same, same));
    const line = Array.from({ length: 200 }, (_, i) => ({ north: 0, east: i }));
    const src = Array.from({ length: 50 }, (_, i) => ({ north: i, east: i * 4 }));
    expect(maxSourceDeviationM(src, line)).toBe(naive(src, line));
  });
});

describe("large noisy CSV import stays near-linear", () => {
  it("20,000 noisy points fit in well under the old 15 s", () => {
    const r = rnd(7);
    const rows = ["north,east"];
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      rows.push(`${(2 * Math.sin(u * 12) + (r() - 0.5) * 0.1).toFixed(4)},${(u * 200 + (r() - 0.5) * 0.1).toFixed(4)}`);
    }
    const parsed = parseLocalPointCsv(rows.join("\n"));
    const t0 = performance.now();
    const lines = localCsvPointsToPlanLines(parsed.points, null);
    const ms = performance.now() - t0;
    expect(lines.length).toBe(1);
    // pre-fix 15.1 s, post-fix ~0.4 s on the dev Mac; generous bound for slow CI.
    expect(ms).toBeLessThan(6000);
  }, 60_000);
});
