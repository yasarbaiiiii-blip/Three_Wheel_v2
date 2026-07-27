import { beforeEach, describe, expect, it, vi } from "vitest";

import * as pathApi from "../api/pathApi";
import {
  buildCsvPlanAndStageBody,
  uploadAndStageCsvMission,
  type CsvStageStep,
} from "./csvMissionStaging";
import type { SurveyCsvExport } from "./surveyCsvExport";

vi.mock("../api/pathApi", () => ({
  uploadPath: vi.fn(),
  planAndStage: vi.fn(),
  getStagedMission: vi.fn(),
  saveLineConfig: vi.fn(),
}));

const uploadPath = vi.mocked(pathApi.uploadPath);
const planAndStage = vi.mocked(pathApi.planAndStage);
const getStagedMission = vi.mocked(pathApi.getStagedMission);
const saveLineConfig = vi.mocked(pathApi.saveLineConfig);

const EXPORTED: SurveyCsvExport = {
  fileName: "haddows_road.csv",
  text: "Name,Code,Latitude,Longitude\n1,path_1,13.072,80.261\n",
  numPoints: 1,
  numPaths: 1,
  kind: "gps",
  previewAnchor: { lat: 13.072, lon: 80.261 },
};

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function fail(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

const PLAN_OK = {
  source: "haddows_road.csv",
  num_waypoints: 4200,
  mark_length_m: 512.4,
  transit_length_m: 642.6,
  merged_waypoints: [[0, 0], [1, 0]],
  spray_flags: [true, true],
  mission_summary: { mission_id: "stg_abc12345_1700000000" },
};

beforeEach(() => {
  vi.clearAllMocks();
  uploadPath.mockResolvedValue(ok({ saved: "haddows_road.csv", size: 64 }));
  saveLineConfig.mockResolvedValue(ok({ name: "haddows_road.csv", fillet_corners_m: 0 }));
  planAndStage.mockResolvedValue(ok(PLAN_OK));
  getStagedMission.mockResolvedValue(ok({ mission_id: "stg_abc12345_1700000000", num_waypoints: 4200 }));
});

describe("buildCsvPlanAndStageBody", () => {
  it("keeps route optimisation on — it is what inserts the transit legs", () => {
    // With optimize:false the planner emits no TRANSIT connector at all and the separate
    // marking paths merge into one continuous sprayed run, i.e. paint across the gap.
    expect(buildCsvPlanAndStageBody("x.csv").optimize).toBe(true);
  });

  it("omits origin_gps so the rover anchors from the file's own coordinates", () => {
    const body = buildCsvPlanAndStageBody("x.csv");
    expect("origin_gps" in body).toBe(false);
    expect(body.source).toBe("x.csv");
    expect(body.include_waypoints).toBe(true);
  });

  it("leaves default spacing alone for small surveys", () => {
    const body = buildCsvPlanAndStageBody("small.csv", { surveyPointCount: 50 });
    expect(body.line_spacing).toBeUndefined();
  });

  it("coarsens line_spacing for large surveys (plan-and-stage 15 s budget)", () => {
    expect(buildCsvPlanAndStageBody("mid.csv", { surveyPointCount: 500 }).line_spacing).toBe(0.1);
    expect(buildCsvPlanAndStageBody("roads.csv", { surveyPointCount: 2500 }).line_spacing).toBe(
      0.15
    );
  });
});

describe("uploadAndStageCsvMission", () => {
  it("uploads, plans, inspects, and returns the mission id", async () => {
    const steps: CsvStageStep[] = [];
    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData(), {
      onStep: (s) => steps.push(s),
    });

    expect(result.success).toBe(true);
    expect(result.missionId).toBe("stg_abc12345_1700000000");
    expect(result.pathName).toBe("haddows_road.csv");
    expect(result.plan?.num_waypoints).toBe(4200);
    expect(result.stagedInspection?.mission_id).toBe("stg_abc12345_1700000000");
    expect(steps).toEqual(["upload", "lineConfig", "planAndStage", "inspect"]);
    expect(saveLineConfig).toHaveBeenCalled();
  });

  it("plans against the uploaded filename", async () => {
    await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());
    expect(planAndStage).toHaveBeenCalledWith(
      "http://rover",
      "haddows_road.csv",
      expect.objectContaining({ source: "haddows_road.csv", optimize: true })
    );
    // EXPORTED.numPoints is 1 — no coarse line_spacing forced
    const body = planAndStage.mock.calls[0][2] as { line_spacing?: number };
    expect(body.line_spacing).toBeUndefined();
  });

  it("stops at upload and never plans when the upload is rejected", async () => {
    uploadPath.mockResolvedValue(fail(415, '{"detail":"extension \'.txt\' not allowed"}'));

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("upload");
    expect(result.error).toContain("not allowed");
    expect(planAndStage).not.toHaveBeenCalled();
  });

  it("surfaces the planner's own message on a 422", async () => {
    planAndStage.mockResolvedValue(fail(422, '{"detail":"Planning error: no rows with usable coordinates"}'));

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("planAndStage");
    expect(result.error).toBe("Planning error: no rows with usable coordinates");
    expect(getStagedMission).not.toHaveBeenCalled();
  });

  it("fails rather than reporting success when no mission id comes back", async () => {
    planAndStage.mockResolvedValue(ok({ ...PLAN_OK, mission_summary: null }));

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("planAndStage");
    expect(result.error).toContain("no mission ID");
  });

  it("keeps the plan available when only the read-back fails", async () => {
    getStagedMission.mockResolvedValue(fail(404, '{"detail":"Staged mission not found or expired."}'));

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("inspect");
    expect(result.missionId).toBe("stg_abc12345_1700000000");
    expect(result.plan?.num_waypoints).toBe(4200);
  });

  it("reports a network throw as a step failure instead of rejecting", async () => {
    uploadPath.mockRejectedValue(new Error("Network request failed"));

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("upload");
    expect(result.error).toBe("Network request failed");
  });

  it("falls back to a status-coded message when the error body is empty", async () => {
    planAndStage.mockResolvedValue({
      ok: false,
      status: 504,
      text: async () => "",
    } as unknown as Response);

    const result = await uploadAndStageCsvMission("http://rover", EXPORTED, new FormData());

    expect(result.error).toContain("504");
  });
});
