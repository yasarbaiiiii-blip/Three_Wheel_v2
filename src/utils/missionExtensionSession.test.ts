import { describe, expect, it } from "vitest";
import {
  extensionConfigAfterFileImport,
  type CsvExtensionConfig,
} from "./missionExtensions";

describe("mission extension import policy", () => {
  const edited: CsvExtensionConfig = { enabled: true, preM: 0.8, aftM: 0.9, perLine: true };

  it("selects per-line CAD policy whenever a DXF joins the mission", () => {
    expect(extensionConfigAfterFileImport(edited, "dxf", false)).toEqual({
      enabled: false,
      preM: 0.5,
      aftM: 0.5,
      perLine: true,
    });
    expect(extensionConfigAfterFileImport(edited, "dxf", true).perLine).toBe(true);
  });

  it("starts a new CSV mission in chain-end mode", () => {
    expect(extensionConfigAfterFileImport(edited, "csv", false)).toEqual({
      enabled: false,
      preM: 0.5,
      aftM: 0.5,
      perLine: false,
    });
  });

  it("does not erase the mission policy when a CSV is appended", () => {
    expect(extensionConfigAfterFileImport(edited, "csv", true)).toEqual(edited);
  });
});
