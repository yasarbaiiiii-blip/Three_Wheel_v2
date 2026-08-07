import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import type { AnchorPoint, UploadedFileEntry } from "../types/uploadedFiles";
import type { MissionLayer } from "../types/missionLayers";
import { createEmptyMissionLayer } from "../types/missionLayers";
import { resolvePlanOrder } from "./anchorResolution";

function dxfLine(id: string, a: [number, number], b: [number, number]): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: a[0], y: a[1] },
    to: { id: 2, x: b[0], y: b[1] },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LINE",
      layer: "0",
      color: 7,
      is_mark: true,
      length_m: Math.hypot(b[0] - a[0], b[1] - a[1]),
      geometry: {},
      preview_points: [
        { north: a[0], east: a[1] },
        { north: b[0], east: b[1] },
      ],
    },
  };
}

/** Straight 11-point road-marking line, 1m spacing along north, corners preserved (pristine). */
function csvLine(id: string, points: AnchorPoint[]): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: points[0].north, y: points[0].east },
    to: { id: 2, x: points[points.length - 1].north, y: points[points.length - 1].east },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: points.length - 1,
      geometry: {
        closed: false,
        road_marking: true,
        vertexCount: points.length,
        corners: [{ atIndex: 3, turnDeg: 45, class: "clean" }],
      },
      preview_points: points,
    },
  };
}

const STRAIGHT: AnchorPoint[] = Array.from({ length: 11 }, (_, i) => ({ north: i, east: 0 }));

function file(
  id: string,
  overrides: Partial<UploadedFileEntry> = {}
): UploadedFileEntry {
  return {
    id,
    fileName: `${id}.csv`,
    kind: "csv",
    isGeographic: true,
    status: "verified",
    lineIdPrefix: id,
    anchorPoint: null,
    ...overrides,
  };
}

function layer(
  id: string,
  number: number,
  fileEntryIds: string[],
  anchorPoint: AnchorPoint | null = null
): MissionLayer {
  return { ...createEmptyMissionLayer(id, number, fileEntryIds), anchorPoint };
}

describe("resolvePlanOrder", () => {
  it("keeps a file's pristine order when it has no anchor", () => {
    const pristine = { fa: [csvLine("fa__path", STRAIGHT)] };
    const result = resolvePlanOrder(pristine, [file("fa")], [], null);
    expect(result.map((l) => l.id)).toEqual(["fa__path"]);
  });

  it("splits a file's own CSV line at its stored anchor point", () => {
    const pristine = { fa: [csvLine("fa__path", STRAIGHT)] };
    const files = [file("fa", { anchorPoint: { north: 3, east: 0 } })];
    const result = resolvePlanOrder(pristine, files, [], null);
    expect(result).toHaveLength(2);
    expect(result[0].from).toMatchObject({ x: 3, y: 0 });
    expect(result[1].from).toMatchObject({ x: 3, y: 0 });
  });

  it("reorders a file's own DXF lines from its stored anchor point", () => {
    const pristine = {
      fa: [dxfLine("fa__A", [0, 0], [0, 2]), dxfLine("fa__B", [50, 0], [50, 2])],
    };
    const files = [file("fa", { kind: "dxf", anchorPoint: { north: 50, east: 0 } })];
    const result = resolvePlanOrder(pristine, files, [], null);
    expect(result.map((l) => l.id)).toEqual(["fa__B", "fa__A"]);
    expect(result[0].from).toMatchObject({ x: 50, y: 0 });
  });

  it("reverses a DXF line entered at its `to` end so painting actually starts at the anchor", () => {
    // fa__B's `to` (not `from`) is the tapped anchor — disconnected from fa__A so there's
    // no shared-vertex ambiguity about which line/end matched.
    const pristine = {
      fa: [dxfLine("fa__A", [0, 0], [0, 2]), dxfLine("fa__B", [50, 0], [50, 2])],
    };
    const files = [file("fa", { kind: "dxf", anchorPoint: { north: 50, east: 2 } })];
    const result = resolvePlanOrder(pristine, files, [], null);
    expect(result.map((l) => l.id)).toEqual(["fa__B", "fa__A"]);
    // fa__B authored (50,0)->(50,2) — reversed so it starts at the tapped (50,2).
    expect(result[0].from).toMatchObject({ x: 50, y: 2 });
    expect(result[0].to).toMatchObject({ x: 50, y: 0 });
  });

  it("reorders member file blocks around a layer's anchor point without altering their own internal order", () => {
    const pristine = {
      fa: [dxfLine("fa__L", [0, 0], [10, 0])],
      fb: [dxfLine("fb__L", [100, 0], [110, 0])],
    };
    const files = [file("fa", { kind: "dxf" }), file("fb", { kind: "dxf" })];
    const layers = [layer("ly1", 1, ["fa", "fb"], { north: 100, east: 0 })];
    const result = resolvePlanOrder(pristine, files, layers, null);
    expect(result.map((l) => l.id)).toEqual(["fb__L", "fa__L"]);
  });

  it("keeps a member file's own anchor-driven split intact when the layer reorders around a different file", () => {
    const pristine = {
      fa: [csvLine("fa__path", STRAIGHT)],
      fb: [dxfLine("fb__L", [100, 0], [110, 0])],
    };
    const files = [
      file("fa", { anchorPoint: { north: 3, east: 0 } }),
      file("fb", { kind: "dxf" }),
    ];
    const layers = [layer("ly1", 1, ["fa", "fb"], { north: 100, east: 0 })];
    const result = resolvePlanOrder(pristine, files, layers, null);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("fb__L");
    // fa's own file-level anchor split survives, still anchored at (3,0), unsplit further.
    expect(result[1].from).toMatchObject({ x: 3, y: 0 });
    expect(result[2].from).toMatchObject({ x: 3, y: 0 });
  });

  it("composes layers and unassigned files at the top level via the universal anchor", () => {
    const pristine = {
      fa: [dxfLine("fa__L", [0, 0], [10, 0])],
      fc: [dxfLine("fc__L", [200, 0], [210, 0])],
    };
    const files = [file("fa", { kind: "dxf" }), file("fc", { kind: "dxf" })];
    const layers = [layer("ly1", 1, ["fa"])];
    const result = resolvePlanOrder(pristine, files, layers, { north: 200, east: 0 });
    expect(result.map((l) => l.id)).toEqual(["fc__L", "fa__L"]);
  });

  it("defaults to layer-number order then unassigned files when no anchors are set", () => {
    const pristine = {
      fa: [dxfLine("fa__L", [0, 0], [1, 0])],
      fb: [dxfLine("fb__L", [10, 0], [11, 0])],
      fc: [dxfLine("fc__L", [20, 0], [21, 0])],
    };
    const files = [file("fa", { kind: "dxf" }), file("fb", { kind: "dxf" }), file("fc", { kind: "dxf" })];
    // Passed out of number order on purpose — resolver must sort by layer.number itself.
    const layers = [layer("ly2", 2, ["fb"]), layer("ly1", 1, ["fa"])];
    const result = resolvePlanOrder(pristine, files, layers, null);
    expect(result.map((l) => l.id)).toEqual(["fa__L", "fb__L", "fc__L"]);
  });

  it("never compounds geometry loss across repeated re-anchoring — every resolve reads the same untouched pristine baseline", () => {
    const pristine = { fa: [csvLine("fa__path", STRAIGHT)] };

    const result1 = resolvePlanOrder(pristine, [file("fa", { anchorPoint: { north: 3, east: 0 } })], [], null);
    expect(result1).toHaveLength(2);
    expect(result1[0].from).toMatchObject({ x: 3, y: 0 });

    // A different anchor point, resolved from the exact same pristine input object.
    const result2 = resolvePlanOrder(pristine, [file("fa", { anchorPoint: { north: 7, east: 0 } })], [], null);
    expect(result2).toHaveLength(2);
    expect(result2[0].from).toMatchObject({ x: 7, y: 0 });

    // Pristine itself was never mutated by either resolve — still one whole line with corners.
    expect(pristine.fa).toHaveLength(1);
    expect(pristine.fa[0].entity?.geometry.corners).toEqual([{ atIndex: 3, turnDeg: 45, class: "clean" }]);
  });

  it("skips files with no pristine geometry yet (e.g. metric DXF pending Fix Alignment)", () => {
    const pristine = { fa: [dxfLine("fa__L", [0, 0], [1, 0])] };
    const files = [file("fa", { kind: "dxf" }), file("fb", { kind: "dxf" })]; // fb has no pristine entry
    const result = resolvePlanOrder(pristine, files, [], null);
    expect(result.map((l) => l.id)).toEqual(["fa__L"]);
  });
});
