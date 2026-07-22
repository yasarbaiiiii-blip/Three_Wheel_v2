import { describe, it, expect } from "vitest";
import {
  applyAxisResize,
  applyHandleResize,
  designObbFromLines,
  designOffsetToWorld,
  edgeHandleArrowBearingDeg,
  getEdgeHandleWorldPoints,
  getEdgeResizeHandles,
  getObbResizeHandles,
  isWorldPointInPlanObb,
  getRotateAffordanceWorldPoints,
  handleHitRadiusM,
  rotateAboutDesignCenter,
  scaleAboutDesignAnchor,
  findNearestHandle,
  getHandleWorldPoints,
  worldToDesignPoint,
  HANDLE_HIT_RADIUS_M,
} from "./planResizeHandles";

const pose = {
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
  width: 10,
  height: 10,
};

describe("planResizeHandles", () => {
  it("places SE corner at design (-halfN, +halfE)", () => {
    const handles = getObbResizeHandles(pose);
    const se = handles.find((h) => h.id === "se")!;
    const w = designOffsetToWorld(se.designNorth, se.designEast, pose);
    expect(w.north).toBeCloseTo(-5, 6);
    expect(w.east).toBeCloseTo(5, 6);
  });

  it("scales about opposite corner keeping NW fixed", () => {
    const handles = getObbResizeHandles(pose);
    const se = handles.find((h) => h.id === "se")!;
    const nw = handles.find((h) => h.id === "nw")!;
    const next = scaleAboutDesignAnchor(pose, 2, nw.designNorth, nw.designEast);
    const nwWorld = designOffsetToWorld(nw.designNorth, nw.designEast, next);
    const seWorld = designOffsetToWorld(se.designNorth, se.designEast, next);
    const nwStart = designOffsetToWorld(nw.designNorth, nw.designEast, pose);
    expect(nwWorld.north).toBeCloseTo(nwStart.north, 5);
    expect(nwWorld.east).toBeCloseTo(nwStart.east, 5);
    expect(next.scale).toBe(2);
    // SE should be twice as far from NW
    const d0 = Math.hypot(
      designOffsetToWorld(se.designNorth, se.designEast, pose).north - nwStart.north,
      designOffsetToWorld(se.designNorth, se.designEast, pose).east - nwStart.east
    );
    const d1 = Math.hypot(seWorld.north - nwWorld.north, seWorld.east - nwWorld.east);
    expect(d1).toBeCloseTo(d0 * 2, 4);
  });

  it("applyHandleResize doubles scale when cursor is 2× from anchor", () => {
    const handles = getObbResizeHandles(pose);
    const se = handles.find((h) => h.id === "se")!;
    const nw = handles.find((h) => h.id === "nw")!;
    const seWorld = designOffsetToWorld(se.designNorth, se.designEast, pose);
    const nwWorld = designOffsetToWorld(nw.designNorth, nw.designEast, pose);
    const cursor = {
      north: nwWorld.north + (seWorld.north - nwWorld.north) * 2,
      east: nwWorld.east + (seWorld.east - nwWorld.east) * 2,
    };
    const next = applyHandleResize({
      pose,
      activeHandle: se,
      oppositeHandle: nw,
      cursor,
    });
    expect(next.scale).toBeCloseTo(2, 5);
  });

  it("findNearestHandle picks closest within radius", () => {
    const worlds = getHandleWorldPoints(pose);
    const hit = findNearestHandle({ north: -5, east: 5 }, worlds, 1);
    expect(hit?.id).toBe("se");
  });

  it("designObbFromLines uses absolute DXF mid + correct width/height axes", () => {
    const obb = designObbFromLines([
      { from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
    ]);
    // x=north, y=east
    expect(obb.designCenterNorth).toBeCloseTo(20, 6);
    expect(obb.designCenterEast).toBeCloseTo(30, 6);
    expect(obb.height).toBeCloseTo(20, 6); // north span
    expect(obb.width).toBeCloseTo(20, 6); // east span
  });

  it("designObbFromLines ignores extension legs so handles stay on primary plan", () => {
    const obb = designObbFromLines([
      { id: "mark-1", layer: "marking", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      {
        id: "ext-pre-1",
        layer: "extension",
        from: { x: -50, y: -50 },
        to: { x: 0, y: 0 },
      },
    ]);
    expect(obb.designCenterNorth).toBeCloseTo(5, 6);
    expect(obb.designCenterEast).toBeCloseTo(5, 6);
    expect(obb.height).toBeCloseTo(10, 6);
    expect(obb.width).toBeCloseTo(10, 6);
  });

  it("handles sit on absolute DXF bbox when designCenter is set", () => {
    const offsetPose = {
      ...pose,
      designCenterNorth: 100,
      designCenterEast: 50,
      width: 20,
      height: 10,
    };
    const handles = getObbResizeHandles(offsetPose);
    const se = handles.find((h) => h.id === "se")!;
    const w = designOffsetToWorld(se.designNorth, se.designEast, offsetPose);
    // SE = center + (-halfN, +halfE) = (100-5, 50+10) = (95, 60)
    expect(w.north).toBeCloseTo(95, 6);
    expect(w.east).toBeCloseTo(60, 6);
  });

  it("worldToDesignPoint inverts designOffsetToWorld", () => {
    const rotated = { ...pose, rotation: 35, scale: 1.4, x: 3, y: -2 };
    const world = designOffsetToWorld(4, -1.5, rotated);
    const back = worldToDesignPoint(world, rotated);
    expect(back.designNorth).toBeCloseTo(4, 9);
    expect(back.designEast).toBeCloseTo(-1.5, 9);
  });

  it("applyAxisResize on east edge changes only east scale and pins west", () => {
    const handles = getObbResizeHandles(pose);
    const e = handles.find((h) => h.id === "e")!;
    const w = handles.find((h) => h.id === "w")!;
    const wStart = designOffsetToWorld(w.designNorth, w.designEast, pose);
    // Full span west→east is 10 m; double it → curSpan 20, east edge at +15 when west pinned at -5.
    const cursor = { north: 0, east: 15 };
    const next = applyAxisResize({
      pose,
      activeHandle: e,
      oppositeHandle: w,
      cursor,
    });
    expect(next.scaleEast ?? next.scale).toBeCloseTo(2, 5);
    expect(next.scaleNorth ?? next.scale).toBeCloseTo(1, 5);
    const wAfter = designOffsetToWorld(w.designNorth, w.designEast, next);
    expect(wAfter.north).toBeCloseTo(wStart.north, 5);
    expect(wAfter.east).toBeCloseTo(wStart.east, 5);
  });

  it("applyAxisResize on north edge changes only north scale", () => {
    const handles = getObbResizeHandles(pose);
    const n = handles.find((h) => h.id === "n")!;
    const s = handles.find((h) => h.id === "s")!;
    // Double north span (10 → 20): north edge at +15 with south pinned at -5.
    const cursor = { north: 15, east: 0 };
    const next = applyAxisResize({
      pose,
      activeHandle: n,
      oppositeHandle: s,
      cursor,
    });
    expect(next.scaleNorth ?? next.scale).toBeCloseTo(2, 5);
    expect(next.scaleEast ?? next.scale).toBeCloseTo(1, 5);
  });

  it("rotateAboutDesignCenter keeps design centre fixed in world", () => {
    const p = {
      ...pose,
      designCenterNorth: 2,
      designCenterEast: -1,
      x: 5,
      y: 3,
      rotation: 10,
    };
    const c0 = designOffsetToWorld(2, -1, p);
    const next = rotateAboutDesignCenter(p, 55);
    const c1 = designOffsetToWorld(2, -1, next);
    expect(c1.north).toBeCloseTo(c0.north, 6);
    expect(c1.east).toBeCloseTo(c0.east, 6);
    expect(next.rotation).toBe(55);
  });

  it("getRotateAffordanceWorldPoints sits outside corners", () => {
    const pts = getRotateAffordanceWorldPoints(pose, 0.2);
    expect(pts).toHaveLength(4);
    const se = pts.find((p) => p.id === "se")!;
    // SE corner is (-5, 5); 20% outside → further from origin
    expect(Math.hypot(se.north, se.east)).toBeGreaterThan(Math.hypot(-5, 5));
  });

  it("handleHitRadiusM grows with meters-per-pixel and never below baseline", () => {
    expect(handleHitRadiusM(0.05, pose, 40)).toBeGreaterThanOrEqual(HANDLE_HIT_RADIUS_M);
    // Zoomed out (large mpp) must expand hit target for fingers.
    expect(handleHitRadiusM(0.5, pose, 40)).toBeGreaterThan(handleHitRadiusM(0.05, pose, 40));
  });

  it("getEdgeResizeHandles returns only n/e/s/w midpoints", () => {
    const edges = getEdgeResizeHandles(pose);
    expect(edges.map((h) => h.id).sort()).toEqual(["e", "n", "s", "w"]);
    const worlds = getEdgeHandleWorldPoints(pose);
    const n = worlds.find((h) => h.id === "n")!;
    expect(n.north).toBeCloseTo(5, 6);
    expect(n.east).toBeCloseTo(0, 6);
  });

  it("edgeHandleArrowBearingDeg points outward with pose rotation", () => {
    expect(edgeHandleArrowBearingDeg("n", 0)).toBe(0);
    expect(edgeHandleArrowBearingDeg("e", 0)).toBe(90);
    expect(edgeHandleArrowBearingDeg("n", 45)).toBe(45);
    expect(edgeHandleArrowBearingDeg("w", 90)).toBe(0); // 90+270 = 360 → 0
  });

  it("isWorldPointInPlanObb selects inside and rejects outside", () => {
    // pose: 10×10 OBB centred at 0 → half extents 5
    expect(isWorldPointInPlanObb({ north: 0, east: 0 }, pose)).toBe(true);
    expect(isWorldPointInPlanObb({ north: 4.9, east: 4.9 }, pose)).toBe(true);
    expect(isWorldPointInPlanObb({ north: 6, east: 0 }, pose)).toBe(false);
    expect(isWorldPointInPlanObb({ north: 6, east: 0 }, pose, 1.5)).toBe(true);
  });
});
