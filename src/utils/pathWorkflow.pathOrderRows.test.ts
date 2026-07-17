import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import {
  buildPathOrderRows,
  extractPrimaryLinesFromPathOrderRows,
  groupExtensionLinesForList,
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

describe("buildPathOrderRows", () => {
  it("builds one flat list: primaries, then all transits, then extension groups", () => {
    const primaries = [primary("a"), primary("b")];
    const transits = [transit("t1"), transit("t2")];
    const groups = groupExtensionLinesForList([ext("ext-pre-1", 0.5, 0.5), ext("ext-aft-1", 0.5, 0.5)]);
    const rows = buildPathOrderRows(primaries, transits, groups);

    expect(rows.map((r) => r.kind)).toEqual([
      "primary",
      "primary",
      "transit",
      "transit",
      "extension",
    ]);
    expect(rows.filter((r) => r.kind === "extension")).toHaveLength(1);
    expect((rows[4] as Extract<PathOrderRow, { kind: "extension" }>).title).toBe("Extension");
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

  it("includes every transit as its own row with stable 0-based index", () => {
    const rows = buildPathOrderRows([primary("a")], [transit("t1"), transit("t2"), transit("t3")], []);
    const tRows = rows.filter((r) => r.kind === "transit") as Extract<PathOrderRow, { kind: "transit" }>[];
    expect(tRows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(tRows.map((r) => r.line.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("extractPrimaryLinesFromPathOrderRows ignores transit/extension after a mixed drag", () => {
    const rows = buildPathOrderRows(
      [primary("a"), primary("b"), primary("c")],
      [transit("t1")],
      groupExtensionLinesForList([ext("ext-pre-1", 0.5, 0.5)])
    );
    // Simulate a messy drag order: transit floated mid-list
    const scrambled: PathOrderRow[] = [rows[2], rows[3], rows[0], rows[4], rows[1]];
    const primaries = extractPrimaryLinesFromPathOrderRows(scrambled);
    expect(primaries.map((l) => l.id)).toEqual(["c", "a", "b"]);
  });
});
