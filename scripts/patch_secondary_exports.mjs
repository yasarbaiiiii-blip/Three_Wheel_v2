import fs from "fs";
const path = "src/screens/SecondaryPages.tsx";
let s = fs.readFileSync(path, "utf8");
for (const name of [
  "SwoziPage",
  "StatusPage",
  "PositioningPage",
  "SettingsPage",
  "HowToPage",
  "AboutPage",
  "linesToDxf",
  "buildTemplate",
  "buildRectangleTemplate",
  "defaultDimensions",
  "formatSprayParamValue",
  "RowToggle",
  "RowSlider",
  "DetailRow",
  "lineLength",
  "lineAngle",
  "mmLineweight",
]) {
  s = s.replace(new RegExp(`^function ${name}\\b`, "m"), `export function ${name}`);
}
s = s.replace(/export \{\s*SwoziPage[\s\S]*?\};\s*$/, "");
fs.writeFileSync(path, s);
console.log("export functions:", (s.match(/^export function/gm) || []).length);
