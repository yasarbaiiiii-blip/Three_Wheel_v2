import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProdApiClient, ProdApiError } from "../../api/prodClient";
import {
  describeCommandError,
  pauseMissionCommand,
  resumeMissionCommand,
  startMissionCommand,
  stopMissionCommand,
} from "./missionCommands";
import { beginStartTap } from "./startTap";

const SHA = "b".repeat(64);
const BASE = "http://192.168.3.150:8000";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; body: unknown; auth: string | undefined };

describe("mission commands against the backend routes", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];
  let replies: Array<Response | Error>;

  beforeEach(() => {
    calls = [];
    replies = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      const next = replies.shift();
      if (!next) throw new Error("no reply queued");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const client = () => new ProdApiClient({ baseUrl: BASE, token: "op-token" });
  const ok = (data: Record<string, unknown> = {}) =>
    json({ ok: true, code: "ok", reason: "", delivered: true, data: { accepted: true, reason_code: 0, ...data } });

  it("start: POST /api/missions/{sha}/start with the tap's request_id, bearer token, and handles 202", async () => {
    replies.push(
      json(
        {
          ok: true,
          accepted: true,
          execution: { mission_id: 7, request_id: "will-be-checked", duplicate: false, gate_reason_code: 0 },
          data: { accepted: true, reason_code: 0, mission_id: 7, duplicate: false, gate_reason_code: 0 },
        },
        202
      )
    );
    const tap = beginStartTap(SHA);
    const result = await startMissionCommand(tap, client());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/missions/${SHA}/start`,
      method: "POST",
      body: { request_id: tap.requestId },
      auth: "Bearer op-token",
    });
    expect(result).toMatchObject({ ok: true, command: "start", missionId: 7, duplicate: false, requestId: tap.requestId });
  });

  it("start: a 202 with duplicate:true is accepted and reported as nothing new started", async () => {
    replies.push(
      json(
        {
          ok: true,
          accepted: true,
          execution: { mission_id: 7, request_id: "r", duplicate: true, gate_reason_code: 0 },
          data: { accepted: true, reason_code: 0, mission_id: 7, duplicate: true, gate_reason_code: 0 },
        },
        202
      )
    );
    const result = await startMissionCommand(beginStartTap(SHA), client());
    expect(result).toMatchObject({ ok: true, duplicate: true, missionId: 7 });
    expect(result.ok && result.message).toMatch(/nothing new/i);
  });

  it("start: a lost reply is retried with the SAME request_id and the second answer is the duplicate", async () => {
    replies.push(
      new Error("Network request failed"),
      json(
        {
          ok: true,
          accepted: true,
          execution: { mission_id: 8, request_id: "r", duplicate: true, gate_reason_code: 0 },
          data: { accepted: true, reason_code: 0, mission_id: 8, duplicate: true, gate_reason_code: 0 },
        },
        202
      )
    );
    const tap = beginStartTap(SHA);
    const result = await startMissionCommand(tap, client());
    expect(calls).toHaveLength(2);
    expect((calls[0].body as { request_id: string }).request_id).toBe((calls[1].body as { request_id: string }).request_id);
    expect(result).toMatchObject({ ok: true, duplicate: true });
  });

  it("start: two taps send two different request ids", async () => {
    const accepted = () =>
      json({ ok: true, accepted: true, execution: { mission_id: 1, request_id: "r", duplicate: false, gate_reason_code: 0 },
        data: { accepted: true, reason_code: 0, mission_id: 1, duplicate: false, gate_reason_code: 0 } }, 202);
    replies.push(accepted(), accepted());
    await startMissionCommand(beginStartTap(SHA), client());
    await startMissionCommand(beginStartTap(SHA), client());
    expect((calls[0].body as { request_id: string }).request_id).not.toBe((calls[1].body as { request_id: string }).request_id);
  });

  it("pause: POST /api/mission/pause, no body", async () => {
    replies.push(ok());
    expect(await pauseMissionCommand(client())).toMatchObject({ ok: true, command: "pause" });
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/mission/pause`, method: "POST", body: undefined });
  });

  it("resume: POST /api/mission/resume, no body", async () => {
    replies.push(ok());
    expect(await resumeMissionCommand(client())).toMatchObject({ ok: true, command: "resume" });
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/mission/resume`, method: "POST", body: undefined });
  });

  it("stop: POST /api/mission/abort with reason operator", async () => {
    replies.push(ok());
    expect(await stopMissionCommand(client())).toMatchObject({ ok: true, command: "stop" });
    expect(calls[0]).toMatchObject({ url: `${BASE}/api/mission/abort`, method: "POST", body: { reason: "operator" } });
  });

  it("never retries pause, resume or stop on an unknown outcome", async () => {
    replies.push(new Error("Network request failed"));
    const result = await stopMissionCommand(client());
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, kind: "unknown", command: "stop" });
  });
});

describe("typed errors become operator messages", () => {
  const api = (status: number, code: string, reason: string, delivered: boolean | null, data?: Record<string, unknown>) =>
    new ProdApiError(reason, status, code, reason, delivered, data);

  it("start refused BUSY, SAFETY_GATE with the guard gate, INVALID_REQUEST", () => {
    expect(describeCommandError("start", api(409, "rejected", "r", true, { reason_code: 2 }))).toMatchObject({
      kind: "refused",
      reasonCode: 2,
    });
    expect(describeCommandError("start", api(409, "rejected", "r", true, { reason_code: 2 })).message).toMatch(/previous mission/i);
    const gate = describeCommandError("start", api(409, "rejected", "r", true, { reason_code: 3, gate_reason_code: 6 }));
    expect(gate.message).toMatch(/safety checks/i);
    expect(gate.message).toMatch(/RTK/);
    const noGps = describeCommandError("start", api(409, "rejected", "r", true, { reason_code: 3, gate_reason_code: 13 }));
    expect(noGps.message).toMatch(/GPS reference/i);
    expect(describeCommandError("start", api(400, "invalid_command", "r", true, { reason_code: 4 }))).toMatchObject({ kind: "invalid" });
  });

  it("resume refusals name the cause", () => {
    expect(describeCommandError("resume", api(409, "rejected", "r", true, { reason_code: 3 })).message).toMatch(/OFFBOARD/);
    expect(describeCommandError("resume", api(409, "rejected", "r", true, { reason_code: 4 })).message).toMatch(/GPS reference/i);
    expect(describeCommandError("resume", api(409, "rejected", "r", true, { reason_code: 1 })).message).toMatch(/not paused/i);
  });

  it("pause and stop refusals say there is nothing to do", () => {
    expect(describeCommandError("pause", api(409, "rejected", "r", true, { reason_code: 1 })).message).toMatch(/not running/i);
    expect(describeCommandError("stop", api(409, "rejected", "r", true, { reason_code: 1 })).message).toMatch(/No mission is active/i);
  });

  it("503 not delivered says nothing was changed", () => {
    const e = describeCommandError("start", api(503, "GatewayUnavailable", "gateway not connected; command NOT delivered", false));
    expect(e.kind).toBe("not_delivered");
    expect(e.message).toMatch(/Nothing was changed/);
    expect(describeCommandError("pause", api(503, "service_unavailable", "x", true, {})).kind).toBe("not_delivered");
  });

  it("504 / timeout / network error say the outcome is unknown and to watch the status", () => {
    for (const err of [
      api(504, "timeout", "no answer", null),
      api(504, "GatewayTimeout", "no reply", null),
      api(408, "TIMEOUT", "Request timed out", null),
      api(0, "NETWORK_ERROR", "Network request failed", null),
    ]) {
      const e = describeCommandError("stop", err);
      expect(e.kind).toBe("unknown");
      expect(e.message).toMatch(/Watch the mission status/);
    }
  });

  it("401, 403, bad id, unknown mission", () => {
    expect(describeCommandError("start", api(401, "HTTP_401", "Unauthorized", false)).kind).toBe("unauthorized");
    expect(describeCommandError("start", api(403, "HTTP_403", "requires role operator", false)).message).toMatch(/operator role/);
    expect(describeCommandError("start", api(400, "bad_id", "x", false)).kind).toBe("invalid");
    expect(describeCommandError("start", api(404, "not_found", "no such mission artifact", false)).message).toMatch(/Send the mission again/);
    expect(describeCommandError("start", api(422, "invalid_request_id", "x", false)).kind).toBe("invalid");
  });

  it("anything else keeps the rover's reason", () => {
    expect(describeCommandError("start", api(502, "weird", "something odd", true))).toMatchObject({
      kind: "other",
      message: "something odd",
    });
    expect(describeCommandError("start", new Error("boom"))).toMatchObject({ kind: "other", message: "boom" });
  });
});

describe("prodClient parses the backend's error bodies", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a 504 with delivered:null stays unknown (not false)", async () => {
    globalThis.fetch = vi.fn(async () =>
      json({ ok: false, code: "GatewayTimeout", reason: "no reply", delivered: null, data: {} }, 504)
    ) as unknown as typeof fetch;
    const c = new ProdApiClient({ baseUrl: BASE, token: "t" });
    await expect(c.pauseMission()).rejects.toMatchObject({ code: "GatewayTimeout", delivered: null, status: 504 });
  });

  it("a FastAPI {detail} 403 gives the role message", async () => {
    globalThis.fetch = vi.fn(async () => json({ detail: "requires role operator" }, 403)) as unknown as typeof fetch;
    const c = new ProdApiClient({ baseUrl: BASE, token: "t" });
    await expect(c.pauseMission()).rejects.toMatchObject({ code: "HTTP_403", reason: "requires role operator" });
  });

  it("a mission-store error {ok,code,reason} has no delivered flag and is not 'unknown'", async () => {
    globalThis.fetch = vi.fn(async () => json({ ok: false, code: "not_found", reason: "no such mission artifact" }, 404)) as unknown as typeof fetch;
    const c = new ProdApiClient({ baseUrl: BASE, token: "t" });
    await expect(c.startMission(SHA, "r1")).rejects.toMatchObject({ code: "not_found", delivered: false });
  });
});
