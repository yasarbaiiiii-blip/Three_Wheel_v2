import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import type { UploadedFileEntry } from "../types/uploadedFiles";
import { computeOffsetResultLines } from "./planOffsetApply";

function seg(id: string, a: [number, number], b: [number, number]): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: a[0], y: a[1] },
    to: { id: 2, x: b[0], y: b[1] },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: 0,
      geometry: {},
      preview_points: [
        { north: a[0], east: a[1] },
        { north: b[0], east: b[1] },
      ],
    },
  };
}

function file(id: string, prefix: string): UploadedFileEntry {
  return {
    id,
    fileName: `${id}.csv`,
    kind: "csv",
    isGeographic: true,
    status: "verified",
    lineIdPrefix: prefix,
  };
}

describe("computeOffsetResultLines", () => {
  const files = [file("fa", "north"), file("fb", "south")];
  const lineA = seg("north__a1", [0, 0], [10, 0]);
  const lineB = seg("south__b1", [0, 0], [10, 0]);
  const lines = [lineA, lineB];

  it("universal scope shifts every line", () => {
    const result = computeOffsetResultLines(lines, files, [], { kind: "universal" }, 1, 90);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const l of result.lines) {
      expect(l.from.y).toBeCloseTo(1, 9);
      expect(l.to.y).toBeCloseTo(1, 9);
    }
  });

  it("file scope shifts only that file's lines, leaves the rest untouched, preserves order", () => {
    const result = computeOffsetResultLines(lines, files, [], { kind: "file", fileId: "fa" }, 1, 90);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((l) => l.id)).toEqual(["north__a1", "south__b1"]); // order preserved
    const shiftedA = result.lines.find((l) => l.id === "north__a1")!;
    const untouchedB = result.lines.find((l) => l.id === "south__b1")!;
    expect(shiftedA.from.y).toBeCloseTo(1, 9);
    expect(untouchedB.from.y).toBeCloseTo(0, 9); // untouched
  });

  it("returns no-marks when the scope has zero paintable marks", () => {
    const boundaryOnly: PlanLine = { ...seg("north__boundary", [0, 0], [5, 0]), layer: "virtual_boundary" };
    const result = computeOffsetResultLines(
      [boundaryOnly],
      files,
      [],
      { kind: "file", fileId: "fa" },
      1,
      90
    );
    expect(result).toEqual({ ok: false, reason: "no-marks" });
  });

  it("returns invalid-offset for a non-finite bearing with a nonzero distance", () => {
    const result = computeOffsetResultLines(lines, files, [], { kind: "universal" }, 1, NaN);
    expect(result).toEqual({ ok: false, reason: "invalid-offset" });
  });

  it("returns zero-distance for a zero offset (even though it's a technically valid no-op delta)", () => {
    const result = computeOffsetResultLines(lines, files, [], { kind: "universal" }, 0, 90);
    expect(result).toEqual({ ok: false, reason: "zero-distance" });
  });
});
