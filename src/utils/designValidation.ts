/**
 * designValidation.ts — Phase 1 validation utilities.
 *
 * Validates DesignDocument, DesignNode, DesignVertex to ensure:
 * - All coordinates are finite
 * - All coordinates are within bounds (±10,000m default)
 * - Entities have ≥2 vertices for LINE/POLYLINE
 * - Instances reference valid template IDs
 * - No duplicate node IDs
 */

import type {
  DesignDocument,
  DesignNode,
  DesignVertex,
  DesignEntity,
  DesignInstance,
} from '../types/designDocument';
import { isDesignInstance, isDesignEntity } from '../types/designDocument';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const DEFAULT_MAX_COORD_M = 10_000;

/** Validate a single vertex is finite and within bounds. */
export function validateVertex(
  v: DesignVertex,
  maxCoordM: number = DEFAULT_MAX_COORD_M,
): ValidationResult {
  const errors: string[] = [];
  if (!isFinite(v.northM)) errors.push(`northM is not finite: ${v.northM}`);
  if (!isFinite(v.eastM)) errors.push(`eastM is not finite: ${v.eastM}`);
  if (Math.abs(v.northM) > maxCoordM)
    errors.push(`northM ${v.northM} exceeds ±${maxCoordM}m`);
  if (Math.abs(v.eastM) > maxCoordM)
    errors.push(`eastM ${v.eastM} exceeds ±${maxCoordM}m`);
  return { ok: errors.length === 0, errors };
}

/** Validate a DesignEntity. */
export function validateEntity(entity: DesignEntity): ValidationResult {
  const errors: string[] = [];
  if (!entity.id) errors.push('Entity missing id');
  if (!entity.type) errors.push('Entity missing type');
  if (!entity.layer) errors.push('Entity missing layer');

  const minVertices: Record<string, number> = {
    LINE: 2,
    POLYLINE: 2,
    POINT: 1,
    FREEHAND: 2,
  };

  const required = minVertices[entity.type] ?? 2;
  if (!entity.vertices || entity.vertices.length < required) {
    errors.push(
      `Entity ${entity.id} (${entity.type}) needs ≥${required} vertices, got ${entity.vertices?.length ?? 0}`,
    );
  }

  if (entity.vertices) {
    for (let i = 0; i < entity.vertices.length; i++) {
      const vr = validateVertex(entity.vertices[i]);
      if (!vr.ok) {
        errors.push(`Entity ${entity.id} vertex[${i}]: ${vr.errors.join('; ')}`);
      }
    }
  }

  if (entity.width !== undefined && (!isFinite(entity.width) || entity.width < 0)) {
    errors.push(`Entity ${entity.id} has invalid width: ${entity.width}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Validate a DesignInstance. */
export function validateInstance(
  instance: DesignInstance,
  knownTemplateIds?: Set<string>,
): ValidationResult {
  const errors: string[] = [];
  if (!instance.id) errors.push('Instance missing id');
  if (!instance.templateId) errors.push('Instance missing templateId');
  if (instance.type !== 'INSTANCE') errors.push(`Instance type should be INSTANCE, got ${instance.type}`);

  const t = instance.transform;
  if (!t) {
    errors.push(`Instance ${instance.id} missing transform`);
  } else {
    if (!isFinite(t.northM)) errors.push(`Instance ${instance.id} transform.northM not finite`);
    if (!isFinite(t.eastM)) errors.push(`Instance ${instance.id} transform.eastM not finite`);
    if (!isFinite(t.rotationDeg)) errors.push(`Instance ${instance.id} transform.rotationDeg not finite`);
    if (!isFinite(t.scale) || t.scale <= 0) {
      errors.push(`Instance ${instance.id} transform.scale invalid: ${t.scale}`);
    }
  }

  if (knownTemplateIds && !knownTemplateIds.has(instance.templateId)) {
    errors.push(`Instance ${instance.id} references unknown templateId: ${instance.templateId}`);
  }

  return { ok: errors.length === 0, errors };
}

/** Validate a DesignNode (entity or instance). */
export function validateNode(
  node: DesignNode,
  knownTemplateIds?: Set<string>,
): ValidationResult {
  if (isDesignInstance(node)) {
    return validateInstance(node, knownTemplateIds);
  }
  if (isDesignEntity(node)) {
    return validateEntity(node);
  }
  return { ok: false, errors: [`Unknown node type: ${(node as any).type}`] };
}

/** Validate a complete DesignDocument. */
export function validateDesignDocument(
  doc: DesignDocument,
  knownTemplateIds?: Set<string>,
): ValidationResult {
  const errors: string[] = [];

  if (doc.schemaVersion !== 1) {
    errors.push(`Unsupported schemaVersion: ${doc.schemaVersion}`);
  }
  if (!doc.id) errors.push('Document missing id');
  if (!isFinite(doc.revision) || doc.revision < 0) {
    errors.push(`Document revision invalid: ${doc.revision}`);
  }

  // Validate frame
  if (!doc.frame) {
    errors.push('Document missing frame');
  } else {
    if (!isFinite(doc.frame.originNorthM))
      errors.push(`Frame originNorthM not finite: ${doc.frame.originNorthM}`);
    if (!isFinite(doc.frame.originEastM))
      errors.push(`Frame originEastM not finite: ${doc.frame.originEastM}`);
  }

  // Check for duplicate node IDs
  const idSet = new Set<string>();
  for (const node of doc.nodes) {
    if (idSet.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    idSet.add(node.id);
  }

  // Validate each node
  for (const node of doc.nodes) {
    const nr = validateNode(node, knownTemplateIds);
    if (!nr.ok) {
      errors.push(...nr.errors);
    }
  }

  return { ok: errors.length === 0, errors };
}
