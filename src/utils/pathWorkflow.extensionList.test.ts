import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  getExtensionGroupKey,
  getExtensionListDistances,
  getLineLengthM,
  groupExtensionLinesForList,
  isExtensionGroupSelected,
} from "./pathWorkflow";

function makeExtLine(
  id: string,
  preLength: number,
  aftLength: number
): PlanLine {
  return {
    id,
    label: id,
    layer: "extension",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: preLength, y: 0 },
    width: 0.1,
    entity: {
      entity_id: "e1",
      entity_type: "line",
      layer: "0",
      color: 1,
      is_mark: true,
      length_m: 99,
      geometry: {},
      preview_points: [],
      extension_preview: {
        enabled: true,
        pre_length_m: preLength,
        aft_length_m: aftLength,
        pre_points: [],
        aft_points: [],
      },
    },
  };
}

function makeTransit(id: string, length = 3): PlanLine {
  return {
    id,
    label: "Transit",
    layer: "transit",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: length, y: 0 },
    width: 0.1,
  };
}

describe("getLineLengthM", () => {
  it("reads pre_length_m for ext-pre- lines, not parent length_m", () => {
    const line = makeExtLine("ext-pre-e1", 0.5, 0.8);
    expect(getLineLengthM(line)).toBe(0.5);
  });

  it("reads aft_length_m for ext-aft- lines", () => {
    const line = makeExtLine("ext-aft-e1", 0.5, 0.8);
    expect(getLineLengthM(line)).toBe(0.8);
  });

  it("falls back to segment hypot for transit without entity length", () => {
    expect(getLineLengthM(makeTransit("t1", 4))).toBe(4);
  });

  it("treats length_m 0 as unset and measures preview_points instead", () => {
    const line: PlanLine = {
      id: "csv-zero",
      label: "CSV",
      layer: "marking",
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 3, y: 0 },
      width: 0.1,
      entity: {
        entity_id: "e",
        entity_type: "LWPOLYLINE",
        layer: "MARK",
        color: 7,
        is_mark: true,
        length_m: 0,
        geometry: { road_marking: true },
        preview_points: [
          { north: 0, east: 0 },
          { north: 0, east: 3 },
        ],
      },
    };
    expect(getLineLengthM(line)).toBeCloseTo(3, 5);
  });
});

describe("groupExtensionLinesForList", () => {
  it("returns one group when all extensions share the same pre/aft", () => {
    const lines = [
      makeExtLine("ext-pre-a", 0.5, 0.5),
      makeExtLine("ext-aft-a", 0.5, 0.5),
      makeExtLine("ext-pre-b", 0.5, 0.5),
      makeTransit("t1"),
    ];
    const groups = groupExtensionLinesForList(lines, "0.5", "0.5");
    expect(groups).toHaveLength(1);
    expect(groups[0].preM).toBe(0.5);
    expect(groups[0].aftM).toBe(0.5);
    expect(groups[0].lineIds).toEqual(["ext-pre-a", "ext-aft-a", "ext-pre-b"]);
  });

  it("splits into two groups when pre/aft distances differ (0.5 vs 0.8)", () => {
    const lines = [
      makeExtLine("ext-pre-a", 0.5, 0.5),
      makeExtLine("ext-aft-a", 0.5, 0.5),
      makeExtLine("ext-pre-b", 0.8, 0.8),
      makeExtLine("ext-aft-b", 0.8, 0.8),
    ];
    const groups = groupExtensionLinesForList(lines);
    expect(groups).toHaveLength(2);
    const keys = groups.map((g) => g.key).sort();
    expect(keys).toEqual([
      getExtensionGroupKey(0.5, 0.5),
      getExtensionGroupKey(0.8, 0.8),
    ].sort());
  });

  it("uses global fallback when extension_preview lengths are missing", () => {
    const line: PlanLine = {
      id: "ext-pre-x",
      label: "Pre",
      layer: "extension",
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 1, y: 0 },
      width: 0.1,
      entity: {
        entity_id: "x",
        entity_type: "line",
        layer: "0",
        color: 1,
        is_mark: true,
        length_m: 10,
        geometry: {},
        preview_points: [],
      },
    };
    const groups = groupExtensionLinesForList([line], "0.6", "0.7");
    expect(groups).toHaveLength(1);
    expect(groups[0].preM).toBe(0.6);
    expect(groups[0].aftM).toBe(0.7);
  });

  it("returns empty when there are no extension lines", () => {
    expect(groupExtensionLinesForList([makeTransit("t1")])).toEqual([]);
  });
});

describe("isExtensionGroupSelected", () => {
  const group = groupExtensionLinesForList([
    makeExtLine("ext-pre-a", 0.5, 0.5),
    makeExtLine("ext-aft-a", 0.5, 0.5),
  ])[0];

  it("matches when highlightLineIds is exactly the group set", () => {
    expect(isExtensionGroupSelected(group, "ext-pre-a", ["ext-pre-a", "ext-aft-a"])).toBe(true);
  });

  it("does not match a partial or larger highlight set", () => {
    expect(isExtensionGroupSelected(group, "ext-pre-a", ["ext-pre-a"])).toBe(false);
    expect(isExtensionGroupSelected(group, null, ["ext-pre-a", "ext-aft-a", "extra"])).toBe(false);
  });

  it("falls back to selectedLineId membership when no multi-highlight", () => {
    expect(isExtensionGroupSelected(group, "ext-aft-a", null)).toBe(true);
    expect(isExtensionGroupSelected(group, "other", null)).toBe(false);
  });
});

describe("getExtensionListDistances", () => {
  it("prefers entity preview over global fallback", () => {
    const line = makeExtLine("ext-pre-a", 0.4, 0.9);
    expect(getExtensionListDistances(line, "0.1", "0.2")).toEqual({ preM: 0.4, aftM: 0.9 });
  });
});
