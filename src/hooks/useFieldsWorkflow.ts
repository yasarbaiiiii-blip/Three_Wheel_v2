import { useMemo, useState } from "react";

import type { FieldsAccordionId } from "../types/fieldsWorkflow";
import type { LayerVisibility } from "../types/plan";

export function getEffectiveLayerVisibility(
  baseVisibility: LayerVisibility,
  activeAccordion: FieldsAccordionId | null
): LayerVisibility {
  if (activeAccordion === "pathOrder" || activeAccordion === "sprayVerify") {
    return { ...baseVisibility, transit: false, extension: false };
  }
  return baseVisibility;
}

export function useFieldsWorkflow(baseVisibility: LayerVisibility) {
  const [activeAccordion, setActiveAccordion] = useState<FieldsAccordionId | null>("upload");
  const [planPreviewConfirmed, setPlanPreviewConfirmed] = useState(false);

  const effectiveLayerVisibility = useMemo(
    () => getEffectiveLayerVisibility(baseVisibility, activeAccordion),
    [activeAccordion, baseVisibility]
  );

  return {
    activeAccordion,
    setActiveAccordion,
    planPreviewConfirmed,
    setPlanPreviewConfirmed,
    effectiveLayerVisibility,
  };
}