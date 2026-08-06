import { describe, expect, it, beforeEach } from "vitest";

import { createEmptyMissionLayer } from "../types/missionLayers";
import {
  applyMissionTerminalOutcome,
  assignFileToLayer,
  createLayerForFile,
  layerForFile,
  markLayersStarted,
  nextLayerNumber,
  nonEmptyMissionLayers,
  outcomeFromMissionStateTransition,
  pruneMissingFiles,
  resetMissionLayerIdSeqForTests,
  resolveVisibleStartLayerIds,
  setMissionLayerVisibility,
  unassignFile,
} from "./missionLayerAssignment";

beforeEach(() => {
  resetMissionLayerIdSeqForTests();
});

describe("missionLayerAssignment", () => {
  it("creates sequential layer numbers without recycling", () => {
    let layers = createLayerForFile([], "f1");
    expect(layers).toHaveLength(1);
    expect(layers[0].number).toBe(1);
    expect(layers[0].fileEntryIds).toEqual(["f1"]);

    layers = createLayerForFile(layers, "f2");
    expect(layers.map((l) => l.number).sort()).toEqual([1, 2]);
    expect(nextLayerNumber(layers)).toBe(3);
  });

  it("keeps a file in at most one layer when reassigning", () => {
    let layers = createLayerForFile([], "f1");
    layers = createLayerForFile(layers, "f2");
    const l2 = layers.find((l) => l.fileEntryIds.includes("f2"))!;
    layers = assignFileToLayer(layers, "f1", l2.id);

    expect(layerForFile(layers, "f1")?.id).toBe(l2.id);
    expect(layers.filter((l) => l.fileEntryIds.includes("f1"))).toHaveLength(1);
    // Layer 1 is empty but kept
    const empty = layers.find((l) => l.number === 1)!;
    expect(empty.fileEntryIds).toEqual([]);
    expect(nonEmptyMissionLayers(layers)).toHaveLength(1);
  });

  it("unassigns and prunes missing files", () => {
    let layers = createLayerForFile([], "f1");
    const l1Id = layers[0].id;
    layers = createLayerForFile(layers, "f2");
    layers = assignFileToLayer(layers, "f2", l1Id);
    expect(layers.find((l) => l.id === l1Id)?.fileEntryIds.sort()).toEqual([
      "f1",
      "f2",
    ]);

    layers = unassignFile(layers, "f1");
    expect(layerForFile(layers, "f1")).toBeNull();
    expect(layers.find((l) => l.id === l1Id)?.fileEntryIds).toEqual(["f2"]);

    layers = pruneMissingFiles(layers, ["f2"]);
    expect(layers.find((l) => l.id === l1Id)?.fileEntryIds).toEqual(["f2"]);
    layers = pruneMissingFiles(layers, []);
    expect(layers.find((l) => l.id === l1Id)?.fileEntryIds).toEqual([]);
  });

  it("marks completed vs stopped outcomes correctly", () => {
    let layers = createLayerForFile([], "f1");
    const id = layers[0].id;
    layers = markLayersStarted(layers, [id], "mission-1", 1000);
    expect(layers[0].lastMissionId).toBe("mission-1");
    expect(layers[0].finished).toBe(false);

    layers = applyMissionTerminalOutcome(layers, [id], "stopped");
    expect(layers[0].finished).toBe(false);
    expect(layers[0].lastOutcome).toBe("stopped");

    layers = applyMissionTerminalOutcome(layers, [id], "completed");
    expect(layers[0].finished).toBe(true);
    expect(layers[0].lastOutcome).toBe("completed");
  });

  it("outcomeFromMissionStateTransition only finishes on completed", () => {
    expect(outcomeFromMissionStateTransition("running", "completed")).toBe(
      "completed"
    );
    expect(outcomeFromMissionStateTransition("running", "idle")).toBe("stopped");
    expect(outcomeFromMissionStateTransition("idle", "completed")).toBeNull();
    expect(outcomeFromMissionStateTransition("running", "running")).toBeNull();
  });

  describe("resolveVisibleStartLayerIds", () => {
    it("returns legacy_full when no mission layers are in use", () => {
      expect(resolveVisibleStartLayerIds([])).toEqual({ kind: "legacy_full" });
    });

    it("blocks with no_layers_ready when layers exist but none have files", () => {
      const layers = [createEmptyMissionLayer("ml-1", 1, [])];
      expect(resolveVisibleStartLayerIds(layers)).toEqual({
        kind: "blocked",
        reason: "no_layers_ready",
      });
    });

    it("blocks with none_visible when every non-empty layer is hidden", () => {
      let layers = createLayerForFile([], "f1");
      const id = layers[0].id;
      layers = setMissionLayerVisibility(layers, id, false);
      expect(resolveVisibleStartLayerIds(layers)).toEqual({
        kind: "blocked",
        reason: "none_visible",
      });
    });

    it("starts only the visible non-empty layers, ignoring hidden and empty ones", () => {
      let layers = createLayerForFile([], "f1");
      layers = createLayerForFile(layers, "f2");
      const [hiddenId, visibleId] = layers.map((l) => l.id);
      layers = setMissionLayerVisibility(layers, hiddenId, false);
      // Empty layer with no files — must never appear in the start set.
      layers = [...layers, createEmptyMissionLayer("ml-empty", 3, [])];

      const result = resolveVisibleStartLayerIds(layers);
      expect(result).toEqual({ kind: "start", ids: [visibleId] });
    });

    it("starts a single non-empty layer only when it is visible", () => {
      let layers = createLayerForFile([], "f1");
      const id = layers[0].id;
      expect(resolveVisibleStartLayerIds(layers)).toEqual({
        kind: "start",
        ids: [id],
      });

      layers = setMissionLayerVisibility(layers, id, false);
      expect(resolveVisibleStartLayerIds(layers)).toEqual({
        kind: "blocked",
        reason: "none_visible",
      });
    });
  });
});
