import { describe, expect, it } from "vitest";

import { parseImportedPlanContent } from "./planImport";

describe("planImport curves", () => {
  it("groups LWPOLYLINE into one line with preview_points", () => {
    const dxf = [
      "0", "SECTION",
      "2", "ENTITIES",
      "0", "LWPOLYLINE",
      "8", "0",
      "70", "1",
      "10", "0",
      "20", "0",
      "10", "2",
      "20", "0",
      "10", "2",
      "20", "2",
      "10", "0",
      "20", "2",
      "0", "ENDSEC",
      "0", "EOF",
    ].join("\n");

    const lines = parseImportedPlanContent("dxf", dxf);
    expect(lines).toHaveLength(1);
    expect(lines[0].entity?.entity_type).toBe("LWPOLYLINE");
    expect(lines[0].entity?.preview_points?.length).toBeGreaterThanOrEqual(4);
  });

  it("stores circle geometry in NED after axis conversion", () => {
    const dxf = [
      "0", "SECTION",
      "2", "ENTITIES",
      "0", "CIRCLE",
      "8", "0",
      "10", "3",
      "20", "4",
      "40", "1",
      "0", "ENDSEC",
      "0", "EOF",
    ].join("\n");

    const lines = parseImportedPlanContent("dxf", dxf);
    const geom = lines[0].entity?.geometry;
    expect(geom.centerNorth).toBe(4);
    expect(geom.centerEast).toBe(3);
    expect(geom.radius).toBe(1);
  });
});