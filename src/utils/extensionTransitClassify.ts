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
