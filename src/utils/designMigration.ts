/**
 * designMigration.ts — Phase 1 migration and parity verification.
 *
 * Implements:
 * - migratePlacedItemsToDesignDocument
 * - verifyMigrationParity
 */

import type { PlacedItem } from '../components/BoundaryEditor';
import {
  DesignDocument,
  DesignNode,
  DesignEntity,
  DesignInstance,
  DesignVertex,
  createDesignDocument,
  createDesignVertex,
  createDesignInstance,
  createDesignEntity,
} from '../types/designDocument';
import {
  TemplateRegistry,
  createTemplateDefinition,
  snapshotTemplateId,
} from './designTemplateRegistry';
import { flattenDesignDocument } from './designTransform';
import { validateDesignDocument } from './designValidation';
import type { PlanLine, PlanPoint } from '../types/plan';

export interface MigrationWarning {
  code: 'LEGACY_AMBIGUOUS_SCALE';
  itemId: string;
  message: string;
}

export interface MigrationResult {
  document: DesignDocument;
  registry: TemplateRegistry;
  warnings: MigrationWarning[];
}

/**
 * Migrates legacy PlacedItem[] state into the canonical DesignDocument
 * and registers any snapshot templates in the TemplateRegistry.
 *
 * Emits warnings for Path B items (ambiguous legacy pinch/scale).
 */
export function migratePlacedItemsToDesignDocument(
  placedItems: PlacedItem[],
): MigrationResult {
  const registry = new TemplateRegistry();
  const doc = createDesignDocument();
  const warnings: MigrationWarning[] = [];

  for (const item of placedItems) {
    const lines = item.lines;
    if (lines.length === 0) {
      continue;
    }

    // Compute template-local bounding box of lines
    let minN = Infinity, maxN = -Infinity;
    let minE = Infinity, maxE = -Infinity;
    for (const l of lines) {
      minN = Math.min(minN, l.from.x, l.to.x); // x = north
      maxN = Math.max(maxN, l.from.x, l.to.x);
      minE = Math.min(minE, l.from.y, l.to.y); // y = east
      maxE = Math.max(maxE, l.from.y, l.to.y);
    }
    const bboxWidth = maxE - minE;
    const bboxHeight = maxN - minN;

    let isPathA = false;
    let scaleToUse = 1.0;

    if (item.scale === 1.0) {
      isPathA = true;
      scaleToUse = 1.0;
    } else {
      // Heuristic: check if lines are template-local (unscaled) vs pre-scaled
      const scaleFactor = item.scale;
      const expectedTemplateWidth = item.width / scaleFactor;
      const expectedTemplateHeight = item.height / scaleFactor;

      const diffTemplateLocal = Math.abs(bboxWidth - expectedTemplateWidth) + Math.abs(bboxHeight - expectedTemplateHeight);
      const diffPreScaled = Math.abs(bboxWidth - item.width) + Math.abs(bboxHeight - item.height);

      if (diffTemplateLocal < 1e-2) {
        isPathA = true;
        scaleToUse = item.scale;
      } else if (diffPreScaled < 1e-2) {
        isPathA = false; // Pre-scaled / baked. Use Path B.
      } else {
        isPathA = false; // Fallback to Path B.
      }
    }

    if (isPathA) {
      // Path A: Clean instance
      // The template-local lines are represented by item.lines directly.
      const templateId = snapshotTemplateId(lines);
      if (!registry.hasTemplate(templateId)) {
        const def = createTemplateDefinition(
          templateId,
          lines,
          item.width / scaleToUse,
          item.height / scaleToUse,
        );
        registry.registerTemplate(def);
      }

      const instance = createDesignInstance(
        item.id,
        templateId,
        {
          northM: item.y, // item.y is north
          eastM: item.x,  // item.x is east
          rotationDeg: item.rotation,
          scale: scaleToUse,
        },
        {
          groupId: item.groupId,
          migration: 'clean_instance',
        },
      );
      doc.nodes.push(instance);
    } else {
      // Path B: Ambiguous legacy
      warnings.push({
        code: 'LEGACY_AMBIGUOUS_SCALE',
        itemId: item.id,
        message: `Item ${item.id} has baked pinch/scale. Migrating as legacy world entities.`,
      });

      // Flatten using legacy handleParse math
      const cos = Math.cos((item.rotation || 0) * Math.PI / 180) || 0;
      const sin = Math.sin((item.rotation || 0) * Math.PI / 180) || 0;

      lines.forEach((l, i) => {
        const fx = (l.from.x * cos - l.from.y * sin) + (item.y || 0); // x=north, y=east, item.y=north
        const fy = (l.from.x * sin + l.from.y * cos) + (item.x || 0); // item.x=east
        const tx = (l.to.x * cos - l.to.y * sin) + (item.y || 0);
        const ty = (l.to.x * sin + l.to.y * cos) + (item.x || 0);

        if (!isFinite(fx) || !isFinite(fy) || !isFinite(tx) || !isFinite(ty)) return;

        const entity = createDesignEntity(
          `${item.id}-line-${i}`,
          'LINE',
          l.layer || 'marking',
          [
            createDesignVertex(fx, fy),
            createDesignVertex(tx, ty),
          ],
          l.width || 0.1,
          {
            sourceItemId: item.id,
            groupId: item.groupId,
            migration: 'legacy_world_entity',
          },
        );
        doc.nodes.push(entity);
      });
    }
  }

  return { document: doc, registry, warnings };
}

/**
 * Geometric verification to ensure legacy flatten output matches new flatten output
 * within tolerance. Matches segment lengths and endpoint coordinates.
 */
export function verifyMigrationParity(
  placedItems: PlacedItem[],
  doc: DesignDocument,
  registry: TemplateRegistry,
  toleranceM = 0.001,
): { ok: boolean; maxDeltaM: number; errors: string[] } {
  // Legacy flatten output
  const legacyLines: PlanLine[] = [];
  placedItems.forEach(item => {
    const cos = Math.cos((item.rotation || 0) * Math.PI / 180) || 0;
    const sin = Math.sin((item.rotation || 0) * Math.PI / 180) || 0;
    item.lines.forEach((l, i) => {
      const fx = (l.from.x * cos - l.from.y * sin) + (item.y || 0);
      const fy = (l.from.x * sin + l.from.y * cos) + (item.x || 0);
      const tx = (l.to.x * cos - l.to.y * sin) + (item.y || 0);
      const ty = (l.to.x * sin + l.to.y * cos) + (item.x || 0);
      if (!isFinite(fx) || !isFinite(fy) || !isFinite(tx) || !isFinite(ty)) return;

      legacyLines.push({
        ...l,
        id: `${item.id}-${i}`,
        from: { ...l.from, x: fx, y: fy },
        to: { ...l.to, x: tx, y: ty },
      });
    });
  });

  // New flatten output
  let newLines: PlanLine[];
  try {
    newLines = flattenDesignDocument(doc, registry);
  } catch (err: any) {
    return {
      ok: false,
      maxDeltaM: Infinity,
      errors: [`Failed to flatten design document: ${err.message}`],
    };
  }

  if (legacyLines.length !== newLines.length) {
    return {
      ok: false,
      maxDeltaM: Infinity,
      errors: [
        `Line count mismatch: legacy has ${legacyLines.length}, new has ${newLines.length}`,
      ],
    };
  }

  let maxDeltaM = 0;
  const errors: string[] = [];
  const remainingNew = [...newLines];

  for (let idx = 0; idx < legacyLines.length; idx++) {
    const leg = legacyLines[idx];
    let bestMatchIdx = -1;
    let minDistance = Infinity;

    for (let j = 0; j < remainingNew.length; j++) {
      const nw = remainingNew[j];
      // Compare direct match
      const dDirect =
        Math.hypot(leg.from.x - nw.from.x, leg.from.y - nw.from.y) +
        Math.hypot(leg.to.x - nw.to.x, leg.to.y - nw.to.y);
      // Compare reversed match
      const dReversed =
        Math.hypot(leg.from.x - nw.to.x, leg.from.y - nw.to.y) +
        Math.hypot(leg.to.x - nw.from.x, leg.to.y - nw.from.y);

      const d = Math.min(dDirect, dReversed);
      if (d < minDistance) {
        minDistance = d;
        bestMatchIdx = j;
      }
    }

    if (bestMatchIdx === -1 || minDistance > toleranceM * 2) {
      errors.push(
        `Legacy line ${idx} (${leg.id}) has no matching counterpart in new model within tolerance. Min distance: ${minDistance}`,
      );
      if (minDistance !== Infinity && minDistance > maxDeltaM) {
        maxDeltaM = minDistance;
      }
    } else {
      if (minDistance > maxDeltaM) {
        maxDeltaM = minDistance;
      }
      remainingNew.splice(bestMatchIdx, 1);
    }
  }

  const ok = errors.length === 0;
  return { ok, maxDeltaM, errors };
}
