/**
 * designTemplateRegistry.ts — Phase 1 deterministic template registry.
 *
 * Template IDs are NEVER random / item.id based.
 *
 * ID format:
 *   Built-in:    `{category}:{variant}:v1` + optional `@param=value`
 *   Snapshot:    `snapshot:fp:{fingerprint}`
 *
 * The registry stores immutable template-local PlanLines keyed by templateId.
 * Same fingerprint → same ID → deduplication.
 */

import type { PlanLine } from '../types/plan';
import type { TemplateDefinition } from '../types/designDocument';

export class TemplateRegistry {
  private templates: Map<string, TemplateDefinition> = new Map();

  /** Register a template. Deduplicates by ID — same ID = same template. */
  registerTemplate(def: TemplateDefinition): void {
    if (this.templates.has(def.templateId)) {
      // Already registered — no-op (immutable templates)
      return;
    }
    this.templates.set(def.templateId, def);
  }

  /** Get a template by ID. */
  getTemplate(templateId: string): TemplateDefinition | undefined {
    return this.templates.get(templateId);
  }

  /** Check if a template exists. */
  hasTemplate(templateId: string): boolean {
    return this.templates.has(templateId);
  }

  /** Get all template IDs. */
  getAllIds(): string[] {
    return Array.from(this.templates.keys());
  }

  /** Get the number of registered templates. */
  get size(): number {
    return this.templates.size;
  }

  /** Get all template IDs as a Set (for validation). */
  getIdSet(): Set<string> {
    return new Set(this.templates.keys());
  }
}

// ──────────────────────────────────────────
// Deterministic template ID generation
// ──────────────────────────────────────────

/**
 * Generate a deterministic template ID for a built-in shape/category.
 * Format: `{category}:{variant}:v1` with optional `@size={size}`
 */
export function builtinTemplateId(
  category: string,
  variant: string,
  params?: Record<string, string | number>,
): string {
  let id = `${category}:${variant}:v1`;
  if (params) {
    const keys = Object.keys(params).sort();
    const suffix = keys.map(k => `${k}=${formatParamValue(params[k])}`).join(',');
    if (suffix) id += `@${suffix}`;
  }
  return id;
}

function formatParamValue(v: string | number): string {
  if (typeof v === 'number') return v.toFixed(3);
  return v;
}

/**
 * Generate a fingerprint-based template ID from template-local lines.
 * Uses a simple hash of normalized geometry for deduplication.
 * Format: `snapshot:fp:{hex}`
 */
export function snapshotTemplateId(lines: PlanLine[]): string {
  const fp = computeGeometryFingerprint(lines);
  return `snapshot:fp:${fp}`;
}

/**
 * Compute a geometry fingerprint for a set of template-local PlanLines.
 * This is a simple deterministic hash — same geometry always gets the same fingerprint.
 */
export function computeGeometryFingerprint(lines: PlanLine[]): string {
  // Normalize: sort by coordinates, round to 0.001m precision
  const normalized = lines.map(l => {
    const fromX = Math.round(l.from.x * 1000) / 1000;
    const fromY = Math.round(l.from.y * 1000) / 1000;
    const toX = Math.round(l.to.x * 1000) / 1000;
    const toY = Math.round(l.to.y * 1000) / 1000;
    return `${fromX},${fromY}->${toX},${toY}`;
  });
  normalized.sort();
  const data = normalized.join('|');
  return simpleHash(data);
}

/**
 * Simple string hash — deterministic, not cryptographic.
 * Returns a 16-char hex string.
 */
function simpleHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return hex1 + hex2;
}

// ──────────────────────────────────────────
// Template definition factory
// ──────────────────────────────────────────

/**
 * Create a TemplateDefinition from template-local PlanLines.
 */
export function createTemplateDefinition(
  templateId: string,
  lines: PlanLine[],
  nominalWidthM: number,
  nominalHeightM: number,
  metadata?: Record<string, unknown>,
): TemplateDefinition {
  let minN = Infinity, maxN = -Infinity;
  let minE = Infinity, maxE = -Infinity;
  for (const l of lines) {
    minN = Math.min(minN, l.from.x, l.to.x); // x = north
    maxN = Math.max(maxN, l.from.x, l.to.x);
    minE = Math.min(minE, l.from.y, l.to.y); // y = east
    maxE = Math.max(maxE, l.from.y, l.to.y);
  }
  return {
    templateId,
    lines,
    bbox: {
      minNorthM: minN,
      maxNorthM: maxN,
      minEastM: minE,
      maxEastM: maxE,
    },
    nominalWidthM,
    nominalHeightM,
    metadata,
  };
}
