export const FIELDS_COLORS = {
  bgBase: "#09090b",
  panelBg: "#18181b",
  panelSolid: "#18181b",
  cardSolid: "#1f1f24",
  surfaceSolid: "#252529",
  navSolid: "#111114",
  panelBorder: "#2e2e34",
  textMain: "#f8fafc",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accentBrand: "#f4c10c",
  accentHover: "#d4a50a",
  accentText: "#1c1c1c",
  accentMuted: "#2e2a18",
  accentBorder: "#6b5a12",
  danger: "#ef4444",
  dangerMuted: "#3d1818",
  dangerBorder: "#7f2a2a",
  success: "#10b981",
  successMuted: "#143d30",
  successBorder: "#1f6b4f",
  warning: "#f59e0b",
  warningMuted: "#3d2e14",
  warningBorder: "#7a5a12",
  overlay: "#09090be6",
  iconBrand: "#3d3618",
  iconSuccess: "#1a3d30",
  iconDanger: "#3d1a1a",
  iconWarning: "#3d2e14",
  iconMuted: "#2e2e34",
  pillSecondary: "#35353c",
  teal: "#0f988f",
  tealDark: "#0b6b68",
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