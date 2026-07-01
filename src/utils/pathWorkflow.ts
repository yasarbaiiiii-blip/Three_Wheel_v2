import * as missionApi from "../api/missionApi";
import * as pathApi from "../api/pathApi";
import type { PlanLine } from "../types/plan";

export function coerceFiniteNumber(value: unknown): number | null {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : null;
}

export function formatFinite(value: unknown, digits = 2, fallback = "n/a") {
  const next = coerceFiniteNumber(value);
  return next == null ? fallback : next.toFixed(digits);
}

const PRIMARY_ENTITY_TYPES = new Set(["line", "arc", "circle"]);

export function normalizeEntityType(entityType: unknown) {
  return String(entityType ?? "").trim().toLowerCase();
}

export type NormalizedExtensionRole = "PRE" | "AFT" | "none";

export type NormalizedPathSegment = {
  index: number;
  sequence: number;
  type: "MARK" | "TRANSIT" | string;
  extensionRole: NormalizedExtensionRole;
  sprayOn: boolean;
  sourceEntity: string;
  lengthM: number | null;
};

export function normalizeSegmentType(rawType: unknown): "MARK" | "TRANSIT" | string {
  const type = String(rawType ?? "").trim().toUpperCase();
  if (type === "MARK") return "MARK";
  if (type === "TRANSIT") return "TRANSIT";
  return type || "UNKNOWN";
}

export function normalizeExtensionRole(segment: pathApi.PathSegmentInfo): NormalizedExtensionRole {
  const roleSources = [segment.segment_role, segment.extension_role];
  for (const raw of roleSources) {
    const role = String(raw ?? "").trim().toLowerCase();
    if (role === "pre" || role === "pre_transit") return "PRE";
    if (role === "aft" || role === "aft_transit") return "AFT";
  }
  return "none";
}

export function normalizePathSegment(segment: pathApi.PathSegmentInfo): NormalizedPathSegment {
  return {
    index: segment.index,
    sequence: segment.sequence,
    type: normalizeSegmentType(segment.type),
    extensionRole: normalizeExtensionRole(segment),
    sprayOn: !!segment.spray_on,
    sourceEntity: String(segment.source_entity ?? "").trim(),
    lengthM: coerceFiniteNumber(segment.length_m),
  };
}

export function summarizeNormalizedSegments(segments: pathApi.PathSegmentInfo[]) {
  const normalized = segments.map(normalizePathSegment);
  let markCount = 0;
  let transitCount = 0;
  let preExtensionCount = 0;
  let aftExtensionCount = 0;
  let sprayOnCount = 0;
  let sprayOffCount = 0;

  for (const segment of normalized) {
    if (segment.type === "MARK") markCount += 1;
    if (segment.type === "TRANSIT") transitCount += 1;
    if (segment.extensionRole === "PRE") preExtensionCount += 1;
    if (segment.extensionRole === "AFT") aftExtensionCount += 1;
    if (segment.sprayOn) sprayOnCount += 1;
    else sprayOffCount += 1;
  }

  return {
    normalized,
    markCount,
    transitCount,
    preExtensionCount,
    aftExtensionCount,
    sprayOnCount,
    sprayOffCount,
  };
}

export function parsePathSegmentsResponse(data: unknown): pathApi.PathSegmentsResponse | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, "segments")) return null;
  if (!Array.isArray(body.segments)) return null;
  if (body.segments.length === 0) return null;
  return body as pathApi.PathSegmentsResponse;
}

export function formatExtensionRoleLabel(role: NormalizedExtensionRole) {
  if (role === "PRE") return "pre";
  if (role === "AFT") return "aft";
  return "none";
}

export function formatWaypointPair(waypoints: unknown): string {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return "n/a";
  const formatPoint = (point: unknown) => {
    if (!Array.isArray(point) || point.length < 2) return "n/a";
    return `[${formatFinite(point[0], 2)}, ${formatFinite(point[1], 2)}]`;
  };
  return `${formatPoint(waypoints[0])} → ${formatPoint(waypoints[waypoints.length - 1])}`;
}

export function parsePlanAndStageResponse(data: unknown): { plan: pathApi.PathPlanResponse; missionId: string } | null {
  if (!data || typeof data !== "object") return null;
  const plan = data as pathApi.PathPlanResponse;
  const missionId = plan.mission_summary?.mission_id ?? plan.mission_id;
  if (typeof missionId !== "string" || missionId.trim() === "") return null;
  return { plan, missionId: missionId.trim() };
}

export function formatSprayFlagSample(loaded: missionApi.LoadedPathResponse): string {
  if (!loaded.has_spray_flags) return "n/a";
  return `mark ${loaded.num_mark} / transit ${loaded.num_transit}`;
}

export function isPrimaryEditableLine(line: PlanLine) {
  if (line.layer === "transit" || line.layer === "extension") {
    return false;
  }
  return PRIMARY_ENTITY_TYPES.has(normalizeEntityType(line.entity?.entity_type));
}

function isRenderableLine(line: PlanLine | null | undefined): line is PlanLine {
  return Boolean(
    line &&
    line.from &&
    line.to &&
    coerceFiniteNumber(line.from.x) != null &&
    coerceFiniteNumber(line.from.y) != null &&
    coerceFiniteNumber(line.to.x) != null &&
    coerceFiniteNumber(line.to.y) != null
  );
}

export function sanitizePlanLines(lines: PlanLine[]) {
  return lines.filter(isRenderableLine);
}