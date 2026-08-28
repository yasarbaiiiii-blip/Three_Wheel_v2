import { describe, expect, it } from "vitest";

import { CHAR_CATALOG, SIGN_CATALOG } from "./templateLibraryCatalog";
import { generateRoadSignLines, type RoadSignType } from "../../utils/roadSignTemplates";
import { generateTextLines } from "../../utils/characterTemplates";

describe("template library catalog", () => {
  it("lists every road sign with drawable strokes", () => {
    expect(SIGN_CATALOG.length).toBeGreaterThanOrEqual(16);
    for (const item of SIGN_CATALOG) {
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.widthM).toBeGreaterThan(0);
      expect(item.heightM).toBeGreaterThan(0);
      expect(generateRoadSignLines(item.id as RoadSignType, 1).length).toBeGreaterThan(0);
    }
  });

  it("lists A–Z and 0–9 with drawable strokes", () => {
    expect(CHAR_CATALOG).toHaveLength(36);
    expect(CHAR_CATALOG[0].id).toBe("A");
    expect(CHAR_CATALOG[25].id).toBe("Z");
    expect(CHAR_CATALOG[26].id).toBe("0");
    expect(CHAR_CATALOG[0].widthM).toBeGreaterThan(0);
    expect(CHAR_CATALOG[0].heightM).toBeGreaterThan(0);
    for (const item of CHAR_CATALOG) {
      expect(generateTextLines(item.id, 1, "smooth", 0.12).length).toBeGreaterThan(0);
    }
  });
});
