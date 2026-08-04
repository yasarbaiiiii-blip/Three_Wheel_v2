import { describe, expect, it, beforeEach } from "vitest";

import type { PlanLine } from "../types/plan";
import type { UploadedFileEntry } from "../types/uploadedFiles";
import { buildAppPlannedStartSnapshot } from "./appPlannedStartSnapshot";
import {
  createLayerForFile,
  assignFileToLayer,
  resetMissionLayerIdSeqForTests,
} from "./missionLayerAssignment";
import {
  buildLayerScopedStartSnapshot,
  buildMissionLayerLegCatalog,
  fileForLineId,
  filterCanvasLinesByMissionVisibility,
  filterPaintedLinesForLayers,
  tagLinesWithMissionLayer,
  unassignedFileIds,
} from "./missionLayerLines";

beforeEach(() => {
  resetMissionLayerIdSeqForTests();
});

function mark(id: string): PlanLine {
  return {
    id,
    label: id,
    layer: "marking",
    from: { id: 1, x: 0, y: 0 },
    to: { id: 2, x: 10, y: 0 },
    width: 0.1,
    is_mark: true,
  };
}

function file(
  id: string,
  prefix: string,
  geographic = true
): UploadedFileEntry {
  return {
    id,
    fileName: `${id}.csv`,
    kind: "csv",
    isGeographic: geographic,
    status: "verified",
    lineIdPrefix: prefix,
  };
}

describe("missionLayerLines", () => {
  const files = [file("fa", "north"), file("fb", "south"), file("fc", "strip")];

  it("resolves file by longest lineIdPrefix", () => {
    expect(fileForLineId("north__line-1", files)?.id).toBe("fa");
    expect(fileForLineId("south__x", files)?.id).toBe("fb");
    expect(fileForLineId("local-csv-transit-1", files)).toBeNull();
  });

  it("filters and orders painted lines by layer number", () => {
    let layers = createLayerForFile([], "fa");
    layers = createLayerForFile(layers, "fb");
    // Put strip on layer 1 with north
    const l1 = layers.find((l) => l.fileEntryIds.includes("fa"))!;
    layers = assignFileToLayer(layers, "fc", l1.id);

    const painted = [
      mark("south__b1"),
      mark("north__a1"),
      mark("strip__c1"),
      mark("south__b2"),
      mark("north__a2"),
    ];

    const l2 = layers.find((l) => l.fileEntryIds.includes("fb"))!;
    const ordered = filterPaintedLinesForLayers(
      painted,
      files,
      layers,
      [l2.id, l1.id] // selection order should not matter
    );

    // Layer 1 (north+strip) first, then layer 2 (south), preserving snapshot order within
    expect(ordered.map((l) => l.id)).toEqual([
      "north__a1",
      "strip__c1",
      "north__a2",
      "south__b1",
      "south__b2",
    ]);
  });

  it("buildLayerScopedStartSnapshot preserves metadata and errors on empty", () => {
    const layers = createLayerForFile([], "fa");
    const snap = buildAppPlannedStartSnapshot({
      paintedLines: [mark("north__a1"), mark("south__b1")],
      originGps: [1, 2],
      missionName: "mission-x",
      extensionConfig: { enabled: true, preM: 0.5, aftM: 0.5, perLine: false },
    });

    const ok = buildLayerScopedStartSnapshot(
      snap,
      files,
      layers,
      [layers[0].id]
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.snapshot.missionName).toBe("mission-x");
      expect(ok.snapshot.originGps).toEqual([1, 2]);
      expect(ok.snapshot.paintedLines.map((l) => l.id)).toEqual(["north__a1"]);
      expect(ok.snapshot.extensionConfig?.enabled).toBe(true);
    }

    const empty = buildLayerScopedStartSnapshot(snap, files, layers, []);
    expect(empty.ok).toBe(false);
  });

  it("hides canvas lines only for invisible mission layers with prefix", () => {
    let layers = createLayerForFile([], "fa");
    layers = createLayerForFile(layers, "fb");
    layers = layers.map((l) =>
      l.fileEntryIds.includes("fb") ? { ...l, visible: false } : l
    );

    const lines = [
      mark("north__a1"),
      mark("south__b1"),
      mark("local-csv-transit-1"),
    ];
    const visible = filterCanvasLinesByMissionVisibility(lines, files, layers);
    expect(visible.map((l) => l.id)).toEqual([
      "north__a1",
      "local-csv-transit-1",
    ]);
  });

  it("lists unassigned files", () => {
    const layers = createLayerForFile([], "fa");
    expect(unassignedFileIds(files, layers)).toEqual(["fb", "fc"]);
  });

  it("recovers mission-layer identity on hydrated (unprefixed) lines by nearest geometry", () => {
    let layers = createLayerForFile([], "fa");
    layers = createLayerForFile(layers, "fb");
    const l1 = layers.find((l) => l.fileEntryIds.includes("fa"))!;
    const l2 = layers.find((l) => l.fileEntryIds.includes("fb"))!;

    // Source (pre-stage) geometry — still carries the file prefix.
    const painted = [
      { ...mark("north__a1"), from: { id: 1, x: 0, y: 0 }, to: { id: 2, x: 10, y: 0 } },
      { ...mark("south__b1"), from: { id: 1, x: 100, y: 100 }, to: { id: 2, x: 110, y: 100 } },
    ];
    const catalog = buildMissionLayerLegCatalog(painted, files, layers);

    // Hydrated (post-stage) geometry: ids like the real round trip mints (no file
    // prefix), same coordinates give or take densification noise.
    const hydrated: PlanLine[] = [
      { ...mark("rover-path-1"), from: { id: 1, x: 0.02, y: -0.01 }, to: { id: 2, x: 10, y: 0 } },
      { ...mark("rover-path-2"), from: { id: 1, x: 100, y: 100 }, to: { id: 2, x: 110.03, y: 100 } },
      { ...mark("rover-transit-1"), from: { id: 1, x: 50, y: 50 }, to: { id: 2, x: 60, y: 60 } },
    ];

    const tagged = tagLinesWithMissionLayer(hydrated, catalog);
    expect(tagged.find((l) => l.id === "rover-path-1")?.missionLayerId).toBe(l1.id);
    expect(tagged.find((l) => l.id === "rover-path-2")?.missionLayerId).toBe(l2.id);
    // Far from both source legs — left untagged rather than forced onto a wrong layer.
    expect(tagged.find((l) => l.id === "rover-transit-1")?.missionLayerId).toBeUndefined();
  });

  it("hides hydrated lines by recovered missionLayerId when their layer is invisible", () => {
    let layers = createLayerForFile([], "fa");
    layers = createLayerForFile(layers, "fb");
    layers = layers.map((l) =>
      l.fileEntryIds.includes("fb") ? { ...l, visible: false } : l
    );
    const l2 = layers.find((l) => l.fileEntryIds.includes("fb"))!;

    const hydrated: PlanLine[] = [
      { ...mark("rover-path-1"), missionLayerId: null },
      { ...mark("rover-path-2"), missionLayerId: l2.id },
    ];
    const visible = filterCanvasLinesByMissionVisibility(hydrated, files, layers);
    expect(visible.map((l) => l.id)).toEqual(["rover-path-1"]);
  });
});
