/**
 * Which FieldsPage step cards belong in which render pass.
 *
 * FieldsPage cannot render its step tree once: Path Order hosts a DraggableFlatList
 * (a VirtualizedList) which must never be a same-orientation ScrollView child, so the
 * page calls renderFieldsSteps() several times — one "slice" per host container — and
 * each call returns the WHOLE card tree. Every card is then gated down to the single
 * slice it belongs in.
 *
 * That makes a missing `slice` term a duplication bug rather than a no-op, which is why
 * these predicates live here as pure functions with tests instead of inline in the JSX.
 */

/** One pass of renderFieldsSteps — see FieldsPage's renderFieldsSteps doc for hosts. */
export type FieldsStepSlice =
  | "csvUpload"
  | "csvPathOrder"
  | "csvScroll"
  | "dxfTop"
  | "dxfPathOrder"
  | "localDxfTop";

/**
 * Does the Align card belong in THIS slice?
 *
 * `needsBatchAlignment` answers "does this batch have a metric DXF still awaiting a GPS
 * fit" — a property of the batch, not of the pass. Gating on it alone renders Align in
 * every pass (Upload · Align · Path Order · Align · Templates · Align), which is exactly
 * what a non-georeferenced DXF upload used to produce.
 */
export function shouldRenderAlignCard(input: {
  slice: FieldsStepSlice;
  isDxfPath: boolean;
  needsBatchAlignment: boolean;
}): boolean {
  const isTopSlice = input.slice === "dxfTop" || input.slice === "localDxfTop";
  return isTopSlice && (input.isDxfPath || input.needsBatchAlignment);
}
