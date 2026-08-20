import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRtkStatus,
  hasLiveCorrections,
  normalizeRtkStatus,
  rtkStatusLabel,
} from "./rtkStatus";

describe("rtkStatus", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("preserves the complete backend lifecycle payload", () => {
    const status = normalizeRtkStatus({
      mode: "idle",
      desired_mode: "ntrip",
      pid: null,
      running: false,
      healthy: false,
      source_state: "restarting",
      frames: 42,
      bytes: 1024,
      last_frame_age_s: 12.5,
      last_error: "socket dropped",
      supervisor_restarts: 3,
      active_profile_id: "profile-1",
      active_profile_revision: 7,
    });
    expect(status).toMatchObject({
      desired_mode: "ntrip",
      source_state: "restarting",
      frames: 42,
      last_frame_age_s: 12.5,
      last_error: "socket dropped",
      supervisor_restarts: 3,
      active_profile_id: "profile-1",
      active_profile_revision: 7,
    });
    expect(rtkStatusLabel(status)).toBe("NTRIP process restarting");
  });

  it("requires fresh RTCM frames before calling corrections live", () => {
    const base = normalizeRtkStatus({
      mode: "ntrip",
      desired_mode: "ntrip",
      running: true,
      healthy: true,
      source_state: "streaming",
      frames: 10,
      bytes: 400,
      last_frame_age_s: 2,
      supervisor_restarts: 0,
    });
    expect(hasLiveCorrections(base)).toBe(true);
    expect(hasLiveCorrections({ ...base, frames: 0 })).toBe(false);
    expect(hasLiveCorrections({ ...base, last_frame_age_s: 11 })).toBe(false);
    expect(rtkStatusLabel({ ...base, last_frame_age_s: 11 })).toBe("NTRIP stream stale");
  });

  it("uses the installed global authenticated fetch", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        mode: "idle",
        desired_mode: "ntrip",
        running: false,
        healthy: false,
        source_state: "unavailable",
        frames: 0,
        bytes: 0,
        last_frame_age_s: null,
        last_error: "configuration missing",
        supervisor_restarts: 0,
      }), { status: 200 })
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    const status = await fetchRtkStatus("http://192.168.1.102:5001");
    expect(status.source_state).toBe("unavailable");
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/rtk/status");
  });
});
