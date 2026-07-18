import { describe, it, expect } from "vitest";
import { buildPlanLengthLabels } from "./planLengthLabels";
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

  it("skips extension scaffolding", () => {
    const labels = buildPlanLengthLabels(
      [line("ext-pre-1", 0, 0, 5, 0, "extension")],
      { x: 0, y: 0, rotation: 0, scale: 1 }
    );
    expect(labels).toHaveLength(0);
  });
});
