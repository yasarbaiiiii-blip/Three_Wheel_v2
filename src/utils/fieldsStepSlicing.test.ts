import { describe, expect, it } from "vitest";

import { shouldRenderAlignCard, type FieldsStepSlice } from "./fieldsStepSlicing";

/** The passes FieldsPage makes for a local (CSV / app-planned DXF) flow. */
const LOCAL_DXF_SLICES: FieldsStepSlice[] = ["localDxfTop", "csvPathOrder", "csvScroll"];

function countAlignCards(
  slices: FieldsStepSlice[],
  opts: { isDxfPath: boolean; needsBatchAlignment: boolean }
): number {
  return slices.filter((slice) => shouldRenderAlignCard({ slice, ...opts })).length;
}

describe("shouldRenderAlignCard", () => {
  it("renders exactly one Align card for a metric DXF awaiting alignment", () => {
    // Regression: a plain (non-georeferenced) DXF produced
    // Upload · Align · Path Order · Align · Templates · Align.
    expect(
      countAlignCards(LOCAL_DXF_SLICES, { isDxfPath: true, needsBatchAlignment: true })
    ).toBe(1);
  });

  it("puts that single card in the top slice", () => {
    expect(
      shouldRenderAlignCard({
        slice: "localDxfTop",
        isDxfPath: true,
        needsBatchAlignment: true,
      })
    ).toBe(true);
  });

  it("keeps Align out of the Path Order and Templates slices", () => {
    for (const slice of ["csvPathOrder", "csvScroll"] as FieldsStepSlice[]) {
      expect(
        shouldRenderAlignCard({ slice, isDxfPath: true, needsBatchAlignment: true })
      ).toBe(false);
    }
  });

  it("still renders once when only the batch flag is set (mixed CSV + metric DXF)", () => {
    // isDxfPath reads false for a mixed batch (batchHasCsv), so the batch flag alone
    // has to carry the card — without duplicating it.
    expect(
      countAlignCards(LOCAL_DXF_SLICES, { isDxfPath: false, needsBatchAlignment: true })
    ).toBe(1);
  });

  it("renders no Align card for a pure CSV flow", () => {
    const csvSlices: FieldsStepSlice[] = ["csvUpload", "csvPathOrder", "csvScroll"];
    expect(countAlignCards(csvSlices, { isDxfPath: false, needsBatchAlignment: false })).toBe(0);
  });
});
