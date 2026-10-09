import { describe, it, expect } from "vitest";
import {
  evaluateStaleness,
  STALE_THRESHOLD_MS,
  DISCONNECTED_THRESHOLD_MS,
} from "./staleness";

describe("Production contract - staleness model", () => {
  const baseTime = 100000;

  it("marks null, undefined or negative stamps as DISCONNECTED", () => {
    expect(evaluateStaleness(null, baseTime).grade).toBe("DISCONNECTED");
    expect(evaluateStaleness(undefined, baseTime).grade).toBe("DISCONNECTED");
    expect(evaluateStaleness(-100, baseTime).grade).toBe("DISCONNECTED");
    expect(evaluateStaleness(0, baseTime).grade).toBe("DISCONNECTED");
  });

  it("marks age <= 1.0 s as LIVE", () => {
    const live0 = evaluateStaleness(baseTime, baseTime);
    expect(live0.grade).toBe("LIVE");
    expect(live0.isLive).toBe(true);
    expect(live0.isStale).toBe(false);
    expect(live0.isDisconnected).toBe(false);

    const live500 = evaluateStaleness(baseTime - 500, baseTime);
    expect(live500.grade).toBe("LIVE");
    expect(live500.ageMs).toBe(500);
    expect(live500.ageSec).toBeCloseTo(0.5);

    const live1000 = evaluateStaleness(baseTime - STALE_THRESHOLD_MS, baseTime);
    expect(live1000.grade).toBe("LIVE");
    expect(live1000.ageMs).toBe(1000);
  });

  it("marks 1.0 s < age <= 2.5 s as STALE", () => {
    const stale1 = evaluateStaleness(baseTime - (STALE_THRESHOLD_MS + 1), baseTime);
    expect(stale1.grade).toBe("STALE");
    expect(stale1.isLive).toBe(false);
    expect(stale1.isStale).toBe(true);
    expect(stale1.isDisconnected).toBe(false);
    expect(stale1.formattedAge).toContain("STALE");

    const stale2000 = evaluateStaleness(baseTime - 2000, baseTime);
    expect(stale2000.grade).toBe("STALE");
    expect(stale2000.ageSec).toBeCloseTo(2.0);

    const stale2500 = evaluateStaleness(baseTime - DISCONNECTED_THRESHOLD_MS, baseTime);
    expect(stale2500.grade).toBe("STALE");
  });

  it("marks age > 2.5 s as DISCONNECTED", () => {
    const disco = evaluateStaleness(baseTime - (DISCONNECTED_THRESHOLD_MS + 1), baseTime);
    expect(disco.grade).toBe("DISCONNECTED");
    expect(disco.isLive).toBe(false);
    expect(disco.isStale).toBe(false);
    expect(disco.isDisconnected).toBe(true);
    expect(disco.formattedAge).toContain("DISCONNECTED");

    const discoOld = evaluateStaleness(baseTime - 10000, baseTime);
    expect(discoOld.grade).toBe("DISCONNECTED");
  });
});
