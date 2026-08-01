import { describe, expect, it } from "vitest";

import { isSprayActive, parseGateSource, readSprayGate } from "./sprayGateNotice";

// The exact shape the deployed spray node emits, read off /spray/status on the
// live rover 2026-08-01 — not invented.
const LIVE_BLOCKED = {
  schema_version: 1,
  mode: "continuous",
  fsm_state: "OFF_CONFIRMED",
  spraying: false,
  desired: false,
  manual_active: false,
  safety_ok: false,
  safety_reason: "not OFFBOARD",
  distance_to_boundary_m: null,
  gps_fix_ok: false,
  gps_fix_name: "RTK_FLOAT",
  xtrack_error_m: null,
};

describe("readSprayGate", () => {
  it("passes the node's reason through verbatim, including the source suffix", () => {
    // The suffix is the operator's only clue about WHICH limit refused, so the
    // assertion is on the whole untouched string.
    const reason = "xtrack error 0.062m gate trip>0.080m clear<=0.050m (mission)";
    const g = readSprayGate({ safety_ok: false, safety_reason: reason, xtrack_error_m: 0.062 });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe(reason);
    expect(g.source).toBe("mission");
    expect(g.xtrackErrorM).toBe(0.062);
  });

  it("reads a param-sourced gate", () => {
    const g = readSprayGate({
      safety_ok: false,
      safety_reason: "xtrack error 0.031m gate trip>0.080m clear<=0.050m (param)",
    });
    expect(g.source).toBe("param");
  });

  it("handles the live payload (non-xtrack gate, no source marker)", () => {
    const g = readSprayGate(LIVE_BLOCKED);
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("not OFFBOARD");
    expect(g.source).toBeNull();
    expect(g.xtrackErrorM).toBeNull();
  });

  it("a happy gate is not blocked and shows nothing", () => {
    const g = readSprayGate({ safety_ok: true, safety_reason: "" });
    expect(g.blocked).toBe(false);
    expect(g.unknown).toBe(false);
    expect(g.reason).toBeNull();
  });

  it("suppresses a stale reason string when the gate reports OK", () => {
    const g = readSprayGate({ safety_ok: true, safety_reason: "xtrack error 0.9m (param)" });
    expect(g.blocked).toBe(false);
    expect(g.reason).toBeNull();
  });

  it("a silent spray node is UNKNOWN, never 'gate OK'", () => {
    // The regression this guards: defaulting a missing field to true renders a
    // confident green "gate OK" for a node that has never spoken.
    for (const data of [{}, { safety_ok: null }, { safety_ok: undefined }, null, undefined]) {
      const g = readSprayGate(data as never);
      expect(g.unknown).toBe(true);
      expect(g.blocked).toBe(false);
    }
  });

  it("treats a non-boolean safety_ok as unknown rather than truthy", () => {
    // "false" (string) is truthy in JS — the exact trap this avoids.
    expect(readSprayGate({ safety_ok: "false" as never }).unknown).toBe(true);
    expect(readSprayGate({ safety_ok: 1 as never }).unknown).toBe(true);
  });

  it("keeps the reason visible while the node is silent, if one was sent", () => {
    const g = readSprayGate({ safety_reason: "not OFFBOARD" });
    expect(g.unknown).toBe(true);
    expect(g.reason).toBe("not OFFBOARD");
  });

  it("ignores a non-finite xtrack error", () => {
    expect(readSprayGate({ safety_ok: false, xtrack_error_m: NaN }).xtrackErrorM).toBeNull();
    expect(readSprayGate({ safety_ok: false, xtrack_error_m: "0.05" as never }).xtrackErrorM).toBeNull();
  });
});

describe("parseGateSource", () => {
  it("only matches the trailing marker", () => {
    expect(parseGateSource("gate (mission) something else")).toBeNull();
    expect(parseGateSource("gate (param)")).toBe("param");
    expect(parseGateSource("gate (PARAM) ")).toBe("param");
    expect(parseGateSource(null)).toBeNull();
    expect(parseGateSource("no marker at all")).toBeNull();
  });
});

describe("isSprayActive", () => {
  it("matches the previous inline rule", () => {
    expect(isSprayActive({ spraying: true })).toBe(true);
    expect(isSprayActive({ manual_override: true } as never)).toBe(true);
    expect(isSprayActive({ spray_active_desired: true } as never)).toBe(true);
    expect(isSprayActive({ spraying: false })).toBe(false);
    expect(isSprayActive(null)).toBe(false);
  });
});
