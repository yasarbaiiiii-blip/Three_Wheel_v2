import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  appendExtensionLegsFromPlanLines,
  buildExtensionLegCatalogFromEntitiesBody,
  buildRuntimeTransitOverlayFromPlan,
  matchNonSprayToExtensionRole,
  normalizeExtensionSegmentRole,
} from "./extensionTransitClassify";
import { getInterShapeTransitLines, isInterShapeTransitLine } from "./pathWorkflow";

describe("normalizeExtensionSegmentRole", () => {
  it("maps pre/aft variants and rejects transit", () => {
    expect(normalizeExtensionSegmentRole("pre")).toBe("pre");
    expect(normalizeExtensionSegmentRole("PRE_TRANSIT")).toBe("pre");
    expect(normalizeExtensionSegmentRole("aft")).toBe("aft");
    expect(normalizeExtensionSegmentRole("aft_transit")).toBe("aft");
    expect(normalizeExtensionSegmentRole("transit")).toBeNull();
    expect(normalizeExtensionSegmentRole(undefined)).toBeNull();
  });
});

describe("buildExtensionLegCatalogFromEntitiesBody", () => {
  it("uses top-level extensions[] role + points", () => {
    const catalog = buildExtensionLegCatalogFromEntitiesBody({
      extensions: [
        {
          role: "pre",
          points: [
            { north: 0, east: -0.5 },
            { north: 0, east: 0 },
          ],
        },
        {
          role: "aft",
          points: [
            { north: 0, east: 2 },
            { north: 0, east: 2.5 },
          ],
        },
      ],
    });
    expect(catalog).toHaveLength(2);
    expect(catalog[0].role).toBe("pre");
    expect(catalog[1].role).toBe("aft");
  });

  it("also reads entity extension_preview pre/aft points", () => {
    const catalog = buildExtensionLegCatalogFromEntitiesBody({
      entities: [
        {
          extension_preview: {
            enabled: true,
            pre_points: [
              { north: 1, east: 1 },
              { north: 2, east: 2 },
            ],
            aft_points: [
              { north: 3, east: 3 },
              { north: 4, east: 4 },
            ],
          },
        },
      ],
    });
    expect(catalog).toHaveLength(2);
    expect(catalog.map((c) => c.role)).toEqual(["pre", "aft"]);
  });
});

describe("matchNonSprayToExtensionRole", () => {
  const catalog = buildExtensionLegCatalogFromEntitiesBody({
    extensions: [
      {
        role: "pre",
        points: [
          { north: -0.4472135954999579, east: -0.22360679774997896 },
          { north: 0, east: 0 },
        ],
      },
      {
        role: "aft",
        points: [
          { north: 3, east: 1.5 },
          { north: 3.447213595499958, east: 1.723606797749979 },
        ],
      },
    ],
  });

  it("matches extension pre/aft legs so they are not treated as transit", () => {
    expect(
      matchNonSprayToExtensionRole(-0.4472135954999579, -0.22360679774997896, 0, 0, catalog)
    ).toBe("pre");
    expect(matchNonSprayToExtensionRole(3, 1.5, 3.447213595499958, 1.723606797749979, catalog)).toBe(
      "aft"
    );
  });

  it("matches reverse endpoint order", () => {
    expect(matchNonSprayToExtensionRole(0, 0, -0.4472135954999579, -0.22360679774997896, catalog)).toBe(
      "pre"
    );
  });

  it("returns null for true inter-shape transit", () => {
    expect(matchNonSprayToExtensionRole(3, 1.5, 0, 0, catalog)).toBeNull();
  });
});

describe("appendExtensionLegsFromPlanLines + list filter", () => {
  it("drops catalog-matched runtime transit from inter-shape list via segmentRole", () => {
    const extLine: PlanLine = {
      id: "ext-pre-64",
      label: "Pre",
      layer: "extension",
      segmentRole: "pre",
      from: { id: 1, x: -0.45, y: -0.22 },
      to: { id: 2, x: 0, y: 0 },
      width: 0.1,
    };
    const catalog = appendExtensionLegsFromPlanLines([], [extLine]);
    const role = matchNonSprayToExtensionRole(-0.45, -0.22, 0, 0, catalog);
    expect(role).toBe("pre");

    const misTaggedAsTransit: PlanLine = {
      id: "runtime-transit-3",
      label: "Transit",
      layer: "transit",
      segmentRole: "pre",
      from: { id: 1, x: -0.45, y: -0.22 },
      to: { id: 2, x: 0, y: 0 },
      width: 0.1,
    };
    const pureTransit: PlanLine = {
      id: "runtime-transit-5",
      label: "Transit",
      layer: "transit",
      segmentRole: "none",
      from: { id: 1, x: 3, y: 3 },
      to: { id: 2, x: 0, y: 3 },
      width: 0.1,
    };
    expect(isInterShapeTransitLine(misTaggedAsTransit)).toBe(false);
    expect(isInterShapeTransitLine(pureTransit)).toBe(true);
    expect(getInterShapeTransitLines([misTaggedAsTransit, pureTransit, extLine]).map((l) => l.id)).toEqual([
      "runtime-transit-5",
    ]);
  });
});

describe("buildRuntimeTransitOverlayFromPlan", () => {
  const catalog = buildExtensionLegCatalogFromEntitiesBody({
    extensions: [
      {
        role: "pre",
        points: [
          { north: 0, east: -0.5 },
          { north: 0, east: 0 },
        ],
      },
      {
        role: "aft",
        points: [
          { north: 0, east: 2 },
          { north: 0, east: 2.5 },
        ],
      },
    ],
  });

  it("LLA-style: catalog non-empty, only connecting transit is non-spray → transit kept", () => {
    // Extensions live only in catalog/extension_preview; /plan non-spray is solely
    // the inter-shape connector. Old first/last skip dropped this when isEnabled.
    const waypoints = [
      [0, 0],
      [0, 2], // mark
      [5, 2], // transit end
      [5, 4], // mark
    ];
    // segment 0 mark, 1 transit, 2 mark
    const sprayFlags = [true, false, true];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: catalog,
      extensionsEnabled: true,
    });
    expect(overlay.applied).toBe(true);
    expect(overlay.transitLines).toHaveLength(1);
    expect(overlay.transitLines[0].id).toBe("runtime-transit-1");
    expect(overlay.transitLines[0].from).toMatchObject({ x: 0, y: 2 });
    expect(overlay.transitLines[0].to).toMatchObject({ x: 5, y: 2 });
  });

  it("LLA-style: two connecting transits — first and last kept when catalog non-empty", () => {
    // 3 shapes: transit A-B and B-C are first/last non-spray only.
    const waypoints = [
      [0, 0],
      [0, 1], // mark A
      [2, 1], // transit A→B
      [2, 2], // mark B
      [4, 2], // transit B→C
      [4, 3], // mark C
    ];
    const sprayFlags = [true, false, true, false, true];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: catalog,
      extensionsEnabled: true,
    });
    expect(overlay.applied).toBe(true);
    expect(overlay.transitLines.map((l) => l.id)).toEqual([
      "runtime-transit-1",
      "runtime-transit-3",
    ]);
  });

  it("strips catalog-matched PRE/AFT and keeps true mid transit", () => {
    // PRE → mark → AFT → TRANSIT → mark
    const waypoints = [
      [0, -0.5],
      [0, 0],
      [0, 2],
      [0, 2.5],
      [5, 2.5],
      [5, 4],
    ];
    // non-spray: 0=pre, 2=aft, 3=transit; spray marks: 1, 4
    const sprayFlags = [false, true, false, false, true];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: catalog,
      extensionsEnabled: true,
    });
    expect(overlay.applied).toBe(true);
    expect(overlay.transitLines).toHaveLength(1);
    expect(overlay.transitLines[0].id).toBe("runtime-transit-3");
    expect(overlay.transitLines[0].from).toMatchObject({ x: 0, y: 2.5 });
    expect(overlay.transitLines[0].to).toMatchObject({ x: 5, y: 2.5 });
  });

  it("empty catalog + extensions on: structural first/last non-spray skipped as PRE/AFT", () => {
    const waypoints = [
      [0, -0.5],
      [0, 0],
      [0, 2],
      [0, 2.5],
      [5, 2.5],
      [5, 4],
    ];
    // non-spray first + mid transit + last
    const sprayFlags = [false, true, false, false, true];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: [],
      extensionsEnabled: true,
    });
    // first non-spray (0) and last non-spray (3) skipped; segment 2 kept
    expect(overlay.applied).toBe(true);
    expect(overlay.transitLines.map((l) => l.id)).toEqual(["runtime-transit-2"]);
  });

  it("extensions off: all non-spray become transit (no structural skip)", () => {
    const waypoints = [
      [0, 0],
      [0, 1],
      [2, 1],
      [2, 2],
    ];
    const sprayFlags = [false, false, true];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: catalog,
      extensionsEnabled: false,
    });
    expect(overlay.applied).toBe(true);
    expect(overlay.transitLines).toHaveLength(2);
  });

  it("applied=false when no inter-shape transit remains (blocks false runtimePathApplied)", () => {
    // Only PRE + AFT non-spray, both catalog-matched → empty overlay
    const waypoints = [
      [0, -0.5],
      [0, 0],
      [0, 2],
      [0, 2.5],
    ];
    const sprayFlags = [false, true, false];
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints,
      sprayFlags,
      extensionLegCatalog: catalog,
      extensionsEnabled: true,
    });
    expect(overlay.transitLines).toHaveLength(0);
    expect(overlay.applied).toBe(false);
  });

  it("applied=false for too-short waypoint list", () => {
    const overlay = buildRuntimeTransitOverlayFromPlan({
      waypoints: [[0, 0]],
      sprayFlags: [],
      extensionLegCatalog: catalog,
      extensionsEnabled: true,
    });
    expect(overlay.applied).toBe(false);
    expect(overlay.transitLines).toHaveLength(0);
  });
});
