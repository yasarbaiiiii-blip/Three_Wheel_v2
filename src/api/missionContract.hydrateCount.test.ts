import { describe, expect, it } from "vitest";
import { verifyHydratedMarkCount } from "./missionContract";

describe("verifyHydratedMarkCount", () => {
  it("allows a single-path mission", () => {
    expect(verifyHydratedMarkCount(1, 1)).toEqual({ ok: true, message: null });
  });

  it("allows load to keep every painted path", () => {
    expect(verifyHydratedMarkCount(2, 2).ok).toBe(true);
  });

  it("rejects Load when a multi-file mission collapses to fewer mark paths", () => {
    const r = verifyHydratedMarkCount(2, 1);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/2/);
  });
});
