import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProdApiClient, ProdApiError } from "../api/prodClient";
import type {
  AppPlannedMissionRequest,
  AppPlannedMissionResponse,
} from "../contract/prod/missionPlan";
import { computeExpectedAdmission } from "./appPlannedMissionBuilder";
import { stageAppPlannedMission } from "./missionStaging";
import type { NedPair, TrajectoryRun } from "./missionTrajectory";
import { verifyAdmissionResponse, verifyStoredPath } from "./missionTrajectoryVerification";

const ANCHOR: [number, number] = [13.0827, 80.2707];
const SHA = "ab".repeat(32);

const mark = (points: NedPair[]): TrajectoryRun => ({ kind: "mark", points, speed_m_s: 0.35 });
const travel = (points: NedPair[]): TrajectoryRun => ({ kind: "travel", points, speed_m_s: 0.5 });
const RUNS = [travel([[0, 0], [2, 0]]), mark([[2, 0], [2, 12], [8, 12]])];

/** What a correct backend answers for a payload that needs no normalisation. */
function backendAnswer(payload: AppPlannedMissionRequest): AppPlannedMissionResponse {
  const e = computeExpectedAdmission(payload);
  return {
    ok: true,
    mission: {
      sha256: SHA,
      engine_id: "app_v1",
      num_points: e.numPoints,
      num_spray_points: e.numSprayPoints,
      mark_length_m: e.markLengthM,
      transit_length_m: e.transitLengthM,
      bbox_ne_m: e.bboxNeM,
      source: { type: "app_planned", client: payload.client, client_version: payload.client_version, name: payload.name, num_runs: e.numRuns },
    },
    normalisation: { densified_steps: 0, max_boundary_snap_m: 0 },
  };
}

function fakeClient(over: Partial<Record<"token" | "upload" | "path", unknown>> = {}) {
  const calls = { upload: 0, path: 0 };
  let lastPayload: AppPlannedMissionRequest | null = null;
  const client = {
    getToken: () => (over.token === undefined ? "tok" : over.token),
    uploadAppPlannedMission: vi.fn(async (p: AppPlannedMissionRequest) => {
      calls.upload++;
      lastPayload = p;
      if (typeof over.upload === "function") return (over.upload as (p: AppPlannedMissionRequest) => unknown)(p);
      return backendAnswer(p);
    }),
    getMissionPath: vi.fn(async () => {
      calls.path++;
      if (typeof over.path === "function") return (over.path as (p: AppPlannedMissionRequest) => unknown)(lastPayload!);
      const stored = computeExpectedAdmission(lastPayload!).storedPoints;
      return { sha256: SHA, frame: "local_ned", anchor: { ...lastPayload!.anchor, alt: null }, points: stored };
    }),
  };
  return { client: client as unknown as ProdApiClient, calls, spy: client };
}

describe("stageAppPlannedMission", () => {
  it("builds with the anchor, uploads once, verifies the answer and the stored geometry", async () => {
    const { client, calls, spy } = fakeClient();
    const steps: string[] = [];
    const res = await stageAppPlannedMission({
      missionName: "job",
      anchor: ANCHOR,
      runs: RUNS,
      client,
      onStep: (s) => steps.push(s),
    });
    expect(res.success).toBe(true);
    expect(steps).toEqual(["build", "upload", "verify"]);
    expect(calls).toEqual({ upload: 1, path: 1 });
    const sent = spy.uploadAppPlannedMission.mock.calls[0][0];
    expect(sent.frame).toBe("local_ned");
    expect(sent.anchor).toEqual({ lat: ANCHOR[0], lon: ANCHOR[1] });
    expect("origin_ne_m" in sent).toBe(false);
    expect(res.missionId).toBe(SHA);
    expect(res.admitted).toMatchObject({
      missionId: SHA,
      numRuns: 2,
      markLengthM: 12 + 6,
      transitLengthM: 2,
      totalLengthM: 20,
    });
    expect(res.admitted!.numWaypoints).toBe(res.admitted!.mission.num_points);
  });

  it("start re-stage can skip the geometry read-back", async () => {
    const { client, calls } = fakeClient();
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client, verifyStoredGeometry: false });
    expect(res.success).toBe(true);
    expect(calls.path).toBe(0);
  });

  it("refuses without a GPS origin and never calls the rover", async () => {
    const { client, calls } = fakeClient();
    const res = await stageAppPlannedMission({ missionName: "j", anchor: null, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.failedStep).toBe("build");
    expect(res.error).toMatch(/no GPS origin/i);
    expect(calls).toEqual({ upload: 0, path: 0 });
  });

  it("refuses when not signed in and never calls the rover", async () => {
    const { client, calls } = fakeClient({ token: null });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.failedStep).toBe("upload");
    expect(res.error).toMatch(/sign in/i);
    expect(calls.upload).toBe(0);
  });

  it("maps a backend rejection to an operator message", async () => {
    const { client } = fakeClient({
      upload: () => {
        throw new ProdApiError("x", 422, "runs_not_contiguous", "run 1 starts 12.0 mm from the previous run's endpoint");
      },
    });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.failedStep).toBe("upload");
    expect(res.error).toMatch(/within 10 mm/);
    expect(res.error).toMatch(/12\.0 mm/);
  });

  it("blocks Load when admission reports a normalisation", async () => {
    const { client } = fakeClient({
      upload: (p: AppPlannedMissionRequest) => ({ ...backendAnswer(p), normalisation: { densified_steps: 3, max_boundary_snap_m: 0.004 } }),
    });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.failedStep).toBe("verify");
    expect(res.loadBlocked).toBe(true);
    expect(res.error).toMatch(/split 3 step/);
    expect(res.error).toMatch(/moved a run boundary by 4\.00 mm/);
  });

  it("blocks Load when the stored lengths differ from the payload (no fabricated echo)", async () => {
    const { client } = fakeClient({
      upload: (p: AppPlannedMissionRequest) => {
        const a = backendAnswer(p);
        a.mission.mark_length_m = (a.mission.mark_length_m ?? 0) + 0.5;
        return a;
      },
    });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.loadBlocked).toBe(true);
    expect(res.error).toMatch(/Painted length/);
  });

  it("blocks Load when the stored geometry differs from what was sent", async () => {
    const { client } = fakeClient({
      path: (p: AppPlannedMissionRequest) => {
        const pts = computeExpectedAdmission(p).storedPoints.map((q) => [...q]);
        pts[2][0] += 0.01;
        return { sha256: SHA, frame: "local_ned", anchor: { ...p.anchor, alt: null }, points: pts };
      },
    });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.loadBlocked).toBe(true);
    expect(res.error).toMatch(/Stored point 2 differs/);
  });

  it("blocks when the read-back fails", async () => {
    const { client } = fakeClient({
      path: () => {
        throw new ProdApiError("net", 0, "NETWORK_ERROR", "net");
      },
    });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.failedStep).toBe("verify");
  });

  it("refuses an empty trajectory", async () => {
    const { client } = fakeClient();
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: [], client });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No trajectory runs/);
  });
});

describe("verification against the payload", () => {
  const payload = (): AppPlannedMissionRequest => {
    const { client, spy } = fakeClient();
    void client;
    void spy;
    return {
      client: "t",
      client_version: "1",
      frame: "local_ned",
      anchor: { lat: 1, lon: 2 },
      runs: [
        { type: "travel", points: [[0, 0, 2], [1, 0, 2]] },
        { type: "mark", points: [[1, 0, 3], [3, 0, 3]] },
      ],
    };
  };

  it("accepts the exact answer", () => {
    const p = payload();
    expect(verifyAdmissionResponse(p, backendAnswer(p)).ok).toBe(true);
  });

  it("flags a bad sha, missing normalisation, wrong counts and bbox", () => {
    const p = payload();
    const a = backendAnswer(p);
    const bad = {
      ...a,
      mission: { ...a.mission, sha256: "nope", num_points: 99, num_spray_points: 0, bbox_ne_m: [0, 0, 9, 9] as [number, number, number, number] },
      normalisation: undefined as never,
    };
    const codes = verifyAdmissionResponse(p, bad).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["sha_invalid", "normalised", "num_points", "num_spray_points", "bbox"]));
  });

  it("flags a response with no mission", () => {
    const p = payload();
    expect(verifyAdmissionResponse(p, null).issues[0].code).toBe("missing_mission");
  });

  it("stored path: frame, anchor, count and flags are all checked", () => {
    const p = payload();
    const stored = computeExpectedAdmission(p).storedPoints;
    expect(verifyStoredPath(p, { sha256: SHA, frame: "local_ned", anchor: { lat: 1, lon: 2, alt: null }, points: stored })).toEqual([]);
    expect(verifyStoredPath(p, { sha256: SHA, frame: "ekf_local_ned", anchor: null, points: stored }).map((i) => i.code)).toEqual(
      expect.arrayContaining(["stored_frame", "stored_anchor"])
    );
    expect(verifyStoredPath(p, { sha256: SHA, frame: "local_ned", anchor: { lat: 1, lon: 2, alt: null }, points: stored.slice(1) })[0].code).toBe("stored_point_count");
    const flipped = stored.map((q) => [...q]) as typeof stored;
    flipped[1][2] ^= 2;
    expect(verifyStoredPath(p, { sha256: SHA, frame: "local_ned", anchor: { lat: 1, lon: 2, alt: null }, points: flipped })[0].code).toBe("stored_point_mismatch");
  });
});

describe("transport: the real production client is used", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to /api/missions/plan with the bearer token on any port and reads back only the stored path", async () => {
    const seen: Array<{ url: string; method?: string; auth?: string; body?: Record<string, unknown> }> = [];
    let payload: AppPlannedMissionRequest | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, method: init?.method, auth: headers.Authorization, body });
      if (url.endsWith("/api/missions/plan")) {
        payload = body as unknown as AppPlannedMissionRequest;
        return new Response(JSON.stringify(backendAnswer(payload)), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      const stored = computeExpectedAdmission(payload!).storedPoints;
      return new Response(JSON.stringify({ sha256: SHA, frame: "local_ned", anchor: { ...payload!.anchor, alt: null }, points: stored }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new ProdApiClient({ baseUrl: "http://10.1.2.3:9001", token: "operator-token" });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(true);
    expect(seen.map((s) => `${s.method ?? "GET"} ${s.url}`)).toEqual([
      "POST http://10.1.2.3:9001/api/missions/plan",
      `GET http://10.1.2.3:9001/api/missions/${SHA}/path`,
    ]);
    expect(seen.every((s) => s.auth === "Bearer operator-token")).toBe(true);
    expect(seen[0].body).toMatchObject({ frame: "local_ned", anchor: { lat: ANCHOR[0], lon: ANCHOR[1] } });
    expect(seen[0].body).not.toHaveProperty("origin_ne_m");
    expect(seen[0].body).not.toHaveProperty("run_echo");
  });

  it("a 422 body {ok:false, code, reason} becomes the operator message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "OUT_OF_BOUNDS", reason: "run 0 point 3 north exceeds the +/-10000 m envelope" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      })
    );
    const client = new ProdApiClient({ baseUrl: "http://10.1.2.3:8000", token: "t" });
    const res = await stageAppPlannedMission({ missionName: "j", anchor: ANCHOR, runs: RUNS, client });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/10 km from the GPS origin/);
    expect(res.error).toMatch(/envelope/);
  });
});
