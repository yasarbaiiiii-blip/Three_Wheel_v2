import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildCornerCatalog,
  recoverCornersAfterHydration,
  tagLinesWithCorners,
} from "./cornerLifecycle";
import { getLineFitMeta } from "./missionReadiness";

function markLine(
  id: string,
  points: Array<{ north: number; east: number }>,
  corners?: Array<Record<string, unknown>>
): PlanLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: first.north, y: first.east },
    to: { id: 2, x: last.north, y: last.east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 10,
      geometry: {
        closed: false,
        road_marking: true,
        paintable: true,
        corners: corners ?? [],
      },
      preview_points: points,
    },
  };
}

describe("cornerLifecycle", () => {
  const sourceCorners = [
    {
      atIndex: 1,
      turnDeg: 90,
      class: "tight",
      radiusM: 0.5,
      cutM: 0.21,
      overBudget: true,
      undrivable: false,
      north: 0,
      east: 5,
    },
    {
      atIndex: 2,
      turnDeg: 90,
      class: "sharp",
      radiusM: 0.2,
      cutM: 0.08,
      overBudget: true,
      undrivable: true,
      north: 5,
      east: 5,
    },
  ];

  const source = markLine(
    "file__path-1",
    [
      { north: 0, east: 0 },
      { north: 0, east: 5 },
      { north: 5, east: 5 },
      { north: 5, east: 0 },
    ],
    sourceCorners
  );

  it("builds a catalog from pre-send painted lines; the rover controller executes every drivable corner", () => {
    const catalog = buildCornerCatalog([source]);
    expect(catalog).toHaveLength(2);
    // Sharp, tight and over-budget corners are all plain vertices handed to the controller:
    // no teardrop / pivot / paint-through distinction is made on the tablet.
    expect(catalog.map((c) => c.executionMode)).toEqual(["controller", "controller"]);
  });

  it("keeps a reversal corner blocked", () => {
    const reversal = markLine(
      "file__path-3",
      [
        { north: 0, east: 0 },
        { north: 5, east: 0 },
        { north: 0.2, east: 0.1 },
      ],
      [
        {
          atIndex: 1,
          turnDeg: 162,
          class: "reversal",
          radiusM: null,
          cutM: null,
          overBudget: true,
          undrivable: true,
          north: 5,
          east: 0,
        },
      ]
    );
    expect(buildCornerCatalog([reversal])[0]?.executionMode).toBe("blocked");
  });

  it("recovers corners onto densified hydrated ids by geometry", () => {
    // Hydrated densified path near the source (ids like rover-path-N).
    const hydrated: PlanLine[] = [
      markLine("rover-path-1", [
        { north: 0.01, east: 0 },
        { north: 0, east: 2.5 },
        { north: 0.02, east: 5.01 },
        { north: 2.5, east: 5 },
        { north: 5.01, east: 4.99 },
        { north: 5, east: 2.5 },
        { north: 5, east: 0.02 },
      ]),
      markLine("rover-transit-1", [
        { north: 50, east: 50 },
        { north: 60, east: 60 },
      ]),
    ];
    // Transit should not keep paint corners; mark layer only.
    hydrated[1] = { ...hydrated[1], layer: "transit", is_mark: false };

    const tagged = recoverCornersAfterHydration(hydrated, [source]);
    const path = tagged.find((l) => l.id === "rover-path-1")!;
    const corners = path.entity?.geometry?.corners as Array<{ class: string; executionMode?: string }>;
    expect(corners?.length).toBeGreaterThanOrEqual(2);
    expect(corners.some((c) => c.class === "sharp")).toBe(true);
    expect(corners.every((c) => c.executionMode === "controller")).toBe(true);

    const meta = getLineFitMeta(path);
    expect(meta.cornersSummary).toMatch(/tight|sharp/i);
    expect(meta.cornerCounts?.total).toBeGreaterThanOrEqual(2);

    const transit = tagged.find((l) => l.id === "rover-transit-1")!;
    expect(transit.entity?.geometry?.corners ?? []).toEqual([]);
  });

  it("marks a hydrated line non-paintable when a recovered corner is a reversal", () => {
    const reversalSource = markLine(
      "file__path-2",
      [
        { north: 20, east: 0 },
        { north: 25, east: 0 },
        { north: 20.2, east: 0.1 },
      ],
      [
        {
          atIndex: 1,
          turnDeg: 162,
          class: "reversal",
          radiusM: 0.5,
          cutM: 0.3,
          overBudget: true,
          undrivable: false,
          north: 25,
          east: 0,
        },
      ]
    );

    // Hydrated (post-stage) geometry has no `paintable` field of its own — the
    // backend round trip never carries one.
    const hydrated: PlanLine = {
      ...markLine("rover-path-9", [
        { north: 20, east: 0 },
        { north: 25, east: 0 },
        { north: 20.2, east: 0.1 },
      ]),
      entity: {
        entity_id: "rover-path-9",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 10,
        geometry: { closed: false, road_marking: true, corners: [] },
        preview_points: [
          { north: 20, east: 0 },
          { north: 25, east: 0 },
          { north: 20.2, east: 0.1 },
        ],
      },
    };

    const tagged = recoverCornersAfterHydration([hydrated], [reversalSource]);
    const line = tagged.find((l) => l.id === "rover-path-9")!;
    expect(line.entity?.geometry?.paintable).toBe(false);
    expect(getLineFitMeta(line).paintable).toBe(false);
  });

  it("leaves lines unmatched when far from catalog", () => {
    const far = markLine("rover-path-9", [
      { north: 200, east: 200 },
      { north: 210, east: 200 },
    ]);
    const tagged = tagLinesWithCorners([far], buildCornerCatalog([source]));
    expect(tagged[0].entity?.geometry?.corners ?? []).toEqual([]);
  });

  it("does not steal extension vertices as mark corners when layer is extension", () => {
    const ext = {
      ...markLine("rover-ext-pre-1", [
        { north: -1, east: 0 },
        { north: 0, east: 0 },
      ]),
      layer: "extension" as const,
    };
    const tagged = tagLinesWithCorners([ext], buildCornerCatalog([source]));
    expect(tagged[0].entity?.geometry?.corners ?? []).toEqual([]);
  });
});
