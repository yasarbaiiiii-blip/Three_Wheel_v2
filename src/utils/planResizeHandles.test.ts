import { describe, it, expect } from "vitest";
import {
  applyHandleResize,
  designOffsetToWorld,
  getObbResizeHandles,
  scaleAboutDesignAnchor,
  findNearestHandle,
  getHandleWorldPoints,
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
});
