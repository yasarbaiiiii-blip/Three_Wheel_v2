import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildPathOrderRows,
  extractPrimaryLinesFromPathOrderRows,
  getInterShapeTransitLines,
  groupExtensionLinesForList,
  isInterShapeTransitLine,
  type PathOrderRow,
} from "./pathWorkflow";

function primary(id: string, entityType = "line"): PlanLine {
  return {
    id,
    label: `Entity ${id}`,
    layer: "marking",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: 1, y: 0 },
    width: 0.1,
    entity: {
      entity_id: id,
      entity_type: entityType,
      layer: "0",
      color: 1,
      is_mark: true,
      length_m: 1,
      geometry: {},
      preview_points: [],
    },
  };
}

function transit(id: string): PlanLine {
  return {
    id,
    label: "Transit",
    layer: "transit",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: 2, y: 0 },
    width: 0.1,
  };
}

function ext(id: string, pre: number, aft: number): PlanLine {
  return {
    id,
    label: id,
    layer: "extension",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: pre, y: 0 },
    width: 0.1,
    entity: {
      entity_id: "e",
      entity_type: "line",
      layer: "0",
      color: 1,
      is_mark: true,
      length_m: 1,
      geometry: {},
      preview_points: [],
      extension_preview: {
        enabled: true,
        pre_length_m: pre,
        aft_length_m: aft,
        pre_points: [],
        aft_points: [],
      },
    },
  };
}

describe("isInterShapeTransitLine / getInterShapeTransitLines", () => {
  it("keeps true transit and drops extension stubs / mis-tagged lines", () => {
    const lines = [
      transit("runtime-transit-2"),
      ext("ext-pre-e1", 0.5, 0.5),
      {
        ...transit("ext-aft-fake"),
        id: "ext-aft-e1",
        layer: "transit" as const,
      },
      {
        ...transit("with-preview"),
        entity: {
          entity_id: "x",
          entity_type: "line",
          layer: "0",
          color: 1,
          is_mark: false,
          length_m: 1,
          geometry: {},
          preview_points: [],
          extension_preview: {
            enabled: true,
            pre_length_m: 0.5,
            aft_length_m: 0.5,
            pre_points: [],
            aft_points: [],
          },
        },
      },
    ];
    const only = getInterShapeTransitLines(lines);
    expect(only.map((l) => l.id)).toEqual(["runtime-transit-2"]);
    expect(isInterShapeTransitLine(ext("ext-pre-e1", 0.5, 0.5))).toBe(false);
  });
});

describe("buildPathOrderRows", () => {
  it("orders paths, then extension, then collapsed transit dropdown (no transit children)", () => {
    const primaries = [primary("a"), primary("b")];
    const transits = [transit("t1"), transit("t2")];
    const groups = groupExtensionLinesForList([ext("ext-pre-1", 0.5, 0.5), ext("ext-aft-1", 0.5, 0.5)]);
    const rows = buildPathOrderRows(primaries, transits, groups, { transitExpanded: false });

    expect(rows.map((r) => r.kind)).toEqual([
      "primary",
      "primary",
      "extension",
      "transitDropdown",
    ]);
    const dd = rows[3] as Extract<PathOrderRow, { kind: "transitDropdown" }>;
    expect(dd.count).toBe(2);
    expect(dd.expanded).toBe(false);
  });

  it("expands transit dropdown to list each inter-shape transit leg", () => {
    const rows = buildPathOrderRows(
      [primary("a")],
      [transit("t1"), transit("t2"), transit("t3")],
      [],
      { transitExpanded: true }
    );
    expect(rows.map((r) => r.kind)).toEqual([
      "primary",
      "transitDropdown",
      "transit",
      "transit",
      "transit",
    ]);
    const tRows = rows.filter((r) => r.kind === "transit") as Extract<PathOrderRow, { kind: "transit" }>[];
    expect(tRows.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("emits two Extension rows when Pre/Aft distances differ (0.5 vs 0.2)", () => {
    const groups = groupExtensionLinesForList([
      ext("ext-pre-a", 0.5, 0.5),
      ext("ext-aft-a", 0.5, 0.5),
      ext("ext-pre-b", 0.2, 0.2),
      ext("ext-aft-b", 0.2, 0.2),
    ]);
    const rows = buildPathOrderRows([primary("a")], [], groups);
    const extRows = rows.filter((r) => r.kind === "extension") as Extract<
      PathOrderRow,
      { kind: "extension" }
    >[];
    expect(extRows).toHaveLength(2);
    expect(extRows.map((r) => r.title)).toEqual(["Extension 1", "Extension 2"]);
  });

  it("does not put extension stubs into the transit dropdown", () => {
    const rows = buildPathOrderRows(
      [primary("a")],
      [transit("t1"), ext("ext-pre-1", 0.5, 0.5) as PlanLine],
      groupExtensionLinesForList([ext("ext-pre-1", 0.5, 0.5)]),
      { transitExpanded: true }
    );
    const tRows = rows.filter((r) => r.kind === "transit");
    expect(tRows).toHaveLength(1);
    expect((tRows[0] as Extract<PathOrderRow, { kind: "transit" }>).line.id).toBe("t1");
  });

  it("extractPrimaryLinesFromPathOrderRows ignores non-primary after a mixed drag", () => {
    const rows = buildPathOrderRows(
      [primary("a"), primary("b"), primary("c")],
      [transit("t1")],
      groupExtensionLinesForList([ext("ext-pre-1", 0.5, 0.5)]),
      { transitExpanded: true }
    );
    // rows: a, b, c, extension, transitDropdown, transit t1
    const scrambled: PathOrderRow[] = [rows[2], rows[0], rows[4], rows[1], rows[3]];
    const primaries = extractPrimaryLinesFromPathOrderRows(scrambled);
    expect(primaries.map((l) => l.id)).toEqual(["c", "a", "b"]);
  });
});
