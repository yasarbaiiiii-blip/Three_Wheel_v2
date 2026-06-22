import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMissionStartPayload,
  classifyMissionError,
  evaluateMissionStartGate,
  invalidateWorkflowFrom,
  isProtectedMissionResident,
  runningMissionMismatch,
  verifyStagedLoadedMission,
} from "./missionContract.ts";

const surveyed = {
  loaded: true,
  mission_id: "mission-42",
  state: "idle",
  num_waypoints: 3,
  num_mark: 2,
  num_transit: 1,
  has_spray_flags: true,
  sample_coords: [],
  sample_truncated: false,
  placement_mode: "GPS_SURVEYED",
  is_staged: true,
  protected: true,
};

test("staged start sends identity and false auto-origin without reload keys", () => {
  assert.deepEqual(
    buildMissionStartPayload({
      stagedMissionId: "mission-42",
      stagedVerified: true,
      fileName: "field.dxf",
      autoOrigin: true,
    }),
    { mission_id: "mission-42", auto_origin: false }
  );
});

test("legacy start preserves filename behavior", () => {
  assert.deepEqual(
    buildMissionStartPayload({
      stagedMissionId: null,
      stagedVerified: false,
      fileName: "field.dxf",
      autoOrigin: true,
    }),
    { path_name: "field.dxf", mission_file: "", auto_origin: true }
  );
});

test("loaded ID mismatch blocks staged start", () => {
  const gate = evaluateMissionStartGate({
    stagedVerified: true,
    loadedVerified: true,
    stagedMissionId: "mission-99",
    loaded: surveyed,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.message, /mission-99.*mission-42/);
});

test("GPS surveyed metadata requires staged protected identity", () => {
  assert.equal(verifyStagedLoadedMission(surveyed, "mission-42").verified, true);
  assert.equal(
    verifyStagedLoadedMission({ ...surveyed, protected: false }, "mission-42").verified,
    false
  );
});

test("protected resident blocks legacy start", () => {
  assert.equal(isProtectedMissionResident(surveyed), true);
  assert.equal(
    evaluateMissionStartGate({
      stagedVerified: false,
      loadedVerified: false,
      stagedMissionId: null,
      loaded: surveyed,
    }).allowed,
    false
  );
});

test("409 and 422 produce distinct user-facing contracts", () => {
  assert.equal(classifyMissionError(409, "identity mismatch").kind, "conflict");
  assert.equal(classifyMissionError(422, "GPS stale").kind, "placement");
  assert.notEqual(classifyMissionError(409, "x").title, classifyMissionError(422, "x").title);
});

test("backend replacement invalidates staged verification", () => {
  const replaced = { ...surveyed, mission_id: "mission-replaced" };
  assert.equal(verifyStagedLoadedMission(replaced, "mission-42").verified, false);
});

test("running identity mismatch is surfaced", () => {
  assert.match(runningMissionMismatch("mission-42", "mission-99"), /does not match/);
  assert.equal(runningMissionMismatch("mission-42", "mission-42"), null);
});

test("local mission is not protected by an stg filename", () => {
  assert.equal(
    isProtectedMissionResident({ ...surveyed, mission_id: "stg_example.csv", placement_mode: "LOCAL_NED", is_staged: false, protected: false }),
    false
  );
});

test("upload or reparse invalidation clears all downstream verification", () => {
  const verified = {
    upload: "verified",
    alignment: "verified",
    spray: "verified",
    staged: "verified",
    loaded: "verified",
    started: "verified",
  };
  assert.deepEqual(invalidateWorkflowFrom(verified, "alignment"), {
    upload: "verified",
    alignment: "pending",
    spray: "pending",
    staged: "pending",
    loaded: "pending",
    started: "pending",
  });
});
