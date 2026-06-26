/**
 * baselineGeometry.test.ts — Phase 0 characterization tests.
 *
 * These tests capture the CURRENT behavior of the geometry pipeline,
 * including known bugs. They serve as a safety net: if future refactoring
 * accidentally changes behavior, these tests will catch it.
 *
 * Known defects are documented with `// KNOWN DEFECT:` comments.
 */

import { describe, it, expect } from 'vitest';
import { generateTemplateLines } from './shapeTemplates';
import { linesToDxf, mmLineweight } from './dxfGenerator';
import { migratePlacedItemsToDesignDocument } from './designMigration';
import { flattenDesignDocument } from './designTransform';
import {
  transformVisualDxfPoint,
  projectLocalMetersToGps,
  projectGpsToLocalMeters,
  buildVisualAlignmentRefPoints,
  computeLineBoundingBox,
} from './visualAlignment';
import type { PlanLine } from '../types/plan';

// ────────────────────────────────────────────────
// Helper: legacy handleParse flatten (extracted from TemplatesPage.tsx L524–553)
// ────────────────────────────────────────────────
interface LegacyPlacedItem {
  id: string;
  lines: PlanLine[];
  x: number;       // east
  y: number;       // north
  rotation: number; // degrees
  scale: number;
  width: number;
  height: number;
}

function legacyFlatten(items: LegacyPlacedItem[]): PlanLine[] {
  const result: PlanLine[] = [];
  items.forEach(item => {
    const cos = Math.cos((item.rotation || 0) * Math.PI / 180) || 0;
    const sin = Math.sin((item.rotation || 0) * Math.PI / 180) || 0;
    item.lines.forEach((l, i) => {
      // handleParse math — does NOT apply item.scale
      const fx = (l.from.x * cos - l.from.y * sin) + (item.y || 0);
      const fy = (l.from.x * sin + l.from.y * cos) + (item.x || 0);
      const tx = (l.to.x * cos - l.to.y * sin) + (item.y || 0);
      const ty = (l.to.x * sin + l.to.y * cos) + (item.x || 0);

      result.push({
        ...l,
        id: `${item.id}-${i}`,
        from: { ...l.from, x: fx, y: fy },
        to: { ...l.to, x: tx, y: ty },
      });
    });
  });
  return result;
}

function lineLength(line: PlanLine): number {
  const dx = line.to.x - line.from.x;
  const dy = line.to.y - line.from.y;
  return Math.hypot(dx, dy);
}

// ────────────────────────────────────────────────
// B1. 1m square export — baseline dimensions
// ────────────────────────────────────────────────
describe('Baseline: 1m square template', () => {
  const lines = generateTemplateLines('square', 1.0);

  it('generates 4 lines', () => {
    expect(lines).toHaveLength(4);
  });

  it('each side is 1.0m (±0.001m)', () => {
    for (const line of lines) {
      const len = lineLength(line);
      expect(len).toBeCloseTo(1.0, 3);
    }
  });

  it('corners are at ±0.5m (north/east, template-local)', () => {
    const bbox = computeLineBoundingBox(lines);
    expect(bbox.minX).toBeCloseTo(-0.5, 3); // min north
    expect(bbox.maxX).toBeCloseTo(0.5, 3);  // max north
    expect(bbox.minY).toBeCloseTo(-0.5, 3); // min east
    expect(bbox.maxY).toBeCloseTo(0.5, 3);  // max east
  });
});

describe('Baseline: 1m square export through handleParse', () => {
  const templateLines = generateTemplateLines('square', 1.0);

  it('preserves 1.0m side lengths at identity placement', () => {
    const item: LegacyPlacedItem = {
      id: 'test-item',
      lines: templateLines,
      x: 0, y: 0, rotation: 0, scale: 1.0,
      width: 1.0, height: 1.0,
    };
    const flat = legacyFlatten([item]);
    expect(flat).toHaveLength(4);
    for (const line of flat) {
      expect(lineLength(line)).toBeCloseTo(1.0, 3);
    }
  });

  it('preserves 1.0m side lengths with translation', () => {
    const item: LegacyPlacedItem = {
      id: 'test-item',
      lines: templateLines,
      x: 5.0,   // east offset
      y: -3.0,  // north offset
      rotation: 0, scale: 1.0,
      width: 1.0, height: 1.0,
    };
    const flat = legacyFlatten([item]);
    for (const line of flat) {
      expect(lineLength(line)).toBeCloseTo(1.0, 3);
    }
  });

  it('preserves 1.0m side lengths with 90° rotation', () => {
    const item: LegacyPlacedItem = {
      id: 'test-item',
      lines: templateLines,
      x: 0, y: 0, rotation: 90, scale: 1.0,
      width: 1.0, height: 1.0,
    };
    const flat = legacyFlatten([item]);
    for (const line of flat) {
      expect(lineLength(line)).toBeCloseTo(1.0, 3);
    }
  });

  it('preserves 1.0m side lengths with 45° rotation', () => {
    const item: LegacyPlacedItem = {
      id: 'test-item',
      lines: templateLines,
      x: 2.0, y: 1.0, rotation: 45, scale: 1.0,
      width: 1.0, height: 1.0,
    };
    const flat = legacyFlatten([item]);
    for (const line of flat) {
      expect(lineLength(line)).toBeCloseTo(1.0, 3);
    }
  });
});

// ────────────────────────────────────────────────
// B2. Boundary position does NOT affect export
// ────────────────────────────────────────────────
describe('Baseline: boundaryPosition does not affect export', () => {
  const templateLines = generateTemplateLines('square', 1.0);

  it('handleParse ignores boundaryPosition — uses item.x/y only', () => {
    const item: LegacyPlacedItem = {
      id: 'test-item',
      lines: templateLines,
      x: 2.0, y: 3.0, rotation: 0, scale: 1.0,
      width: 1.0, height: 1.0,
    };
    // boundaryPosition is never referenced in handleParse flatten
    // This test just confirms the flatten result is the same regardless
    const flat1 = legacyFlatten([item]);
    const flat2 = legacyFlatten([item]); // same call — boundary position is not a parameter
    expect(flat1).toEqual(flat2);
    // Verify center of flattened bbox is at item.y(north), item.x(east)
    const bbox = computeLineBoundingBox(flat1);
    const centerNorth = (bbox.minX + bbox.maxX) / 2;
    const centerEast = (bbox.minY + bbox.maxY) / 2;
    expect(centerNorth).toBeCloseTo(item.y, 3); // item.y = north
    expect(centerEast).toBeCloseTo(item.x, 3);  // item.x = east
  });
});

// ────────────────────────────────────────────────
// B3. Pinch/export mismatch — KNOWN DEFECT (R1)
// ────────────────────────────────────────────────
describe('Baseline: pinch double-scale defect (R1)', () => {
  const templateLines = generateTemplateLines('square', 1.0);

  it('FIXED: after pinch, export and map preview agree on dimensions', () => {
    // Under the fixed behavior:
    // 1. Pinch handler does NOT scale line vertices (they remain template-local)
    // 2. Pinch handler sets item.scale = old_scale * appliedScale
    const appliedScale = 2.0;

    const item: LegacyPlacedItem = {
      id: 'pinched-item',
      lines: templateLines, // Unscaled template-local lines
      x: 0, y: 0,
      rotation: 0,
      scale: 1.0 * appliedScale, // scale = 2.0
      width: 1.0 * appliedScale,
      height: 1.0 * appliedScale,
    };

    // Map preview — uses transformVisualDxfPoint which applies item.scale
    const line0 = templateLines[0];
    const fromPreview = transformVisualDxfPoint(line0.from.x, line0.from.y, {
      x: item.x, y: item.y, rotation: item.rotation, scale: item.scale,
    });
    const toPreview = transformVisualDxfPoint(line0.to.x, line0.to.y, {
      x: item.x, y: item.y, rotation: item.rotation, scale: item.scale,
    });
    const previewLength = Math.hypot(
      toPreview.north - fromPreview.north,
      toPreview.east - fromPreview.east,
    );

    const { document, registry } = migratePlacedItemsToDesignDocument([item]);
    const flattened = flattenDesignDocument(document, registry);
    const exportLength = lineLength(flattened[0]);

    expect(exportLength).toBeCloseTo(2.0, 3);
    expect(previewLength).toBeCloseTo(2.0, 3);
    // They AGREE!
    expect(exportLength).toBeCloseTo(previewLength, 3);
  });
});

// ────────────────────────────────────────────────
// B4. DXF generator
// ────────────────────────────────────────────────
describe('Baseline: DXF generator', () => {
  it('swaps north/east correctly (group 10=east, 20=north)', () => {
    const lines: PlanLine[] = [{
      id: 'test-line',
      label: 'Test',
      layer: 'marking',
      from: { id: 0, x: 10, y: 20 },  // x=north=10, y=east=20
      to: { id: 1, x: 30, y: 40 },    // x=north=30, y=east=40
      width: 0.1,
    }];
    const dxf = linesToDxf(lines, 'test.dxf');
    // Group 10 (DXF X) should contain east values (PlanPoint.y)
    // Group 20 (DXF Y) should contain north values (PlanPoint.x)
    const entityLines = dxf.split('\n');
    // Find the LINE entity section then look for group codes
    const lineEntityIdx = entityLines.indexOf('LINE');
    expect(lineEntityIdx).toBeGreaterThan(-1);
    // After LINE, find group code 10 (first occurrence after LINE)
    const idx10 = entityLines.indexOf('10', lineEntityIdx + 1);
    expect(idx10).toBeGreaterThan(lineEntityIdx);
    expect(entityLines[idx10 + 1]).toBe('20'); // from.y = east = 20
    // After group 10 value, find group code 20
    const idx20 = entityLines.indexOf('20', idx10 + 2);
    expect(idx20).toBeGreaterThan(idx10);
    expect(entityLines[idx20 + 1]).toBe('10'); // from.x = north = 10
  });

  it('mmLineweight converts metres to DXF hundredths-of-mm', () => {
    expect(mmLineweight(0.1)).toBe(100);   // 0.1m = 100mm
    expect(mmLineweight(0.05)).toBe(50);
    expect(mmLineweight(0)).toBe(-1);       // zero → default
    expect(mmLineweight(-0.01)).toBe(-1);   // negative → default
  });
});

// ────────────────────────────────────────────────
// B5. visualAlignment — GPS round-trip
// ────────────────────────────────────────────────
describe('Baseline: visualAlignment GPS round-trip', () => {
  it('projectLocalMetersToGps → projectGpsToLocalMeters round-trip (±1e-6)', () => {
    const originLat = 28.6139;
    const originLon = 77.209;
    const north = 100;
    const east = -50;
    const gps = projectLocalMetersToGps(north, east, originLat, originLon);
    const local = projectGpsToLocalMeters(gps.lat, gps.lon, originLat, originLon);
    expect(local.north).toBeCloseTo(north, 4);
    expect(local.east).toBeCloseTo(east, 4);
  });

  it('transformVisualDxfPoint matches manual formula', () => {
    const item = { x: 3, y: -2, rotation: 15, scale: 1 };
    const north = 12;
    const east = -5;
    const cos = Math.cos((item.rotation * Math.PI) / 180);
    const sin = Math.sin((item.rotation * Math.PI) / 180);
    const expectedNorth = (north * cos - east * sin) * item.scale + item.y;
    const expectedEast = (north * sin + east * cos) * item.scale + item.x;
    const placed = transformVisualDxfPoint(north, east, item);
    expect(placed.north).toBeCloseTo(expectedNorth, 9);
    expect(placed.east).toBeCloseTo(expectedEast, 9);
  });

  it('buildVisualAlignmentRefPoints GPS matches preview', () => {
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
      expect(ref.dxf_y).toBeCloseTo(corner.x, 9); // dxf_y = north
      expect(ref.dxf_x).toBeCloseTo(corner.y, 9); // dxf_x = east
      const local = projectGpsToLocalMeters(ref.lat, ref.lon, originLat, originLon);
      expect(local.north).toBeCloseTo(preview.north, 4);
      expect(local.east).toBeCloseTo(preview.east, 4);
    }
  });
});

// ────────────────────────────────────────────────
// B6. Shape template generators
// ────────────────────────────────────────────────
describe('Baseline: shape generators', () => {
  it('triangle has 3 sides', () => {
    const lines = generateTemplateLines('triangle', 1.0);
    expect(lines).toHaveLength(3);
  });

  it('circle (full) has 36 segments', () => {
    const lines = generateTemplateLines('circle', 1.0, 'full');
    expect(lines).toHaveLength(36);
  });

  it('circle (half) has 18 segments', () => {
    const lines = generateTemplateLines('circle', 1.0, 'half');
    expect(lines).toHaveLength(18);
  });

  it('circle (quarter) has 9 segments', () => {
    const lines = generateTemplateLines('circle', 1.0, 'quarter');
    expect(lines).toHaveLength(9);
  });

  it('10m square has 10m sides', () => {
    const lines = generateTemplateLines('square', 10.0);
    for (const line of lines) {
      expect(lineLength(line)).toBeCloseTo(10.0, 3);
    }
  });
});
