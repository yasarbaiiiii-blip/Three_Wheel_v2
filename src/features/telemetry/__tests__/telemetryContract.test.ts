import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as store from "../prodTelemetryStore";
import type { RoverTelemetrySnapshot } from "../../../contract/prod/realtime";
import { liveRover, operatorLinkData, pushRoverEvent } from "../../../test/roverEvents";

function snapshot(): RoverTelemetrySnapshot {
  return {
    vehicle_state: { age_s: 0, fresh: true, data: { position_valid: true, velocity_valid: true, attitude_valid: true, north_m: 12, east_m: 4, down_m: 0, velocity_north_mps: 1, velocity_east_mps: 0, heading_rad: -Math.PI / 2, yaw_rate_radps: 0, arming_state: 2, nav_state: 14, failsafe: false } },
    gnss_report: { age_s: 0, fresh: true, data: { valid: true, fix_type: 3, latitude_deg: 12, longitude_deg: 77, altitude_msl_m: 10, horizontal_accuracy_m: 1, satellites_used: 10, heading_rad: 0, hdop: 1 } },
    gateway: { schema: 1, operator_alive: true, clients: 1 },
  } as RoverTelemetrySnapshot;
}
const ingest = (snap = snapshot(), age_s = 0, options: Record<string, unknown> = {}) =>
  store.ingestTelemetryPacket({ snapshot: snap, age_s }, { source: "socket", ...options } as any);

describe("production telemetry failure contract", () => {
  beforeEach(() => { vi.useFakeTimers(); store.clearProdTelemetry(); (store as any).setProdSocketConnected?.(true); liveRover(); });
  afterEach(() => { store.clearProdTelemetry(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("cached envelopes and source ages add rather than resetting freshness", () => {
    const s = snapshot(); s.vehicle_state!.age_s = 0.6;
    ingest(s, 0.5);
    expect(store.getAdaptedTelemetrySnapshot()?.pos_n).toBeNull();
    expect(store.getOverallStaleness().isLive).toBe(true);
    ingest(s, 3);
    expect(store.getOverallStaleness().isDisconnected).toBe(true);
  });
  it("backend fresh false is unusable despite small age", () => {
    const s = snapshot(); s.vehicle_state!.fresh = false; s.gnss_report!.fresh = false;
    ingest(s);
    expect((store as any).evaluateMissionStartTelemetry().ok).toBe(false);
  });
  it("local aging expires fresh sources without refreshing packet/cache timestamps", () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const unsub = store.subscribeProdTelemetry(() => {});
    ingest(); const received = store.getProdTelemetryState().lastReceivedAt;
    const cache = (store as any).getMissionStartTelemetryPose();
    now += 1001; vi.advanceTimersByTime(1250);
    expect(store.getProdTelemetryState().lastReceivedAt).toBe(received);
    expect((store as any).getMissionStartTelemetryPose()).toBeNull();
    expect(cache?.pos_n).toBe(12);
    expect(store.getAdaptedTelemetrySnapshot()?.pos_n).toBeNull(); unsub();
  });
  it("invalid pose fields and non-finite heading become null", () => {
    const s = snapshot(); Object.assign(s.vehicle_state!.data, {position_valid:false, velocity_valid:false, attitude_valid:false}); s.gnss_report!.data.valid = false;
    ingest(s); const p = store.getAdaptedTelemetrySnapshot()!;
    for (const field of ["pos_n", "pos_e", "speed_m_s", "heading_ned_deg", "lat", "lon", "alt"]) expect((p as any)[field]).toBeNull();
    s.vehicle_state!.data.attitude_valid = true; s.vehicle_state!.data.heading_rad = NaN; ingest(s);
    expect(store.getAdaptedTelemetrySnapshot()?.heading_ned_deg).toBeNull();
  });
  it("reconnect and resume invalidate trust until a genuinely fresh packet", () => {
    ingest(); expect((store as any).evaluateMissionStartTelemetry().ok).toBe(true);
    (store as any).invalidateTelemetrySession("resume");
    expect((store as any).evaluateMissionStartTelemetry().ok).toBe(false);
    ingest(snapshot(), 2); expect((store as any).evaluateMissionStartTelemetry().ok).toBe(false);
    ingest(); expect((store as any).evaluateMissionStartTelemetry().ok).toBe(true);
    (store as any).setProdSocketConnected(false); (store as any).setProdSocketConnected(true);
    expect((store as any).getMissionStartTelemetryPose()).toBeNull();
  });
  it("missing pose rejects Start with an actionable reason", () => {
    const s = snapshot(); s.vehicle_state = null; s.gnss_report = null; ingest(s);
    expect((store as any).evaluateMissionStartTelemetry().reasons).toContain("No valid, fresh rover pose available.");
  });
  it("gateway loss, operator loss and silent telemetry are distinct", () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    ingest(); pushRoverEvent("gateway_link", { connected: false });
    expect((store as any).evaluateMissionStartTelemetry().reasons).toContain("Gateway disconnected.");
    // The gateway comes back (its replay re-establishes the kinds): the operator link is lost.
    pushRoverEvent("gateway_link", { connected: true });
    pushRoverEvent("operator_link", operatorLinkData(false));
    ingest();
    expect(store.getProdTelemetryState().gatewayConnected).toBe(true);
    expect(store.getProdTelemetryState().operatorAlive).toBe(false);
    // The operator heartbeat is not a start condition (prototype behaviour).
    expect((store as any).evaluateMissionStartTelemetry().reasons).not.toContain("Operator heartbeat unavailable.");
    pushRoverEvent("operator_link", operatorLinkData(true));
    ingest(); now += 2501;
    expect((store as any).evaluateMissionStartTelemetry().reasons).toContain("Telemetry disconnected or silent.");
  });
  it("old REST requests never overwrite newer socket data or newer REST results", () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const first = (store as any).beginTelemetryRequest(); now++;
    const second = (store as any).beginTelemetryRequest(); now++;
    const s = snapshot(); s.vehicle_state!.data.north_m = 20;
    expect(ingest(s, 0, {source:"rest", request:second})).toBe(true);
    expect(ingest(snapshot(), 0, {source:"rest", request:first})).toBe(false);
    const third = (store as any).beginTelemetryRequest(); now++;
    ingest(s); expect(ingest(snapshot(), 0, {source:"rest", request:third})).toBe(false);
    expect(store.getAdaptedTelemetrySnapshot()?.pos_n).toBe(20);
  });
  it("wrong schema warns loudly and blocks Start", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = snapshot(); (s.gateway as any).schema = "1"; ingest(s);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema"), "1");
    expect((store as any).evaluateMissionStartTelemetry().ok).toBe(false);
  });
  it("preserves GPS-origin fix >=3 policy without requiring RTK fixed", () => {
    const s = snapshot(); ingest(s);
    expect(store.evaluateMissionStartTelemetry([12,77]).ok).toBe(true);
    s.gnss_report!.data.fix_type=2; ingest(s);
    expect(store.evaluateMissionStartTelemetry([12,77]).reasons.join(" ")).toContain("GPS fix ≥ 3");
    expect(store.evaluateMissionStartTelemetry(null).ok).toBe(true);
  });
});
