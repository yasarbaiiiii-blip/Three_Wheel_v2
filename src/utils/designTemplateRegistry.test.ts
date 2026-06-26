import { describe, it, expect } from 'vitest';
import {
  TemplateRegistry,
  builtinTemplateId,
  snapshotTemplateId,
  computeGeometryFingerprint,
  createTemplateDefinition,
} from './designTemplateRegistry';
import type { PlanLine } from '../types/plan';

describe('designTemplateRegistry', () => {
  it('generates built-in template IDs deterministically', () => {
    const id1 = builtinTemplateId('shape', 'square', { size: 10, option: 'arc' });
    const id2 = builtinTemplateId('shape', 'square', { option: 'arc', size: 10 });
    expect(id1).toBe(id2);
    expect(id1).toContain('shape:square:v1');
    expect(id1).toContain('size=10.000');
  });

  it('computes stable geometry fingerprints regardless of segment ordering', () => {
    const line1: PlanLine = {
      id: '1',
      label: 'L1',
      layer: 'marking',
      from: { id: 1, x: 0, y: 0 },
      to: { id: 2, x: 5, y: 5 },
      width: 0.1,
    };
    const line2: PlanLine = {
      id: '2',
      label: 'L2',
      layer: 'marking',
      from: { id: 3, x: 5, y: 5 },
      to: { id: 4, x: 10, y: 10 },
      width: 0.1,
    };

    const fp1 = computeGeometryFingerprint([line1, line2]);
    const fp2 = computeGeometryFingerprint([line2, line1]);
    expect(fp1).toBe(fp2);

    const snapshotId1 = snapshotTemplateId([line1, line2]);
    expect(snapshotId1).toContain('snapshot:fp:');
  });

  it('registers and retrieves templates correctly', () => {
    const registry = new TemplateRegistry();
    const lines: PlanLine[] = [
      {
        id: '1',
        label: 'L1',
        layer: 'marking',
        from: { id: 1, x: 0, y: 0 },
        to: { id: 2, x: 1, y: 1 },
        width: 0.1,
      },
    ];

    const def = createTemplateDefinition('test-temp', lines, 1.0, 1.0);
    expect(def.bbox.minNorthM).toBe(0);
    expect(def.bbox.maxEastM).toBe(1);

    registry.registerTemplate(def);
    expect(registry.hasTemplate('test-temp')).toBe(true);
    expect(registry.getTemplate('test-temp')).toEqual(def);
    expect(registry.getAllIds()).toEqual(['test-temp']);
    expect(registry.size).toBe(1);

    // Re-registration should be a no-op
    registry.registerTemplate(def);
    expect(registry.size).toBe(1);
  });
});
