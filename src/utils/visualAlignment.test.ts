import {
  buildVisualAlignmentRefPoints,
  projectGpsToLocalMeters,
  transformVisualDxfPoint,
} from "./visualAlignment";

function assertClose(actual: number, expected: number, tol = 1e-9, label = "") {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

function testPreviewMatchesMapViewFormula() {
  const item = { x: 3, y: -2, rotation: 15, scale: 1 };
  const north = 12;
  const east = -5;
  const cos = Math.cos((item.rotation * Math.PI) / 180);
  const sin = Math.sin((item.rotation * Math.PI) / 180);
  const expectedNorth = (north * cos - east * sin) * item.scale + item.y;
  const expectedEast = (north * sin + east * cos) * item.scale + item.x;
  const placed = transformVisualDxfPoint(north, east, item);
  assertClose(placed.north, expectedNorth, 1e-12, "north");
  assertClose(placed.east, expectedEast, 1e-12, "east");
}

function testNonCentredPlanConfirmationMatchesPreview() {
  const item = { x: 4.5, y: -1.25, rotation: 30, scale: 1 };
  const corners = [
    { x: 10, y: 20 },
    { x: 40, y: 20 },
    { x: 40, y: 50 },
    { x: 10, y: 50 },
  ];
  const originLat = 28.6139;
  const originLon = 77.209;

  for (const corner of corners) {
    const preview = transformVisualDxfPoint(corner.x, corner.y, item);
    const refs = buildVisualAlignmentRefPoints([corner], item, originLat, originLon);
    const ref = refs[0];
    assertClose(ref.dxf_y, corner.x, 1e-12, "dxf_y/north");
    assertClose(ref.dxf_x, corner.y, 1e-12, "dxf_x/east");
    const local = projectGpsToLocalMeters(ref.lat, ref.lon, originLat, originLon);
    assertClose(local.north, preview.north, 1e-6, "gps north");
    assertClose(local.east, preview.east, 1e-6, "gps east");
  }
}

function testBackendRefIntegrityAllCorners() {
  const item = { x: -2, y: 6, rotation: -12, scale: 1 };
  const corners = [
    { x: -8, y: 3 },
    { x: 15, y: 3 },
    { x: 15, y: 22 },
    { x: -8, y: 22 },
  ];
  const originLat = 12.9716;
  const originLon = 77.5946;
  const refs = buildVisualAlignmentRefPoints(corners, item, originLat, originLon);
  if (refs.length !== 4) {
    throw new Error(`expected 4 ref points, got ${refs.length}`);
  }
  for (let i = 0; i < refs.length; i++) {
    const corner = corners[i];
    const ref = refs[i];
    const preview = transformVisualDxfPoint(corner.x, corner.y, item);
    const fromGps = projectGpsToLocalMeters(ref.lat, ref.lon, originLat, originLon);
    assertClose(fromGps.north, preview.north, 1e-6, `corner ${i} north`);
    assertClose(fromGps.east, preview.east, 1e-6, `corner ${i} east`);
  }
}

export function runVisualAlignmentTests() {
  testPreviewMatchesMapViewFormula();
  testNonCentredPlanConfirmationMatchesPreview();
  testBackendRefIntegrityAllCorners();
}

runVisualAlignmentTests();
console.log("visualAlignment tests passed");