import { describe, it, expect } from 'vitest';
import {
  migratePlacedItemsToDesignDocument,
  verifyMigrationParity,
} from './designMigration';
import type { PlacedItem } from '../components/BoundaryEditor';
import type { PlanLine } from '../types/plan';
import { flattenDesignDocument } from './designTransform';

describe('designMigration', () => {
  it('migrates a clean PlacedItem (Path A) and verifies parity', () => {
    // 1. Create a legacy PlacedItem with scale = 1.0 (clean)
    const lines: PlanLine[] = [
      {
        id: '1',
        label: 'Line 1',
        layer: 'marking',
        from: { id: 0, x: -1, y: -1 },
        to: { id: 1, x: 1, y: 1 },
        width: 0.1,
      },
    ];
    const legacyItem: PlacedItem = {
      id: 'legacy-1',
      lines,
      x: 10,
      y: 20,
      rotation: 0,
      scale: 1.0,
      width: 2.0,
      height: 2.0,
    };

    const { document, registry, warnings } = migratePlacedItemsToDesignDocument([legacyItem]);
    
    // There should be no warnings on clean instances
    expect(warnings).toHaveLength(0);
    expect(document.nodes).toHaveLength(1);
    expect(document.nodes[0].type).toBe('INSTANCE');

    // Run parity check
    const check = verifyMigrationParity([legacyItem], document, registry);
    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
    expect(check.maxDeltaM).toBeCloseTo(0, 5);
  });

  it('migrates a pre-scaled legacy PlacedItem (Path B) to world entities with warnings and preserves parity', () => {
    // 2. Create a legacy PlacedItem with scale = 2.0 and lines pre-scaled (Path B)
    // lines are already multiplied by scale (e.g. from -2 to 2)
    const lines: PlanLine[] = [
      {
        id: '1',
        label: 'Line 1',
        layer: 'marking',
        from: { id: 0, x: -2, y: -2 },
        to: { id: 1, x: 2, y: 2 },
        width: 0.1,
      },
    ];
    const legacyItem: PlacedItem = {
      id: 'legacy-2',
      lines,
      x: 5,
      y: 10,
      rotation: 45,
      scale: 2.0,
      width: 4.0, // scale is 2.0, width is 4.0
      height: 4.0,
    };

    const { document, registry, warnings } = migratePlacedItemsToDesignDocument([legacyItem]);

    // Path B should emit a warning
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('LEGACY_AMBIGUOUS_SCALE');
    expect(warnings[0].itemId).toBe('legacy-2');

    // It should yield multiple entities (1 line segment = 1 DesignEntity)
    expect(document.nodes).toHaveLength(1);
    expect(document.nodes[0].type).toBe('LINE');

    // Verify parity
    const check = verifyMigrationParity([legacyItem], document, registry);
    expect(check.ok).toBe(true);
    expect(check.errors).toHaveLength(0);
    expect(check.maxDeltaM).toBeCloseTo(0, 5);
  });
});
