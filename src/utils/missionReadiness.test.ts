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

  it("getLineFitMeta treats a reversal-classified corner as non-paintable", () => {
    const line = markLine("file__a", reversalCorner, /* geom paintable */ true);
    const meta = getLineFitMeta(line);
    expect(meta.paintable).toBe(false);
    expect(meta.cornerCounts?.reversal).toBe(1);
  });

  it("an ordinary tight corner (not reversal) stays paintable", () => {
    const line = markLine("file__b", tightCorner, true);
    expect(getLineFitMeta(line).paintable).toBe(true);
  });

  it("evaluateCsvSendReadiness blocks Send until the reversal is skipped or acknowledged", () => {
    const line = markLine("file__a", reversalCorner, true);
    const blocked = evaluateCsvSendReadiness({ lines: [line] });
    expect(blocked.canSend).toBe(false);
    expect(blocked.needsGeometryAck).toBe(true);
    expect(blocked.nonPaintablePainted).toHaveLength(1);

    const acknowledged = evaluateCsvSendReadiness({
      lines: [line],
      geometryAcknowledged: true,
    });
    // Same policy as any other non-paintable painted path: ack unblocks Send,
    // buildTrajectory still refuses the actual reversal geometry downstream.
    expect(acknowledged.canSend).toBe(true);
  });

  it("a mission with only ordinary corners sends without acknowledgement", () => {
    const line = markLine("file__b", tightCorner, true);
    const readiness = evaluateCsvSendReadiness({ lines: [line] });
    expect(readiness.canSend).toBe(true);
    expect(readiness.needsGeometryAck).toBe(false);
  });
});
