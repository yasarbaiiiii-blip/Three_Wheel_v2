/**
 * Classify non-spray / runtime legs as extension (pre/aft) vs inter-shape transit.
 *
 * /plan only exposes spray flags — no role. /entities exposes extensions[] with
 * role + points and per-entity extension_preview. We build a catalog from that
 * and match segment endpoints so Path Order never lists extension under Transit.
 */

import type { DxfPoint, PlanLine, PlanSegmentRole } from "../types/plan";
import { coerceFiniteNumber } from "./pathWorkflow";

export type ExtensionSegmentRole = "pre" | "aft";

export type ExtensionLegSample = {
  role: ExtensionSegmentRole;
  fromNorth: number;
  fromEast: number;
  toNorth: number;
  toEast: number;
};

/** Default endpoint match tolerance (metres) for /plan vs /entities float noise. */
export const EXTENSION_ENDPOINT_MATCH_EPS_M = 0.05;

export function normalizeExtensionSegmentRole(raw: unknown): ExtensionSegmentRole | null {
  const role = String(raw ?? "").trim().toLowerCase();
  if (role === "pre" || role === "pre_transit") return "pre";
  if (role === "aft" || role === "aft_transit") return "aft";
  return null;
}

function pushLegFromPoints(
  catalog: ExtensionLegSample[],
  role: ExtensionSegmentRole,
  points: Array<{ north?: unknown; east?: unknown } | DxfPoint> | undefined | null
) {
  if (!Array.isArray(points) || points.length < 2) return;
  const a = points[0];
  const b = points[points.length - 1];
  const fromNorth = coerceFiniteNumber((a as DxfPoint).north);
  const fromEast = coerceFiniteNumber((a as DxfPoint).east);
  const toNorth = coerceFiniteNumber((b as DxfPoint).north);
  const toEast = coerceFiniteNumber((b as DxfPoint).east);
  if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) return;
  catalog.push({ role, fromNorth, fromEast, toNorth, toEast });
}

/**
 * Build extension-leg catalog from a /entities response body.
 * Uses top-level `extensions[]` (role + points) and each entity's extension_preview.
 */
export function buildExtensionLegCatalogFromEntitiesBody(body: {
  extensions?: Array<{
    role?: unknown;
    points?: Array<{ north?: unknown; east?: unknown }>;
  }>;
  entities?: Array<{
    extension_preview?: {
      enabled?: boolean;
      pre_points?: Array<{ north?: unknown; east?: unknown }>;
      aft_points?: Array<{ north?: unknown; east?: unknown }>;
    };
  }>;
}): ExtensionLegSample[] {
  const catalog: ExtensionLegSample[] = [];

  if (Array.isArray(body.extensions)) {
    for (const ext of body.extensions) {
      const role = normalizeExtensionSegmentRole(ext?.role);
      if (!role) continue;
      pushLegFromPoints(catalog, role, ext?.points);
    }
  }

  if (Array.isArray(body.entities)) {
    for (const ent of body.entities) {
      const preview = ent?.extension_preview;
      if (!preview || preview.enabled === false) continue;
      pushLegFromPoints(catalog, "pre", preview.pre_points);
      pushLegFromPoints(catalog, "aft", preview.aft_points);
    }
  }

  return catalog;
}

/** Add legs already built as layer:"extension" PlanLines (fallbackExtLines). */
export function appendExtensionLegsFromPlanLines(
  catalog: ExtensionLegSample[],
  lines: PlanLine[]
): ExtensionLegSample[] {
  const next = catalog.slice();
  for (const line of lines) {
    if (line.layer !== "extension") continue;
    let role: ExtensionSegmentRole | null =
      line.segmentRole === "pre" || line.segmentRole === "aft" ? line.segmentRole : null;
    if (!role) {
      const id = String(line.id ?? "").toLowerCase();
      if (id.startsWith("ext-pre-")) role = "pre";
      else if (id.startsWith("ext-aft-")) role = "aft";
    }
    if (!role) continue;
    const fromNorth = coerceFiniteNumber(line.from?.x);
    const fromEast = coerceFiniteNumber(line.from?.y);
    const toNorth = coerceFiniteNumber(line.to?.x);
    const toEast = coerceFiniteNumber(line.to?.y);
    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) continue;
    next.push({ role, fromNorth, fromEast, toNorth, toEast });
  }
  return next;
}

function pointNear(
  n1: number,
  e1: number,
  n2: number,
  e2: number,
  epsM: number
): boolean {
  return Math.hypot(n1 - n2, e1 - e2) <= epsM;
}

/**
 * If this non-spray segment matches a catalogued extension pre/aft leg (either
 * direction), return that role; otherwise null (treat as inter-shape transit).
 */
export function matchNonSprayToExtensionRole(
  fromNorth: number,
  fromEast: number,
  toNorth: number,
  toEast: number,
  catalog: ExtensionLegSample[],
  epsM: number = EXTENSION_ENDPOINT_MATCH_EPS_M
): ExtensionSegmentRole | null {
  for (const leg of catalog) {
    const forward =
      pointNear(fromNorth, fromEast, leg.fromNorth, leg.fromEast, epsM) &&
      pointNear(toNorth, toEast, leg.toNorth, leg.toEast, epsM);
    if (forward) return leg.role;
    const reverse =
      pointNear(fromNorth, fromEast, leg.toNorth, leg.toEast, epsM) &&
      pointNear(toNorth, toEast, leg.fromNorth, leg.fromEast, epsM);
    if (reverse) return leg.role;
  }
  return null;
}

export function toPlanSegmentRole(role: ExtensionSegmentRole | null | undefined): PlanSegmentRole {
  if (role === "pre" || role === "aft") return role;
  return "none";
}

export type RuntimeTransitOverlayResult = {
  /** Inter-shape transit PlanLines (layer transit, segmentRole none). */
  transitLines: PlanLine[];
  /**
   * True only when at least one inter-shape transit was produced.
   * Callers must NOT treat empty overlays as authoritative — fall back to
   * /entities transit_preview so connecting legs are not silently dropped.
   */
  applied: boolean;
};

/**
 * Build inter-shape transit lines from /plan merged waypoints + spray flags.
 *
 * Classification order per non-spray segment:
 * 1. Catalog match (pre/aft) → skip (drawn via fallback extension lines)
 * 2. Structural first/last non-spray skip — ONLY when extensions are enabled AND
 *    the catalog is empty (legacy global PRE/AFT pair). When the catalog is
 *    non-empty (typical LLA + extension_preview), first/last are real connecting
 *    transits and must not be dropped.
 * 3. Otherwise → runtime transit line
 */
export function buildRuntimeTransitOverlayFromPlan(args: {
  waypoints: unknown[];
  sprayFlags: unknown[];
  extensionLegCatalog: ExtensionLegSample[];
  extensionsEnabled: boolean;
  epsM?: number;
}): RuntimeTransitOverlayResult {
  const wps = Array.isArray(args.waypoints) ? args.waypoints : [];
  const sprayFlags = Array.isArray(args.sprayFlags) ? args.sprayFlags : [];
  const catalog = args.extensionLegCatalog ?? [];
  const epsM = args.epsM ?? EXTENSION_ENDPOINT_MATCH_EPS_M;

  if (wps.length < 2) {
    return { transitLines: [], applied: false };
  }

  const nonSprayIdxs: number[] = [];
  for (let i = 0; i < wps.length - 1; i++) {
    if (!(sprayFlags[i] ?? true)) nonSprayIdxs.push(i);
  }

  // Structural PRE/AFT ends only when we have no catalog samples to match against.
  // When catalog is non-empty (entity extension_preview / extensions[]), first/last
  // non-spray are often the only inter-shape connecting transits (backend puts PRE/AFT
  // only on entities, not as /plan non-spray). Blind skip would hide them — LLA bug.
  const useStructuralExtEnds = args.extensionsEnabled && catalog.length === 0;
  const firstNonSprayIdx = nonSprayIdxs[0];
  const lastNonSprayIdx = nonSprayIdxs[nonSprayIdxs.length - 1];

  const transitLines: PlanLine[] = [];

  for (let i = 0; i < wps.length - 1; i++) {
    const isMark = sprayFlags[i] ?? true;
    if (isMark) continue;

    const fromNorth = coerceFiniteNumber((wps[i] as unknown[])?.[0]);
    const fromEast = coerceFiniteNumber((wps[i] as unknown[])?.[1]);
    const toNorth = coerceFiniteNumber((wps[i + 1] as unknown[])?.[0]);
    const toEast = coerceFiniteNumber((wps[i + 1] as unknown[])?.[1]);
    if (fromNorth == null || fromEast == null || toNorth == null || toEast == null) continue;

    const extRole = matchNonSprayToExtensionRole(
      fromNorth,
      fromEast,
      toNorth,
      toEast,
      catalog,
      epsM
    );
    if (extRole) continue;

    if (
      useStructuralExtEnds &&
      (i === firstNonSprayIdx || i === lastNonSprayIdx)
    ) {
      continue;
    }

    transitLines.push({
      id: `runtime-transit-${i}`,
      label: "Transit",
      layer: "transit",
      segmentRole: "none",
      from: { id: 900000 + i * 2 + 1, x: fromNorth, y: fromEast },
      to: { id: 900000 + i * 2 + 2, x: toNorth, y: toEast },
      width: 0.1,
    });
  }

  return {
    transitLines,
    applied: transitLines.length > 0,
  };
}
