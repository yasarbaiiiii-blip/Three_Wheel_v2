/**
 * designDocument.ts — Canonical design types (Phase 1).
 *
 * All coordinates use explicit `northM` / `eastM` names.
 * No ambiguous `x` / `y` in the new data model.
 *
 * See docs/coordinate-conventions.md for the full mapping.
 */

// ──────────────────────────────────────────
// Design Frame
// ──────────────────────────────────────────

export interface DesignFrame {
  /** Origin north offset in metres. Default 0. */
  originNorthM: number;
  /** Origin east offset in metres. Default 0. */
  originEastM: number;
}

// ──────────────────────────────────────────
// Design Vertex
// ──────────────────────────────────────────

export interface DesignVertex {
  northM: number;
  eastM: number;
}

// ──────────────────────────────────────────
// Design Entity — raw geometry in world frame
// ──────────────────────────────────────────

export type DesignEntityType = 'LINE' | 'POLYLINE' | 'POINT' | 'FREEHAND';

export interface DesignEntity {
  id: string;
  type: DesignEntityType;
  layer: string;
  vertices: DesignVertex[];
  width?: number;
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Design Instance — reference to a template
// ──────────────────────────────────────────

export interface InstanceTransform {
  northM: number;
  eastM: number;
  rotationDeg: number;
  scale: number;
}

export interface DesignInstance {
  id: string;
  type: 'INSTANCE';
  templateId: string;
  transform: InstanceTransform;
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Design Node = Entity | Instance
// ──────────────────────────────────────────

export type DesignNode = DesignEntity | DesignInstance;

export function isDesignInstance(node: DesignNode): node is DesignInstance {
  return node.type === 'INSTANCE';
}

export function isDesignEntity(node: DesignNode): node is DesignEntity {
  return node.type !== 'INSTANCE';
}

// ──────────────────────────────────────────
// Design Document — the canonical model
// ──────────────────────────────────────────

export interface DesignDocument {
  schemaVersion: 1;
  id: string;
  frame: DesignFrame;
  nodes: DesignNode[];
  revision: number;
}

// ──────────────────────────────────────────
// Template definition (for the registry)
// ──────────────────────────────────────────

export interface TemplateDefinition {
  templateId: string;
  /** Template-local lines (PlanLine format for backward compatibility) */
  lines: import('../types/plan').PlanLine[];
  /** Template-local bounding box (north/east) */
  bbox: {
    minNorthM: number;
    maxNorthM: number;
    minEastM: number;
    maxEastM: number;
  };
  /** Original width/height from the PlacedItem (for dedup) */
  nominalWidthM: number;
  nominalHeightM: number;
  metadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Alignment model
// ──────────────────────────────────────────

export interface AlignmentReferencePoint {
  designNorthM: number;
  designEastM: number;
  lat: number;
  lon: number;
}

export interface DesignAlignment {
  method: 'single_point' | 'least_squares' | 'visual';
  offsetNorthM: number;
  offsetEastM: number;
  rotationDeg: number;
  scale: number;
  referencePoints: AlignmentReferencePoint[];
  pathName?: string;
  verifiedAt?: string;
  backendMetadata?: Record<string, unknown>;
}

// ──────────────────────────────────────────
// Preview anchor
// ──────────────────────────────────────────

export interface DesignPreviewAnchor {
  mode: 'rover_latched' | 'explicit_gps' | 'aligned_ref';
  lat: number;
  lon: number;
}

// ──────────────────────────────────────────
// Undo/redo command types
// ──────────────────────────────────────────

export type DesignCommand =
  | { type: 'AddNode'; node: DesignNode }
  | { type: 'DeleteNode'; nodeId: string; snapshot: DesignNode }
  | { type: 'UpdateInstanceTransform'; nodeId: string; before: InstanceTransform; after: InstanceTransform }
  | { type: 'UpdateEntityVertices'; nodeId: string; before: DesignVertex[]; after: DesignVertex[] }
  | { type: 'UpdateFrame'; before: DesignFrame; after: DesignFrame }
  | { type: 'UpdateNodeGroupId'; nodeId: string; before?: string; after?: string }
  | { type: 'Batch'; commands: DesignCommand[] };

// ──────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────

export function createDesignDocument(id?: string): DesignDocument {
  return {
    schemaVersion: 1,
    id: id ?? `doc-${Date.now()}`,
    frame: { originNorthM: 0, originEastM: 0 },
    nodes: [],
    revision: 0,
  };
}

export function createDesignVertex(northM: number, eastM: number): DesignVertex {
  return { northM, eastM };
}

export function createDesignInstance(
  id: string,
  templateId: string,
  transform: InstanceTransform,
  metadata?: Record<string, unknown>,
): DesignInstance {
  return { id, type: 'INSTANCE', templateId, transform, metadata };
}

export function createDesignEntity(
  id: string,
  entityType: DesignEntityType,
  layer: string,
  vertices: DesignVertex[],
  width?: number,
  metadata?: Record<string, unknown>,
): DesignEntity {
  return { id, type: entityType, layer, vertices, width, metadata };
}
