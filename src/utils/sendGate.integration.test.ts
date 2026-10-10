/**
 * Send → "is it safe to load?" gate, against a fake rover.
 *
 * The app builds runs (with extensions), POSTs them, and the rover answers with the
 * densified mission plus a run_echo. Load must stay blocked unless that echo matches what
 * was sent — otherwise the rover could be driven on a mission that is not the drawing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLocalDxf } from "./dxfLocalImport";
import { DXF_EXTENSION_CONFIG, normalizeCsvExtensionConfig } from "./missionExtensions";
import {
  chainMarkLinesByGeometry,
  defaultPathOrder,
  resolveOrderedPaintedLines,
  selectMarkPlanLines,
} from "./missionPathOrder";
import { planAndStageAppTrajectory } from "./missionStaging";
import { buildTrajectory, trajectoryRunLengthM, trajectoryTotals } from "./missionTrajectory";

const DXF =
  "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
  "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n6\n21\n0\n" +
  "0\nLINE\n8\n0\n10\n0\n20\n2\n11\n6\n21\n2\n" +
  "0\nENDSEC\n0\nEOF\n";

function runs() {
  const parsed = parseLocalDxf(DXF, "t.dxf");
  const marks = selectMarkPlanLines(chainMarkLinesByGeometry(parsed.lines));
  const painted = resolveOrderedPaintedLines(marks, defaultPathOrder(marks));
  return buildTrajectory(painted, {
    markSpeedMs: 0.35,
    travelSpeedMs: 0.5,
    extensions: normalizeCsvExtensionConfig({ ...DXF_EXTENSION_CONFIG, enabled: true }),
    includeEntryTransit: false,
  }).runs;
}

/** What an honest rover returns: same runs, densified (more points), same lengths. */
function honestPlan(sent: ReturnType<typeof runs>, tweak?: (p: Record<string, any>) => void) {
  const totals = trajectoryTotals(sent);
  const plan: Record<string, any> = {
    mission_id: "m-123",
    run_echo: sent.map((r, i) => ({
      index: i,
      kind: r.kind,
      num_points: r.points.length * 10,
      length_m: trajectoryRunLengthM(r),
    })),
    mark_length_m: totals.markLengthM,
    transit_length_m: totals.travelLengthM,
    total_length_m: totals.markLengthM + totals.travelLengthM,
    warnings: [],
  };
  tweak?.(plan);
  return plan;
}

function fakeRover(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
  );
}

const stage = (sent: ReturnType<typeof runs>) =>
  planAndStageAppTrajectory("http://rover.local:5001", {
    missionName: "t",
    originGps: [13.0, 80.0],
    runs: sent,
    skipStagedInspect: true,
  });

afterEach(() => vi.unstubAllGlobals());

describe("Send gate (extensions on, two lines)", () => {
  it("sent runs include the run-in/run-out and two painted passes", () => {
    const sent = runs();
    expect(sent[0].label).toBe("pre-ext");
    expect(sent[sent.length - 1].label).toBe("aft-ext");
    expect(sent.filter((r) => r.kind === "mark")).toHaveLength(2);
  });

  it("an honest rover echo passes → mission staged, Load allowed", async () => {
    const sent = runs();
    fakeRover(honestPlan(sent));
    const r = await stage(sent);
    expect(r.success).toBe(true);
    expect(r.missionId).toBe("m-123");
    expect(r.echoVerification?.ok).toBe(true);
  });

  it("a backend-generated terminal run-out does not block a legitimate mission", async () => {
    const sent = runs();
    fakeRover(
      honestPlan(sent, (p) => {
        p.run_echo.push({ index: sent.length, kind: "travel", num_points: 3, length_m: 0.1, generated: true });
        p.transit_length_m += 0.1;
        p.total_length_m += 0.1;
      })
    );
    expect((await stage(sent)).success).toBe(true);
  });

  it("rover dropped the run-out → BLOCKED before Load", async () => {
    const sent = runs();
    fakeRover(
      honestPlan(sent, (p) => {
        p.run_echo.pop();
      })
    );
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("verifyEcho");
    expect(r.error).toMatch(/Load blocked/i);
  });

  it("rover turned a travel run into a paint run → BLOCKED", async () => {
    const sent = runs();
    fakeRover(
      honestPlan(sent, (p) => {
        p.run_echo[0].kind = "mark";
      })
    );
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("verifyEcho");
  });

  it("rover truncated a painted run by 10% → BLOCKED", async () => {
    const sent = runs();
    fakeRover(
      honestPlan(sent, (p) => {
        const i = p.run_echo.findIndex((e: any) => e.kind === "mark");
        p.run_echo[i].length_m *= 0.9;
        p.mark_length_m *= 0.95;
      })
    );
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("verifyEcho");
  });

  it("response without run_echo cannot be verified → BLOCKED", async () => {
    const sent = runs();
    fakeRover(
      honestPlan(sent, (p) => {
        delete p.run_echo;
      })
    );
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("verifyEcho");
  });

  it("rover error (500) → clear failure, nothing staged", async () => {
    const sent = runs();
    fakeRover({ detail: "planner exploded" }, 500);
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("planTrajectory");
    expect(r.missionId).toBeUndefined();
  });

  it("no network → failure result, never an exception", async () => {
    const sent = runs();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Network request failed"))));
    const r = await stage(sent);
    expect(r.success).toBe(false);
    expect(r.failedStep).toBe("planTrajectory");
  });

  it("reply with no mission id → failure, nothing to load", async () => {
    const sent = runs();
    fakeRover(honestPlan(sent, (p) => delete p.mission_id));
    const r = await stage(sent);
    expect(r.success).toBe(false);
  });

  it("nothing to send → refuses without calling the rover", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await stage([]);
    expect(r.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
