import { useMemo, useState } from "react";

import type { FieldsAccordionId, FieldsStepId, PlanManipulationMode, TransformHUDData } from "../types/fieldsWorkflow";
import type { LayerVisibility } from "../types/plan";

/**
 * Layer visibility applied to the Fields plan preview for the current step.
 *
 * Path Order used to force `transit: false` so reordering wouldn't show stale transit
 * until Save. Product requirement is the **entire plan** ambient-visible on every step
 * (marks + transit + extension), so this no longer overrides base visibility. Transit
 * still reflects last-saved order until Load/Save — operators prefer seeing it.
 */
export function getEffectiveLayerVisibility(
  baseVisibility: LayerVisibility,
  _activeStep: FieldsStepId | FieldsAccordionId | null
): LayerVisibility {
  return baseVisibility;
}

/** @deprecated backward compat — old accordion-based overload */
export function getEffectiveLayerVisibilityLegacy(
  baseVisibility: LayerVisibility,
  _activeAccordion: FieldsAccordionId | null
): LayerVisibility {
  return baseVisibility;
}

const INITIAL_TRANSFORM: TransformHUDData = {
  scaleMultiplier: 1,
  boundingWidthM: 0,
  boundingHeightM: 0,
  rotationDeg: 0,
  offsetMeters: { x: 0, y: 0 },
};

export function useFieldsWorkflow(baseVisibility: LayerVisibility) {
  // New step-based state
  const [activeStep, setActiveStep] = useState<FieldsStepId>("upload");
  const [isTransformConfirmed, setIsTransformConfirmed] = useState(false);
  const [isAlignmentComplete, setIsAlignmentComplete] = useState(false);
  const [manipulationMode, setManipulationMode] = useState<PlanManipulationMode>("idle");
  const [transformData, setTransformData] = useState<TransformHUDData>(INITIAL_TRANSFORM);
  const [showMapInteraction, setShowMapInteraction] = useState(false);

  // Legacy compat (will be removed after full migration)
  const [activeAccordion, setActiveAccordion] = useState<FieldsAccordionId | null>("upload");
  const [planPreviewConfirmed, setPlanPreviewConfirmed] = useState(false);

  const effectiveLayerVisibility = useMemo(
    () => getEffectiveLayerVisibility(baseVisibility, activeStep),
    [activeStep, baseVisibility]
  );

  const resetTransform = () => {
    setTransformData(INITIAL_TRANSFORM);
    setManipulationMode("idle");
    setShowMapInteraction(false);
    setIsTransformConfirmed(false);
  };

  return {
    // New step-based
    activeStep,
    setActiveStep,
    isTransformConfirmed,
    setIsTransformConfirmed,
    isAlignmentComplete,
    setIsAlignmentComplete,
    manipulationMode,
    setManipulationMode,
    transformData,
    setTransformData,
    showMapInteraction,
    setShowMapInteraction,
    resetTransform,
    // Legacy compat
    activeAccordion,
    setActiveAccordion,
    planPreviewConfirmed,
    setPlanPreviewConfirmed,
    effectiveLayerVisibility,
  };
}