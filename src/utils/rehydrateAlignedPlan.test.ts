import { describe, it, expect } from "vitest";
import type { PlanLine } from "../types/plan";
import type { AlignmentResultState } from "../types/fieldsWorkflow";
import {
  parseVerifiedAlignmentTransform,
  rehydrateAlignedPlanLines,
} from "./rehydrateAlignedPlan";
import { enforceAlignmentScale } from "./designAlignmentPolicy";

function makeLine(id: string, n0: number, e0: number, n1: number, e1: number): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: n0, y: e0 },
    to: { id: 2, x: n1, y: e1 },
    width: 0.1,
  };
}

function completeAlignment(
  overrides: Partial<AlignmentResultState> = {}
): AlignmentResultState {
  return {
    method: "least_squares",
    scale: 1,
    rotation_deg: 90,
    offset_n: 10,
    offset_e: -5,
    origin_gps: [12.34, 56.78],
    rmse_m: 0.01,
    sample_coords: null,
    residuals: null,
    warnings: null,
    ...overrides,
  };
}

describe("parseVerifiedAlignmentTransform", () => {
  it("returns null for missing alignment", () => {
    expect(parseVerifiedAlignmentTransform(null)).toBeNull();
    expect(parseVerifiedAlignmentTransform(undefined)).toBeNull();
  });

  it("returns null when any required field is incomplete (no partial bake)", () => {
    expect(parseVerifiedAlignmentTransform(completeAlignment({ rotation_deg: null }))).toBeNull();
    expect(parseVerifiedAlignmentTransform(completeAlignment({ offset_n: null }))).toBeNull();
    expect(parseVerifiedAlignmentTransform(completeAlignment({ offset_e: null }))).toBeNull();
    expect(parseVerifiedAlignmentTransform(completeAlignment({ rotation_deg: NaN }))).toBeNull();
  });

  it("parses a complete transform and enforces scale policy", () => {
    const parsed = parseVerifiedAlignmentTransform(
      completeAlignment({ scale: 1.5, rotation_deg: 30, offset_n: 1, offset_e: 2 })
    );
    expect(parsed).toEqual({
      rotationDeg: 30,
      scale: enforceAlignmentScale(1.5),
      offsetN: 1,
      offsetE: 2,
    });
  });

  it("defaults missing scale to 1 then enforces policy", () => {
    const parsed = parseVerifiedAlignmentTransform(completeAlignment({ scale: null }));
    expect(parsed?.scale).toBe(enforceAlignmentScale(1));
  });
});

describe("rehydrateAlignedPlanLines", () => {
  it("returns the same array reference when alignment is absent", () => {
    const lines = [makeLine("a", 0, 0, 1, 0)];
    expect(rehydrateAlignedPlanLines(lines, null)).toBe(lines);
  });

  it("returns the same array when transform is incomplete", () => {
    const lines = [makeLine("a", 0, 0, 1, 0)];
    const incomplete = completeAlignment({ offset_e: null });
    expect(rehydrateAlignedPlanLines(lines, incomplete)).toBe(lines);
  });

  it("bakes design-frame geometry into NED (same math as Fix Alignment)", () => {
    // 90° CCW: (n,e)=(1,0) → (0,1); then + offset (10, -5)
    const design = [makeLine("a", 1, 0, 0, 1)];
    const alignment = completeAlignment({
      rotation_deg: 90,
      offset_n: 10,
      offset_e: -5,
      scale: 1,
    });
    const ned = rehydrateAlignedPlanLines(design, alignment);
    expect(ned).not.toBe(design);
    expect(ned[0].from.x).toBeCloseTo(10, 9); // 0 + 10
    expect(ned[0].from.y).toBeCloseTo(-4, 9); // 1 + -5
    expect(ned[0].to.x).toBeCloseTo(9, 9); // -1 + 10
    expect(ned[0].to.y).toBeCloseTo(-5, 9); // 0 + -5
  });

  it("is idempotent on the same design input (no double-bake of design frame)", () => {
    const design = [
      makeLine("mark", 2, 3, 4, 5),
      makeLine("ext", 2, 3, 1.5, 3), // synthetic pre-extension stub
    ];
    const alignment = completeAlignment({
      rotation_deg: 15,
      offset_n: 100,
      offset_e: 200,
      scale: 1,
    });
    const once = rehydrateAlignedPlanLines(design, alignment);
    const twice = rehydrateAlignedPlanLines(design, alignment);
    expect(once[0].from.x).toBeCloseTo(twice[0].from.x, 9);
    expect(once[0].from.y).toBeCloseTo(twice[0].from.y, 9);
    expect(once[0].to.x).toBeCloseTo(twice[0].to.x, 9);
    expect(once[1].from.x).toBeCloseTo(twice[1].from.x, 9);
    expect(once[1].to.y).toBeCloseTo(twice[1].to.y, 9);
  });

  it("does not leave design endpoints unchanged after a non-identity transform", () => {
    const design = [makeLine("a", 10, 20, 30, 40)];
    const alignment = completeAlignment({
      rotation_deg: 45,
      offset_n: 7,
      offset_e: 8,
    });
    const ned = rehydrateAlignedPlanLines(design, alignment);
    expect(ned[0].from.x).not.toBeCloseTo(10, 5);
    expect(ned[0].from.y).not.toBeCloseTo(20, 5);
  });
});
