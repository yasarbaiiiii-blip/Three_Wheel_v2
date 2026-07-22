import { describe, it, expect } from "vitest";
import {
  buildPlanLengthLabels,
  measurePathLengthAndCenter,
  offsetLabelFromPathCenter,
} from "./planLengthLabels";
import type { PlanLine } from "../types/plan";

const line = (id: string, x0: number, y0: number, x1: number, y1: number, layer = "marking"): PlanLine => ({
  id,
  label: id,
  layer: layer as PlanLine["layer"],
  from: { id: 1, x: x0, y: y0 },
  to: { id: 2, x: x1, y: y1 },
  width: 0.1,
});

describe("buildPlanLengthLabels", () => {
  it("multiplies design length by sticker scale", () => {
    const labels = buildPlanLengthLabels([line("a", 0, 0, 10, 0)], {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1.5,
    });
    expect(labels).toHaveLength(1);
    expect(labels[0].lengthM).toBeCloseTo(15, 5);
    expect(labels[0].label).toMatch(/15\.00 m/);
  });

  it("places label offset from geometric centre of a straight path", () => {
    // Path along north axis; perpendicular offset is east/west (or left of tangent).
    const labels = buildPlanLengthLabels([line("a", 0, 0, 10, 0)], {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
    });
    expect(labels).toHaveLength(1);
    // Centre is (5,0); left-of-north tangent is west → east decreases.
    expect(labels[0].north).toBeCloseTo(5, 5);
    expect(Math.abs(labels[0].east)).toBeGreaterThanOrEqual(1.2);
  });

  it("uses scaleEast for east-running segments (non-uniform)", () => {
    const labels = buildPlanLengthLabels([line("a", 0, 0, 0, 10)], {
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      scaleNorth: 1,
      scaleEast: 2,
    });
    expect(labels).toHaveLength(1);
    expect(labels[0].lengthM).toBeCloseTo(20, 5);
    // Path along east; centre e≈10, offset perpendicular (north)
    expect(labels[0].east).toBeCloseTo(10, 5);
    expect(Math.abs(labels[0].north)).toBeGreaterThanOrEqual(1.2);
  });

  it("measurePathLengthAndCenter uses arc-length midpoint on polylines", () => {
    const m = measurePathLengthAndCenter([
      { north: 0, east: 0 },
      { north: 1, east: 0 },
      { north: 11, east: 0 },
    ]);
    expect(m).not.toBeNull();
    expect(m!.lengthM).toBeCloseTo(11, 6);
    expect(m!.center.north).toBeCloseTo(5.5, 6);
    expect(m!.center.east).toBeCloseTo(0, 6);
  });

  it("offsetLabelFromPathCenter leaves a readable gap from the stroke", () => {
    const c = offsetLabelFromPathCenter(
      { north: 5, east: 0 },
      { north: 1, east: 0 },
      10
    );
    expect(Math.hypot(c.north - 5, c.east - 0)).toBeGreaterThanOrEqual(1.2);
  });

  it("includes extension run-ups when extensions are enabled", () => {
    const labels = buildPlanLengthLabels(
      [line("ext-pre-1", 0, 0, 5, 0, "extension")],
      { x: 0, y: 0, rotation: 0, scale: 1 }
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].lengthM).toBeCloseTo(5, 5);
  });

  it("skips transit scaffolding", () => {
    const labels = buildPlanLengthLabels(
      [line("runtime-transit-0", 0, 0, 5, 0, "transit")],
      { x: 0, y: 0, rotation: 0, scale: 1 }
    );
    expect(labels).toHaveLength(0);
  });
});
