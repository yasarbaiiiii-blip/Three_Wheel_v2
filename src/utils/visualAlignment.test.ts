import { describe, it, expect } from "vitest";
import {
  buildVisualAlignmentRefPoints,
  projectGpsToLocalMeters,
  transformVisualDxfPoint,
} from "./visualAlignment";

describe("visualAlignment", () => {
  it("preview matches MapView formula", () => {
    const item = { x: 3, y: -2, rotation: 15, scale: 1 };
    const north = 12;
    const east = -5;
    const cos = Math.cos((item.rotation * Math.PI) / 180);
    const sin = Math.sin((item.rotation * Math.PI) / 180);
    const expectedNorth = (north * cos - east * sin) * item.scale + item.y;
    const expectedEast = (north * sin + east * cos) * item.scale + item.x;
    const placed = transformVisualDxfPoint(north, east, item);
    expect(placed.north).toBeCloseTo(expectedNorth, 12);
    expect(placed.east).toBeCloseTo(expectedEast, 12);
  });

  it("non-centred plan confirmation matches preview", () => {
    const item = { x: 4.5, y: -1.25, rotation: 30, scale: 1 };
    const corners = [
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 50 },
      { x: 10, y: 50 },
    ];
    const originLat = 28.6139;
    const originLon = 77.209;

    for (const corner of corners) {
      const preview = transformVisualDxfPoint(corner.x, corner.y, item);
      const refs = buildVisualAlignmentRefPoints([corner], item, originLat, originLon);
      const ref = refs[0];
      expect(ref.dxf_y).toBeCloseTo(corner.x, 12);
      expect(ref.dxf_x).toBeCloseTo(corner.y, 12);
      const local = projectGpsToLocalMeters(ref.lat, ref.lon, originLat, originLon);
      expect(local.north).toBeCloseTo(preview.north, 6);
      expect(local.east).toBeCloseTo(preview.east, 6);
    }
  });

  it("backend ref integrity for all corners", () => {
    const item = { x: -2, y: 6, rotation: -12, scale: 1 };
    const corners = [
      { x: -8, y: 3 },
      { x: 15, y: 3 },
      { x: 15, y: 22 },
      { x: -8, y: 22 },
    ];
    const originLat = 12.9716;
    const originLon = 77.5946;
    const refs = buildVisualAlignmentRefPoints(corners, item, originLat, originLon);
    expect(refs).toHaveLength(4);
    for (let i = 0; i < refs.length; i++) {
      const corner = corners[i];
      const ref = refs[i];
      const preview = transformVisualDxfPoint(corner.x, corner.y, item);
      const fromGps = projectGpsToLocalMeters(ref.lat, ref.lon, originLat, originLon);
      expect(fromGps.north).toBeCloseTo(preview.north, 6);
      expect(fromGps.east).toBeCloseTo(preview.east, 6);
    }
  });
});