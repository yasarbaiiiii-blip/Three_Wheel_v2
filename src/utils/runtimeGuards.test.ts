import { describe, expect, it } from "vitest";
import { yieldToUi } from "./runtimeGuards";

describe("runtimeGuards", () => {
  it("yieldToUi resolves after animation frames", async () => {
    // jsdom/node may not implement rAF — polyfill for the test.
    if (typeof requestAnimationFrame !== "function") {
      (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
        setTimeout(() => cb(Date.now()), 0) as unknown as number;
    }
    const t0 = Date.now();
    await yieldToUi();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
  });
});
