import { describe, expect, it } from "vitest";

import { classifyCsvFlow, hidesLoadStep } from "./csvFlowKind";

const kind = (over: Partial<Parameters<typeof classifyCsvFlow>[0]> = {}) =>
  classifyCsvFlow({
    localCsvPreview: null,
    fileType: "csv",
    preLineCsvMode: false,
    ...over,
  });

describe("classifyCsvFlow", () => {
  it("treats a pre-line survey CSV as its own flow", () => {
    expect(kind({ preLineCsvMode: true })).toBe("pre-line-survey-csv");
  });

  it("treats a plain uploaded CSV as a local point CSV", () => {
    expect(kind({ preLineCsvMode: false })).toBe("local-point-csv");
  });

  it("lets an on-device preview win regardless of the toggle", () => {
    // Only the local parser produces localCsvPreview, so it is decisive.
    expect(kind({ localCsvPreview: {}, preLineCsvMode: true })).toBe("local-point-csv");
  });

  it("ignores non-CSV sources", () => {
    expect(kind({ fileType: "dxf" })).toBe("not-csv");
    expect(kind({ fileType: "waypoints" })).toBe("not-csv");
    expect(kind({ fileType: null })).toBe("not-csv");
  });
});

describe("hidesLoadStep", () => {
  it("shows Path Order & Load for a pre-line survey CSV", () => {
    // THE regression. `isLocalCsvFlow` was `localCsvPreview != null ||
    // fileType === "csv"`, so a pre-line CSV looked local, the load step was
    // hidden, and a surveyed line could be previewed but never loaded.
    expect(hidesLoadStep(kind({ preLineCsvMode: true }))).toBe(false);
  });

  it("keeps it hidden for a local point CSV, which never stages", () => {
    expect(hidesLoadStep(kind({ localCsvPreview: {} }))).toBe(true);
    expect(hidesLoadStep(kind({ preLineCsvMode: false }))).toBe(true);
  });

  it("shows it for DXF", () => {
    expect(hidesLoadStep(kind({ fileType: "dxf" }))).toBe(false);
  });

  it("reproduces the old buggy rule to prove the fix changes behaviour", () => {
    const oldRule = (localCsvPreview: unknown | null, fileType: string | null) =>
      localCsvPreview != null || fileType === "csv";
    // Old: a pre-line CSV was "local" -> load step hidden.
    expect(oldRule(null, "csv")).toBe(true);
    // New: it is not.
    expect(hidesLoadStep(kind({ preLineCsvMode: true }))).toBe(false);
  });
});
