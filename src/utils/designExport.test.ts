import { describe, it, expect } from 'vitest';
import { linesToDxf } from './dxfGenerator';
import {
  createDesignDocument,
  createDesignInstance,
  createDesignVertex,
} from '../types/designDocument';
import { TemplateRegistry } from './designTemplateRegistry';
import { flattenDesignDocument } from './designTransform';

// Lightweight DXF parser specifically for the generated LINE format in our tests.
// This avoids importing planImport.ts which pulls in React Native / Expo modules.
function parseDxfLines(dxf: string): { from: { x: number; y: number }; to: { x: number; y: number }; layer: string }[] {
  const lines = dxf.split('\n').map(s => s.trim());
  const parsed: { from: { x: number; y: number }; to: { x: number; y: number }; layer: string }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'LINE') {
      let fromX = 0, fromY = 0, toX = 0, toY = 0;
      let layer = '';
      for (let j = i + 1; j < lines.length; j += 2) {
        if (lines[j] === '0') {
          break;
        }
        if (lines[j] === '8') {
          layer = lines[j + 1].toLowerCase();
        }
        if (lines[j] === '10') {
          fromY = parseFloat(lines[j + 1]); // DXF X (10) = East (y)
        }
        if (lines[j] === '20') {
          fromX = parseFloat(lines[j + 1]); // DXF Y (20) = North (x)
        }
        if (lines[j] === '11') {
          toY = parseFloat(lines[j + 1]);
        }
        if (lines[j] === '21') {
          toX = parseFloat(lines[j + 1]);
        }
      }
      parsed.push({
        from: { x: fromX, y: fromY }, // x = North, y = East in PlanPoint format
        to: { x: toX, y: toY },
        layer,
      });
    }
  }
  return parsed;
}

describe('DXF Export Round-trip Validation (Phase 5)', () => {
  it('should export design document lines to DXF and import them back with extreme precision (±0.001m)', () => {
    // 1. Setup a test template in the registry
    const registry = new TemplateRegistry();
    const squareTemplateId = 'shape:square:v1';
    
    // Create a 1m x 1m template-local square
    const squareLines = [
      { id: '1', label: '1', from: { id: 1, x: 0, y: 0 }, to: { id: 2, x: 1, y: 0 }, layer: 'marking' as const, width: 0.1 },
      { id: '2', label: '2', from: { id: 2, x: 1, y: 0 }, to: { id: 3, x: 1, y: 1 }, layer: 'marking' as const, width: 0.1 },
      { id: '3', label: '3', from: { id: 3, x: 1, y: 1 }, to: { id: 4, x: 0, y: 1 }, layer: 'marking' as const, width: 0.1 },
      { id: '4', label: '4', from: { id: 4, x: 0, y: 1 }, to: { id: 1, x: 0, y: 0 }, layer: 'marking' as const, width: 0.1 },
    ];
    
    registry.registerTemplate({
      templateId: squareTemplateId,
      lines: squareLines,
      nominalWidthM: 1.0,
      nominalHeightM: 1.0,
      bbox: { minNorthM: 0, maxNorthM: 1, minEastM: 0, maxEastM: 1 },
    });

    // 2. Build a design document containing a translated, rotated, and scaled instance
    const doc = createDesignDocument('test-doc');
    const instance = createDesignInstance(
      'instance-1',
      squareTemplateId,
      {
        northM: 10.0, // translation North
        eastM: 20.0,  // translation East
        rotationDeg: 90.0, // CCW rotation
        scale: 2.0, // 2x scale
      }
    );
    doc.nodes.push(instance);

    // 3. Flatten the design document to PlanLines
    const flattened = flattenDesignDocument(doc, registry);

    // 4. Export to DXF format
    const dxfString = linesToDxf(flattened, 'TestExport');

    // 5. Parse back the DXF string
    const importedLines = parseDxfLines(dxfString);

    expect(importedLines.length).toBe(flattened.length);

    // 6. Verify coordinates match flat lines within ±0.001m
    for (let i = 0; i < flattened.length; i++) {
      const orig = flattened[i];
      const imp = importedLines.find(l => l.layer === orig.layer && 
        Math.abs(l.from.x - orig.from.x) < 0.05 && 
        Math.abs(l.from.y - orig.from.y) < 0.05
      );
      
      expect(imp).toBeDefined();
      if (imp) {
        expect(Math.abs(imp.from.x - orig.from.x)).toBeLessThan(0.001); // North (x) parity
        expect(Math.abs(imp.from.y - orig.from.y)).toBeLessThan(0.001); // East (y) parity
        expect(Math.abs(imp.to.x - orig.to.x)).toBeLessThan(0.001);
        expect(Math.abs(imp.to.y - orig.to.y)).toBeLessThan(0.001);
      }
    }
  });
});
