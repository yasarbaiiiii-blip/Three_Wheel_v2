/**
 * LIVE end-to-end verification of the two backend-trajectory flows, driven
 * through the app's OWN client modules against a real rover.
 *
 *     ROVER_BASE_URL=http://192.168.1.102:5001 ROVER_PASSWORD=... npx vitest run src/api/liveRoverFlow.test.ts
 *
 * Skipped entirely without ROVER_BASE_URL, so the offline suite is unaffected.
 *
 * Why this exists rather than a curl script: every previous "the flow works"
 * claim was made by hand-rolling the HTTP calls, which proves the BACKEND works
 * and says nothing about the app. Here the requests are issued by pathApi /
 * missionApi and the verdicts come from missionContract — the same code the
 * operator's device runs. A contract drift between app and backend fails here.
 *
 * It stops one step short of POST /api/mission/start: it asserts the start
 * payload the app WOULD send, and never sends it. Nothing moves.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

const BASE = process.env.ROVER_BASE_URL ?? "";
const PASSWORD = process.env.ROVER_PASSWORD ?? "";
const live = describe.skipIf(!BASE);

/** Survey CSV → backend plan. The 08-01 field-test line. */
const CSV_PATH = process.env.ROVER_CSV_PATH ?? "field_test_03.csv";
/** Georeferenced DXF → backend parse + plan. Today's rigid arc. */
const DXF_PATH = process.env.ROVER_DXF_PATH ?? "arc_2x2_georef_rigid.dxf";

type Wp = { north: number; east: number; spray?: boolean; must_hit?: boolean };

/** Largest per-vertex distance between a preview list and a staged list. */
function maxDeviationM(preview: Wp[], staged: number[][]): number {
  let worst = 0;
  for (let i = 0; i < preview.length; i += 1) {
    const [n, e] = staged[i];
    worst = Math.max(worst, Math.hypot(preview[i].north - n, preview[i].east - e));
  }
  return worst;
}

describe("live rover backend-trajectory flow", () => {
  it("is skipped without ROVER_BASE_URL", () => {
    expect(true).toBe(true);
  });
});

live("live rover backend-trajectory flow", () => {
  let pathApi: typeof import("./pathApi");
  let missionApi: typeof import("./missionApi");
  let contract: typeof import("./missionContract");

  beforeAll(async () => {
    const authApi = await import("./authApi");
    pathApi = await import("./pathApi");
    missionApi = await import("./missionApi");
    contract = await import("./missionContract");

    // Exactly what App.tsx does on connect. Every pathApi/missionApi call below
    // goes out with no explicit auth header — if this wiring is wrong they all
    // 401 and the whole suite fails, which is the point.
    authApi.installAuthenticatedFetch();
    const session = await authApi.login(BASE, PASSWORD);
    expect(session.token).toBeTruthy();
    expect(session.must_change_password).toBe(false);
    authApi.setAuthRuntime({ token: session.token, baseUrl: BASE });
  });

  afterAll(async () => {
    // Leave the controller as we found it: idle, nothing resident.
    await missionApi.clearMission(BASE).catch(() => {});
  });

  it("reaches the rover and lists both source files", async () => {
    const paths = await pathApi.getPaths(BASE);
    const names = paths.map((p) => p.name);
    expect(names).toContain(CSV_PATH);
    expect(names).toContain(DXF_PATH);
  });

  for (const [label, source] of [
    ["survey CSV", CSV_PATH],
    ["georeferenced DXF", DXF_PATH],
  ] as const) {
    describe(`${label} — ${source}`, () => {
      let preview: import("./pathApi").PathPreviewResponse;
      let missionId: string;
      let staged: import("./pathApi").StagedMissionResponse;

      it("previews: the operator sees a real path", async () => {
        const res = await pathApi.getPathPreview(BASE, source);
        expect(res.status).toBe(200);
        preview = await res.json();
        expect(preview.waypoints?.length ?? 0).toBeGreaterThan(1);
        // A path that is all-transit would paint nothing; a path with no
        // must-hit has lost its source vertices to densification.
        expect(preview.waypoints!.some((w) => w.spray)).toBe(true);
        expect(preview.waypoints!.some((w) => w.must_hit)).toBe(true);
      });

      it("plans and stages, and the stage is what was previewed", async () => {
        const res = await pathApi.planAndStage(BASE, source, { source });
        expect(res.status).toBe(200);
        const plan: import("./pathApi").PathPlanResponse = await res.json();

        // The app reads the id off mission_summary; a top-level mission_id is
        // NOT populated by this route. Pinning it here so a client that reads
        // the wrong key fails in the harness, not in the field.
        missionId = String(plan.mission_summary?.mission_id ?? "");
        expect(missionId).toMatch(/^stg_/);

        const stagedRes = await pathApi.getStagedMission(BASE, missionId);
        expect(stagedRes.status).toBe(200);
        staged = await stagedRes.json();

        // WYSIWYG: preview and staged must be the same geometry, or the
        // operator approved a shape the rover will not drive.
        expect(staged.num_waypoints).toBe(preview.num_points);
        expect(staged.waypoints.length).toBe(preview.waypoints!.length);
        expect(maxDeviationM(preview.waypoints as Wp[], staged.waypoints)).toBeLessThan(1e-9);

        // ...and the same paint. A geometry match with drifted spray flags
        // paints the wrong stretches of an identical line.
        expect(staged.spray_flags.length).toBe(preview.waypoints!.length);
        expect(staged.spray_flags).toEqual(preview.waypoints!.map((w) => Boolean(w.spray)));
      });

      it("carries a GPS anchor, so placement is surveyed and not local", async () => {
        // Without this the mission is placed at whatever the EKF origin happens
        // to be — the 2.14 m misplacement failure mode, which shows no symptom
        // in the app at all.
        expect(staged.anchor).toBeTruthy();
        const anchor = staged.anchor as Record<string, unknown>;
        expect(typeof anchor.lat).toBe("number");
        expect(typeof anchor.lon).toBe("number");
        expect(Math.abs(anchor.lat as number)).toBeGreaterThan(0.001);
        expect(staged.placement_mode).toBe("GPS_SURVEYED");
      });

      it("loads to the controller and verifies as the SAME mission", async () => {
        const res = await missionApi.loadMissionToController(BASE, { mission_id: missionId });
        expect(res.status).toBe(200);

        const loadedRes = await missionApi.getLoadedPath(BASE);
        expect(loadedRes.status).toBe(200);
        const loaded: import("./missionApi").LoadedPathResponse = await loadedRes.json();

        const verdict = contract.verifyStagedLoadedMission(loaded, missionId);
        expect(verdict.message).toBeNull();
        expect(verdict.verified).toBe(true);
        expect(loaded.num_waypoints).toBe(staged.num_waypoints);
        expect(loaded.placement_mode).toBe("GPS_SURVEYED");
      });

      it("opens the start gate and would start BY ID, never by filename", async () => {
        const loaded: import("./missionApi").LoadedPathResponse = await (
          await missionApi.getLoadedPath(BASE)
        ).json();

        const gate = contract.evaluateMissionStartGate({
          stagedVerified: true,
          loadedVerified: true,
          stagedMissionId: missionId,
          loaded,
        });
        expect(gate.message).toBeNull();
        expect(gate.allowed).toBe(true);

        const payload = contract.buildMissionStartPayload({
          stagedMissionId: missionId,
          stagedVerified: true,
          fileName: source,
          autoOrigin: true,
        });
        // path_name would make the backend re-read the file from disk and throw
        // the surveyed placement away — the mission would drive in the wrong
        // place. The id is the only safe start key for a staged mission.
        expect(payload).toEqual({ mission_id: missionId, auto_origin: false });
        expect(payload.path_name).toBeUndefined();
      });
    });
  }
});
