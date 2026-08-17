import { describe, expect, it } from "vitest";
import { createPathPipelineGuard, exclusiveBusyMessage } from "./pathPipelineGuard";

describe("pathPipelineGuard generation", () => {
  it("drops a stale preview token after a newer preview starts", () => {
    const g = createPathPipelineGuard();
    const first = g.beginAsyncMapWrite();
    const second = g.beginAsyncMapWrite();
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(second)).toBe(true);
  });

  it("exclusive send invalidates an in-flight preview token", () => {
    const g = createPathPipelineGuard();
    const preview = g.beginAsyncMapWrite();
    const send = g.tryExclusive("send");
    expect(send.ok).toBe(true);
    if (send.ok) {
      expect(g.isCurrent(preview)).toBe(false);
      expect(g.isCurrent(send.token)).toBe(true);
    }
  });
});

describe("pathPipelineGuard exclusive lock", () => {
  it("refuses Start while Send is held", () => {
    const g = createPathPipelineGuard();
    expect(g.tryExclusive("send").ok).toBe(true);
    const start = g.tryExclusive("start");
    expect(start).toEqual({ ok: false, holder: "send" });
    expect(exclusiveBusyMessage("send")).toMatch(/Send to rover/i);
  });

  it("allows Start after Send is released", () => {
    const g = createPathPipelineGuard();
    expect(g.tryExclusive("send").ok).toBe(true);
    expect(g.releaseExclusive("send")).toBe(true);
    expect(g.isExclusive()).toBe(false);
    expect(g.tryExclusive("start").ok).toBe(true);
  });

  it("does not release a lock owned by a different kind", () => {
    const g = createPathPipelineGuard();
    expect(g.tryExclusive("start").ok).toBe(true);
    expect(g.releaseExclusive("send")).toBe(false);
    expect(g.exclusiveKind()).toBe("start");
  });

  it("nested load can see parent exclusive and skip acquiring", () => {
    const g = createPathPipelineGuard();
    expect(g.tryExclusive("send").ok).toBe(true);
    const nested = g.tryExclusive("load");
    expect(nested.ok).toBe(false);
    expect(g.exclusiveKind()).toBe("send");
  });
});
