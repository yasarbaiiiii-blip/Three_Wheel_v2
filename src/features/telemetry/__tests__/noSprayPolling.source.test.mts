/**
 * Source pin for APP-05: spray status by events, not REST polling.
 * Rule: status reaches the tablet only by WebSocket events (rover_event, telemetry);
 * REST is only for commands.
 * No poll timer or call to /api/spray/status remains anywhere in the app.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".git") {
        walk(full, out);
      }
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx|mts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");

describe("APP-05: no REST poll of spray status remains", () => {
  it("no source file polls or calls /api/spray/status", () => {
    const sourceFiles = walk(SRC);
    const callers = sourceFiles
      .filter((file) => read(file).includes("/api/spray/status"))
      .map((file) => relative(ROOT, file));
    expect(callers).toEqual([]);
  });

  it("no periodic timer is scheduled for spray status polling", () => {
    const filesToCheck = [
      join(SRC, "components", "ModernSettingsPage.tsx"),
      join(SRC, "screens", "SecondaryPages.tsx"),
    ];
    for (const file of filesToCheck) {
      const content = read(file);
      // Ensure no setInterval with sprayApiUrl or spray status exists
      expect(/setInterval\([^)]*spray.*status/i.test(content), `${relative(ROOT, file)} has polling timer`).toBe(false);
      expect(/setInterval\([^)]*pollStatus/i.test(content), `${relative(ROOT, file)} has pollStatus timer`).toBe(false);
    }
  });
});
