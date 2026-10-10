import { describe, expect, it, vi } from "vitest";
import { ProdApiError } from "../../api/prodClient";
import type { StartMissionResponse } from "../../contract/prod/rest";
import { REQUEST_ID_PATTERN, StartTap, beginStartTap, isOutcomeUnknown, newRequestId } from "./startTap";

const SHA = "a".repeat(64);

const accepted = (over: Partial<StartMissionResponse["execution"]> = {}): StartMissionResponse => ({
  ok: true,
  accepted: true,
  execution: { mission_id: 7, request_id: "x", duplicate: false, gate_reason_code: 0, ...over },
  data: { accepted: true, reason_code: 0, mission_id: 7, duplicate: false, gate_reason_code: 0 },
});

const unknown = () => new ProdApiError("timed out", 408, "TIMEOUT", "Request timed out", null);
const refused = () =>
  new ProdApiError("busy", 409, "rejected", "busy", true, { accepted: false, reason_code: 2 });

describe("request ids", () => {
  it("are valid for the backend's pattern (1-64 of A-Za-z0-9._:-)", () => {
    for (let i = 0; i < 50; i++) expect(newRequestId()).toMatch(REQUEST_ID_PATTERN);
    expect(newRequestId().length).toBeLessThanOrEqual(64);
  });

  it("are unique, also within one millisecond", () => {
    const fixed = () => 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId(fixed)));
    expect(ids.size).toBe(500);
  });

  it("a tap refuses an id the backend would reject", () => {
    expect(() => new StartTap(SHA, "has space")).toThrow();
    expect(() => new StartTap(SHA, "x".repeat(65))).toThrow();
    expect(() => new StartTap(SHA, "")).toThrow();
    expect(() => new StartTap(SHA, "tab-1:9f2c")).not.toThrow();
  });
});

describe("one tap = one request_id", () => {
  it("a new tap gets a new id", () => {
    const a = beginStartTap(SHA);
    const b = beginStartTap(SHA);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("sends the tap's id and the mission sha once on success", async () => {
    const client = { startMission: vi.fn().mockResolvedValue(accepted()) };
    const tap = beginStartTap(SHA);
    await tap.submit(client);
    expect(client.startMission).toHaveBeenCalledTimes(1);
    expect(client.startMission).toHaveBeenCalledWith(SHA, tap.requestId);
    expect(tap.attempts).toBe(1);
  });

  it("reuses the SAME id when the outcome is unknown and the send is repeated", async () => {
    const client = {
      startMission: vi.fn().mockRejectedValueOnce(unknown()).mockResolvedValueOnce(accepted({ duplicate: true })),
    };
    const tap = beginStartTap(SHA);
    const res = await tap.submit(client);
    expect(client.startMission).toHaveBeenCalledTimes(2);
    const ids = client.startMission.mock.calls.map((c) => c[1]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(tap.requestId);
    expect(res.execution.duplicate).toBe(true);
    expect(tap.attempts).toBe(2);
  });

  it("a second tap after a retried first one uses a different id", async () => {
    const client = {
      startMission: vi.fn().mockRejectedValueOnce(unknown()).mockResolvedValue(accepted()),
    };
    const first = beginStartTap(SHA);
    await first.submit(client);
    const second = beginStartTap(SHA);
    await second.submit(client);
    const ids = client.startMission.mock.calls.map((c) => c[1]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("retries once only, then throws the unknown outcome", async () => {
    const client = { startMission: vi.fn().mockRejectedValue(unknown()) };
    const tap = beginStartTap(SHA);
    await expect(tap.submit(client)).rejects.toBeInstanceOf(ProdApiError);
    expect(client.startMission).toHaveBeenCalledTimes(2);
  });

  it("never retries a refusal: the rover answered", async () => {
    const client = { startMission: vi.fn().mockRejectedValue(refused()) };
    const tap = beginStartTap(SHA);
    await expect(tap.submit(client)).rejects.toMatchObject({ code: "rejected" });
    expect(client.startMission).toHaveBeenCalledTimes(1);
  });

  it("never retries a not-delivered error (nothing started, the operator fixes the link)", async () => {
    const notDelivered = new ProdApiError("down", 503, "GatewayUnavailable", "down", false);
    const client = { startMission: vi.fn().mockRejectedValue(notDelivered) };
    await expect(beginStartTap(SHA).submit(client)).rejects.toBe(notDelivered);
    expect(client.startMission).toHaveBeenCalledTimes(1);
  });

  it("isOutcomeUnknown is only a delivered:null API error", () => {
    expect(isOutcomeUnknown(unknown())).toBe(true);
    expect(isOutcomeUnknown(refused())).toBe(false);
    expect(isOutcomeUnknown(new Error("x"))).toBe(false);
  });
});
