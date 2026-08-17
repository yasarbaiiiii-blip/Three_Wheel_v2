import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advancedParams,
  baselineValue,
  buildDialTicks,
  buildDirtyPayload,
  coerceParamValue,
  coerceTypedValue,
  dialStepFor,
  dropSettledEdits,
  fieldParams,
  formatAppliedNames,
  formatParamValue,
  groupParams,
  interpretSetParamsResult,
  mergeAppliedCurrent,
  nearestTickIndex,
  normalizeControllerParams,
  paramLabel,
  paramUnit,
  setControllerParams,
  valuesEqual,
  type ControllerParam,
} from "./controllerParams";

function param(partial: Partial<ControllerParam> & Pick<ControllerParam, "name" | "type">): ControllerParam {
  return {
    default: null,
    current: null,
    group: "Test",
    description: "",
    min: null,
    max: null,
    ...partial,
  };
}

describe("controllerParams normalize + format", () => {
  it("reads the backend array contract and ignores junk", () => {
    const params = normalizeControllerParams({
      parameters: [
        { name: "mission_speed", type: "float", default: 1, current: 0.35, group: "Mission Control", description: "speed", min: 0, max: 2 },
        { name: 12 },
      ],
      count: 2,
    });
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe("mission_speed");
    expect(params[0].type).toBe("float");
    expect(params[0].current).toBe(0.35);
  });

  it("formats numbers without trailing float noise", () => {
    expect(formatParamValue(0.3)).toBe("0.3");
    expect(formatParamValue(true)).toBe("true");
    expect(formatParamValue(null)).toBe("");
  });
});

describe("controllerParams coerce + dirty payload", () => {
  it("coerces JSON integers to float when the schema is float", () => {
    const mission = param({ name: "mission_speed", type: "float", min: 0, max: 2 });
    expect(coerceTypedValue(1, mission)).toBe(1);
    expect(typeof coerceTypedValue(1, mission)).toBe("number");
    expect(coerceParamValue("0.35", mission)).toBe(0.35);
  });

  it("rejects out of range and bad types", () => {
    const speed = param({ name: "mission_speed", type: "float", min: 0, max: 2 });
    expect(() => coerceParamValue("9", speed)).toThrow(/at most 2/);
    expect(() => coerceParamValue("nope", speed)).toThrow(/must be a number/);
    expect(() => coerceParamValue("1.2", param({ name: "preview_curvature_n", type: "int", min: 1, max: 20 }))).toThrow(/integer/);
  });

  it("sends only dirty keys and keeps ROS float types", () => {
    const params = [
      param({ name: "mission_speed", type: "float", current: 1, min: 0, max: 2 }),
      param({ name: "require_rtk_fix", type: "bool", current: true }),
    ];
    const payload = buildDirtyPayload(params, { mission_speed: 0.35 });
    expect(payload).toEqual({ mission_speed: 0.35 });
    expect(valuesEqual(1, 1.0, "float")).toBe(true);
    expect(valuesEqual(true, "true", "bool")).toBe(true);
  });
});

describe("controllerParams apply result merge", () => {
  it("treats empty or ok PUT bodies as all accepted", () => {
    const payload = { mission_speed: 0.35, max_linear_vel: 1.2 };
    expect(interpretSetParamsResult(payload, null)).toEqual({
      ok: true,
      accepted: ["mission_speed", "max_linear_vel"],
      rejected: [],
    });
    expect(interpretSetParamsResult(payload, { ok: true })).toEqual({
      ok: true,
      accepted: ["mission_speed", "max_linear_vel"],
      rejected: [],
    });
  });

  it("splits per-name ROS results and keeps failed keys dirty", () => {
    const payload = { mission_speed: 0.35, max_linear_vel: 1.2 };
    expect(interpretSetParamsResult(payload, {
      ok: false,
      parameters: { mission_speed: true, max_linear_vel: false },
    })).toEqual({
      ok: false,
      accepted: ["mission_speed"],
      rejected: ["max_linear_vel"],
    });

    const params = [
      param({ name: "mission_speed", type: "float", current: 1 }),
      param({ name: "max_linear_vel", type: "float", current: 0.8 }),
    ];
    const merged = mergeAppliedCurrent(params, { mission_speed: 0.35 });
    expect(merged[0].current).toBe(0.35);
    expect(merged[1].current).toBe(0.8);

    const leftover = dropSettledEdits(
      { mission_speed: 0.35, max_linear_vel: 1.2 },
      payload,
      ["mission_speed"],
      new Map(params.map((item) => [item.name, item]))
    );
    expect(leftover).toEqual({ max_linear_vel: 1.2 });
  });

  it("keeps an edit if the user changed the value again during apply", () => {
    const speed = param({ name: "mission_speed", type: "float", current: 1 });
    const leftover = dropSettledEdits(
      { mission_speed: 0.5 },
      { mission_speed: 0.35 },
      ["mission_speed"],
      new Map([["mission_speed", speed]])
    );
    expect(leftover).toEqual({ mission_speed: 0.5 });
  });

  it("summarizes applied names for the status banner", () => {
    expect(formatAppliedNames(["mission_speed"])).toBe("Mission speed");
    expect(formatAppliedNames(["mission_speed", "max_linear_vel", "min_linear_vel", "xy_goal_tolerance"])).toBe(
      "Mission speed, Max speed +2 more"
    );
  });
});

describe("controllerParams setControllerParams", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns accepted keys from a 200 body and does not require a follow-up GET", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, parameters: { mission_speed: true } }), { status: 200 })
    ) as typeof fetch;

    const result = await setControllerParams("http://192.168.1.102:5001", "rpp", { mission_speed: 0.35 });
    expect(result).toEqual({ ok: true, accepted: ["mission_speed"], rejected: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("http://192.168.1.102:5001/api/rpp/params");
    expect((init as RequestInit).method).toBe("PUT");
  });

  it("treats an empty 200 body as success for the sent keys", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const result = await setControllerParams("http://192.168.1.102:5001", "spray", {
      solenoid_open_delay_s: 0.04,
    });
    expect(result).toEqual({ ok: true, accepted: ["solenoid_open_delay_s"], rejected: [] });
  });

  it("times out a hung rover write", async () => {
    globalThis.fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    ) as typeof fetch;

    await expect(
      setControllerParams("http://192.168.1.102:5001", "rpp", { mission_speed: 0.35 }, 20)
    ).rejects.toThrow(/did not respond in time/);
  });
});

describe("controllerParams dials + grouping", () => {
  it("keeps float dials under 201 ticks and includes the live value", () => {
    const speed = param({ name: "mission_speed", type: "float", current: 0.37, min: 0, max: 2 });
    const ticks = buildDialTicks(speed, 0.37);
    expect(ticks.length).toBeGreaterThan(10);
    expect(ticks.length).toBeLessThanOrEqual(201);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(2);
    expect(ticks[nearestTickIndex(ticks, 0.37)]).toBeCloseTo(0.37, 2);
    expect(dialStepFor(speed, 0, 2)).toBe(0.02);
  });

  it("splits field vs advanced and groups the rest", () => {
    const params = [
      param({ name: "mission_speed", type: "float", group: "Mission Control" }),
      param({ name: "a_lat_max", type: "float", group: "Curvature Regulation" }),
      param({ name: "solenoid_open_delay_s", type: "float", group: "Distance-Aware Spray" }),
    ];
    expect(fieldParams(params, "rpp").map((item) => item.name)).toEqual(["mission_speed"]);
    expect(advancedParams(params, "rpp").map((item) => item.name)).toEqual(["a_lat_max", "solenoid_open_delay_s"]);
    expect(groupParams(params).map((item) => item.group)).toEqual([
      "Mission Control",
      "Curvature Regulation",
      "Distance-Aware Spray",
    ]);
  });

  it("labels units and uses current over default", () => {
    expect(paramLabel("mission_speed")).toBe("Mission speed");
    expect(paramUnit("solenoid_open_delay_s")).toBe("s");
    expect(paramUnit("nozzle_forward_offset_m")).toBe("m");
    expect(
      baselineValue(param({ name: "mission_speed", type: "float", default: 1, current: 0.35 }))
    ).toBe(0.35);
  });
});
