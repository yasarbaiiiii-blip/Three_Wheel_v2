export const FIELDS_COLORS = {
  bgBase: "#09090b",
  panelBg: "#121214",
  panelSolid: "#121214",
  cardSolid: "#1a1a1f",
  surfaceSolid: "#222228",
  navSolid: "#0c0c0e",
  panelBorder: "#2c2c34",
  textMain: "#f4f4f5",
  textMuted: "#a1a1aa",
  textDim: "#71717a",
  accentBrand: "#f4c10c",
  accentHover: "#d4a50a",
  accentText: "#18181b",
  accentMuted: "#2a2410",
  accentBorder: "#5c4d12",
  danger: "#f87171",
  dangerMuted: "#2a1414",
  dangerBorder: "#7f1d1d",
  success: "#34d399",
  successMuted: "#0f2a22",
  successBorder: "#166534",
  warning: "#fbbf24",
  warningMuted: "#2a220f",
  warningBorder: "#854d0e",
  overlay: "#09090be6",
  iconBrand: "#3d3618",
  iconSuccess: "#1a3d30",
  iconDanger: "#3d1a1a",
  iconWarning: "#3d2e14",
  iconMuted: "#2e2e34",
  pillSecondary: "#2e2e36",
  teal: "#0f988f",
  tealDark: "#0b6b68",
  // Map interaction overlay
  hudBg: "rgba(15, 15, 20, 0.85)",
  hudBorder: "rgba(255, 255, 255, 0.12)",
  hudText: "#e2e8f0",
  iconActive: "#22d3ee",
  iconGlow: "rgba(34, 211, 238, 0.25)",
  iconInactive: "#475569",
  confirmGreen: "#22c55e",
  confirmGreenBg: "rgba(34, 197, 94, 0.15)",
  // Step indicators
  stepActive: "#f4c10c",
  stepDone: "#34d399",
  stepPending: "#3f3f46",
};

/** Shared layout tokens for the Fields right rail (alignment grid). */
export const FIELDS_LAYOUT = {
  panelPad: 14,
  cardGap: 8,
  cardRadius: 14,
  headerMinH: 52,
  rowPadH: 14,
  rowPadV: 12,
  bodyPad: 14,
  nodeSize: 28,
  iconBtn: 36,
};

export const statusPillColors = (status: string) => {
  if (status === "verified") {
    return { bg: FIELDS_COLORS.successMuted, border: FIELDS_COLORS.successBorder, text: FIELDS_COLORS.success };
  }
  if (status === "failed") {
    return { bg: FIELDS_COLORS.dangerMuted, border: FIELDS_COLORS.dangerBorder, text: FIELDS_COLORS.danger };
  }
  if (status === "pending") {
    return { bg: FIELDS_COLORS.warningMuted, border: FIELDS_COLORS.warningBorder, text: FIELDS_COLORS.warning };
  }
  return { bg: FIELDS_COLORS.surfaceSolid, border: FIELDS_COLORS.panelBorder, text: FIELDS_COLORS.textDim };
};
