import { describe, expect, it } from "vitest";

import type { PlanLine } from "../types/plan";
import { evaluateCsvSendReadiness, getLineFitMeta } from "./missionReadiness";

function markLine(
  id: string,
  corners: Array<Record<string, unknown>>,
  paintable: boolean = true
): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: 5, y: 0 },
    width: 0.1,
    is_mark: true,
    entity: {
      entity_id: id,
      entity_type: "LWPOLYLINE",
      layer: "MARK",
      color: 7,
      is_mark: true,
      length_m: 5,
      geometry: {
        closed: false,
        road_marking: true,
        paintable,
        corners,
      },
      preview_points: [
        { north: 0, east: 0 },
        { north: 5, east: 0 },
      ],
    },
  };
}

describe("reversal corners block Send (cornerLifecycle executionMode='blocked' wired to readiness)", () => {
  const reversalCorner = [
    {
      atIndex: 1,
      turnDeg: 162,
      class: "reversal",
      radiusM: 0.5,
      cutM: 0.3,
      overBudget: true,
      undrivable: false,
      north: 2.5,
      east: 0,
    },
  ];
  const tightCorner = [
    {
      atIndex: 1,
      turnDeg: 90,
      class: "tight",
      radiusM: 3,
      cutM: 0.09,
      overBudget: false,
      undrivable: false,
      north: 2.5,
      east: 0,
    },
  ];

  it("getLineFitMeta still reports a reversal corner count (information only)", () => {
    const line = markLine("file__a", reversalCorner, true);
    const meta = getLineFitMeta(line);
    expect(meta.cornerCounts?.reversal).toBe(1);
  });

  it("a path with a reversal corner is not vetoed: Send needs no acknowledgement for it", () => {
    const line = markLine("file__a", reversalCorner, true);
    const readiness = evaluateCsvSendReadiness({ lines: [line] });
    expect(readiness.canSend).toBe(true);
    expect(readiness.needsAck).toEqual([]);
    expect(readiness.hardBlocks).toEqual([]);
  });

  it("a mission with only ordinary corners sends without acknowledgement", () => {
    const line = markLine("file__b", tightCorner, true);
    const readiness = evaluateCsvSendReadiness({ lines: [line] });
    expect(readiness.canSend).toBe(true);
  });
});
