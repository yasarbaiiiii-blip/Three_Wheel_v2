/**
 * Source pin for APP-15: exactly one place creates a Socket.IO client (the ProdSocketManager
 * singleton in src/api/prodSocket.ts). Screens and components must go through it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".git") walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx|mts)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("one Socket.IO client creator", () => {
  it("only src/api/prodSocket.ts calls io()", () => {
    const files = [...walk(join(ROOT, "src")), join(ROOT, "App.tsx")];
    const offenders = files
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return /import\s*\{[^}]*\bio\b[^}]*\}\s*from\s*["']socket\.io-client["']/.test(text);
      })
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual(["src/api/prodSocket.ts"]);
    expect((readFileSync(join(ROOT, "src/api/prodSocket.ts"), "utf8").match(/\bio\(/g) ?? []).length).toBe(1);
  });
});
