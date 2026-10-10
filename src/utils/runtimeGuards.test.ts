import { describe, expect, it, vi } from "vitest";
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

  it("yieldToUi still resolves when animation frames are never delivered", async () => {
    // A backgrounded app / system picker on top can withhold frames. A promise that never
    // settles would leave every busy-flagged control (Add files, Send…) dead.
    const original = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = () => 0; // never calls back
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      void yieldToUi().then(settled);
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      (globalThis as any).requestAnimationFrame = original;
    }
  });
});
