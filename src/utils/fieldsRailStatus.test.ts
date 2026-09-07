import { describe, expect, it } from "vitest";

import {
  deriveFieldsRailStatus,
  originChipLabel,
  readyChipLabel,
} from "./fieldsRailStatus";

const empty = {
  primaryFileName: null as string | null,
  fileCount: 0,
  uploadDone: false,
  alignRequired: false,
  alignDone: false,
  templatesVisible: false,
  pathOrderReady: false,
  stagedOrLoaded: false,
  autoOrigin: false,
  hasGpsOrigin: false,
};

describe("deriveFieldsRailStatus", () => {
  it("starts empty with no CTA", () => {
    const s = deriveFieldsRailStatus(empty);
    expect(s.fileName).toBe("No file");
    expect(s.readyDone).toBe(0);
    expect(s.readyTotal).toBe(2);
    expect(s.origin).toBe("unanchored");
    expect(s.ctaId).toBe("none");
  });

  it("CSV after upload is fully ready and points at Path Order", () => {
    const s = deriveFieldsRailStatus({
      ...empty,
      primaryFileName: "field_test.csv",
      fileCount: 1,
      uploadDone: true,
      templatesVisible: true,
      pathOrderReady: true,
    });
    expect(s.fileName).toBe("field_test.csv");
    expect(s.readyDone).toBe(3);
    expect(s.readyTotal).toBe(3);
    expect(s.ctaId).toBe("pathOrder");
    expect(s.ctaLabel).toBe("Send");
  });

  it("metric DXF after upload is 1 of 4 and points at Align", () => {
    const s = deriveFieldsRailStatus({
      ...empty,
      primaryFileName: "tennis_itf.dxf",
      fileCount: 1,
      uploadDone: true,
      alignRequired: true,
      templatesVisible: true,
    });
    expect(s.readyDone).toBe(1);
    expect(s.readyTotal).toBe(4);
    expect(s.ctaId).toBe("align");
    expect(s.ctaLabel).toBe("Align DXF");
  });

  it("aligned DXF is fully ready and points at Send until staged", () => {
    const s = deriveFieldsRailStatus({
      ...empty,
      primaryFileName: "tennis_itf.dxf",
      fileCount: 1,
      uploadDone: true,
      alignRequired: true,
      alignDone: true,
      templatesVisible: true,
      pathOrderReady: true,
      hasGpsOrigin: true,
    });
    expect(s.readyDone).toBe(4);
    expect(s.readyTotal).toBe(4);
    expect(s.origin).toBe("gps");
    expect(s.ctaId).toBe("pathOrder");
  });

  it("hides the CTA once staged or loaded", () => {
    const s = deriveFieldsRailStatus({
      ...empty,
      primaryFileName: "tennis_itf.dxf",
      fileCount: 1,
      uploadDone: true,
      alignRequired: true,
      alignDone: true,
      templatesVisible: true,
      pathOrderReady: true,
      stagedOrLoaded: true,
      hasGpsOrigin: true,
    });
    expect(s.ctaId).toBe("none");
    expect(s.origin).toBe("gps");
  });

  it("Auto Origin wins only when there is no GPS origin", () => {
    expect(
      deriveFieldsRailStatus({ ...empty, autoOrigin: true }).origin
    ).toBe("auto");
    expect(
      deriveFieldsRailStatus({ ...empty, autoOrigin: true, hasGpsOrigin: true }).origin
    ).toBe("gps");
  });

  it("trims blank file names and floors fileCount", () => {
    const s = deriveFieldsRailStatus({
      ...empty,
      primaryFileName: "  ",
      fileCount: 2.9,
    });
    expect(s.fileName).toBe("No file");
    expect(s.fileCount).toBe(2);
  });
});

describe("chip labels", () => {
  it("renders origin and ready copy", () => {
    expect(originChipLabel("gps")).toBe("Origin GPS");
    expect(originChipLabel("auto")).toBe("Origin Auto");
    expect(originChipLabel("unanchored")).toBe("Origin unanchored");
    expect(readyChipLabel(1, 4)).toBe("1 of 4 ready");
    expect(readyChipLabel(4, 4)).toBe("4 of 4 ready");
  });
});
