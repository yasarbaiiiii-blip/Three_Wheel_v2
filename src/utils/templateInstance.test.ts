import { describe, expect, it } from "vitest";
import { generateTextLines } from "./characterTemplates";
import { makeAsymmetricLTemplate } from "./csvTemplatePlacement";
import { generateRoadSignLines } from "./roadSignTemplates";
import { transformVisualDxfPoint } from "./visualAlignment";
import {
  bakeTemplateInstance,
  createPlacedTemplateInstance,
  ghostLinesForPose,
  instanceForLineId,
  removePrefixedLines,
  replacePrefixedLines,
  toCenteredPlanFrameLines,
} from "./templateInstance";

function bakedCentroid(lines: { entity?: { preview_points?: { north: number; east: number }[] } }[]) {
  let minN = Infinity;
  let maxN = -Infinity;
  let minE = Infinity;
  let maxE = -Infinity;
  for (const line of lines) {
    for (const pt of line.entity?.preview_points ?? []) {
      minN = Math.min(minN, pt.north);
      maxN = Math.max(maxN, pt.north);
      minE = Math.min(minE, pt.east);
      maxE = Math.max(maxE, pt.east);
    }
  }
  return { north: (minN + maxN) / 2, east: (minE + maxE) / 2 };
}

describe("templateInstance", () => {
  it("centers drawing strokes on the plan-frame origin", () => {
    const centered = toCenteredPlanFrameLines(makeAsymmetricLTemplate(4));
    const c = bakedCentroid(centered);
    expect(c.north).toBeCloseTo(0, 6);
    expect(c.east).toBeCloseTo(0, 6);
    expect(centered[0].from.x).toBeCloseTo(centered[0].entity!.preview_points![0].north, 6);
    expect(centered[0].from.y).toBeCloseTo(centered[0].entity!.preview_points![0].east, 6);
  });

  it("bakes prefixed mission lines with the centroid on the tap pose", () => {
    const source = makeAsymmetricLTemplate(4);
    const instance = createPlacedTemplateInstance({
      id: "tpl-1",
      fileName: "L mark",
      kind: "sign",
      lineIdPrefix: "lmark",
      sourceLines: source,
      north: 10,
      east: 20,
    });
    const baked = bakeTemplateInstance(instance);
    expect(baked.length).toBeGreaterThan(0);
    expect(baked.every((line) => line.id.startsWith("lmark__"))).toBe(true);
    expect(baked.every((line) => !line.id.startsWith("lmark__lmark"))).toBe(true);
    const c = bakedCentroid(baked);
    expect(c.north).toBeCloseTo(10, 5);
    expect(c.east).toBeCloseTo(20, 5);
  });

  it("rotates with the same NED convention as the map sticker", () => {
    const source = makeAsymmetricLTemplate(4);
    const local = toCenteredPlanFrameLines(source);
    const first = local[0].entity!.preview_points![0];
    const expected = transformVisualDxfPoint(first.north, first.east, {
      x: 0,
      y: 0,
      rotation: 90,
      scale: 1,
    });
    const baked = bakeTemplateInstance({
      ...createPlacedTemplateInstance({
        id: "tpl-2",
        fileName: "rot",
        kind: "sign",
        lineIdPrefix: "rot",
        sourceLines: source,
        north: 0,
        east: 0,
      }),
      rotationDeg: 90,
    });
    const got = baked[0].entity!.preview_points![0];
    expect(got.north).toBeCloseTo(expected.north, 5);
    expect(got.east).toBeCloseTo(expected.east, 5);
    const c = bakedCentroid(baked);
    expect(c.north).toBeCloseTo(0, 5);
    expect(c.east).toBeCloseTo(0, 5);
  });

  it("ghost lines are uncommitted (no file prefix)", () => {
    const ghost = ghostLinesForPose(makeAsymmetricLTemplate(2), {
      north: 1,
      east: 2,
      rotationDeg: 0,
      scale: 1,
    });
    expect(ghost.some((line) => line.id.includes("ghost"))).toBe(true);
    expect(ghost.every((line) => !line.id.includes("__"))).toBe(true);
    const c = bakedCentroid(ghost);
    expect(c.north).toBeCloseTo(1, 5);
    expect(c.east).toBeCloseTo(2, 5);
  });

  it("replacePrefixedLines swaps only that template", () => {
    const keep = {
      id: "csv__a",
      label: "csv",
      layer: "marking" as const,
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 1, y: 0 },
    };
    const old = {
      id: "lmark__old",
      label: "old",
      layer: "marking" as const,
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 1, y: 0 },
    };
    const next = {
      id: "lmark__new",
      label: "new",
      layer: "marking" as const,
      width: 0.1,
      from: { id: 1, x: 3, y: 3 },
      to: { id: 2, x: 4, y: 4 },
    };
    const out = replacePrefixedLines([keep, old], "lmark", [next]);
    expect(out.map((l) => l.id)).toEqual(["csv__a", "lmark__new"]);
  });

  it("removePrefixedLines drops only that template", () => {
    const keep = {
      id: "csv__a",
      label: "csv",
      layer: "marking" as const,
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 1, y: 0 },
    };
    const gone = {
      id: "lmark__old",
      label: "old",
      layer: "marking" as const,
      width: 0.1,
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 1, y: 0 },
    };
    expect(removePrefixedLines([keep, gone], "lmark").map((l) => l.id)).toEqual(["csv__a"]);
  });

  it("resolves an instance from a prefixed line id", () => {
    const instance = createPlacedTemplateInstance({
      id: "tpl-1",
      fileName: "AM 01",
      kind: "sign",
      lineIdPrefix: "am01",
      sourceLines: makeAsymmetricLTemplate(1),
      north: 0,
      east: 0,
    });
    expect(instanceForLineId([instance], "am01__stroke-1")?.id).toBe("tpl-1");
    expect(instanceForLineId([instance], "other__x")).toBeNull();
  });

  it("bakes a road sign and a character string as first-class prefixed files", () => {
    const sign = bakeTemplateInstance(
      createPlacedTemplateInstance({
        id: "sign-1",
        fileName: "AM 01 2.0m",
        kind: "sign",
        lineIdPrefix: "am01",
        sourceLines: generateRoadSignLines("am_01", 2),
        north: 5,
        east: -3,
      })
    );
    const text = bakeTemplateInstance(
      createPlacedTemplateInstance({
        id: "text-1",
        fileName: "Text HELLO 2.0m",
        kind: "characters",
        lineIdPrefix: "hello",
        sourceLines: generateTextLines("HELLO", 2, "smooth", 0.1),
        north: 5,
        east: -3,
      })
    );
    expect(sign.length).toBeGreaterThan(2);
    expect(text.length).toBeGreaterThan(2);
    expect(sign.every((line) => line.id.startsWith("am01__"))).toBe(true);
    expect(text.every((line) => line.id.startsWith("hello__"))).toBe(true);
    expect(bakedCentroid(sign).north).toBeCloseTo(5, 4);
    expect(bakedCentroid(sign).east).toBeCloseTo(-3, 4);
    expect(bakedCentroid(text).north).toBeCloseTo(5, 4);
    expect(bakedCentroid(text).east).toBeCloseTo(-3, 4);
  });
});
