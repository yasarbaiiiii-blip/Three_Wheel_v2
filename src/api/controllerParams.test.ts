import { describe, expect, it } from "vitest";
import {
  advancedParams,
  baselineValue,
  buildDialTicks,
  buildDirtyPayload,
  coerceParamValue,
  coerceTypedValue,
  dialStepFor,
  fieldParams,
  formatParamValue,
  groupParams,
  nearestTickIndex,
  normalizeControllerParams,
  paramLabel,
  paramUnit,
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
