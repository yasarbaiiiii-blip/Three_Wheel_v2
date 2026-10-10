/**
 * Source pin for mission contract v2: the operator never arms and never changes mode for a mission.
 * The only caller of `arm` / `setOffboard` is the separate debug screen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");

describe("the app has no operator arm or OFFBOARD control in the mission flow", () => {
  it("the only caller of arm / setOffboard in the app is the separate debug screen", () => {
    const callers = walk(SRC)
      .filter((file) => /\.(arm|setOffboard)\(/.test(read(file)))
      .map((file) => relative(ROOT, file))
      .sort();
    expect(callers).toEqual(["src/screens/DebugDriveScreen.tsx"]);
  });

  it("the Home mission screen and App have no arm or mode control", () => {
    const files = [join(ROOT, "App.tsx"), join(SRC, "components", "ModernHomeUI.tsx")];
    const forbidden = [
      /\.arm\(/,
      /\.setOffboard\(/,
      /vehicle\/arm/,
      /vehicle\/offboard/,
      /onArmVehicle/,
      /onSetMode/,
      /armVehicle/,
      /setVehicleMode/,
      /set_mode/,
    ];
    for (const file of files) {
      const text = read(file);
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${relative(ROOT, file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("the debug screen is a separate tool: its own connection panel, not part of the mission flow", () => {
    const text = read(join(SRC, "screens", "DebugDriveScreen.tsx"));
    expect(text).toMatch(/SEPARATE engineering tool/);
    expect(text).toMatch(/handleConnect/);
  });
});
