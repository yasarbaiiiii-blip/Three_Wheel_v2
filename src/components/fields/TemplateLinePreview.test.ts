import { describe, expect, it } from "vitest";

import {
  clampPreviewZoom,
  collectDimensionLods,
  collectPreviewSegs,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  previewStrokeUser,
} from "./templateLinePreviewMath";
import { generateArrowLines } from "../../utils/arrowTemplates";
import { generateTextLines } from "../../utils/characterTemplates";
import { generateRoadSignLines } from "../../utils/roadSignTemplates";

describe("clampPreviewZoom", () => {
  it("clamps between zoom-out and zoom-in limits", () => {
    expect(clampPreviewZoom(0.1)).toBe(PREVIEW_ZOOM_MIN);
    expect(clampPreviewZoom(20)).toBe(PREVIEW_ZOOM_MAX);
    expect(clampPreviewZoom(1)).toBe(1);
    expect(clampPreviewZoom(Number.NaN)).toBe(1);
  });
});

describe("previewStrokeUser", () => {
  it("keeps on-screen stroke in pixels when the world span shrinks", () => {
    const px = 2;
    const size = 200;
    const atNine = previewStrokeUser(9, size, px);
    const atOne = previewStrokeUser(1, size, px);
    expect((atNine * size) / 9).toBeCloseTo(2, 5);
    expect((atOne * size) / 1).toBeCloseTo(2, 5);
    expect(atOne).toBeLessThan(atNine);
  });
});

describe("collectPreviewSegs", () => {
  it("produces drawable segments for letters and arrows", () => {
    const letter = collectPreviewSegs(generateTextLines("A", 1, "smooth", 0.12), false);
    expect(letter.segs.length).toBeGreaterThan(0);
    const xs = letter.segs.flatMap((s) => [s.x1, s.x2]);
    const ys = letter.segs.flatMap((s) => [s.y1, s.y2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.5);

    const north = collectPreviewSegs(generateArrowLines("up", 1), false);
    const east = collectPreviewSegs(generateArrowLines("right", 1), false);
    expect(north.segs.length).toBeGreaterThan(0);
    expect(east.segs.length).toBeGreaterThan(0);
  });
});

describe("collectDimensionLods", () => {
  it("exposes overall size first, then smaller segment lengths", () => {
    const marks = collectDimensionLods(generateRoadSignLines("am_04", 1), false);
    const large = marks.filter((m) => m.tier === "large");
    expect(large.length).toBe(2);
    expect(large.every((m) => m.lengthM > 0)).toBe(true);
    expect(marks.some((m) => m.tier === "medium" || m.tier === "tiny")).toBe(true);
  });
});
