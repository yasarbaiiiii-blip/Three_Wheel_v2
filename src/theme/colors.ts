export interface Palette {
  background: string;
  foreground: string;
  panel: string;
  border: string;
  muted: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  emerald: string;
  amber: string;
  crimson: string;
}

export const lightPalette: Palette = {
  background: "#EEF3F7",
  foreground: "#15202B",
  panel: "#FFFFFF",
  border: "#CBD5E1",
  muted: "#E2E8F0",
  mutedForeground: "#52606D",
  primary: "#1E293B",
  primaryForeground: "#F8FAFC",
  emerald: "#059669",
  amber: "#D97706",
  crimson: "#DC2626",
};

export const darkPalette: Palette = {
  background: "#09090B",
  foreground: "#FAFAFA",
  panel: "#18181B",
  border: "#27272A",
  muted: "#27272A",
  mutedForeground: "#A1A1AA",
  primary: "#FAFAFA",
  primaryForeground: "#18181B",
  emerald: "#059669",
  amber: "#D97706",
  crimson: "#DC2626",
};
