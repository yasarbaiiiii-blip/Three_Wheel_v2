import assert from "node:assert/strict";
import test from "node:test";

import {
  anchorToAlignedRefPoints,
  stagedMissionMatchesId,
  waypointsToPlanLines,
} from "./stagedMissionHydration.ts";

test("stagedMissionMatchesId requires exact mission_id", () => {
  assert.equal(
    stagedMissionMatchesId({ mission_id: "stg_abc_123" }, "stg_abc_123"),
    true
  );
  assert.equal(
    stagedMissionMatchesId({ mission_id: "stg_old" }, "stg_new"),
    false
  );
  assert.equal(stagedMissionMatchesId(null, "stg_abc_123"), false);
});

test("waypointsToPlanLines maps spray flags to marking and transit layers", () => {
  const lines = waypointsToPlanLines(
    [
      [0, 0],
      [2, 0],
      [2, 2],
    ],
    [true, false]
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].layer, "marking");
  assert.equal(lines[0].from.x, 0);
  assert.equal(lines[0].from.y, 0);
  assert.equal(lines[0].to.x, 2);
  assert.equal(lines[0].to.y, 0);
  assert.equal(lines[1].layer, "transit");
  assert.equal(lines[1].to.x, 2);
  assert.equal(lines[1].to.y, 2);
});

test("waypointsToPlanLines skips invalid coordinate pairs", () => {
  const lines = waypointsToPlanLines([[0, 0], ["bad", 1], [1, 1]], [true, true, true]);
  assert.equal(lines.length, 0);
});

test("anchorToAlignedRefPoints exposes GPS anchor at local NED origin", () => {
  assert.deepEqual(
    anchorToAlignedRefPoints({ lat: 37.7749, lon: -122.4194, rotation_deg: 12 }),
    [{ dxf_x: 0, dxf_y: 0, lat: 37.7749, lon: -122.4194 }]
  );
  assert.deepEqual(anchorToAlignedRefPoints(null), []);
  assert.deepEqual(anchorToAlignedRefPoints({ lat: "n/a", lon: 1 }), []);
});

test("re-staged same filename still keys on mission_id not source name", () => {
  const first = waypointsToPlanLines([[0, 0], [1, 0]], [true]);
  const second = waypointsToPlanLines([[5, 5], [6, 5]], [true]);
  assert.notDeepEqual(first, second);
  assert.equal(stagedMissionMatchesId({ mission_id: "stg_new" }, "stg_new"), true);
  assert.equal(stagedMissionMatchesId({ mission_id: "stg_old" }, "stg_new"), false);
});